use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    client::{OpsBridgeClient, OpsBridgeError},
    types::{
        is_artifact_handle, OpsArtifactClassifier, OpsArtifactHandleChunk, OpsArtifactManifestV1,
        OpsArtifactReadRequest, OpsArtifactReadResult, OPS_CONTRACT_VERSION,
    },
};

const ROOT_MARKER: &str = ".buzz-ops-artifact-handles-v1";
const ROOT_MARKER_BYTES: &[u8] = b"buzz-ops-artifact-handles-v1\n";
const MAX_HANDLES: usize = 32;
const MAX_AGGREGATE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INLINE_BYTES: u64 = 1024 * 1024;
const MAX_HUB_CHUNK_BYTES: u32 = 786_432;
const HANDLE_TTL: Duration = Duration::from_secs(15 * 60);
const WRITER_STRIPES: usize = 32;

#[derive(Debug)]
struct HandleEntry {
    file: File,
    size: u64,
    mime: String,
    expires_at: SystemTime,
}

#[derive(Debug, Default)]
struct HandleState {
    entries: HashMap<String, HandleEntry>,
    total_bytes: u64,
    closed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct StoredArtifactHandle {
    handle: String,
    expires_at: String,
}

impl StoredArtifactHandle {
    #[cfg(test)]
    pub(crate) fn handle(&self) -> &str {
        &self.handle
    }
}

pub(crate) struct ArtifactHandleStore {
    root: PathBuf,
    state: Mutex<HandleState>,
    writers: Vec<Arc<tokio::sync::Mutex<()>>>,
}

#[derive(Default)]
pub(crate) struct OpsArtifactState {
    store: Mutex<Option<Result<Arc<ArtifactHandleStore>, OpsBridgeError>>>,
}

impl OpsArtifactState {
    pub(crate) fn initialize(&self, app_cache: PathBuf) -> Result<(), OpsBridgeError> {
        let store = ArtifactHandleStore::initialize(app_cache).map(Arc::new);
        let failure = store.as_ref().err().copied();
        let mut slot = self
            .store
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if slot.is_some() {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
        *slot = Some(store);
        failure.map_or(Ok(()), Err)
    }

    pub(crate) fn store(&self) -> Result<Arc<ArtifactHandleStore>, OpsBridgeError> {
        self.store
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?
            .clone()
            .unwrap_or(Err(OpsBridgeError::ArtifactHandleStore))
    }

    pub(crate) fn shutdown_cleanup(&self) -> Result<(), OpsBridgeError> {
        let store = self.store()?;
        store.shutdown_cleanup()
    }
}

impl ArtifactHandleStore {
    pub(crate) fn initialize(app_cache: PathBuf) -> Result<Self, OpsBridgeError> {
        let app_cache = prepare_app_cache(&app_cache)?;
        let root = app_cache.join("ops-artifact-handles-v1");
        let created = prepare_owned_root(&root)?;
        prepare_marker(&root, created)?;
        cleanup_crash_remnants(&root)?;
        Ok(Self {
            root,
            state: Mutex::new(HandleState::default()),
            writers: (0..WRITER_STRIPES)
                .map(|_| Arc::new(tokio::sync::Mutex::new(())))
                .collect(),
        })
    }

    pub(crate) async fn lock_writer(
        &self,
        request: &OpsArtifactReadRequest,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        request.artifact_id.hash(&mut hasher);
        request.version.hash(&mut hasher);
        request.representation.as_str().hash(&mut hasher);
        let index = hasher.finish() as usize % self.writers.len();
        Arc::clone(&self.writers[index]).lock_owned().await
    }

    pub(crate) fn store_at(
        &self,
        bytes: &[u8],
        mime: &str,
        now: SystemTime,
    ) -> Result<StoredArtifactHandle, OpsBridgeError> {
        if !matches!(
            mime,
            "text/markdown" | "text/plain" | "application/json" | "text/html"
        ) {
            return Err(OpsBridgeError::ArtifactMediaUnsupported);
        }
        let size = u64::try_from(bytes.len()).map_err(|_| OpsBridgeError::ArtifactTooLarge)?;
        if size > MAX_ARTIFACT_BYTES {
            return Err(OpsBridgeError::ArtifactTooLarge);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if state.closed {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
        self.sweep_locked(&mut state, now)?;
        if state.entries.len() >= MAX_HANDLES
            || state
                .total_bytes
                .checked_add(size)
                .is_none_or(|total| total > MAX_AGGREGATE_BYTES)
        {
            return Err(OpsBridgeError::ArtifactTooLarge);
        }
        let expires_at = now
            .checked_add(HANDLE_TTL)
            .ok_or(OpsBridgeError::ArtifactHandleStore)?;
        let expires_at_text = timestamp(expires_at)?;

        validate_runtime_root(&self.root, &state)?;
        // The retained File is the only content capability. Unix unlinks the
        // custom named file immediately; Windows holds a no-share,
        // delete-on-close tempfile until the handle is released.
        let mut file = create_content_file(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        }
        validate_directory(&self.root)?;
        validate_marker(&self.root)?;
        file.write_all(bytes)
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        file.sync_all()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        validate_open_file(
            &file
                .metadata()
                .map_err(|_| OpsBridgeError::ArtifactHandleStore)?,
            0o600,
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let handle = format!("artifact-handle:{id}");
        state.total_bytes += size;
        state.entries.insert(
            handle.clone(),
            HandleEntry {
                file,
                size,
                mime: mime.to_owned(),
                expires_at,
            },
        );
        if let Err(error) = validate_runtime_root(&self.root, &state) {
            state.entries.remove(&handle);
            state.total_bytes = state.total_bytes.saturating_sub(size);
            return Err(error);
        }
        Ok(StoredArtifactHandle {
            handle,
            expires_at: expires_at_text,
        })
    }

    pub(crate) fn read_at(
        &self,
        handle: &str,
        offset: u64,
        length: u32,
        now: SystemTime,
    ) -> Result<OpsArtifactHandleChunk, OpsBridgeError> {
        if !is_artifact_handle(handle)
            || offset > super::types::MAX_SAFE_INTEGER_U64
            || !(1..=256 * 1024).contains(&length)
        {
            return Err(OpsBridgeError::InvalidArtifactRequest);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if state.closed {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
        self.sweep_locked(&mut state, now)?;
        let entry = state
            .entries
            .get(handle)
            .ok_or(OpsBridgeError::InvalidArtifactRequest)?;
        if offset > entry.size {
            return Err(OpsBridgeError::InvalidArtifactRequest);
        }
        let metadata = entry
            .file
            .metadata()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if metadata.len() != entry.size {
            return Err(OpsBridgeError::ArtifactIntegrityMismatch);
        }
        let next_offset = entry.size.min(offset.saturating_add(length as u64));
        let mut bytes = vec![0_u8; (next_offset - offset) as usize];
        read_file_at(&entry.file, &mut bytes, offset)?;
        let data_base64 = STANDARD.encode(bytes);
        Ok(OpsArtifactHandleChunk {
            contract_version: OPS_CONTRACT_VERSION,
            handle: handle.to_owned(),
            mime: entry.mime.clone(),
            offset,
            next_offset,
            total_size: entry.size,
            data_base64,
            eof: next_offset == entry.size,
        })
    }

    pub(crate) fn release(&self, handle: &str) -> Result<bool, OpsBridgeError> {
        if !is_artifact_handle(handle) {
            return Err(OpsBridgeError::InvalidArtifactRequest);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if state.closed {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
        self.sweep_locked(&mut state, SystemTime::now())?;
        let Some(entry) = state.entries.get(handle) else {
            return Ok(false);
        };
        let size = entry.size;
        state.entries.remove(handle);
        state.total_bytes = state.total_bytes.saturating_sub(size);
        Ok(true)
    }

    pub(crate) fn shutdown_cleanup(&self) -> Result<(), OpsBridgeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        state.closed = true;
        validate_runtime_root(&self.root, &state)?;
        let entries: Vec<_> = state
            .entries
            .iter()
            .map(|(handle, entry)| (handle.clone(), entry.size))
            .collect();
        for (handle, size) in entries {
            state.entries.remove(&handle);
            state.total_bytes = state.total_bytes.saturating_sub(size);
        }
        Ok(())
    }

    fn sweep_locked(&self, state: &mut HandleState, now: SystemTime) -> Result<(), OpsBridgeError> {
        validate_runtime_root(&self.root, state)?;
        let expired: Vec<_> = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.expires_at <= now)
            .map(|(handle, entry)| (handle.clone(), entry.size))
            .collect();
        for (handle, size) in expired {
            state.entries.remove(&handle);
            state.total_bytes = state.total_bytes.saturating_sub(size);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn live_handle_count(&self) -> usize {
        self.state.lock().unwrap().entries.len()
    }
    #[cfg(test)]
    pub(crate) fn live_bytes(&self) -> u64 {
        self.state.lock().unwrap().total_bytes
    }
    #[cfg(all(test, unix))]
    pub(crate) fn handle_file_security(&self, handle: &str) -> (u32, bool) {
        use std::os::{fd::AsRawFd, unix::fs::PermissionsExt};
        let state = self.state.lock().unwrap();
        let file = &state.entries.get(handle).unwrap().file;
        let mode = file.metadata().unwrap().permissions().mode() & 0o777;
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        (mode, flags >= 0 && flags & libc::FD_CLOEXEC != 0)
    }

    fn ensure_open(&self) -> Result<(), OpsBridgeError> {
        if self
            .state
            .lock()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?
            .closed
        {
            Err(OpsBridgeError::ArtifactHandleStore)
        } else {
            Ok(())
        }
    }
}

pub(crate) async fn read_verified_artifact(
    client: Arc<OpsBridgeClient>,
    store: Arc<ArtifactHandleStore>,
    request: OpsArtifactReadRequest,
) -> Result<OpsArtifactReadResult, OpsBridgeError> {
    request.validate()?;
    let _writer = store.lock_writer(&request).await;
    store.ensure_open()?;
    let manifest = client.artifact_manifest(&request).await?;
    validate_manifest(&manifest, &request)?;
    let mut bytes = Vec::with_capacity(manifest.total_size as usize);
    let mut offset = 0_u64;
    while offset < manifest.total_size {
        let remaining = manifest.total_size - offset;
        let length = u32::try_from(remaining.min(MAX_HUB_CHUNK_BYTES as u64)).unwrap();
        let chunk = client.artifact_chunk(&request, offset, length).await?;
        if chunk.artifact_id != manifest.artifact_id
            || chunk.version != manifest.version
            || chunk.representation != manifest.representation
            || chunk.offset != offset
            || chunk.next_offset <= offset
            || chunk.next_offset > manifest.total_size
            || chunk.total_size != manifest.total_size
            || chunk.sha256 != manifest.sha256
            || chunk.mime != manifest.mime
            || chunk.eof != (chunk.next_offset == manifest.total_size)
        {
            return Err(OpsBridgeError::ArtifactIntegrityMismatch);
        }
        let decoded = STANDARD
            .decode(&chunk.data_base64)
            .map_err(|_| OpsBridgeError::ArtifactIntegrityMismatch)?;
        if STANDARD.encode(&decoded) != chunk.data_base64
            || decoded.len() as u64 != chunk.next_offset - chunk.offset
            || decoded.len() > MAX_HUB_CHUNK_BYTES as usize
        {
            return Err(OpsBridgeError::ArtifactIntegrityMismatch);
        }
        bytes.extend_from_slice(&decoded);
        offset = chunk.next_offset;
    }
    if bytes.len() as u64 != manifest.total_size
        || hex::encode(Sha256::digest(&bytes)) != manifest.sha256
    {
        return Err(OpsBridgeError::ArtifactIntegrityMismatch);
    }
    store.ensure_open()?;
    if manifest.total_size <= MAX_INLINE_BYTES {
        if let Ok(text) = String::from_utf8(bytes.clone()) {
            return Ok(OpsArtifactReadResult::InlineText {
                contract_version: OPS_CONTRACT_VERSION,
                artifact_id: request.artifact_id,
                version: request.version,
                representation: request.representation,
                mime: manifest.mime,
                total_size: manifest.total_size,
                sha256: manifest.sha256,
                text,
            });
        }
    }
    let stored = store.store_at(&bytes, &manifest.mime, SystemTime::now())?;
    Ok(OpsArtifactReadResult::OpaqueHandle {
        contract_version: OPS_CONTRACT_VERSION,
        artifact_id: request.artifact_id,
        version: request.version,
        representation: request.representation,
        mime: manifest.mime,
        total_size: manifest.total_size,
        sha256: manifest.sha256,
        handle: stored.handle,
        expires_at: stored.expires_at,
    })
}

fn validate_manifest(
    manifest: &OpsArtifactManifestV1,
    request: &OpsArtifactReadRequest,
) -> Result<(), OpsBridgeError> {
    let valid_mime = matches!(
        manifest.mime.as_str(),
        "text/markdown" | "text/plain" | "application/json" | "text/html"
    );
    let timestamp = DateTime::parse_from_rfc3339(&manifest.created_at)
        .ok()
        .map(|value| {
            value
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        });
    if manifest.artifact_id != request.artifact_id
        || manifest.version != request.version
        || manifest.representation != request.representation
        || manifest.total_size > MAX_ARTIFACT_BYTES
        || manifest.sha256.len() != 64
        || !manifest
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !valid_mime
        || manifest.visibility != "public_safe"
        || !manifest.guest_readable
        || manifest.provenance.classifier != OpsArtifactClassifier::HubGuestSafeV1
        || timestamp.as_deref() != Some(manifest.created_at.as_str())
    {
        return Err(if manifest.total_size > MAX_ARTIFACT_BYTES {
            OpsBridgeError::ArtifactTooLarge
        } else {
            OpsBridgeError::ArtifactIntegrityMismatch
        });
    }
    Ok(())
}

fn timestamp(value: SystemTime) -> Result<String, OpsBridgeError> {
    Ok(DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn prepare_owned_root(root: &Path) -> Result<bool, OpsBridgeError> {
    if !root.is_absolute() {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    let created = match std::fs::symlink_metadata(root) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(OpsBridgeError::ArtifactHandleStore);
            }
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(root).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
            }
            true
        }
        Err(_) => return Err(OpsBridgeError::ArtifactHandleStore),
    };
    validate_directory(root)?;
    Ok(created)
}

fn cleanup_crash_remnants(root: &Path) -> Result<(), OpsBridgeError> {
    cleanup_crash_remnants_inner(root, || {})
}

fn cleanup_crash_remnants_inner(
    root: &Path,
    before_delete: impl FnOnce(),
) -> Result<(), OpsBridgeError> {
    #[cfg(unix)]
    let anchor = open_root_anchor(root)?;
    let remnants = validate_startup_root(root)?;
    before_delete();
    for path in remnants {
        #[cfg(unix)]
        {
            validate_root_anchor(root, &anchor)?;
            remove_startup_remnant(&anchor, &path)?;
        }
        #[cfg(not(unix))]
        remove_startup_remnant(root, &path)?;
    }
    #[cfg(unix)]
    validate_root_anchor(root, &anchor)?;
    validate_startup_root(root).map(|_| ())
}

#[cfg(test)]
pub(crate) fn cleanup_crash_remnants_with_hook(
    root: &Path,
    before_delete: impl FnOnce(),
) -> Result<(), OpsBridgeError> {
    cleanup_crash_remnants_inner(root, before_delete)
}

fn validate_startup_root(root: &Path) -> Result<Vec<PathBuf>, OpsBridgeError> {
    validate_directory(root)?;
    validate_marker(root)?;
    let mut remnants = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|_| OpsBridgeError::ArtifactHandleStore)? {
        let entry = entry.map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(OpsBridgeError::ArtifactHandleStore)?;
        if name == ROOT_MARKER {
            continue;
        }
        #[cfg(unix)]
        {
            let middle = name
                .strip_prefix(".buzz-artifact-live-")
                .and_then(|value| value.strip_suffix(".tmp"))
                .ok_or(OpsBridgeError::ArtifactHandleStore)?;
            if middle.len() != 16 || !middle.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return Err(OpsBridgeError::ArtifactHandleStore);
            }
            validate_regular_file(&entry.path(), Some(0o600))?;
            remnants.push(entry.path());
        }
        #[cfg(not(unix))]
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    Ok(remnants)
}

fn validate_runtime_root(root: &Path, state: &HandleState) -> Result<(), OpsBridgeError> {
    validate_directory(root)?;
    validate_marker(root)?;
    #[cfg(windows)]
    let mut live_entries = 0_usize;
    for entry in std::fs::read_dir(root).map_err(|_| OpsBridgeError::ArtifactHandleStore)? {
        let entry = entry.map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(OpsBridgeError::ArtifactHandleStore)?;
        if name == ROOT_MARKER {
            continue;
        }
        #[cfg(windows)]
        {
            let middle = name
                .strip_prefix(".tmp")
                .ok_or(OpsBridgeError::ArtifactHandleStore)?;
            if middle.len() != 6 || !middle.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return Err(OpsBridgeError::ArtifactHandleStore);
            }
            // The file itself is opened with share_mode(0); use the directory
            // enumeration's cached type instead of trying to reopen it.
            if !entry
                .file_type()
                .map_err(|_| OpsBridgeError::ArtifactHandleStore)?
                .is_file()
            {
                return Err(OpsBridgeError::ArtifactHandleStore);
            }
            live_entries += 1;
        }
        #[cfg(not(windows))]
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    #[cfg(windows)]
    if live_entries != state.entries.len() {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    #[cfg(not(windows))]
    let _ = state;
    Ok(())
}

fn validate_marker(root: &Path) -> Result<(), OpsBridgeError> {
    let path = root.join(ROOT_MARKER);
    validate_regular_file(&path, Some(0o600))?;
    let mut marker = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    let metadata = marker
        .metadata()
        .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    validate_open_file(&metadata, 0o600)?;
    if metadata.len() != ROOT_MARKER_BYTES.len() as u64 {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    let mut bytes = [0_u8; ROOT_MARKER_BYTES.len()];
    marker
        .read_exact(&mut bytes)
        .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    if bytes != ROOT_MARKER_BYTES {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    Ok(())
}

fn validate_directory(path: &Path) -> Result<(), OpsBridgeError> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    if std::fs::canonicalize(path).map_err(|_| OpsBridgeError::ArtifactHandleStore)? != path {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o777 != 0o700
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
    }
    Ok(())
}

fn validate_regular_file(path: &Path, required_mode: Option<u32>) -> Result<(), OpsBridgeError> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    #[cfg(unix)]
    if let Some(required) = required_mode {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o777 != required
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
    }
    Ok(())
}

fn prepare_app_cache(app_cache: &Path) -> Result<PathBuf, OpsBridgeError> {
    if !app_cache.is_absolute() {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    match std::fs::symlink_metadata(app_cache) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(OpsBridgeError::ArtifactHandleStore);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = app_cache
                .parent()
                .ok_or(OpsBridgeError::ArtifactHandleStore)?;
            let canonical_parent =
                std::fs::canonicalize(parent).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
            let name = app_cache
                .file_name()
                .ok_or(OpsBridgeError::ArtifactHandleStore)?;
            let canonical_target = canonical_parent.join(name);
            std::fs::create_dir(&canonical_target)
                .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&canonical_target, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
            }
        }
        Err(_) => return Err(OpsBridgeError::ArtifactHandleStore),
    }
    let canonical =
        std::fs::canonicalize(app_cache).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    let metadata = std::fs::metadata(app_cache).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
    }
    Ok(canonical)
}

fn prepare_marker(root: &Path, created: bool) -> Result<(), OpsBridgeError> {
    if created {
        let path = root.join(ROOT_MARKER);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(path)
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        file.write_all(ROOT_MARKER_BYTES)
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        file.sync_all()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        Ok(())
    } else {
        validate_marker(root)
    }
}

fn validate_open_file(metadata: &std::fs::Metadata, mode: u32) -> Result<(), OpsBridgeError> {
    if !metadata.is_file() {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o777 != mode
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(OpsBridgeError::ArtifactHandleStore);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_content_file(root: &Path) -> Result<File, OpsBridgeError> {
    tempfile::Builder::new()
        .prefix(".buzz-artifact-live-")
        .suffix(".tmp")
        .rand_bytes(16)
        .tempfile_in(root)
        .map(tempfile::NamedTempFile::into_file)
        .map_err(|_| OpsBridgeError::ArtifactHandleStore)
}

#[cfg(windows)]
fn create_content_file(root: &Path) -> Result<File, OpsBridgeError> {
    // tempfile_in uses create_new + share_mode(0) +
    // FILE_FLAG_DELETE_ON_CLOSE on Windows. The live `.tmpXXXXXX` entry is
    // counted by validate_runtime_root and is removed by the kernel on close.
    tempfile::tempfile_in(root).map_err(|_| OpsBridgeError::ArtifactHandleStore)
}

#[cfg(not(any(unix, windows)))]
fn create_content_file(_root: &Path) -> Result<File, OpsBridgeError> {
    Err(OpsBridgeError::ArtifactHandleStore)
}

#[cfg(unix)]
fn open_root_anchor(root: &Path) -> Result<File, OpsBridgeError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let anchor = options
        .open(root)
        .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    validate_root_anchor(root, &anchor)?;
    Ok(anchor)
}

#[cfg(unix)]
fn validate_root_anchor(root: &Path, anchor: &File) -> Result<(), OpsBridgeError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let current =
        std::fs::symlink_metadata(root).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    let anchored = anchor
        .metadata()
        .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    if current.file_type().is_symlink()
        || !current.is_dir()
        || current.dev() != anchored.dev()
        || current.ino() != anchored.ino()
        || anchored.permissions().mode() & 0o777 != 0o700
        || anchored.uid() != unsafe { libc::geteuid() }
    {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    Ok(())
}

#[cfg(unix)]
fn remove_startup_remnant(anchor: &File, path: &Path) -> Result<(), OpsBridgeError> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    let name = path
        .file_name()
        .ok_or(OpsBridgeError::ArtifactHandleStore)?;
    if name.as_bytes().contains(&b'/') {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    let name =
        std::ffi::CString::new(name.as_bytes()).map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
    let fd = unsafe {
        libc::openat(
            anchor.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    validate_open_file(
        &file
            .metadata()
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?,
        0o600,
    )?;
    if unsafe { libc::unlinkat(anchor.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(OpsBridgeError::ArtifactHandleStore);
    }
    Ok(())
}

#[cfg(not(unix))]
fn remove_startup_remnant(_root: &Path, _path: &Path) -> Result<(), OpsBridgeError> {
    Err(OpsBridgeError::ArtifactHandleStore)
}

#[cfg(unix)]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> Result<(), OpsBridgeError> {
    use std::os::unix::fs::FileExt;
    let mut filled = 0;
    while filled < bytes.len() {
        let read = file
            .read_at(&mut bytes[filled..], offset + filled as u64)
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if read == 0 {
            return Err(OpsBridgeError::ArtifactIntegrityMismatch);
        }
        filled += read;
    }
    Ok(())
}

#[cfg(windows)]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> Result<(), OpsBridgeError> {
    use std::os::windows::fs::FileExt;
    let mut filled = 0;
    while filled < bytes.len() {
        let read = file
            .seek_read(&mut bytes[filled..], offset + filled as u64)
            .map_err(|_| OpsBridgeError::ArtifactHandleStore)?;
        if read == 0 {
            return Err(OpsBridgeError::ArtifactIntegrityMismatch);
        }
        filled += read;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn read_file_at(_file: &File, _bytes: &mut [u8], _offset: u64) -> Result<(), OpsBridgeError> {
    Err(OpsBridgeError::ArtifactHandleStore)
}
