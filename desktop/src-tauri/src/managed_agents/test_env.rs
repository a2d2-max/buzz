//! Shared process-env helpers for tests that need a temp `HOME`.
//!
//! Tauri resolves `app_data_dir` from `dirs::data_dir()`, which reads `$HOME`
//! (macOS) / `$XDG_DATA_HOME` (Linux), so a test that wants a mock app to read
//! and write under a tempdir has to override them. Overriding process env is
//! global, hence the crate-wide `lock_path_mutex()` every caller must hold.

/// RAII override of a process env var; restores the prior value on drop so a
/// panicking assertion cannot leak `HOME` into the rest of the suite.
///
/// Holds `OsString` rather than `String` so a pre-existing non-Unicode value is
/// restored exactly.
pub(crate) struct EnvVarGuard {
    key: String,
    prior: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    /// Caller must hold `crate::managed_agents::lock_path_mutex()`.
    pub(crate) fn set(key: &str, value: &std::path::Path) -> Self {
        let prior = std::env::var_os(key);
        // SAFETY: the caller holds the crate-wide process-env lock.
        #[allow(deprecated)]
        unsafe {
            std::env::set_var(key, value)
        };
        Self {
            key: key.to_string(),
            prior,
        }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        #[allow(deprecated)]
        // SAFETY: the caller holds the crate-wide process-env lock.
        unsafe {
            match &self.prior {
                Some(value) => std::env::set_var(&self.key, value),
                None => std::env::remove_var(&self.key),
            }
        }
    }
}

/// Point `HOME` and `XDG_DATA_HOME` at a fresh directory under `temp` and
/// return the guards that restore them.
///
/// Caller must hold `crate::managed_agents::lock_path_mutex()` for the whole
/// lifetime of the returned guards.
pub(crate) fn scoped_home(temp: &std::path::Path) -> (EnvVarGuard, EnvVarGuard) {
    let home = temp.join("home");
    std::fs::create_dir_all(&home).expect("temp home dir");
    (
        EnvVarGuard::set("HOME", &home),
        EnvVarGuard::set("XDG_DATA_HOME", &home),
    )
}
