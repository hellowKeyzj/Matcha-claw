use std::collections::BTreeSet;

use environment::{
    ProviderAccount, ProviderCascade, ProviderCascadeFault, ProviderModel, ProviderModelCapability,
    ProviderRouting, ProviderRoutingCapability, ProviderRoutingStoreFault,
};
use openclaw::port::ProviderNativeConfigurationEffect;

use crate::provider::accounts::{ProviderCommitOutcome, ProviderPersistedOutcome};

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

pub(crate) struct ProviderRoutingOwner;

impl ProviderRoutingOwner {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(super) fn list(&mut self, cascade: &mut ProviderCascade) -> ProviderRoutingListOutcome {
        if cascade.reload().is_err() {
            return ProviderRoutingListOutcome::Unavailable;
        }
        ProviderRoutingListOutcome::Desired(cascade.routing().cloned())
    }

    pub(super) fn replace(
        &mut self,
        cascade: &mut ProviderCascade,
        routing: ProviderRouting,
    ) -> ProviderRoutingReplaceOutcome {
        if cascade.reload().is_err() {
            return ProviderRoutingReplaceOutcome::Unavailable;
        }
        if !routing
            .routes()
            .iter()
            .all(|(capability, route)| self.route_is_admissible(cascade, *capability, route))
        {
            return ProviderRoutingReplaceOutcome::Rejected;
        }
        if let Err(fault) = cascade.replace_routing(routing.clone()) {
            return replace_fault(fault);
        }
        let confirmed = cascade.routing() == Some(&routing);
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

    pub(super) fn route_account_ids(
        &self,
        cascade: &ProviderCascade,
    ) -> BTreeSet<environment::ProviderAccountId> {
        cascade
            .routing()
            .map(|routing| {
                routing
                    .routes()
                    .iter()
                    .flat_map(|(_, route)| {
                        std::iter::once(route.primary()).chain(route.fallbacks())
                    })
                    .map(|reference| reference.account_id().clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn route_is_admissible(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderRoutingCapability,
        route: &environment::ProviderRoute,
    ) -> bool {
        self.reference_is_admissible(cascade, capability, route.primary())
            && route
                .fallbacks()
                .iter()
                .all(|reference| self.reference_is_admissible(cascade, capability, reference))
    }

    fn reference_is_admissible(
        &self,
        cascade: &ProviderCascade,
        capability: ProviderRoutingCapability,
        reference: &environment::ProviderModelReference,
    ) -> bool {
        let Some(account) = self.account_for(cascade, reference.account_id()) else {
            return false;
        };
        account.configuration().enabled()
            && cascade
                .catalog()
                .models()
                .iter()
                .any(|model| model_matches(model, capability, reference))
    }

    fn account_for<'a>(
        &self,
        cascade: &'a ProviderCascade,
        account_id: &environment::ProviderAccountId,
    ) -> Option<&'a ProviderAccount> {
        cascade.account(account_id)
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

fn replace_fault(fault: ProviderCascadeFault) -> ProviderRoutingReplaceOutcome {
    let ProviderCascadeFault::Routing(fault) = fault else {
        return ProviderRoutingReplaceOutcome::Unavailable;
    };
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
