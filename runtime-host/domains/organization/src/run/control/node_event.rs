use std::num::NonZeroU32;

use super::agent_event::{AgentNodeEvent, AgentNodeEventResolution};
use crate::{
    EvidenceReference, EvidenceReferenceKind,
    run::{
        delivery::{AuthorizedGraphResolutionReceipt, DeliveryId},
        event::{ApprovalAction, ApprovalCommand, NodeProgressCommand, OpaqueId, RunCommand},
        graph::{ExecutionFence, GraphRunId},
    },
};

const MAX_COMPLETION_REFERENCES: usize = 32;

/// One opaque evidence reference proven by a producer for one node execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamNodeCompletionEvidence {
    graph_run_id: GraphRunId,
    fence: ExecutionFence,
    reference: EvidenceReference,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodeCompletionEvidenceError {
    BlankGraphRunId,
}

impl TeamNodeCompletionEvidence {
    pub fn try_new(
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        reference: EvidenceReference,
    ) -> Result<Self, TeamNodeCompletionEvidenceError> {
        let graph_run_id = graph_run_id.into();
        if graph_run_id.trim().is_empty() {
            return Err(TeamNodeCompletionEvidenceError::BlankGraphRunId);
        }
        Ok(Self {
            graph_run_id: GraphRunId::new(graph_run_id),
            fence,
            reference,
        })
    }

    pub fn graph_run_id(&self) -> &GraphRunId {
        &self.graph_run_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub fn reference(&self) -> &EvidenceReference {
        &self.reference
    }
}

/// A terminal completion receipt containing only producer-provided opaque evidence facts.
///
/// It does not carry artifact content, terminal status, or graph output. The receipt and every
/// reference are pinned to the same run and execution fence for idempotent downstream recording.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamNodeCompletionReceipt {
    receipt: AuthorizedGraphResolutionReceipt,
    graph_run_id: GraphRunId,
    fence: ExecutionFence,
    evidence: Vec<TeamNodeCompletionEvidence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodeCompletionReceiptError {
    BlankGraphRunId,
    TooManyReferences,
    DuplicateReference,
    EvidenceGraphRunMismatch,
    EvidenceFenceMismatch,
}

impl TeamNodeCompletionReceipt {
    pub fn try_new(
        receipt: AuthorizedGraphResolutionReceipt,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        evidence: impl IntoIterator<Item = TeamNodeCompletionEvidence>,
    ) -> Result<Self, TeamNodeCompletionReceiptError> {
        let graph_run_id = graph_run_id.into();
        if graph_run_id.trim().is_empty() {
            return Err(TeamNodeCompletionReceiptError::BlankGraphRunId);
        }
        let graph_run_id = GraphRunId::new(graph_run_id);
        let evidence: Vec<_> = evidence.into_iter().collect();
        if evidence.len() > MAX_COMPLETION_REFERENCES {
            return Err(TeamNodeCompletionReceiptError::TooManyReferences);
        }
        for (index, current) in evidence.iter().enumerate() {
            if current.graph_run_id() != &graph_run_id {
                return Err(TeamNodeCompletionReceiptError::EvidenceGraphRunMismatch);
            }
            if current.fence() != &fence {
                return Err(TeamNodeCompletionReceiptError::EvidenceFenceMismatch);
            }
            if evidence[..index].iter().any(|previous| {
                previous.reference().kind() == current.reference().kind()
                    && previous.reference().reference() == current.reference().reference()
                    && previous.reference().label() == current.reference().label()
            }) {
                return Err(TeamNodeCompletionReceiptError::DuplicateReference);
            }
        }
        Ok(Self {
            receipt,
            graph_run_id,
            fence,
            evidence,
        })
    }

    pub fn receipt(&self) -> &AuthorizedGraphResolutionReceipt {
        &self.receipt
    }

    pub fn graph_run_id(&self) -> &GraphRunId {
        &self.graph_run_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub fn evidence(&self) -> &[TeamNodeCompletionEvidence] {
        &self.evidence
    }

    pub fn artifact_evidence(&self) -> impl Iterator<Item = &TeamNodeCompletionEvidence> {
        self.evidence
            .iter()
            .filter(|evidence| evidence.reference().kind() == EvidenceReferenceKind::Artifact)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodeEventKind {
    Progress,
    RequestInput,
    RequestApproval { action: ApprovalAction },
    Complete,
    Reject,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamNodeEvent {
    node_execution_id: OpaqueId,
    role_id: Option<OpaqueId>,
    kind: TeamNodeEventKind,
    completion_receipt: Option<TeamNodeCompletionReceipt>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodeEventOutcome {
    Progressed,
    WaitingForInput,
    ApprovalRequested,
    TerminalReceiptRequired,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::graph::{AttemptId, NodeExecutionId};

    fn fence() -> ExecutionFence {
        ExecutionFence::new(
            AttemptId::for_node(
                &crate::NodeId::new("work"),
                std::num::NonZeroU32::new(1).unwrap(),
            ),
            NodeExecutionId::for_attempt(&AttemptId::for_node(
                &crate::NodeId::new("work"),
                std::num::NonZeroU32::new(1).unwrap(),
            )),
        )
    }

    fn artifact() -> EvidenceReference {
        EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "artifact:one", None).unwrap()
    }

    #[test]
    fn completion_receipt_binds_opaque_evidence_to_run_and_fence() {
        let fence = fence();
        let evidence =
            TeamNodeCompletionEvidence::try_new("run:one", fence.clone(), artifact()).unwrap();
        let receipt = TeamNodeCompletionReceipt::try_new(
            AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
            "run:one",
            fence.clone(),
            [evidence],
        )
        .unwrap();

        assert_eq!(receipt.graph_run_id().as_str(), "run:one");
        assert_eq!(receipt.fence(), &fence);
        assert_eq!(receipt.artifact_evidence().count(), 1);
        assert_eq!(
            receipt.evidence()[0].reference().reference(),
            "artifact:one"
        );
    }

    #[test]
    fn completion_receipt_rejects_mismatched_evidence_and_duplicates() {
        let fence = fence();
        let mismatched =
            TeamNodeCompletionEvidence::try_new("run:other", fence.clone(), artifact()).unwrap();
        assert_eq!(
            TeamNodeCompletionReceipt::try_new(
                AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
                "run:one",
                fence.clone(),
                [mismatched],
            ),
            Err(TeamNodeCompletionReceiptError::EvidenceGraphRunMismatch)
        );

        let first =
            TeamNodeCompletionEvidence::try_new("run:one", fence.clone(), artifact()).unwrap();
        let second =
            TeamNodeCompletionEvidence::try_new("run:one", fence.clone(), artifact()).unwrap();
        assert_eq!(
            TeamNodeCompletionReceipt::try_new(
                AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
                "run:one",
                fence,
                [first, second],
            ),
            Err(TeamNodeCompletionReceiptError::DuplicateReference)
        );
    }

    #[test]
    fn completion_event_keeps_receipt_separate_from_terminal_graph_resolution() {
        let fence = fence();
        let evidence =
            TeamNodeCompletionEvidence::try_new("run:one", fence.clone(), artifact()).unwrap();
        let receipt = TeamNodeCompletionReceipt::try_new(
            AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
            "run:one",
            fence,
            [evidence],
        )
        .unwrap();
        let event = TeamNodeEvent::complete_with_receipt(
            OpaqueId::try_new("work:attempt:1").unwrap(),
            None,
            receipt,
        );
        assert_eq!(event.kind(), TeamNodeEventKind::Complete);
        assert!(event.completion_receipt().is_some());
    }
}

impl TeamNodeEvent {
    pub fn progress(node_execution_id: OpaqueId, role_id: Option<OpaqueId>) -> Self {
        Self {
            node_execution_id,
            role_id,
            kind: TeamNodeEventKind::Progress,
            completion_receipt: None,
        }
    }

    pub fn request_input(node_execution_id: OpaqueId, role_id: Option<OpaqueId>) -> Self {
        Self {
            node_execution_id,
            role_id,
            kind: TeamNodeEventKind::RequestInput,
            completion_receipt: None,
        }
    }

    pub fn request_approval(
        node_execution_id: OpaqueId,
        role_id: Option<OpaqueId>,
        action: ApprovalAction,
    ) -> Self {
        Self {
            node_execution_id,
            role_id,
            kind: TeamNodeEventKind::RequestApproval { action },
            completion_receipt: None,
        }
    }

    pub fn complete(node_execution_id: OpaqueId, role_id: Option<OpaqueId>) -> Self {
        Self {
            node_execution_id,
            role_id,
            kind: TeamNodeEventKind::Complete,
            completion_receipt: None,
        }
    }

    pub fn complete_with_receipt(
        node_execution_id: OpaqueId,
        role_id: Option<OpaqueId>,
        completion_receipt: TeamNodeCompletionReceipt,
    ) -> Self {
        Self {
            node_execution_id,
            role_id,
            kind: TeamNodeEventKind::Complete,
            completion_receipt: Some(completion_receipt),
        }
    }

    pub fn completion_receipt(&self) -> Option<&TeamNodeCompletionReceipt> {
        self.completion_receipt.as_ref()
    }

    pub fn reject(node_execution_id: OpaqueId, role_id: Option<OpaqueId>) -> Self {
        Self {
            node_execution_id,
            role_id,
            kind: TeamNodeEventKind::Reject,
            completion_receipt: None,
        }
    }

    pub fn node_execution_id(&self) -> &OpaqueId {
        &self.node_execution_id
    }

    pub fn role_id(&self) -> Option<&OpaqueId> {
        self.role_id.as_ref()
    }

    pub const fn kind(&self) -> TeamNodeEventKind {
        self.kind
    }

    pub(crate) fn command_payload(
        &self,
        approval_id: Option<OpaqueId>,
        resolved_role_id: Option<OpaqueId>,
    ) -> Option<crate::CommandPayload> {
        match self.kind {
            TeamNodeEventKind::Progress => Some(crate::CommandPayload::NodeProgress(
                NodeProgressCommand::progress(self.node_execution_id.clone()),
            )),
            TeamNodeEventKind::RequestInput => Some(crate::CommandPayload::NodeProgress(
                NodeProgressCommand::request_input(self.node_execution_id.clone()),
            )),
            TeamNodeEventKind::RequestApproval { action } => Some(
                crate::CommandPayload::ApprovalRequest(ApprovalCommand::new(
                    approval_id.expect("approval requests require an approval identifier"),
                    self.node_execution_id.clone(),
                    resolved_role_id.expect("approval requests require a resolved role"),
                    action,
                )),
            ),
            TeamNodeEventKind::Complete | TeamNodeEventKind::Reject => None,
        }
    }
}

/// A non-terminal node event paired with the command accepted by the event ledger.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamNodeNonTerminalEvent {
    command: RunCommand,
    event: TeamNodeEvent,
}

impl TeamNodeNonTerminalEvent {
    pub fn command(&self) -> &RunCommand {
        &self.command
    }

    pub fn event(&self) -> &TeamNodeEvent {
        &self.event
    }

    pub fn into_parts(self) -> (RunCommand, TeamNodeEvent) {
        (self.command, self.event)
    }
}

/// A terminal node resolution ready for `OrganizationStore::apply_agent_node_event_resolution`.
///
/// `attempt` is the already-validated attempt identity supplied by the caller. The store remains
/// responsible for checking the fence against the current graph and delivery facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamNodeTerminalEvent {
    resolution: AgentNodeEventResolution,
    attempt: NonZeroU32,
}

impl TeamNodeTerminalEvent {
    pub fn resolution(&self) -> &AgentNodeEventResolution {
        &self.resolution
    }

    pub const fn attempt(&self) -> NonZeroU32 {
        self.attempt
    }

    pub fn into_resolution(self) -> AgentNodeEventResolution {
        self.resolution
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamNodeEventProducerError {
    TerminalReceiptRequired,
    Invalid,
}

/// Builds typed node-event envelopes without mutating organization facts.
///
/// Non-terminal output is submitted through `OrganizationStore::team_node_event`; terminal output
/// is submitted through `OrganizationStore::apply_agent_node_event_resolution`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TeamNodeEventProducer;

impl TeamNodeEventProducer {
    pub fn non_terminal(
        run_id: OpaqueId,
        command_id: OpaqueId,
        idempotency_key: OpaqueId,
        event: TeamNodeEvent,
        created_at: u64,
    ) -> Result<TeamNodeNonTerminalEvent, TeamNodeEventProducerError> {
        if matches!(
            event.kind(),
            TeamNodeEventKind::Complete | TeamNodeEventKind::Reject
        ) {
            return Err(TeamNodeEventProducerError::TerminalReceiptRequired);
        }
        let (approval_id, resolved_role_id) = match event.kind() {
            TeamNodeEventKind::RequestApproval { .. } => {
                let role_id = event
                    .role_id()
                    .cloned()
                    .ok_or(TeamNodeEventProducerError::Invalid)?;
                let approval_id =
                    OpaqueId::try_new(format!("team-approval-{}", idempotency_key.as_str()))
                        .map_err(|_| TeamNodeEventProducerError::Invalid)?;
                (Some(approval_id), Some(role_id))
            }
            TeamNodeEventKind::Progress | TeamNodeEventKind::RequestInput => (None, None),
            TeamNodeEventKind::Complete | TeamNodeEventKind::Reject => unreachable!(),
        };
        let payload = event
            .command_payload(approval_id, resolved_role_id)
            .ok_or(TeamNodeEventProducerError::Invalid)?;
        Ok(TeamNodeNonTerminalEvent {
            command: RunCommand::new(run_id, command_id, idempotency_key, payload, created_at),
            event,
        })
    }

    pub fn complete(
        delivery_id: Option<DeliveryId>,
        receipt: Option<AuthorizedGraphResolutionReceipt>,
        graph_run_id: Option<GraphRunId>,
        fence: Option<ExecutionFence>,
        attempt: Option<NonZeroU32>,
        summary: String,
        source_envelope_id: String,
        idempotency_key: String,
        output_port: Option<String>,
        resolved_at: u64,
    ) -> Result<TeamNodeTerminalEvent, TeamNodeEventProducerError> {
        Self::terminal(
            AgentNodeEvent::Complete,
            delivery_id,
            receipt,
            graph_run_id,
            fence,
            attempt,
            summary,
            source_envelope_id,
            idempotency_key,
            output_port,
            resolved_at,
        )
    }

    pub fn reject(
        delivery_id: Option<DeliveryId>,
        receipt: Option<AuthorizedGraphResolutionReceipt>,
        graph_run_id: Option<GraphRunId>,
        fence: Option<ExecutionFence>,
        attempt: Option<NonZeroU32>,
        summary: String,
        source_envelope_id: String,
        idempotency_key: String,
        output_port: Option<String>,
        resolved_at: u64,
    ) -> Result<TeamNodeTerminalEvent, TeamNodeEventProducerError> {
        Self::terminal(
            AgentNodeEvent::Reject,
            delivery_id,
            receipt,
            graph_run_id,
            fence,
            attempt,
            summary,
            source_envelope_id,
            idempotency_key,
            output_port,
            resolved_at,
        )
    }

    fn terminal(
        event: AgentNodeEvent,
        delivery_id: Option<DeliveryId>,
        receipt: Option<AuthorizedGraphResolutionReceipt>,
        graph_run_id: Option<GraphRunId>,
        fence: Option<ExecutionFence>,
        attempt: Option<NonZeroU32>,
        summary: String,
        source_envelope_id: String,
        idempotency_key: String,
        output_port: Option<String>,
        resolved_at: u64,
    ) -> Result<TeamNodeTerminalEvent, TeamNodeEventProducerError> {
        let delivery_id = delivery_id.ok_or(TeamNodeEventProducerError::TerminalReceiptRequired)?;
        let receipt = receipt.ok_or(TeamNodeEventProducerError::TerminalReceiptRequired)?;
        let graph_run_id =
            graph_run_id.ok_or(TeamNodeEventProducerError::TerminalReceiptRequired)?;
        let fence = fence.ok_or(TeamNodeEventProducerError::TerminalReceiptRequired)?;
        let attempt = attempt.ok_or(TeamNodeEventProducerError::TerminalReceiptRequired)?;
        let output_port = output_port.ok_or(TeamNodeEventProducerError::TerminalReceiptRequired)?;
        let resolution = match event {
            AgentNodeEvent::Complete => AgentNodeEventResolution::complete_with_summary(
                receipt,
                delivery_id,
                graph_run_id.as_str(),
                fence,
                summary,
                source_envelope_id,
                idempotency_key,
                Some(output_port),
                resolved_at,
            ),
            AgentNodeEvent::Reject => AgentNodeEventResolution::reject_with_summary(
                receipt,
                delivery_id,
                graph_run_id.as_str(),
                fence,
                summary,
                source_envelope_id,
                idempotency_key,
                Some(output_port),
                resolved_at,
            ),
        }
        .map_err(|_| TeamNodeEventProducerError::Invalid)?;
        Ok(TeamNodeTerminalEvent {
            resolution,
            attempt,
        })
    }
}
