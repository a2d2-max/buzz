//! Scripts, ledgers and holds in the minutes bucket
//! (`gs://a2d2-huddle-minutes`; never the recording bucket):
//!
//! ```text
//! transcripts/{community}/{channel}/{first session}.json   the script
//! ledger/{community}/{channel}/{first session}/lease       who holds the meeting, until when
//! ledger/…/pieces/{key}                                    one finished piece (one ledger line)
//! ledger/…/runs/{n}                                        run n went through transcription
//! ledger/…/bundles/{n}.jsonl                               every outcome known after run n
//! ```
//!
//! Ledger objects are written only with `ifGenerationMatch=0`, so nothing
//! in `ledger/` is ever overwritten; a piece written twice keeps its first
//! answer. `{key}` is the piece key, itself a sha256, so no pubkey shows in
//! any name. Opening a ledger reads the newest bundle and only the pieces
//! written after it. The bucket deletes `ledger/` after 30 days.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use buzz_gcp::gcs::{Gcs, GcsError, GcsErrorKind, Write};
use buzz_huddle_recording::format_utc_millis;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::collect::MeetingPlan;
use crate::ledger::{outcome_line, parse_lines, run_line, Ledger, Outcome};
use crate::runner::{MeetingError, MinutesHome};
use crate::transcript::Transcript;

/// How long a hold lasts. A worker that dies leaves the meeting held this
/// long at most; processing a meeting takes minutes.
pub const LEASE_MS: u64 = 2 * 60 * 60 * 1_000;

/// Value of the lease's `format`.
pub const LEASE_FORMAT: &str = "huddle-minutes-lease/1";

const JSON: &str = "application/json";
/// Largest lease read.
const MAX_LEASE: u64 = 4 * 1024;
/// Largest script, bundle or piece read.
const MAX_READ: u64 = 64 * 1024 * 1024;

/// The minutes bucket as a [`MinutesHome`].
#[derive(Debug, Clone)]
pub struct GcsMinutes {
    gcs: Arc<Gcs>,
    bucket: String,
    clock: fn() -> u64,
}

impl GcsMinutes {
    /// `bucket` through `gcs`; holds use the system clock.
    pub fn new(gcs: Arc<Gcs>, bucket: impl Into<String>) -> Self {
        Self {
            gcs,
            bucket: bucket.into(),
            clock: system_now_ms,
        }
    }

    /// The same with another clock for holds, UTC ms (tests).
    pub fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = clock;
        self
    }

    /// Where a meeting's ledger objects live (ends with `/`).
    pub fn ledger_prefix(meeting: &MeetingPlan) -> String {
        format!(
            "ledger/{}/{}/{}/",
            meeting.community_id,
            meeting.channel_id,
            meeting.first_session_id()
        )
    }

    /// Where a meeting's script lives.
    pub fn script_key(meeting: &MeetingPlan) -> String {
        format!(
            "transcripts/{}/{}/{}.json",
            meeting.community_id,
            meeting.channel_id,
            meeting.first_session_id()
        )
    }

    fn lease_key(meeting: &MeetingPlan) -> String {
        format!("{}lease", Self::ledger_prefix(meeting))
    }

    /// Create the lease; `None` when it is already there.
    async fn create_lease(&self, name: &str) -> Result<Option<GcsHold>, GcsError> {
        let lease = Lease {
            format: LEASE_FORMAT.to_string(),
            holder: Uuid::new_v4(),
            expires_at: format_utc_millis((self.clock)() + LEASE_MS),
            expires_at_unix_ms: (self.clock)() + LEASE_MS,
        };
        let body = serde_json::to_vec(&lease).unwrap_or_default();
        match self
            .gcs
            .put(&self.bucket, name, body, JSON, Write::IfAbsent)
            .await
        {
            Ok(object) => Ok(Some(GcsHold {
                name: name.to_string(),
                generation: object.generation,
            })),
            Err(error) if error.kind == GcsErrorKind::AlreadyExists => Ok(None),
            Err(error) => Err(error),
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

#[derive(Serialize, Deserialize)]
struct Lease {
    format: String,
    holder: Uuid,
    expires_at: String,
    expires_at_unix_ms: u64,
}

/// A lease this worker created: its name and generation.
#[derive(Debug)]
pub struct GcsHold {
    name: String,
    generation: u64,
}

impl MinutesHome for GcsMinutes {
    type Ledger = GcsLedger;
    type Hold = GcsHold;

    async fn hold(&self, meeting: &MeetingPlan) -> Result<Option<GcsHold>, MeetingError> {
        let name = Self::lease_key(meeting);
        if let Some(hold) = self.create_lease(&name).await? {
            return Ok(Some(hold));
        }
        // Held, or left by a worker that died: take it over only once it
        // has expired, and only that very generation of it.
        let existing = match self.gcs.stat(&self.bucket, &name).await {
            Ok(existing) => existing,
            // Let go of just now: the next run takes it.
            Err(error) if error.kind == GcsErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let expires = match self
            .gcs
            .get_generation(&self.bucket, &name, existing.generation, MAX_LEASE)
            .await
        {
            Ok(bytes) => serde_json::from_slice::<Lease>(&bytes)
                .map(|lease| lease.expires_at_unix_ms)
                // An unreadable lease cannot be honoured.
                .unwrap_or(0),
            // Written again just now: someone holds it.
            Err(error) if error.kind == GcsErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if expires > (self.clock)() {
            return Ok(None);
        }
        match self
            .gcs
            .delete_if_generation(&self.bucket, &name, existing.generation)
            .await
        {
            Ok(()) => {}
            // Someone else got there first.
            Err(error)
                if matches!(
                    error.kind,
                    GcsErrorKind::NotFound | GcsErrorKind::AlreadyExists
                ) => {}
            Err(error) => return Err(error.into()),
        }
        Ok(self.create_lease(&name).await?)
    }

    async fn release(&self, hold: GcsHold) -> Result<(), MeetingError> {
        match self
            .gcs
            .delete_if_generation(&self.bucket, &hold.name, hold.generation)
            .await
        {
            Ok(()) => Ok(()),
            // Expired and taken over: not ours to delete any more.
            Err(error)
                if matches!(
                    error.kind,
                    GcsErrorKind::NotFound | GcsErrorKind::AlreadyExists
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn processed_sessions(
        &self,
        meeting: &MeetingPlan,
    ) -> Result<Vec<(Uuid, String)>, MeetingError> {
        let prefix = format!(
            "transcripts/{}/{}/",
            meeting.community_id, meeting.channel_id
        );
        let mut processed = Vec::new();
        for object in self.gcs.list(&self.bucket, &prefix).await? {
            let bytes = self.gcs.get(&self.bucket, &object.name, MAX_READ).await?;
            let transcript: Transcript = serde_json::from_slice(&bytes)
                .map_err(|e| MeetingError::Scripts(format!("{}: {e}", object.name)))?;
            for session in transcript.session_ids {
                processed.push((session, object.name.clone()));
            }
        }
        Ok(processed)
    }

    fn script_name(&self, meeting: &MeetingPlan) -> String {
        Self::script_key(meeting)
    }

    async fn open_ledger(&self, meeting: &MeetingPlan) -> std::io::Result<GcsLedger> {
        GcsLedger::open(
            self.gcs.clone(),
            self.bucket.clone(),
            Self::ledger_prefix(meeting),
        )
        .await
    }

    async fn write_script(
        &self,
        meeting: &MeetingPlan,
        json: Vec<u8>,
        overwrite: bool,
    ) -> Result<String, MeetingError> {
        let key = Self::script_key(meeting);
        let write = if overwrite {
            Write::Overwrite
        } else {
            Write::IfAbsent
        };
        self.gcs.put(&self.bucket, &key, json, JSON, write).await?;
        Ok(format!("gs://{}/{key}", self.bucket))
    }
}

/// One meeting's ledger in the minutes bucket (see the module docs).
#[derive(Debug)]
pub struct GcsLedger {
    gcs: Arc<Gcs>,
    bucket: String,
    prefix: String,
    outcomes: HashMap<String, Outcome>,
    runs: u32,
    unreadable: u64,
}

fn io(error: GcsError) -> std::io::Error {
    std::io::Error::other(error)
}

impl GcsLedger {
    /// Read the ledger under `prefix`: the newest bundle, then every piece
    /// written after it. An object that cannot be read is skipped and
    /// counted.
    pub async fn open(gcs: Arc<Gcs>, bucket: String, prefix: String) -> std::io::Result<Self> {
        let objects = gcs.list(&bucket, &prefix).await.map_err(io)?;
        let mut runs = 0u32;
        let mut newest_bundle: Option<(u32, String)> = None;
        let mut pieces = Vec::new();
        for object in &objects {
            let rest = &object.name[prefix.len()..];
            if let Some(n) = rest.strip_prefix("runs/").and_then(|n| n.parse().ok()) {
                runs = runs.max(n);
            } else if let Some(n) = rest
                .strip_prefix("bundles/")
                .and_then(|n| n.strip_suffix(".jsonl"))
                .and_then(|n| n.parse::<u32>().ok())
            {
                if newest_bundle.as_ref().is_none_or(|(m, _)| n > *m) {
                    newest_bundle = Some((n, object.name.clone()));
                }
            } else if let Some(key) = rest.strip_prefix("pieces/") {
                pieces.push((key.to_string(), object.name.clone()));
            }
        }
        let mut ledger = Self {
            gcs,
            bucket,
            prefix,
            outcomes: HashMap::new(),
            runs,
            unreadable: 0,
        };
        if let Some((_, name)) = newest_bundle {
            let bytes = ledger
                .gcs
                .get(&ledger.bucket, &name, MAX_READ)
                .await
                .map_err(io)?;
            let parsed = parse_lines(&String::from_utf8_lossy(&bytes));
            ledger.outcomes = parsed.outcomes;
            ledger.unreadable += parsed.unreadable_lines;
        }
        for (key, name) in pieces {
            if ledger.outcomes.contains_key(&key) {
                continue;
            }
            let bytes = ledger
                .gcs
                .get(&ledger.bucket, &name, MAX_READ)
                .await
                .map_err(io)?;
            let parsed = parse_lines(&String::from_utf8_lossy(&bytes));
            match parsed.outcomes.into_iter().find(|(k, _)| *k == key) {
                Some((key, outcome)) if parsed.unreadable_lines == 0 => {
                    ledger.outcomes.insert(key, outcome);
                }
                _ => ledger.unreadable += 1,
            }
        }
        Ok(ledger)
    }

    /// Write `name` once; an object already there is left as it is.
    async fn write_once(&self, name: &str, body: String) -> std::io::Result<()> {
        match self
            .gcs
            .put(&self.bucket, name, body.into_bytes(), JSON, Write::IfAbsent)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.kind == GcsErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(io(error)),
        }
    }
}

impl Ledger for GcsLedger {
    fn runs(&self) -> u32 {
        self.runs
    }

    fn unreadable_lines(&self) -> u64 {
        self.unreadable
    }

    fn outcome(&self, key: &str) -> Option<&Outcome> {
        self.outcomes.get(key)
    }

    async fn record(&mut self, key: &str, outcome: Outcome) -> std::io::Result<()> {
        let name = format!("{}pieces/{key}", self.prefix);
        self.write_once(&name, outcome_line(key, &outcome)).await?;
        self.outcomes.insert(key.to_string(), outcome);
        Ok(())
    }

    async fn finish_run(&mut self, number: u32) -> std::io::Result<()> {
        // The bundle first: a run counts only once its bundle is there.
        let mut keys: Vec<&String> = self.outcomes.keys().collect();
        keys.sort();
        let mut bundle = String::new();
        for key in keys {
            bundle.push_str(&outcome_line(key, &self.outcomes[key]));
            bundle.push('\n');
        }
        bundle.push_str(&run_line(number));
        bundle.push('\n');
        let name = format!("{}bundles/{number}.jsonl", self.prefix);
        self.write_once(&name, bundle).await?;
        let name = format!("{}runs/{number}", self.prefix);
        self.write_once(&name, run_line(number)).await?;
        self.runs = self.runs.max(number);
        Ok(())
    }
}
