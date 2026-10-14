//! Where recordings live. The worker sees an object store with `/`-separated
//! keys, the same shape the relay writes (`docs/huddle-recording.md`): a
//! local folder ([`LocalStore`]) or a Cloud Storage bucket ([`GcsStore`]).

use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use buzz_gcp::gcs::{Gcs, GcsError, GcsErrorKind, Write};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    /// Cloud Storage refused or failed.
    #[error("{op} {key}: {source}")]
    Gcs {
        /// What was being done.
        op: &'static str,
        /// The object key.
        key: String,
        /// The underlying error.
        source: GcsError,
    },
}

/// What [`RecordingStore::put_new`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutNew {
    /// Written now.
    Written,
    /// Already there with exactly these bytes (an earlier run wrote it).
    Same,
    /// Already there with other bytes, and left as it is.
    Other,
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
    /// The first `len` bytes of one object (fewer when it is shorter).
    fn get_start(
        &self,
        key: &str,
        len: u64,
    ) -> impl Future<Output = Result<Vec<u8>, StoreError>> + Send;
    /// Create or replace one object.
    fn put(&self, key: &str, bytes: Vec<u8>)
        -> impl Future<Output = Result<(), StoreError>> + Send;
    /// Create one object only if nothing is stored under `key`; never
    /// replaces (the worker needs no right to overwrite or delete).
    fn put_new(
        &self,
        key: &str,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<PutNew, StoreError>> + Send;
    /// Names of the folders right under `prefix` (which ends with `/`),
    /// sorted.
    fn folders(&self, prefix: &str)
        -> impl Future<Output = Result<Vec<String>, StoreError>> + Send;
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

    async fn get_start(&self, key: &str, len: u64) -> Result<Vec<u8>, StoreError> {
        let path = self.path_of(key)?;
        let wrap = |source| StoreError::Io {
            op: "read",
            key: key.to_string(),
            source,
        };
        let file = tokio::fs::File::open(&path).await.map_err(wrap)?;
        let mut bytes = Vec::new();
        file.take(len).read_to_end(&mut bytes).await.map_err(wrap)?;
        Ok(bytes)
    }

    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<PutNew, StoreError> {
        let path = self.path_of(key)?;
        match tokio::fs::read(&path).await {
            Ok(stored) if stored == bytes => Ok(PutNew::Same),
            Ok(_) => Ok(PutNew::Other),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.put(key, bytes).await?;
                Ok(PutNew::Written)
            }
            Err(source) => Err(StoreError::Io {
                op: "read",
                key: key.to_string(),
                source,
            }),
        }
    }

    async fn folders(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        let folder = prefix.trim_end_matches('/');
        let dir = if folder.is_empty() {
            self.root.clone()
        } else {
            self.path_of(folder)?
        };
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(io_error("list", &dir, source)),
        };
        let mut names = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|source| io_error("list", &dir, source))?
        {
            let is_dir = entry
                .file_type()
                .await
                .map_err(|source| io_error("stat", &entry.path(), source))?
                .is_dir();
            if let (true, Some(name)) = (is_dir, entry.file_name().to_str()) {
                names.push(name.to_string());
            }
        }
        names.sort();
        Ok(names)
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

/// Largest object [`GcsStore`] reads whole (chunks and manifests are far
/// smaller).
pub const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;

/// A Cloud Storage bucket. Keys are object names.
#[derive(Debug, Clone)]
pub struct GcsStore {
    gcs: Arc<Gcs>,
    bucket: String,
}

impl GcsStore {
    /// Objects of `bucket` through `gcs`.
    pub fn new(gcs: Arc<Gcs>, bucket: impl Into<String>) -> Self {
        Self {
            gcs,
            bucket: bucket.into(),
        }
    }
}

fn gcs_error<'a>(op: &'static str, key: &'a str) -> impl FnOnce(GcsError) -> StoreError + 'a {
    move |source| StoreError::Gcs {
        op,
        key: key.to_string(),
        source,
    }
}

/// Content type by file extension (the mixed audio is WAV).
fn content_type(key: &str) -> &'static str {
    match key.rsplit_once('.').map(|(_, extension)| extension) {
        Some("wav") => "audio/wav",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

impl RecordingStore for GcsStore {
    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        let mut out: Vec<ObjectInfo> = self
            .gcs
            .list(&self.bucket, prefix)
            .await
            .map_err(gcs_error("list", prefix))?
            .into_iter()
            .map(|object| ObjectInfo {
                key: object.name,
                size: object.size,
                modified_unix_ms: object.updated_unix_ms,
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, StoreError> {
        let bytes = self
            .gcs
            .get(&self.bucket, key, MAX_OBJECT_BYTES)
            .await
            .map_err(gcs_error("read", key))?;
        Ok(bytes.to_vec())
    }

    async fn get_start(&self, key: &str, len: u64) -> Result<Vec<u8>, StoreError> {
        let bytes = self
            .gcs
            .get_start(&self.bucket, key, len)
            .await
            .map_err(gcs_error("read", key))?;
        Ok(bytes.to_vec())
    }

    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<(), StoreError> {
        self.gcs
            .put(
                &self.bucket,
                key,
                bytes,
                content_type(key),
                Write::Overwrite,
            )
            .await
            .map_err(gcs_error("write", key))?;
        Ok(())
    }

    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<PutNew, StoreError> {
        let read = gcs_error("read", key);
        match self.gcs.stat(&self.bucket, key).await {
            Ok(object) => {
                if object.size != bytes.len() as u64 {
                    return Ok(PutNew::Other);
                }
                let stored = self
                    .gcs
                    .get_generation(&self.bucket, key, object.generation, object.size)
                    .await
                    .map_err(read)?;
                Ok(if stored == bytes {
                    PutNew::Same
                } else {
                    PutNew::Other
                })
            }
            Err(error) if error.kind == GcsErrorKind::NotFound => {
                match self
                    .gcs
                    .put(&self.bucket, key, bytes, content_type(key), Write::IfAbsent)
                    .await
                {
                    Ok(_) => Ok(PutNew::Written),
                    // Someone wrote other bytes in between.
                    Err(error) if error.kind == GcsErrorKind::AlreadyExists => Ok(PutNew::Other),
                    Err(error) => Err(gcs_error("write", key)(error)),
                }
            }
            Err(error) => Err(read(error)),
        }
    }

    async fn folders(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        let folders = self
            .gcs
            .list_folders(&self.bucket, prefix)
            .await
            .map_err(gcs_error("list", prefix))?;
        Ok(folders
            .iter()
            .filter_map(|folder| folder.strip_prefix(prefix))
            .map(|name| name.trim_end_matches('/').to_string())
            .filter(|name| !name.is_empty())
            .collect())
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

    /// The bucket store writes new objects only (no overwrite or delete
    /// right needed) and lists folders.
    #[tokio::test]
    async fn gcs_store_writes_new_objects_only_and_lists_folders() {
        use buzz_gcp::token::{AccessToken, TokenSource, Tokens};
        let fake = buzz_gcp::fake::FakeGcs::start(3_600).await;
        fake.accept_token("t");
        let tokens = Tokens::new(TokenSource::Static(AccessToken::new("t"))).expect("tokens");
        let gcs = Gcs::with_base_url(tokens, fake.url()).expect("client");
        let store = GcsStore::new(Arc::new(gcs), "rec");
        let key = "h/c/ch/mixed/a.wav";
        assert_eq!(
            store.put_new(key, b"abc".to_vec()).await.expect("new"),
            PutNew::Written
        );
        let written = fake.objects("rec")[key].clone();
        assert_eq!(written.content_type, "audio/wav");
        assert_eq!(
            store.put_new(key, b"abc".to_vec()).await.expect("same"),
            PutNew::Same
        );
        assert_eq!(
            store.put_new(key, b"abd".to_vec()).await.expect("other"),
            PutNew::Other
        );
        assert_eq!(fake.objects("rec")[key], written, "never overwritten");
        store.put("h/d/x", b"x".to_vec()).await.expect("put");
        assert_eq!(store.folders("h/").await.expect("folders"), ["c", "d"]);
        assert_eq!(store.folders("h/c/").await.expect("folders"), ["ch"]);
    }

    #[tokio::test]
    async fn local_store_writes_new_objects_only_and_lists_folders() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalStore::new(dir.path());
        assert_eq!(
            store
                .put_new("h/c/mixed/a.wav", b"abc".to_vec())
                .await
                .expect("new"),
            PutNew::Written
        );
        assert_eq!(
            store
                .put_new("h/c/mixed/a.wav", b"abc".to_vec())
                .await
                .expect("same"),
            PutNew::Same
        );
        assert_eq!(
            store
                .put_new("h/c/mixed/a.wav", b"abd".to_vec())
                .await
                .expect("other"),
            PutNew::Other
        );
        assert_eq!(store.get("h/c/mixed/a.wav").await.expect("kept"), b"abc");
        store.put("h/d/x", b"x".to_vec()).await.expect("put");
        store.put("h/file", b"x".to_vec()).await.expect("put");
        assert_eq!(store.folders("h/").await.expect("folders"), ["c", "d"]);
        assert_eq!(store.folders("h/c/").await.expect("folders"), ["mixed"]);
        assert!(store.folders("none/").await.expect("none").is_empty());
    }

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
