use std::fmt;

use crate::{
    DeliveryPhase, GraphStatus, OrganizationFacts, TeamId, TeamRevision,
    run::{
        GraphRunId, delivery::TerminalObservationResolution, lifecycle::GraphRunLifecycleState,
        project,
    },
};

/// The fixed Organization query vocabulary for an existing TeamRun.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamRunQuery {
    Get { team: TeamId, run: GraphRunId },
}

impl TeamRunQuery {
    pub fn get(team: TeamId, run: GraphRunId) -> Self {
        Self::Get { team, run }
    }

    pub fn team(&self) -> &TeamId {
        match self {
            Self::Get { team, .. } => team,
        }
    }

    pub fn run(&self) -> &GraphRunId {
        match self {
            Self::Get { run, .. } => run,
        }
    }
}

/// A deliberately small TeamRun projection. Provider identities, workspace bindings, session
/// references, delivery receipts, and payloads never cross this query boundary.
#[derive(Clone, Eq, PartialEq)]
pub struct TeamRunProjection {
    team: TeamId,
    run: GraphRunId,
    team_revision: TeamRevision,
    graph_status: GraphStatus,
}

impl TeamRunProjection {
    fn new(
        team: TeamId,
        run: GraphRunId,
        team_revision: TeamRevision,
        graph_status: GraphStatus,
    ) -> Self {
        Self {
            team,
            run,
            team_revision,
            graph_status,
        }
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub fn run(&self) -> &GraphRunId {
        &self.run
    }

    pub const fn team_revision(&self) -> TeamRevision {
        self.team_revision
    }

    pub const fn graph_status(&self) -> GraphStatus {
        self.graph_status
    }
}

impl fmt::Debug for TeamRunProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamRunProjection")
            .field("team", &self.team)
            .field("run", &self.run)
            .field("team_revision", &self.team_revision)
            .field("graph_status", &self.graph_status)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum TeamRunQueryOutcome {
    Available(TeamRunProjection),
    Unavailable,
    OutcomeUnknown,
}

impl fmt::Debug for TeamRunQueryOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Available(projection) => formatter
                .debug_tuple("Available")
                .field(projection)
                .finish(),
            Self::Unavailable => formatter.write_str("Unavailable"),
            Self::OutcomeUnknown => formatter.write_str("OutcomeUnknown"),
        }
    }
}

/// Resolves a TeamRun only from validated Organization durable facts.
///
/// A TeamRun is unavailable without an extant, non-tombstoned team and its confirmed
/// materialization receipt. A confirmed materialization remains conservative when no runtime
/// receipt exists or delivery recovery recorded an unknown outcome.
pub fn query_team_run(facts: &OrganizationFacts, query: &TeamRunQuery) -> TeamRunQueryOutcome {
    let Some(team) = facts.team(query.team()) else {
        return TeamRunQueryOutcome::Unavailable;
    };
    if team.tombstoned() || facts.materialization(query.team()).is_none() {
        return TeamRunQueryOutcome::Unavailable;
    }

    let Some(run) = facts.run(query.run()) else {
        return TeamRunQueryOutcome::Unavailable;
    };
    if run.team() != query.team() {
        return TeamRunQueryOutcome::Unavailable;
    }
    if matches!(
        run.lifecycle().state(),
        GraphRunLifecycleState::Tombstoned { .. }
    ) {
        return TeamRunQueryOutcome::Unavailable;
    }
    if matches!(
        run.lifecycle().state(),
        GraphRunLifecycleState::Cancelling { .. } | GraphRunLifecycleState::OutcomeUnknown { .. }
    ) || run.runtime().is_none()
    {
        return TeamRunQueryOutcome::OutcomeUnknown;
    }
    if facts.deliveries().deliveries().any(|delivery| {
        delivery.facts().run_id == query.run().as_str()
            && match delivery.phase() {
                DeliveryPhase::OutcomeUnknown { .. } => true,
                DeliveryPhase::TerminalObserved { observation } => matches!(
                    observation.resolution(),
                    TerminalObservationResolution::AwaitingAuthorizedGraphResolution
                ),
                _ => false,
            }
    }) {
        return TeamRunQueryOutcome::OutcomeUnknown;
    }

    TeamRunQueryOutcome::Available(TeamRunProjection::new(
        query.team().clone(),
        query.run().clone(),
        team.revision(),
        project(run.graph()).status,
    ))
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use crate::{
        BeginCancellationOutcome, Delivery, DeliveryId, DeliveryLedger, DeliveryReceipt,
        DeliveryRequest, GraphDefinition, GraphEvent, GraphRunFacts, GraphRunId, GraphState,
        ManagedAgentReference, MaterializationReceipt, MemberId, NodeDefinition, NodeId,
        OrganizationFacts, RoleAssignment, RoleId, RoleKind, RoleMaterializationReceipt,
        RoleSessionReceipt, RunRuntimeReceipt, RuntimeEndpointReference, TeamDefinition, TeamFacts,
        TeamId, TeamMember, TeamRole, begin_delivery, settle_delivery,
    };

    use crate::run::delivery::{
        NativeRunReceiptReference, NativeTerminalStatus, observe_matcha_terminal,
    };

    use super::*;

    const PRIVATE_AGENT: &str = "private-agent-token";
    const PRIVATE_ENDPOINT: &str = "private-runtime-endpoint";

    #[test]
    fn query_is_unavailable_without_a_confirmed_materialization_receipt() {
        let facts = facts(None, None, DeliveryLedger::default());

        assert_eq!(
            query_team_run(&facts, &query()),
            TeamRunQueryOutcome::Unavailable
        );
    }

    #[test]
    fn query_keeps_unproven_runtime_and_recovered_delivery_outcomes_unknown() {
        let receipt = materialization();
        let no_runtime = facts(Some(receipt.clone()), None, DeliveryLedger::default());
        assert_eq!(
            query_team_run(&no_runtime, &query()),
            TeamRunQueryOutcome::OutcomeUnknown
        );

        let mut delivery = Delivery::request(DeliveryRequest {
            delivery_id: DeliveryId::new("delivery:one").unwrap(),
            team_id: "team:one".into(),
            run_id: "run:one".into(),
            node_id: "start".into(),
            node_execution_id: "start:attempt:1".into(),
            task_id: "task:one".into(),
            role_id: "leader".into(),
            idempotency_key: "delivery:one".into(),
            message: "private prompt".into(),
            requested_at: 1,
            max_attempts: 2,
        })
        .unwrap();
        let _ = begin_delivery(&mut delivery, 2);
        let recovered = crate::recover_interrupted_delivery(&mut delivery, 3);
        assert!(matches!(recovered, crate::DeliveryRecovery::OutcomeUnknown));
        let ledger = DeliveryLedger::restore(crate::DeliveryLedgerSnapshot::new(vec![
            delivery.snapshot(),
        ]))
        .unwrap();
        let unknown_delivery = facts(Some(receipt), Some(runtime()), ledger);

        assert_eq!(
            query_team_run(&unknown_delivery, &query()),
            TeamRunQueryOutcome::OutcomeUnknown
        );
    }

    #[test]
    fn available_projection_exposes_no_provider_receipt_or_workspace_data() {
        let facts = facts(
            Some(materialization()),
            Some(runtime()),
            DeliveryLedger::default(),
        );
        let outcome = query_team_run(&facts, &query());

        assert!(matches!(
            outcome,
            TeamRunQueryOutcome::Available(ref projection)
                if projection.team().as_str() == "team:one"
                    && projection.run().as_str() == "run:one"
                    && projection.team_revision() == TeamRevision::initial()
                    && projection.graph_status() == GraphStatus::Ready
        ));
        let debug = format!("{outcome:?}");
        for private in [PRIVATE_AGENT, PRIVATE_ENDPOINT] {
            assert!(!debug.contains(private));
        }
    }

    #[test]
    fn query_hides_tombstoned_runs_and_keeps_cancelling_runs_unknown() {
        let mut tombstoned = facts(
            Some(materialization()),
            Some(runtime()),
            DeliveryLedger::default(),
        );
        let started = tombstoned
            .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2)
            .unwrap();
        assert!(matches!(started, BeginCancellationOutcome::Started(_)));
        tombstoned
            .settle_graph_run_cancellation(
                &GraphRunId::new("run:one"),
                "cancel:one",
                crate::RoleAbortOutcome::Confirmed,
                3,
            )
            .unwrap();
        tombstoned
            .tombstone_graph_run(&GraphRunId::new("run:one"), "delete:one", 4)
            .unwrap();
        assert_eq!(
            query_team_run(&tombstoned, &query()),
            TeamRunQueryOutcome::Unavailable
        );

        let mut cancelling = facts(
            Some(materialization()),
            Some(runtime()),
            DeliveryLedger::default(),
        );
        let started = cancelling
            .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2)
            .unwrap();
        assert!(matches!(started, BeginCancellationOutcome::Started(_)));
        assert_eq!(
            query_team_run(&cancelling, &query()),
            TeamRunQueryOutcome::OutcomeUnknown
        );
    }

    #[test]
    fn query_keeps_terminal_observation_awaiting_authorized_resolution_unknown() {
        let mut delivery = delivered_delivery();
        let mut graph = graph();
        let fence = graph
            .current_attempt(&NodeId::new("start"))
            .unwrap()
            .fence()
            .clone();
        graph = crate::reduce(
            graph,
            GraphEvent::AttemptStarted {
                node_id: NodeId::new("start"),
                fence,
                started_at: 2,
            },
        )
        .unwrap();
        let binding = runtime().bindings()[0].clone();
        observe_matcha_terminal(
            &mut delivery,
            &mut graph,
            binding.external_session().clone(),
            NativeRunReceiptReference::try_new("receipt:one").unwrap(),
            NativeTerminalStatus::Completed,
            3,
        )
        .unwrap();
        let ledger = DeliveryLedger::restore(crate::DeliveryLedgerSnapshot::new(vec![
            delivery.snapshot(),
        ]))
        .unwrap();
        let facts = OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            vec![materialization()],
            vec![
                GraphRunFacts::new(
                    TeamId::try_new("team:one").unwrap(),
                    TeamRevision::initial(),
                    graph,
                    Some(runtime()),
                )
                .unwrap(),
            ],
            ledger.snapshot(),
        )
        .unwrap();

        assert_eq!(
            query_team_run(&facts, &query()),
            TeamRunQueryOutcome::OutcomeUnknown
        );
    }

    fn team_definition() -> TeamDefinition {
        let member =
            TeamMember::try_new(MemberId::try_new("member:leader").unwrap(), "Leader").unwrap();
        let role = TeamRole::try_new(
            RoleId::try_new("leader").unwrap(),
            "Leader",
            RoleKind::Leader,
        )
        .unwrap();
        TeamDefinition::try_new(
            TeamId::try_new("team:one").unwrap(),
            "Test team",
            vec![member.clone()],
            vec![role.clone()],
            vec![RoleAssignment::new(
                member.member_id().clone(),
                role.role_id().clone(),
            )],
        )
        .unwrap()
    }

    fn delivered_delivery() -> Delivery {
        let mut delivery = Delivery::request(DeliveryRequest {
            delivery_id: DeliveryId::new("delivery:one").unwrap(),
            team_id: "team:one".into(),
            run_id: "run:one".into(),
            node_id: "start".into(),
            node_execution_id: "start:attempt:1".into(),
            task_id: "task:one".into(),
            role_id: "leader".into(),
            idempotency_key: "delivery:one".into(),
            message: "private prompt".into(),
            requested_at: 1,
            max_attempts: 2,
        })
        .unwrap();
        let claim = match begin_delivery(&mut delivery, 2) {
            crate::DeliveryStart::Claimed(claim) => claim,
            other => panic!("expected a delivery claim, got {other:?}"),
        };
        settle_delivery(
            &mut delivery,
            &claim,
            DeliveryReceipt::Accepted {
                receipt: crate::DeliveryReceiptReference::try_new("receipt:one").unwrap(),
                accepted_at: 2,
                matcha_correlation: Some(crate::MatchaDeliveryCorrelation::new(
                    crate::ExternalSessionReference::try_new("external-session").unwrap(),
                    NativeRunReceiptReference::try_new("receipt:one").unwrap(),
                )),
            },
            3,
        )
        .unwrap();
        delivery
    }

    fn query() -> TeamRunQuery {
        TeamRunQuery::get(
            TeamId::try_new("team:one").unwrap(),
            GraphRunId::new("run:one"),
        )
    }

    fn facts(
        materialization: Option<MaterializationReceipt>,
        runtime: Option<RunRuntimeReceipt>,
        deliveries: DeliveryLedger,
    ) -> OrganizationFacts {
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            materialization,
            vec![
                GraphRunFacts::new(
                    TeamId::try_new("team:one").unwrap(),
                    TeamRevision::initial(),
                    graph(),
                    runtime,
                )
                .unwrap(),
            ],
            deliveries.snapshot(),
        )
        .unwrap()
    }

    fn graph() -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "graph:one",
                "plan:one",
                GraphRunId::new("run:one"),
                "display text is not projected",
                vec![NodeDefinition::start(
                    NodeId::new("start"),
                    "private node display",
                    NonZeroU32::new(2).unwrap(),
                    None,
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    fn materialization() -> MaterializationReceipt {
        let endpoint = RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap();
        MaterializationReceipt::try_new(
            TeamId::try_new("team:one").unwrap(),
            endpoint.clone(),
            vec![RoleMaterializationReceipt::new(
                RoleId::try_new("leader").unwrap(),
                ManagedAgentReference::try_new(PRIVATE_AGENT).unwrap(),
                endpoint,
            )],
        )
        .unwrap()
    }

    fn runtime() -> RunRuntimeReceipt {
        let endpoint = RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap();
        let binding = RoleSessionReceipt::new(
            TeamId::try_new("team:one").unwrap(),
            GraphRunId::new("run:one"),
            RoleId::try_new("leader").unwrap(),
            crate::LocalSessionReference::try_new("local-session").unwrap(),
            crate::ExternalSessionReference::try_new("external-session").unwrap(),
            ManagedAgentReference::try_new(PRIVATE_AGENT).unwrap(),
            endpoint,
        );
        RunRuntimeReceipt::try_new(GraphRunId::new("run:one"), vec![binding]).unwrap()
    }
}
