use std::fmt;

use crate::{DeliveryId, ExecutionFence, GraphRunId, MatchaDeliveryCorrelation, NodeId, RoleId};

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaTerminalReceiptTarget {
    delivery_id: DeliveryId,
    correlation: MatchaDeliveryCorrelation,
    proof: TerminalObservationProof,
}

#[derive(Clone, Eq, PartialEq)]
struct TerminalObservationProof {
    graph_run_id: GraphRunId,
    node_id: NodeId,
    fence: ExecutionFence,
    role_id: RoleId,
}

impl MatchaTerminalReceiptTarget {
    pub(super) fn new(
        delivery_id: DeliveryId,
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        role_id: RoleId,
        correlation: MatchaDeliveryCorrelation,
    ) -> Self {
        Self {
            delivery_id,
            correlation,
            proof: TerminalObservationProof {
                graph_run_id,
                node_id,
                fence,
                role_id,
            },
        }
    }

    pub fn correlation(&self) -> &MatchaDeliveryCorrelation {
        &self.correlation
    }

    pub(super) fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub fn graph_run_id(&self) -> &GraphRunId {
        &self.proof.graph_run_id
    }
}

impl fmt::Debug for MatchaTerminalReceiptTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MatchaTerminalReceiptTarget")
            .field("delivery_id", &"<redacted>")
            .field("correlation", &"<redacted>")
            .field("proof", &"<redacted>")
            .finish()
    }
}
