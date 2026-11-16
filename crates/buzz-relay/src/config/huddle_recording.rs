//! Huddle recorder settings (`BUZZ_HUDDLE_RECORDING*`), see
//! `docs/huddle-recording.md`. Kept beside `config.rs` so the recorder's
//! settings and their tests do not grow the shared config file.

use super::ConfigError;

/// Where the huddle recorder stores sessions (`BUZZ_HUDDLE_RECORDING`).
///
/// See `docs/huddle-recording.md`. [`Self::Off`] (the default) means the
/// recorder is never constructed and huddle audio behaves exactly as before.
#[derive(Clone, PartialEq, Eq)]
pub enum HuddleRecordingMode {
    /// No recording.
    Off,
    /// Write objects under a local directory (`BUZZ_HUDDLE_RECORDING_DIR`).
    Local {
        /// Root directory; object keys become relative paths under it.
        dir: std::path::PathBuf,
    },
    /// Write objects to an S3-compatible bucket (GCS via its HMAC interop).
    S3 {
        /// `BUZZ_HUDDLE_RECORDING_BUCKET`.
        bucket: String,
        /// `BUZZ_HUDDLE_RECORDING_ENDPOINT`, e.g. `https://storage.googleapis.com`.
        endpoint: String,
        /// `BUZZ_HUDDLE_RECORDING_REGION` (signing region), default `auto`.
        region: String,
        /// `BUZZ_HUDDLE_RECORDING_ACCESS_KEY`; empty together with the secret
        /// selects the AWS default credential chain.
        access_key: String,
        /// `BUZZ_HUDDLE_RECORDING_SECRET_KEY`. Redacted from `Debug`.
        secret_key: String,
    },
}

impl std::fmt::Debug for HuddleRecordingMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => f.write_str("Off"),
            Self::Local { dir } => f.debug_struct("Local").field("dir", dir).finish(),
            Self::S3 {
                bucket,
                endpoint,
                region,
                access_key,
                ..
            } => f
                .debug_struct("S3")
                .field("bucket", bucket)
                .field("endpoint", endpoint)
                .field("region", region)
                .field(
                    "access_key",
                    &if access_key.is_empty() {
                        "[EMPTY]"
                    } else {
                        "[REDACTED]"
                    },
                )
                .field("secret_key", &"[REDACTED]")
                .finish(),
        }
    }
}

/// Huddle recorder settings (`BUZZ_HUDDLE_RECORDING*`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HuddleRecordingConfig {
    /// Storage backend, or off.
    pub mode: HuddleRecordingMode,
    /// Key prefix inside the bucket/directory (`BUZZ_HUDDLE_RECORDING_PREFIX`).
    pub prefix: String,
    /// Longest span one chunk may cover, in seconds
    /// (`BUZZ_HUDDLE_RECORDING_CHUNK_SECS`).
    pub chunk_secs: u64,
}

impl HuddleRecordingConfig {
    /// Default key prefix.
    pub const DEFAULT_PREFIX: &'static str = "huddles";
    /// Default chunk span in seconds.
    pub const DEFAULT_CHUNK_SECS: u64 = 30;

    /// Recording disabled.
    pub fn off() -> Self {
        Self {
            mode: HuddleRecordingMode::Off,
            prefix: Self::DEFAULT_PREFIX.to_string(),
            chunk_secs: Self::DEFAULT_CHUNK_SECS,
        }
    }

    /// Parse the `BUZZ_HUDDLE_RECORDING*` variables through `lookup`.
    ///
    /// With the mode unset, empty, or `off`, nothing else is read — a stray
    /// value in another recording variable cannot break a relay that does not
    /// record. Any other mode fails loudly on a missing or malformed setting:
    /// an operator who asked for recording gets it or is told why not.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let var = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let required = |name: &str, mode: &str| {
            var(name).ok_or_else(|| {
                ConfigError::InvalidValue(format!(
                    "{name} is required when BUZZ_HUDDLE_RECORDING={mode}"
                ))
            })
        };
        let mode = match var("BUZZ_HUDDLE_RECORDING")
            .map(|raw| raw.to_ascii_lowercase())
            .as_deref()
        {
            None | Some("off") => return Ok(Self::off()),
            Some("local") => HuddleRecordingMode::Local {
                dir: std::path::PathBuf::from(required("BUZZ_HUDDLE_RECORDING_DIR", "local")?),
            },
            Some("s3") => {
                let access_key = var("BUZZ_HUDDLE_RECORDING_ACCESS_KEY").unwrap_or_default();
                let secret_key = var("BUZZ_HUDDLE_RECORDING_SECRET_KEY").unwrap_or_default();
                if access_key.is_empty() != secret_key.is_empty() {
                    return Err(ConfigError::InvalidValue(
                        "BUZZ_HUDDLE_RECORDING_ACCESS_KEY and BUZZ_HUDDLE_RECORDING_SECRET_KEY must be set together, or both left empty to use the AWS credential chain".to_string(),
                    ));
                }
                HuddleRecordingMode::S3 {
                    bucket: required("BUZZ_HUDDLE_RECORDING_BUCKET", "s3")?,
                    endpoint: required("BUZZ_HUDDLE_RECORDING_ENDPOINT", "s3")?,
                    region: var("BUZZ_HUDDLE_RECORDING_REGION").unwrap_or_else(|| "auto".into()),
                    access_key,
                    secret_key,
                }
            }
            Some(other) => {
                return Err(ConfigError::InvalidValue(format!(
                    "BUZZ_HUDDLE_RECORDING must be off, local, or s3 (got {other:?})"
                )))
            }
        };
        let prefix = match lookup("BUZZ_HUDDLE_RECORDING_PREFIX") {
            None => Self::DEFAULT_PREFIX.to_string(),
            Some(raw) => {
                // Every `/`-separated segment must be a plain name: no empty
                // segment (so no leading, trailing or doubled `/`), no `.` or
                // `..`, no `\`. Keys then stay inside the bucket prefix and,
                // in local mode, inside the recording directory.
                let prefix = raw.trim();
                let plain = prefix.split('/').all(|segment| {
                    !segment.trim().is_empty()
                        && segment != "."
                        && segment != ".."
                        && !segment.contains('\\')
                });
                if !plain {
                    return Err(ConfigError::InvalidValue(format!(
                        "BUZZ_HUDDLE_RECORDING_PREFIX must be '/'-separated names with no empty, '.', '..' or '\\' segments (got {prefix:?})"
                    )));
                }
                prefix.to_string()
            }
        };
        let chunk_secs = match var("BUZZ_HUDDLE_RECORDING_CHUNK_SECS") {
            None => Self::DEFAULT_CHUNK_SECS,
            Some(raw) => raw.parse::<u64>().ok().filter(|v| *v > 0).ok_or_else(|| {
                ConfigError::InvalidValue(
                    "BUZZ_HUDDLE_RECORDING_CHUNK_SECS must be a positive integer".to_string(),
                )
            })?,
        };
        Ok(Self {
            mode,
            prefix,
            chunk_secs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Look up against a fixed set, standing in for process env.
    fn env_of<'a>(set: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + use<'a> {
        move |name| {
            set.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn huddle_recording_defaults_off_and_ignores_other_vars_when_off() {
        assert_eq!(
            HuddleRecordingConfig::from_lookup(env_of(&[])).expect("default"),
            HuddleRecordingConfig::off()
        );
        // A malformed chunk size must not break a relay that does not record.
        for mode in ["off", "OFF", " "] {
            let config = HuddleRecordingConfig::from_lookup(env_of(&[
                ("BUZZ_HUDDLE_RECORDING", mode),
                ("BUZZ_HUDDLE_RECORDING_CHUNK_SECS", "nope"),
            ]))
            .expect("off ignores the rest");
            assert_eq!(config.mode, HuddleRecordingMode::Off, "mode {mode:?}");
        }
    }

    #[test]
    fn huddle_recording_local_requires_a_directory() {
        let config = HuddleRecordingConfig::from_lookup(env_of(&[
            ("BUZZ_HUDDLE_RECORDING", "local"),
            ("BUZZ_HUDDLE_RECORDING_DIR", "/var/huddles"),
        ]))
        .expect("local");
        assert_eq!(
            config,
            HuddleRecordingConfig {
                mode: HuddleRecordingMode::Local {
                    dir: "/var/huddles".into()
                },
                prefix: "huddles".into(),
                chunk_secs: 30,
            }
        );
        let missing =
            HuddleRecordingConfig::from_lookup(env_of(&[("BUZZ_HUDDLE_RECORDING", "local")]));
        assert!(matches!(
            missing,
            Err(ConfigError::InvalidValue(ref m)) if m.contains("BUZZ_HUDDLE_RECORDING_DIR")
        ));
    }

    #[test]
    fn huddle_recording_s3_reads_bucket_endpoint_region_and_keys() {
        let config = HuddleRecordingConfig::from_lookup(env_of(&[
            ("BUZZ_HUDDLE_RECORDING", "s3"),
            ("BUZZ_HUDDLE_RECORDING_BUCKET", "a2d2-huddle-recordings"),
            (
                "BUZZ_HUDDLE_RECORDING_ENDPOINT",
                "https://storage.googleapis.com",
            ),
            ("BUZZ_HUDDLE_RECORDING_ACCESS_KEY", "GOOG-ACCESS"),
            ("BUZZ_HUDDLE_RECORDING_SECRET_KEY", "very-secret"),
            ("BUZZ_HUDDLE_RECORDING_PREFIX", " rec/huddles "),
            ("BUZZ_HUDDLE_RECORDING_CHUNK_SECS", "10"),
        ]))
        .expect("s3");
        assert_eq!(
            config.mode,
            HuddleRecordingMode::S3 {
                bucket: "a2d2-huddle-recordings".into(),
                endpoint: "https://storage.googleapis.com".into(),
                region: "auto".into(),
                access_key: "GOOG-ACCESS".into(),
                secret_key: "very-secret".into(),
            }
        );
        assert_eq!(config.prefix, "rec/huddles");
        assert_eq!(config.chunk_secs, 10);
        let debug = format!("{config:?}");
        assert!(!debug.contains("very-secret"), "secret leaked: {debug}");
        assert!(!debug.contains("GOOG-ACCESS"), "access key leaked: {debug}");
    }

    #[test]
    fn huddle_recording_rejects_half_configured_or_unknown_settings() {
        let base = [
            ("BUZZ_HUDDLE_RECORDING", "s3"),
            ("BUZZ_HUDDLE_RECORDING_BUCKET", "b"),
            ("BUZZ_HUDDLE_RECORDING_ENDPOINT", "https://example.invalid"),
        ];
        let cases: Vec<(Vec<(&str, &str)>, &str)> = vec![
            (
                vec![("BUZZ_HUDDLE_RECORDING", "s3")],
                "BUZZ_HUDDLE_RECORDING_BUCKET",
            ),
            (
                vec![
                    ("BUZZ_HUDDLE_RECORDING", "s3"),
                    ("BUZZ_HUDDLE_RECORDING_BUCKET", "b"),
                ],
                "BUZZ_HUDDLE_RECORDING_ENDPOINT",
            ),
            (
                [
                    base.as_slice(),
                    &[("BUZZ_HUDDLE_RECORDING_ACCESS_KEY", "only")],
                ]
                .concat(),
                "set together",
            ),
            (
                [
                    base.as_slice(),
                    &[("BUZZ_HUDDLE_RECORDING_CHUNK_SECS", "0")],
                ]
                .concat(),
                "BUZZ_HUDDLE_RECORDING_CHUNK_SECS",
            ),
            (
                [base.as_slice(), &[("BUZZ_HUDDLE_RECORDING_PREFIX", "//")]].concat(),
                "BUZZ_HUDDLE_RECORDING_PREFIX",
            ),
            (vec![("BUZZ_HUDDLE_RECORDING", "gcs")], "off, local, or s3"),
        ];
        for (vars, needle) in cases {
            let result = HuddleRecordingConfig::from_lookup(env_of(&vars));
            assert!(
                matches!(result, Err(ConfigError::InvalidValue(ref m)) if m.contains(needle)),
                "{vars:?} should fail mentioning {needle}, got {result:?}"
            );
        }
    }

    /// Every `/`-separated prefix segment must be a plain name.
    #[test]
    fn huddle_recording_prefix_rejects_empty_dot_and_backslash_segments() {
        let with_prefix = |prefix: &'static str| {
            HuddleRecordingConfig::from_lookup(env_of(&[
                ("BUZZ_HUDDLE_RECORDING", "local"),
                ("BUZZ_HUDDLE_RECORDING_DIR", "/var/huddles"),
                ("BUZZ_HUDDLE_RECORDING_PREFIX", prefix),
            ]))
        };
        for accepted in ["huddles", "a2d2/huddles", "rec-1/2026_10"] {
            assert_eq!(
                with_prefix(accepted).map(|c| c.prefix).ok().as_deref(),
                Some(accepted),
                "{accepted:?} must be accepted"
            );
        }
        for rejected in [
            "", " ", "/", "//", "/rec", "rec/", "a//b", "a/ /b", ".", "..", "./a", "a/.", "a/../b",
            "..\\x", "a\\b",
        ] {
            assert!(
                matches!(
                    with_prefix(rejected),
                    Err(ConfigError::InvalidValue(ref m)) if m.contains("BUZZ_HUDDLE_RECORDING_PREFIX")
                ),
                "{rejected:?} must be rejected"
            );
        }
    }
}
