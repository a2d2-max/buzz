//! Full upstream products run at their own origin with one mount-scoped A2D2 login capability.
use crate::{
    app_state::AppState,
    relay::{
        build_nip98_auth_header, relay_api_base_url_with_override, relay_ws_url_with_override,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use buzz_core_pkg::engine_bridge::{
    EngineAction, EngineLaunchIntent, EngineProduct, ENGINE_BRIDGE_VERSION,
    ENGINE_LAUNCH_MAX_TTL_SECONDS,
};
use chrono::Utc;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{
    ipc::CapabilityBuilder, plugin::TauriPlugin, LogicalPosition, LogicalSize, Manager, State, Url,
    Webview, WebviewBuilder, WebviewUrl, Wry,
};

const UPSTREAM_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const ENGINE_LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const ENGINE_LAUNCH_RESPONSE_MAX_BYTES: usize = 4 * 1024;
const ENGINE_CALLBACK_STATE_BYTES: usize = 32;

const ENGINE_LAUNCH_SCRIPT: &str = r#"
(() => {
  const fail = (message) => { throw new Error(message); };
  const launch = async () => {
    const begin = await fetch('/api/a2d2/session/begin', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: '{}'
    });
    if (!begin.ok) fail('A2D2 session begin failed');
    const beginBody = await begin.json();
    if (typeof beginBody.state !== 'string') fail('A2D2 session state missing');
    const nativeInvoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof nativeInvoke !== 'function') fail('A2D2 native launch unavailable');
    const launchBody = await nativeInvoke('plugin:engine-launch|mint_upstream_launch_from_child', {
      callbackState: beginBody.state
    });
    if (!launchBody || typeof launchBody.code !== 'string' ||
        typeof launchBody.mount_session !== 'string') {
      fail('A2D2 native launch failed');
    }
    const exchange = await fetch('/api/a2d2/session/exchange', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: launchBody.code,
        mount_session: launchBody.mount_session,
        state: beginBody.state
      })
    });
    if (!exchange.ok) fail('A2D2 session exchange failed');
    const exchangeBody = await exchange.json();
    if (exchangeBody.authenticated !== true ||
        !Number.isSafeInteger(exchangeBody.expires_at) ||
        exchangeBody.expires_at <= Math.floor(Date.now() / 1000)) {
      fail('A2D2 session exchange response invalid');
    }
    const result = {
      authenticated: true,
      expires_at: exchangeBody.expires_at
    };
    if (typeof exchangeBody.workspace_slug === 'string' &&
        /^[A-Za-z0-9_-]{1,48}$/.test(exchangeBody.workspace_slug)) {
      result.workspace_slug = exchangeBody.workspace_slug;
    } else if (typeof exchangeBody.workspace_id === 'string' &&
               /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(exchangeBody.workspace_id)) {
      result.workspace_id = exchangeBody.workspace_id;
    } else {
      fail('A2D2 managed workspace missing');
    }
    return Object.freeze(result);
  };
  Object.defineProperty(window, 'a2d2Engine', {
    configurable: false, enumerable: false, writable: false,
    value: Object.freeze({ launch })
  });
})();
"#;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamProduct {
    Affine,
    Plane,
}

impl From<UpstreamProduct> for EngineProduct {
    fn from(value: UpstreamProduct) -> Self {
        match value {
            UpstreamProduct::Affine => Self::Affine,
            UpstreamProduct::Plane => Self::Plane,
        }
    }
}

/// Public scope for one native child WebView. Tokens and private keys never
/// cross or persist in this record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UpstreamMountRecord {
    product: UpstreamProduct,
    mount_session: uuid::Uuid,
    origin: String,
    relay: String,
    pubkey: String,
    launch_pending: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelayLaunchResponse {
    code: String,
    expires_at: i64,
}

#[derive(Serialize)]
pub(crate) struct NativeLaunchResponse {
    code: String,
    mount_session: uuid::Uuid,
    expires_at: i64,
}

impl UpstreamProduct {
    fn name(self) -> &'static str {
        match self {
            Self::Affine => "affine",
            Self::Plane => "plane",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Affine => "AFFiNE",
            Self::Plane => "Plane",
        }
    }
    fn raw_url(self) -> Option<String> {
        let (name, baked) = match self {
            Self::Affine => ("BUZZ_AFFINE_URL", option_env!("BUZZ_DESKTOP_AFFINE_URL")),
            Self::Plane => ("BUZZ_PLANE_URL", option_env!("BUZZ_DESKTOP_PLANE_URL")),
        };
        std::env::var(name)
            .ok()
            .or_else(|| baked.map(str::to_owned))
    }
    fn url(self) -> Result<Url, String> {
        let value = self
            .raw_url()
            .ok_or_else(|| format!("{} service has not been configured", self.name()))?;
        endpoint(&value)
    }
}

fn configured_products_with(
    mut raw_url: impl FnMut(UpstreamProduct) -> Option<String>,
) -> Vec<UpstreamProduct> {
    [UpstreamProduct::Affine, UpstreamProduct::Plane]
        .into_iter()
        .filter(|product| {
            raw_url(*product)
                .as_deref()
                .is_some_and(|raw| endpoint(raw).is_ok())
        })
        .collect()
}

fn configured_products() -> Vec<UpstreamProduct> {
    configured_products_with(UpstreamProduct::raw_url)
}

fn mount_label(product: UpstreamProduct, session: uuid::Uuid) -> String {
    format!("upstream-{}-{session}", product.name())
}

/// Register the bounded remote login surface once for each configured product.
///
/// Tauri 2.11 runtime capabilities are append-only, so per-mount registration
/// would leak one rule for every opened view. Provider origins are process
/// configuration: changing one requires a restart, where this fixed set is
/// rebuilt. The command still validates the exact live mount record.
pub fn register_upstream_login_capabilities(app: &tauri::AppHandle) -> Result<(), String> {
    for product in configured_products() {
        let origin = product.url()?.origin().ascii_serialization();
        app.add_capability(
            CapabilityBuilder::new(format!("engine-launch-{}", product.name()))
                .local(false)
                .remote(format!("{origin}/*"))
                .webview(format!("upstream-{}-*", product.name()))
                .permission("engine-launch:allow-mint-upstream-launch-from-child"),
        )
        .map_err(|error| format!("failed to authorize {} login: {error}", product.title()))?;
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize)]
pub struct UpstreamBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn endpoint(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid upstream service URL")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || url.host_str().is_some_and(|h| h.ends_with(".localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Upstream service requires HTTPS or a local loopback URL without credentials".into(),
        );
    }
    Ok(url)
}

fn trusted_host(label: &str, url: &Url) -> bool {
    label == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("localhost")
                && url.port() == Some(1420)))
}

pub(crate) fn ensure_trusted_caller(caller: &Webview) -> Result<(), String> {
    if trusted_host(caller.label(), &caller.url().map_err(|e| e.to_string())?) {
        Ok(())
    } else {
        Err("Only the local main app can use this command".into())
    }
}

/// Compile-time proof for sensitive local-account operations. The private
/// field means account command modules can obtain this token only by passing
/// the actual invoking WebView through the origin/label guard above.
pub(crate) struct TrustedLocalCaller(());

pub(crate) fn trusted_local_caller(caller: &Webview) -> Result<TrustedLocalCaller, String> {
    ensure_trusted_caller(caller)?;
    Ok(TrustedLocalCaller(()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SameOriginPopupAction {
    Navigate,
    Download,
}

fn is_plane_attachment_download(product: UpstreamProduct, target: &Url) -> bool {
    if product != UpstreamProduct::Plane || target.query().is_some() || target.fragment().is_some()
    {
        return false;
    }
    let Some(mut parts) = target.path_segments().map(Iterator::collect::<Vec<_>>) else {
        return false;
    };
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts.len() == 11
        && parts[0..4] == ["api", "assets", "v2", "workspaces"]
        && !parts[4].is_empty()
        && parts[5] == "projects"
        && uuid::Uuid::parse_str(parts[6]).is_ok()
        && parts[7] == "issues"
        && uuid::Uuid::parse_str(parts[8]).is_ok()
        && parts[9] == "attachments"
        && uuid::Uuid::parse_str(parts[10]).is_ok()
}

fn reuse_same_origin_new_window<E>(
    product: UpstreamProduct,
    target: Url,
    configured: &Url,
    dispatch: impl FnOnce(Url, SameOriginPopupAction) -> Result<(), E>,
) -> bool {
    if target.origin() != configured.origin()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return false;
    }
    let action = if is_plane_attachment_download(product, &target) {
        SameOriginPopupAction::Download
    } else {
        SameOriginPopupAction::Navigate
    };
    dispatch(target, action).is_ok()
}

fn download_script(url: &Url) -> Result<String, String> {
    let href = serde_json::to_string(url.as_str()).map_err(|error| error.to_string())?;
    Ok(format!(
        "(() => {{ const link = document.createElement('a'); link.href = {href}; link.download = ''; link.hidden = true; document.body.appendChild(link); link.click(); link.remove(); }})()"
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeFailure {
    RateLimited,
    Unavailable,
}

impl ProbeFailure {
    fn user_message(self, product: UpstreamProduct) -> String {
        match self {
            Self::RateLimited => format!(
                "{} is temporarily rate limited. Wait a moment, then try again.",
                product.title()
            ),
            Self::Unavailable => format!(
                "{} isn’t responding. Check the service, then try again.",
                product.title()
            ),
        }
    }
}

async fn probe_endpoint(
    client: &reqwest::Client,
    url: Url,
    timeout: Duration,
) -> Result<(), ProbeFailure> {
    let response = client
        .head(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ProbeFailure::Unavailable)?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        Err(ProbeFailure::RateLimited)
    } else if response.status().is_server_error() {
        Err(ProbeFailure::Unavailable)
    } else {
        Ok(())
    }
}

#[derive(Eq, PartialEq)]
struct UpstreamContext {
    pubkey: String,
    relay: String,
}

fn upstream_context(state: &AppState) -> Result<UpstreamContext, String> {
    Ok(UpstreamContext {
        pubkey: state
            .keys
            .lock()
            .map_err(|e| e.to_string())?
            .public_key()
            .to_hex(),
        relay: relay_ws_url_with_override(state),
    })
}

fn start_launch(
    state: &AppState,
    label: &str,
    request_origin: &str,
) -> Result<UpstreamMountRecord, String> {
    let mut mounts = state
        .upstream_mounts
        .lock()
        .map_err(|_| "upstream launch state unavailable".to_string())?;
    let Some(record) = mounts.get_mut(label) else {
        return Err("upstream view is no longer active".into());
    };
    if request_origin != record.origin {
        return Err("upstream view origin changed".into());
    }
    if record.launch_pending {
        return Err("upstream launch already pending".into());
    }
    record.launch_pending = true;
    Ok(record.clone())
}

fn finish_launch(state: &AppState, label: &str, mount_session: uuid::Uuid) {
    if let Ok(mut mounts) = state.upstream_mounts.lock() {
        if let Some(record) = mounts.get_mut(label) {
            if record.mount_session == mount_session {
                record.launch_pending = false;
            }
        }
    }
}

async fn read_bounded_response(
    mut response: reqwest::Response,
) -> Result<RelayLaunchResponse, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "relay response failed")?
    {
        if body.len().saturating_add(chunk.len()) > ENGINE_LAUNCH_RESPONSE_MAX_BYTES {
            return Err("relay response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "relay response malformed".into())
}

async fn mint_engine_launch(
    app: &tauri::AppHandle,
    label: &str,
    record: &UpstreamMountRecord,
    callback_state: &str,
) -> Result<NativeLaunchResponse, String> {
    let callback_state_bytes = URL_SAFE_NO_PAD
        .decode(callback_state)
        .map_err(|_| "invalid callback state")?;
    if callback_state_bytes.len() != ENGINE_CALLBACK_STATE_BYTES {
        return Err("invalid callback state".into());
    }
    let state = app.state::<AppState>();
    let view = app
        .get_webview(label)
        .ok_or_else(|| "upstream view is no longer active".to_string())?;
    let current_url = view.url().map_err(|_| "upstream view URL unavailable")?;
    if current_url.origin().ascii_serialization() != record.origin {
        return Err("upstream view origin changed".into());
    }
    let context = upstream_context(&state)?;
    if context.pubkey != record.pubkey || context.relay != record.relay {
        return Err("active A2D2 identity changed".into());
    }

    let now = Utc::now().timestamp();
    let intent = EngineLaunchIntent {
        version: ENGINE_BRIDGE_VERSION,
        product: record.product.into(),
        action: EngineAction::LaunchSession,
        mount_session: record.mount_session,
        origin: record.origin.clone(),
        pubkey: record.pubkey.clone(),
        nonce: uuid::Uuid::new_v4(),
        callback_state_sha256: hex::encode(Sha256::digest(callback_state.as_bytes())),
        expires_at: now + ENGINE_LAUNCH_MAX_TTL_SECONDS,
    };
    intent
        .validate_syntax(now)
        .map_err(|_| "invalid launch scope")?;
    let body = serde_json::to_vec(&intent).map_err(|_| "launch serialization failed")?;
    let relay_base = relay_api_base_url_with_override(&state);
    let url = format!("{}/api/engine/v1/launch", relay_base.trim_end_matches('/'));
    let auth = build_nip98_auth_header(&Method::POST, &url, &body, &state)?;
    let request = state
        .company_identity_http_client
        .post(&url)
        .header("authorization", auth)
        .header("content-type", "application/json")
        .body(body)
        .timeout(ENGINE_LAUNCH_TIMEOUT);
    let request = crate::company_identity::attach_to_no_redirect_request(&state, &url, request)?;
    let response = request
        .send()
        .await
        .map_err(|_| "relay launch request failed")?;
    if !response.status().is_success() {
        return Err("relay launch denied".into());
    }
    let minted = read_bounded_response(response).await?;
    if minted.code.len() < 32
        || minted.code.len() > 128
        || minted.expires_at <= now
        || minted.expires_at > now + ENGINE_LAUNCH_MAX_TTL_SECONDS
    {
        return Err("relay launch response invalid".into());
    }

    let current = upstream_context(&state)?;
    let still_mounted = state
        .upstream_mounts
        .lock()
        .ok()
        .and_then(|mounts| mounts.get(label).cloned())
        .is_some_and(|mounted| mounted.mount_session == record.mount_session);
    if current != context || !still_mounted {
        return Err("active A2D2 scope changed".into());
    }
    Ok(NativeLaunchResponse {
        code: minted.code,
        mount_session: record.mount_session,
        expires_at: minted.expires_at,
    })
}

/// Mint the one-time provider login code available to a mounted product child.
///
/// Tauri's runtime ACL grants this command only to the product's child-label
/// family at its configured remote origin. This handler provides the exact
/// authority by rechecking the live WebView URL, mount UUID, relay, and active
/// public key before signing.
#[tauri::command]
pub async fn mint_upstream_launch_from_child(
    app: tauri::AppHandle,
    caller: Webview,
    callback_state: String,
) -> Result<NativeLaunchResponse, String> {
    let label = caller.label().to_string();
    if !label.starts_with("upstream-") {
        return Err("upstream launch denied".into());
    }
    let request_origin = caller
        .url()
        .map_err(|_| "upstream view URL unavailable".to_string())?
        .origin()
        .ascii_serialization();
    let state = app.state::<AppState>();
    let record = start_launch(&state, &label, &request_origin)?;
    let response = mint_engine_launch(&app, &label, &record, &callback_state).await;
    if let Err(error) = &response {
        eprintln!("buzz-desktop: upstream launch failed: {error}");
    }
    finish_launch(&state, &label, record.mount_session);
    response
}

/// Install the single remote-child command behind its own plugin ACL.
///
/// Keeping this command out of the application ACL preserves the existing
/// local-main command surface while Tauri still requires an explicit remote
/// capability for this plugin command.
pub fn engine_launch_plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("engine-launch")
        .invoke_handler(tauri::generate_handler![
            #![plugin(engine_launch)]
            mint_upstream_launch_from_child
        ])
        .build()
}

/// Return products with a valid configured origin. Remote views cannot query host setup.
#[tauri::command]
pub fn get_upstream_app_availability(caller: Webview) -> Result<Vec<UpstreamProduct>, String> {
    ensure_trusted_caller(&caller)?;
    Ok(configured_products())
}

/// Check one configured origin before the frontend mounts its child WebView.
#[tauri::command]
pub async fn probe_upstream_app(
    caller: Webview,
    state: State<'_, AppState>,
    product: UpstreamProduct,
    session: String,
) -> Result<String, String> {
    ensure_trusted_caller(&caller)?;
    uuid::Uuid::parse_str(&session).map_err(|_| "Invalid upstream mount session")?;
    let url = product.url()?;
    let context = upstream_context(&state)?;
    probe_endpoint(&state.media_fetch_client, url, UPSTREAM_PROBE_TIMEOUT)
        .await
        .map_err(|failure| failure.user_message(product))?;
    if upstream_context(&state)? != context {
        return Err("The active workspace changed. Try again.".into());
    }
    Ok(session)
}

/// Return the active upstream child to its previous in-product page.
#[tauri::command]
pub fn go_back_upstream_app(
    app: tauri::AppHandle,
    caller: Webview,
    session: String,
) -> Result<(), String> {
    ensure_trusted_caller(&caller)?;
    let session = uuid::Uuid::parse_str(&session).map_err(|_| "Invalid upstream mount session")?;
    let view = [UpstreamProduct::Affine, UpstreamProduct::Plane]
        .into_iter()
        .find_map(|product| app.get_webview(&mount_label(product, session)))
        .ok_or_else(|| "Upstream view is no longer active".to_string())?;
    view.eval("history.back()").map_err(|e| e.to_string())
}

fn validate_bounds(bounds: UpstreamBounds, width: f64, height: f64) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .any(|v| !v.is_finite())
        || bounds.x < 0.0
        || bounds.y < 40.0
        || bounds.width < 1.0
        || bounds.height < 1.0
        || bounds.x + bounds.width > width + 1.0
        || bounds.y + bounds.height > height + 1.0
    {
        return Err("Upstream view is outside the content area".into());
    }
    Ok(())
}

/// Position or close the requesting host's product view. Remote content cannot call this command.
/// A unique mount session prevents an old unmount from closing a newly opened product.
#[tauri::command]
pub async fn sync_upstream_app(
    app: tauri::AppHandle,
    caller: Webview,
    state: State<'_, AppState>,
    product: UpstreamProduct,
    session: String,
    bounds: Option<UpstreamBounds>,
    hidden: bool,
) -> Result<(), String> {
    ensure_trusted_caller(&caller)?;
    let session = uuid::Uuid::parse_str(&session).map_err(|_| "Invalid upstream mount session")?;
    let label = mount_label(product, session);
    let Some(bounds) = bounds else {
        if let Ok(mut mounts) = state.upstream_mounts.lock() {
            mounts.remove(&label);
        }
        if let Some(view) = app.get_webview(&label) {
            view.close().map_err(|e| e.to_string())?;
        }
        return Ok(());
    };
    let window = caller.window();
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    validate_bounds(
        bounds,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )?;
    let position = LogicalPosition::new(bounds.x, bounds.y);
    let size = LogicalSize::new(bounds.width, bounds.height);
    if let Some(view) = app.get_webview(&label) {
        view.set_position(position).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        if hidden { view.hide() } else { view.show() }.map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = product.url()?;
    let pubkey = state
        .keys
        .lock()
        .map_err(|e| e.to_string())?
        .public_key()
        .to_hex();
    let binding = format!(
        "{}:{}:{}:{}:{}",
        app.config().identifier,
        product.name(),
        url.origin().ascii_serialization(),
        relay_ws_url_with_override(&state),
        pubkey
    );
    let store = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, binding.as_bytes());
    // At most one product view per main window. Never affect the host or other native windows.
    for view in window.webviews() {
        if view.label().starts_with("upstream-") {
            if let Ok(mut mounts) = state.upstream_mounts.lock() {
                mounts.remove(view.label());
            }
            view.close().map_err(|e| e.to_string())?;
        }
    }
    let origin = url.origin();
    let popup_app = app.clone();
    let popup_label = label.clone();
    let popup_origin = url.clone();
    let record = UpstreamMountRecord {
        product,
        mount_session: session,
        origin: origin.ascii_serialization(),
        relay: relay_ws_url_with_override(&state),
        pubkey,
        launch_pending: false,
    };
    state
        .upstream_mounts
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), record);
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .initialization_script(ENGINE_LAUNCH_SCRIPT)
        .data_store_identifier(*store.as_bytes())
        .data_directory(
            app.path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())?
                .join("upstream")
                .join(store.to_string()),
        )
        .disable_drag_drop_handler()
        .on_navigation(move |target| {
            // The product's own routes and HTTPS identity providers are allowed, local app protocols are not.
            target.origin() == origin
                || (target.scheme() == "https"
                    && target.username().is_empty()
                    && target.password().is_none()
                    && target
                        .host_str()
                        .is_some_and(|h| h != "localhost" && !h.ends_with(".localhost")))
        })
        .on_new_window(move |target, _| {
            let dispatch_app = popup_app.clone();
            let dispatch_label = popup_label.clone();
            let _ = reuse_same_origin_new_window(product, target, &popup_origin, |url, action| {
                let app = dispatch_app.clone();
                let label = dispatch_label.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(view) = app.get_webview(&label) else {
                        eprintln!("buzz-desktop: upstream popup target is no longer active");
                        return;
                    };
                    match action {
                        SameOriginPopupAction::Navigate => match view.navigate(url) {
                            Ok(()) => eprintln!("buzz-desktop: reused same-origin upstream popup"),
                            Err(error) => {
                                eprintln!("buzz-desktop: failed to reuse upstream view: {error}")
                            }
                        },
                        SameOriginPopupAction::Download => match download_script(&url)
                            .and_then(|script| view.eval(&script).map_err(|error| error.to_string()))
                        {
                            Ok(()) => eprintln!("buzz-desktop: dispatched upstream download"),
                            Err(error) => {
                                eprintln!("buzz-desktop: failed to dispatch upstream download: {error}")
                            }
                        }
                    }
                });
                Ok::<(), std::convert::Infallible>(())
            });
            // Reuse the mounted child for same-product links. Never allocate a popup WebView.
            tauri::webview::NewWindowResponse::Deny
        });
    let view = match window.add_child(builder, position, size) {
        Ok(view) => view,
        Err(error) => {
            if let Ok(mut mounts) = state.upstream_mounts.lock() {
                mounts.remove(&label);
            }
            return Err(error.to_string());
        }
    };
    if hidden {
        view.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn products_with(affine: Option<&str>, plane: Option<&str>) -> Vec<UpstreamProduct> {
        configured_products_with(|product| match product {
            UpstreamProduct::Affine => affine.map(str::to_owned),
            UpstreamProduct::Plane => plane.map(str::to_owned),
        })
    }

    async fn one_response(status: u16) -> (Url, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            stream
                .write_all(
                    format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\n\r\n").as_bytes(),
                )
                .await
                .unwrap();
        });
        (Url::parse(&format!("http://{address}")).unwrap(), task)
    }

    #[test]
    fn configured_product_matrix_uses_valid_native_endpoints() {
        assert_eq!(products_with(None, None), vec![]);
        assert_eq!(
            products_with(Some("http://127.0.0.1:3010"), None),
            vec![UpstreamProduct::Affine]
        );
        assert_eq!(
            products_with(None, Some("http://127.0.0.1:3020")),
            vec![UpstreamProduct::Plane]
        );
        assert_eq!(
            products_with(Some("http://127.0.0.1:3010"), Some("http://127.0.0.1:3020")),
            vec![UpstreamProduct::Affine, UpstreamProduct::Plane]
        );
        assert_eq!(
            products_with(Some("http://remote.example.com"), None),
            vec![]
        );
    }

    #[test]
    fn child_bootstrap_invokes_only_the_dedicated_launch_plugin() {
        assert!(
            ENGINE_LAUNCH_SCRIPT.contains("plugin:engine-launch|mint_upstream_launch_from_child")
        );
        assert!(!ENGINE_LAUNCH_SCRIPT.contains("nativeInvoke('mint_upstream_launch_from_child'"));
        assert_eq!(ENGINE_LAUNCH_SCRIPT.matches("nativeInvoke(").count(), 1);
    }

    #[tokio::test]
    async fn readiness_accepts_http_auth_responses_without_following_them() {
        let client = crate::app_state::build_media_fetch_client().unwrap();
        for status in [302, 401, 403, 405] {
            let (url, server) = one_response(status).await;
            assert!(probe_endpoint(&client, url, Duration::from_secs(1))
                .await
                .is_ok());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn readiness_rejects_rate_limited_response() {
        let client = crate::app_state::build_media_fetch_client().unwrap();
        let (url, server) = one_response(429).await;
        assert_eq!(
            probe_endpoint(&client, url, Duration::from_secs(1)).await,
            Err(ProbeFailure::RateLimited)
        );
        assert_eq!(
            ProbeFailure::RateLimited.user_message(UpstreamProduct::Plane),
            "Plane is temporarily rate limited. Wait a moment, then try again."
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn readiness_rejects_server_errors() {
        let client = crate::app_state::build_media_fetch_client().unwrap();
        for status in [500, 502, 503] {
            let (url, server) = one_response(status).await;
            assert!(probe_endpoint(&client, url, Duration::from_secs(1))
                .await
                .is_err());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn readiness_times_out_a_server_that_never_sends_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let client = crate::app_state::build_media_fetch_client().unwrap();
        let result = probe_endpoint(
            &client,
            Url::parse(&format!("http://{address}")).unwrap(),
            Duration::from_millis(25),
        )
        .await;
        assert!(result.is_err());
        server.abort();
    }
    #[test]
    fn remote_views_cannot_manage_native_host() {
        assert!(!trusted_host(
            "upstream-test",
            &Url::parse("https://affine.example.com").unwrap()
        ));
        assert!(!trusted_host(
            "main",
            &Url::parse("https://affine.example.com").unwrap()
        ));
        assert!(trusted_host(
            "main",
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
    }
    #[test]
    fn bounds_cannot_cover_native_navigation_or_escape_window() {
        assert!(validate_bounds(
            UpstreamBounds {
                x: 260.0,
                y: 80.0,
                width: 700.0,
                height: 500.0
            },
            1000.0,
            700.0
        )
        .is_ok());
        assert!(validate_bounds(
            UpstreamBounds {
                x: 0.0,
                y: 0.0,
                width: 700.0,
                height: 500.0
            },
            1000.0,
            700.0
        )
        .is_err());
        assert!(validate_bounds(
            UpstreamBounds {
                x: 260.0,
                y: 80.0,
                width: f64::NAN,
                height: 500.0
            },
            1000.0,
            700.0
        )
        .is_err());
    }
    #[test]
    fn upstream_endpoints_accept_https_and_loopback_only() {
        assert!(endpoint("https://affine.example.com").is_ok());
        assert!(endpoint("http://127.0.0.1:3010").is_ok());
        for value in [
            "http://remote.example.com",
            "file:///etc/passwd",
            "tauri://localhost",
            "https://user:secret@example.com",
            "https://example.com/?token=secret",
            "https://tauri.localhost",
            "https://ipc.localhost",
        ] {
            assert!(endpoint(value).is_err(), "{value}");
        }
    }

    #[test]
    fn same_origin_new_window_reuses_the_active_child_and_rejects_external_origins() {
        let configured = Url::parse("https://plane.example.com").unwrap();
        let target = Url::parse("https://plane.example.com/work-items/123").unwrap();
        let mut navigated = None;
        assert!(reuse_same_origin_new_window(
            UpstreamProduct::Plane,
            target.clone(),
            &configured,
            |url, action| {
                navigated = Some((url, action));
                Ok::<(), ()>(())
            }
        ));
        assert_eq!(navigated, Some((target, SameOriginPopupAction::Navigate)));

        let mut external_navigated = false;
        assert!(!reuse_same_origin_new_window(
            UpstreamProduct::Plane,
            Url::parse("https://accounts.example.com/login").unwrap(),
            &configured,
            |_, _| {
                external_navigated = true;
                Ok::<(), ()>(())
            }
        ));
        assert!(!external_navigated);
    }

    #[test]
    fn plane_attachment_popups_dispatch_a_child_session_download() {
        let configured = Url::parse("https://plane.example.com").unwrap();
        let target = Url::parse(
            "https://plane.example.com/api/assets/v2/workspaces/native-qa/projects/4dae6436-a213-43c4-82c7-4e4a4fe08907/issues/88d18819-b621-4fdf-8dd3-8ab5344554a6/attachments/3d691af7-565f-4d38-97d7-c6a6588d2bee/",
        )
        .unwrap();
        let mut action = None;
        assert!(reuse_same_origin_new_window(
            UpstreamProduct::Plane,
            target.clone(),
            &configured,
            |url, dispatched| {
                assert_eq!(url, target);
                action = Some(dispatched);
                Ok::<(), ()>(())
            }
        ));
        assert_eq!(action, Some(SameOriginPopupAction::Download));

        for rejected in [
            "https://plane.example.com/api/assets/v2/workspaces/native-qa/projects/not-a-uuid/issues/88d18819-b621-4fdf-8dd3-8ab5344554a6/attachments/3d691af7-565f-4d38-97d7-c6a6588d2bee/",
            "https://plane.example.com/api/assets/v2/workspaces/native-qa/projects/4dae6436-a213-43c4-82c7-4e4a4fe08907/issues/88d18819-b621-4fdf-8dd3-8ab5344554a6/attachments/3d691af7-565f-4d38-97d7-c6a6588d2bee/?token=secret",
        ] {
            assert!(!is_plane_attachment_download(
                UpstreamProduct::Plane,
                &Url::parse(rejected).unwrap()
            ));
        }
        assert!(!is_plane_attachment_download(
            UpstreamProduct::Affine,
            &target
        ));
    }

    #[test]
    fn upstream_download_script_uses_a_download_link_without_exposing_new_ipc() {
        let url = Url::parse("https://plane.example.com/downloads/file?a=1&b=2").unwrap();
        let script = download_script(&url).unwrap();
        assert!(script.contains("link.download = ''"));
        assert!(script.contains("link.click()"));
        assert!(script.contains("a=1&b=2"));
    }
}
