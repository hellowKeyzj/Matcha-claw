use std::collections::BTreeSet;

use environment::{
    ProviderAccount, ProviderAccountStore, ProviderModel, ProviderModelCapability,
    ProviderModelStore, ProviderRouting, ProviderRoutingCapability, ProviderRoutingStore,
    ProviderRoutingStoreFault,
};
use openclaw::port::ProviderNativeConfigurationEffect;

use crate::{
    composition::Host,
    provider_accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRoutingListOutcome {
    Desired(Option<ProviderRouting>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRoutingReplaceOutcome {
    /// Desired routing is durable. Configuration is a separate private projection, never runtime
    /// acceptance, health, or observed state.
    DesiredStored {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationEffect,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Unavailable,
}

pub(crate) struct ProviderRoutingOwner {
    accounts: ProviderAccountStore,
    models: ProviderModelStore,
    routing: ProviderRoutingStore,
}

impl ProviderRoutingOwner {
    pub(crate) fn new(
        accounts: ProviderAccountStore,
        models: ProviderModelStore,
        routing: ProviderRoutingStore,
    ) -> Self {
        Self {
            accounts,
            models,
            routing,
        }
    }

    pub(crate) fn desired(&self) -> Option<&ProviderRouting> {
        self.routing.routing()
    }

    fn replace(&mut self, routing: ProviderRouting) -> ProviderRoutingReplaceOutcome {
        if self.accounts.reload().is_err()
            || self.models.reload().is_err()
            || self.routing.reload().is_err()
        {
            return ProviderRoutingReplaceOutcome::Unavailable;
        }
        if !routing
            .routes()
            .iter()
            .all(|(capability, route)| self.route_is_admissible(*capability, route))
        {
            return ProviderRoutingReplaceOutcome::Rejected;
        }
        if let Err(fault) = self.routing.replace(routing.clone()) {
            return replace_fault(fault);
        }
        let confirmed = self.routing.routing() == Some(&routing);
        ProviderRoutingReplaceOutcome::DesiredStored {
            persisted: if confirmed {
                ProviderPersistedOutcome::Confirmed
            } else {
                ProviderPersistedOutcome::Unknown
            },
            native: ProviderNativeConfigurationEffect::Unavailable,
            commit: if confirmed {
                ProviderCommitOutcome::Committed
            } else {
                ProviderCommitOutcome::CommitOutcomeUnknown
            },
        }
    }

    fn route_account_ids(&self) -> BTreeSet<environment::ProviderAccountId> {
        self.routing
            .routing()
            .map(|routing| {
                routing
                    .routes()
                    .iter()
                    .flat_map(|(_, route)| std::iter::once(route.primary()).chain(route.fallbacks()))
                    .map(|reference| reference.account_id().clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn route_is_admissible(
        &self,
        capability: ProviderRoutingCapability,
        route: &environment::ProviderRoute,
    ) -> bool {
        self.reference_is_admissible(capability, route.primary())
            && route
                .fallbacks()
                .iter()
                .all(|reference| self.reference_is_admissible(capability, reference))
    }

    fn reference_is_admissible(
        &self,
        capability: ProviderRoutingCapability,
        reference: &environment::ProviderModelReference,
    ) -> bool {
        let Some(account) = self.account_for(reference.account_id()) else {
            return false;
        };
        account.configuration().enabled()
            && self
                .models
                .catalog()
                .models()
                .iter()
                .any(|model| model_matches(model, capability, reference))
    }

    fn account_for(&self, account_id: &environment::ProviderAccountId) -> Option<&ProviderAccount> {
        self.accounts.account(account_id)
    }
}

impl Host {
    pub(crate) fn list_provider_routing(&mut self) -> ProviderRoutingListOutcome {
        if self.admission.admit_request().is_err()
            || self.provider_routing.accounts.reload().is_err()
            || self.provider_routing.models.reload().is_err()
            || self.provider_routing.routing.reload().is_err()
        {
            return ProviderRoutingListOutcome::Unavailable;
        }
        ProviderRoutingListOutcome::Desired(self.provider_routing.desired().cloned())
    }

    pub(crate) async fn replace_provider_routing(
        &mut self,
        routing: ProviderRouting,
    ) -> ProviderRoutingReplaceOutcome {
        if self.admission.admit_request().is_err() {
            return ProviderRoutingReplaceOutcome::Unavailable;
        }
        let outcome = self.provider_routing.replace(routing);
        let ProviderRoutingReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let required_auth_accounts = self.provider_routing.route_account_ids();
        let native = self
            .reconcile_provider_native_configuration(&[], &required_auth_accounts)
            .await;
        ProviderRoutingReplaceOutcome::DesiredStored {
            persisted,
            native,
            commit,
        }
    }
}

fn model_matches(
    model: &ProviderModel,
    capability: ProviderRoutingCapability,
    reference: &environment::ProviderModelReference,
) -> bool {
    model.account_id() == reference.account_id()
        && model.model_id() == reference.model_id()
        && model.supports(model_capability(capability))
}

const fn model_capability(capability: ProviderRoutingCapability) -> ProviderModelCapability {
    match capability {
        ProviderRoutingCapability::Chat => ProviderModelCapability::Chat,
        ProviderRoutingCapability::ImageUnderstand => ProviderModelCapability::ImageUnderstand,
        ProviderRoutingCapability::ImageGenerate => ProviderModelCapability::ImageGenerate,
        ProviderRoutingCapability::VideoGenerate => ProviderModelCapability::VideoGenerate,
        ProviderRoutingCapability::MusicGenerate => ProviderModelCapability::MusicGenerate,
        ProviderRoutingCapability::Tts => ProviderModelCapability::TextToSpeech,
    }
}

fn replace_fault(fault: ProviderRoutingStoreFault) -> ProviderRoutingReplaceOutcome {
    match fault {
        ProviderRoutingStoreFault::Decode
        | ProviderRoutingStoreFault::Encode
        | ProviderRoutingStoreFault::InitialRevisionRequired
        | ProviderRoutingStoreFault::RecordTooLarge
        | ProviderRoutingStoreFault::RevisionConflict
        | ProviderRoutingStoreFault::RevisionMustFollowCurrent
        | ProviderRoutingStoreFault::StaleRevision => ProviderRoutingReplaceOutcome::Rejected,
        ProviderRoutingStoreFault::CommitOutcomeUnknown(_)
        | ProviderRoutingStoreFault::RecoveryRequired => {
            ProviderRoutingReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Unknown,
                native: ProviderNativeConfigurationEffect::Unavailable,
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            }
        }
        ProviderRoutingStoreFault::Commit(_) | ProviderRoutingStoreFault::WriterBusy => {
            ProviderRoutingReplaceOutcome::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_id() -> environment::ProviderAccountId {
        environment::ProviderAccountId::try_new("routing-test").expect("valid account identifier")
    }

    fn model(capabilities: Vec<ProviderModelCapability>) -> ProviderModel {
        ProviderModel::try_new(
            account_id(),
            "model",
            capabilities,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("valid provider model")
    }

    #[test]
    fn routing_model_requires_its_selected_capability() {
        let reference = environment::ProviderModelReference::try_new(account_id(), "model")
            .expect("valid model reference");
        assert!(model_matches(
            &model(vec![ProviderModelCapability::ImageGenerate]),
            ProviderRoutingCapability::ImageGenerate,
            &reference,
        ));
        assert!(!model_matches(
            &model(vec![ProviderModelCapability::Chat]),
            ProviderRoutingCapability::ImageGenerate,
            &reference,
        ));
    }

    #[test]
    fn routing_capabilities_map_to_final_provider_model_capabilities() {
        assert_eq!(
            model_capability(ProviderRoutingCapability::Tts),
            ProviderModelCapability::TextToSpeech
        );
        assert_eq!(
            model_capability(ProviderRoutingCapability::ImageUnderstand),
            ProviderModelCapability::ImageUnderstand
        );
    }
}
