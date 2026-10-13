//! After the script: the context correction and the summary (Gemini), then
//! the Notion page, done while the worker still holds the meeting.
//!
//! The correction ([`crate::correct`], `{first}.corrected.json`) never
//! holds anything up: while it is not there (off for the run, waiting,
//! failed or given up) the summary and the page use the original script,
//! and once it is there they are made again from the corrected text. Its
//! failures have the summary's shape (`{first}.correct-failed.json`, the
//! same limits).
//!
//! What is done after the script counts only for the very script it was
//! made from — the sha256 of the script's bytes — so a script written again
//! (`--overwrite`) never gets an older script's summary or page:
//!
//! - The summary (`{first}.summary.json`) keeps that sha256
//!   ([`Summary::script_sha256`]). A stored summary that cannot be read is a
//!   failure: Gemini is not asked again (it costs money).
//! - The Notion record keeps the script's sha256 and the summary's
//!   ([`RecordStamp`]): a page written before its summary existed is written
//!   again once it does. With the summary on, the page waits for it.
//!
//! Failures have one shape for both steps (the worker docs have the table):
//!
//! - Each meeting keeps one record per step for its script,
//!   `{first}.summary-failed.json` and `{first}.notion-failed.json`
//!   ([`StepFailures`]). Deleting it lets the next run start over.
//! - A try that cost money, or may have — an answer came (200), or the
//!   request was sent and then timed out or the connection closed — is not
//!   sent again in the run and counts as a paid try; after
//!   [`PAID_SUMMARY_TRIES`] of them the summary is given up.
//! - A failure that cost nothing (no connection, 5xx) counts as a free
//!   failure and that meeting waits ([`backoff`]) before its next try; other
//!   meetings go on. After more than [`FREE_SUMMARY_FAILS`] the summary is
//!   given up; the Notion page keeps trying. A 429 only waits. A bad request
//!   (400·404) counts only after another meeting succeeded earlier in the
//!   run; otherwise it is counted apart ([`UNCOUNTED_BAD_REQUESTS`]).
//! - A given-up summary leaves the page written with [`SUMMARY_GIVEN_UP`] in
//!   its place, and the meeting is finished.
//! - A step is off for the rest of the run only on what the service says:
//!   refused credentials or permission and 429 at once, other trouble
//!   (unavailable, timed out, cut off) on [`TROUBLE_IN_A_ROW`] meetings in a
//!   row; any answer starts the count again.
//!
//! The records are read first; the script is read only when a step is left
//! to do. Nothing new starts with less than [`FOLLOW_UP_MIN_LEFT`] before
//! the run's deadline, and Gemini gets the deadline too: no request or wait
//! that would end after it. Before writing the summary or a record the
//! worker checks it still holds the meeting.
//!
//! Who said what is shown through [`DisplayNames`]: pubkey prefixes unless
//! profile names are on (below); a map that also knows a diarized
//! `speaker_label` can take its place without touching this flow.
//!
//! 프로필 이름([`FollowUps::with_profiles`])을 켜면 회의마다 한 번, 어느 단계든 처음
//! 이름이 필요할 때 릴레이에 묻고 그 회의의 후보정·요약·페이지가 같은 이름표를 쓴다.
//! 묻기가 안 되면 그 사람들만 pubkey 앞 8자로 두고 단계는 그대로 간다. 이름 묻기는 단계의
//! 실패로 세지 않고 실패 기록(`StepFailures`)에도 넣지 않는다([`FollowedUp::names`] 에
//! 수만 남긴다).
//!
//! 페이지 뒤의 task 연결([`FollowUps::with_tasks`], [`crate::tasks`])은 이 글의 요약과 끝난
//! 페이지가 있는 회의에만 돈다. 회의마다 한 번이다: 장부(`{first}.tasks.json`)가 끝남이면
//! 스크립트가 바뀌어도 다시 하지 않는다. 실패 기록(`{first}.tasks-failed.json`)과 실행 끄기는
//! 요약과 같은 모양이지만, task 연결의 실패는 회의의 실패로 세지 않는다
//! ([`FollowedUp::has_failure`] 에 안 든다). 작업기 저장소가 실패할 때만 회의가 실패한다.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use buzz_gcp::token::Tokens;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::collect::MeetingPlan;
use crate::correct::{self, Corrected, Glossary};
use crate::models::sha256_hex;
use crate::notion::{
    self, MeetingKind, MeetingPage, NotionClient, NotionError, NotionErrorKind, NotionRecord,
    ProcessingStatus, PublishMeetingError, PublishReport, RecordStamp,
};
use crate::profiles::{NamesReport, ProfileNames, ProfileSource};
use crate::runner::{Beside, MeetingError, MinutesHome};
use crate::summary::{
    self, DisplayNames, GeminiSettings, Summary, SummaryError, SummaryErrorKind, Usage,
};
use crate::tasks::{
    self, CheckInput, Plan, TaskSchema, TasksLedger, TasksMode, TasksReport, TASKS_FORMAT,
    TASKS_MAX_AGE_MS,
};
use crate::transcript::Transcript;

/// Tries of one script's summary that cost money, or may have, before the
/// summary is given up.
pub const PAID_SUMMARY_TRIES: u32 = 3;
/// Free failures of one script's summary that are tried again; one more and
/// it is given up (about ten and a half hours of waiting). The Notion page
/// is never given up.
pub const FREE_SUMMARY_FAILS: u32 = 6;
/// The wait after a step's first free failure; it doubles with each one
/// after, up to [`MAX_BACKOFF`].
pub const FIRST_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// The longest wait between tries of one step.
pub const MAX_BACKOFF: Duration = Duration::from_secs(6 * 60 * 60);
/// Trouble (unavailable, timed out, cut off) on this many meetings in a row
/// turns the step off for the rest of the run.
pub const TROUBLE_IN_A_ROW: u32 = 2;
/// Requests refused as bad (400·404) on this many meetings in a row look
/// like a setting, not the meetings: the step is off for the rest of the
/// run, and from this one on they do not count for their meeting.
pub const BAD_REQUESTS_IN_A_ROW: u32 = 2;
/// A bad request (400·404) counts for its meeting only when another
/// meeting's summary succeeded earlier in the same run; otherwise it may be
/// a setting and is counted apart. This many of those for one script give
/// its summary up anyway: with the waits (10, 20, 40, 80, 160, 320 minutes,
/// then 6 hours) the 11th comes about 34.5 hours after the first, so a
/// wrong setting has a day and a half to be noticed and fixed, and a
/// meeting that always comes first still gets its page in the end.
pub const UNCOUNTED_BAD_REQUESTS: u32 = 11;
/// Nothing after the script starts with less than this left before the
/// run's deadline; the next run does it.
pub const FOLLOW_UP_MIN_LEFT: Duration = Duration::from_secs(10 * 60);
/// Time limit of one Gemini request in the worker; the attempts stay as in
/// [`GeminiSettings::retry`]. Long enough for the whole
/// [`summary::DEFAULT_MAX_OUTPUT_TOKENS`] (32,768) at 61 tokens a second or
/// more (measured 2026-10-12 on a 58-minute meeting: 998 tokens in 12.2 s,
/// at least 82 a second), and short enough to start inside
/// [`FOLLOW_UP_MIN_LEFT`].
pub const WORKER_GEMINI_TIMEOUT: Duration = Duration::from_secs(540);
/// `Retry-After` from Gemini and Notion is followed this far (ms) in the
/// worker.
pub const WORKER_MAX_RETRY_AFTER_MS: u64 = 60_000;
// A request started with FOLLOW_UP_MIN_LEFT to go must be able to finish.
const _: () = assert!(WORKER_GEMINI_TIMEOUT.as_secs() < FOLLOW_UP_MIN_LEFT.as_secs());
/// On the Notion page in place of a summary that was given up.
pub const SUMMARY_GIVEN_UP: &str = "요약 실패: 이 스크립트로는 요약을 만들지 못했어요.";
/// [`RecordStamp::summary_sha256`] of a page written with the summary given
/// up.
pub const SUMMARY_GIVEN_UP_STAMP: &str = "failed";
/// Value of [`StepFailures::format`].
pub const STEP_FAILURES_FORMAT: &str = "huddle-step-failures/1";

/// The wait after a step's `free_fails`-th free failure (1 and up):
/// [`FIRST_BACKOFF`] doubled each time, at most [`MAX_BACKOFF`].
pub fn backoff(free_fails: u32) -> Duration {
    let doublings = free_fails.saturating_sub(1).min(16);
    FIRST_BACKOFF
        .saturating_mul(1u32 << doublings)
        .min(MAX_BACKOFF)
}

/// Failures of one step (summary or Notion page) for one script, kept beside
/// it (`{first}.summary-failed.json`, `{first}.notion-failed.json`). Holds
/// no meeting text. Deleting the file lets the next run start over.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepFailures {
    /// [`STEP_FAILURES_FORMAT`].
    pub format: String,
    /// sha256 of the script the failures are about; another script's count
    /// as none.
    pub script_sha256: String,
    /// Tries that cost money, or may have (the summary only).
    #[serde(default)]
    pub paid_tries: u32,
    /// Failures that cost nothing.
    #[serde(default)]
    pub free_fails: u32,
    /// Bad requests (400·404) not counted as the meeting's own: no other
    /// meeting's step had succeeded before it in the run.
    #[serde(default)]
    pub uncounted_bad_requests: u32,
    /// Kind of the last failure, e.g. `transient`.
    #[serde(default, alias = "kind")]
    pub last_kind: String,
    /// Its code, e.g. `HTTP 500 INTERNAL` (no meeting text).
    #[serde(default, alias = "code")]
    pub last_code: String,
    /// No new try before this (UTC ms).
    #[serde(default)]
    pub next_try_after_unix_ms: u64,
}

impl StepFailures {
    fn new(script_sha256: &str) -> Self {
        Self {
            format: STEP_FAILURES_FORMAT.into(),
            script_sha256: script_sha256.into(),
            ..Self::default()
        }
    }

    /// The summary is given up for this script.
    pub fn summary_given_up(&self) -> bool {
        self.paid_tries >= PAID_SUMMARY_TRIES
            || self.free_fails > FREE_SUMMARY_FAILS
            || self.uncounted_bad_requests >= UNCOUNTED_BAD_REQUESTS
    }

    /// The step waits at `now`. A next try further off than [`MAX_BACKOFF`]
    /// was never written by this worker (a wrong clock, a damaged record):
    /// it is not waited for.
    fn waiting(&self, now: u64) -> bool {
        let longest = u64::try_from(MAX_BACKOFF.as_millis()).unwrap_or(u64::MAX);
        now < self.next_try_after_unix_ms
            && self.next_try_after_unix_ms <= now.saturating_add(longest)
    }

    /// Count one failure at `now` (UTC ms); a free one sets the next try.
    fn count(&mut self, cost: Cost, kind: &str, code: &str, now: u64) {
        self.last_kind = kind.into();
        self.last_code = code.into();
        match cost {
            Cost::Paid => self.paid_tries += 1,
            Cost::Free | Cost::WaitOnly => {
                if cost == Cost::Free {
                    self.free_fails += 1;
                }
                let n = self.free_fails.max(1);
                let wait = u64::try_from(backoff(n).as_millis()).unwrap_or(u64::MAX);
                self.next_try_after_unix_ms = now.saturating_add(wait);
            }
            Cost::UncountedBadRequest => {
                self.uncounted_bad_requests += 1;
                let n = self.uncounted_bad_requests;
                let wait = u64::try_from(backoff(n).as_millis()).unwrap_or(u64::MAX);
                self.next_try_after_unix_ms = now.saturating_add(wait);
            }
            Cost::Uncounted => {}
        }
    }

    /// How this failure was counted, for the log.
    fn tally(&self, cost: Cost, given_up: bool, now: u64) -> String {
        let end = if given_up { ", given up" } else { "" };
        match cost {
            Cost::Paid => format!(
                " (paid try {} of {PAID_SUMMARY_TRIES}{end})",
                self.paid_tries
            ),
            Cost::Free if given_up => format!(" (free failure {}{end})", self.free_fails),
            Cost::Free => format!(
                " (free failure {}, next try in {} min)",
                self.free_fails,
                self.next_try_after_unix_ms
                    .saturating_sub(now)
                    .div_ceil(60_000)
            ),
            Cost::UncountedBadRequest if given_up => format!(
                " (bad request not counted {}{end})",
                self.uncounted_bad_requests
            ),
            Cost::UncountedBadRequest => format!(
                " (bad request not counted {}, next try in {} min)",
                self.uncounted_bad_requests,
                self.next_try_after_unix_ms
                    .saturating_sub(now)
                    .div_ceil(60_000)
            ),
            Cost::WaitOnly => format!(
                " (not counted, next try in {} min)",
                self.next_try_after_unix_ms
                    .saturating_sub(now)
                    .div_ceil(60_000)
            ),
            Cost::Uncounted => String::new(),
        }
    }
}

/// How a failure counts for its meeting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cost {
    /// Cost money, or may have.
    Paid,
    /// Cost nothing: wait, then try again.
    Free,
    /// Not the meeting's doing, but wait before trying it again (429).
    WaitOnly,
    /// A bad request that may be a setting: counted apart, and wait
    /// ([`UNCOUNTED_BAD_REQUESTS`]).
    UncountedBadRequest,
    /// Not the meeting's doing (refused credentials or permission, no
    /// token).
    Uncounted,
}

/// What a result says about the service, for the rest of the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    /// Refused (credentials, permission) or rate-limited: off now.
    Refused,
    /// Unavailable, timed out or cut off: off after [`TROUBLE_IN_A_ROW`].
    Trouble,
    /// Refused as a bad request (400·404): off after
    /// [`BAD_REQUESTS_IN_A_ROW`].
    BadRequest,
    /// The service answered.
    Answered,
}

fn summary_class(error: &SummaryError) -> (Cost, Signal) {
    use SummaryErrorKind as Kind;
    let cost = match error.kind {
        _ if error.may_have_cost() => Cost::Paid,
        Kind::Auth | Kind::Permission | Kind::NoToken => Cost::Uncounted,
        Kind::RateLimited => Cost::WaitOnly,
        _ => Cost::Free,
    };
    let signal = match error.kind {
        Kind::Auth | Kind::Permission | Kind::RateLimited => Signal::Refused,
        Kind::Transient | Kind::NoToken => Signal::Trouble,
        Kind::BadRequest => Signal::BadRequest,
        Kind::BadResponse | Kind::OutOfTime => Signal::Answered,
    };
    (cost, signal)
}

fn notion_class(kind: NotionErrorKind) -> (Cost, Signal) {
    use NotionErrorKind as Kind;
    match kind {
        Kind::Auth | Kind::Permission => (Cost::Uncounted, Signal::Refused),
        Kind::RateLimited => (Cost::WaitOnly, Signal::Refused),
        Kind::Transient => (Cost::Free, Signal::Trouble),
        Kind::NotFound | Kind::BadRequest => (Cost::Free, Signal::BadRequest),
        Kind::BadResponse => (Cost::Free, Signal::Answered),
    }
}

/// One step's state for the rest of the run.
#[derive(Debug, Default)]
struct ForRun {
    off: bool,
    /// The step succeeded for some meeting earlier in this run.
    succeeded: bool,
    trouble_in_a_row: u32,
    bad_requests_in_a_row: u32,
}

impl ForRun {
    /// How a failure of this kind counts for its meeting, after taking it
    /// in: a free bad request counts only after a success earlier in this
    /// run, and never when it looks like a setting
    /// ([`BAD_REQUESTS_IN_A_ROW`] in a row). A paid try stays paid (the
    /// shorter ask after a paid answer can get the 400).
    fn count_as(&mut self, cost: Cost, signal: Signal) -> Cost {
        let setting = self.heard(signal);
        match signal {
            Signal::BadRequest if cost == Cost::Free && (setting || !self.succeeded) => {
                Cost::UncountedBadRequest
            }
            _ => cost,
        }
    }

    /// Take in one result; `true` for bad requests on
    /// [`BAD_REQUESTS_IN_A_ROW`] meetings in a row.
    fn heard(&mut self, signal: Signal) -> bool {
        match signal {
            Signal::Refused => self.off = true,
            Signal::Trouble => {
                self.bad_requests_in_a_row = 0;
                self.trouble_in_a_row += 1;
                self.off |= self.trouble_in_a_row >= TROUBLE_IN_A_ROW;
            }
            Signal::BadRequest => {
                self.trouble_in_a_row = 0;
                self.bad_requests_in_a_row += 1;
                if self.bad_requests_in_a_row >= BAD_REQUESTS_IN_A_ROW {
                    self.off = true;
                    return true;
                }
            }
            Signal::Answered => {
                self.trouble_in_a_row = 0;
                self.bad_requests_in_a_row = 0;
            }
        }
        false
    }
}

/// How to ask Gemini for the correction.
pub struct CorrectStep<'a> {
    /// HTTP client.
    pub http: &'a reqwest::Client,
    /// Model, project, retries, time limit of each request.
    pub settings: &'a GeminiSettings,
    /// Google access tokens.
    pub tokens: &'a Tokens,
    /// The team's words.
    pub glossary: &'a Glossary,
}

/// How to ask Gemini for the summary.
pub struct SummaryStep<'a> {
    /// HTTP client.
    pub http: &'a reqwest::Client,
    /// Model, project, retries, time limit of each request.
    pub settings: &'a GeminiSettings,
    /// Google access tokens.
    pub tokens: &'a Tokens,
}

/// How to write the Notion page.
pub struct NotionStep<'a> {
    /// Notion client (token, spacing between requests).
    pub client: NotionClient<'a>,
    /// Put before the page title (e.g. `[시험] `).
    pub title_prefix: String,
    /// Shown in the "채널" column; channel id when `None`.
    pub channel_label: Option<String>,
    /// "종류"; left empty when `None`.
    pub kind: Option<MeetingKind>,
}

/// 팀 task DB 와 잇는 법([`crate::tasks`]). Gemini 는 요약과 같은 모델·클라이언트를 쓴다.
pub struct TasksStep<'a> {
    /// 어디까지 쓰나(off 가 아닌 것).
    pub mode: TasksMode,
    /// Gemini HTTP client.
    pub http: &'a reqwest::Client,
    /// 요약과 같은 Gemini 설정(모델·생각 수준·요청 시간 상한·다시 하기).
    pub settings: &'a GeminiSettings,
    /// Google access tokens.
    pub tokens: &'a Tokens,
    /// task DB 를 읽고 쓰는 노션 클라이언트(회의록 페이지와 같은 토큰).
    pub client: NotionClient<'a>,
    /// task DB(노션 database id).
    pub database_id: String,
    /// 이 실행에서 읽은 task DB 칸(실행마다 한 번 읽는다).
    schema: Option<TaskSchema>,
}

impl<'a> TasksStep<'a> {
    /// `database_id` 의 task 와 `mode` 만큼 잇는다.
    pub fn new(
        mode: TasksMode,
        http: &'a reqwest::Client,
        settings: &'a GeminiSettings,
        tokens: &'a Tokens,
        client: NotionClient<'a>,
        database_id: impl Into<String>,
    ) -> Self {
        Self {
            mode,
            http,
            settings,
            tokens,
            client,
            database_id: database_id.into(),
            schema: None,
        }
    }
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// What to do after the script, for one run. A step left `None` is off.
pub struct FollowUps<'a> {
    /// The context correction ([`with_correct`](Self::with_correct)).
    pub correct: Option<CorrectStep<'a>>,
    /// The summary.
    pub summary: Option<SummaryStep<'a>>,
    /// The Notion page.
    pub notion: Option<NotionStep<'a>>,
    /// pubkey → name, for the summary and the page.
    pub names: &'a dyn DisplayNames,
    /// 참석자 프로필 이름을 물을 곳([`with_profiles`](Self::with_profiles)). 있으면 회의마다
    /// 한 번 묻고 그 회의에서는 `names` 대신 그 이름표를 쓴다.
    pub profiles: Option<&'a ProfileSource>,
    /// 페이지 뒤 팀 task DB 연결([`with_tasks`](Self::with_tasks)).
    pub tasks: Option<TasksStep<'a>>,
    deadline: Option<Instant>,
    clock: &'a dyn Fn() -> u64,
    correct_run: ForRun,
    summary_run: ForRun,
    notion_run: ForRun,
    tasks_run: ForRun,
}

impl<'a> FollowUps<'a> {
    /// These steps, with no deadline and the system clock.
    pub fn new(
        summary: Option<SummaryStep<'a>>,
        notion: Option<NotionStep<'a>>,
        names: &'a dyn DisplayNames,
    ) -> Self {
        Self {
            correct: None,
            summary,
            notion,
            names,
            profiles: None,
            tasks: None,
            deadline: None,
            clock: &system_now_ms,
            correct_run: ForRun::default(),
            summary_run: ForRun::default(),
            notion_run: ForRun::default(),
            tasks_run: ForRun::default(),
        }
    }

    /// Also correct the script before the summary.
    pub fn with_correct(mut self, step: CorrectStep<'a>) -> Self {
        self.correct = Some(step);
        self
    }

    /// 페이지 뒤에 팀 task DB 와 잇는다(요약과 노션 페이지가 있어야 돈다).
    pub fn with_tasks(mut self, step: TasksStep<'a>) -> Self {
        self.tasks = Some(step);
        self
    }

    /// 사람 이름을 `source` 에서 회의마다 한 번 물은 프로필 이름으로 보인다. 못 찾은
    /// 사람은 pubkey 앞 8자.
    pub fn with_profiles(mut self, source: &'a ProfileSource) -> Self {
        self.profiles = Some(source);
        self
    }

    /// Nothing new starts with less than [`FOLLOW_UP_MIN_LEFT`] before
    /// `deadline`.
    pub fn with_deadline(mut self, deadline: Instant) -> Self {
        self.deadline = Some(deadline);
        self
    }

    /// Another clock (UTC ms) for waiting after failures (tests).
    pub fn with_clock(mut self, clock: &'a dyn Fn() -> u64) -> Self {
        self.clock = clock;
        self
    }

    /// Some step is on.
    pub fn any(&self) -> bool {
        self.correct.is_some()
            || self.summary.is_some()
            || self.notion.is_some()
            || self.tasks.is_some()
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn short_of_time(&self) -> bool {
        self.deadline.is_some_and(|deadline| {
            deadline.saturating_duration_since(Instant::now()) < FOLLOW_UP_MIN_LEFT
        })
    }
}

/// Why a step was not tried this run (a later run does it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Later {
    /// The Notion page waits for the summary.
    Summary,
    /// Less than [`FOLLOW_UP_MIN_LEFT`] before the run's deadline.
    TimeLimit,
    /// Off for the rest of this run: refused, rate-limited, or trouble on
    /// [`TROUBLE_IN_A_ROW`] meetings in a row.
    OffForRun,
    /// This meeting waits after its free failures ([`backoff`]).
    Backoff,
    /// The minutes home failed in an earlier step.
    Home,
    /// task 연결이 노션 회의록 페이지를 기다린다.
    Page,
}

impl Later {
    /// For the log.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "waiting for the summary",
            Self::TimeLimit => "too little time left in this run",
            Self::OffForRun => "off for this run (refused, rate-limited or in trouble)",
            Self::Backoff => "waiting after earlier failures",
            Self::Home => "the minutes home failed",
            Self::Page => "waiting for the Notion page",
        }
    }
}

/// What happened to one step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Not asked for.
    Off,
    /// Done on an earlier run for this very script; nothing sent.
    AlreadyDone,
    /// Done now.
    Done,
    /// The step (correction or summary) was given up for this script on an
    /// earlier run ([`StepFailures::summary_given_up`]); nothing sent.
    GaveUp,
    /// Not tried this run; a later run does it.
    Later(Later),
    /// Failed now. Kind and codes only, never meeting text, and how it was
    /// counted.
    Failed(String),
    /// 이 회의에는 하지 않는다(task 연결: 맞대 볼 요약이 없음, 끝난 지 오래된 회의). 보낸 것도
    /// 남은 것도 없다.
    Skipped(&'static str),
}

/// What the correction made this run, numbers only (for the log).
#[derive(Debug, Clone, PartialEq)]
pub struct CorrectReport {
    /// Sure edits put into the text.
    pub sure: usize,
    /// Unsure edits left as suggestions.
    pub unsure: usize,
    /// Edits that failed a check.
    pub dropped: u64,
    /// Tokens and cost.
    pub usage: Usage,
}

/// The steps after the script.
#[derive(Debug)]
pub struct FollowedUp {
    /// The context correction.
    pub correct: Step,
    /// The summary.
    pub summary: Step,
    /// The Notion page.
    pub notion: Step,
    /// The minutes home failed (a record not read or written, or the hold
    /// lost): the meeting failed, though its script stands. The step it
    /// happened in is [`Step::Failed`].
    pub home_error: Option<MeetingError>,
    /// Tokens and cost of the summary made this run (none when none was
    /// made now; a paid failure's are not known).
    pub summary_usage: Option<Usage>,
    /// What the correction made this run (none when none was made now).
    pub correct_made: Option<CorrectReport>,
    /// 이번에 참석자 프로필 이름을 물었으면 그 결과(수와 까닭의 종류만). 단계의 실패로
    /// 세지 않는다.
    pub names: Option<NamesReport>,
    /// 이번에 노션 페이지를 써 봤으면 그 보고(담당자 연결 DB 에 한 일 포함). 로그에는
    /// 수와 까닭의 종류만 찍는다.
    pub notion_report: Option<PublishReport>,
    /// 팀 task DB 연결.
    pub tasks: Step,
    /// 이번에 task 연결을 해 봤으면 그 보고(수만).
    pub tasks_made: Option<TasksReport>,
}

impl FollowedUp {
    fn steps(&self) -> [&Step; 3] {
        [&self.correct, &self.summary, &self.notion]
    }

    /// A later run has something to do.
    pub fn left_for_next_run(&self) -> bool {
        self.steps()
            .into_iter()
            .chain([&self.tasks])
            .any(|step| matches!(step, Step::Failed(_) | Step::Later(_)))
    }

    /// A step failed this run. task 연결의 실패는 넣지 않는다: 회의록은 그래도 됐다
    /// ([`tasks_failed`](Self::tasks_failed) 로 따로 본다).
    pub fn has_failure(&self) -> bool {
        self.steps()
            .iter()
            .any(|step| matches!(step, Step::Failed(_)))
    }

    /// task 연결이 이번에 실패했다(회의 실패로는 안 센다. 다음 실행에 다시 한다).
    pub fn tasks_failed(&self) -> bool {
        matches!(self.tasks, Step::Failed(_))
    }

    /// Nothing was done, tried or left this run.
    pub fn nothing_left(&self) -> bool {
        self.home_error.is_none()
            && self.steps().into_iter().chain([&self.tasks]).all(|step| {
                matches!(
                    step,
                    Step::Off | Step::AlreadyDone | Step::GaveUp | Step::Skipped(_)
                )
            })
    }
}

fn io(error: serde_json::Error) -> MeetingError {
    MeetingError::Io(std::io::Error::other(error))
}

/// One meeting being followed up: what the steps share.
struct Held<'a, H: MinutesHome> {
    home: &'a H,
    hold: &'a H::Hold,
    meeting: &'a MeetingPlan,
    script_sha256: &'a str,
    given: Option<&'a Transcript>,
    read: Option<Transcript>,
}

impl<H: MinutesHome> Held<'_, H> {
    /// The script: as given, or read now. It must still be the script the
    /// sha256 is of.
    async fn script(&mut self) -> Result<&Transcript, MeetingError> {
        if let Some(given) = self.given {
            return Ok(given);
        }
        let script = match self.read.take() {
            Some(script) => script,
            None => {
                let name = self.home.script_name(self.meeting);
                let bytes = self
                    .home
                    .read_script(self.meeting)
                    .await?
                    .ok_or_else(|| MeetingError::Scripts(format!("{name}: gone")))?;
                if sha256_hex(&bytes) != self.script_sha256 {
                    return Err(MeetingError::Scripts(format!("{name}: changed")));
                }
                serde_json::from_slice(&bytes).map_err(|e| {
                    MeetingError::Scripts(format!("{name}: not a script ({:?})", e.classify()))
                })?
            }
        };
        Ok(self.read.insert(script))
    }

    /// This script's failures of a step (none for another script's). The
    /// inner `Err` is a record that cannot be read.
    async fn failures(&self, beside: Beside) -> Result<Result<StepFailures, ()>, MeetingError> {
        let fresh = StepFailures::new(self.script_sha256);
        Ok(match self.home.read_beside(self.meeting, beside).await? {
            None => Ok(fresh),
            Some(bytes) => match serde_json::from_slice::<StepFailures>(&bytes) {
                Ok(failures) if failures.script_sha256 == self.script_sha256 => Ok(failures),
                Ok(_) => Ok(fresh),
                Err(_) => Err(()),
            },
        })
    }

    /// Fails with [`MeetingError::HoldLost`] when another worker has taken
    /// the meeting over.
    async fn check_held(&self) -> Result<(), MeetingError> {
        match self.home.still_held(self.hold).await? {
            true => Ok(()),
            false => Err(MeetingError::HoldLost),
        }
    }

    async fn write(&self, beside: Beside, json: Vec<u8>) -> Result<(), MeetingError> {
        self.check_held().await?;
        self.home.write_beside(self.meeting, beside, json).await?;
        Ok(())
    }

    async fn write_failures(
        &self,
        beside: Beside,
        failures: &StepFailures,
    ) -> Result<(), MeetingError> {
        let json = serde_json::to_vec_pretty(failures).map_err(io)?;
        self.write(beside, json).await
    }
}

/// 회의 하나의 이름표. 프로필 이름을 켰으면 어느 단계든 처음 이름이 필요할 때 한 번만
/// 묻고, 그 회의의 남은 단계가 같은 이름표를 쓴다.
struct MeetingNames<'a> {
    /// 실행 전체의 이름표(`FollowUps::names`).
    run: &'a dyn DisplayNames,
    source: Option<&'a ProfileSource>,
    asked: Option<ProfileNames>,
}

impl<'a> MeetingNames<'a> {
    fn new(steps: &FollowUps<'a>) -> Self {
        Self {
            run: steps.names,
            source: steps.profiles,
            asked: None,
        }
    }

    /// `transcript`(이 회의 스크립트)에 쓸 이름표.
    async fn get(&mut self, transcript: &Transcript) -> &dyn DisplayNames {
        let Some(source) = self.source else {
            return self.run;
        };
        if self.asked.is_none() {
            self.asked = Some(source.names_for(transcript).await);
        }
        match &self.asked {
            Some(names) => names,
            None => self.run,
        }
    }

    /// 물었으면 그 결과.
    fn report(&self) -> Option<NamesReport> {
        self.asked.as_ref().map(|names| names.report().clone())
    }
}

/// Which text the summary and the page use.
enum ForText {
    /// The correction is off: the original, and stamps are not compared.
    Off,
    /// This script's correction and the sha256 of its stored bytes.
    Made(Box<Corrected>, String),
    /// No correction (yet, or given up): the original.
    Original,
}

impl ForText {
    /// What the summary and the page record as the text they used, to
    /// compare with; `None` when the correction is off.
    fn stamp(&self) -> Option<&str> {
        match self {
            Self::Off => None,
            Self::Made(_, sha) => Some(sha),
            Self::Original => Some(""),
        }
    }

    fn corrected(&self) -> Option<&Corrected> {
        match self {
            Self::Made(corrected, _) => Some(corrected),
            Self::Off | Self::Original => None,
        }
    }
}

/// Where the summary stands, for the page.
enum ForPage {
    /// The summary is off: the page goes without one, whatever it had.
    Off,
    /// This script's summary and the sha256 of its stored bytes.
    Made(Box<Summary>, String),
    /// Given up for this script.
    GivenUp,
    /// Not there (yet): the page waits.
    Missing,
}

/// The summary and the Notion page of `meeting`, whose script's bytes have
/// the sha256 `script_sha256`, then the team's task DB. Call it while
/// holding the meeting (`hold`). `transcript` is that script when the caller
/// has it; otherwise it is read only if a step needs it. Steps that fail are
/// reported, never returned: the script and its report stand whatever
/// happens here.
pub async fn follow_up_held<H: MinutesHome>(
    home: &H,
    hold: &H::Hold,
    meeting: &MeetingPlan,
    script_sha256: &str,
    transcript: Option<&Transcript>,
    steps: &mut FollowUps<'_>,
) -> FollowedUp {
    let mut held = Held {
        home,
        hold,
        meeting,
        script_sha256,
        given: transcript,
        read: None,
    };
    let mut names = MeetingNames::new(steps);
    let later = |on: bool| {
        if on {
            Step::Later(Later::Home)
        } else {
            Step::Off
        }
    };
    let tasks_on = steps.tasks.is_some();
    let (correct, for_text) = match correct_step(&mut held, steps, &mut names).await {
        Ok(done) => done,
        Err(error) => {
            return FollowedUp {
                correct: Step::Failed(format!("minutes home: {error}")),
                summary: later(steps.summary.is_some()),
                notion: later(steps.notion.is_some()),
                home_error: Some(error),
                summary_usage: None,
                correct_made: None,
                names: names.report(),
                notion_report: None,
                tasks: later(tasks_on),
                tasks_made: None,
            }
        }
    };
    let correct_made = match (&correct, &for_text) {
        (Step::Done, ForText::Made(made, _)) => Some(CorrectReport {
            sure: made.sure_edits(),
            unsure: made.unsure_edits(),
            dropped: made.dropped,
            usage: made.usage.clone(),
        }),
        _ => None,
    };
    let (summary, for_page) = match summary_step(&mut held, steps, &for_text, &mut names).await {
        Ok(done) => done,
        Err(error) => {
            return FollowedUp {
                correct,
                summary: Step::Failed(format!("minutes home: {error}")),
                notion: later(steps.notion.is_some()),
                home_error: Some(error),
                summary_usage: None,
                correct_made,
                names: names.report(),
                notion_report: None,
                tasks: later(tasks_on),
                tasks_made: None,
            }
        }
    };
    let summary_usage = match (&summary, &for_page) {
        (Step::Done, ForPage::Made(made, _)) => Some(made.usage.clone()),
        _ => None,
    };
    let mut notion_report = None;
    let notion = notion_step(
        &mut held,
        steps,
        &for_page,
        &for_text,
        &mut names,
        &mut notion_report,
    )
    .await;
    let notion = match notion {
        Ok(notion) => notion,
        Err(error) => {
            return FollowedUp {
                correct,
                summary,
                notion: Step::Failed(format!("minutes home: {error}")),
                home_error: Some(error),
                summary_usage,
                correct_made,
                names: names.report(),
                notion_report,
                tasks: later(tasks_on),
                tasks_made: None,
            }
        }
    };
    let mut tasks_made = None;
    let tasks = tasks_step(
        &mut held,
        steps,
        &for_page,
        &notion,
        &mut names,
        &mut tasks_made,
    )
    .await;
    let (tasks, home_error) = match tasks {
        Ok(tasks) => (tasks, None),
        Err(error) => (Step::Failed(format!("minutes home: {error}")), Some(error)),
    };
    FollowedUp {
        correct,
        summary,
        notion,
        home_error,
        summary_usage,
        correct_made,
        names: names.report(),
        notion_report,
        tasks,
        tasks_made,
    }
}

/// Count a failed Gemini step (the correction or the summary) for its
/// meeting and write its record: the log text, and whether the step is now
/// given up for this script.
async fn gemini_failure<H: MinutesHome>(
    held: &Held<'_, H>,
    run: &mut ForRun,
    now: u64,
    mut failures: StepFailures,
    beside: Beside,
    error: &SummaryError,
) -> Result<(String, bool), MeetingError> {
    let (cost, signal) = summary_class(error);
    let cost = run.count_as(cost, signal);
    failures.count(cost, error.kind.as_str(), &error.code, now);
    if cost != Cost::Uncounted {
        held.write_failures(beside, &failures).await?;
    }
    let given_up = failures.summary_given_up();
    let text = format!(
        "{} {}{}",
        error.kind,
        error.code,
        failures.tally(cost, given_up, now)
    );
    Ok((text, given_up))
}

async fn correct_step<H: MinutesHome>(
    held: &mut Held<'_, H>,
    steps: &mut FollowUps<'_>,
    names: &mut MeetingNames<'_>,
) -> Result<(Step, ForText), MeetingError> {
    if steps.correct.is_none() {
        return Ok((Step::Off, ForText::Off));
    }
    if let Some(bytes) = held
        .home
        .read_beside(held.meeting, Beside::Corrected)
        .await?
    {
        let Ok(stored) = serde_json::from_slice::<Corrected>(&bytes) else {
            // Asking again would pay again: someone has to look.
            let failed = Step::Failed("stored correction unreadable".into());
            return Ok((failed, ForText::Original));
        };
        if stored.script_sha256 == held.script_sha256 {
            let sha = sha256_hex(&bytes);
            return Ok((Step::AlreadyDone, ForText::Made(Box::new(stored), sha)));
        }
        // Another script's correction: this script still needs its own.
    }
    let Ok(failures) = held.failures(Beside::CorrectFailed).await? else {
        // Its paid tries are not known: not paid for again.
        let failed = Step::Failed("stored correction failures unreadable".into());
        return Ok((failed, ForText::Original));
    };
    if failures.summary_given_up() {
        return Ok((Step::GaveUp, ForText::Original));
    }
    if failures.waiting(steps.now()) {
        return Ok((Step::Later(Later::Backoff), ForText::Original));
    }
    if steps.correct_run.off {
        return Ok((Step::Later(Later::OffForRun), ForText::Original));
    }
    if steps.short_of_time() {
        return Ok((Step::Later(Later::TimeLimit), ForText::Original));
    }
    let Some(step) = &steps.correct else {
        return Ok((Step::Off, ForText::Off));
    };
    // No request or wait past the run's deadline.
    let mut settings = step.settings.clone();
    settings.deadline = steps.deadline;
    let transcript = held.script().await?;
    let shown = names.get(transcript).await;
    let asked = correct::correct(
        step.http,
        &settings,
        step.tokens,
        transcript,
        shown,
        step.glossary,
    )
    .await;
    let error = match asked {
        Ok(mut made) => {
            steps.correct_run.heard(Signal::Answered);
            steps.correct_run.succeeded = true;
            made.script_sha256 = held.script_sha256.to_string();
            let json = serde_json::to_vec_pretty(&made).map_err(io)?;
            let sha = sha256_hex(&json);
            held.write(Beside::Corrected, json).await?;
            return Ok((Step::Done, ForText::Made(Box::new(made), sha)));
        }
        Err(error) => error,
    };
    // Nothing sent: the deadline came first.
    if error.kind == SummaryErrorKind::OutOfTime && !error.may_have_cost() {
        return Ok((Step::Later(Later::TimeLimit), ForText::Original));
    }
    let now = steps.now();
    let (text, _) = gemini_failure(
        held,
        &mut steps.correct_run,
        now,
        failures,
        Beside::CorrectFailed,
        &error,
    )
    .await?;
    Ok((Step::Failed(text), ForText::Original))
}

async fn summary_step<H: MinutesHome>(
    held: &mut Held<'_, H>,
    steps: &mut FollowUps<'_>,
    for_text: &ForText,
    names: &mut MeetingNames<'_>,
) -> Result<(Step, ForPage), MeetingError> {
    if steps.summary.is_none() {
        return Ok((Step::Off, ForPage::Off));
    }
    // This script's summary of the text before its correction: the page
    // keeps it if the new one is given up.
    let mut earlier = None;
    if let Some(bytes) = held.home.read_beside(held.meeting, Beside::Summary).await? {
        let Ok(stored) = serde_json::from_slice::<Summary>(&bytes) else {
            // Asking again would pay again: someone has to look.
            let failed = Step::Failed("stored summary unreadable".into());
            return Ok((failed, ForPage::Missing));
        };
        let same_text = for_text
            .stamp()
            .is_none_or(|stamp| stamp == stored.corrected_sha256);
        if stored.script_sha256 == held.script_sha256 {
            let sha = sha256_hex(&bytes);
            if same_text {
                return Ok((Step::AlreadyDone, ForPage::Made(Box::new(stored), sha)));
            }
            earlier = Some((Box::new(stored), sha));
        }
        // Another script's summary, or this script's before its correction
        // came: this text still needs its own.
    }
    let Ok(failures) = held.failures(Beside::SummaryFailed).await? else {
        // Its paid tries are not known: not paid for again.
        let failed = Step::Failed("stored summary failures unreadable".into());
        return Ok((failed, ForPage::Missing));
    };
    if failures.summary_given_up() {
        return Ok((Step::GaveUp, given_up_page(earlier)));
    }
    if failures.waiting(steps.now()) {
        return Ok((Step::Later(Later::Backoff), ForPage::Missing));
    }
    if steps.summary_run.off {
        return Ok((Step::Later(Later::OffForRun), ForPage::Missing));
    }
    if steps.short_of_time() {
        return Ok((Step::Later(Later::TimeLimit), ForPage::Missing));
    }
    let Some(step) = &steps.summary else {
        return Ok((Step::Off, ForPage::Off));
    };
    // No request or wait past the run's deadline.
    let mut settings = step.settings.clone();
    settings.deadline = steps.deadline;
    let script = held.script().await?;
    let shown = names.get(script).await;
    let fixed;
    let transcript = match for_text.corrected() {
        Some(corrected) => {
            fixed = correct::corrected_transcript(script, corrected);
            &fixed
        }
        None => script,
    };
    // The model reads the corrected text; its evidence is checked against
    // the original. 프롬프트와 담당자 검사는 같은 이름표(`shown`)를 쓴다.
    let asked =
        summary::summarize_from(step.http, &settings, step.tokens, script, transcript, shown).await;
    let error = match asked {
        Ok(mut made) => {
            steps.summary_run.heard(Signal::Answered);
            steps.summary_run.succeeded = true;
            made.script_sha256 = held.script_sha256.to_string();
            made.corrected_sha256 = for_text.stamp().unwrap_or_default().to_string();
            let json = serde_json::to_vec_pretty(&made).map_err(io)?;
            let sha = sha256_hex(&json);
            held.write(Beside::Summary, json).await?;
            return Ok((Step::Done, ForPage::Made(Box::new(made), sha)));
        }
        Err(error) => error,
    };
    // Nothing sent: the deadline came first.
    if error.kind == SummaryErrorKind::OutOfTime && !error.may_have_cost() {
        return Ok((Step::Later(Later::TimeLimit), ForPage::Missing));
    }
    let now = steps.now();
    let (text, given_up) = gemini_failure(
        held,
        &mut steps.summary_run,
        now,
        failures,
        Beside::SummaryFailed,
        &error,
    )
    .await?;
    Ok((
        Step::Failed(text),
        if given_up {
            given_up_page(earlier)
        } else {
            ForPage::Missing
        },
    ))
}

/// The page's summary once this text's summary is given up: the script's
/// earlier summary (of the text before its correction) when there is one.
fn given_up_page(earlier: Option<(Box<Summary>, String)>) -> ForPage {
    match earlier {
        Some((summary, sha)) => ForPage::Made(summary, sha),
        None => ForPage::GivenUp,
    }
}

/// The Notion page. `published` gets the publish report once a page write
/// is tried (also when it fails), for the log.
async fn notion_step<H: MinutesHome>(
    held: &mut Held<'_, H>,
    steps: &mut FollowUps<'_>,
    for_page: &ForPage,
    for_text: &ForText,
    names: &mut MeetingNames<'_>,
    published: &mut Option<PublishReport>,
) -> Result<Step, MeetingError> {
    if steps.notion.is_none() {
        return Ok(Step::Off);
    }
    let (summary, summary_stamp) = match for_page {
        ForPage::Missing => return Ok(Step::Later(Later::Summary)),
        // Not compared: the page keeps what it was written with.
        ForPage::Off => (None, None),
        ForPage::Made(summary, sha) => (Some(summary.as_ref()), Some(sha.clone())),
        ForPage::GivenUp => (None, Some(SUMMARY_GIVEN_UP_STAMP.to_string())),
    };
    let done = held
        .home
        .read_notion_record(held.meeting)
        .await?
        .and_then(|bytes| serde_json::from_slice::<NotionRecord>(&bytes).ok())
        .is_some_and(|record| {
            record.done
                && record.script_sha256 == held.script_sha256
                && summary_stamp
                    .as_ref()
                    .is_none_or(|stamp| *stamp == record.summary_sha256)
                && for_text
                    .stamp()
                    .is_none_or(|stamp| stamp == record.corrected_sha256)
        });
    if done {
        return Ok(Step::AlreadyDone);
    }
    // Trying again costs nothing: a record that cannot be read starts over.
    let mut failures = held
        .failures(Beside::NotionFailed)
        .await?
        .unwrap_or_else(|()| StepFailures::new(held.script_sha256));
    if failures.waiting(steps.now()) {
        return Ok(Step::Later(Later::Backoff));
    }
    if steps.notion_run.off {
        return Ok(Step::Later(Later::OffForRun));
    }
    if steps.short_of_time() {
        return Ok(Step::Later(Later::TimeLimit));
    }
    // task 연결이 이미 붙인 「관련 있을 수 있는 task」 절은 다시 써도 남긴다.
    let tail = match steps.tasks.is_some() {
        true => maybe_tail(held).await?,
        false => Vec::new(),
    };
    let Some(step) = steps.notion.as_mut() else {
        return Ok(Step::Off);
    };
    let given_up = summary_stamp.as_deref() == Some(SUMMARY_GIVEN_UP_STAMP);
    let stamp = RecordStamp {
        script_sha256: held.script_sha256.to_string(),
        summary_sha256: summary_stamp.unwrap_or_default(),
        corrected_sha256: for_text.stamp().unwrap_or_default().to_string(),
    };
    let (home, hold, meeting) = (held.home, held.hold, held.meeting);
    let transcript = held.script().await?;
    let shown = names.get(transcript).await;
    let page = MeetingPage {
        transcript,
        corrected: for_text.corrected(),
        summary,
        summary_note: given_up.then_some(SUMMARY_GIVEN_UP),
        names: shown,
        title_prefix: &step.title_prefix,
        channel_label: step.channel_label.as_deref(),
        kind: step.kind,
        status: ProcessingStatus::Done,
        tail: &tail,
    };
    let report = published.insert(PublishReport::default());
    let result =
        notion::publish_held(home, hold, meeting, &mut step.client, &page, &stamp, report).await;
    let error = match result {
        Ok(()) => {
            steps.notion_run.heard(Signal::Answered);
            steps.notion_run.succeeded = true;
            return Ok(Step::Done);
        }
        Err(PublishMeetingError::Home(error)) => return Err(error),
        // Marked "실패" on the page (or found by notion-stale).
        Err(PublishMeetingError::Notion(error)) => error,
    };
    let (cost, signal) = notion_class(error.kind);
    let cost = steps.notion_run.count_as(cost, signal);
    let now = steps.now();
    // Only the kind and codes: Notion's message can quote the page.
    failures.count(cost, error.kind.as_str(), error.short_code(), now);
    if cost != Cost::Uncounted {
        held.write_failures(Beside::NotionFailed, &failures).await?;
    }
    Ok(Step::Failed(format!(
        "{}{}",
        error.short(),
        failures.tally(cost, false, now)
    )))
}

/// 회의록 페이지를 다시 쓸 때 끝에 붙일 「관련 있을 수 있는 task」 절: task 연결이 그 절을 이미
/// 붙였을 때만(장부에 끝낸 쓰기로 있을 때). 아직 안 붙였으면 task 연결이 붙인다.
async fn maybe_tail<H: MinutesHome>(held: &Held<'_, H>) -> Result<Vec<Value>, MeetingError> {
    let Some(bytes) = held.home.read_beside(held.meeting, Beside::Tasks).await? else {
        return Ok(Vec::new());
    };
    Ok(serde_json::from_slice::<TasksLedger>(&bytes)
        .ok()
        .filter(|ledger| {
            let key = tasks::Write::Maybe.key(&ledger.plan);
            ledger.done.contains(&key)
        })
        .map(|ledger| tasks::maybe_blocks(&ledger.plan.maybe))
        .unwrap_or_default())
}

/// task 연결이 실패한 곳.
enum TasksError {
    /// Gemini(요약과 같은 규칙으로 센다).
    Gemini(SummaryError),
    /// 노션 task DB·회의록 페이지.
    Notion(NotionError),
}

/// task 연결의 실패를 그 회의 몫으로 세고 기록을 쓴다. 로그 글에는 종류와 코드만 넣는다(노션
/// 메시지는 페이지 글을 옮겨 올 수 있다).
async fn tasks_failure<H: MinutesHome>(
    held: &Held<'_, H>,
    run: &mut ForRun,
    now: u64,
    mut failures: StepFailures,
    error: TasksError,
) -> Result<Step, MeetingError> {
    let (cost, signal, kind, code) = match &error {
        TasksError::Gemini(error) => {
            // Nothing sent: the deadline came first.
            if error.kind == SummaryErrorKind::OutOfTime && !error.may_have_cost() {
                return Ok(Step::Later(Later::TimeLimit));
            }
            let (cost, signal) = summary_class(error);
            (cost, signal, error.kind.as_str(), error.code.clone())
        }
        TasksError::Notion(error) => {
            let (cost, signal) = notion_class(error.kind);
            (
                cost,
                signal,
                error.kind.as_str(),
                error.short_code().to_string(),
            )
        }
    };
    let cost = run.count_as(cost, signal);
    failures.count(cost, kind, &code, now);
    if cost != Cost::Uncounted {
        held.write_failures(Beside::TasksFailed, &failures).await?;
    }
    let given_up = failures.summary_given_up();
    Ok(Step::Failed(format!(
        "{kind} {code}{}",
        failures.tally(cost, given_up, now)
    )))
}

/// 팀 task DB 연결([`crate::tasks`]). 이 글의 요약과 끝난 노션 페이지가 있을 때만 돈다. 회의마다
/// 한 번: 장부가 끝남이면 다시 하지 않는다. 장부가 없으면 계획을 세워(Gemini 한 번) 쓰기 전에
/// 남기고, 쓰기를 하나 할 때마다 끝낸 것을 더한다. 실패는 [`FollowedUp::has_failure`] 에 안
/// 들어간다(회의록은 됐다). 작업기 저장소가 실패하면 `Err`(회의 실패).
async fn tasks_step<H: MinutesHome>(
    held: &mut Held<'_, H>,
    steps: &mut FollowUps<'_>,
    for_page: &ForPage,
    notion: &Step,
    names: &mut MeetingNames<'_>,
    made: &mut Option<TasksReport>,
) -> Result<Step, MeetingError> {
    if steps
        .tasks
        .as_ref()
        .is_none_or(|step| step.mode == TasksMode::Off)
    {
        return Ok(Step::Off);
    }
    let (summary, summary_sha) = match for_page {
        ForPage::Made(summary, sha) => (summary.as_ref(), sha.as_str()),
        ForPage::Missing => return Ok(Step::Later(Later::Summary)),
        ForPage::GivenUp => return Ok(Step::Skipped("no summary to match")),
        ForPage::Off => return Ok(Step::Skipped("the summary is off")),
    };
    match notion {
        Step::Done | Step::AlreadyDone => {}
        Step::Off => return Ok(Step::Skipped("the Notion page is off")),
        _ => return Ok(Step::Later(Later::Page)),
    }
    // 끝난 지 오래된 회의는 지금 task 를 건드리지 않는다(읽지도 보내지도 않는다).
    let now = steps.now();
    if now.saturating_sub(held.meeting.ended_at_unix_ms()) > TASKS_MAX_AGE_MS {
        return Ok(Step::Skipped("the meeting ended over 24 hours ago"));
    }
    let ledger = match held.home.read_beside(held.meeting, Beside::Tasks).await? {
        None => None,
        Some(bytes) => match serde_json::from_slice::<TasksLedger>(&bytes) {
            Ok(ledger) => Some(ledger),
            // Asking again would pay again, and what was written is not known.
            Err(_) => return Ok(Step::Failed("stored task links unreadable".into())),
        },
    };
    if ledger.as_ref().is_some_and(|ledger| ledger.finished) {
        return Ok(Step::AlreadyDone);
    }
    let Ok(failures) = held.failures(Beside::TasksFailed).await? else {
        // Its paid tries are not known: not paid for again.
        return Ok(Step::Failed("stored task link failures unreadable".into()));
    };
    if failures.summary_given_up() {
        return Ok(Step::GaveUp);
    }
    if failures.waiting(now) {
        return Ok(Step::Later(Later::Backoff));
    }
    if steps.tasks_run.off {
        return Ok(Step::Later(Later::OffForRun));
    }
    if steps.short_of_time() {
        return Ok(Step::Later(Later::TimeLimit));
    }
    let deadline = steps.deadline;
    let FollowUps {
        tasks: Some(step),
        tasks_run: run,
        ..
    } = steps
    else {
        return Ok(Step::Off);
    };
    let report = made.insert(TasksReport::default());
    let mut asked = None;
    let mut ledger = match ledger {
        Some(ledger) => ledger,
        None => {
            // 회의록 페이지: 앞 단계가 끝냈다고 본 기록.
            let page_id = held
                .home
                .read_notion_record(held.meeting)
                .await?
                .and_then(|bytes| serde_json::from_slice::<NotionRecord>(&bytes).ok())
                .filter(|record| record.done && !record.page_id.is_empty())
                .map(|record| record.page_id);
            let Some(page_id) = page_id else {
                return Ok(Step::Later(Later::Page));
            };
            let planned =
                plan_tasks(held, step, deadline, summary, summary_sha, page_id, names).await?;
            match planned {
                Ok(ledger) => {
                    asked = ledger.usage.clone();
                    ledger
                }
                Err(error) => return tasks_failure(held, run, now, failures, error).await,
            }
        }
    };
    report.plan(&ledger.plan);
    report.usage = asked;
    let link = step.client.settings().playback_link.clone();
    let mut failed = None;
    for write in tasks::writes(&ledger.plan, ledger.mode.min(step.mode)) {
        let key = write.key(&ledger.plan);
        if ledger.done.contains(&key) {
            continue;
        }
        match tasks::apply(&mut step.client, &mut ledger, write, &link).await {
            Ok(wrote) => {
                tasks::count(report, write, wrote);
                ledger.done.push(key);
                held.write(Beside::Tasks, ledger_json(&ledger)?).await?;
            }
            Err(error) => {
                failed = Some(error);
                break;
            }
        }
    }
    if let Some(error) = failed {
        return tasks_failure(held, run, now, failures, TasksError::Notion(error)).await;
    }
    ledger.finished = true;
    held.write(Beside::Tasks, ledger_json(&ledger)?).await?;
    run.heard(Signal::Answered);
    run.succeeded = true;
    Ok(Step::Done)
}

fn ledger_json(ledger: &TasksLedger) -> Result<Vec<u8>, MeetingError> {
    serde_json::to_vec_pretty(ledger).map_err(io)
}

/// task 연결 계획: task DB 칸(실행마다 한 번)과 진행 중 task 를 읽고, 물을 거리가 있으면 Gemini 에
/// 한 번 묻고 검사해서, 쓰기 전에 장부에 남긴다. 회의 안의 글은 원본 스크립트로 검사한다.
#[allow(clippy::too_many_arguments)]
async fn plan_tasks<H: MinutesHome>(
    held: &mut Held<'_, H>,
    step: &mut TasksStep<'_>,
    deadline: Option<Instant>,
    summary: &Summary,
    summary_sha: &str,
    page_id: String,
    names: &mut MeetingNames<'_>,
) -> Result<Result<TasksLedger, TasksError>, MeetingError> {
    let schema = match &step.schema {
        Some(schema) => schema.clone(),
        None => match tasks::read_schema(&mut step.client, &step.database_id).await {
            Ok(schema) => step.schema.insert(schema).clone(),
            Err(error) => return Ok(Err(TasksError::Notion(error))),
        },
    };
    let open = match tasks::open_tasks(&mut step.client, &schema).await {
        Ok(open) => open,
        Err(error) => return Ok(Err(TasksError::Notion(error))),
    };
    let script_sha256 = held.script_sha256.to_string();
    let (plan, usage, meeting, channel_id) = {
        let transcript = held.script().await?;
        let shown = names.get(transcript).await;
        let input = CheckInput {
            summary,
            tasks: &open,
            schema: &schema,
            transcript,
            names: shown,
            mode: step.mode,
        };
        let meeting = tasks::meeting_label(transcript);
        let channel_id = transcript.channel_id;
        if tasks::worth_asking(&input) {
            // No request or wait past the run's deadline.
            let mut settings = step.settings.clone();
            settings.deadline = deadline;
            match tasks::ask(step.http, &settings, step.tokens, &input).await {
                Ok((plan, usage)) => (plan, Some(usage), meeting, channel_id),
                Err(error) => return Ok(Err(TasksError::Gemini(error))),
            }
        } else {
            (Plan::default(), None, meeting, channel_id)
        }
    };
    let ledger = TasksLedger {
        format: TASKS_FORMAT.into(),
        mode: step.mode,
        script_sha256,
        summary_sha256: summary_sha.to_string(),
        minutes_page_id: page_id,
        channel_id,
        meeting,
        schema,
        plan,
        usage,
        done: Vec::new(),
        created: Default::default(),
        finished: false,
    };
    held.write(Beside::Tasks, ledger_json(&ledger)?).await?;
    Ok(Ok(ledger))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;

    use buzz_gcp::fake::FakeGcs;
    use buzz_gcp::gcs::Gcs;
    use buzz_gcp::token::{AccessToken, TokenSource};
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::gcs_minutes::GcsMinutes;
    use crate::notion::tests::{
        fake_notion, minutes_pages, plan_for, plan_in, settings_for as notion_settings, FakeNotion,
    };
    use crate::notion::{minutes_property, people_property, NotionSettings};
    use crate::pipeline::{MinutesSettings, SttPolicy};
    use crate::profiles::tests::{profile_event, source_for as profile_source};
    use crate::profiles::NamesTrouble;
    use crate::runner::{run_meeting, run_meeting_with, Done, LocalMinutes, RunOptions};
    use crate::store::LocalStore;
    use crate::stt::{SpeechToText, SttError, SttOutput, SttRequest};
    use crate::summary::tests::{answer, gemini_reply, settings_for as gemini_settings};
    use crate::summary::PubkeyPrefixNames;
    use crate::tasks::tests::{
        add_task_db, meeting as task_meeting, summary_answer, TASK_DB, TASK_DS,
    };
    use crate::tasks::{page_url, MAYBE_HEADING, RECORD_HEADING};
    use crate::test_http::{transcript_with, FakeServer, Recorded, Reply};
    use crate::transcript::SttInfo;
    use crate::vad::{SegmentPlan, SpeechDetector, SpeechSpan, VadError};

    const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";
    const FIRST: Uuid = Uuid::from_u128(3);

    fn script() -> Transcript {
        transcript_with(&[
            (1_000, A, "견적서 얘기해요."),
            (5_000, A, "금요일까지 보낼게요."),
        ])
    }

    fn other_script() -> Transcript {
        transcript_with(&[(1_000, A, "완전히 다른 새 내용이에요.")])
    }

    /// sha256 of the bytes the runner writes for `script`.
    fn sha_of(script: &Transcript) -> String {
        sha256_hex(&serde_json::to_vec_pretty(script).unwrap())
    }

    /// The two steps, with the minutes home fine.
    fn pair(followed: &FollowedUp) -> (Step, Step) {
        assert!(followed.home_error.is_none(), "{followed:?}");
        (followed.summary.clone(), followed.notion.clone())
    }

    fn failed_with(step: &Step, text: &str) -> bool {
        matches!(step, Step::Failed(failure) if failure.contains(text))
    }

    /// A fake Gemini that answers well, or refuses (HTTP 400, free) while
    /// `refuse` is set.
    async fn gemini(refuse: Arc<AtomicBool>) -> FakeServer {
        FakeServer::start(move |_| {
            if refuse.load(Ordering::SeqCst) {
                Reply::json(400, &json!({ "error": { "status": "INVALID_ARGUMENT" } }))
            } else {
                gemini_reply(&answer(json!([])), "STOP")
            }
        })
        .await
    }

    /// A fake Gemini whose answers are always cut off (paid, unusable).
    async fn cut_off_gemini() -> FakeServer {
        FakeServer::start(|_| gemini_reply(&answer(json!([])), "MAX_TOKENS")).await
    }

    struct World {
        dir: tempfile::TempDir,
        home: LocalMinutes,
        meeting: MeetingPlan,
        /// Another meeting (channel 9, first session 10).
        meeting_b: MeetingPlan,
        gemini: FakeServer,
        refuse: Arc<AtomicBool>,
        notion: FakeServer,
        state: Arc<std::sync::Mutex<FakeNotion>>,
        http: reqwest::Client,
        gemini_settings: GeminiSettings,
        notion_settings: NotionSettings,
        tokens: Tokens,
        /// The follow-ups' clock (UTC ms), moved by hand.
        clock: Arc<AtomicU64>,
        clock_fn: Box<dyn Fn() -> u64>,
    }

    async fn world() -> World {
        let dir = tempfile::tempdir().unwrap();
        let meeting = plan_for(&dir.path().join("recordings")).await;
        let meeting_b = plan_in(
            &dir.path().join("recordings"),
            Uuid::from_u128(9),
            Uuid::from_u128(10),
        )
        .await;
        let home = LocalMinutes::open(&dir.path().join("minutes")).unwrap();
        let refuse = Arc::new(AtomicBool::new(false));
        let gemini = gemini(refuse.clone()).await;
        let (notion, state) = fake_notion(FakeNotion::default()).await;
        let clock = Arc::new(AtomicU64::new(1_791_800_000_000));
        let read = clock.clone();
        World {
            clock,
            clock_fn: Box::new(move || read.load(Ordering::SeqCst)),
            gemini_settings: gemini_settings(&gemini),
            notion_settings: notion_settings(&notion),
            dir,
            home,
            meeting,
            meeting_b,
            gemini,
            refuse,
            notion,
            state,
            http: reqwest::Client::new(),
            tokens: Tokens::new(TokenSource::Static(AccessToken::new("t"))).unwrap(),
        }
    }

    impl World {
        fn summary_step<'a>(&'a self, settings: &'a GeminiSettings) -> SummaryStep<'a> {
            SummaryStep {
                http: &self.http,
                settings,
                tokens: &self.tokens,
            }
        }

        fn notion_step(&self) -> NotionStep<'_> {
            NotionStep {
                client: NotionClient::new(&self.http, &self.notion_settings, "t").unwrap(),
                title_prefix: String::new(),
                channel_label: None,
                kind: None,
            }
        }

        /// One run's steps on the world's clock: the summary from
        /// `summary` when given, the Notion page when `notion`.
        fn run<'a>(&'a self, summary: Option<&'a GeminiSettings>, notion: bool) -> FollowUps<'a> {
            FollowUps::new(
                summary.map(|settings| self.summary_step(settings)),
                notion.then(|| self.notion_step()),
                &PubkeyPrefixNames,
            )
            .with_clock(&*self.clock_fn)
        }

        fn steps(&self) -> FollowUps<'_> {
            self.run(Some(&self.gemini_settings), true)
        }

        fn now(&self) -> u64 {
            self.clock.load(Ordering::SeqCst)
        }

        fn advance(&self, by: Duration) {
            self.clock
                .fetch_add(by.as_millis() as u64, Ordering::SeqCst);
        }

        /// One run's follow-up of `script`, holding the meeting.
        async fn follow_with(&self, script: &Transcript, steps: &mut FollowUps<'_>) -> FollowedUp {
            self.follow_meeting(&self.meeting, script, steps).await
        }

        /// The same for `meeting`.
        async fn follow_meeting(
            &self,
            meeting: &MeetingPlan,
            script: &Transcript,
            steps: &mut FollowUps<'_>,
        ) -> FollowedUp {
            let hold = self.home.hold(meeting).await.unwrap().unwrap();
            let followed = follow_up_held(
                &self.home,
                &hold,
                meeting,
                &sha_of(script),
                Some(script),
                steps,
            )
            .await;
            self.home.release(hold).await.unwrap();
            followed
        }

        async fn follow(&self) -> FollowedUp {
            self.follow_with(&script(), &mut self.steps()).await
        }

        /// Both steps, the summary from `settings`.
        async fn follow_from(&self, settings: &GeminiSettings) -> FollowedUp {
            let mut steps = self.run(Some(settings), true);
            self.follow_with(&script(), &mut steps).await
        }

        /// Both steps for the stored script named by `sha`, not handed over.
        async fn follow_stored(&self, sha: &str) -> FollowedUp {
            let hold = self.home.hold(&self.meeting).await.unwrap().unwrap();
            let mut steps = self.steps();
            let followed =
                follow_up_held(&self.home, &hold, &self.meeting, sha, None, &mut steps).await;
            self.home.release(hold).await.unwrap();
            followed
        }

        fn record(&self) -> Option<NotionRecord> {
            std::fs::read(self.home.notion_record_path(FIRST))
                .ok()
                .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        }

        fn summary_bytes(&self) -> Vec<u8> {
            std::fs::read(self.home.summary_path(FIRST)).unwrap()
        }

        fn failures(&self) -> StepFailures {
            let path = self.home.beside_path(FIRST, Beside::SummaryFailed);
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
        }

        fn notion_failures(&self) -> StepFailures {
            let path = self.home.beside_path(FIRST, Beside::NotionFailed);
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
        }

        fn counts(&self) -> (usize, usize) {
            (self.gemini.requests().len(), self.notion.requests().len())
        }

        /// The one page's status and its blocks as JSON text.
        fn page(&self) -> (String, String) {
            let state = self.state.lock().unwrap();
            let pages = minutes_pages(&state);
            assert_eq!(pages.len(), 1, "one page for the meeting");
            let status = pages[0].properties[minutes_property::STATUS]["select"]["name"]
                .as_str()
                .unwrap()
                .to_string();
            (status, serde_json::to_string(&pages[0].children).unwrap())
        }
    }

    /// Script → summary → Notion page once, both stamped with the script;
    /// the next run sends nothing.
    #[tokio::test]
    async fn summary_then_notion_once() {
        let world = world().await;
        let first = world.follow().await;
        assert_eq!(pair(&first), (Step::Done, Step::Done));
        let usage = first
            .summary_usage
            .as_ref()
            .expect("usage of the summary made now");
        assert_eq!((usage.input_tokens, usage.calls), (1_000, 1));
        let stored: Summary = serde_json::from_slice(&world.summary_bytes()).unwrap();
        assert_eq!(stored.script_sha256, sha_of(&script()));
        let record = world.record().unwrap();
        assert!(record.done);
        assert_eq!(record.script_sha256, sha_of(&script()));
        assert_eq!(record.summary_sha256, sha256_hex(&world.summary_bytes()));
        assert_eq!(world.page().0, "완료");

        let before = world.counts();
        let again = world.follow().await;
        assert_eq!(pair(&again), (Step::AlreadyDone, Step::AlreadyDone));
        assert!(again.nothing_left());
        assert!(again.summary_usage.is_none());
        assert_eq!(world.counts(), before, "nothing paid or sent twice");
    }

    /// A free summary failure (refused before an answer): no summary, the
    /// page waits, and this meeting waits 10 minutes before asking again
    /// (once), then writes the page.
    #[tokio::test]
    async fn a_failed_summary_is_tried_again_and_the_page_waits() {
        let world = world().await;
        world.refuse.store(true, Ordering::SeqCst);
        let first = world.follow().await;
        assert!(
            failed_with(
                &first.summary,
                "bad-request HTTP 400 INVALID_ARGUMENT (bad request not counted 1, next try in 10 min)"
            ),
            "{first:?}"
        );
        assert_eq!(first.notion, Step::Later(Later::Summary));
        assert!(first.left_for_next_run());
        assert!(!world.home.summary_path(FIRST).exists());
        let failures = world.failures();
        assert_eq!(
            (
                failures.paid_tries,
                failures.free_fails,
                failures.uncounted_bad_requests
            ),
            (0, 0, 1)
        );
        assert_eq!(failures.next_try_after_unix_ms, world.now() + 600_000);
        assert!(world.notion.requests().is_empty(), "no page yet");

        world.refuse.store(false, Ordering::SeqCst);
        let before = world.gemini.requests().len();
        let waiting = world.follow().await;
        assert_eq!(
            pair(&waiting),
            (Step::Later(Later::Backoff), Step::Later(Later::Summary))
        );
        assert!(!waiting.has_failure());
        assert_eq!(world.gemini.requests().len(), before, "not asked yet");
        world.advance(FIRST_BACKOFF);
        assert_eq!(pair(&world.follow().await), (Step::Done, Step::Done));
        assert_eq!(world.gemini.requests().len() - before, 1);
        assert_eq!(world.page().0, "완료");
    }

    /// A failed Notion page is marked "실패" and recorded as not done; the
    /// meeting waits, then writes that same page again without asking for
    /// the summary.
    #[tokio::test]
    async fn a_failed_notion_page_is_tried_again_alone() {
        let world = world().await;
        world.state.lock().unwrap().append_failures = vec![Reply::json(
            400,
            &json!({ "code": "validation_error", "message": "refused" }),
        )];
        let first = world.follow().await;
        assert_eq!(first.summary, Step::Done);
        assert!(
            failed_with(
                &first.notion,
                "validation_error (bad request not counted 1, next try in 10 min)"
            ),
            "{first:?}"
        );
        let record = world.record().unwrap();
        assert!(!record.done);
        assert_eq!(world.page().0, "실패");
        assert_eq!(world.notion_failures().uncounted_bad_requests, 1);

        let gemini = world.gemini.requests().len();
        assert_eq!(
            pair(&world.follow().await),
            (Step::AlreadyDone, Step::Later(Later::Backoff))
        );
        world.advance(FIRST_BACKOFF);
        assert_eq!(pair(&world.follow().await), (Step::AlreadyDone, Step::Done));
        assert_eq!(world.gemini.requests().len(), gemini, "summary kept");
        assert_eq!(world.record().unwrap().page_id, record.page_id, "same page");
        assert_eq!(world.page().0, "완료");
    }

    /// A script written again (`--overwrite`) is another script: it gets its
    /// own summary, and the same page is written again for it.
    #[tokio::test]
    async fn a_script_written_again_gets_its_own_summary_and_page() {
        let world = world().await;
        world.follow().await;
        let page_id = world.record().unwrap().page_id;
        let gemini = world.gemini.requests().len();
        let again = world.follow_with(&other_script(), &mut world.steps()).await;
        assert_eq!(pair(&again), (Step::Done, Step::Done));
        assert_eq!(world.gemini.requests().len(), gemini + 1);
        let record = world.record().unwrap();
        assert_eq!(record.page_id, page_id);
        assert_eq!(record.script_sha256, sha_of(&other_script()));

        // With the summary off, the script alone decides.
        let mut only_notion = FollowUps::new(None, Some(world.notion_step()), &PubkeyPrefixNames);
        let back = world.follow_with(&script(), &mut only_notion).await;
        assert_eq!(pair(&back), (Step::Off, Step::Done));
        assert_eq!(world.record().unwrap().script_sha256, sha_of(&script()));
    }

    /// --overwrite, then the page fails before Notion gives a page id: the
    /// old "done" does not stand for the new script.
    #[tokio::test]
    async fn an_old_done_record_does_not_count_for_a_new_script() {
        let world = world().await;
        world.follow().await;
        let page_id = world.record().unwrap().page_id;
        // The people lookup (its failure is let go), then reading the known
        // page.
        let refused = || {
            Reply::json(
                400,
                &json!({ "code": "validation_error", "message": "refused" }),
            )
        };
        world.state.lock().unwrap().queued = vec![refused(), refused()];
        let failed = world.follow_with(&other_script(), &mut world.steps()).await;
        assert!(
            failed_with(&failed.notion, "validation_error"),
            "{failed:?}"
        );
        let record = world.record().unwrap();
        assert!(!record.done);
        assert_eq!(record.page_id, page_id);
        assert_eq!(record.script_sha256, sha_of(&other_script()));
        assert_eq!(world.page().0, "완료", "the page was not reached");
        world.advance(FIRST_BACKOFF);
        let next = world.follow_with(&other_script(), &mut world.steps()).await;
        assert_eq!(pair(&next), (Step::AlreadyDone, Step::Done));
    }

    /// Paid tries are counted per script: three, then the summary is given
    /// up and nothing more is paid. Deleting the record starts over, and so
    /// does a script written again.
    #[tokio::test]
    async fn paid_tries_stop_after_three() {
        let world = world().await;
        let cut = cut_off_gemini().await;
        let settings = gemini_settings(&cut);
        let mut calls = Vec::new();
        let mut summary = Vec::new();
        for _ in 0..4 {
            let mut steps = world.run(Some(&settings), false);
            let followed = world.follow_with(&script(), &mut steps).await;
            calls.push(cut.requests().len());
            summary.push(followed.summary.clone());
            assert!(followed.home_error.is_none(), "{followed:?}");
        }
        // Each try is the answer and one shorter ask again.
        assert_eq!(calls, [2, 4, 6, 6], "the fourth run pays nothing");
        assert!(failed_with(&summary[0], "paid try 1 of 3)"), "{summary:?}");
        assert!(
            failed_with(&summary[2], "paid try 3 of 3, given up)"),
            "{summary:?}"
        );
        assert!(failed_with(&summary[2], "bad-response "), "{summary:?}");
        assert_eq!(summary[3], Step::GaveUp);
        let failures = world.failures();
        assert_eq!(failures.format, STEP_FAILURES_FORMAT);
        assert_eq!((failures.paid_tries, failures.free_fails), (3, 0));
        assert_eq!(failures.last_kind, "bad-response");
        assert_eq!(failures.script_sha256, sha_of(&script()));
        assert_eq!(failures.next_try_after_unix_ms, 0, "paid tries do not wait");

        // Deleting the record (the way back, by hand) starts over.
        std::fs::remove_file(world.home.beside_path(FIRST, Beside::SummaryFailed)).unwrap();
        let again = world
            .follow_with(&script(), &mut world.run(Some(&settings), false))
            .await;
        assert!(failed_with(&again.summary, "paid try 1 of 3)"), "{again:?}");
        assert_eq!(cut.requests().len(), 8);

        let other = world
            .follow_with(&other_script(), &mut world.run(Some(&settings), false))
            .await;
        assert!(failed_with(&other.summary, "paid try 1 of 3)"), "{other:?}");
        assert_eq!(cut.requests().len(), 10);
    }

    /// A given-up summary still gets its page, which says so; then the
    /// meeting is finished.
    #[tokio::test]
    async fn a_given_up_summary_still_gets_its_page() {
        let world = world().await;
        let cut = cut_off_gemini().await;
        let settings = gemini_settings(&cut);
        for _ in 1..PAID_SUMMARY_TRIES {
            let tried = world.follow_from(&settings).await;
            assert_eq!(tried.notion, Step::Later(Later::Summary));
        }
        assert!(world.notion.requests().is_empty());

        let last = world.follow_from(&settings).await;
        assert!(failed_with(&last.summary, "given up"), "{last:?}");
        assert_eq!(last.notion, Step::Done);
        let (status, body) = world.page();
        assert_eq!(status, "완료");
        assert!(body.contains(SUMMARY_GIVEN_UP), "{body}");
        assert_eq!(
            world.record().unwrap().summary_sha256,
            SUMMARY_GIVEN_UP_STAMP
        );

        let before = (cut.requests().len(), world.notion.requests().len());
        let after = world.follow_from(&settings).await;
        assert_eq!(pair(&after), (Step::GaveUp, Step::AlreadyDone));
        assert!(after.nothing_left());
        assert_eq!(
            (cut.requests().len(), world.notion.requests().len()),
            before
        );
    }

    /// A stored summary (or failure count) that cannot be read is a
    /// failure; Gemini is not asked again.
    #[tokio::test]
    async fn an_unreadable_stored_summary_is_not_paid_for_again() {
        let world = world().await;
        std::fs::write(world.home.summary_path(FIRST), b"{ not json").unwrap();
        let first = world.follow().await;
        assert_eq!(
            pair(&first),
            (
                Step::Failed("stored summary unreadable".into()),
                Step::Later(Later::Summary)
            )
        );
        std::fs::remove_file(world.home.summary_path(FIRST)).unwrap();
        let failures = world.home.beside_path(FIRST, Beside::SummaryFailed);
        std::fs::write(failures, b"{ not json").unwrap();
        let second = world.follow().await;
        assert!(
            failed_with(&second.summary, "failures unreadable"),
            "{second:?}"
        );
        assert_eq!(world.counts(), (0, 0));
    }

    /// The Notion error message (it can quote the page) stays out of the
    /// step and the record: kind, HTTP status and code only.
    #[tokio::test]
    async fn a_failed_page_logs_no_notion_message() {
        let world = world().await;
        world.state.lock().unwrap().append_failures = vec![Reply::json(
            400,
            &json!({ "code": "validation_error", "message": "body.children[0] instead was `견적서 얘기해요.`" }),
        )];
        let followed = world.follow().await;
        let Step::Failed(text) = &followed.notion else {
            panic!("{followed:?}")
        };
        assert!(
            !text.contains("견적서") && !text.contains("instead was"),
            "{text}"
        );
        assert!(
            text.starts_with("bad-request HTTP 400 validation_error ("),
            "{text}"
        );
        let record = std::fs::read(world.home.beside_path(FIRST, Beside::NotionFailed)).unwrap();
        let record = String::from_utf8(record).unwrap();
        assert!(!record.contains("견적서") && !record.contains("instead was"));
        assert_eq!(
            world.notion_failures().last_code,
            "HTTP 400 validation_error"
        );
    }

    /// Notion first without a summary; the summary turned on later reaches
    /// the page. Turned off again, the page is left as it is.
    #[tokio::test]
    async fn a_summary_turned_on_later_reaches_the_page() {
        let world = world().await;
        let mut only_notion = FollowUps::new(None, Some(world.notion_step()), &PubkeyPrefixNames);
        let first = world.follow_with(&script(), &mut only_notion).await;
        assert_eq!(pair(&first), (Step::Off, Step::Done));
        assert_eq!(world.record().unwrap().summary_sha256, "");
        let notion = world.notion.requests().len();

        let later = world.follow().await;
        assert_eq!(pair(&later), (Step::Done, Step::Done));
        assert!(
            world.notion.requests().len() > notion,
            "the page is written again"
        );
        assert_eq!(
            world.record().unwrap().summary_sha256,
            sha256_hex(&world.summary_bytes())
        );

        let mut only_notion = FollowUps::new(None, Some(world.notion_step()), &PubkeyPrefixNames);
        let off = world.follow_with(&script(), &mut only_notion).await;
        assert_eq!(pair(&off), (Step::Off, Step::AlreadyDone));
    }

    /// --overwrite: a new script whose summary fails does not get the old
    /// summary, nor the old page; a later run makes its own.
    #[tokio::test]
    async fn an_overwritten_script_never_gets_the_old_summary() {
        let world = world().await;
        assert_eq!(pair(&world.follow().await), (Step::Done, Step::Done));
        let old = world.summary_bytes();
        world.refuse.store(true, Ordering::SeqCst);
        let refused = world.follow_with(&other_script(), &mut world.steps()).await;
        assert!(matches!(refused.summary, Step::Failed(_)), "{refused:?}");
        assert_eq!(refused.notion, Step::Later(Later::Summary));
        assert_eq!(
            world.record().unwrap().script_sha256,
            sha_of(&script()),
            "the page is not claimed for the new script"
        );
        world.refuse.store(false, Ordering::SeqCst);
        world.advance(FIRST_BACKOFF);
        let gemini = world.gemini.requests().len();
        let next = world.follow_with(&other_script(), &mut world.steps()).await;
        assert_eq!(pair(&next), (Step::Done, Step::Done));
        assert_eq!(world.gemini.requests().len() - gemini, 1);
        assert_ne!(world.summary_bytes(), old);
        assert_eq!(
            world.record().unwrap().script_sha256,
            sha_of(&other_script())
        );
    }

    /// With less than [`FOLLOW_UP_MIN_LEFT`] before the deadline nothing new
    /// starts; what is done is still seen as done.
    #[tokio::test]
    async fn too_little_time_leaves_the_steps_for_the_next_run() {
        let world = world().await;
        let soon = Instant::now() + FOLLOW_UP_MIN_LEFT - Duration::from_secs(5);
        let late = world
            .follow_with(&script(), &mut world.steps().with_deadline(soon))
            .await;
        assert_eq!(
            pair(&late),
            (Step::Later(Later::TimeLimit), Step::Later(Later::Summary))
        );
        assert!(late.left_for_next_run() && !late.has_failure());
        assert_eq!(world.counts(), (0, 0));

        let mut only_notion =
            FollowUps::new(None, Some(world.notion_step()), &PubkeyPrefixNames).with_deadline(soon);
        let late = world.follow_with(&script(), &mut only_notion).await;
        assert_eq!(pair(&late), (Step::Off, Step::Later(Later::TimeLimit)));
        assert_eq!(world.counts(), (0, 0));

        let plenty = Instant::now() + FOLLOW_UP_MIN_LEFT + Duration::from_secs(60);
        let mut steps = world.steps().with_deadline(plenty);
        assert_eq!(
            pair(&world.follow_with(&script(), &mut steps).await),
            (Step::Done, Step::Done)
        );
        let done = world
            .follow_with(&script(), &mut world.steps().with_deadline(soon))
            .await;
        assert_eq!(pair(&done), (Step::AlreadyDone, Step::AlreadyDone));
    }

    /// Refused credentials or permission turn a step off for the rest of the
    /// run; the next run tries again.
    #[tokio::test]
    async fn a_refused_step_is_off_for_the_rest_of_the_run() {
        let world = world().await;
        let forbidden = FakeServer::start(|_| {
            Reply::json(403, &json!({ "error": { "status": "PERMISSION_DENIED" } }))
        })
        .await;
        let settings = gemini_settings(&forbidden);
        let mut run = FollowUps::new(
            Some(world.summary_step(&settings)),
            Some(world.notion_step()),
            &PubkeyPrefixNames,
        );
        let first = world.follow_with(&script(), &mut run).await;
        assert!(
            failed_with(&first.summary, "permission HTTP 403"),
            "{first:?}"
        );
        let second = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(
            pair(&second),
            (Step::Later(Later::OffForRun), Step::Later(Later::Summary))
        );
        assert_eq!(forbidden.requests().len(), 1);
        let mut next_run = FollowUps::new(
            Some(world.summary_step(&settings)),
            None,
            &PubkeyPrefixNames,
        );
        world.follow_with(&script(), &mut next_run).await;
        assert_eq!(forbidden.requests().len(), 2);

        world.state.lock().unwrap().append_failures = vec![Reply::json(
            401,
            &json!({ "code": "unauthorized", "message": "API token is invalid." }),
        )];
        let mut run = world.steps();
        let first = world.follow_with(&script(), &mut run).await;
        assert!(
            failed_with(&first.notion, "auth HTTP 401 unauthorized"),
            "{first:?}"
        );
        let notion = world.notion.requests().len();
        let second = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(pair(&second), (Step::Done, Step::Later(Later::OffForRun)));
        assert_eq!(world.notion.requests().len(), notion);
    }

    /// The script is read only when a step is left, and must still be the
    /// script it was named by.
    #[tokio::test]
    async fn the_script_is_read_only_when_a_step_is_left() {
        let world = world().await;
        let bytes = serde_json::to_vec_pretty(&script()).unwrap();
        let sha = sha256_hex(&bytes);
        let path = world.home.transcript_path(FIRST);
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            pair(&world.follow_stored(&sha).await),
            (Step::Done, Step::Done)
        );
        // Everything done: other bytes in its place go unseen.
        std::fs::write(&path, b"not read").unwrap();
        assert_eq!(
            pair(&world.follow_stored(&sha).await),
            (Step::AlreadyDone, Step::AlreadyDone)
        );
        // Something left: read, and found changed.
        std::fs::remove_file(world.home.summary_path(FIRST)).unwrap();
        let changed = world.follow_stored(&sha).await;
        assert!(failed_with(&changed.summary, "changed"), "{changed:?}");
        assert!(
            matches!(changed.home_error, Some(MeetingError::Scripts(_))),
            "{changed:?}"
        );
        assert_eq!(world.gemini.requests().len(), 1);
    }

    struct Bucket {
        _recordings: tempfile::TempDir,
        meeting: MeetingPlan,
        fake: FakeGcs,
        home: GcsMinutes,
        lease: String,
    }

    async fn bucket() -> Bucket {
        let recordings = tempfile::tempdir().unwrap();
        let meeting = plan_for(recordings.path()).await;
        let fake = FakeGcs::start(3_600).await;
        fake.accept_token("t");
        let tokens = Tokens::new(TokenSource::Static(AccessToken::new("t"))).unwrap();
        let gcs = Arc::new(Gcs::with_base_url(tokens, fake.url()).unwrap());
        Bucket {
            lease: format!("{}lease", GcsMinutes::ledger_prefix(&meeting)),
            _recordings: recordings,
            meeting,
            fake,
            home: GcsMinutes::new(gcs, "minutes"),
        }
    }

    /// Another worker takes the meeting over while Gemini answers: the paid
    /// summary is not written, the meeting fails, and its lease is left to
    /// the other worker.
    #[tokio::test]
    async fn nothing_is_written_once_the_hold_is_lost() {
        let bucket = bucket().await;
        let (fake, lease) = (bucket.fake.clone(), bucket.lease.clone());
        let gemini = FakeServer::start(move |_| {
            fake.insert("minutes", &lease, b"{}".to_vec());
            gemini_reply(&answer(json!([])), "STOP")
        })
        .await;
        let settings = gemini_settings(&gemini);
        let http = reqwest::Client::new();
        let tokens = Tokens::new(TokenSource::Static(AccessToken::new("g"))).unwrap();
        let mut steps = FollowUps::new(
            Some(SummaryStep {
                http: &http,
                settings: &settings,
                tokens: &tokens,
            }),
            None,
            &PubkeyPrefixNames,
        );
        let hold = bucket.home.hold(&bucket.meeting).await.unwrap().unwrap();
        let followed = follow_up_held(
            &bucket.home,
            &hold,
            &bucket.meeting,
            &sha_of(&script()),
            Some(&script()),
            &mut steps,
        )
        .await;
        bucket.home.release(hold).await.unwrap();
        assert!(
            matches!(followed.home_error, Some(MeetingError::HoldLost)),
            "{followed:?}"
        );
        assert!(failed_with(&followed.summary, "hold"), "{followed:?}");
        assert_eq!(gemini.requests().len(), 1);
        let objects = bucket.fake.objects("minutes");
        let summary = GcsMinutes::beside_key(&bucket.meeting, Beside::Summary);
        assert!(!objects.contains_key(&summary));
        assert!(objects.contains_key(&bucket.lease), "the other worker's");
    }

    /// The same for the Notion record: the page went out, the record is not
    /// written over the other worker's.
    #[tokio::test]
    async fn no_notion_record_once_the_hold_is_lost() {
        let bucket = bucket().await;
        let (notion, state) = fake_notion(FakeNotion::default()).await;
        let settings = notion_settings(&notion);
        let http = reqwest::Client::new();
        let mut steps = FollowUps::new(
            None,
            Some(NotionStep {
                client: NotionClient::new(&http, &settings, "t").unwrap(),
                title_prefix: String::new(),
                channel_label: None,
                kind: None,
            }),
            &PubkeyPrefixNames,
        );
        let hold = bucket.home.hold(&bucket.meeting).await.unwrap().unwrap();
        bucket.fake.insert("minutes", &bucket.lease, b"{}".to_vec());
        let followed = follow_up_held(
            &bucket.home,
            &hold,
            &bucket.meeting,
            &sha_of(&script()),
            Some(&script()),
            &mut steps,
        )
        .await;
        assert!(
            matches!(followed.home_error, Some(MeetingError::HoldLost)),
            "{followed:?}"
        );
        assert_eq!(minutes_pages(&state.lock().unwrap()).len(), 1);
        let record = GcsMinutes::notion_record_key(&bucket.meeting);
        assert!(!bucket.fake.objects("minutes").contains_key(&record));
    }

    /// Test double: must never be reached.
    struct Unused;

    impl SpeechDetector for Unused {
        fn detect(&mut self, _: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
            panic!("speech detection ran")
        }
    }

    impl SpeechToText for Unused {
        fn info(&self) -> SttInfo {
            SttInfo::default()
        }

        async fn transcribe(&self, _: SttRequest<'_>) -> Result<SttOutput, SttError> {
            panic!("transcription ran")
        }
    }

    /// Hears nothing.
    struct Silent;

    impl SpeechDetector for Silent {
        fn detect(&mut self, _: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
            Ok(Vec::new())
        }
    }

    fn minutes_settings() -> MinutesSettings {
        MinutesSettings {
            segment_plan: SegmentPlan::default(),
            stt: SttPolicy::default(),
            ledger_version: "test".into(),
            audio_key: String::new(),
            now_unix_ms: 0,
            speakers: crate::speakers::SpeakerSettings::default(),
        }
    }

    fn options(meeting: &MeetingPlan) -> RunOptions {
        RunOptions {
            prefix: "h".into(),
            now_unix_ms: meeting.started_at_unix_ms() + 3_600_000,
            quiet_ms: 0,
            overwrite: false,
        }
    }

    /// A meeting whose own script is there: the runner does only the steps
    /// after it, transcribing nothing; with nothing left (or no steps) it is
    /// skipped as before.
    #[tokio::test]
    async fn the_runner_does_only_what_is_left_after_the_script() {
        let world = world().await;
        let mut transcript = script();
        transcript.session_ids = vec![FIRST];
        std::fs::write(
            world.home.transcript_path(FIRST),
            serde_json::to_vec(&transcript).unwrap(),
        )
        .unwrap();
        let store = LocalStore::new(world.dir.path().join("recordings"));
        let options = options(&world.meeting);
        for expected in [Some((Step::Done, Step::Done)), None] {
            let done = run_meeting_with(
                &world.home,
                &store,
                &world.meeting,
                &mut Unused,
                &Unused,
                &minutes_settings(),
                &options,
                Some(&mut world.steps()),
            )
            .await
            .unwrap();
            match expected {
                Some(expected) => {
                    let Done::FollowedUp(followed) = &done else {
                        panic!("{done:?}")
                    };
                    assert_eq!(pair(followed), expected);
                }
                // Both done the first time: nothing left.
                None => assert!(matches!(done, Done::Skipped(_)), "{done:?}"),
            }
        }
        let done = run_meeting(
            &world.home,
            &store,
            &world.meeting,
            &mut Unused,
            &Unused,
            &minutes_settings(),
            &options,
        )
        .await
        .unwrap();
        assert!(matches!(done, Done::Skipped(_)), "{done:?}");
    }

    /// The minutes home failing after the script (here: the hold lost while
    /// Gemini answers) fails the meeting but keeps its script and report.
    #[tokio::test]
    async fn a_failure_after_the_script_keeps_the_script_and_its_report() {
        let bucket = bucket().await;
        let (fake, lease) = (bucket.fake.clone(), bucket.lease.clone());
        let gemini = FakeServer::start(move |_| {
            fake.insert("minutes", &lease, b"{}".to_vec());
            gemini_reply(&answer(json!([])), "STOP")
        })
        .await;
        let settings = gemini_settings(&gemini);
        let http = reqwest::Client::new();
        let tokens = Tokens::new(TokenSource::Static(AccessToken::new("g"))).unwrap();
        let mut steps = FollowUps::new(
            Some(SummaryStep {
                http: &http,
                settings: &settings,
                tokens: &tokens,
            }),
            None,
            &PubkeyPrefixNames,
        );
        let store = LocalStore::new(bucket._recordings.path());
        let done = run_meeting_with(
            &bucket.home,
            &store,
            &bucket.meeting,
            &mut Silent,
            &Unused,
            &minutes_settings(),
            &options(&bucket.meeting),
            Some(&mut steps),
        )
        .await
        .unwrap();
        let Done::Written {
            output,
            script,
            follow: Some(followed),
            ..
        } = &done
        else {
            panic!("{done:?}")
        };
        assert_eq!(
            *script,
            format!("gs://minutes/{}", GcsMinutes::script_key(&bucket.meeting))
        );
        assert_eq!(output.transcript.session_ids, vec![FIRST]);
        assert!(
            matches!(followed.home_error, Some(MeetingError::HoldLost)),
            "{followed:?}"
        );
        let objects = bucket.fake.objects("minutes");
        assert!(objects.contains_key(&GcsMinutes::script_key(&bucket.meeting)));
        assert!(!objects.contains_key(&GcsMinutes::beside_key(&bucket.meeting, Beside::Summary)));
    }

    /// A Gemini that takes longer than the worker's time limit: the answer
    /// would come (and be paid for) after the client gave up.
    fn slow_gemini() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    drop(stream);
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    /// A request that timed out may have been paid for: it is not sent again
    /// in the run, and counts against the script's paid tries.
    #[tokio::test]
    async fn a_timeout_counts_as_a_paid_try() {
        let world = world().await;
        let (base, seen) = slow_gemini();
        let mut settings = world.gemini_settings.clone();
        settings.base_url = base;
        settings.request_timeout = Duration::from_millis(200);
        let mut calls = Vec::new();
        let mut summary = Vec::new();
        for _ in 0..4 {
            let mut steps = world.run(Some(&settings), false);
            let followed = world.follow_with(&script(), &mut steps).await;
            calls.push(seen.load(Ordering::SeqCst));
            summary.push(followed.summary);
        }
        assert_eq!(calls, [1, 2, 3, 3], "{summary:?}");
        assert!(
            failed_with(&summary[0], "transient timeout (paid try 1 of 3)"),
            "{summary:?}"
        );
        assert_eq!(summary[3], Step::GaveUp);
        assert_eq!(world.failures().paid_tries, 3);
    }

    /// Cut off (paid), then the shorter ask fails for good: the paid answer
    /// still counts. That trouble alone does not turn the summary off; a
    /// second meeting in trouble right after does.
    #[tokio::test]
    async fn a_paid_answer_counts_even_when_the_shorter_ask_fails() {
        let world = world().await;
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = asked.clone();
        let server = FakeServer::start(move |_| match counter.fetch_add(1, Ordering::SeqCst) {
            0 => gemini_reply(&answer(json!([])), "MAX_TOKENS"),
            _ => Reply::json(503, &json!({ "error": { "status": "UNAVAILABLE" } })),
        })
        .await;
        let settings = gemini_settings(&server);
        let mut run = world.run(Some(&settings), false);
        let followed = world.follow_with(&script(), &mut run).await;
        assert!(
            failed_with(&followed.summary, "paid try 1 of 3)"),
            "{followed:?}"
        );
        assert_eq!(world.failures().paid_tries, 1);
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert!(failed_with(&b.summary, "free failure 1"), "{b:?}");
        let sent = server.requests().len();
        let third = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(third.summary, Step::Later(Later::OffForRun));
        assert_eq!(server.requests().len(), sent);
    }

    /// 429 every time: the step is off for the rest of the run.
    #[tokio::test]
    async fn rate_limits_turn_the_step_off_for_the_run() {
        let world = world().await;
        let limited = FakeServer::start(|_| {
            Reply::json(429, &json!({ "error": { "status": "RESOURCE_EXHAUSTED" } }))
        })
        .await;
        let settings = gemini_settings(&limited);
        let mut run = FollowUps::new(
            Some(world.summary_step(&settings)),
            Some(world.notion_step()),
            &PubkeyPrefixNames,
        );
        let first = world.follow_with(&script(), &mut run).await;
        assert!(failed_with(&first.summary, "rate-limited"), "{first:?}");
        let after_first = limited.requests().len();
        let second = world.follow_with(&other_script(), &mut run).await;
        assert!(matches!(second.summary, Step::Later(_)), "{second:?}");
        assert_eq!(limited.requests().len(), after_first);
    }

    /// No wait whose end, plus a request, would pass the run's deadline:
    /// the failure comes back at once.
    #[tokio::test]
    async fn gemini_never_waits_past_the_deadline() {
        let world = world().await;
        let limited = FakeServer::start(|_| {
            Reply::json(429, &json!({ "error": { "status": "RESOURCE_EXHAUSTED" } }))
                .with_header("retry-after", "5")
        })
        .await;
        let mut settings = gemini_settings(&limited);
        // The first request just fits; the wait after it does not.
        settings.request_timeout = FOLLOW_UP_MIN_LEFT;
        let deadline = Instant::now() + FOLLOW_UP_MIN_LEFT + Duration::from_secs(2);
        let mut steps = FollowUps::new(
            Some(world.summary_step(&settings)),
            None,
            &PubkeyPrefixNames,
        )
        .with_deadline(deadline);
        let started = Instant::now();
        let followed = world.follow_with(&script(), &mut steps).await;
        assert!(started.elapsed() < Duration::from_secs(3), "waited");
        assert!(
            failed_with(
                &followed.summary,
                "rate-limited HTTP 429 RESOURCE_EXHAUSTED; not waited"
            ),
            "{followed:?}"
        );
        assert_eq!(limited.requests().len(), 1);
    }

    /// No request that could not end before the run's deadline: nothing is
    /// sent and the summary is left for the next run (not a failure).
    #[tokio::test]
    async fn no_request_that_cannot_end_before_the_deadline() {
        let world = world().await;
        let mut settings = world.gemini_settings.clone();
        settings.request_timeout = FOLLOW_UP_MIN_LEFT + Duration::from_secs(60);
        let deadline = Instant::now() + FOLLOW_UP_MIN_LEFT + Duration::from_secs(2);
        let mut steps = FollowUps::new(
            Some(world.summary_step(&settings)),
            Some(world.notion_step()),
            &PubkeyPrefixNames,
        )
        .with_deadline(deadline);
        let followed = world.follow_with(&script(), &mut steps).await;
        assert_eq!(
            pair(&followed),
            (Step::Later(Later::TimeLimit), Step::Later(Later::Summary))
        );
        assert!(!followed.has_failure());
        assert_eq!(world.counts(), (0, 0));
    }

    /// Notion rate-limited after its retries: the page step is off for the
    /// rest of the run too.
    #[tokio::test]
    async fn notion_rate_limits_turn_the_page_off_for_the_run() {
        let world = world().await;
        world.state.lock().unwrap().append_failures = vec![
            Reply::json(
                429,
                &json!({ "code": "rate_limited", "message": "slow down" })
            );
            40
        ];
        let mut run = FollowUps::new(None, Some(world.notion_step()), &PubkeyPrefixNames);
        let first = world.follow_with(&script(), &mut run).await;
        assert!(failed_with(&first.notion, "rate-limited"), "{first:?}");
        let notion = world.notion.requests().len();
        let second = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(pair(&second), (Step::Off, Step::Later(Later::OffForRun)));
        assert_eq!(world.notion.requests().len(), notion);
        // Not counted against the meeting; it only waits.
        let failures = world.notion_failures();
        assert_eq!(
            (failures.free_fails, failures.uncounted_bad_requests),
            (0, 0)
        );
        assert!(failures.next_try_after_unix_ms > 0, "{failures:?}");
    }

    /// A Gemini that hangs while `slow` is set and answers well otherwise.
    fn hanging_gemini(slow: Arc<AtomicBool>) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = seen.clone();
        let body = gemini_reply(&answer(json!([])), "STOP").body;
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                let (slow, body) = (slow.load(Ordering::SeqCst), body.clone());
                std::thread::spawn(move || {
                    if slow {
                        std::thread::sleep(Duration::from_millis(1500));
                        return;
                    }
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut length = 0usize;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line.trim().is_empty() {
                            break;
                        }
                        let lower = line.to_ascii_lowercase();
                        if let Some(value) = lower.strip_prefix("content-length:") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                    let mut request = vec![0; length];
                    reader.read_exact(&mut request).unwrap();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn third_script() -> Transcript {
        transcript_with(&[(1_000, A, "세 번째 회의예요.")])
    }

    fn fourth_script() -> Transcript {
        transcript_with(&[(1_000, A, "네 번째 회의예요.")])
    }

    /// A time-out skips only its meeting: the next meeting of the run is
    /// summarized, and a time-out after that success starts the count again.
    #[tokio::test]
    async fn a_timeout_skips_only_its_meeting() {
        let world = world().await;
        let slow = Arc::new(AtomicBool::new(true));
        let (base, seen) = hanging_gemini(slow.clone());
        let mut settings = world.gemini_settings.clone();
        settings.base_url = base;
        settings.request_timeout = Duration::from_millis(300);
        let mut run = FollowUps::new(
            Some(world.summary_step(&settings)),
            None,
            &PubkeyPrefixNames,
        );
        let first = world.follow_with(&script(), &mut run).await;
        assert!(
            failed_with(&first.summary, "timeout (paid try 1 of 3)"),
            "{first:?}"
        );
        slow.store(false, Ordering::SeqCst);
        let second = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(second.summary, Step::Done);
        slow.store(true, Ordering::SeqCst);
        let third = world.follow_with(&third_script(), &mut run).await;
        assert!(failed_with(&third.summary, "timeout"), "{third:?}");
        slow.store(false, Ordering::SeqCst);
        let fourth = world.follow_with(&fourth_script(), &mut run).await;
        assert_eq!(fourth.summary, Step::Done);
        assert_eq!(seen.load(Ordering::SeqCst), 4);
    }

    /// Two meetings in a row timing out turn the summary off for the run.
    #[tokio::test]
    async fn two_timeouts_in_a_row_turn_the_summary_off() {
        let world = world().await;
        let (base, seen) = hanging_gemini(Arc::new(AtomicBool::new(true)));
        let mut settings = world.gemini_settings.clone();
        settings.base_url = base;
        settings.request_timeout = Duration::from_millis(300);
        let mut run = FollowUps::new(
            Some(world.summary_step(&settings)),
            None,
            &PubkeyPrefixNames,
        );
        for script in [script(), other_script()] {
            let followed = world.follow_with(&script, &mut run).await;
            assert!(failed_with(&followed.summary, "timeout"), "{followed:?}");
        }
        let third = world.follow_with(&third_script(), &mut run).await;
        assert_eq!(third.summary, Step::Later(Later::OffForRun));
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    // ---- review round 3 (r3_*), turned into checks ----

    /// Meeting B's script (channel 9, session 10).
    fn b_script() -> Transcript {
        let mut script = transcript_with(&[(1_000, A, "다른 회의의 내용이에요.")]);
        script.channel_id = Uuid::from_u128(9);
        script.session_ids = vec![Uuid::from_u128(10)];
        script
    }

    /// Accepts, reads the request, then closes after `close_ms` without
    /// answering.
    fn silent_server(close_ms: u64) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut buf = [0u8; 65536];
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let _ = stream.read(&mut buf);
                    std::thread::sleep(Duration::from_millis(close_ms));
                    drop(stream);
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn paid_tries(world: &World) -> Option<u32> {
        std::fs::read(world.home.beside_path(FIRST, Beside::SummaryFailed))
            .ok()
            .map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
            .and_then(|record| record["paid_tries"].as_u64())
            .map(|n| n as u32)
    }

    /// A request that times out after it was sent may have cost money: one
    /// request a run, counted, three at most.
    #[tokio::test]
    async fn r3_timeout_is_counted() {
        let world = world().await;
        let (base, seen) = silent_server(2_000);
        let mut settings = world.gemini_settings.clone();
        settings.base_url = base;
        settings.request_timeout = Duration::from_millis(300);
        let mut counted = Vec::new();
        for _ in 0..4 {
            let mut steps = FollowUps::new(
                Some(world.summary_step(&settings)),
                None,
                &PubkeyPrefixNames,
            );
            world.follow_with(&script(), &mut steps).await;
            counted.push((seen.load(Ordering::SeqCst), paid_tries(&world)));
        }
        assert_eq!(
            counted,
            [(1, Some(1)), (2, Some(2)), (3, Some(3)), (3, Some(3))]
        );
    }

    /// The connection closed after the request was sent, no answer: the
    /// same as a time-out (Gemini may have answered and charged).
    #[tokio::test]
    async fn r3_dropped_after_send_is_counted_and_not_sent_again() {
        let world = world().await;
        let (base, seen) = silent_server(150);
        let mut settings = world.gemini_settings.clone();
        settings.base_url = base;
        let mut counted = Vec::new();
        for _ in 0..4 {
            let mut steps = FollowUps::new(
                Some(world.summary_step(&settings)),
                None,
                &PubkeyPrefixNames,
            );
            world.follow_with(&script(), &mut steps).await;
            counted.push((seen.load(Ordering::SeqCst), paid_tries(&world)));
        }
        assert_eq!(
            counted,
            [(1, Some(1)), (2, Some(2)), (3, Some(3)), (3, Some(3))]
        );
    }

    /// Meeting A always gets a 500: meeting B after it in the run is still
    /// summarized and written, and A waits before its next try.
    #[tokio::test]
    async fn r3_one_poison_meeting_does_not_block_the_others() {
        let world = world().await;
        let server = FakeServer::start(|request| {
            if String::from_utf8_lossy(&request.body).contains("견적서") {
                Reply::json(500, &json!({ "error": { "status": "INTERNAL" } }))
            } else {
                gemini_reply(&answer(json!([])), "STOP")
            }
        })
        .await;
        let settings = gemini_settings(&server);
        let mut sent_for_a = Vec::new();
        for run in 0..2 {
            let mut steps = FollowUps::new(
                Some(world.summary_step(&settings)),
                Some(world.notion_step()),
                &PubkeyPrefixNames,
            );
            let before = server.requests().len();
            let a = world.follow_with(&script(), &mut steps).await;
            sent_for_a.push(server.requests().len() - before);
            let b = world
                .follow_meeting(&world.meeting_b, &b_script(), &mut steps)
                .await;
            let expected = if run == 0 {
                Step::Done
            } else {
                Step::AlreadyDone
            };
            assert_eq!((b.summary, b.notion), (expected.clone(), expected), "{a:?}");
        }
        // Four tries (with retries) the first run, none the next: A waits.
        assert_eq!(sent_for_a, [4, 0]);
    }

    /// One 200 whose body is cut: counted for that meeting only; the next
    /// meeting of the run is summarized.
    #[tokio::test]
    async fn r3_one_cut_body_does_not_turn_the_summary_off() {
        let world = world().await;
        let cut = Arc::new(AtomicBool::new(true));
        let flag = cut.clone();
        let server = FakeServer::start(move |_| {
            let reply = gemini_reply(&answer(json!([])), "STOP");
            if flag.swap(false, Ordering::SeqCst) {
                reply.cut_off()
            } else {
                reply
            }
        })
        .await;
        let settings = gemini_settings(&server);
        let mut steps = FollowUps::new(
            Some(world.summary_step(&settings)),
            None,
            &PubkeyPrefixNames,
        );
        let a = world.follow_with(&script(), &mut steps).await;
        assert!(failed_with(&a.summary, "paid try 1 of 3)"), "{a:?}");
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut steps)
            .await;
        assert_eq!(b.summary, Step::Done);
        assert_eq!(paid_tries(&world), Some(1));
    }

    // ---- one shape for failures: each rule ----

    /// 10 minutes, doubled each time, at most 6 hours.
    #[test]
    fn backoff_doubles_up_to_six_hours() {
        let minutes: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs() / 60).collect();
        assert_eq!(minutes, [10, 20, 40, 80, 160, 320, 360, 360]);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
    }

    /// Free failures (500): the meeting waits longer each time, other runs
    /// send nothing meanwhile; after more than six the summary is given up
    /// and the page says so.
    #[tokio::test]
    async fn free_failures_back_off_then_give_up() {
        let world = world().await;
        let broken =
            FakeServer::start(|_| Reply::json(500, &json!({ "error": { "status": "INTERNAL" } })))
                .await;
        let settings = gemini_settings(&broken);
        let mut waits = Vec::new();
        for n in 1..=FREE_SUMMARY_FAILS {
            let failed = world.follow_from(&settings).await;
            assert!(
                failed_with(&failed.summary, &format!("free failure {n}, next try in")),
                "{failed:?}"
            );
            let failures = world.failures();
            assert_eq!((failures.free_fails, failures.paid_tries), (n, 0));
            let wait = failures.next_try_after_unix_ms - world.now();
            waits.push(wait / 60_000);
            // Not yet: nothing is sent.
            let sent = broken.requests().len();
            world.advance(Duration::from_millis(wait - 1));
            let waiting = world.follow_from(&settings).await;
            assert_eq!(waiting.summary, Step::Later(Later::Backoff));
            assert_eq!(broken.requests().len(), sent);
            world.advance(Duration::from_millis(1));
        }
        assert_eq!(waits, [10, 20, 40, 80, 160, 320]);
        let last = world.follow_from(&settings).await;
        assert!(
            failed_with(&last.summary, "free failure 7, given up)"),
            "{last:?}"
        );
        assert_eq!(last.notion, Step::Done);
        assert!(world.page().1.contains(SUMMARY_GIVEN_UP));
        // Four tries (with retries) each time.
        assert_eq!(broken.requests().len(), 4 * 7);
        let after = world.follow_from(&settings).await;
        assert_eq!(pair(&after), (Step::GaveUp, Step::AlreadyDone));
    }

    /// Trouble (500 after the retries) on two meetings in a row turns the
    /// summary off for the run; one alone does not.
    #[tokio::test]
    async fn trouble_on_two_meetings_in_a_row_turns_the_summary_off() {
        let world = world().await;
        let broken =
            FakeServer::start(|_| Reply::json(500, &json!({ "error": { "status": "INTERNAL" } })))
                .await;
        let settings = gemini_settings(&broken);
        let mut run = world.run(Some(&settings), false);
        let a = world.follow_with(&script(), &mut run).await;
        assert!(failed_with(&a.summary, "free failure 1"), "{a:?}");
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert!(failed_with(&b.summary, "free failure 1"), "{b:?}");
        let sent = broken.requests().len();
        let third = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(third.summary, Step::Later(Later::OffForRun));
        assert_eq!(broken.requests().len(), sent);
    }

    /// The Notion page has the same shape: trouble on two meetings in a row
    /// turns it off for the run, a failed meeting waits, and the page is
    /// never given up.
    #[tokio::test]
    async fn notion_has_the_same_shape_and_never_gives_up() {
        let world = world().await;
        let unavailable = || {
            Reply::json(
                503,
                &json!({ "code": "service_unavailable", "message": "later" }),
            )
        };
        world.state.lock().unwrap().append_failures = vec![unavailable(); 400];
        let mut run = world.run(None, true);
        let a = world.follow_with(&script(), &mut run).await;
        assert!(failed_with(&a.notion, "transient HTTP 503"), "{a:?}");
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert!(failed_with(&b.notion, "transient HTTP 503"), "{b:?}");
        let sent = world.notion.requests().len();
        let third = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(third.notion, Step::Later(Later::OffForRun));
        assert_eq!(world.notion.requests().len(), sent);

        // A 400 each run: the page waits, tries again, and never gives up.
        let refused = || Reply::json(400, &json!({ "code": "validation_error", "message": "no" }));
        world.state.lock().unwrap().append_failures = vec![refused(); 20];
        for n in 2..=9 {
            world.advance(MAX_BACKOFF);
            let mut run = world.run(None, true);
            let tried = world.follow_with(&script(), &mut run).await;
            assert!(
                failed_with(
                    &tried.notion,
                    &format!("bad request not counted {}, next try in", n - 1)
                ),
                "{tried:?}"
            );
        }
        assert_eq!(
            (
                world.notion_failures().free_fails,
                world.notion_failures().uncounted_bad_requests
            ),
            (1, 8)
        );
    }

    /// A record from before (`huddle-summary-failed/1`: `kind`, `code`,
    /// `paid_tries`) still counts.
    #[tokio::test]
    async fn an_older_failure_record_still_counts() {
        let world = world().await;
        let old = json!({
            "format": "huddle-summary-failed/1",
            "script_sha256": sha_of(&script()),
            "kind": "bad-response",
            "code": "finish reason SAFETY",
            "paid_tries": 2,
        });
        std::fs::write(
            world.home.beside_path(FIRST, Beside::SummaryFailed),
            serde_json::to_vec(&old).unwrap(),
        )
        .unwrap();
        assert_eq!(world.failures().last_kind, "bad-response");
        let cut = cut_off_gemini().await;
        let settings = gemini_settings(&cut);
        let last = world
            .follow_with(&script(), &mut world.run(Some(&settings), false))
            .await;
        assert!(
            failed_with(&last.summary, "paid try 3 of 3, given up)"),
            "{last:?}"
        );
    }

    // ---- review round 4 (r4_*) and the rules after it ----

    fn failures_of(world: &World, first: u128, beside: Beside) -> Option<StepFailures> {
        std::fs::read(world.home.beside_path(Uuid::from_u128(first), beside))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    /// 429: off for the run at once; the meeting waits but it is not
    /// counted against it.
    #[tokio::test]
    async fn rate_limits_are_not_counted_but_wait() {
        let world = world().await;
        let limited = FakeServer::start(|_| {
            Reply::json(429, &json!({ "error": { "status": "RESOURCE_EXHAUSTED" } }))
        })
        .await;
        let settings = gemini_settings(&limited);
        let a = world
            .follow_with(&script(), &mut world.run(Some(&settings), false))
            .await;
        assert!(
            failed_with(&a.summary, "(not counted, next try in 10 min)"),
            "{a:?}"
        );
        let failures = world.failures();
        assert_eq!((failures.free_fails, failures.paid_tries), (0, 0));
        assert_eq!(failures.next_try_after_unix_ms, world.now() + 600_000);
        assert_eq!(failures.last_kind, "rate-limited");
    }

    /// The token source not answering is not the meeting's doing: not
    /// counted, no record; on two meetings in a row the summary is off.
    #[tokio::test]
    async fn r4_no_token_is_not_counted() {
        let world = world().await;
        let tokens = Tokens::new(TokenSource::MetadataServer {
            base_url: "http://127.0.0.1:1".into(),
        })
        .unwrap();
        let step = SummaryStep {
            http: &world.http,
            settings: &world.gemini_settings,
            tokens: &tokens,
        };
        let mut run =
            FollowUps::new(Some(step), None, &PubkeyPrefixNames).with_clock(&*world.clock_fn);
        let a = world.follow_with(&script(), &mut run).await;
        assert!(failed_with(&a.summary, "no-token token: "), "{a:?}");
        assert!(failures_of(&world, 3, Beside::SummaryFailed).is_none());
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert!(failed_with(&b.summary, "no-token"), "{b:?}");
        let third = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(third.summary, Step::Later(Later::OffForRun));
        assert_eq!(world.gemini.requests().len(), 0);
    }

    /// Bad requests (400) on two meetings in a row look like a setting: off
    /// for the run, and the second is not counted for its meeting (it only
    /// waits).
    #[tokio::test]
    async fn bad_requests_on_two_meetings_in_a_row_turn_the_summary_off() {
        let world = world().await;
        world.refuse.store(true, Ordering::SeqCst);
        let mut run = world.steps();
        world.follow_with(&script(), &mut run).await;
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert!(
            failed_with(
                &b.summary,
                "(bad request not counted 1, next try in 10 min)"
            ),
            "{b:?}"
        );
        let b_failures = failures_of(&world, 10, Beside::SummaryFailed).unwrap();
        assert_eq!(
            (b_failures.free_fails, b_failures.uncounted_bad_requests),
            (0, 1)
        );
        assert_eq!(b_failures.next_try_after_unix_ms, world.now() + 600_000);
        let sent = world.gemini.requests().len();
        let third = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(third.summary, Step::Later(Later::OffForRun));
        assert_eq!(world.gemini.requests().len(), sent);
    }

    /// The same for the Notion page (400·404).
    #[tokio::test]
    async fn bad_requests_on_two_meetings_in_a_row_turn_the_page_off() {
        let world = world().await;
        let refused = || Reply::json(400, &json!({ "code": "validation_error", "message": "no" }));
        world.state.lock().unwrap().append_failures = vec![refused(); 10];
        let mut run = world.run(None, true);
        world.follow_with(&script(), &mut run).await;
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert!(
            failed_with(&b.notion, "(bad request not counted 1, next try in"),
            "{b:?}"
        );
        assert_eq!(
            failures_of(&world, 10, Beside::NotionFailed)
                .unwrap()
                .free_fails,
            0
        );
        let sent = world.notion.requests().len();
        let third = world.follow_with(&other_script(), &mut run).await;
        assert_eq!(third.notion, Step::Later(Later::OffForRun));
        assert_eq!(world.notion.requests().len(), sent);
    }

    /// A next try further off than the longest wait was never written by
    /// the worker: it is not waited for.
    #[tokio::test]
    async fn a_next_try_too_far_off_is_not_waited_for() {
        let world = world().await;
        let longest = MAX_BACKOFF.as_millis() as u64;
        let record = |next: u64| StepFailures {
            free_fails: 1,
            next_try_after_unix_ms: next,
            ..StepFailures::new(&sha_of(&script()))
        };
        let write = |failures: StepFailures| {
            std::fs::write(
                world.home.beside_path(FIRST, Beside::SummaryFailed),
                serde_json::to_vec(&failures).unwrap(),
            )
            .unwrap()
        };
        write(record(world.now() + longest));
        assert_eq!(world.follow().await.summary, Step::Later(Later::Backoff));
        write(record(world.now() + longest + 60_000));
        assert_eq!(world.follow().await.summary, Step::Done);
    }

    /// Two meetings failing with 500, then a good one, every 10 minutes:
    /// the good one waits two runs (trouble twice in a row turns the
    /// summary off), then goes through while the two back off; each try of
    /// those two counts against it.
    #[tokio::test]
    async fn r4_two_poison_then_good() {
        let world = world().await;
        let meeting_c = plan_in(
            &world.dir.path().join("recordings"),
            Uuid::from_u128(11),
            Uuid::from_u128(12),
        )
        .await;
        let server = FakeServer::start(|request| {
            let body = String::from_utf8_lossy(&request.body).to_string();
            if body.contains("견적서") || body.contains("다른 회의") {
                Reply::json(500, &json!({ "error": { "status": "INTERNAL" } }))
            } else {
                gemini_reply(&answer(json!([])), "STOP")
            }
        })
        .await;
        let settings = gemini_settings(&server);
        let mut good = transcript_with(&[(1_000, A, "좋은 회의예요.")]);
        good.channel_id = Uuid::from_u128(11);
        good.session_ids = vec![Uuid::from_u128(12)];
        let mut c_steps = Vec::new();
        for _ in 0..4 {
            let mut run = world.run(Some(&settings), false);
            world.follow_with(&script(), &mut run).await;
            world
                .follow_meeting(&world.meeting_b, &b_script(), &mut run)
                .await;
            let c = world.follow_meeting(&meeting_c, &good, &mut run).await;
            c_steps.push(c.summary);
            world.advance(Duration::from_secs(600));
        }
        assert_eq!(
            c_steps,
            [
                Step::Later(Later::OffForRun),
                Step::Later(Later::OffForRun),
                Step::Done,
                Step::AlreadyDone
            ]
        );
        let counted = |first| {
            failures_of(&world, first, Beside::SummaryFailed)
                .unwrap()
                .free_fails
        };
        assert_eq!((counted(3), counted(10)), (3, 3));
    }

    /// Gemini refusing meeting A's script (`견적서`) as a bad request and
    /// answering the others.
    async fn refuses_a() -> FakeServer {
        FakeServer::start(|request| {
            if String::from_utf8_lossy(&request.body).contains("견적서") {
                Reply::json(400, &json!({ "error": { "status": "INVALID_ARGUMENT" } }))
            } else {
                gemini_reply(&answer(json!([])), "STOP")
            }
        })
        .await
    }

    /// A wrong setting (every meeting gets 400), runs every 10 minutes for
    /// a day: nobody is given up, nothing counts as the meetings' own; once
    /// fixed, the next try writes both.
    #[tokio::test]
    async fn r4_a_wrong_setting_gives_up_nobody_for_a_day() {
        let world = world().await;
        world.refuse.store(true, Ordering::SeqCst);
        for _ in 0..(24 * 6) {
            let mut run = world.steps();
            for (meeting, script) in [(&world.meeting, script()), (&world.meeting_b, b_script())] {
                let followed = world.follow_meeting(meeting, &script, &mut run).await;
                assert!(
                    !failed_with(&followed.summary, "given up") && followed.summary != Step::GaveUp,
                    "{followed:?}"
                );
            }
            world.advance(Duration::from_secs(600));
        }
        let a = failures_of(&world, 3, Beside::SummaryFailed).unwrap();
        let b = failures_of(&world, 10, Beside::SummaryFailed).unwrap();
        assert_eq!((a.free_fails, b.free_fails), (0, 0));
        assert!(a.uncounted_bad_requests < UNCOUNTED_BAD_REQUESTS, "{a:?}");
        assert!(b.uncounted_bad_requests < UNCOUNTED_BAD_REQUESTS, "{b:?}");
        // Fixed: the next try goes through.
        world.refuse.store(false, Ordering::SeqCst);
        world.advance(MAX_BACKOFF);
        let mut run = world.steps();
        let a = world.follow_with(&script(), &mut run).await;
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert_eq!(pair(&a), (Step::Done, Step::Done));
        assert_eq!(pair(&b), (Step::Done, Step::Done));
    }

    /// A bad request in a run where another meeting's summary succeeded
    /// first counts as the meeting's own.
    #[tokio::test]
    async fn a_bad_request_after_a_success_counts() {
        let world = world().await;
        let server = refuses_a().await;
        let settings = gemini_settings(&server);
        let mut run = world.run(Some(&settings), false);
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert_eq!(b.summary, Step::Done);
        let a = world.follow_with(&script(), &mut run).await;
        assert!(
            failed_with(&a.summary, "(free failure 1, next try in 10 min)"),
            "{a:?}"
        );
        let failures = world.failures();
        assert_eq!(
            (failures.free_fails, failures.uncounted_bad_requests),
            (1, 0)
        );
    }

    /// A meeting that always comes first and always gets 400 is counted
    /// apart; the 11th time (about 34.5 hours) gives its summary up.
    #[tokio::test]
    async fn a_bad_meeting_always_first_is_given_up_in_the_end() {
        let world = world().await;
        let server = refuses_a().await;
        let settings = gemini_settings(&server);
        let start = world.now();
        let mut uncounted = Vec::new();
        for _ in 0..20 {
            let mut run = world.run(Some(&settings), false);
            let a = world.follow_with(&script(), &mut run).await;
            world
                .follow_meeting(&world.meeting_b, &b_script(), &mut run)
                .await;
            let failures = world.failures();
            uncounted.push(failures.uncounted_bad_requests);
            if failures.summary_given_up() {
                assert!(failed_with(&a.summary, "given up"), "{a:?}");
                break;
            }
            assert!(failed_with(&a.summary, "bad request not counted"), "{a:?}");
            world.advance(Duration::from_millis(
                failures.next_try_after_unix_ms - world.now(),
            ));
        }
        assert!(world.failures().summary_given_up(), "{uncounted:?}");
        assert_eq!(uncounted, (1..=UNCOUNTED_BAD_REQUESTS).collect::<Vec<_>>());
        assert_eq!((world.now() - start) / 60_000, 2_070, "about 34.5 hours");
        assert_eq!(world.failures().free_fails, 0);
        let after = world
            .follow_with(&script(), &mut world.run(Some(&settings), false))
            .await;
        assert_eq!(after.summary, Step::GaveUp);
    }

    /// The same for the Notion page: a bad request after another meeting's
    /// page went through counts as the meeting's own.
    #[tokio::test]
    async fn a_bad_page_request_after_a_success_counts() {
        let world = world().await;
        let mut run = world.run(None, true);
        let b = world
            .follow_meeting(&world.meeting_b, &b_script(), &mut run)
            .await;
        assert_eq!(b.notion, Step::Done);
        world.state.lock().unwrap().append_failures = vec![Reply::json(
            400,
            &json!({ "code": "validation_error", "message": "no" }),
        )];
        let a = world.follow_with(&script(), &mut run).await;
        assert!(
            failed_with(&a.notion, "(free failure 1, next try in 10 min)"),
            "{a:?}"
        );
        assert_eq!(world.notion_failures().uncounted_bad_requests, 0);
    }

    /// The first ask is cut off at the limit (paid), the shorter ask gets
    /// 400: a paid try, three at most — not a bad request counted apart.
    #[tokio::test]
    async fn r5_paid_then_bad_request_is_a_paid_try() {
        let world = world().await;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n = calls.clone();
        let server = FakeServer::start(move |_| {
            if n.fetch_add(1, Ordering::SeqCst).is_multiple_of(2) {
                gemini_reply(&answer(json!([])), "MAX_TOKENS")
            } else {
                Reply::json(400, &json!({ "error": { "status": "INVALID_ARGUMENT" } }))
            }
        })
        .await;
        let settings = gemini_settings(&server);
        let mut steps_seen = Vec::new();
        for _ in 0..5 {
            let mut run = world.run(Some(&settings), false);
            let a = world.follow_with(&script(), &mut run).await;
            steps_seen.push(a.summary);
            world.advance(MAX_BACKOFF);
        }
        assert!(
            failed_with(&steps_seen[0], "(paid try 1 of 3)"),
            "{steps_seen:?}"
        );
        assert!(
            failed_with(&steps_seen[2], "(paid try 3 of 3, given up)"),
            "{steps_seen:?}"
        );
        assert_eq!(steps_seen[3..], [Step::GaveUp, Step::GaveUp]);
        let failures = world.failures();
        assert_eq!(
            (
                failures.paid_tries,
                failures.free_fails,
                failures.uncounted_bad_requests
            ),
            (3, 0, 0)
        );
        // Three paid answers (and three shorter asks), no more.
        assert_eq!(calls.load(Ordering::SeqCst), 6);
    }

    /// A paid answer, then 429 on the shorter ask: still a paid try (the
    /// 429 does not make it a wait-only failure).
    #[tokio::test]
    async fn a_paid_answer_then_429_is_a_paid_try() {
        let world = world().await;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n = calls.clone();
        let server = FakeServer::start(move |_| match n.fetch_add(1, Ordering::SeqCst) {
            0 => gemini_reply(&answer(json!([])), "MAX_TOKENS"),
            _ => Reply::json(429, &json!({ "error": { "status": "RESOURCE_EXHAUSTED" } })),
        })
        .await;
        let settings = gemini_settings(&server);
        let a = world
            .follow_with(&script(), &mut world.run(Some(&settings), false))
            .await;
        assert!(failed_with(&a.summary, "rate-limited"), "{a:?}");
        assert!(failed_with(&a.summary, "(paid try 1 of 3)"), "{a:?}");
        assert_eq!(world.failures().paid_tries, 1);
    }

    // ---- The context correction.

    const SPOKEN: &str = "회의록은 오션에 올려 주세요.";

    fn spoken_script() -> Transcript {
        transcript_with(&[(1_000, A, SPOKEN), (5_000, A, "금요일까지 보낼게요.")])
    }

    fn is_correction(request: &crate::test_http::Recorded) -> bool {
        String::from_utf8_lossy(&request.body).contains("받아쓰기 교정 담당")
    }

    /// The correction's answer for [`spoken_script`]: one sure fix.
    fn fix_answer() -> String {
        json!({ "lines": [{ "id": "L000", "edits": [
            { "from": "오션에", "to": "노션에", "level": "확정", "why": "ㄴ과 ㅇ" }
        ] }] })
        .to_string()
    }

    /// A fake Gemini for both steps: the correction fails (HTTP 500, free)
    /// while `fail` is set and is cut off (paid) while `cut` is set; the
    /// summary is cut off (paid) while `cut_summary` is set.
    async fn two_step_gemini(
        fail: Arc<AtomicBool>,
        cut: Arc<AtomicBool>,
        cut_summary: Arc<AtomicBool>,
    ) -> FakeServer {
        FakeServer::start(move |request| {
            if !is_correction(request) {
                let finish = if cut_summary.load(Ordering::SeqCst) {
                    "MAX_TOKENS"
                } else {
                    "STOP"
                };
                return gemini_reply(&answer(json!([])), finish);
            }
            if fail.load(Ordering::SeqCst) {
                Reply::json(500, &json!({ "error": { "status": "INTERNAL" } }))
            } else if cut.load(Ordering::SeqCst) {
                gemini_reply(&fix_answer(), "MAX_TOKENS")
            } else {
                gemini_reply(&fix_answer(), "STOP")
            }
        })
        .await
    }

    struct Correcting {
        world: World,
        server: FakeServer,
        settings: GeminiSettings,
        glossary: Glossary,
        fail: Arc<AtomicBool>,
        cut: Arc<AtomicBool>,
        cut_summary: Arc<AtomicBool>,
    }

    async fn correcting() -> Correcting {
        let world = world().await;
        let fail = Arc::new(AtomicBool::new(false));
        let cut = Arc::new(AtomicBool::new(false));
        let cut_summary = Arc::new(AtomicBool::new(false));
        let server = two_step_gemini(fail.clone(), cut.clone(), cut_summary.clone()).await;
        Correcting {
            world,
            settings: gemini_settings(&server),
            server,
            glossary: Glossary::team(),
            fail,
            cut,
            cut_summary,
        }
    }

    impl Correcting {
        /// All three steps, or only the summary and the page.
        async fn follow(&self, correct: bool, script: &Transcript) -> FollowedUp {
            self.follow_steps(correct, true, script).await
        }

        /// The correction when `correct`, the summary when `summary`, and the
        /// page.
        async fn follow_steps(
            &self,
            correct: bool,
            summary: bool,
            script: &Transcript,
        ) -> FollowedUp {
            let mut steps = self.world.run(summary.then_some(&self.settings), true);
            if correct {
                steps = steps.with_correct(CorrectStep {
                    http: &self.world.http,
                    settings: &self.settings,
                    tokens: &self.world.tokens,
                    glossary: &self.glossary,
                });
            }
            self.world.follow_with(script, &mut steps).await
        }

        /// The summary requests, in order.
        fn summary_prompts(&self) -> Vec<String> {
            self.server
                .requests()
                .iter()
                .filter(|request| !is_correction(request))
                .map(|request| String::from_utf8_lossy(&request.body).into_owned())
                .collect()
        }

        fn corrections_sent(&self) -> usize {
            self.server
                .requests()
                .iter()
                .filter(|request| is_correction(request))
                .count()
        }

        fn corrected_path(&self) -> std::path::PathBuf {
            self.world.home.beside_path(FIRST, Beside::Corrected)
        }

        fn stored(&self) -> Summary {
            serde_json::from_slice(&self.world.summary_bytes()).unwrap()
        }
    }

    #[tokio::test]
    async fn a_failed_correction_holds_nothing_up_and_is_used_once_it_comes() {
        let c = correcting().await;
        let script = spoken_script();
        c.fail.store(true, Ordering::SeqCst);
        let first = c.follow(true, &script).await;
        assert!(failed_with(&first.correct, "transient"), "{first:?}");
        assert!(failed_with(&first.correct, "(free failure 1"), "{first:?}");
        assert_eq!(pair(&first), (Step::Done, Step::Done));
        assert_eq!(first.correct_made, None);
        // Made from the original, and stamped so.
        assert!(c.summary_prompts()[0].contains("오션에"));
        assert_eq!(c.stored().corrected_sha256, "");
        assert_eq!(c.world.record().unwrap().corrected_sha256, "");
        assert!(!c.corrected_path().exists());

        // Waiting after the failure: nothing else is done again.
        let waiting = c.follow(true, &script).await;
        assert_eq!(waiting.correct, Step::Later(Later::Backoff));
        assert_eq!(pair(&waiting), (Step::AlreadyDone, Step::AlreadyDone));

        c.fail.store(false, Ordering::SeqCst);
        c.world.advance(FIRST_BACKOFF);
        let second = c.follow(true, &script).await;
        assert_eq!(second.correct, Step::Done);
        assert_eq!(pair(&second), (Step::Done, Step::Done));
        let made = second.correct_made.clone().unwrap();
        assert_eq!((made.sure, made.unsure, made.dropped), (1, 0, 0));
        assert_eq!(made.usage.calls, 1);
        let sha = sha256_hex(&std::fs::read(c.corrected_path()).unwrap());
        assert_eq!(c.stored().corrected_sha256, sha);
        assert_eq!(c.world.record().unwrap().corrected_sha256, sha);
        // The summary now reads the corrected text only.
        let prompts = c.summary_prompts();
        assert_eq!(prompts.len(), 2);
        assert!(prompts[1].contains("노션에") && !prompts[1].contains("오션에"));
        // The page shows the fix with the original word in place.
        let (_, blocks) = c.world.page();
        assert!(
            blocks.contains("회의록은 노션에(원래: 오션에) 올려 주세요."),
            "{blocks}"
        );
        // The script itself is never touched.
        assert_eq!(script.segments[0].text, SPOKEN);

        let sent = c.server.requests().len();
        let third = c.follow(true, &script).await;
        assert_eq!(third.correct, Step::AlreadyDone);
        assert_eq!(pair(&third), (Step::AlreadyDone, Step::AlreadyDone));
        assert_eq!(c.server.requests().len(), sent);
    }

    #[tokio::test]
    async fn a_given_up_correction_never_makes_the_summary_again() {
        let c = correcting().await;
        let script = spoken_script();
        c.cut.store(true, Ordering::SeqCst);
        for paid in 1..=PAID_SUMMARY_TRIES {
            let run = c.follow(true, &script).await;
            let tally = format!("(paid try {paid} of {PAID_SUMMARY_TRIES}");
            assert!(failed_with(&run.correct, &tally), "{run:?}");
            let summary = if paid == 1 {
                Step::Done
            } else {
                Step::AlreadyDone
            };
            assert_eq!(pair(&run).0, summary);
        }
        let sent = c.server.requests().len();
        let after = c.follow(true, &script).await;
        assert_eq!(after.correct, Step::GaveUp);
        assert_eq!(pair(&after), (Step::AlreadyDone, Step::AlreadyDone));
        assert_eq!(c.server.requests().len(), sent);
        assert_eq!(c.summary_prompts().len(), 1);
        let failures: StepFailures = serde_json::from_slice(
            &std::fs::read(c.world.home.beside_path(FIRST, Beside::CorrectFailed)).unwrap(),
        )
        .unwrap();
        assert_eq!(failures.paid_tries, PAID_SUMMARY_TRIES);
    }

    #[tokio::test]
    async fn turning_the_correction_on_later_makes_the_summary_and_page_again() {
        let c = correcting().await;
        let script = spoken_script();
        let off = c.follow(false, &script).await;
        assert_eq!(off.correct, Step::Off);
        assert_eq!(pair(&off), (Step::Done, Step::Done));
        assert_eq!(c.corrections_sent(), 0);

        let on = c.follow(true, &script).await;
        assert_eq!(on.correct, Step::Done);
        assert_eq!(pair(&on), (Step::Done, Step::Done));
        assert_eq!(c.summary_prompts().len(), 2);

        // Off again: what was made stays; nothing is compared or sent.
        let sent = c.server.requests().len();
        let off = c.follow(false, &script).await;
        assert_eq!(off.correct, Step::Off);
        assert_eq!(pair(&off), (Step::AlreadyDone, Step::AlreadyDone));
        assert_eq!(c.server.requests().len(), sent);
    }

    #[tokio::test]
    async fn a_correction_counts_only_for_its_own_script() {
        let c = correcting().await;
        assert_eq!(c.follow(true, &spoken_script()).await.correct, Step::Done);
        let other = other_script();
        let again = c.follow(true, &other).await;
        assert_eq!(again.correct, Step::Done);
        assert_eq!(c.corrections_sent(), 2);
        let stored: Corrected =
            serde_json::from_slice(&std::fs::read(c.corrected_path()).unwrap()).unwrap();
        assert_eq!(stored.script_sha256, sha_of(&other));
        // The fix's words are not in the other script: dropped.
        assert_eq!((stored.sure_edits(), stored.dropped), (0, 1));
    }

    #[tokio::test]
    async fn an_unreadable_stored_correction_is_not_paid_for_again() {
        let c = correcting().await;
        std::fs::write(c.corrected_path(), b"{ not json").unwrap();
        let run = c.follow(true, &spoken_script()).await;
        assert!(
            failed_with(&run.correct, "stored correction unreadable"),
            "{run:?}"
        );
        assert_eq!(pair(&run), (Step::Done, Step::Done));
        assert_eq!(c.corrections_sent(), 0);
        assert_eq!(c.stored().corrected_sha256, "");
    }

    #[tokio::test]
    async fn the_page_follows_the_correction_even_without_the_summary() {
        let c = correcting().await;
        let script = spoken_script();
        c.fail.store(true, Ordering::SeqCst);
        let first = c.follow_steps(true, false, &script).await;
        assert!(failed_with(&first.correct, "transient"), "{first:?}");
        assert_eq!(pair(&first), (Step::Off, Step::Done));
        assert!(!c.world.page().1.contains("원래:"));

        c.fail.store(false, Ordering::SeqCst);
        c.world.advance(FIRST_BACKOFF);
        let second = c.follow_steps(true, false, &script).await;
        assert_eq!(second.correct, Step::Done);
        // Only the correction changed: the page is written again for it.
        assert_eq!(pair(&second), (Step::Off, Step::Done));
        assert!(c.world.page().1.contains("노션에(원래: 오션에)"));
        let third = c.follow_steps(true, false, &script).await;
        assert_eq!(pair(&third), (Step::Off, Step::AlreadyDone));
    }

    #[tokio::test]
    async fn a_summary_given_up_after_the_correction_keeps_the_earlier_one() {
        let c = correcting().await;
        let script = spoken_script();
        c.fail.store(true, Ordering::SeqCst);
        assert_eq!(
            pair(&c.follow(true, &script).await),
            (Step::Done, Step::Done)
        );
        let earlier = c.world.summary_bytes();

        // The correction comes, and every new summary is cut off (paid).
        c.fail.store(false, Ordering::SeqCst);
        c.cut_summary.store(true, Ordering::SeqCst);
        c.world.advance(FIRST_BACKOFF);
        for paid in 1..PAID_SUMMARY_TRIES {
            let run = c.follow(true, &script).await;
            assert!(
                failed_with(&run.summary, &format!("(paid try {paid} of")),
                "{run:?}"
            );
            // The page waits for the new summary.
            assert_eq!(run.notion, Step::Later(Later::Summary));
        }
        let last = c.follow(true, &script).await;
        assert!(failed_with(&last.summary, "given up"), "{last:?}");
        // The page keeps the summary it had, with the corrected script.
        assert_eq!(last.notion, Step::Done);
        assert_eq!(c.world.summary_bytes(), earlier);
        let record = c.world.record().unwrap();
        assert_eq!(record.summary_sha256, sha256_hex(&earlier));
        let (_, blocks) = c.world.page();
        assert!(!blocks.contains(SUMMARY_GIVEN_UP), "{blocks}");
        assert!(blocks.contains("노션에(원래: 오션에)"), "{blocks}");

        let sent = c.server.requests().len();
        let after = c.follow(true, &script).await;
        assert_eq!(pair(&after), (Step::GaveUp, Step::AlreadyDone));
        assert_eq!(c.server.requests().len(), sent);
    }

    #[tokio::test]
    async fn the_summary_checks_its_evidence_against_the_original_script() {
        // The original says he heard it; a correction turns it into a promise.
        let script = transcript_with(&[(1_000, A, "견적서는 제가 금요일까지 보낸대요.")]);
        let fix = json!({ "lines": [{ "id": "L000", "edits": [
            { "from": "보낸대요", "to": "보낼게요", "level": "확정", "why": "소리" }
        ] }] })
        .to_string();
        let promise = json!([{
            "text": "견적서 보내기",
            "assignee_id": "P1",
            "assignee_quote": "제가 금요일까지 보낼게요",
            "due": "2026-10-16",
            "due_quote": "금요일까지",
            "status": "확정",
            "evidence_start_ms": 1_000
        }]);
        let server = FakeServer::start(move |request| {
            if is_correction(request) {
                gemini_reply(&fix, "STOP")
            } else {
                gemini_reply(&answer(promise.clone()), "STOP")
            }
        })
        .await;
        let world = world().await;
        let settings = gemini_settings(&server);
        let glossary = Glossary::team();
        let mut steps = world.run(Some(&settings), false).with_correct(CorrectStep {
            http: &world.http,
            settings: &settings,
            tokens: &world.tokens,
            glossary: &glossary,
        });
        let followed = world.follow_with(&script, &mut steps).await;
        assert_eq!(
            (followed.correct.clone(), pair(&followed).0),
            (Step::Done, Step::Done)
        );
        // The model read the corrected text…
        let prompt = server
            .requests()
            .iter()
            .filter(|request| !is_correction(request))
            .map(|request| String::from_utf8_lossy(&request.body).into_owned())
            .next()
            .unwrap();
        assert!(prompt.contains("보낼게요"));
        // …but only the original's words are evidence: no promise there.
        let stored: Summary = serde_json::from_slice(&world.summary_bytes()).unwrap();
        let item = &stored.action_items[0];
        assert_eq!(item.assignee_pubkey, None);
        assert_eq!(item.status, summary::ItemStatus::Unsure);
    }

    // ---- 참석자 프로필 이름.

    /// 한 사람(진짜 키)이 말한 회의: 첫 줄은 [`SPOKEN`].
    fn named_script(pubkey: &str) -> Transcript {
        transcript_with(&[
            (1_000, pubkey, SPOKEN),
            (5_000, pubkey, "금요일까지 보낼게요."),
        ])
    }

    /// generateContent 요청의 프롬프트 글.
    fn prompt_of(request: &crate::test_http::Recorded) -> String {
        request.json()["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// 프로필 이름은 회의마다 한 번만 묻고, 후보정·요약 프롬프트와 노션 페이지·담당자
    /// 줄이 같은 이름을 쓴다. 할 게 없는 다음 실행은 묻지 않는다.
    #[tokio::test]
    async fn profile_names_are_asked_once_and_reach_every_step() {
        let person = nostr::Keys::generate();
        let pubkey = person.public_key().to_hex();
        let event = profile_event(&person, &json!({ "display_name": "김지영" }), 10);
        let relay = FakeServer::start(move |_| Reply::json(200, &json!([event]))).await;
        let source = profile_source(&relay.base, &nostr::Keys::generate());
        let fixture = correcting().await;
        let script = named_script(&pubkey);
        let steps = || {
            fixture
                .world
                .run(Some(&fixture.settings), true)
                .with_correct(CorrectStep {
                    http: &fixture.world.http,
                    settings: &fixture.settings,
                    tokens: &fixture.world.tokens,
                    glossary: &fixture.glossary,
                })
                .with_profiles(&source)
        };
        let followed = fixture.world.follow_with(&script, &mut steps()).await;
        assert_eq!(
            (
                followed.correct.clone(),
                followed.summary.clone(),
                followed.notion.clone()
            ),
            (Step::Done, Step::Done, Step::Done)
        );
        assert_eq!(relay.requests().len(), 1, "one ask for the meeting");
        assert_eq!(
            followed.names,
            Some(NamesReport {
                asked: 1,
                found: 1,
                clashed: 0,
                trouble: None
            })
        );
        // 담당자 연결 DB 에 한 일이 로그로 갈 보고에 실린다.
        let report = followed.notion_report.as_ref().expect("page written");
        assert_eq!(report.people_rows_added.len(), 1);
        assert_eq!(report.people_error, None);

        let requests = fixture.server.requests();
        let correction = requests.iter().find(|r| is_correction(r)).unwrap();
        assert!(
            prompt_of(correction).contains("(김지영) "),
            "{}",
            prompt_of(correction)
        );
        let summary = requests.iter().find(|r| !is_correction(r)).unwrap();
        assert!(
            prompt_of(summary).contains(r#"{"id":"P1","name":"김지영"}"#),
            "{}",
            prompt_of(summary)
        );
        {
            let state = fixture.world.state.lock().unwrap();
            let pages = minutes_pages(&state);
            assert_eq!(
                pages[0].properties[minutes_property::PARTICIPANTS]["multi_select"],
                json!([{ "name": "김지영" }])
            );
            let body = serde_json::to_string(&pages[0].children).unwrap();
            assert!(body.contains(" 김지영: "), "{body}");
            assert!(!body.contains(&pubkey[..8]), "{body}");
            let row = state
                .pages
                .iter()
                .find(|page| page.properties.contains_key(people_property::PUBKEY))
                .unwrap();
            assert_eq!(
                row.properties[people_property::NAME]["title"][0]["plain_text"],
                "김지영"
            );
        }

        // 다 된 회의: 이름이 필요한 단계가 없으니 묻지 않는다.
        let again = fixture.world.follow_with(&script, &mut steps()).await;
        assert!(again.nothing_left(), "{again:?}");
        assert_eq!(again.names, None);
        assert_eq!(again.notion_report, None);
        assert_eq!(relay.requests().len(), 1);
    }

    /// 이름은 도장(sha256)에 안 섞인다: 1회차에 릴레이가 이름을 안 줘서(401) 앞 8자로 요약·
    /// 페이지를 만들고, 2회차에 이름이 나와도 요약·페이지를 다시 하지 않는다(Gemini·노션 요청
    /// 0개, 릴레이도 안 묻는다). 이름이 바뀔 때마다 돈 드는 요약을 다시 하지 않게 지킨다.
    #[tokio::test]
    async fn names_never_enter_the_stamps() {
        let world = world().await;
        let person = nostr::Keys::generate();
        let pubkey = person.public_key().to_hex();
        let event = profile_event(&person, &json!({ "display_name": "김지영" }), 10);
        let answer_names = Arc::new(AtomicBool::new(false));
        let gate = Arc::clone(&answer_names);
        let relay = FakeServer::start(move |_| {
            if gate.load(Ordering::SeqCst) {
                Reply::json(200, &json!([event]))
            } else {
                Reply::json(401, &json!({ "error": "NIP-98: replay detected" }))
            }
        })
        .await;
        let source = profile_source(&relay.base, &nostr::Keys::generate());
        let script = named_script(&pubkey);

        let first = world
            .follow_with(&script, &mut world.steps().with_profiles(&source))
            .await;
        assert_eq!(pair(&first), (Step::Done, Step::Done));
        assert_eq!(first.names.as_ref().map(|names| names.found), Some(0));

        answer_names.store(true, Ordering::SeqCst);
        let before = world.counts();
        let again = world
            .follow_with(&script, &mut world.steps().with_profiles(&source))
            .await;
        assert_eq!(pair(&again), (Step::AlreadyDone, Step::AlreadyDone));
        assert_eq!(
            world.counts(),
            before,
            "no Gemini or Notion request for names"
        );
        assert_eq!(again.names, None);
        assert_eq!(relay.requests().len(), 1);
    }

    /// 릴레이가 이름을 안 주면(401) 그 사람만 pubkey 앞 8자로 두고, 단계는 다 되며 실패로
    /// 세지도 실패 기록을 남기지도 않는다.
    #[tokio::test]
    async fn refused_names_fall_back_without_failing_the_meeting() {
        let world = world().await;
        let relay =
            FakeServer::start(|_| Reply::json(401, &json!({ "error": "NIP-98: replay detected" })))
                .await;
        let source = profile_source(&relay.base, &nostr::Keys::generate());
        let pubkey = nostr::Keys::generate().public_key().to_hex();
        let mut steps = world.steps().with_profiles(&source);
        let followed = world.follow_with(&named_script(&pubkey), &mut steps).await;
        assert_eq!(pair(&followed), (Step::Done, Step::Done));
        assert!(!followed.has_failure() && !followed.left_for_next_run());
        assert_eq!(
            followed.names,
            Some(NamesReport {
                asked: 1,
                found: 0,
                clashed: 0,
                trouble: Some(NamesTrouble::Refused(401))
            })
        );
        assert_eq!(relay.requests().len(), 1);
        for beside in [
            Beside::CorrectFailed,
            Beside::SummaryFailed,
            Beside::NotionFailed,
        ] {
            assert!(!world.home.beside_path(FIRST, beside).exists());
        }
        let state = world.state.lock().unwrap();
        assert_eq!(
            minutes_pages(&state)[0].properties[minutes_property::PARTICIPANTS]["multi_select"],
            json!([{ "name": &pubkey[..8] }])
        );
    }

    // ---- 팀 task DB 연결.

    /// task 연결 요청인가(시스템 지시로 가린다).
    fn is_tasks_request(request: &Recorded) -> bool {
        String::from_utf8_lossy(&request.body).contains("task 목록을 맞대어")
    }

    /// 블록의 글(멘션은 빼고).
    fn block_text(block: &Value) -> String {
        let kind = block["type"].as_str().unwrap_or("");
        block[kind]["rich_text"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|run| run["text"]["content"].as_str())
            .collect()
    }

    /// 모델이 낼 법한 답을 프롬프트의 task 목록에서 만든다(제목으로 K 번호를 찾는다): 견적서
    /// 자동화는 확실 + 기한, 로그인 오류 수정은 확실 + 완료, 결제 화면 개편은 애매, 회의록 공유
    /// 할 일은 그런 task 가 있으면 확실한 짝, 없으면 새 task.
    fn answer_for(request: &Recorded) -> Value {
        let prompt = request.json()["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        let list = prompt.split("진행 중 task(JSON 배열):\n").nth(1).unwrap();
        let tasks: Vec<Value> = serde_json::from_str(list.trim()).unwrap();
        let id = |title: &str| {
            tasks
                .iter()
                .find(|task| task["title"] == title)
                .map(|task| task["id"].as_str().unwrap().to_string())
        };
        let (mut links, mut due, mut status, mut new) = (vec![], vec![], vec![], vec![]);
        if let Some(k) = id("견적서 자동화") {
            links.push(
                json!({ "item": "A1", "task": k, "level": "확실", "why": "견적서 자동화",
                               "said": "금요일까지 끝내기로 했다.", "ms": 5_000 }),
            );
            due.push(json!({ "task": k, "due": "2026-10-16", "ms": 5_000 }));
        }
        if let Some(k) = id("로그인 오류 수정") {
            links.push(
                json!({ "item": "D1", "task": k, "level": "확실", "why": "로그인 오류",
                               "said": "어제 배포를 마쳤다.", "ms": 9_000 }),
            );
            status.push(json!({ "task": k, "status": "완료", "ms": 9_000 }));
        }
        if let Some(k) = id("결제 화면 개편") {
            links.push(json!({ "item": "T1", "task": k, "level": "애매",
                               "why": "결제 화면 이야기일 수 있다", "said": "", "ms": 13_000 }));
        }
        match id("회의록 공유 기능 만들기") {
            Some(k) => links.push(json!({ "item": "A2", "task": k, "level": "확실",
                                          "why": "같은 일", "said": "목요일까지 만든다.", "ms": 17_000 })),
            None => new.push(json!("A2")),
        }
        json!({ "links": links, "due_changes": due, "status_changes": status, "new_tasks": new })
    }

    /// task 연결 시험의 세상: 요약과 task 연결에 답하는 가짜 Gemini, task DB 가 있는 가짜 노션.
    struct Linking {
        world: World,
        gemini: FakeServer,
        settings: GeminiSettings,
        /// 있으면 task 연결에 이 답을 준다(없으면 [`answer_for`]).
        fixed: Arc<std::sync::Mutex<Option<Value>>>,
    }

    async fn linking() -> Linking {
        let world = world().await;
        add_task_db(&mut world.state.lock().unwrap());
        let fixed = Arc::new(std::sync::Mutex::new(None::<Value>));
        let shared = Arc::clone(&fixed);
        let gemini = FakeServer::start(move |request| {
            if !is_tasks_request(request) {
                return gemini_reply(&summary_answer(), "STOP");
            }
            let answer = shared
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| answer_for(request));
            gemini_reply(&answer.to_string(), "STOP")
        })
        .await;
        Linking {
            settings: gemini_settings(&gemini),
            world,
            gemini,
            fixed,
        }
    }

    impl Linking {
        /// 요약·페이지에 `mode` 의 task 연결(off 면 없음).
        fn steps(&self, mode: TasksMode) -> FollowUps<'_> {
            let steps = self.world.run(Some(&self.settings), true);
            if mode == TasksMode::Off {
                return steps;
            }
            let client = NotionClient::new(&self.world.http, &self.world.notion_settings, "t");
            steps.with_tasks(TasksStep::new(
                mode,
                &self.world.http,
                &self.settings,
                &self.world.tokens,
                client.unwrap(),
                TASK_DB,
            ))
        }

        async fn follow(&self, mode: TasksMode) -> FollowedUp {
            self.follow_script(mode, &task_meeting()).await
        }

        async fn follow_script(&self, mode: TasksMode, script: &Transcript) -> FollowedUp {
            let mut steps = self.steps(mode);
            self.world.follow_with(script, &mut steps).await
        }

        /// task 연결로 Gemini 에 물은 수.
        fn tasks_asked(&self) -> usize {
            self.gemini
                .requests()
                .iter()
                .filter(|request| is_tasks_request(request))
                .count()
        }

        /// task DB 로 간 노션 요청(읽기 포함).
        fn task_requests(&self) -> Vec<Recorded> {
            self.world
                .notion
                .requests()
                .into_iter()
                .filter(|request| {
                    request.path.contains("task-")
                        || request.json()["parent"]["data_source_id"] == TASK_DS
                })
                .collect()
        }

        /// task 쪽 쓰기(칸 고치기·덧붙이기·만들기).
        fn task_writes(&self) -> Vec<Recorded> {
            self.task_requests()
                .into_iter()
                .filter(|request| request.method != "GET" && !request.path.ends_with("/query"))
                .collect()
        }

        fn page(&self, id: &str) -> (serde_json::Map<String, Value>, Vec<Value>) {
            let state = self.world.state.lock().unwrap();
            let page = state.pages.iter().find(|page| page.id == id).unwrap();
            (page.properties.clone(), page.children.clone())
        }

        /// 그 task 페이지의 「허들 회의 기록」 수.
        fn records(&self, id: &str) -> usize {
            self.page(id)
                .1
                .iter()
                .filter(|block| {
                    block["type"] == "heading_3" && block_text(block).starts_with(RECORD_HEADING)
                })
                .count()
        }

        /// 회의가 만든 task(시험 task 가 아닌 task DB 페이지) id.
        fn created(&self) -> Vec<String> {
            let state = self.world.state.lock().unwrap();
            state
                .pages
                .iter()
                .filter(|page| page.data_source == TASK_DS && !page.id.starts_with("task-"))
                .map(|page| page.id.clone())
                .collect()
        }

        fn minutes_id(&self) -> String {
            minutes_pages(&self.world.state.lock().unwrap())[0]
                .id
                .clone()
        }

        /// 회의록 페이지의 「관련 있을 수 있는 task」 절 수.
        fn maybe_sections(&self) -> usize {
            self.page(&self.minutes_id())
                .1
                .iter()
                .filter(|block| block["type"] == "heading_2" && block_text(block) == MAYBE_HEADING)
                .count()
        }

        fn ledger_path(&self) -> std::path::PathBuf {
            self.world.home.beside_path(FIRST, Beside::Tasks)
        }

        fn ledger(&self) -> TasksLedger {
            serde_json::from_slice(&std::fs::read(self.ledger_path()).unwrap()).unwrap()
        }
    }

    /// 스위치 넷이 각각 할 일만 한다. off 는 task DB 를 보지도 않고 Gemini 도 안 부른다.
    /// append 는 확실한 짝에 기록만(애매한 짝은 회의록 페이지 절), create 는 짝 없는 확정 할 일을
    /// 새 task 로, update 는 종료일·작업상태까지 바꾼다.
    #[tokio::test]
    async fn each_tasks_mode_does_only_its_own_writes() {
        let off = linking().await;
        let followed = off.follow(TasksMode::Off).await;
        assert_eq!(pair(&followed), (Step::Done, Step::Done));
        assert_eq!(
            (followed.tasks.clone(), followed.tasks_made),
            (Step::Off, None)
        );
        assert_eq!(off.tasks_asked(), 0);
        assert!(off.task_requests().is_empty());

        let append = linking().await;
        let followed = append.follow(TasksMode::Append).await;
        assert_eq!(followed.tasks, Step::Done, "{followed:?}");
        assert_eq!(
            (
                append.records("task-1"),
                append.records("task-2"),
                append.records("task-3")
            ),
            (1, 1, 0)
        );
        let writes = append.task_writes();
        assert_eq!(writes.len(), 2, "{writes:?}");
        assert!(writes
            .iter()
            .all(|write| write.method == "PATCH" && write.path.ends_with("/children")));
        assert!(append.created().is_empty());
        assert_eq!(append.maybe_sections(), 1);
        assert_eq!(append.tasks_asked(), 1);

        let create = linking().await;
        let followed = create.follow(TasksMode::Create).await;
        assert_eq!(followed.tasks, Step::Done, "{followed:?}");
        let created = create.created();
        assert_eq!(created.len(), 1);
        let (properties, body) = create.page(&created[0]);
        assert_eq!(
            notion::property_text(&properties["기능"]),
            "회의록 공유 기능 만들기"
        );
        assert_eq!(properties["작업상태"]["select"]["name"], "시작 전");
        assert_eq!(properties["종료일"]["date"]["start"], "2026-10-15");
        assert_eq!(properties["담당자"]["people"][0]["id"], "user-1");
        assert_eq!(
            notion::property_text(&properties["관련 노션 페이지"]),
            page_url(&create.minutes_id())
        );
        assert!(
            serde_json::to_string(&body)
                .unwrap()
                .contains(&format!(r#""page":{{"id":"{}"}}"#, create.minutes_id())),
            "the body links the minutes"
        );
        assert!(
            create
                .task_writes()
                .iter()
                .all(|write| !write.path.starts_with("/v1/pages/task-")),
            "no property changes"
        );

        let update = linking().await;
        let followed = update.follow(TasksMode::Update).await;
        assert_eq!(followed.tasks, Step::Done, "{followed:?}");
        let report = followed.tasks_made.clone().unwrap();
        assert_eq!(
            (
                report.appended,
                report.created,
                report.due_changed,
                report.status_changed
            ),
            (2, 1, 1, 1)
        );
        let (task_1, body_1) = update.page("task-1");
        assert_eq!(task_1["종료일"]["date"]["start"], "2026-10-16");
        let (task_2, body_2) = update.page("task-2");
        assert_eq!(task_2["작업상태"]["select"]["name"], "완료");
        // 기록에 예전 값 → 새 값과 근거, 그 task 의 담당자 멘션.
        let body_1 = serde_json::to_string(&body_1).unwrap();
        assert!(
            body_1.contains("기한: 10/20 → 10/16 (근거 [00:05])"),
            "{body_1}"
        );
        assert!(body_1.contains(r#""user":{"id":"user-9"}"#), "{body_1}");
        let body_2 = serde_json::to_string(&body_2).unwrap();
        assert!(
            body_2.contains("상태: Dev QA → 완료 (근거 [00:09])"),
            "{body_2}"
        );
        assert!(
            !body_2.contains(r#""user":"#),
            "task-2 has no 담당자: {body_2}"
        );
        // 칸 고치기는 조용히, 바꿈이 든 기록은 알림이 가게(멘션).
        for write in update.task_writes() {
            let silent = write.json()["notifications"]["mode"] == "silent";
            if write.path.starts_with("/v1/pages/task-") {
                assert!(silent, "{}", write.path);
            }
            if write.path.ends_with("/children") && write.path.contains("task-") {
                assert!(!silent, "a change is told: {}", write.path);
            }
        }
    }

    /// 기존 task 에서는 종료일·작업상태만 고친다. 담당자·협업담당자·관계·우선순위·repo·commit
    /// id·배포·실제진행률은 어느 요청에도 안 들어간다.
    #[tokio::test]
    async fn only_due_and_status_are_ever_changed() {
        let link = linking().await;
        link.follow(TasksMode::Update).await;
        let allowed_new = ["기능", "작업상태", "관련 노션 페이지", "종료일", "담당자"];
        let mut patched = 0;
        for write in link.task_writes() {
            let body = write.json();
            let names: Vec<String> = body["properties"]
                .as_object()
                .map(|map| map.keys().cloned().collect())
                .unwrap_or_default();
            if write.path.starts_with("/v1/pages/task-") {
                patched += 1;
                assert!(
                    names
                        .iter()
                        .all(|name| crate::tasks::CHANGEABLE.contains(&name.as_str())),
                    "{names:?}"
                );
            } else if write.path == "/v1/pages" {
                assert!(
                    names
                        .iter()
                        .all(|name| allowed_new.contains(&name.as_str())),
                    "{names:?}"
                );
            } else {
                assert!(names.is_empty(), "{}: {names:?}", write.path);
            }
        }
        assert_eq!(patched, 2);
        let (task_1, _) = link.page("task-1");
        assert_eq!(task_1["담당자"]["people"][0]["id"], "user-9");
        assert_eq!(task_1["우선순위"]["select"]["name"], "높음");
        assert_eq!(notion::property_text(&task_1["repo"]), "a2d2-lab/buzz");
    }

    /// 다시 돌려도(10분마다, --overwrite 로 스크립트가 바뀌어도) 같은 task 에 두 번 쓰지 않고
    /// Gemini 도 회의마다 한 번만 부른다. 다시 쓴 회의록 페이지에도 애매한 짝 절은 하나다.
    #[tokio::test]
    async fn rerunning_writes_nothing_twice_and_asks_gemini_once() {
        let link = linking().await;
        assert_eq!(link.follow(TasksMode::Update).await.tasks, Step::Done);
        let writes = link.task_writes().len();
        let again = link.follow(TasksMode::Update).await;
        assert_eq!(again.tasks, Step::AlreadyDone);
        assert!(again.nothing_left(), "{again:?}");

        let mut other = task_meeting();
        other.segments.pop();
        let rewritten = link.follow_script(TasksMode::Update, &other).await;
        assert_eq!(pair(&rewritten), (Step::Done, Step::Done));
        assert_eq!(rewritten.tasks, Step::AlreadyDone);

        assert_eq!(link.tasks_asked(), 1);
        assert_eq!(link.task_writes().len(), writes);
        assert_eq!((link.records("task-1"), link.records("task-2")), (1, 1));
        assert_eq!(link.created().len(), 1);
        assert_eq!(
            link.maybe_sections(),
            1,
            "kept once on the page written again"
        );
    }

    /// 노션에 쓰고 장부에 남기기 전에 죽었다: 기록은 회의록 페이지 멘션으로, 새 task 는 관련
    /// 노션 페이지 칸으로, 회의록 절은 제목으로 알아보고 다시 안 쓴다(계획은 장부 것을 써서
    /// Gemini 도 다시 안 부른다). 장부를 통째로 잃어도 두 번 쓰지 않는다.
    #[tokio::test]
    async fn a_crash_before_the_ledger_writes_nothing_twice() {
        let link = linking().await;
        link.follow(TasksMode::Update).await;
        let mut ledger = link.ledger();
        ledger
            .done
            .retain(|key| key != "append:task-1" && !key.starts_with("create:") && key != "maybe");
        ledger.created.clear();
        ledger.finished = false;
        std::fs::write(link.ledger_path(), serde_json::to_vec(&ledger).unwrap()).unwrap();

        let resumed = link.follow(TasksMode::Update).await;
        assert_eq!(resumed.tasks, Step::Done, "{resumed:?}");
        let report = resumed.tasks_made.clone().unwrap();
        assert_eq!(
            (report.already_there, report.appended, report.created),
            (3, 0, 0)
        );
        assert_eq!(link.tasks_asked(), 1, "the stored plan was used");
        let counts = |link: &Linking| {
            (
                link.records("task-1"),
                link.records("task-2"),
                link.created().len(),
                link.maybe_sections(),
            )
        };
        assert_eq!(counts(&link), (1, 1, 1, 1));
        assert!(link.ledger().finished);

        // 장부를 잃음: 다시 계획한다(Gemini 한 번 더). 그래도 두 번 쓰는 것은 없다.
        std::fs::remove_file(link.ledger_path()).unwrap();
        let replanned = link.follow(TasksMode::Update).await;
        assert_eq!(replanned.tasks, Step::Done, "{replanned:?}");
        assert_eq!(link.tasks_asked(), 2);
        let report = replanned.tasks_made.clone().unwrap();
        assert_eq!(
            (
                report.appended,
                report.created,
                report.due_changed,
                report.status_changed
            ),
            (0, 0, 0, 0),
            "{report:?}"
        );
        assert_eq!(counts(&link), (1, 1, 1, 1));
    }

    /// 쓰기 하나가 실패하면(503) 거기서 멈추고 물러선다. 다음 시도는 남은 쓰기만 하고, 회의는
    /// 실패로 안 센다.
    #[tokio::test]
    async fn a_failed_write_is_tried_again_without_doubles() {
        let link = linking().await;
        link.world.state.lock().unwrap().failing_paths = vec!["task-2".into()];
        let first = link.follow(TasksMode::Update).await;
        assert!(
            failed_with(
                &first.tasks,
                "transient HTTP 503 service_unavailable (free failure 1, next try in 10 min)"
            ),
            "{first:?}"
        );
        assert!(!first.has_failure() && first.home_error.is_none() && first.tasks_failed());
        assert!(first.left_for_next_run());
        assert_eq!((link.records("task-1"), link.records("task-2")), (1, 0));
        assert!(!link.ledger().finished);

        link.world.state.lock().unwrap().failing_paths.clear();
        let waiting = link.follow(TasksMode::Update).await;
        assert_eq!(waiting.tasks, Step::Later(Later::Backoff));
        link.world.advance(FIRST_BACKOFF);
        let second = link.follow(TasksMode::Update).await;
        assert_eq!(second.tasks, Step::Done, "{second:?}");
        assert_eq!(
            (
                link.records("task-1"),
                link.records("task-2"),
                link.created().len()
            ),
            (1, 1, 1)
        );
        assert_eq!(link.page("task-2").0["작업상태"]["select"]["name"], "완료");
        assert_eq!(link.tasks_asked(), 1);
    }

    /// 계획은 쓰기 전에 장부에 남는다: 첫 쓰기부터 실패해도 다음 시도는 그 계획을 이어 쓰고
    /// Gemini 를 다시 부르지 않는다(돈 한 번).
    #[tokio::test]
    async fn the_plan_is_kept_when_the_first_write_fails() {
        let link = linking().await;
        link.world.state.lock().unwrap().failing_paths = vec!["task-1".into()];
        let first = link.follow(TasksMode::Update).await;
        assert!(failed_with(&first.tasks, "transient HTTP 503"), "{first:?}");
        let ledger = link.ledger();
        assert!(ledger.done.is_empty() && !ledger.finished, "{ledger:?}");
        assert_eq!(ledger.plan.tasks.len(), 2);

        link.world.state.lock().unwrap().failing_paths.clear();
        link.world.advance(FIRST_BACKOFF);
        let second = link.follow(TasksMode::Update).await;
        assert_eq!(second.tasks, Step::Done, "{second:?}");
        assert_eq!(link.tasks_asked(), 1);
        assert_eq!(
            second.tasks_made.unwrap().usage,
            None,
            "nothing paid this run"
        );
        assert_eq!((link.records("task-1"), link.records("task-2")), (1, 1));
    }

    /// 통합이 task DB 에 연결 안 됨(403): 회의록은 그대로 성공이고, 회의 몫으로 세지 않으며,
    /// 그 실행의 남은 회의는 task DB 를 다시 묻지 않는다. 로그 글에 노션 메시지가 없다.
    #[tokio::test]
    async fn a_task_db_the_integration_cannot_see_does_not_fail_the_meeting() {
        let link = linking().await;
        link.world.state.lock().unwrap().forbidden_paths = vec!["task-".into()];
        let mut run = link.steps(TasksMode::Update);
        let first = link.world.follow_with(&task_meeting(), &mut run).await;
        assert_eq!(pair(&first), (Step::Done, Step::Done));
        let Step::Failed(text) = &first.tasks else {
            panic!("{first:?}")
        };
        assert_eq!(text, "permission HTTP 403 restricted_resource");
        assert!(!first.has_failure() && first.home_error.is_none());
        assert!(first.tasks_failed() && first.left_for_next_run());
        assert_eq!(link.tasks_asked(), 0, "nothing paid");
        assert!(!link
            .world
            .home
            .beside_path(FIRST, Beside::TasksFailed)
            .exists());

        let asked = link.task_requests().len();
        let b = link
            .world
            .follow_meeting(&link.world.meeting_b, &b_script(), &mut run)
            .await;
        assert_eq!(b.notion, Step::Done);
        assert_eq!(b.tasks, Step::Later(Later::OffForRun));
        assert_eq!(link.task_requests().len(), asked);
    }

    /// 로그 줄은 수뿐이다(task 제목·사람 이름·pubkey·노션 id 없음).
    #[tokio::test]
    async fn task_logs_have_numbers_only() {
        let link = linking().await;
        *link.fixed.lock().unwrap() = Some(json!({
            "links": [
                { "item": "A1", "task": "K1", "level": "확실", "why": "견적서",
                  "said": "견적서 자동화를 금요일까지.", "ms": 5_000 },
                { "item": "D1", "task": "K9", "level": "확실", "why": "", "said": "", "ms": 9_000 }
            ],
            "due_changes": [{ "task": "K1", "due": "2026-10-23", "ms": 5_000 }],
            "status_changes": [],
            "new_tasks": []
        }));
        let followed = link.follow(TasksMode::Update).await;
        let report = followed.tasks_made.clone().unwrap();
        let lines = [
            report.to_string(),
            report.dropped.to_string(),
            format!("{:?}", followed.tasks),
        ];
        assert_eq!(
            lines[0],
            "tasks: matched 1 (sure 1, maybe 0), appended 1, created 0, due changed 0, status changed 0, skipped 2"
        );
        assert_eq!(
            lines[1],
            "tasks checks dropped: unknown task 1, date not in the words 1"
        );
        for line in &lines {
            for secret in [
                "견적",
                "로그인",
                "회의록",
                "결제",
                "담당 사람",
                "지영",
                "aaaaaaaa",
                "bbbbbbbb",
                "task-",
                "user-",
                "page-",
            ] {
                assert!(!line.contains(secret), "{secret} in {line}");
            }
        }
    }

    /// 끝난 지 24시간 넘은 회의는 task 를 건드리지 않는다(스위치를 처음 켰을 때 지난 회의들이
    /// 지금 task 를 덮어쓰지 않게). 남은 일로도 치지 않는다.
    #[tokio::test]
    async fn an_old_meeting_leaves_the_tasks_alone() {
        let link = linking().await;
        link.world.advance(Duration::from_secs(25 * 60 * 60));
        let followed = link.follow(TasksMode::Update).await;
        assert_eq!(pair(&followed), (Step::Done, Step::Done));
        assert_eq!(
            followed.tasks,
            Step::Skipped("the meeting ended over 24 hours ago")
        );
        assert_eq!(link.tasks_asked(), 0);
        assert!(link.task_requests().is_empty());
        assert!(link.follow(TasksMode::Update).await.nothing_left());
    }

    /// 애매한 짝만 있으면 task 에는 아무것도 안 쓰고 회의록 페이지에 링크만 남긴다.
    #[tokio::test]
    async fn maybe_links_only_reach_the_minutes_page() {
        let link = linking().await;
        *link.fixed.lock().unwrap() = Some(json!({
            "links": [
                { "item": "A1", "task": "K1", "level": "애매", "why": "아마 같은 일",
                  "said": "금요일까지", "ms": 5_000 },
                { "item": "T1", "task": "K3", "level": "애매", "why": "결제 화면", "said": "", "ms": 13_000 }
            ],
            "due_changes": [{ "task": "K1", "due": "2026-10-16", "ms": 5_000 }],
            "status_changes": [],
            "new_tasks": ["A1"]
        }));
        let followed = link.follow(TasksMode::Update).await;
        assert_eq!(followed.tasks, Step::Done, "{followed:?}");
        assert!(link.task_writes().is_empty(), "{:?}", link.task_writes());
        assert_eq!(link.maybe_sections(), 1);
        let (_, minutes) = link.page(&link.minutes_id());
        let minutes = serde_json::to_string(&minutes).unwrap();
        assert!(minutes.contains(r#""page":{"id":"task-1"}"#), "{minutes}");
        assert!(minutes.contains(r#""page":{"id":"task-3"}"#), "{minutes}");
    }
}
