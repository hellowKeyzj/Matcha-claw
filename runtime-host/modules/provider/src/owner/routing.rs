use std::collections::BTreeSet;

use crate::{
    ProviderAccountId, ProviderCascade, ProviderCascadeFault, ProviderRouting,
    ProviderRoutingStoreFault,
    application::receipts::{
        ProviderCommitOutcome, ProviderNativeConfigurationView, ProviderPersistedOutcome,
        ProviderRoutingReplaceOutcome,
    },
    provider_routing_account_ids, provider_routing_is_admissible,
};

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
