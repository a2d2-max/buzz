//! After the script: the summary (Gemini) and the Notion page, done while
//! the worker still holds the meeting.
//!
//! Each step is done once. A summary already stored for this script is not
//! asked for again (it costs money); a Notion page whose record says it was
//! written to the end is not written again. A step that fails is left for
//! the next run, which does only what is missing. With the summary on, the
//! Notion page waits for it.
//!
//! Who said what is shown through [`DisplayNames`]: today pubkey prefixes;
//! a map that also knows a diarized `speaker_label` can take its place
//! without touching this flow.

use buzz_gcp::token::Tokens;

use crate::collect::MeetingPlan;
use crate::notion::{
    self, MeetingKind, MeetingPage, NotionClient, NotionRecord, ProcessingStatus,
    PublishMeetingError, PublishReport,
};
use crate::runner::{MeetingError, MinutesHome};
use crate::summary::{self, DisplayNames, GeminiSettings, Summary};
use crate::transcript::Transcript;

/// How to ask Gemini for the summary.
pub struct SummaryStep<'a> {
    /// HTTP client (with a time limit).
    pub http: &'a reqwest::Client,
    /// Model, project, retries.
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

/// What to do after the script. A step left `None` is off.
pub struct FollowUps<'a> {
    /// The summary.
    pub summary: Option<SummaryStep<'a>>,
    /// The Notion page.
    pub notion: Option<NotionStep<'a>>,
    /// pubkey → name, for the summary and the page.
    pub names: &'a dyn DisplayNames,
}

/// What happened to one step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Not asked for.
    Off,
    /// Done on an earlier run; nothing sent.
    AlreadyDone,
    /// Done now.
    Done,
    /// The Notion page waits for the summary (it failed this run).
    Waiting,
    /// Failed now; the next run tries again. The error, codes only.
    Failed(String),
}

/// The two steps after the script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FollowedUp {
    /// The summary.
    pub summary: Step,
    /// The Notion page.
    pub notion: Step,
}

impl FollowedUp {
    /// A step failed (or waits): the next run has something to do.
    pub fn left_for_next_run(&self) -> bool {
        [&self.summary, &self.notion]
            .iter()
            .any(|step| matches!(step, Step::Failed(_) | Step::Waiting))
    }

    /// A step failed this run.
    pub fn has_failure(&self) -> bool {
        [&self.summary, &self.notion]
            .iter()
            .any(|step| matches!(step, Step::Failed(_)))
    }

    /// Nothing was done or tried this run.
    pub fn nothing_left(&self) -> bool {
        [&self.summary, &self.notion]
            .iter()
            .all(|step| matches!(step, Step::Off | Step::AlreadyDone))
    }
}

fn io(error: serde_json::Error) -> MeetingError {
    MeetingError::Io(std::io::Error::other(error))
}

/// The summary and the Notion page of `meeting`, whose script is
/// `transcript`. Call it while holding the meeting. `fresh` means the script
/// was written just now: earlier results belong to an older script and are
/// done again. Steps that fail are reported, not returned as errors; an
/// error is the minutes home failing.
pub async fn follow_up_held<H: MinutesHome>(
    home: &H,
    meeting: &MeetingPlan,
    transcript: &Transcript,
    fresh: bool,
    steps: &mut FollowUps<'_>,
) -> Result<FollowedUp, MeetingError> {
    let mut made: Option<Summary> = None;
    let summary_step = match &steps.summary {
        None => Step::Off,
        Some(step) => {
            let stored = if fresh {
                None
            } else {
                home.read_summary(meeting)
                    .await?
                    .and_then(|bytes| serde_json::from_slice::<Summary>(&bytes).ok())
                    // A summary of another version of the script is not this one's.
                    .filter(|stored| stored.huddle_id == summary::huddle_id(transcript))
            };
            match stored {
                Some(stored) => {
                    made = Some(stored);
                    Step::AlreadyDone
                }
                None => match summary::summarize(
                    step.http,
                    step.settings,
                    step.tokens,
                    transcript,
                    steps.names,
                )
                .await
                {
                    Ok(summary) => {
                        let json = serde_json::to_vec_pretty(&summary).map_err(io)?;
                        home.write_summary(meeting, json).await?;
                        made = Some(summary);
                        Step::Done
                    }
                    Err(error) => Step::Failed(error.to_string()),
                },
            }
        }
    };

    let notion_step = match steps.notion.as_mut() {
        None => Step::Off,
        Some(_) if steps.summary.is_some() && made.is_none() => Step::Waiting,
        Some(step) => {
            let done = !fresh
                && home
                    .read_notion_record(meeting)
                    .await?
                    .and_then(|bytes| serde_json::from_slice::<NotionRecord>(&bytes).ok())
                    .is_some_and(|record| record.done);
            if done {
                Step::AlreadyDone
            } else {
                let page = MeetingPage {
                    transcript,
                    summary: made.as_ref(),
                    names: steps.names,
                    title_prefix: &step.title_prefix,
                    channel_label: step.channel_label.as_deref(),
                    kind: step.kind,
                    status: ProcessingStatus::Done,
                };
                let mut report = PublishReport::default();
                match notion::publish_held(home, meeting, &mut step.client, &page, &mut report)
                    .await
                {
                    Ok(()) => Step::Done,
                    Err(PublishMeetingError::Home(error)) => return Err(error),
                    // Marked "실패" on the page (or found by notion-stale).
                    Err(PublishMeetingError::Notion(error)) => Step::Failed(error.to_string()),
                }
            }
        }
    };
    Ok(FollowedUp {
        summary: summary_step,
        notion: notion_step,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use buzz_gcp::token::{AccessToken, TokenSource};
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::notion::tests::{
        fake_notion, minutes_pages, plan_for, settings_for as notion_settings, FakeNotion,
    };
    use crate::notion::{minutes_property, NotionSettings};
    use crate::pipeline::{MinutesSettings, SttPolicy};
    use crate::runner::{run_meeting, run_meeting_with, Done, LocalMinutes, RunOptions};
    use crate::store::LocalStore;
    use crate::stt::{SpeechToText, SttError, SttOutput, SttRequest};
    use crate::summary::tests::{answer, gemini_reply, settings_for as gemini_settings};
    use crate::summary::PubkeyPrefixNames;
    use crate::test_http::{transcript_with, FakeServer, Reply};
    use crate::transcript::SttInfo;
    use crate::vad::{SegmentPlan, SpeechDetector, SpeechSpan, VadError};

    const A: &str = "aaaaaaaa00000000000000000000000000000000000000000000000000000001";

    fn script() -> Transcript {
        transcript_with(&[
            (1_000, A, "견적서 얘기해요."),
            (5_000, A, "금요일까지 보낼게요."),
        ])
    }

    /// A fake Gemini that answers well, or refuses (HTTP 400) while
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

    struct World {
        _dir: tempfile::TempDir,
        home: LocalMinutes,
        meeting: MeetingPlan,
        gemini: FakeServer,
        refuse: Arc<AtomicBool>,
        notion: FakeServer,
        state: Arc<std::sync::Mutex<FakeNotion>>,
        http: reqwest::Client,
        gemini_settings: GeminiSettings,
        notion_settings: NotionSettings,
        tokens: Tokens,
    }

    async fn world() -> World {
        let dir = tempfile::tempdir().unwrap();
        let meeting = plan_for(&dir.path().join("recordings")).await;
        let home = LocalMinutes::open(&dir.path().join("minutes")).unwrap();
        let refuse = Arc::new(AtomicBool::new(false));
        let gemini = gemini(refuse.clone()).await;
        let (notion, state) = fake_notion(FakeNotion::default()).await;
        World {
            gemini_settings: gemini_settings(&gemini),
            notion_settings: notion_settings(&notion),
            _dir: dir,
            home,
            meeting,
            gemini,
            refuse,
            notion,
            state,
            http: reqwest::Client::new(),
            tokens: Tokens::new(TokenSource::Static(AccessToken::new("t"))).unwrap(),
        }
    }

    impl World {
        fn steps(&self) -> FollowUps<'_> {
            FollowUps {
                summary: Some(SummaryStep {
                    http: &self.http,
                    settings: &self.gemini_settings,
                    tokens: &self.tokens,
                }),
                notion: Some(NotionStep {
                    client: NotionClient::new(&self.http, &self.notion_settings, "t").unwrap(),
                    title_prefix: String::new(),
                    channel_label: None,
                    kind: None,
                }),
                names: &PubkeyPrefixNames,
            }
        }

        async fn follow(&self, fresh: bool) -> FollowedUp {
            follow_up_held(
                &self.home,
                &self.meeting,
                &script(),
                fresh,
                &mut self.steps(),
            )
            .await
            .unwrap()
        }

        fn record(&self) -> Option<NotionRecord> {
            std::fs::read(self.home.notion_record_path(Uuid::from_u128(3)))
                .ok()
                .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        }

        fn page_status(&self) -> String {
            let state = self.state.lock().unwrap();
            let pages = minutes_pages(&state);
            assert_eq!(pages.len(), 1, "one page for the meeting");
            pages[0].properties[minutes_property::STATUS]["select"]["name"]
                .as_str()
                .unwrap()
                .to_string()
        }
    }

    fn followed(summary: Step, notion: Step) -> FollowedUp {
        FollowedUp { summary, notion }
    }

    /// Script → summary → Notion page once; the next run sends nothing.
    #[tokio::test]
    async fn summary_then_notion_once() {
        let world = world().await;
        assert_eq!(world.follow(true).await, followed(Step::Done, Step::Done));
        assert!(world.home.summary_path(Uuid::from_u128(3)).exists());
        assert!(world.record().unwrap().done);
        assert_eq!(world.page_status(), "완료");

        let (gemini, notion) = (world.gemini.requests().len(), world.notion.requests().len());
        let again = world.follow(false).await;
        assert_eq!(again, followed(Step::AlreadyDone, Step::AlreadyDone));
        assert!(again.nothing_left());
        assert_eq!(
            world.gemini.requests().len(),
            gemini,
            "summary not paid twice"
        );
        assert_eq!(world.notion.requests().len(), notion);

        // A script written again (--overwrite) gets a new summary and page.
        assert_eq!(world.follow(true).await, followed(Step::Done, Step::Done));
        assert_eq!(world.gemini.requests().len(), gemini + 1);
    }

    /// A failed summary leaves no summary and the page waits; the next run
    /// asks for the summary again (once), then writes the page.
    #[tokio::test]
    async fn a_failed_summary_is_tried_again_and_the_page_waits() {
        let world = world().await;
        world.refuse.store(true, Ordering::SeqCst);
        let first = world.follow(true).await;
        assert!(matches!(first.summary, Step::Failed(_)), "{first:?}");
        assert_eq!(first.notion, Step::Waiting);
        assert!(first.left_for_next_run());
        assert!(!world.home.summary_path(Uuid::from_u128(3)).exists());
        assert!(world.notion.requests().is_empty(), "no page yet");

        world.refuse.store(false, Ordering::SeqCst);
        let before = world.gemini.requests().len();
        assert_eq!(world.follow(false).await, followed(Step::Done, Step::Done));
        assert_eq!(world.gemini.requests().len() - before, 1);
        assert_eq!(world.page_status(), "완료");
    }

    /// A failed Notion page is marked "실패" and recorded as not done; the
    /// next run writes that same page again without asking for the summary.
    #[tokio::test]
    async fn a_failed_notion_page_is_tried_again_alone() {
        let world = world().await;
        world.state.lock().unwrap().append_failures = vec![Reply::json(
            400,
            &json!({ "code": "validation_error", "message": "refused" }),
        )];
        let first = world.follow(true).await;
        assert_eq!(first.summary, Step::Done);
        assert!(matches!(first.notion, Step::Failed(_)), "{first:?}");
        let record = world.record().unwrap();
        assert!(!record.done);
        assert_eq!(world.page_status(), "실패");

        let gemini = world.gemini.requests().len();
        assert_eq!(
            world.follow(false).await,
            followed(Step::AlreadyDone, Step::Done)
        );
        assert_eq!(world.gemini.requests().len(), gemini, "summary kept");
        assert_eq!(world.record().unwrap().page_id, record.page_id, "same page");
        assert_eq!(world.page_status(), "완료");
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

    /// A meeting whose own script is there: the runner does only the steps
    /// after it, transcribing nothing; with nothing left (or no steps) it is
    /// skipped as before.
    #[tokio::test]
    async fn the_runner_does_only_what_is_left_after_the_script() {
        let world = world().await;
        let mut transcript = script();
        transcript.session_ids = vec![Uuid::from_u128(3)];
        std::fs::write(
            world.home.transcript_path(Uuid::from_u128(3)),
            serde_json::to_vec(&transcript).unwrap(),
        )
        .unwrap();
        let store = LocalStore::new(world._dir.path().join("recordings"));
        let settings = MinutesSettings {
            segment_plan: SegmentPlan::default(),
            stt: SttPolicy::default(),
            ledger_version: "test".into(),
            audio_key: String::new(),
            now_unix_ms: 0,
        };
        let options = RunOptions {
            prefix: "h".into(),
            now_unix_ms: world.meeting.started_at_unix_ms() + 3_600_000,
            quiet_ms: 0,
            overwrite: false,
        };
        for expected in [Some(followed(Step::Done, Step::Done)), None] {
            let done = run_meeting_with(
                &world.home,
                &store,
                &world.meeting,
                &mut Unused,
                &Unused,
                &settings,
                &options,
                Some(&mut world.steps()),
            )
            .await
            .unwrap();
            match expected {
                Some(expected) => {
                    assert!(
                        matches!(&done, Done::FollowedUp(f) if *f == expected),
                        "{done:?}"
                    )
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
            &settings,
            &options,
        )
        .await
        .unwrap();
        assert!(matches!(done, Done::Skipped(_)), "{done:?}");
    }
}
