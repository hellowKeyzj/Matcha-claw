use std::sync::Arc;

use world::{
    InvestigationFuture, InvestigationReceipt, InvestigationRequest, InvestigationSentness,
    InvestigationSettlementFuture, InvestigationState, InvestigationUsage, WorldInvestigation,
};
use world_protocol::{api::InvestigationSelection, time::Timestamp};

pub(crate) struct HostWorldInvestigation {
    pub(crate) open_claw: Option<Arc<dyn WorldInvestigation>>,
    pub(crate) matcha: Option<Arc<dyn WorldInvestigation>>,
}

impl HostWorldInvestigation {
    fn selected(&self, selection: &InvestigationSelection) -> Option<&dyn WorldInvestigation> {
        match selection {
            InvestigationSelection::Openclaw { .. } => self.open_claw.as_deref(),
            InvestigationSelection::MatchaAgent { .. } => self.matcha.as_deref(),
        }
    }
}

impl WorldInvestigation for HostWorldInvestigation {
    fn execute<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a> {
        match self.selected(&request.identity.selection) {
            Some(port) => port.execute(request),
            None => unavailable(request, InvestigationSentness::NotSent),
        }
    }

    fn inspect<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a> {
        match self.selected(&request.identity.selection) {
            Some(port) => port.inspect(request),
            None => unavailable(request, InvestigationSentness::MayHaveSent),
        }
    }

    fn cancel<'a>(
        &'a self,
        request: InvestigationRequest,
        requested_at: Timestamp,
    ) -> InvestigationFuture<'a> {
        match self.selected(&request.identity.selection) {
            Some(port) => port.cancel(request, requested_at),
            None => unavailable(request, InvestigationSentness::MayHaveSent),
        }
    }

    fn settle<'a>(
        &'a self,
        request: InvestigationRequest,
        settled_at: Timestamp,
    ) -> InvestigationSettlementFuture<'a> {
        match self.selected(&request.identity.selection) {
            Some(port) => port.settle(request, settled_at),
            None => Box::pin(async {
                Err(world::NativeVerificationError::new(
                    world_protocol::authorization::AuthorizationFailure::InvalidDelegation,
                    std::io::Error::new(std::io::ErrorKind::NotConnected, "world.investigation_peer_unavailable"),
                ))
            }),
        }
    }
}

fn unavailable<'a>(
    request: InvestigationRequest,
    sentness: InvestigationSentness,
) -> InvestigationFuture<'a> {
    Box::pin(async move {
        InvestigationReceipt {
            identity: request.identity,
            state: InvestigationState::Unavailable,
            sentness,
            accepted: None,
            usage: InvestigationUsage::Unavailable,
        }
    })
}
