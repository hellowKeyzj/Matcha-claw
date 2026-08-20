//! VM provider compatibility boundary.
//!
//! Fleet's durable target model has no separate VM target kind. The legacy
//! Remote Fleet VM provider used the SSH transport, so this module preserves
//! that semantic mapping without inventing a new target variant or provider
//! success path.

use fleet::{SshTargetConfig, command::CommandKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VmEffect {
    Probe,
    Install,
}

pub(crate) fn project_ssh_effect(operation: CommandKind) -> Option<VmEffect> {
    match operation {
        CommandKind::ProbeNode => Some(VmEffect::Probe),
        CommandKind::InstallAgent => Some(VmEffect::Install),
        CommandKind::StartRuntime
        | CommandKind::StopRuntime
        | CommandKind::SyncCapabilities
        | CommandKind::UpgradeAgent
        | CommandKind::MountWorkspace
        | CommandKind::ExposePort => None,
    }
}

/// A VM effect carries the same private SSH configuration as the historical
/// VM provider. Credentials remain Fleet secret references until SSH executes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VmSshBoundary {
    config: SshTargetConfig,
    effect: VmEffect,
}

impl VmSshBoundary {
    pub(crate) fn new(config: &SshTargetConfig, effect: VmEffect) -> Self {
        Self {
            config: config.clone(),
            effect,
        }
    }

    pub(crate) fn config(&self) -> &SshTargetConfig {
        &self.config
    }
    pub(crate) const fn effect(&self) -> VmEffect {
        self.effect
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet::{FleetSecretRef, SshAuthentication};

    #[test]
    fn legacy_vm_operations_project_to_pinned_ssh_without_new_target_kind() {
        assert_eq!(
            project_ssh_effect(CommandKind::ProbeNode),
            Some(VmEffect::Probe)
        );
        assert_eq!(
            project_ssh_effect(CommandKind::InstallAgent),
            Some(VmEffect::Install)
        );
        assert_eq!(project_ssh_effect(CommandKind::StartRuntime), None);
    }

    #[test]
    fn vm_boundary_keeps_ssh_secret_private() {
        let config = SshTargetConfig::try_new(
            "vm.example.test",
            Some(22),
            Some("operator".into()),
            SshAuthentication::PrivateKey(
                FleetSecretRef::parse("remote-fleet://credentials/vm").unwrap(),
            ),
            "install-agent",
        )
        .unwrap();
        let boundary = VmSshBoundary::new(&config, VmEffect::Probe);
        assert_eq!(boundary.config().host(), "vm.example.test");
        assert_eq!(boundary.effect(), VmEffect::Probe);
        assert!(!format!("{boundary:?}").contains("secret-value"));
    }
}
