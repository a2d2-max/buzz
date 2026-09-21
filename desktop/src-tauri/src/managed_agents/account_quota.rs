//! Remaining subscription quota for one stored provider account.
//!
//! This is the *subscription* side of usage — "how much of the plan is left" —
//! and it is deliberately separate from the token/cost archive in
//! `archive::agent_usage`, which answers "how much was spent". Neither can be
//! derived from the other: a plan's remaining percentage lives only on the
//! provider, and a flat-rate plan's spend never appears in a local log.
//!
//! Both providers are read through the path that already owns their
//! credentials, so no extra secret ever crosses this module:
//!
//! * Claude — spawn `claude -p "/usage" --output-format json` against the
//!   account's own login, exactly as [`crate::commands::claude_accounts`]
//!   spawns `claude auth status --json`. A `config_dir` login keeps its OAuth
//!   token in an OS keychain item owned by Claude Code; reading that item from
//!   the desktop binary would prompt the owner (or fail), so the CLI that
//!   already owns it does the read. The slash command resolves locally — it
//!   costs no tokens and starts no model turn.
//! * Codex — read the account's app-owned `CODEX_HOME/auth.json` and ask
//!   ChatGPT directly. That file belongs to Buzz, so no keychain is involved.
//!   Only `access_token` is read; `refresh_token` is never used, because
//!   spending it here would rotate the value out from under the login Buzz
//!   spawns agents with.
//!
//! The parsing helpers are pure so they can be tested without a provider.

use serde::Serialize;

/// Longest provider payload this module will look at. Both providers answer in
/// well under a kilobyte; anything larger is a changed contract, not data.
pub(crate) const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// Upper bound on rendered rows, so a provider cannot grow the settings list
/// without a code change here.
pub(crate) const MAX_WINDOWS: usize = 8;

/// One rate-limit window as the provider reports it (a session window, a
/// weekly window, a per-model weekly window, …).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// Provider's own name for the window, shown verbatim.
    pub label: String,
    /// Percent of the window consumed, or `None` when the provider reported a
    /// window without a number. Never defaulted to zero: an unknown value and
    /// a fresh window must not look the same.
    pub used_percent: Option<f64>,
    /// Human reset text as the provider phrased it, already localized by them.
    pub resets_at: Option<String>,
}

/// Why a quota reading is or is not usable. The UI picks its treatment from
/// this rather than sniffing the message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountQuotaState {
    /// Windows below are current.
    Ok,
    /// The provider says this account is out of quota right now.
    LimitReached,
    /// The account's login is missing or expired; the owner must sign in again.
    NeedsLogin,
    /// This account kind has no subscription quota to report (an API-key
    /// account bills per request).
    NotApplicable,
    /// The reading failed. `message` says why; the row must not render zeros.
    Unavailable,
}

/// Quota for one account, as returned to the settings UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuota {
    pub state: AccountQuotaState,
    /// Plan name when the provider names one (`max`, `pro`, …).
    pub plan: Option<String>,
    pub windows: Vec<QuotaWindow>,
    /// Failure reason, or the provider's own summary line when it carried
    /// wording the parsed windows do not. Never contains a credential.
    pub message: Option<String>,
}

impl AccountQuota {
    /// A reading that failed, carrying the reason instead of empty numbers.
    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            state: AccountQuotaState::Unavailable,
            plan: None,
            windows: Vec::new(),
            message: Some(message.into()),
        }
    }

    /// The owner has to sign in again before any number can be read.
    pub(crate) fn needs_login(message: impl Into<String>) -> Self {
        Self {
            state: AccountQuotaState::NeedsLogin,
            plan: None,
            windows: Vec::new(),
            message: Some(message.into()),
        }
    }
}

/// Pull the `result` string out of `claude -p --output-format json`.
///
/// Returns `Err` when the envelope is missing or reports an error, so a
/// failed run can never be presented as an empty-but-successful reading.
pub(crate) fn claude_usage_result_text(stdout: &[u8]) -> Result<String, String> {
    if stdout.len() > MAX_PAYLOAD_BYTES {
        return Err("Claude returned more output than this reading accepts".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|_| "Claude returned an unreadable usage response".to_string())?;
    if value.get("is_error").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(value
            .get("result")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Claude reported an error reading usage")
            .to_string());
    }
    value
        .get("result")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Claude returned no usage text".to_string())
}

/// Parse the `/usage` report Claude Code renders for its own users.
///
/// Each measured line reads
/// `Current week (all models): 24% used · resets Sep 13 at 10:59pm (Asia/Seoul)`.
/// Lines that carry no percentage (the leading "You are currently using your
/// subscription…" sentence, for one) are not windows and are skipped here; the
/// caller keeps the full text so nothing the provider said is lost.
pub(crate) fn parse_claude_usage_text(text: &str) -> Vec<QuotaWindow> {
    let mut windows = Vec::new();
    for line in text.lines() {
        if windows.len() >= MAX_WINDOWS {
            break;
        }
        let line = line.trim();
        let Some((label, rest)) = line.split_once(':') else {
            continue;
        };
        let label = label.trim();
        if label.is_empty() {
            continue;
        }
        let Some(used_percent) = leading_percent(rest) else {
            continue;
        };
        windows.push(QuotaWindow {
            label: label.to_string(),
            used_percent: Some(used_percent),
            resets_at: reset_phrase(rest),
        });
    }
    windows
}

/// `" 24% used · resets …"` → `24.0`. `None` when the segment opens with
/// anything other than a number followed by `%`.
fn leading_percent(rest: &str) -> Option<f64> {
    let rest = rest.trim_start();
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if digits.is_empty() || !rest[digits.len()..].starts_with('%') {
        return None;
    }
    digits.parse::<f64>().ok()
}

/// `"… · resets Sep 13 at 10:59pm (Asia/Seoul)"` → `"Sep 13 at 10:59pm (Asia/Seoul)"`.
fn reset_phrase(rest: &str) -> Option<String> {
    let (_, after) = rest.split_once("resets")?;
    let phrase = after.trim().trim_end_matches('.').trim();
    if phrase.is_empty() {
        None
    } else {
        Some(phrase.to_string())
    }
}

/// Parse ChatGPT's Codex usage document into the same shape.
///
/// The payload nests a primary/secondary window under `rate_limit` and repeats
/// that shape once per extra metered feature in `additional_rate_limits`.
pub(crate) fn parse_codex_usage(body: &str) -> Result<AccountQuota, String> {
    if body.len() > MAX_PAYLOAD_BYTES {
        return Err("ChatGPT returned more output than this reading accepts".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "ChatGPT returned an unreadable usage response".to_string())?;

    let plan = value
        .get("plan_type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let root = value.get("rate_limit");
    let limit_reached = root
        .and_then(|limit| limit.get("limit_reached"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let mut windows = Vec::new();
    push_codex_windows(root, "Weekly limit", &mut windows);
    if let Some(extras) = value
        .get("additional_rate_limits")
        .and_then(serde_json::Value::as_array)
    {
        for extra in extras {
            let name = extra
                .get("limit_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Additional limit");
            push_codex_windows(extra.get("rate_limit"), name, &mut windows);
        }
    }

    if windows.is_empty() {
        return Err("ChatGPT reported no rate-limit windows".to_string());
    }
    Ok(AccountQuota {
        state: if limit_reached {
            AccountQuotaState::LimitReached
        } else {
            AccountQuotaState::Ok
        },
        plan,
        windows,
        message: None,
    })
}

/// Append the primary and secondary windows of one `rate_limit` object.
///
/// A window whose whole span is already spent is still worth showing, so a
/// zero percentage is kept; only a missing object is dropped.
fn push_codex_windows(
    limit: Option<&serde_json::Value>,
    label: &str,
    windows: &mut Vec<QuotaWindow>,
) {
    let Some(limit) = limit else {
        return;
    };
    for (key, suffix) in [("primary_window", ""), ("secondary_window", " (secondary)")] {
        if windows.len() >= MAX_WINDOWS {
            return;
        }
        let Some(window) = limit.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        windows.push(QuotaWindow {
            label: format!("{label}{suffix}"),
            used_percent: window
                .get("used_percent")
                .and_then(serde_json::Value::as_f64),
            resets_at: window
                .get("reset_after_seconds")
                .and_then(serde_json::Value::as_i64)
                .map(humanize_reset_seconds),
        });
    }
}

/// `466030` → `"in 5 days"`. Coarse on purpose: the row is a glance, and the
/// provider's own second-level precision goes stale while the panel is open.
fn humanize_reset_seconds(seconds: i64) -> String {
    if seconds <= 0 {
        return "now".to_string();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("in {minutes} min");
    }
    let hours = minutes / 60;
    if hours < 48 {
        return format!("in {hours}h");
    }
    format!("in {} days", hours / 24)
}

/// Read `access_token` and `account_id` out of a Codex `auth.json`.
///
/// `refresh_token` is deliberately not returned: rotating it here would log the
/// spawned agents out of the same home.
pub(crate) fn codex_access_token(auth_json: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(auth_json).ok()?;
    let tokens = value.get("tokens")?;
    let access = tokens.get("access_token")?.as_str()?;
    let account = tokens.get("account_id")?.as_str()?;
    if access.is_empty() || account.is_empty() {
        return None;
    }
    Some((access.to_string(), account.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim `result` text from `claude -p "/usage" --output-format json`.
    const CLAUDE_TEXT: &str = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 2% used · resets Sep 10 at 8:39pm (Asia/Seoul)\nCurrent week (all models): 24% used · resets Sep 13 at 10:59pm (Asia/Seoul)\nCurrent week (Fable): 38% used · resets Sep 13 at 10:59pm (Asia/Seoul)";

    #[test]
    fn parses_every_measured_claude_line_and_skips_the_prose() {
        let windows = parse_claude_usage_text(CLAUDE_TEXT);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "Current session");
        assert_eq!(windows[0].used_percent, Some(2.0));
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("Sep 10 at 8:39pm (Asia/Seoul)")
        );
        assert_eq!(windows[2].label, "Current week (Fable)");
        assert_eq!(windows[2].used_percent, Some(38.0));
    }

    #[test]
    fn a_line_without_a_percentage_is_not_a_window() {
        // The leading sentence has a colon-free shape and no number; a future
        // note line with a colon must not become a zero-percent row either.
        let windows = parse_claude_usage_text("Note: your plan renews monthly");
        assert!(windows.is_empty());
    }

    #[test]
    fn claude_window_count_is_bounded() {
        let line = "Current week (model): 1% used · resets soon\n";
        let windows = parse_claude_usage_text(&line.repeat(MAX_WINDOWS + 5));
        assert_eq!(windows.len(), MAX_WINDOWS);
    }

    #[test]
    fn claude_envelope_error_is_not_reported_as_an_empty_reading() {
        let stdout = br#"{"is_error":true,"result":"Invalid API key"}"#;
        let error = claude_usage_result_text(stdout).expect_err("error envelope must not parse");
        assert_eq!(error, "Invalid API key");
    }

    #[test]
    fn claude_result_text_is_extracted() {
        let stdout = br#"{"is_error":false,"result":"Current session: 5% used"}"#;
        let text = claude_usage_result_text(stdout).expect("result text");
        assert_eq!(text, "Current session: 5% used");
    }

    #[test]
    fn oversized_claude_payload_is_rejected() {
        let stdout = vec![b'x'; MAX_PAYLOAD_BYTES + 1];
        assert!(claude_usage_result_text(&stdout).is_err());
    }

    #[test]
    fn codex_limit_reached_and_extra_features_are_reported() {
        let body = r#"{
          "plan_type": "pro",
          "rate_limit": {
            "limit_reached": true,
            "primary_window": {"used_percent": 100, "reset_after_seconds": 466030},
            "secondary_window": null
          },
          "additional_rate_limits": [
            {"limit_name": "GPT-5.3-Codex-Spark",
             "rate_limit": {"primary_window": {"used_percent": 0, "reset_after_seconds": 18000},
                            "secondary_window": {"used_percent": 100, "reset_after_seconds": 468000}}}
          ]
        }"#;
        let quota = parse_codex_usage(body).expect("codex usage");
        assert_eq!(quota.state, AccountQuotaState::LimitReached);
        assert_eq!(quota.plan.as_deref(), Some("pro"));
        assert_eq!(quota.windows.len(), 3);
        assert_eq!(quota.windows[0].label, "Weekly limit");
        assert_eq!(quota.windows[0].used_percent, Some(100.0));
        assert_eq!(quota.windows[0].resets_at.as_deref(), Some("in 5 days"));
        assert_eq!(quota.windows[2].label, "GPT-5.3-Codex-Spark (secondary)");
    }

    #[test]
    fn codex_payload_without_windows_is_an_error_not_an_empty_ok() {
        let error = parse_codex_usage(r#"{"plan_type":"pro"}"#)
            .expect_err("a payload with no windows must fail");
        assert!(error.contains("no rate-limit windows"));
    }

    #[test]
    fn codex_refresh_token_is_never_returned() {
        let auth = r#"{"tokens":{"access_token":"a","refresh_token":"r","account_id":"b"}}"#;
        let (access, account) = codex_access_token(auth).expect("tokens");
        assert_eq!(access, "a");
        assert_eq!(account, "b");
        assert!(codex_access_token(r#"{"tokens":{"refresh_token":"r"}}"#).is_none());
    }

    #[test]
    fn reset_seconds_stay_coarse_across_each_boundary() {
        assert_eq!(humanize_reset_seconds(0), "now");
        assert_eq!(humanize_reset_seconds(1800), "in 30 min");
        assert_eq!(humanize_reset_seconds(7200), "in 2h");
        assert_eq!(humanize_reset_seconds(466_030), "in 5 days");
    }
}
