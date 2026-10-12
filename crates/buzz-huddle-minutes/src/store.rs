//! Where recordings live. The worker sees an object store with `/`-separated
//! keys, the same shape the relay writes (`docs/huddle-recording.md`). Only a
//! local-folder implementation exists for now; GCS comes next.

use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use tokio::io::AsyncWriteExt;

/// One stored object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    /// Full object key, `/`-separated.
    pub key: String,
    /// Size in bytes.
    pub size: u64,
    /// Last write time, UTC ms since the Unix epoch.
    pub modified_unix_ms: u64,
}

/// Why a store call failed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The key is not a plain relative path.
    #[error("invalid object key {0:?}")]
    InvalidKey(String),
    /// Reading or writing failed.
    #[error("{op} {key}: {source}")]
    Io {
        /// What was being done.
        op: &'static str,
        /// The object key.
        key: String,
        /// The underlying error.
        source: std::io::Error,
    },
}

/// Object storage the worker reads recordings from and writes the mixed
/// audio to.
pub trait RecordingStore {
    /// Every object whose key starts with `prefix`, sorted by key.
    fn list(
        &self,
        prefix: &str,
    ) -> impl Future<Output = Result<Vec<ObjectInfo>, StoreError>> + Send;
    /// The bytes of one object.
    fn get(&self, key: &str) -> impl Future<Output = Result<Vec<u8>, StoreError>> + Send;
    /// Create or replace one object.
    fn put(&self, key: &str, bytes: Vec<u8>)
        -> impl Future<Output = Result<(), StoreError>> + Send;
}

/// A folder laid out like the bucket (`BUZZ_HUDDLE_RECORDING=local`).
#[derive(Debug, Clone)]
pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    /// Store rooted at `root`; keys are paths below it.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path_of(&self, key: &str) -> Result<PathBuf, StoreError> {
        let relative = Path::new(key);
        let plain = !key.is_empty()
            && relative
                .components()
                .all(|component| matches!(component, Component::Normal(_)));
        if !plain {
            return Err(StoreError::InvalidKey(key.to_string()));
        }
        Ok(self.root.join(relative))
    }
}

impl RecordingStore for LocalStore {
    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        // List the deepest folder named by the prefix, then filter by the
        // whole prefix so "a/b" also matches "a/bc/…" like a bucket does.
        let folder = match prefix.rfind('/') {
            Some(cut) => &prefix[..cut],
            None => "",
        };
        let start = if folder.is_empty() {
            self.root.clone()
        } else {
            self.path_of(folder)?
        };
        let mut out = Vec::new();
        let mut pending = vec![start];
        while let Some(dir) = pending.pop() {
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(source) => return Err(io_error("list", &dir, source)),
            };
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|source| io_error("list", &dir, source))?
            {
                let path = entry.path();
                let meta = entry
                    .metadata()
                    .await
                    .map_err(|source| io_error("stat", &path, source))?;
                if meta.is_dir() {
                    pending.push(path);
                    continue;
                }
                let Some(key) = key_of(&self.root, &path) else {
                    continue;
                };
                if !key.starts_with(prefix) {
                    continue;
                }
                let modified_unix_ms = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |since| {
                        u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
                    });
                out.push(ObjectInfo {
                    key,
                    size: meta.len(),
                    modified_unix_ms,
                });
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, StoreError> {
        let path = self.path_of(key)?;
        tokio::fs::read(&path)
            .await
            .map_err(|source| StoreError::Io {
                op: "read",
                key: key.to_string(),
                source,
            })
    }

    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<(), StoreError> {
        let path = self.path_of(key)?;
        let wrap = |source| StoreError::Io {
            op: "write",
            key: key.to_string(),
            source,
        };
        // Like the recorder's local mode: folders 0700, files 0600.
        if let Some(parent) = path.parent() {
            let mut folders = tokio::fs::DirBuilder::new();
            folders.recursive(true);
            #[cfg(unix)]
            folders.mode(0o700);
            folders.create(parent).await.map_err(wrap)?;
        }
        // Write beside the target and rename so a reader never sees half a file.
        let partial = path.with_extension("partial");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&partial).await.map_err(wrap)?;
        file.write_all(&bytes).await.map_err(wrap)?;
        file.flush().await.map_err(wrap)?;
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let private = std::fs::Permissions::from_mode(0o600);
            tokio::fs::set_permissions(&partial, private)
                .await
                .map_err(wrap)?;
        }
        tokio::fs::rename(&partial, &path).await.map_err(wrap)
    }
}

fn key_of(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    Some(parts?.join("/"))
}

fn io_error(op: &'static str, path: &Path, source: std::io::Error) -> StoreError {
    StoreError::Io {
        op,
        key: path.display().to_string(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_store_lists_by_key_prefix_and_refuses_escapes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalStore::new(dir.path());
        store
            .put("h/c1/s1/chunk-000000.bhr", vec![1, 2])
            .await
            .expect("put");
        store
            .put("h/c1/s1/manifest.json", b"{}".to_vec())
            .await
            .expect("put");
        store
            .put("h/c10/s2/chunk-000000.bhr", vec![3])
            .await
            .expect("put");

        let keys: Vec<String> = store
            .list("h/c1/")
            .await
            .expect("list")
            .into_iter()
            .map(|object| object.key)
            .collect();
        assert_eq!(keys, ["h/c1/s1/chunk-000000.bhr", "h/c1/s1/manifest.json"]);
        assert_eq!(store.list("h/c1").await.expect("list").len(), 3);
        assert!(store.list("nothing/here/").await.expect("list").is_empty());
        assert_eq!(
            store.get("h/c10/s2/chunk-000000.bhr").await.expect("get"),
            [3]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| {
                std::fs::metadata(dir.path().join(p))
                    .expect("stat")
                    .permissions()
                    .mode()
                    & 0o777
            };
            assert_eq!(mode("h/c1/s1/manifest.json"), 0o600);
            assert_eq!(mode("h/c1/s1"), 0o700);
        }

        for bad in ["../x", "/etc/passwd", "a/../b", ""] {
            assert!(matches!(
                store.get(bad).await,
                Err(StoreError::InvalidKey(_))
            ));
        }
    }
}
