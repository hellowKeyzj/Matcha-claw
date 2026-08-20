use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

use crate::{
    GraphRunId, ListTeams, RemoveTeam, ReplaceTeam, RoleId, TeamCommand, TeamId, TeamReplaced,
    TeamRevision, TeamRevisionOverflow,
};

use super::materialization::{
    MaterializationOperationOutcome, MaterializationOperationReceipt, MaterializationRejection,
    TeamMaterializationRemoval, TeamMaterializationRequest,
};
use super::*;

fn team() -> TeamId {
    TeamId::try_new("team-release").unwrap()
}

fn run() -> GraphRunId {
    GraphRunId::new("run-42")
}

fn role() -> RoleId {
    RoleId::try_new("reviewer").unwrap()
}

fn other_role() -> RoleId {
    RoleId::try_new("approver").unwrap()
}

fn endpoint() -> RuntimeEndpointReference {
    RuntimeEndpointReference::try_new("endpoint-primary").unwrap()
}

fn other_endpoint() -> RuntimeEndpointReference {
    RuntimeEndpointReference::try_new("endpoint-secondary").unwrap()
}

fn agent() -> ManagedAgentReference {
    ManagedAgentReference::try_new("agent-reviewer").unwrap()
}

fn local_session() -> LocalSessionReference {
    LocalSessionReference::try_new("local-session-reviewer").unwrap()
}

fn external_session() -> ExternalSessionReference {
    ExternalSessionReference::try_new("session-native-opaque").unwrap()
}

fn idempotency_key() -> IdempotencyKey {
    IdempotencyKey::try_new("run-42:reviewer:1").unwrap()
}

fn binding() -> RoleSessionReceipt {
    RoleSessionReceipt::new(
        team(),
        run(),
        role(),
        local_session(),
        external_session(),
        agent(),
        endpoint(),
    )
}

fn materialized_role(
    role: RoleId,
    agent: &str,
    endpoint: RuntimeEndpointReference,
) -> RoleMaterializationReceipt {
    RoleMaterializationReceipt::new(
        role,
        ManagedAgentReference::try_new(agent).unwrap(),
        endpoint,
    )
}

#[test]
fn rejects_blank_opaque_references_at_the_port_boundary() {
    assert!(ExternalSessionReference::try_new("").is_err());
    assert!(LocalSessionReference::try_new("\n").is_err());
    assert!(DeliveryReceiptReference::try_new("\n").is_err());
}

#[test]
fn materialization_intent_requires_one_distinct_role() {
    let reviewer = RoleAgentMaterialization::managed(role(), "reviewer-agent").unwrap();
    let duplicate = RoleAgentMaterialization::managed(role(), "reviewer-agent-two").unwrap();

    assert_eq!(
        TeamMaterializationIntent::try_new(
            team(),
            endpoint(),
            MaterializationSource::TeamSkill,
            vec![reviewer, duplicate],
        ),
        Err(InvalidTeamMaterializationIntent::DuplicateRole),
    );
}

#[test]
fn materialization_intent_makes_agent_ownership_explicit() {
    let managed = RoleAgentMaterialization::managed(role(), "Reviewer").unwrap();
    let external = RoleAgentMaterialization::external(
        other_role(),
        ManagedAgentReference::try_new("existing-approver").unwrap(),
    );

    assert!(matches!(
        managed.agent(),
        RoleMaterializationAgent::Managed { .. }
    ));
    assert!(matches!(
        external.agent(),
        RoleMaterializationAgent::External { .. }
    ));
}

#[test]
fn materialization_receipt_preserves_role_correlated_external_facts() {
    let intent = TeamMaterializationIntent::try_new(
        team(),
        endpoint(),
        MaterializationSource::Manual,
        vec![RoleAgentMaterialization::managed(role(), "reviewer-agent").unwrap()],
    )
    .unwrap();
    let role_receipt = materialized_role(role(), "agent-reviewer", endpoint());
    let receipt =
        MaterializationReceipt::try_new(team(), endpoint(), vec![role_receipt.clone()]).unwrap();

    assert_eq!(intent.team(), receipt.team());
    assert_eq!(intent.endpoint(), receipt.endpoint());
    assert_eq!(receipt.roles(), std::slice::from_ref(&role_receipt));

    let external_role = RoleMaterializationReceipt::with_ownership(
        other_role(),
        ManagedAgentReference::try_new("existing-approver").unwrap(),
        RoleMaterializationOwnership::External,
        endpoint(),
    );
    let receipt =
        MaterializationReceipt::try_new(team(), endpoint(), vec![role_receipt, external_role])
            .unwrap();
    assert_eq!(
        receipt.roles()[1].ownership(),
        RoleMaterializationOwnership::External
    );
}

#[test]
fn materialization_receipt_rejects_cross_endpoint_and_duplicate_role_facts() {
    assert_eq!(
        MaterializationReceipt::try_new(team(), endpoint(), vec![]),
        Err(InvalidMaterializationReceipt::EmptyRoles),
    );
    assert_eq!(
        MaterializationReceipt::try_new(
            team(),
            endpoint(),
            vec![materialized_role(
                role(),
                "agent-reviewer",
                other_endpoint()
            )],
        ),
        Err(InvalidMaterializationReceipt::RoleEndpointMismatch),
    );
    assert_eq!(
        MaterializationReceipt::try_new(
            team(),
            endpoint(),
            vec![
                materialized_role(role(), "agent-reviewer", endpoint()),
                materialized_role(role(), "agent-approver", endpoint()),
            ],
        ),
        Err(InvalidMaterializationReceipt::DuplicateRole),
    );
}

#[test]
fn materialization_receipt_rejects_duplicate_agents() {
    assert_eq!(
        MaterializationReceipt::try_new(
            team(),
            endpoint(),
            vec![
                materialized_role(role(), "agent-reviewer", endpoint()),
                materialized_role(other_role(), "agent-reviewer", endpoint()),
            ],
        ),
        Err(InvalidMaterializationReceipt::DuplicateAgent),
    );
}

fn poll_ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);

    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("test materialization port must complete immediately"),
    }
}

struct FixedOutcomeMaterializationPort {
    materialize_outcome: MaterializationOperationOutcome,
    remove_outcome: MaterializationOperationOutcome,
    received: Option<(TeamId, IdempotencyKey)>,
    removed: Option<(TeamId, IdempotencyKey)>,
}

impl TeamMaterializationPort for FixedOutcomeMaterializationPort {
    type Error = ();

    fn materialize(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> impl Future<Output = Result<MaterializationOperationOutcome, Self::Error>> + Send {
        self.received = Some((
            request.intent().team().clone(),
            request.idempotency_key().clone(),
        ));
        let outcome = self.materialize_outcome.clone();
        async move { Ok(outcome) }
    }

    fn remove(
        &mut self,
        removal: TeamMaterializationRemoval,
    ) -> impl Future<Output = Result<MaterializationOperationOutcome, Self::Error>> + Send {
        self.removed = Some((
            removal.receipt().team().clone(),
            removal.idempotency_key().clone(),
        ));
        let outcome = self.remove_outcome.clone();
        async move { Ok(outcome) }
    }
}

fn materialization_request(key: IdempotencyKey) -> TeamMaterializationRequest {
    TeamMaterializationRequest::new(
        TeamMaterializationIntent::try_new(
            team(),
            endpoint(),
            MaterializationSource::TeamSkill,
            vec![RoleAgentMaterialization::managed(role(), "reviewer-agent").unwrap()],
        )
        .unwrap(),
        key,
    )
}

fn materialization_receipt() -> MaterializationReceipt {
    MaterializationReceipt::try_new(
        team(),
        endpoint(),
        vec![materialized_role(role(), "agent-reviewer", endpoint())],
    )
    .unwrap()
}

#[test]
fn materialization_delivery_is_async_and_keeps_accepted_rejected_and_unknown_separate() {
    let key = idempotency_key();
    let accepted = MaterializationOperationOutcome::Accepted {
        receipt: MaterializationOperationReceipt::new(key.clone()),
    };
    let mut port = FixedOutcomeMaterializationPort {
        materialize_outcome: accepted.clone(),
        remove_outcome: MaterializationOperationOutcome::OutcomeUnknown,
        received: None,
        removed: None,
    };

    assert_eq!(
        poll_ready(port.materialize(materialization_request(key.clone()))),
        Ok(accepted),
    );
    assert_eq!(port.received, Some((team(), key)));
    assert_ne!(
        MaterializationOperationOutcome::Rejected {
            rejection: MaterializationRejection::Retryable,
        },
        MaterializationOperationOutcome::OutcomeUnknown,
    );
}

#[test]
fn materialization_operation_receipt_is_not_a_final_materialization_fact() {
    let operation_receipt = MaterializationOperationReceipt::new(idempotency_key());

    assert_eq!(operation_receipt.idempotency_key(), &idempotency_key());
    assert!(!format!("{operation_receipt:?}").contains("agent-reviewer"));
}

#[test]
fn materialization_preserves_explicit_rejection_and_unknown_remote_outcomes() {
    let rejected = MaterializationOperationOutcome::Rejected {
        rejection: MaterializationRejection::Permanent,
    };
    let mut port = FixedOutcomeMaterializationPort {
        materialize_outcome: rejected.clone(),
        remove_outcome: MaterializationOperationOutcome::OutcomeUnknown,
        received: None,
        removed: None,
    };

    assert_eq!(
        poll_ready(port.materialize(materialization_request(idempotency_key()))),
        Ok(rejected),
    );
    assert_eq!(
        poll_ready(port.remove(TeamMaterializationRemoval::new(
            materialization_receipt(),
            idempotency_key(),
        ))),
        Ok(MaterializationOperationOutcome::OutcomeUnknown),
    );
    assert_eq!(port.removed, Some((team(), idempotency_key())));
}

#[test]
fn timeout_close_and_invalid_provider_reply_are_outcome_unknown() {
    for condition in ["timeout", "connection close", "invalid provider reply"] {
        let mut port = FixedOutcomeMaterializationPort {
            materialize_outcome: MaterializationOperationOutcome::OutcomeUnknown,
            remove_outcome: MaterializationOperationOutcome::OutcomeUnknown,
            received: None,
            removed: None,
        };

        assert_eq!(
            poll_ready(port.materialize(materialization_request(idempotency_key()))),
            Ok(MaterializationOperationOutcome::OutcomeUnknown),
            "{condition} must not claim a materialization outcome",
        );
    }
}

#[test]
fn role_session_receipt_preserves_local_and_external_identity() {
    let receipt = binding();

    assert_eq!(receipt.team(), &team());
    assert_eq!(receipt.team_run(), &run());
    assert_eq!(receipt.role(), &role());
    assert_eq!(receipt.agent(), &agent());
    assert_eq!(receipt.endpoint(), &endpoint());
    assert_ne!(
        receipt.local_session().as_str(),
        receipt.external_session().as_str()
    );
}

#[test]
fn pending_hydration_is_not_an_empty_or_unavailable_session_window() {
    let pending = RoleSessionWindow::PendingHydration {
        session: binding().external_session().clone(),
    };
    let unavailable = RoleSessionWindow::Unavailable {
        session: binding().external_session().clone(),
    };

    assert_ne!(pending, unavailable);
    assert!(matches!(
        pending,
        RoleSessionWindow::PendingHydration { .. }
    ));
}

#[test]
fn run_runtime_receipt_rejects_mismatched_or_duplicate_role_bindings() {
    assert_eq!(
        RunRuntimeReceipt::try_new(
            run(),
            vec![RoleSessionReceipt::new(
                team(),
                GraphRunId::new("run-other"),
                role(),
                local_session(),
                external_session(),
                agent(),
                endpoint(),
            )],
        ),
        Err(InvalidRunRuntimeReceipt::BindingRunMismatch),
    );
    assert_eq!(
        RunRuntimeReceipt::try_new(
            run(),
            vec![
                binding(),
                RoleSessionReceipt::new(
                    team(),
                    run(),
                    other_role(),
                    LocalSessionReference::try_new("local-session-approver").unwrap(),
                    ExternalSessionReference::try_new("session-native-approver").unwrap(),
                    ManagedAgentReference::try_new("agent-approver").unwrap(),
                    other_endpoint(),
                ),
            ],
        ),
        Err(InvalidRunRuntimeReceipt::BindingEndpointMismatch),
    );
    assert_eq!(
        RunRuntimeReceipt::try_new(run(), vec![binding(), binding()],),
        Err(InvalidRunRuntimeReceipt::DuplicateRoleBinding),
    );
}

#[test]
fn run_runtime_receipt_rejects_reused_local_or_native_session_across_roles() {
    let first = binding();
    let same_local = RoleSessionReceipt::new(
        team(),
        run(),
        other_role(),
        first.local_session().clone(),
        ExternalSessionReference::try_new("session-native-approver").unwrap(),
        ManagedAgentReference::try_new("agent-approver").unwrap(),
        endpoint(),
    );
    assert_eq!(
        RunRuntimeReceipt::try_new(run(), vec![first.clone(), same_local],),
        Err(InvalidRunRuntimeReceipt::DuplicateLocalSessionBinding),
    );

    let same_native = RoleSessionReceipt::new(
        team(),
        run(),
        other_role(),
        LocalSessionReference::try_new("local-session-approver").unwrap(),
        first.external_session().clone(),
        ManagedAgentReference::try_new("agent-approver").unwrap(),
        endpoint(),
    );
    assert_eq!(
        RunRuntimeReceipt::try_new(run(), vec![first, same_native],),
        Err(InvalidRunRuntimeReceipt::DuplicateExternalSessionBinding),
    );
}

#[test]
fn valid_run_runtime_receipt_survives_typed_construction() {
    let bindings = vec![binding()];
    let receipt = RunRuntimeReceipt::try_new(run(), bindings.clone()).unwrap();

    assert_eq!(receipt.team_run(), &run());
    assert_eq!(receipt.bindings(), bindings);
}

struct UnknownOutcomeDeliveryPort {
    received: Option<(DeliveryReference, IdempotencyKey)>,
}

impl PromptDeliveryPort for UnknownOutcomeDeliveryPort {
    type Error = ();

    fn deliver(
        &mut self,
        request: PromptDeliveryRequest,
    ) -> Result<PromptDeliveryOutcome, Self::Error> {
        self.received = Some((
            request.delivery().clone(),
            request.idempotency_key().clone(),
        ));
        Ok(PromptDeliveryOutcome::OutcomeUnknown)
    }
}

#[test]
fn prompt_dispatch_payload_debug_redacts_prompt_text() {
    let payload = PromptDispatchPayload::try_new("prompt-canary").unwrap();

    assert!(!format!("{payload:?}").contains("prompt-canary"));
}

#[test]
fn preserves_idempotency_and_unknown_external_delivery_outcome() {
    let delivery = DeliveryReference::try_new("delivery-1").unwrap();
    let key = idempotency_key();
    let request = PromptDeliveryRequest::new(
        delivery.clone(),
        binding(),
        key.clone(),
        PromptDispatchPayload::try_new("review the release").unwrap(),
    );
    let mut port = UnknownOutcomeDeliveryPort { received: None };

    assert_eq!(
        port.deliver(request),
        Ok(PromptDeliveryOutcome::OutcomeUnknown)
    );
    assert_eq!(port.received, Some((delivery, key)));
}

#[test]
fn team_contracts_are_available_from_the_organization_root() {
    use std::time::UNIX_EPOCH;

    use crate::{
        CreateTeam, InvalidReplaceTeam, InvalidTeamCreated, InvalidTeamListPage,
        InvalidTeamPageSize, InvalidTeamReplaced, InvalidTeamRevision, TeamCreated, TeamEvent,
        TeamListPage, TeamPageSize, TeamProjection, TeamQuery, TeamRemoved,
    };

    let page_size = TeamPageSize::try_new(1).unwrap();
    let query = TeamQuery::List(ListTeams::new(Some(team()), page_size));
    let event = TeamEvent::TeamRemoved(TeamRemoved::new(
        team(),
        TeamRevision::initial(),
        UNIX_EPOCH,
    ));

    assert!(matches!(query, TeamQuery::List(_)));
    assert_eq!(event.team_id(), &team());

    fn exposed<T>() {}

    exposed::<CreateTeam>();
    exposed::<InvalidReplaceTeam>();
    exposed::<InvalidTeamCreated>();
    exposed::<InvalidTeamListPage>();
    exposed::<InvalidTeamPageSize>();
    exposed::<InvalidTeamReplaced>();
    exposed::<InvalidTeamRevision>();
    exposed::<RemoveTeam>();
    exposed::<ReplaceTeam>();
    exposed::<TeamCommand>();
    exposed::<TeamCreated>();
    exposed::<TeamListPage>();
    exposed::<TeamProjection>();
    exposed::<TeamReplaced>();
    exposed::<TeamRevisionOverflow>();
}
