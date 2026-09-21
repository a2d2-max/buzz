//! Managed AFFiNE/Plane session broker HTTP surface.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use buzz_core::engine_bridge::{EngineLaunchIntent, EngineProduct};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    engine_sessions::{
        EngineLaunchScope, EngineProviderConfig, EngineSessionError, EngineSessionScope,
    },
    state::AppState,
};

use super::{
    api_error,
    bridge::{
        check_nip98_replay, enforce_http_admission, nip98_expected_url,
        verify_bridge_auth_with_options,
    },
};

const LAUNCH_PATH: &str = "/api/engine/v1/launch";
const TIMESTAMP_HEADER: &str = "x-a2d2-engine-timestamp";
const SIGNATURE_HEADER: &str = "x-a2d2-engine-signature";

type ApiError = (StatusCode, Json<Value>);

fn error(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return None;
    };
    value.to_str().ok()
}

fn verify_provider<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    product: EngineProduct,
    origin: &str,
    body: &[u8],
) -> Result<&'a EngineProviderConfig, ApiError> {
    let provider = state
        .engine_session_config
        .provider(product)
        .filter(|provider| provider.origin == origin)
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "broker_unavailable"))?;
    let timestamp = single_header(headers, TIMESTAMP_HEADER)
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "server_auth_invalid"))?;
    let signature = single_header(headers, SIGNATURE_HEADER)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "server_auth_invalid"))?;
    if !provider.verify_server_auth(timestamp, signature, body, Utc::now().timestamp()) {
        return Err(error(StatusCode::UNAUTHORIZED, "server_auth_invalid"));
    }
    Ok(provider)
}

#[derive(Serialize)]
pub(crate) struct LaunchResponse {
    code: String,
    expires_at: i64,
}

/// Mint one body-bound, single-use product launch after NIP-98 and membership.
pub(crate) async fn launch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<LaunchResponse>, ApiError> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;
    let url = nip98_expected_url(&state.config.relay_url, &tenant, LAUNCH_PATH);
    let auth = verify_bridge_auth_with_options(&headers, "POST", &url, Some(&body), true, true)?;
    enforce_http_admission(&state, &tenant, &auth.pubkey).await?;
    check_nip98_replay(&state, &tenant, auth.event_id_bytes).await?;

    let binding: EngineLaunchIntent = serde_json::from_slice(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    binding
        .validate_syntax(Utc::now().timestamp())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if binding.pubkey != auth.pubkey.to_hex() {
        return Err(error(StatusCode::FORBIDDEN, "scope_or_membership_denied"));
    }
    let provider = state
        .engine_session_config
        .provider(binding.product)
        .filter(|provider| provider.origin == binding.origin)
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "broker_unavailable"))?;
    let pubkey = auth.pubkey.to_bytes();
    let member = state
        .db
        .get_relay_member(tenant.community(), &binding.pubkey)
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "broker_unavailable"))?
        .ok_or_else(|| error(StatusCode::FORBIDDEN, "scope_or_membership_denied"))?;
    let minted = state
        .engine_session_broker
        .mint(
            EngineLaunchScope {
                community: tenant.community(),
                pubkey,
                product: binding.product,
                origin: provider.origin.clone(),
                mount_session: binding.mount_session,
                callback_state_sha256: hex::decode(&binding.callback_state_sha256)
                    .ok()
                    .and_then(|bytes| bytes.try_into().ok())
                    .ok_or_else(|| error(StatusCode::BAD_REQUEST, "invalid_request"))?,
                role: member.role,
            },
            Utc::now().timestamp(),
        )
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "broker_unavailable"))?;
    Ok(Json(LaunchResponse {
        code: minted.code,
        expires_at: minted.expires_at,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeRequest {
    code: String,
    product: EngineProduct,
    origin: String,
    mount_session: Uuid,
    callback_state: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    session_token: String,
    product: EngineProduct,
    origin: String,
}

#[derive(Serialize)]
pub(crate) struct SessionResponse {
    session_token: String,
    community_id: Uuid,
    pubkey: String,
    role: String,
    principal_key: String,
    expires_at: i64,
}

fn principal_key(scope: &EngineSessionScope) -> String {
    let product = match scope.product {
        EngineProduct::Affine => "affine",
        EngineProduct::Plane => "plane",
    };
    hex::encode(Sha256::digest(format!(
        "a2d2-engine-principal:v1:{}:{product}:{}",
        scope.community.as_uuid(),
        hex::encode(scope.pubkey)
    )))
}

async fn live_session_response(
    state: &AppState,
    token: String,
    scope: EngineSessionScope,
) -> Result<SessionResponse, ApiError> {
    let pubkey = hex::encode(scope.pubkey);
    let member = state
        .db
        .get_relay_member(scope.community, &pubkey)
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "broker_unavailable"))?;
    let Some(member) = member else {
        state.engine_session_broker.revoke(&token);
        return Err(error(StatusCode::FORBIDDEN, "scope_or_membership_denied"));
    };
    Ok(SessionResponse {
        session_token: token,
        community_id: *scope.community.as_uuid(),
        pubkey,
        role: member.role,
        principal_key: principal_key(&scope),
        expires_at: scope.expires_at,
    })
}

/// Consume one launch code from a product backend.
pub(crate) async fn exchange(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<SessionResponse>, ApiError> {
    let request: ExchangeRequest = serde_json::from_slice(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    verify_provider(&state, &headers, request.product, &request.origin, &body)?;
    let minted = state
        .engine_session_broker
        .exchange(
            &request.code,
            request.product,
            &request.origin,
            request.mount_session,
            request.callback_state.as_bytes(),
            Utc::now().timestamp(),
        )
        .map_err(|failure| match failure {
            EngineSessionError::InvalidLaunch => {
                error(StatusCode::GONE, "launch_invalid_or_expired")
            }
            EngineSessionError::ScopeMismatch => {
                error(StatusCode::FORBIDDEN, "scope_or_membership_denied")
            }
            EngineSessionError::Full | EngineSessionError::InvalidSession => {
                error(StatusCode::SERVICE_UNAVAILABLE, "broker_unavailable")
            }
        })?;
    live_session_response(&state, minted.token, minted.scope)
        .await
        .map(Json)
}

/// Revalidate one product session against current A2D2 membership and role.
pub(crate) async fn check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<SessionResponse>, ApiError> {
    let request: SessionRequest = serde_json::from_slice(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    verify_provider(&state, &headers, request.product, &request.origin, &body)?;
    let scope = state
        .engine_session_broker
        .session(&request.session_token, Utc::now().timestamp())
        .map_err(|_| error(StatusCode::UNAUTHORIZED, "session_invalid_or_expired"))?;
    if scope.product != request.product || scope.origin != request.origin {
        state.engine_session_broker.revoke(&request.session_token);
        return Err(error(StatusCode::FORBIDDEN, "session_scope_mismatch"));
    }
    live_session_response(&state, request.session_token, scope)
        .await
        .map(Json)
}

/// Revoke one product session. The operation is idempotent.
pub(crate) async fn revoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let request: SessionRequest = serde_json::from_slice(&body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    verify_provider(&state, &headers, request.product, &request.origin, &body)?;
    state.engine_session_broker.revoke(&request.session_token);
    Ok(StatusCode::NO_CONTENT)
}
