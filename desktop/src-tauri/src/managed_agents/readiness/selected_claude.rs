use super::{EffectiveAgentEnv, Requirement};
use crate::managed_agents::AcpAvailabilityStatus;

pub(super) fn requirements(
    effective: &EffectiveAgentEnv,
    default_probe: impl FnOnce() -> Vec<Requirement>,
) -> Vec<Requirement> {
    if effective.selected_claude_account_unready {
        return vec![Requirement::CliLogin {
            probe_args: vec!["claude".into(), "auth".into(), "status".into()],
            setup_copy:
                "finish the one-time login for the selected Claude account in Settings → Agents"
                    .to_string(),
            availability: AcpAvailabilityStatus::Available,
        }];
    }
    if effective.oauth_token_supplied {
        vec![]
    } else {
        default_probe()
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn selected_unready_bypasses_an_ambient_logged_in_probe() {
        let probe_called = Cell::new(false);
        let effective = EffectiveAgentEnv {
            env: BTreeMap::from([
                ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "fixture".to_string()),
                ("ANTHROPIC_API_KEY".to_string(), "fixture".to_string()),
            ]),
            config_file_path: None,
            oauth_token_supplied: false,
            selected_claude_account_unready: true,
            effective_command: "claude-agent-acp".to_string(),
        };

        let requirements = requirements(&effective, || {
            probe_called.set(true);
            vec![]
        });

        assert!(!requirements.is_empty());
        assert!(
            !probe_called.get(),
            "ambient LoggedIn must not be consulted"
        );
        assert!(
            matches!(&requirements[0], Requirement::CliLogin { setup_copy, .. } if setup_copy.contains("selected Claude account"))
        );
    }
}
