use std::fmt;

use crate::{
    DeliveryId, ExecutionFence, GraphRunId, NativeDeliveryCorrelation, NodeId, RoleId,
    RuntimeEndpointReference,
};

#[derive(Clone, Eq, PartialEq)]
pub struct NativeTerminalReceiptTarget {
    delivery_id: DeliveryId,
    endpoint: RuntimeEndpointReference,
    correlation: NativeDeliveryCorrelation,
    proof: TerminalObservationProof,
}

#[derive(Clone, Eq, PartialEq)]
struct TerminalObservationProof {
    graph_run_id: GraphRunId,
    node_id: NodeId,
    fence: ExecutionFence,
    role_id: RoleId,
}

impl NativeTerminalReceiptTarget {
    pub(super) fn new(
        delivery_id: DeliveryId,
        graph_run_id: GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        role_id: RoleId,
        endpoint: RuntimeEndpointReference,
        correlation: NativeDeliveryCorrelation,
    ) -> Self {
        Self {
            delivery_id,
            endpoint,
            correlation,
            proof: TerminalObservationProof {
                graph_run_id,
                node_id,
                fence,
                role_id,
            },
        }
    }

    pub fn endpoint(&self) -> &RuntimeEndpointReference {
        &self.endpoint
    }

    pub fn correlation(&self) -> &NativeDeliveryCorrelation {
        &self.correlation
    }

    pub(crate) fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub fn graph_run_id(&self) -> &GraphRunId {
        &self.proof.graph_run_id
    }
}

impl fmt::Debug for NativeTerminalReceiptTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeTerminalReceiptTarget")
            .field("delivery_id", &"<redacted>")
            .field("correlation", &"<redacted>")
            .field("proof", &"<redacted>")
            .finish()
    }
}
