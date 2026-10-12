//! Process one meeting into a local output folder, safely against another
//! worker doing the same meeting at the same time.
//!
//! Order: lock the meeting → check (under the lock) that no script already
//! covers it → open its ledger → transcribe → write the mixed audio and the
//! script. The lock is an OS advisory lock on `<first session>.lock`
//! (`flock`), so a crashed worker never leaves the meeting locked. A meeting
//! that is locked is skipped and counted; the next run picks it up.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use uuid::Uuid;

use crate::collect::{Meeting, Skip};
use crate::ledger::SttLedger;
use crate::pipeline::{
    build_minutes, mixed_audio_key, MinutesError, MinutesOutput, MinutesSettings,
};
use crate::store::{RecordingStore, StoreError};
use crate::stt::SpeechToText;
use crate::transcript::Transcript;
use crate::vad::SpeechDetector;

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

    /// Every session id already in a script here, with the script's file
    /// name. An unreadable script is an error: skipping it could process a
    /// meeting twice.
    pub fn processed_sessions(&self) -> Result<Vec<(Uuid, String)>, MeetingError> {
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
}

/// What happened to one meeting.
#[derive(Debug)]
pub enum Done {
    /// Script and mixed audio written.
    Written {
        /// The run's output (mixed audio already stored).
        output: Box<MinutesOutput>,
        /// Where the script went.
        transcript_path: PathBuf,
    },
    /// Left alone this run.
    Skipped(Skip),
    /// Another worker holds the meeting's lock.
    Locked,
}

/// Why one meeting failed. Other meetings go on.
#[derive(Debug, thiserror::Error)]
pub enum MeetingError {
    /// The meeting's ledger could not be opened.
    #[error("ledger: {0}")]
    Ledger(std::io::Error),
    /// Building the minutes failed.
    #[error(transparent)]
    Minutes(#[from] MinutesError),
    /// Storing the mixed audio failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The lock or the script file failed.
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// A script in the output folder could not be read.
    #[error("scripts in the output folder: {0}")]
    Scripts(String),
}

impl MeetingError {
    /// Whether the whole run should stop, not just this meeting.
    pub fn stops_the_run(&self) -> bool {
        matches!(self, Self::Minutes(error) if error.stops_the_run())
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
pub async fn run_meeting<S, D, T>(
    minutes: &LocalMinutes,
    store: &S,
    meeting: &Meeting,
    detector: &mut D,
    stt: &T,
    settings: &MinutesSettings,
    options: &RunOptions,
) -> Result<Done, MeetingError>
where
    S: RecordingStore,
    D: SpeechDetector,
    T: SpeechToText,
{
    let first = meeting
        .sessions
        .first()
        .map(|session| session.session_id)
        .unwrap_or_default();

    let lock = open_private(&minutes.lock_path(first), false)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == fs2::lock_contended_error().kind() => {
            return Ok(Done::Locked)
        }
        Err(error) => return Err(MeetingError::Io(error)),
    }

    // Checked under the lock: a worker that finished just before us wrote
    // its script before letting go.
    let transcript_path = minutes.transcript_path(first);
    let own_name = transcript_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let processed: HashSet<Uuid> = minutes
        .processed_sessions()?
        .into_iter()
        .filter(|(_, file)| !(options.overwrite && *file == own_name))
        .map(|(session, _)| session)
        .collect();
    if let Some(skip) = meeting.skip_reason(&processed, options.now_unix_ms, options.quiet_ms) {
        return Ok(Done::Skipped(skip));
    }

    let mut ledger = SttLedger::open(&minutes.ledger_path(first)).map_err(MeetingError::Ledger)?;
    let mut settings = settings.clone();
    settings.audio_key = mixed_audio_key(&options.prefix, meeting);
    settings.now_unix_ms = options.now_unix_ms;
    let mut output = build_minutes(meeting, detector, stt, &mut ledger, &settings).await?;

    store
        .put(&settings.audio_key, std::mem::take(&mut output.mixed_audio))
        .await?;
    let json = serde_json::to_vec_pretty(&output.transcript).map_err(std::io::Error::other)?;
    write_private(&transcript_path, &json)?;
    drop(lock);
    Ok(Done::Written {
        output: Box::new(output),
        transcript_path,
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
