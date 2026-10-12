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
use crate::ledger::{Ledger, SttLedger};
use crate::pipeline::{
    build_minutes, mixed_audio_key, MinutesError, MinutesOutput, MinutesSettings,
};
use crate::store::{RecordingStore, StoreError};
use crate::stt::SpeechToText;
use crate::transcript::Transcript;
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
    /// Every session id already in a script of this meeting's channel,
    /// with the script's name. An unreadable script is an error: skipping
    /// it could process a meeting twice.
    fn processed_sessions(
        &self,
        meeting: &MeetingPlan,
    ) -> impl Future<Output = Result<Vec<(Uuid, String)>, MeetingError>>;
    /// Name of this meeting's script, as [`processed_sessions`] gives it.
    ///
    /// [`processed_sessions`]: MinutesHome::processed_sessions
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

    async fn processed_sessions(
        &self,
        _meeting: &MeetingPlan,
    ) -> Result<Vec<(Uuid, String)>, MeetingError> {
        let scripts = |error: &dyn std::fmt::Display| MeetingError::Scripts(error.to_string());
        let mut processed = Vec::new();
        for entry in std::fs::read_dir(&self.dir).map_err(|e| scripts(&e))? {
            let entry = entry.map_err(|e| scripts(&e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".transcript.json") {
                continue;
            }
            let bytes = std::fs::read(entry.path()).map_err(|e| scripts(&e))?;
            let transcript: Transcript =
                serde_json::from_slice(&bytes).map_err(|e| scripts(&format!("{name}: {e}")))?;
            for session in transcript.session_ids {
                processed.push((session, name.clone()));
            }
        }
        Ok(processed)
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
    },
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
    let Some(hold) = home.hold(meeting).await? else {
        return Ok(Done::Locked);
    };
    let done = run_held(home, store, meeting, detector, stt, settings, options).await;
    // Let go whatever happened; a failure to let go is reported only when
    // the meeting itself went well.
    let released = home.release(hold).await;
    let done = done?;
    released?;
    Ok(done)
}

async fn run_held<H, S, D, T>(
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
    // Checked while holding the meeting: a worker that finished just
    // before us wrote its script before letting go.
    let own = home.script_name(meeting);
    let processed: HashSet<Uuid> = home
        .processed_sessions(meeting)
        .await?
        .into_iter()
        .filter(|(_, script)| !(options.overwrite && *script == own))
        .map(|(session, _)| session)
        .collect();
    if let Some(skip) = meeting.skip_reason(&processed, options.now_unix_ms, options.quiet_ms) {
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

    store
        .put(&settings.audio_key, std::mem::take(&mut output.mixed_audio))
        .await?;
    let json = serde_json::to_vec_pretty(&output.transcript).map_err(std::io::Error::other)?;
    let script = home.write_script(meeting, json, options.overwrite).await?;
    Ok(Done::Written {
        output: Box::new(output),
        script,
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
