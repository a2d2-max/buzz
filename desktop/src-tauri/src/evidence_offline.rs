use std::ffi::OsStr;

const EVIDENCE_OFFLINE_ENV: &str = "BUZZ_OPS_EVIDENCE_OFFLINE";
pub(crate) const OFFLINE_PROXY_URL: &str = "http://127.0.0.1:1";

fn enabled_from(value: Option<&OsStr>, debug_assertions: bool) -> bool {
    debug_assertions && value == Some(OsStr::new("1"))
}

pub(crate) fn enabled() -> bool {
    enabled_from(
        std::env::var_os(EVIDENCE_OFFLINE_ENV).as_deref(),
        cfg!(debug_assertions),
    )
}

fn proxy_url_from(enabled: bool) -> Option<&'static str> {
    enabled.then_some(OFFLINE_PROXY_URL)
}

pub(crate) fn proxy_url() -> Option<&'static str> {
    proxy_url_from(enabled())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StartupSideEffectPolicy {
    pub(crate) allow_managed_agent_restore: bool,
    pub(crate) start_periodic_agent_sweep: bool,
    pub(crate) start_periodic_event_publish: bool,
}

pub(crate) fn startup_side_effect_policy(
    evidence_offline: bool,
    restore_agents: bool,
    recovery_mode: bool,
) -> StartupSideEffectPolicy {
    StartupSideEffectPolicy {
        allow_managed_agent_restore: !evidence_offline && restore_agents && !recovery_mode,
        start_periodic_agent_sweep: !evidence_offline,
        start_periodic_event_publish: !evidence_offline && !recovery_mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_offline_mode_is_debug_only_and_requires_exact_one() {
        assert!(enabled_from(Some(OsStr::new("1")), true));
        for value in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("0")),
            Some(OsStr::new("true")),
        ] {
            assert!(!enabled_from(value, true));
        }
        assert!(!enabled_from(Some(OsStr::new("1")), false));
    }

    #[test]
    fn evidence_offline_mode_routes_shared_http_to_loopback_fail_closed_proxy() {
        assert_eq!(proxy_url_from(true), Some(OFFLINE_PROXY_URL));
        assert_eq!(proxy_url_from(false), None);
    }

    #[test]
    fn evidence_startup_policy_disables_agent_spawn_system_sweep_and_external_publish() {
        let offline = startup_side_effect_policy(true, true, false);
        assert_eq!(
            offline,
            StartupSideEffectPolicy {
                allow_managed_agent_restore: false,
                start_periodic_agent_sweep: false,
                start_periodic_event_publish: false,
            }
        );

        assert_eq!(
            startup_side_effect_policy(false, true, false),
            StartupSideEffectPolicy {
                allow_managed_agent_restore: true,
                start_periodic_agent_sweep: true,
                start_periodic_event_publish: true,
            }
        );
        assert_eq!(
            startup_side_effect_policy(false, false, false),
            StartupSideEffectPolicy {
                allow_managed_agent_restore: false,
                start_periodic_agent_sweep: true,
                start_periodic_event_publish: true,
            }
        );
        assert_eq!(
            startup_side_effect_policy(false, true, true),
            StartupSideEffectPolicy {
                allow_managed_agent_restore: false,
                start_periodic_agent_sweep: true,
                start_periodic_event_publish: false,
            }
        );
    }
}
