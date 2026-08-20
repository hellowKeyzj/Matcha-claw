use super::node_event::TeamNodeCompletionReceipt;

use crate::run::{
    delivery::{
        AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionReceipt,
        DeliveryId,
    },
    graph::{ExecutionFence, GraphRunId, NodeKind},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentNodeEvent {
    Complete,
    Reject,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentNodeEventResolution {
    receipt: AuthorizedGraphResolutionReceipt,
    delivery_id: DeliveryId,
    graph_run_id: GraphRunId,
    fence: ExecutionFence,
    event: AgentNodeEvent,
    completion_receipt: Option<TeamNodeCompletionReceipt>,
    summary: Option<String>,
    artifact_source_envelope_id: Option<String>,
    artifact_idempotency_key: Option<String>,
    output_port: Option<String>,
    resolved_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentNodeEventResolutionError {
    BlankGraphRunId,
    EmptyOutputPort,
    UnsafeOutputPort,
    NodeMismatch,
    CompletionReceiptMismatch,
    CompletionReceiptIdentityMismatch,
    BlankArtifactIdentity,
    UnexpectedNodeKind,
    InvalidSummary,
    AuthorizedResolution(crate::AuthorizedGraphResolutionError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EvidenceReference, EvidenceReferenceKind,
        run::{
            control::node_event::{TeamNodeCompletionEvidence, TeamNodeCompletionReceipt},
            graph::{AttemptId, NodeExecutionId},
        },
    };

    fn fence() -> ExecutionFence {
        let attempt = AttemptId::for_node(
            &crate::NodeId::new("work"),
            std::num::NonZeroU32::new(1).unwrap(),
        );
        ExecutionFence::new(attempt.clone(), NodeExecutionId::for_attempt(&attempt))
    }

    #[test]
    fn completion_resolution_exposes_only_fence_bound_receipt() {
        let fence = fence();
        let evidence = TeamNodeCompletionEvidence::try_new(
            "run:one",
            fence.clone(),
            EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "artifact:one", None)
                .unwrap(),
        )
        .unwrap();
        let completion = TeamNodeCompletionReceipt::try_new(
            AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
            "run:one",
            fence.clone(),
            [evidence],
        )
        .unwrap();
        let resolution = AgentNodeEventResolution::complete_with_receipt(
            AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
            DeliveryId::new("delivery:one").unwrap(),
            "run:one",
            fence.clone(),
            completion.clone(),
            None::<String>,
            5,
        )
        .unwrap();
        assert_eq!(resolution.completion_receipt(), Some(&completion));
        assert_eq!(resolution.fence(), &fence);
    }

    #[test]
    fn terminal_summary_is_bounded_and_redaction_safe() {
        let fence = fence();
        let receipt = AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap();
        let delivery = DeliveryId::new("delivery:one").unwrap();
        let resolution = AgentNodeEventResolution::complete_with_summary(
            receipt,
            delivery,
            "run:one",
            fence.clone(),
            "completed safely".to_owned(),
            "command:one",
            "delivery-key:one",
            Some("completed"),
            5,
        )
        .unwrap();
        assert_eq!(resolution.summary(), Some("completed safely"));
        assert_eq!(
            resolution.artifact_source_envelope_id(),
            Some("command:one")
        );
        assert_eq!(
            resolution.artifact_idempotency_key(),
            Some("delivery-key:one")
        );
        assert_eq!(
            AgentNodeEventResolution::reject_with_summary(
                AuthorizedGraphResolutionReceipt::try_new("resolution:two").unwrap(),
                DeliveryId::new("delivery:two").unwrap(),
                "run:one",
                fence.clone(),
                "\u{0000}".to_owned(),
                "command:two",
                "delivery-key:two",
                Some("failed"),
                5,
            ),
            Err(AgentNodeEventResolutionError::InvalidSummary)
        );
        assert_eq!(
            AgentNodeEventResolution::complete_with_summary(
                AuthorizedGraphResolutionReceipt::try_new("resolution:three").unwrap(),
                DeliveryId::new("delivery:three").unwrap(),
                "run:one",
                fence,
                "completed safely".to_owned(),
                " ",
                "delivery-key:three",
                Some("completed"),
                5,
            ),
            Err(AgentNodeEventResolutionError::BlankArtifactIdentity)
        );
    }

    #[test]
    fn completion_resolution_rejects_receipt_from_another_fence() {
        let fence = fence();
        let other_fence = ExecutionFence::new(
            AttemptId::for_node(
                &crate::NodeId::new("work"),
                std::num::NonZeroU32::new(2).unwrap(),
            ),
            NodeExecutionId::for_attempt(&AttemptId::for_node(
                &crate::NodeId::new("work"),
                std::num::NonZeroU32::new(2).unwrap(),
            )),
        );
        let completion = TeamNodeCompletionReceipt::try_new(
            AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
            "run:one",
            other_fence,
            [],
        )
        .unwrap();
        assert_eq!(
            AgentNodeEventResolution::complete_with_receipt(
                AuthorizedGraphResolutionReceipt::try_new("resolution:one").unwrap(),
                DeliveryId::new("delivery:one").unwrap(),
                "run:one",
                fence,
                completion,
                None::<String>,
                5,
            ),
            Err(AgentNodeEventResolutionError::CompletionReceiptMismatch)
        );
    }
}

impl AgentNodeEventResolution {
    pub fn complete(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        output_port: Option<impl Into<String>>,
        resolved_at: u64,
    ) -> Result<Self, AgentNodeEventResolutionError> {
        Self::new(
            receipt,
            delivery_id,
            graph_run_id,
            fence,
            AgentNodeEvent::Complete,
            None,
            None,
            None,
            None,
            output_port,
            resolved_at,
        )
    }

    pub fn complete_with_summary(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        summary: String,
        source_envelope_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        output_port: Option<impl Into<String>>,
        resolved_at: u64,
    ) -> Result<Self, AgentNodeEventResolutionError> {
        Self::new(
            receipt,
            delivery_id,
            graph_run_id,
            fence,
            AgentNodeEvent::Complete,
            None,
            Some(summary),
            Some(source_envelope_id.into()),
            Some(idempotency_key.into()),
            output_port,
            resolved_at,
        )
    }

    pub fn complete_with_receipt(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        completion_receipt: TeamNodeCompletionReceipt,
        output_port: Option<impl Into<String>>,
        resolved_at: u64,
    ) -> Result<Self, AgentNodeEventResolutionError> {
        Self::new(
            receipt,
            delivery_id,
            graph_run_id,
            fence,
            AgentNodeEvent::Complete,
            Some(completion_receipt),
            None,
            None,
            None,
            output_port,
            resolved_at,
        )
    }

    pub fn reject(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        output_port: Option<impl Into<String>>,
        resolved_at: u64,
    ) -> Result<Self, AgentNodeEventResolutionError> {
        Self::new(
            receipt,
            delivery_id,
            graph_run_id,
            fence,
            AgentNodeEvent::Reject,
            None,
            None,
            None,
            None,
            output_port,
            resolved_at,
        )
    }

    pub fn reject_with_summary(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        summary: String,
        source_envelope_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        output_port: Option<impl Into<String>>,
        resolved_at: u64,
    ) -> Result<Self, AgentNodeEventResolutionError> {
        Self::new(
            receipt,
            delivery_id,
            graph_run_id,
            fence,
            AgentNodeEvent::Reject,
            None,
            Some(summary),
            Some(source_envelope_id.into()),
            Some(idempotency_key.into()),
            output_port,
            resolved_at,
        )
    }

    fn new(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        event: AgentNodeEvent,
        completion_receipt: Option<TeamNodeCompletionReceipt>,
        summary: Option<String>,
        artifact_source_envelope_id: Option<String>,
        artifact_idempotency_key: Option<String>,
        output_port: Option<impl Into<String>>,
        resolved_at: u64,
    ) -> Result<Self, AgentNodeEventResolutionError> {
        let graph_run_id = graph_run_id.into();
        if graph_run_id.trim().is_empty() {
            return Err(AgentNodeEventResolutionError::BlankGraphRunId);
        }
        if let Some(completion_receipt) = &completion_receipt {
            if completion_receipt.graph_run_id().as_str() != graph_run_id {
                return Err(AgentNodeEventResolutionError::CompletionReceiptIdentityMismatch);
            }
            if completion_receipt.fence() != &fence {
                return Err(AgentNodeEventResolutionError::CompletionReceiptMismatch);
            }
        }
        let summary = summary
            .map(|summary| {
                let summary = summary.trim().to_owned();
                (summary.len() <= 512
                    && !summary.is_empty()
                    && !summary.chars().any(char::is_control))
                .then_some(summary)
                .ok_or(AgentNodeEventResolutionError::InvalidSummary)
            })
            .transpose()?;
        if artifact_source_envelope_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
            || artifact_idempotency_key
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || artifact_source_envelope_id.is_some() != artifact_idempotency_key.is_some()
            || (summary.is_some()
                && event == AgentNodeEvent::Complete
                && artifact_source_envelope_id.is_none())
        {
            return Err(AgentNodeEventResolutionError::BlankArtifactIdentity);
        }
        let output_port = output_port.map(Into::into);
        if let Some(output_port) = &output_port {
            if output_port.trim().is_empty() {
                return Err(AgentNodeEventResolutionError::EmptyOutputPort);
            }
            if !is_safe_output_port(output_port) {
                return Err(AgentNodeEventResolutionError::UnsafeOutputPort);
            }
        }
        Ok(Self {
            receipt,
            delivery_id,
            graph_run_id: GraphRunId::new(graph_run_id),
            fence,
            event,
            completion_receipt,
            summary,
            artifact_source_envelope_id,
            artifact_idempotency_key,
            output_port,
            resolved_at,
        })
    }

    pub fn receipt(&self) -> &AuthorizedGraphResolutionReceipt {
        &self.receipt
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub fn graph_run_id(&self) -> &GraphRunId {
        &self.graph_run_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub const fn event(&self) -> AgentNodeEvent {
        self.event
    }

    pub fn completion_receipt(&self) -> Option<&TeamNodeCompletionReceipt> {
        self.completion_receipt.as_ref()
    }

    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    pub fn artifact_source_envelope_id(&self) -> Option<&str> {
        self.artifact_source_envelope_id.as_deref()
    }

    pub fn artifact_idempotency_key(&self) -> Option<&str> {
        self.artifact_idempotency_key.as_deref()
    }

    pub fn output_port(&self) -> Option<&str> {
        self.output_port.as_deref()
    }

    pub const fn resolved_at(&self) -> u64 {
        self.resolved_at
    }

    pub(crate) fn authorized_resolution(
        &self,
        node_kind: NodeKind,
    ) -> Result<AuthorizedGraphResolution, AgentNodeEventResolutionError> {
        if !matches!(node_kind, NodeKind::Work | NodeKind::Review) {
            return Err(AgentNodeEventResolutionError::UnexpectedNodeKind);
        }
        let output_port = match self.output_port() {
            Some(output_port) => output_port,
            None => default_output_port(self.event, node_kind)?,
        };
        let outcome = match self.event {
            AgentNodeEvent::Complete => AuthorizedGraphOutcome::Completed,
            AgentNodeEvent::Reject => AuthorizedGraphOutcome::Failed,
        };
        AuthorizedGraphResolution::new(
            self.receipt.clone(),
            self.delivery_id.clone(),
            self.graph_run_id.as_str(),
            self.fence.clone(),
            outcome,
            output_port,
            self.resolved_at,
        )
        .map_err(|error| match error {
            crate::InvalidAuthorizedGraphResolution::BlankOutputPort => {
                AgentNodeEventResolutionError::EmptyOutputPort
            }
            crate::InvalidAuthorizedGraphResolution::UnsafeOutputPort => {
                AgentNodeEventResolutionError::UnsafeOutputPort
            }
            crate::InvalidAuthorizedGraphResolution::BlankGraphRunId => {
                AgentNodeEventResolutionError::BlankGraphRunId
            }
        })
    }
}

fn default_output_port(
    event: AgentNodeEvent,
    node_kind: NodeKind,
) -> Result<&'static str, AgentNodeEventResolutionError> {
    match event {
        AgentNodeEvent::Reject => Ok("failed"),
        AgentNodeEvent::Complete => match node_kind {
            NodeKind::Work => Ok("completed"),
            NodeKind::Review => Ok("passed"),
            NodeKind::Start
            | NodeKind::HumanDecision
            | NodeKind::ScriptReview
            | NodeKind::Join
            | NodeKind::End => Err(AgentNodeEventResolutionError::UnexpectedNodeKind),
        },
    }
}

fn is_safe_output_port(output_port: &str) -> bool {
    output_port
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
}
