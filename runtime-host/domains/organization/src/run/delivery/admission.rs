use std::fmt;

use sha2::{Digest, Sha256};

use crate::{
    OrganizationFacts, TeamId,
    run::{
        delivery::{DELIVERY_MAX_ATTEMPTS, DeliveryId, DeliveryRequest, RegisterOutcome},
        graph::{EdgeAction, GraphRunId, NodeId, NodeKind},
        lifecycle::GraphRunLifecycleState,
    },
    team::RoleId,
};

/// Private role-chat admission input. Its message never enters a public Team projection.
#[derive(Clone, Eq, PartialEq)]
pub struct RoleChatAdmission {
    team_id: TeamId,
    run_id: GraphRunId,
    role_id: RoleId,
    message: String,
    idempotency_key: String,
    requested_at: u64,
}

impl RoleChatAdmission {
    pub fn new(
        team_id: TeamId,
        run_id: GraphRunId,
        role_id: RoleId,
        message: impl Into<String>,
        idempotency_key: impl Into<String>,
        requested_at: u64,
    ) -> Result<Self, RoleChatAdmissionError> {
        let message = message.into();
        let idempotency_key = idempotency_key.into();
        if message.trim().is_empty() || idempotency_key.trim().is_empty() {
            return Err(RoleChatAdmissionError::InvalidInput);
        }
        Ok(Self {
            team_id,
            run_id,
            role_id,
            message,
            idempotency_key,
            requested_at,
        })
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }
    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }
    pub fn role_id(&self) -> &RoleId {
        &self.role_id
    }
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
    pub(crate) fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    pub(crate) const fn requested_at(&self) -> u64 {
        self.requested_at
    }
}

impl fmt::Debug for RoleChatAdmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RoleChatAdmission")
            .field("team_id", &self.team_id)
            .field("run_id", &self.run_id)
            .field("role_id", &self.role_id)
            .field("message", &"<redacted>")
            .field("idempotency_key", &"<redacted>")
            .field("requested_at", &self.requested_at)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleChatAdmissionError {
    InvalidInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleChatAdmissionOutcome {
    Accepted { delivery_id: DeliveryId },
    Rejected(RoleChatRejection),
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleChatRejection {
    TeamUnavailable,
    RunUnavailable,
    RoleUnavailable,
    StaleFence,
    Ambiguous,
    IdempotencyConflict,
}

pub(crate) fn admit_role_chat(
    facts: &mut OrganizationFacts,
    admission: RoleChatAdmission,
) -> Result<RoleChatAdmissionOutcome, RoleChatAdmissionError> {
    let existing = facts
        .deliveries()
        .delivery_by_idempotency_key(admission.idempotency_key());
    if let Some(existing) = existing {
        return Ok(
            if existing.facts().team_id == admission.team_id().as_str()
                && existing.facts().run_id == admission.run_id().as_str()
                && existing.facts().role_id == admission.role_id().as_str()
                && existing.facts().message == admission.message()
            {
                RoleChatAdmissionOutcome::Accepted {
                    delivery_id: existing.facts().delivery_id.clone(),
                }
            } else {
                RoleChatAdmissionOutcome::Rejected(RoleChatRejection::IdempotencyConflict)
            },
        );
    }
    let Some(team) = facts.team(admission.team_id()) else {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::TeamUnavailable,
        ));
    };
    if team.tombstoned() {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::TeamUnavailable,
        ));
    }
    if !team
        .definition()
        .roles()
        .iter()
        .any(|role| role.role_id() == admission.role_id())
    {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::RoleUnavailable,
        ));
    }
    let Some(run) = facts.run(admission.run_id()) else {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::RunUnavailable,
        ));
    };
    let Some(runtime) = run.runtime() else {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::RunUnavailable,
        ));
    };
    if run.team() != admission.team_id()
        || !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
    {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::RunUnavailable,
        ));
    }
    if !runtime
        .bindings()
        .iter()
        .any(|binding| binding.role() == admission.role_id())
    {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            RoleChatRejection::RoleUnavailable,
        ));
    }

    let candidates = run
        .graph()
        .ready_queue()
        .iter()
        .filter_map(|queue| {
            let node = run.graph().definition().node(queue.node_id())?;
            if node.kind() != NodeKind::Work
                || node.work_assignment()?.role_id() != admission.role_id().as_str()
                || run
                    .graph()
                    .definition()
                    .incoming_edges(node.id())
                    .any(|edge| {
                        edge.action() == EdgeAction::Activate
                            || edge.action() == EdgeAction::Gate
                            || edge.action() == EdgeAction::Finish
                    })
            {
                return None;
            }
            let attempt = run.graph().current_attempt(queue.node_id())?;
            if facts.deliveries().deliveries().any(|delivery| {
                delivery.facts().team_id == admission.team_id().as_str()
                    && delivery.facts().run_id == admission.run_id().as_str()
                    && delivery.facts().node_execution_id
                        == attempt.fence().node_execution_id().as_str()
                    && !delivery.is_terminal()
            }) {
                return None;
            }
            (attempt.status() == crate::AttemptStatus::Ready
                && attempt.fence() == queue.fence()
                && attempt.number().get() == 1
                && attempt.created_at() == attempt.updated_at())
            .then_some((node, attempt))
        })
        .collect::<Vec<_>>();

    if candidates.len() != 1 {
        return Ok(RoleChatAdmissionOutcome::Rejected(
            if candidates.is_empty() {
                RoleChatRejection::StaleFence
            } else {
                RoleChatRejection::Ambiguous
            },
        ));
    }
    let (node, attempt) = candidates[0];
    let task_id = match node.kind() {
        NodeKind::Work => node
            .work_assignment()
            .expect("work node was selected")
            .task_id()
            .to_owned(),
        NodeKind::Review => node.id().as_str().to_owned(),
        _ => {
            return Ok(RoleChatAdmissionOutcome::Rejected(
                RoleChatRejection::StaleFence,
            ));
        }
    };
    let request = delivery_request(
        &admission,
        node.id(),
        attempt.fence().node_execution_id().as_str(),
        &task_id,
        DELIVERY_MAX_ATTEMPTS,
    );

    match facts
        .register_delivery(request)
        .map_err(|_| RoleChatAdmissionError::InvalidInput)?
    {
        RegisterOutcome::Recorded(delivery) | RegisterOutcome::Replayed(delivery) => {
            Ok(RoleChatAdmissionOutcome::Accepted {
                delivery_id: delivery.facts().delivery_id.clone(),
            })
        }
        RegisterOutcome::ConflictingIdempotencyKey
        | RegisterOutcome::ConflictingDeliveryId { .. } => {
            Ok(RoleChatAdmissionOutcome::OutcomeUnknown)
        }
    }
}

fn delivery_request(
    admission: &RoleChatAdmission,
    node_id: &NodeId,
    node_execution_id: &str,
    task_id: &str,
    max_attempts: u32,
) -> DeliveryRequest {
    let delivery_id = delivery_id(admission, node_id, node_execution_id);
    DeliveryRequest {
        delivery_id,
        team_id: admission.team_id().as_str().to_owned(),
        run_id: admission.run_id().as_str().to_owned(),
        node_id: node_id.as_str().to_owned(),
        node_execution_id: node_execution_id.to_owned(),
        task_id: task_id.to_owned(),
        role_id: admission.role_id().as_str().to_owned(),
        idempotency_key: admission.idempotency_key().to_owned(),
        message: admission.message().to_owned(),
        requested_at: admission.requested_at(),
        max_attempts,
    }
}

fn delivery_id(
    admission: &RoleChatAdmission,
    node_id: &NodeId,
    node_execution_id: &str,
) -> DeliveryId {
    let mut hash = Sha256::new();
    hash.update(admission.run_id().as_str().as_bytes());
    hash.update([0]);
    hash.update(node_id.as_str().as_bytes());
    hash.update([0]);
    hash.update(node_execution_id.as_bytes());
    hash.update([0]);
    hash.update(admission.idempotency_key().as_bytes());
    DeliveryId::new(format!("role-chat:{:x}", hash.finalize()))
        .expect("SHA-256 derived delivery id is non-empty")
}
