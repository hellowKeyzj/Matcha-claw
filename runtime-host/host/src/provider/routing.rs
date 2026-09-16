use std::collections::BTreeSet;

use crate::provider::{
    accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
    native::ProviderNativeConfigurationView,
};
use environment::{
    ProviderAccountId, ProviderCascade, ProviderCascadeFault, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingStoreFault, provider_routing_account_ids,
    provider_routing_is_admissible,
};

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRoutingListOutcome {
    Desired(Option<ProviderRoutingView>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderRoutingView {
    pub(crate) revision: u64,
    pub(crate) routes: Vec<ProviderRouteView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderRouteView {
    pub(crate) capability: &'static str,
    pub(crate) primary: ProviderModelReferenceView,
    pub(crate) fallbacks: Vec<ProviderModelReferenceView>,
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderModelReferenceView {
    pub(crate) account_id: String,
    pub(crate) model_id: String,
}

impl ProviderRoutingView {
    pub(crate) fn from_routing(routing: &ProviderRouting) -> Self {
        Self {
            revision: routing.revision().get(),
            routes: routing
                .routes()
                .iter()
                .map(|(capability, route)| ProviderRouteView {
                    capability: provider_routing_capability_name(*capability),
                    primary: ProviderModelReferenceView::from_reference(route.primary()),
                    fallbacks: route
                        .fallbacks()
                        .iter()
                        .map(ProviderModelReferenceView::from_reference)
                        .collect(),
                    timeout_ms: route.timeout_ms(),
                })
                .collect(),
        }
    }
}

impl ProviderModelReferenceView {
    fn from_reference(reference: &environment::ProviderModelReference) -> Self {
        Self {
            account_id: reference.account_id().as_str().to_owned(),
            model_id: reference.model_id().to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRoutingReplaceOutcome {
    /// Desired routing is durable. Configuration is a separate private projection, never runtime
    /// acceptance, health, or observed state.
    DesiredStored {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
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

    pub(super) fn replace(
        &mut self,
        cascade: &mut ProviderCascade,
        routing: ProviderRouting,
    ) -> ProviderRoutingReplaceOutcome {
        if cascade.reload().is_err() {
            return ProviderRoutingReplaceOutcome::Unavailable;
        }
        if !provider_routing_is_admissible(&routing, cascade.accounts(), cascade.catalog()) {
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
            native: ProviderNativeConfigurationView::unavailable(),
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
    ) -> BTreeSet<ProviderAccountId> {
        cascade
            .routing()
            .map(provider_routing_account_ids)
            .unwrap_or_default()
    }
}

const fn provider_routing_capability_name(capability: ProviderRoutingCapability) -> &'static str {
    match capability {
        ProviderRoutingCapability::Chat => "chat",
        ProviderRoutingCapability::ImageUnderstand => "imageUnderstand",
        ProviderRoutingCapability::ImageGenerate => "imageGenerate",
        ProviderRoutingCapability::VideoGenerate => "videoGenerate",
        ProviderRoutingCapability::MusicGenerate => "musicGenerate",
        ProviderRoutingCapability::Tts => "tts",
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
                native: ProviderNativeConfigurationView::unavailable(),
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
    use environment::{
        ProviderModel, ProviderModelCapability, provider_model_matches_routing_reference,
        provider_routing_model_capability,
    };

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
        assert!(provider_model_matches_routing_reference(
            &model(vec![ProviderModelCapability::ImageGenerate]),
            ProviderRoutingCapability::ImageGenerate,
            &reference,
        ));
        assert!(!provider_model_matches_routing_reference(
            &model(vec![ProviderModelCapability::Chat]),
            ProviderRoutingCapability::ImageGenerate,
            &reference,
        ));
    }

    #[test]
    fn routing_capabilities_map_to_final_provider_model_capabilities() {
        assert_eq!(
            provider_routing_model_capability(ProviderRoutingCapability::Tts),
            ProviderModelCapability::TextToSpeech
        );
        assert_eq!(
            provider_routing_model_capability(ProviderRoutingCapability::ImageUnderstand),
            ProviderModelCapability::ImageUnderstand
        );
    }
}
