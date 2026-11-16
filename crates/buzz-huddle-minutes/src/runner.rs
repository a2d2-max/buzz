//! Process one meeting, safely against another worker doing the same
//! meeting at the same time.
//!
//! Order: hold the meeting → check (while holding it) that no script
//! already covers it → open its ledger → fetch its chunks (only this
//! meeting's) → transcribe → store the mixed audio and the script → let go.
//! A meeting another worker holds is skipped and counted; the next run
//! picks it up.
//!
//! Where scripts, ledgers and holds live is a [`MinutesHome`]: a local
//! folder ([`LocalMinutes`], held with an OS `flock`, so a crashed worker
//! never leaves the meeting held) or the minutes bucket
//! ([`crate::gcs_minutes::GcsMinutes`], held with a lease object that
//! expires).

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};

use buzz_gcp::gcs::{GcsError, GcsErrorKind};
use fs2::FileExt;
use uuid::Uuid;

use crate::collect::{CollectError, MeetingPlan, Skip};
use crate::followup::{follow_up_held, FollowUps, FollowedUp};
use crate::ledger::{Ledger, SttLedger};
use crate::models::sha256_hex;
use crate::pipeline::{
    build_minutes, mixed_audio_key, MinutesError, MinutesOutput, MinutesSettings,
};
use crate::store::{PutNew, RecordingStore, StoreError};
use crate::stt::SpeechToText;
use crate::vad::SpeechDetector;

/// Where a channel's scripts, ledgers and holds live.
pub trait MinutesHome {
    /// A meeting's ledger.
    type Ledger: Ledger;
    /// Proof that this worker holds a meeting.
    type Hold;

    /// Take the meeting; `None` when another worker holds it.
    fn hold(
        &self,
        meeting: &MeetingPlan,
    ) -> impl Future<Output = Result<Option<Self::Hold>, MeetingError>>;
    /// Let go of the meeting.
    fn release(&self, hold: Self::Hold) -> impl Future<Output = Result<(), MeetingError>>;
    /// Whether `hold` is still this worker's (a lease may have expired and
    /// been taken over). Checked before writing what comes after the script.
    fn still_held(&self, hold: &Self::Hold) -> impl Future<Output = Result<bool, MeetingError>>;
    /// Every script of this meeting's channel: name, sessions and the
    /// sha256 of its bytes. An unreadable script is an error: skipping it
    /// could process a meeting twice.
    fn scripts(
        &self,
        meeting: &MeetingPlan,
    ) -> impl Future<Output = Result<Vec<ScriptInfo>, MeetingError>>;
    /// Name of this meeting's script, as [`scripts`] gives it.
    ///
    /// [`scripts`]: MinutesHome::scripts
    fn script_name(&self, meeting: &MeetingPlan) -> String;
    /// Open the meeting's ledger.
    fn open_ledger(
        &self,
        meeting: &MeetingPlan,
    ) -> impl Future<Output = std::io::Result<Self::Ledger>>;
    /// Store the script; returns where it went.
    fn write_script(
        &self,
        meeting: &MeetingPlan,
        json: Vec<u8>,
        overwrite: bool,
    ) -> impl Future<Output = Result<String, MeetingError>>;
    /// 이 회의의 노션 기록(스크립트 옆 `{첫 세션}.notion.json`: 만든 page id).
    /// 아직 없으면 `None`.
    fn read_notion_record(
        &self,
        meeting: &MeetingPlan,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, MeetingError>>;
    /// 이 회의의 노션 기록을 쓴다(있으면 바꿔 쓴다). 쓴 곳을 돌려준다.
    fn write_notion_record(
        &self,
        meeting: &MeetingPlan,
        json: Vec<u8>,
    ) -> impl Future<Output = Result<String, MeetingError>>;
    /// This meeting's own script ([`script_name`](MinutesHome::script_name)),
    /// if it is there.
    fn read_script(
        &self,
        meeting: &MeetingPlan,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, MeetingError>>;
    /// A file kept beside this meeting's script, if it is there.
    fn read_beside(
        &self,
        meeting: &MeetingPlan,
        beside: Beside,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, MeetingError>>;
    /// Store a file beside this meeting's script (replacing an older one);
    /// returns where it went.
    fn write_beside(
        &self,
        meeting: &MeetingPlan,
        beside: Beside,
        json: Vec<u8>,
    ) -> impl Future<Output = Result<String, MeetingError>>;
}

/// One script of a channel, as [`MinutesHome::scripts`] lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptInfo {
    /// Its name ([`MinutesHome::script_name`] for the meeting it belongs to).
    pub name: String,
    /// sha256 of its bytes (hex).
    pub sha256: String,
    /// The sessions it covers.
    pub session_ids: Vec<Uuid>,
}

/// Files kept beside a meeting's script, named `{first session id}` +
/// [`suffix`](Beside::suffix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Beside {
    /// The summary (`huddle-summary/1`).
    Summary,
    /// The summary's failures for the current script
    /// ([`crate::followup::StepFailures`]).
    SummaryFailed,
    /// The Notion page's failures for the current script.
    NotionFailed,
    /// The context correction (`huddle-corrected/1`).
    Corrected,
    /// The correction's failures for the current script.
    CorrectFailed,
    /// 팀 task DB 연결 장부(`huddle-tasks/1`, [`crate::tasks::TasksLedger`]): 회의마다
    /// 하나(스크립트가 바뀌어도 그대로).
    Tasks,
    /// task 연결의 실패 기록(현재 스크립트의 것).
    TasksFailed,
}

impl Beside {
    /// What follows the first session id in the name.
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Summary => ".summary.json",
            Self::SummaryFailed => ".summary-failed.json",
            Self::NotionFailed => ".notion-failed.json",
            Self::Corrected => ".corrected.json",
            Self::CorrectFailed => ".correct-failed.json",
            Self::Tasks => ".tasks.json",
            Self::TasksFailed => ".tasks-failed.json",
        }
    }
}

/// The local folder where scripts, ledgers and locks live.
#[derive(Debug, Clone)]
pub struct LocalMinutes {
    dir: PathBuf,
}

impl LocalMinutes {
    /// Use `dir`, creating it (0700) when missing.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        create_private_dir(dir)?;
        Ok(Self {
            dir: dir.to_path_buf(),
        })
    }

    /// Script of the meeting whose first session is `first`.
    pub fn transcript_path(&self, first: Uuid) -> PathBuf {
        self.dir.join(format!("{first}.transcript.json"))
    }

    /// Ledger of the meeting whose first session is `first`.
    pub fn ledger_path(&self, first: Uuid) -> PathBuf {
        self.dir.join(format!("{first}.stt.jsonl"))
    }

    fn lock_path(&self, first: Uuid) -> PathBuf {
        self.dir.join(format!("{first}.lock"))
    }

    /// 첫 세션이 `first` 인 회의의 노션 기록.
    pub fn notion_record_path(&self, first: Uuid) -> PathBuf {
        self.dir.join(format!("{first}.notion.json"))
    }

    /// Summary of the meeting whose first session is `first`.
    pub fn summary_path(&self, first: Uuid) -> PathBuf {
        self.beside_path(first, Beside::Summary)
    }

    /// A file beside the script of the meeting whose first session is
    /// `first`.
    pub fn beside_path(&self, first: Uuid, beside: Beside) -> PathBuf {
        self.dir.join(format!("{first}{}", beside.suffix()))
    }
}

impl MinutesHome for LocalMinutes {
    type Ledger = SttLedger;
    /// The lock file, locked; dropping it lets go.
    type Hold = std::fs::File;

    async fn hold(&self, meeting: &MeetingPlan) -> Result<Option<std::fs::File>, MeetingError> {
        let lock = open_private(&self.lock_path(meeting.first_session_id()), false)?;
        match lock.try_lock_exclusive() {
            Ok(()) => Ok(Some(lock)),
            Err(error) if error.kind() == fs2::lock_contended_error().kind() => Ok(None),
            Err(error) => Err(MeetingError::Io(error)),
        }
    }

    async fn release(&self, hold: std::fs::File) -> Result<(), MeetingError> {
        drop(hold);
        Ok(())
    }

    async fn still_held(&self, _hold: &std::fs::File) -> Result<bool, MeetingError> {
        // An OS lock held through an open file cannot be taken away.
        Ok(true)
    }

    async fn scripts(&self, _meeting: &MeetingPlan) -> Result<Vec<ScriptInfo>, MeetingError> {
        let scripts = |error: &dyn std::fmt::Display| MeetingError::Scripts(error.to_string());
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&self.dir).map_err(|e| scripts(&e))? {
            let entry = entry.map_err(|e| scripts(&e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".transcript.json") {
                continue;
            }
            let bytes = std::fs::read(entry.path()).map_err(|e| scripts(&e))?;
            found.push(script_info(name, &bytes)?);
        }
        Ok(found)
    }

    fn script_name(&self, meeting: &MeetingPlan) -> String {
        format!("{}.transcript.json", meeting.first_session_id())
    }

    async fn open_ledger(&self, meeting: &MeetingPlan) -> std::io::Result<SttLedger> {
        SttLedger::open(&self.ledger_path(meeting.first_session_id()))
    }

    async fn write_script(
        &self,
        meeting: &MeetingPlan,
        json: Vec<u8>,
        _overwrite: bool,
    ) -> Result<String, MeetingError> {
        let path = self.transcript_path(meeting.first_session_id());
        write_private(&path, &json)?;
        Ok(path.display().to_string())
    }

    async fn read_notion_record(
        &self,
        meeting: &MeetingPlan,
    ) -> Result<Option<Vec<u8>>, MeetingError> {
        match std::fs::read(self.notion_record_path(meeting.first_session_id())) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(MeetingError::Io(error)),
        }
    }

    async fn write_notion_record(
        &self,
        meeting: &MeetingPlan,
        json: Vec<u8>,
    ) -> Result<String, MeetingError> {
        let path = self.notion_record_path(meeting.first_session_id());
        write_private(&path, &json)?;
        Ok(path.display().to_string())
    }

    async fn read_script(&self, meeting: &MeetingPlan) -> Result<Option<Vec<u8>>, MeetingError> {
        read_if_there(&self.transcript_path(meeting.first_session_id()))
    }

    async fn read_beside(
        &self,
        meeting: &MeetingPlan,
        beside: Beside,
    ) -> Result<Option<Vec<u8>>, MeetingError> {
        read_if_there(&self.beside_path(meeting.first_session_id(), beside))
    }

    async fn write_beside(
        &self,
        meeting: &MeetingPlan,
        beside: Beside,
        json: Vec<u8>,
    ) -> Result<String, MeetingError> {
        let path = self.beside_path(meeting.first_session_id(), beside);
        write_private(&path, &json)?;
        Ok(path.display().to_string())
    }
}

/// The sessions a script covers: all a listing needs. Only this is read,
/// so a script in another format (a later `huddle-transcript/N`, say after
/// going back to an older worker) never fails the channel.
#[derive(serde::Deserialize)]
struct ScriptSessions {
    session_ids: Vec<Uuid>,
}

/// A script's [`ScriptInfo`] from its name and bytes.
pub fn script_info(name: String, bytes: &[u8]) -> Result<ScriptInfo, MeetingError> {
    // Only the kind of error: serde's text can quote the script.
    let script: ScriptSessions = serde_json::from_slice(bytes)
        .map_err(|e| MeetingError::Scripts(format!("{name}: not a script ({:?})", e.classify())))?;
    Ok(ScriptInfo {
        name,
        sha256: sha256_hex(bytes),
        session_ids: script.session_ids,
    })
}

/// The file's bytes, or `None` when there is no such file.
fn read_if_there(path: &Path) -> Result<Option<Vec<u8>>, MeetingError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(MeetingError::Io(error)),
    }
}

/// What happened to one meeting.
#[derive(Debug)]
pub enum Done {
    /// Script and mixed audio written.
    Written {
        /// The run's output (mixed audio already stored).
        output: Box<MinutesOutput>,
        /// Where the script went.
        script: String,
        /// The mixed audio: written now, or already there (from an earlier
        /// run; with other bytes it is kept — the worker never overwrites
        /// in the recording bucket).
        audio: PutNew,
        /// The summary and the Notion page, when they were asked for.
        follow: Option<FollowedUp>,
    },
    /// The script was already there; what was left after it (summary,
    /// Notion page) was done or tried now.
    FollowedUp(FollowedUp),
    /// Left alone this run.
    Skipped(Skip),
    /// Another worker holds the meeting.
    Locked,
}

/// Why one meeting failed. Other meetings go on unless
/// [`stops_the_run`](Self::stops_the_run).
#[derive(Debug, thiserror::Error)]
pub enum MeetingError {
    /// The meeting's ledger could not be opened.
    #[error("ledger: {0}")]
    Ledger(std::io::Error),
    /// The meeting's chunks could not be fetched.
    #[error(transparent)]
    Collect(#[from] CollectError),
    /// Building the minutes failed.
    #[error(transparent)]
    Minutes(#[from] MinutesError),
    /// Storing the mixed audio failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The minutes bucket refused or failed (hold, scripts).
    #[error("minutes bucket: {0}")]
    Gcs(#[from] GcsError),
    /// The lock or the script file failed.
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// A script could not be read.
    #[error("scripts: {0}")]
    Scripts(String),
    /// Another worker took the meeting over (the hold expired) before
    /// something was written; nothing more is written.
    #[error("the hold on the meeting was lost; nothing more written")]
    HoldLost,
}

impl MeetingError {
    /// Whether the whole run should stop, not just this meeting: the
    /// transcriber refused credentials or quota, or Cloud Storage refused
    /// credentials, permission or quota — later meetings would fail the
    /// same way.
    pub fn stops_the_run(&self) -> bool {
        let refused = |kind: GcsErrorKind| {
            matches!(
                kind,
                GcsErrorKind::Auth | GcsErrorKind::Permission | GcsErrorKind::Quota
            )
        };
        match self {
            Self::Minutes(error) => error.stops_the_run(),
            Self::Gcs(error) => refused(error.kind),
            Self::Store(StoreError::Gcs { source, .. })
            | Self::Collect(CollectError::Store(StoreError::Gcs { source, .. })) => {
                refused(source.kind)
            }
            _ => false,
        }
    }
}

/// Per-run choices.
#[derive(Debug, Clone)]
pub struct RunOptions {
    /// Storage prefix of the recordings.
    pub prefix: String,
    /// The current time, UTC ms.
    pub now_unix_ms: u64,
    /// A meeting is over after this long with nothing written, ms.
    pub quiet_ms: u64,
    /// Replace this meeting's own script.
    pub overwrite: bool,
}

/// Process one meeting (see the module docs).
pub async fn run_meeting<H, S, D, T>(
    home: &H,
    store: &S,
    meeting: &MeetingPlan,
    detector: &mut D,
    stt: &T,
    settings: &MinutesSettings,
    options: &RunOptions,
) -> Result<Done, MeetingError>
where
    H: MinutesHome,
    S: RecordingStore,
    D: SpeechDetector,
    T: SpeechToText,
{
    run_meeting_with(home, store, meeting, detector, stt, settings, options, None).await
}

/// [`run_meeting`], then — still holding the meeting — the summary and the
/// Notion page (see [`crate::followup`]). A meeting whose own script is
/// already there gets only what is missing after it.
#[allow(clippy::too_many_arguments)]
pub async fn run_meeting_with<H, S, D, T>(
    home: &H,
    store: &S,
    meeting: &MeetingPlan,
    detector: &mut D,
    stt: &T,
    settings: &MinutesSettings,
    options: &RunOptions,
    follow: Option<&mut FollowUps<'_>>,
) -> Result<Done, MeetingError>
where
    H: MinutesHome,
    S: RecordingStore,
    D: SpeechDetector,
    T: SpeechToText,
{
    let Some(hold) = home.hold(meeting).await? else {
        return Ok(Done::Locked);
    };
    let done = run_held(
        home, &hold, store, meeting, detector, stt, settings, options, follow,
    )
    .await;
    // Let go whatever happened; a failure to let go is reported only when
    // the meeting itself went well.
    let released = home.release(hold).await;
    let done = done?;
    released?;
    Ok(done)
}

#[allow(clippy::too_many_arguments)]
async fn run_held<H, S, D, T>(
    home: &H,
    hold: &H::Hold,
    store: &S,
    meeting: &MeetingPlan,
    detector: &mut D,
    stt: &T,
    settings: &MinutesSettings,
    options: &RunOptions,
    follow: Option<&mut FollowUps<'_>>,
) -> Result<Done, MeetingError>
where
    H: MinutesHome,
    S: RecordingStore,
    D: SpeechDetector,
    T: SpeechToText,
{
    // Checked while holding the meeting: a worker that finished just
    // before us wrote its script before letting go.
    let own = home.script_name(meeting);
    let scripts = home.scripts(meeting).await?;
    let own_sha = scripts
        .iter()
        .find(|script| script.name == own)
        .map(|script| script.sha256.clone());
    let processed: HashSet<Uuid> = scripts
        .iter()
        .filter(|script| !(options.overwrite && script.name == own))
        .flat_map(|script| script.session_ids.iter().copied())
        .collect();
    if let Some(skip) = meeting.skip_reason(&processed, options.now_unix_ms, options.quiet_ms) {
        // This very meeting's script is there: only what comes after it
        // (summary, Notion page) may be left. The script itself is read
        // only if a step needs it.
        let only_follow_up = skip == Skip::AlreadyProcessed && !options.overwrite;
        if let (true, Some(sha), Some(steps)) = (only_follow_up, own_sha, follow) {
            let followed = follow_up_held(home, hold, meeting, &sha, None, steps).await;
            if followed.nothing_left() {
                return Ok(Done::Skipped(skip));
            }
            return Ok(Done::FollowedUp(followed));
        }
        return Ok(Done::Skipped(skip));
    }

    let mut ledger = home
        .open_ledger(meeting)
        .await
        .map_err(MeetingError::Ledger)?;
    let loaded = meeting.load(store).await?;
    let mut settings = settings.clone();
    settings.audio_key = mixed_audio_key(&options.prefix, &loaded);
    settings.now_unix_ms = options.now_unix_ms;
    let mut output = build_minutes(&loaded, detector, stt, &mut ledger, &settings).await?;

    let audio = store
        .put_new(&settings.audio_key, std::mem::take(&mut output.mixed_audio))
        .await?;
    let json = serde_json::to_vec_pretty(&output.transcript).map_err(std::io::Error::other)?;
    let sha = sha256_hex(&json);
    let script = home.write_script(meeting, json, options.overwrite).await?;
    // What comes after never takes the script and its report away: its
    // failures are steps in `follow`.
    let follow = match follow {
        Some(steps) => {
            Some(follow_up_held(home, hold, meeting, &sha, Some(&output.transcript), steps).await)
        }
        None => None,
    };
    Ok(Done::Written {
        output: Box::new(output),
        script,
        audio,
        follow,
    })
}

/// Create `dir` (and missing parents) readable by its owner only (0700).
/// An existing folder is left as it is.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn open_private(path: &Path, truncate: bool) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Write a file readable by its owner only (0600), atomically.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let partial = path.with_extension("partial");
    let mut file = open_private(&partial, true)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&partial, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A listing reads only the sessions: `/1`, `/2` and a script whose
    /// lines it cannot make sense of all list.
    #[test]
    fn scripts_of_every_format_list() {
        let session = Uuid::from_u128(3);
        let scripts = [
            serde_json::json!({
                "format": "huddle-transcript/1",
                "session_ids": [session],
                "segments": [{ "start_ms": 1, "end_ms": 2, "speaker": "ab", "text": "네" }]
            }),
            serde_json::json!({
                "format": "huddle-transcript/2",
                "session_ids": [session],
                "segments": [{
                    "start_ms": 1, "end_ms": 2, "device": "ab", "speaker": null,
                    "speaker_label": "회의실 화자 1", "speaker_confidence": null, "text": "네"
                }]
            }),
            serde_json::json!({
                "format": "huddle-transcript/9",
                "session_ids": [session],
                "segments": [{ "something": "else" }]
            }),
        ];
        for script in scripts {
            let bytes = serde_json::to_vec(&script).unwrap();
            let info = script_info("s.json".into(), &bytes).unwrap();
            assert_eq!(info.session_ids, vec![session], "{script}");
            assert_eq!(info.sha256, sha256_hex(&bytes));
        }
        assert!(script_info("s.json".into(), b"{}").is_err());
    }
}
