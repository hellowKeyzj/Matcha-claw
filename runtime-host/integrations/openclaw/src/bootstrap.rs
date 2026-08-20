use std::collections::BTreeSet;

use environment::{ProviderAccount, ProviderModelCatalog, ProviderRouting};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::{
        provider_models::{ProviderModelProjection, ProviderModelProjectionEffect},
        routing::{ProviderRoutingProjection, ProviderRoutingProjectionEffect},
    },
};

/// Private bootstrap-time projection of already durable desired state into
/// `openclaw.json`. It neither observes a Gateway nor proves config reload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PrivateProjectionEffect {
    pub providers: ConfigWriteEffect,
    pub restart: RestartPreparation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigWriteEffect {
    Unchanged,
    Written,
    Unknown,
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
        let providers = project_providers(state_dir, accounts, models, routing, now_millis);
        Self {
            providers,
            restart: restart_preparation(providers),
        }
    }
}

fn project_providers(
    state_dir: CanonicalStateDir,
    accounts: &[ProviderAccount],
    models: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    now_millis: u64,
) -> ConfigWriteEffect {
    let required_auth_accounts = accounts
        .iter()
        .map(|account| account.id().clone())
        .collect::<BTreeSet<_>>();
    let models_changed = match ProviderModelProjection::apply(
        state_dir.clone(),
        accounts,
        models,
        &[],
        &required_auth_accounts,
        now_millis,
    ) {
        Ok(ProviderModelProjectionEffect::ConfigurationWritten { changed }) => changed,
        Err(_) => return ConfigWriteEffect::Unknown,
    };
    let routing_changed = match routing {
        Some(routing) => {
            match ProviderRoutingProjection::apply(state_dir, accounts, models, routing, now_millis)
            {
                Ok(ProviderRoutingProjectionEffect::ConfigurationWritten { changed }) => changed,
                Err(_) => return ConfigWriteEffect::Unknown,
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

const fn restart_preparation(providers: ConfigWriteEffect) -> RestartPreparation {
    if matches!(providers, ConfigWriteEffect::Unknown) {
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
            restart_preparation(ConfigWriteEffect::Unchanged),
            RestartPreparation::NotRequired
        );
        assert_eq!(
            restart_preparation(ConfigWriteEffect::Written),
            RestartPreparation::Required
        );
    }

    #[test]
    fn unknown_config_effect_never_prepares_or_claims_a_restart() {
        assert_eq!(
            restart_preparation(ConfigWriteEffect::Unknown),
            RestartPreparation::Unknown
        );
    }
}
