use std::collections::BTreeSet;

use environment::{ProviderAccount, ProviderAccountId, ProviderModelCatalog, ProviderRouting};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::{
        provider_models::{
            ProviderModelProjection, ProviderModelProjectionEffect, ProviderModelProjectionError,
        },
        routing::{
            ProviderRoutingProjection, ProviderRoutingProjectionEffect,
            ProviderRoutingProjectionError,
        },
    },
};

/// Private bootstrap-time projection of already durable desired state into
/// `openclaw.json`. It neither observes a Gateway nor proves config reload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateProjectionEffect {
    pub providers: ConfigWriteEffect,
    pub restart: RestartPreparation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigWriteEffect {
    Unchanged,
    Written,
    Unknown(ProviderProjectionBuildDiagnostic),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderProjectionBuildDiagnostic {
    reason: &'static str,
    expected_path: &'static str,
    detail: String,
}

impl ProviderProjectionBuildDiagnostic {
    pub fn new(
        reason: &'static str,
        expected_path: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            reason,
            expected_path,
            detail: detail.into(),
        }
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }

    pub fn expected_path(&self) -> &'static str {
        self.expected_path
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl ConfigWriteEffect {
    pub fn unknown(reason: &'static str, detail: impl Into<String>) -> Self {
        Self::Unknown(ProviderProjectionBuildDiagnostic::new(
            reason,
            "models.providers",
            detail,
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestartPreparation {
    NotRequired,
    Required,
    Unknown,
}

impl PrivateProjectionEffect {
    pub fn apply(
        state_dir: CanonicalStateDir,
        accounts: &[ProviderAccount],
        models: &ProviderModelCatalog,
        routing: Option<&ProviderRouting>,
        now_millis: u64,
    ) -> Self {
        let required_auth_accounts = accounts
            .iter()
            .map(|account| account.id().clone())
            .collect::<BTreeSet<_>>();
        Self::apply_required_auth(
            state_dir,
            accounts,
            models,
            routing,
            &[],
            &required_auth_accounts,
            now_millis,
        )
    }

    pub fn apply_required_auth(
        state_dir: CanonicalStateDir,
        accounts: &[ProviderAccount],
        models: &ProviderModelCatalog,
        routing: Option<&ProviderRouting>,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<ProviderAccountId>,
        now_millis: u64,
    ) -> Self {
        let providers = project_providers(
            state_dir,
            accounts,
            models,
            routing,
            retired,
            required_auth_accounts,
            now_millis,
        );
        let restart = restart_preparation(&providers);
        Self { providers, restart }
    }
}

fn project_providers(
    state_dir: CanonicalStateDir,
    accounts: &[ProviderAccount],
    models: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    retired: &[ProviderAccount],
    required_auth_accounts: &BTreeSet<ProviderAccountId>,
    now_millis: u64,
) -> ConfigWriteEffect {
    let models_changed = match ProviderModelProjection::apply(
        state_dir.clone(),
        accounts,
        models,
        retired,
        required_auth_accounts,
        now_millis,
    ) {
        Ok(ProviderModelProjectionEffect::ConfigurationWritten { changed }) => changed,
        Err(error) => return ConfigWriteEffect::Unknown(provider_models_diagnostic(error)),
    };
    let routing_changed = match routing {
        Some(routing) => {
            match ProviderRoutingProjection::apply(state_dir, accounts, models, routing, now_millis)
            {
                Ok(ProviderRoutingProjectionEffect::ConfigurationWritten { changed }) => changed,
                Err(error) => return ConfigWriteEffect::Unknown(routing_diagnostic(error)),
            }
        }
        None => false,
    };
    if models_changed || routing_changed {
        ConfigWriteEffect::Written
    } else {
        ConfigWriteEffect::Unchanged
    }
}

fn provider_models_diagnostic(
    error: ProviderModelProjectionError,
) -> ProviderProjectionBuildDiagnostic {
    ProviderProjectionBuildDiagnostic::new(
        error.diagnostic_reason(),
        "models.providers",
        error.to_string(),
    )
}

fn routing_diagnostic(error: ProviderRoutingProjectionError) -> ProviderProjectionBuildDiagnostic {
    ProviderProjectionBuildDiagnostic::new(
        error.diagnostic_reason(),
        "agents.defaults",
        error.to_string(),
    )
}

const fn restart_preparation(providers: &ConfigWriteEffect) -> RestartPreparation {
    if matches!(providers, ConfigWriteEffect::Unknown(_)) {
        RestartPreparation::Unknown
    } else if matches!(providers, ConfigWriteEffect::Written) {
        RestartPreparation::Required
    } else {
        RestartPreparation::NotRequired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_is_prepared_only_for_a_changed_private_projection() {
        assert_eq!(
            restart_preparation(&ConfigWriteEffect::Unchanged),
            RestartPreparation::NotRequired
        );
        assert_eq!(
            restart_preparation(&ConfigWriteEffect::Written),
            RestartPreparation::Required
        );
    }

    #[test]
    fn unknown_config_effect_never_prepares_or_claims_a_restart() {
        assert_eq!(
            restart_preparation(&ConfigWriteEffect::unknown(
                "provider-model-token-limit-invalid",
                "OpenClaw provider model token limit is invalid",
            )),
            RestartPreparation::Unknown
        );
    }
}
