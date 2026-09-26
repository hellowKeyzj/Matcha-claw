use std::{
    fs::{self, OpenOptions},
    io::Write,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::run::delivery::{
    AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionReceipt,
    NativeRunReceiptReference, NativeTerminalStatus, TerminalObservationResolution,
    observe_native_terminal, resolve_authorized_graph_outcome,
};
use crate::{
    ActivityTarget, AgentNodeEventResolution, Approval, ApprovalDecision, ApprovalRequest,
    ApprovalStatus, ArmedTriggerFacts, AttemptStatus, CommandPayload, ControlAuthority,
    ControlNodeResolution, ControlNodeResolutionError, ControlNodeResolutionOutcome, Delivery,
    DeliveryId, DeliveryLedger, DeliveryLedgerSnapshot, DeliveryPhase, DeliveryPhaseSnapshot,
    DeliveryReceipt, DeliveryReceiptError, DeliveryRequest, DeliveryResolution, DeliverySnapshot,
    DeliveryStart, DependencyMetadata, EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy,
    EndpointSessionId, EvidenceId, EvidenceRecord, EvidenceReference, ExecutorPolicy,
    GraphDefinition, GraphEvent, GraphPatch, GraphPatchOperation, GraphRunId, GraphRunLifecycle,
    GraphRunLifecycleState, GraphState, GroupId, HumanDecision, IdempotencyKey, JoinPolicy,
    ManagedAgentReference, MaterializationOperationOutcome, MaterializationReceipt,
    MaterializationRecordOutcome, MaterializationRejection, MaterializationSource, MemberId,
    NativeDeliveryCorrelation, NodeDefinition, NodeId, NodeKind, RegisterOutcome, ReviewAssignment,
    RoleAssignment, RoleId, RoleKind, RoleMaterializationAgent, RoleMaterializationReceipt,
    RoleSessionReceipt, RunRuntimeReceipt, RuntimeEndpointReference, ScriptReviewRule,
    StartTrigger, TeamDecisionCommand, TeamDecisionType, TeamDefinition, TeamId, TeamMember,
    TeamNodeEvent, TeamNodeEventOutcome, TeamRevision, TeamRole, TeamRunQuery, TeamRunQueryOutcome,
    TerminalObservationOutcome, TriggerFireError, TriggerFireRequest, TriggerRegistration,
    TriggerSource, WorkAssignment, WorkGroup, begin_delivery,
    ports::materialization::NativeWorkspaceReceipt,
    query_team_run, reduce,
    run::event::NodeProgressCommand,
    run::lifecycle::{
        BeginCancellationOutcome, CreateGraphRunOutcome, ResumeOutcome, RoleAbortOutcome,
        SettleCancellationOutcome, TombstoneOutcome,
    },
    run::{
        approval::{
            ApprovalEffect, ApprovalOrigin, ApprovalResolutionCause, ApprovalSubject,
            HumanDecisionCommand, HumanDecisionOutcome,
        },
        event::{
            ApprovalAction, ApprovalCommand, EventLedger, EventLedgerSnapshot, OpaqueId, RunCommand,
        },
    },
    settle_delivery,
};

use super::facts::{ApprovalResolutionInput, TeamRunFactsRestoreInput};
use super::{
    ApprovalResolutionOutcome, GraphRunFacts, OrganizationFacts, OrganizationStore, StoreFault,
    TeamFacts,
};

static NEXT_PATH_ID: AtomicU64 = AtomicU64::new(1);

#[test]
fn decision_ledger_commits_replays_conflicts_and_reopens() {
    let path = test_path("decision-ledger");
    let mut store = OrganizationStore::open(&path).unwrap();
    let command = TeamDecisionCommand::try_new(
        "decision:one",
        "run:one",
        "stage:one",
        TeamDecisionType::Retry,
        Some("reviewed".to_owned()),
        "decision-key:one",
        1,
    )
    .unwrap();
    let first = store.record_decision(command.clone()).unwrap();
    assert!(!first.is_replay());
    let committed_len = fs::metadata(&path).unwrap().len();
    assert!(store.record_decision(command).unwrap().is_replay());
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    let conflict = TeamDecisionCommand::try_new(
        "decision:other",
        "run:one",
        "stage:one",
        TeamDecisionType::Abort,
        None,
        "decision-key:one",
        2,
    )
    .unwrap();
    assert_eq!(
        store.record_decision(conflict),
        Err(StoreFault::InvalidFacts)
    );
    drop(store);
    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(reopened.decisions().count(), 1);
    assert_eq!(
        reopened
            .decision("run:one", "decision-key:one")
            .unwrap()
            .decision(),
        TeamDecisionType::Retry
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn graph_replace_records_once_replays_exactly_and_survives_reopen() {
    let path = test_path("graph-replace");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let definition = GraphDefinition::new(
        "graph:replacement",
        "plan:replacement",
        GraphRunId::new("run:one"),
        "replacement",
        vec![NodeDefinition::start(
            NodeId::new("start"),
            "start",
            NonZeroU32::new(1).unwrap(),
            Some(StartTrigger::Webhook {
                path: "inbound".to_owned(),
            }),
        )],
        Vec::new(),
    )
    .unwrap();
    let command = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("graph-replace:one").unwrap(),
        OpaqueId::try_new("graph-replace-key:one").unwrap(),
        CommandPayload::GraphReplace(definition.clone()),
        2,
    );

    let recorded = store
        .replace_team_graph(command.clone(), definition.clone())
        .unwrap();
    assert!(!recorded.is_replay());
    assert_eq!(recorded.events().len(), 1);
    assert!(matches!(
        recorded.events()[0].payload(),
        crate::run::event::TeamEventPayload::GraphReplaced {
            graph_id,
            workflow_plan_id,
        } if graph_id == "graph:replacement" && workflow_plan_id == "plan:replacement"
    ));
    let committed_len = fs::metadata(&path).unwrap().len();
    assert!(
        store
            .replace_team_graph(command.clone(), definition.clone())
            .unwrap()
            .is_replay()
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);

    let conflicting_definition = GraphDefinition::new(
        "graph:conflict",
        "plan:replacement",
        GraphRunId::new("run:one"),
        "conflict",
        vec![NodeDefinition::start(
            NodeId::new("start"),
            "start",
            NonZeroU32::new(1).unwrap(),
            None,
        )],
        Vec::new(),
    )
    .unwrap();
    let conflicting_command = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("graph-replace:two").unwrap(),
        OpaqueId::try_new("graph-replace-key:one").unwrap(),
        CommandPayload::GraphReplace(conflicting_definition.clone()),
        3,
    );
    assert!(matches!(
        store.replace_team_graph(conflicting_command, conflicting_definition),
        Err(StoreFault::EventLedger(
            crate::RecordCommandError::IdempotencyConflict
        ))
    ));
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .definition(),
        &definition
    );
    assert!(
        reopened
            .replace_team_graph(command, definition)
            .unwrap()
            .is_replay()
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn graph_replace_reopen_preserves_full_definition_metadata_and_command_payload() {
    let path = test_path("graph-replace-rich");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let definition = rich_replacement_definition();
    let command = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("graph-replace:rich").unwrap(),
        OpaqueId::try_new("graph-replace-key:rich").unwrap(),
        CommandPayload::GraphReplace(definition.clone()),
        2,
    );

    assert!(
        !store
            .replace_team_graph(command.clone(), definition.clone())
            .unwrap()
            .is_replay()
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    let restored = reopened
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .definition();
    assert_eq!(restored, &definition);
    assert!(restored.nodes()[0].is_control());
    assert_eq!(
        restored.nodes()[2].work_assignment().unwrap().prompt(),
        "work instruction"
    );
    assert_eq!(
        restored.nodes()[2]
            .work_assignment()
            .unwrap()
            .output_artifact_kind(),
        Some("artifact-report")
    );
    assert_eq!(
        restored.nodes()[2]
            .work_assignment()
            .unwrap()
            .group_id()
            .unwrap()
            .as_str(),
        "group-work"
    );
    assert_eq!(
        restored.nodes()[3].review_assignment().unwrap().prompt(),
        "review instruction"
    );
    assert_eq!(
        restored.nodes()[4].work_group().unwrap().join_policy(),
        &JoinPolicy::new(true, false, 2)
    );
    assert!(!restored.edges()[1].payload().include_upstream_result());
    assert_eq!(
        restored.edges()[1]
            .dependency()
            .unwrap()
            .dependency_task_id(),
        "task-start"
    );
    assert_eq!(
        restored.edges()[1].dependency().unwrap().task_id(),
        "task-work"
    );

    let event_snapshot = reopened.facts().event_snapshot();
    let commands = event_snapshot.commands();
    assert_eq!(commands.len(), 1);
    assert_eq!(
        commands[0].command().payload(),
        &CommandPayload::GraphReplace(definition.clone())
    );
    assert!(
        reopened
            .replace_team_graph(command, definition)
            .unwrap()
            .is_replay()
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn workflow_template_debug_redacts_source_identity_and_task_prompt() {
    let template = super::WorkflowTemplateFacts::new(
        team_id(),
        "source-identity-private-canary",
        9,
        crate::run::WorkflowPlan::new(
            "plan-template",
            "run-template",
            "Template title",
            "active",
            Vec::new(),
            vec![crate::run::WorkflowTask::new(
                "task-template",
                "role-template",
                "Task title",
                "prompt-private-canary",
                Vec::new(),
                Some("artifact-template".to_owned()),
            )],
            "template-idempotency",
            42,
        ),
    )
    .unwrap();

    let debug = format!("{template:?}");
    assert!(debug.contains("<redacted>"));
    assert!(!debug.contains("source-identity-private-canary"));
    assert!(!debug.contains("prompt-private-canary"));
    assert!(debug.contains("plan-template"));
    assert!(debug.contains("task_count: 1"));
}

#[test]
fn reopen_round_trip_preserves_complete_team_definition_without_private_canaries() {
    let path = test_path("team-definition-round-trip");
    let definition = team_definition();
    let revision = TeamRevision::try_new(2).unwrap();
    let facts = OrganizationFacts::restore(
        [TeamFacts::new(definition.clone(), revision, true)],
        [],
        [],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap();

    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();
    drop(store);

    let bytes = fs::read(&path).unwrap();
    assert!(contains(&bytes, definition.name().as_bytes()));
    for private_canary in [
        "teamskill-root-private-canary",
        "workspace-path-private-canary",
        "native-config-private-canary",
        "secret-private-canary",
    ] {
        assert!(!contains(&bytes, private_canary.as_bytes()));
    }

    let reopened = OrganizationStore::open(&path).unwrap();
    let restored = reopened.facts().team(definition.team_id()).unwrap();
    assert_eq!(restored.definition(), &definition);
    assert_eq!(restored.revision(), revision);
    assert!(restored.tombstoned());
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn reopen_round_trip_preserves_graph_display_facts() {
    let path = test_path("round-trip");
    let graph_title = "Release readiness graph";
    let facts = facts_with_run(graph_title, false);

    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();
    drop(store);

    let bytes = fs::read(&path).unwrap();
    assert!(contains(&bytes, graph_title.as_bytes()));
    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(reopened.facts().teams().count(), 1);
    assert_eq!(reopened.facts().runs().count(), 1);
    assert_eq!(reopened.facts().deliveries().deliveries().count(), 0);
    assert_eq!(
        reopened
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .definition()
            .title(),
        graph_title
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn reopen_round_trip_preserves_teamrun_approval_and_event_ledgers_in_one_frame() {
    let path = test_path("teamrun-ledgers");
    let mut approval = Approval::request(ApprovalRequest {
        approval_id: "approval:one".to_owned(),
        run_id: "run:one".to_owned(),
        stage_id: "review".to_owned(),
        role_id: "leader".to_owned(),
        reason: "Review required".to_owned(),
        requested_action: "Release".to_owned(),
        risk_summary: "Production impact".to_owned(),
        idempotency_key: "approval-command:one".to_owned(),
        requested_at: 2,
        subject: ApprovalSubject::Stage {
            stage_id: "review".to_owned(),
        },
        origin: ApprovalOrigin::StageContinuation,
        effect: ApprovalEffect::ResumeStage,
        execution_fence: None,
    });
    approval
        .resolve_with_receipt(
            crate::ApprovalDecision::Approve,
            3,
            Some("Approved".to_owned()),
            "approval-resolution:one".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();
    let mut events = EventLedger::default();
    let command = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("command:one").unwrap(),
        OpaqueId::try_new("command-key:one").unwrap(),
        CommandPayload::ApprovalRequest(ApprovalCommand::new(
            OpaqueId::try_new("approval:one").unwrap(),
            OpaqueId::try_new("review:attempt:one").unwrap(),
            OpaqueId::try_new("leader").unwrap(),
            ApprovalAction::ContinueNode,
        )),
        2,
    );
    let receipt = events.accept(command);
    events
        .append_approval_resolution(
            OpaqueId::try_new("run:one").unwrap(),
            OpaqueId::try_new("approval:one").unwrap(),
            ApprovalDecision::Approve,
            OpaqueId::try_new("approval-resolution:one").unwrap(),
            3,
        )
        .unwrap();
    let facts = OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
        teams: vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        materializations: Vec::new(),
        runs: vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ],
        pending_workflow_plan_admissions: Vec::new(),
        templates: Vec::new(),
        deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
        activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
        triggers: Vec::new(),
        control_resolutions: Vec::new(),
        approvals: vec![approval.durable_snapshot()],
        events: events.snapshot(),
        evidence: Vec::new(),
    })
    .unwrap();

    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();
    let committed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(receipt.events().len(), 1);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let approval = reopened.facts().approvals().next().unwrap();
    assert_eq!(approval.status(), ApprovalStatus::Approved);
    assert_eq!(
        approval.resolution().unwrap().idempotency_key,
        "approval-resolution:one"
    );
    let events = reopened.facts().event_snapshot();
    assert_eq!(events.commands().len(), 1);
    assert_eq!(events.events().len(), 2);
    assert_eq!(events.events()[0].causation_id(), "command:one");
    assert!(matches!(
        events.events()[1].payload(),
        crate::run::event::TeamEventPayload::ApprovalResolved {
            approval_id,
            decision: ApprovalDecision::Approve,
            status: ApprovalStatus::Approved,
        } if approval_id.as_str() == "approval:one"
    ));
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn resolving_an_unknown_approval_fails_closed_without_appending_a_frame() {
    let path = test_path("unknown-approval-resolution");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let committed_len = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.resolve_approval(ApprovalResolutionInput {
            run_id: GraphRunId::new("run:one"),
            approval_id: "approval:missing".to_owned(),
            stage_id: "work".to_owned(),
            role_id: "leader".to_owned(),
            decision: ApprovalDecision::Approve,
            resolved_at: 2,
            note: Some("Approved.".to_owned()),
            idempotency_key: "resolution-key".to_owned(),
        }),
        Err(StoreFault::InvalidFacts)
    );
    assert_eq!(store.facts().approvals().count(), 0);
    assert_eq!(store.facts().event_snapshot().events().len(), 0);
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn approval_resolution_replays_exact_receipts_without_a_frame_and_rejects_conflicts() {
    let path = test_path("approval-resolution-idempotency");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_approvals(["approval:one"]))
        .unwrap();

    assert_eq!(
        store
            .resolve_approval(ApprovalResolutionInput {
                run_id: GraphRunId::new("run:one"),
                approval_id: "approval:one".to_owned(),
                stage_id: "work".to_owned(),
                role_id: "leader".to_owned(),
                decision: ApprovalDecision::Approve,
                resolved_at: 2,
                note: Some("Approved for canary rollout.".to_owned()),
                idempotency_key: "approval-resolution:one".to_owned(),
            })
            .unwrap(),
        ApprovalResolutionOutcome::Recorded
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(store.facts().event_snapshot().events().len(), 1);

    assert_eq!(
        store
            .resolve_approval(ApprovalResolutionInput {
                run_id: GraphRunId::new("run:one"),
                approval_id: "approval:one".to_owned(),
                stage_id: "work".to_owned(),
                role_id: "leader".to_owned(),
                decision: ApprovalDecision::Approve,
                resolved_at: 2,
                note: Some("Approved for canary rollout.".to_owned()),
                idempotency_key: "approval-resolution:one".to_owned(),
            })
            .unwrap(),
        ApprovalResolutionOutcome::Replayed
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    assert_eq!(store.facts().event_snapshot().events().len(), 1);

    assert_eq!(
        store.resolve_approval(ApprovalResolutionInput {
            run_id: GraphRunId::new("run:one"),
            approval_id: "approval:one".to_owned(),
            stage_id: "work".to_owned(),
            role_id: "leader".to_owned(),
            decision: ApprovalDecision::Deny,
            resolved_at: 2,
            note: Some("Denied for canary rollout.".to_owned()),
            idempotency_key: "approval-resolution:one".to_owned(),
        }),
        Err(StoreFault::InvalidFacts)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    let approval = store.facts().approvals().next().unwrap();
    assert_eq!(approval.status(), ApprovalStatus::Approved);
    assert_eq!(approval.resolutions().len(), 1);
    assert_eq!(store.facts().event_snapshot().events().len(), 1);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn team_graph_patch_replays_without_appending_a_frame_and_conflicts_fail_closed() {
    let path = test_path("team-graph-patch-idempotency");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let patch = GraphPatch::new(
        "graph:one",
        "plan:one",
        vec![GraphPatchOperation::RemoveNode(NodeId::new("start"))],
    )
    .unwrap();
    let command = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("patch-command").unwrap(),
        OpaqueId::try_new("patch-key").unwrap(),
        CommandPayload::GraphPatch(
            crate::run::event::GraphPatch::try_new(
                "graph:one",
                "plan:one",
                vec![crate::run::event::GraphPatchOperation::RemoveNode {
                    node_id: "start".to_owned(),
                }],
            )
            .unwrap(),
        ),
        2,
    );

    assert!(
        store
            .team_graph_patch(command.clone(), patch.clone())
            .is_err()
    );
    let before = fs::metadata(&path).unwrap().len();
    let valid = GraphPatch::new(
        "graph:one",
        "plan:one",
        vec![GraphPatchOperation::AddNode(NodeDefinition::control(
            NodeId::new("end"),
            NodeKind::End,
            "end",
            NonZeroU32::new(1).unwrap(),
        ))],
    )
    .unwrap();
    let audit = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("patch-command-valid").unwrap(),
        OpaqueId::try_new("patch-key-valid").unwrap(),
        CommandPayload::GraphPatch(
            crate::run::event::GraphPatch::try_new(
                "graph:one",
                "plan:one",
                vec![crate::run::event::GraphPatchOperation::AddNode {
                    node_id: "end".to_owned(),
                    kind: crate::run::event::GraphNodeKind::End,
                    role_id: None,
                }],
            )
            .unwrap(),
        ),
        3,
    );
    let recorded = store.team_graph_patch(audit.clone(), valid).unwrap();
    assert!(!recorded.is_replay());
    let committed = fs::metadata(&path).unwrap().len();
    assert!(committed > before);
    let replay = store.team_graph_patch(audit, patch).unwrap();
    assert!(replay.is_replay());
    assert_eq!(fs::metadata(&path).unwrap().len(), committed);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn team_node_events_apply_only_current_progress_input_and_approval_facts() {
    let path = test_path("node-event-fences");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts_with_work_root()).unwrap();
    let execution = OpaqueId::try_new("work:attempt:1").unwrap();
    let progress = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("progress-command").unwrap(),
        OpaqueId::try_new("progress-key").unwrap(),
        CommandPayload::NodeProgress(NodeProgressCommand::progress(execution.clone())),
        2,
    );
    assert_eq!(
        store.team_node_event(
            progress,
            TeamNodeEvent::progress(
                execution.clone(),
                Some(OpaqueId::try_new("leader").unwrap())
            ),
        ),
        Ok(TeamNodeEventOutcome::Progressed)
    );
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .status(),
        AttemptStatus::Ready
    );

    let approval = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("approval-command").unwrap(),
        OpaqueId::try_new("approval-key").unwrap(),
        CommandPayload::ApprovalRequest(ApprovalCommand::new(
            OpaqueId::try_new("team-approval-approval-key").unwrap(),
            execution.clone(),
            OpaqueId::try_new("leader").unwrap(),
            ApprovalAction::ExternalAction,
        )),
        3,
    );
    assert_eq!(
        store.team_node_event(
            approval,
            TeamNodeEvent::request_approval(
                execution,
                Some(OpaqueId::try_new("leader").unwrap()),
                ApprovalAction::ExternalAction,
            ),
        ),
        Ok(TeamNodeEventOutcome::ApprovalRequested)
    );
    let attempt = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("work"))
        .unwrap();
    assert_eq!(attempt.status(), AttemptStatus::Waiting);
    let approval = store.facts().approvals().next().unwrap();
    assert_eq!(
        approval.facts().execution_fence.as_deref(),
        Some("work:attempt:1")
    );
    drop(store);
    remove_test_path(&path);
}

#[test]
fn terminal_team_node_events_cannot_forge_graph_outcomes() {
    let path = test_path("terminal-node-event");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let execution = "start:attempt:1";
    let command = RunCommand::new(
        OpaqueId::try_new("run:one").unwrap(),
        OpaqueId::try_new("terminal-command").unwrap(),
        OpaqueId::try_new("terminal-key").unwrap(),
        CommandPayload::NodeProgress(NodeProgressCommand::progress(
            OpaqueId::try_new(execution).unwrap(),
        )),
        2,
    );

    assert_eq!(
        store.team_node_event(
            command,
            TeamNodeEvent::complete(OpaqueId::try_new(execution).unwrap(), None),
        ),
        Ok(TeamNodeEventOutcome::TerminalReceiptRequired)
    );
    let attempt = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("start"))
        .unwrap();
    assert_eq!(attempt.status(), AttemptStatus::Ready);
    assert!(attempt.output_port().is_none());
    drop(store);
    remove_test_path(&path);
}

#[test]
fn durable_restore_rejects_a_resolution_event_tampered_to_another_decision() {
    let mut approval = approval("approval:one");
    approval
        .resolve_with_receipt(
            ApprovalDecision::Approve,
            2,
            None,
            "resolution-key".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();
    let mut events = EventLedger::default();
    events
        .append_approval_resolution(
            OpaqueId::try_new("run:one").unwrap(),
            OpaqueId::try_new("approval:one").unwrap(),
            ApprovalDecision::Deny,
            OpaqueId::try_new("resolution-key").unwrap(),
            2,
        )
        .unwrap();

    assert_eq!(
        OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
            teams: vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            materializations: Vec::new(),
            runs: vec![
                GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None)
                    .unwrap(),
            ],
            pending_workflow_plan_admissions: Vec::new(),
            templates: Vec::new(),
            deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
            activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
            triggers: Vec::new(),
            control_resolutions: Vec::new(),
            approvals: vec![approval.durable_snapshot()],
            events: events.snapshot(),
            evidence: Vec::new(),
        }),
        Err(super::OrganizationFactsError::InvalidApprovalLedger)
    );
}

#[test]
fn unknown_approval_resolution_fails_closed_for_existing_and_missing_runs() {
    let path = test_path("unknown-approval-run-context");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(delivered_terminal_facts()).unwrap();
    let committed_len = fs::metadata(&path).unwrap().len();

    for run_id in ["run:two", "run:missing"] {
        assert_eq!(
            store.resolve_approval(ApprovalResolutionInput {
                run_id: GraphRunId::new(run_id),
                approval_id: "approval:missing".to_owned(),
                stage_id: "work".to_owned(),
                role_id: "leader".to_owned(),
                decision: ApprovalDecision::Approve,
                resolved_at: 2,
                note: None,
                idempotency_key: "resolution-key".to_owned(),
            }),
            Err(StoreFault::InvalidFacts)
        );
    }
    assert_eq!(store.facts().approvals().count(), 0);
    assert_eq!(store.facts().event_snapshot().events().len(), 0);
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn existing_approval_resolution_preserves_actor_append_order_across_reopen() {
    let path = test_path("interleaved-approval-resolutions");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_approvals(["approval:z", "approval:a"]))
        .unwrap();

    store
        .resolve_approval(ApprovalResolutionInput {
            run_id: GraphRunId::new("run:one"),
            approval_id: "approval:z".to_owned(),
            stage_id: "work".to_owned(),
            role_id: "leader".to_owned(),
            decision: ApprovalDecision::Approve,
            resolved_at: 2,
            note: None,
            idempotency_key: "resolution-z".to_owned(),
        })
        .unwrap();
    store
        .resolve_approval(ApprovalResolutionInput {
            run_id: GraphRunId::new("run:one"),
            approval_id: "approval:a".to_owned(),
            stage_id: "work".to_owned(),
            role_id: "leader".to_owned(),
            decision: ApprovalDecision::Deny,
            resolved_at: 3,
            note: None,
            idempotency_key: "resolution-a".to_owned(),
        })
        .unwrap();
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let events = reopened.facts().event_snapshot();
    assert_eq!(
        events
            .events()
            .iter()
            .map(|event| (event.sequence(), event.causation_id()))
            .collect::<Vec<_>>(),
        vec![(1, "approval:z"), (2, "approval:a")]
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn durable_restore_rejects_approval_history_without_its_append_only_resolution_event() {
    let mut approval = approval("approval:one");
    approval
        .resolve_with_receipt(
            ApprovalDecision::Approve,
            2,
            Some("Approved.".to_owned()),
            "resolution-key".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();

    assert_eq!(
        OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
            teams: vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false
            )]
            .into_iter()
            .collect(),
            materializations: [].into_iter().collect(),
            runs: vec![
                GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None)
                    .unwrap()
            ]
            .into_iter()
            .collect(),
            pending_workflow_plan_admissions: Vec::new(),
            templates: Vec::new(),
            deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
            activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
            triggers: [].into_iter().collect(),
            control_resolutions: [].into_iter().collect(),
            approvals: [approval.durable_snapshot()].into_iter().collect(),
            events: EventLedger::default().snapshot(),
            evidence: [].into_iter().collect(),
        }),
        Err(super::OrganizationFactsError::InvalidApprovalLedger)
    );
}

#[test]
fn work_node_approval_resolution_does_not_complete_a_waiting_attempt() {
    let path = test_path("work-node-approval-waiting");
    let (delivery, mut graph, binding) = delivered_work_delivery_and_graph();
    let work_id = NodeId::new("work");
    let fence = graph.current_attempt(&work_id).unwrap().fence().clone();
    graph = reduce(
        graph,
        GraphEvent::NodeWaiting {
            node_id: work_id.clone(),
            fence,
            waiting_at: 4,
        },
    )
    .unwrap();
    let facts = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        vec![terminal_materialization()],
        vec![
            GraphRunFacts::new(
                team_id(),
                TeamRevision::initial(),
                graph,
                Some(runtime(binding)),
            )
            .unwrap(),
        ],
        DeliveryLedgerSnapshot::new(vec![delivery.snapshot()]),
    )
    .unwrap();
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(
            OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
                teams: facts.teams().cloned().collect(),
                materializations: facts.materializations().cloned().collect(),
                runs: facts.runs().cloned().collect(),
                pending_workflow_plan_admissions: Vec::new(),
                templates: Vec::new(),
                deliveries: facts.deliveries().snapshot(),
                activities: facts.activities().snapshot(),
                triggers: facts.triggers().requests().cloned().collect(),
                control_resolutions: facts.control_node_resolutions().cloned().collect(),
                approvals: vec![
                    Approval::request(ApprovalRequest {
                        approval_id: "approval:work".to_owned(),
                        run_id: "run:one".to_owned(),
                        stage_id: "work".to_owned(),
                        role_id: "leader".to_owned(),
                        reason: "Review required".to_owned(),
                        requested_action: "Release".to_owned(),
                        risk_summary: "Production impact".to_owned(),
                        idempotency_key: "approval-request-key".to_owned(),
                        requested_at: 4,
                        subject: ApprovalSubject::WorkNode {
                            node_id: "work".to_owned(),
                        },
                        origin: ApprovalOrigin::WorkNode,
                        effect: ApprovalEffect::KeepNodeWaiting,
                        execution_fence: Some("work:attempt:1".to_owned()),
                    })
                    .durable_snapshot(),
                ],
                events: facts.event_snapshot(),
                evidence: facts.evidence_records().cloned().collect(),
            })
            .unwrap(),
        )
        .unwrap();

    store
        .resolve_approval(ApprovalResolutionInput {
            run_id: GraphRunId::new("run:one"),
            approval_id: "approval:work".to_owned(),
            stage_id: "work".to_owned(),
            role_id: "leader".to_owned(),
            decision: ApprovalDecision::Approve,
            resolved_at: 5,
            note: None,
            idempotency_key: "resolution-key".to_owned(),
        })
        .unwrap();

    let attempt = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&work_id)
        .unwrap();
    assert_eq!(attempt.status(), AttemptStatus::Waiting);
    assert!(attempt.output_port().is_none());
    drop(store);
    remove_test_path(&path);
}

#[test]
fn open_creates_nested_durable_path_and_enforces_single_writer() {
    let path = test_path("nested").join("a").join("b").join("facts.log");
    let store = OrganizationStore::open(&path).unwrap();
    assert!(path.is_file());
    drop(store);
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock_path = PathBuf::from(lock_path);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .unwrap();
    assert!(matches!(
        OrganizationStore::open(&path),
        Err(StoreFault::WriterBusy)
    ));
    fs::remove_file(lock_path).unwrap();
    assert!(OrganizationStore::open(&path).is_ok());
    remove_test_path(&path);
}

#[test]
fn incomplete_trailing_frame_is_discarded_on_reopen() {
    let path = test_path("trailing");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    drop(store);
    let committed_len = fs::metadata(&path).unwrap().len();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&[0xA1, 0, 1]).unwrap();
    file.sync_all().unwrap();

    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    assert_eq!(reopened.facts().runs().count(), 1);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn checksum_and_schema_corruption_fail_closed_without_echoing_bytes() {
    let path = test_path("corrupt");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    drop(store);

    let mut corrupt = fs::read(&path).unwrap();
    *corrupt.last_mut().unwrap() ^= 0xFF;
    fs::write(&path, corrupt).unwrap();
    assert!(matches!(
        OrganizationStore::open(&path),
        Err(StoreFault::CorruptRecord)
    ));

    let schema_path = test_path("schema");
    let schema_store = OrganizationStore::open(&schema_path).unwrap();
    drop(schema_store);
    let mut unsupported = fs::read(&schema_path).unwrap();
    unsupported[8] = 99;
    fs::write(&schema_path, unsupported).unwrap();
    assert!(matches!(
        OrganizationStore::open(&schema_path),
        Err(StoreFault::UnsupportedSchemaVersion(99))
    ));
    remove_test_path(&path);
    remove_test_path(&schema_path);
}

#[test]
fn facts_restore_rejects_duplicate_and_mismatched_indexes() {
    let team = TeamFacts::new(team_definition(), TeamRevision::initial(), false);
    let duplicate = OrganizationFacts::restore(
        vec![team.clone(), team],
        [],
        [],
        DeliveryLedgerSnapshot::new(Vec::new()),
    );
    assert!(matches!(
        duplicate,
        Err(super::OrganizationFactsError::DuplicateTeam)
    ));

    let unknown_run = GraphRunFacts::new(
        TeamId::try_new("team:unknown").unwrap(),
        TeamRevision::initial(),
        graph("display"),
        None,
    )
    .unwrap();
    let mismatched = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![unknown_run],
        DeliveryLedgerSnapshot::new(Vec::new()),
    );
    assert!(matches!(
        mismatched,
        Err(super::OrganizationFactsError::UnknownRunTeam)
    ));
}

#[test]
fn durable_restore_rejects_duplicate_matcha_terminal_correlation() {
    let correlation = NativeDeliveryCorrelation::new(
        EndpointSessionId::try_new("matcha-session-correlation-canary").unwrap(),
        NativeRunReceiptReference::try_new("matcha-native-run-correlation-canary").unwrap(),
    );
    let first = DeliverySnapshot::new(
        delivery_request(),
        DeliveryPhaseSnapshot::Delivered {
            receipt: crate::DeliveryReceiptReference::try_new("delivery-receipt:one").unwrap(),
            native_correlation: Some(correlation.clone()),
            accepted_at: 3,
        },
        0,
        2,
    );
    let mut second_request = delivery_request();
    second_request.delivery_id = DeliveryId::new("delivery:two").unwrap();
    second_request.idempotency_key = "delivery:two".to_owned();
    let second = DeliverySnapshot::new(
        second_request,
        DeliveryPhaseSnapshot::Delivered {
            receipt: crate::DeliveryReceiptReference::try_new("delivery-receipt:two").unwrap(),
            native_correlation: Some(correlation),
            accepted_at: 3,
        },
        0,
        2,
    );

    assert_eq!(
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false
            )],
            [],
            vec![
                GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None)
                    .unwrap(),
            ],
            DeliveryLedgerSnapshot::new(vec![first, second]),
        ),
        Err(super::OrganizationFactsError::DuplicateMatchaTerminalCorrelation),
    );
}

#[test]
fn trigger_registration_restore_requires_matching_graph_attempt() {
    let request =
        TriggerFireRequest::try_new("run:one", "start", TriggerSource::Webhook, "request:one")
            .unwrap();
    let graph = facts_with_armed_webhook_run()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .clone();
    let run = GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap();

    assert_eq!(
        OrganizationFacts::restore_with_triggers(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false
            )],
            [],
            vec![run],
            DeliveryLedgerSnapshot::new(Vec::new()),
            [request.clone()],
        ),
        Err(super::OrganizationFactsError::InvalidTriggerRegistration),
    );

    let mut facts = facts_with_armed_webhook_run();
    facts.fire_trigger(request, 2).unwrap();
    assert_eq!(
        OrganizationFacts::restore(
            facts.teams().cloned(),
            facts.materializations().cloned(),
            facts.runs().cloned(),
            facts.deliveries().snapshot(),
        ),
        Err(super::OrganizationFactsError::InvalidTriggerRegistration),
    );
}

#[test]
fn durable_trigger_fire_records_once_replays_without_refiring_and_survives_reopen() {
    let path = test_path("trigger-fire");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts_with_armed_webhook_run()).unwrap();
    let request =
        TriggerFireRequest::try_new("run:one", "start", TriggerSource::Webhook, "request:one")
            .unwrap();

    assert_eq!(
        store.fire_trigger(request.clone(), 2),
        Ok(TriggerRegistration::Recorded(request.clone()))
    );
    let graph = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph();
    assert_eq!(
        graph
            .current_attempt(&NodeId::new("start"))
            .unwrap()
            .number()
            .get(),
        1
    );
    assert_eq!(
        graph
            .current_attempt(&NodeId::new("start"))
            .unwrap()
            .reason(),
        &crate::AttemptReason::Trigger
    );
    let len_after_first_fire = fs::metadata(&path).unwrap().len();
    let bytes = fs::read(&path).unwrap();
    assert!(contains(&bytes, b"/team/release"));
    assert!(contains(&bytes, b"request:one"));

    assert_eq!(
        store.fire_trigger(request.clone(), 3),
        Ok(TriggerRegistration::Replayed(request.clone()))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), len_after_first_fire);
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("start"))
            .unwrap()
            .number()
            .get(),
        1
    );
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .triggers()
            .request("run:one", "request:one"),
        Some(&request)
    );
    assert_eq!(
        reopened
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("start"))
            .unwrap()
            .reason(),
        &crate::AttemptReason::Trigger
    );
    assert_eq!(
        reopened.fire_trigger(request.clone(), 4),
        Ok(TriggerRegistration::Replayed(request))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), len_after_first_fire);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn team_tombstone_is_logical_idempotent_and_preserves_materialization() {
    let path = test_path("team-tombstone-materialization");
    let team_id = TeamId::try_new("team:one").unwrap();
    let cleanup_key = crate::IdempotencyKey::try_new("cleanup:team-one").unwrap();
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(provisionable_facts()).unwrap();

    assert_eq!(
        store.tombstone_team(&team_id, cleanup_key.clone()),
        Ok(super::facts::TeamTombstoneOutcome::Tombstoned)
    );
    let after_tombstone = fs::metadata(&path).unwrap().len();
    assert!(store.facts().team(&team_id).unwrap().tombstoned());
    assert_eq!(
        store.facts().materialization(&team_id),
        Some(&terminal_materialization())
    );
    let lifecycle = store.facts().materialization_lifecycles().next().unwrap();
    assert!(matches!(
        lifecycle,
        crate::TeamMaterializationLifecycle::Tombstoned(
            crate::TombstonedMaterialization::Confirmed {
                cleanup: crate::TeamMaterializationCleanup::Pending(removal),
                ..
            }
        ) if removal.idempotency_key() == &cleanup_key
    ));

    assert_eq!(
        store.tombstone_team(&team_id, cleanup_key.clone()),
        Ok(super::facts::TeamTombstoneOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_tombstone);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert!(reopened.facts().team(&team_id).unwrap().tombstoned());
    assert_eq!(
        reopened.facts().materialization(&team_id),
        Some(&terminal_materialization())
    );
    assert!(matches!(
        reopened.facts().materialization_lifecycles().next(),
        Some(crate::TeamMaterializationLifecycle::Tombstoned(
            crate::TombstonedMaterialization::Confirmed {
                cleanup: crate::TeamMaterializationCleanup::Pending(removal),
                ..
            }
        )) if removal.idempotency_key() == &cleanup_key
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn manual_materialization_round_trips_and_keeps_external_agents_opaque() {
    let path = test_path("manual-materialization-round-trip");
    let mut store = OrganizationStore::open(&path).unwrap();
    let materialization = crate::compile_manual_team_materialization(
        TeamId::try_new("team:manual").unwrap(),
        "Selected Team",
        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        vec![
            crate::ManualTeamRoleBinding::try_new(
                RoleId::try_new("leader").unwrap(),
                "Lead",
                ManagedAgentReference::try_new("existing-lead").unwrap(),
                true,
            )
            .unwrap(),
            crate::ManualTeamRoleBinding::try_new(
                RoleId::try_new("reviewer").unwrap(),
                "Reviewer",
                ManagedAgentReference::try_new("existing-reviewer").unwrap(),
                false,
            )
            .unwrap(),
        ],
        IdempotencyKey::try_new("materialize:manual").unwrap(),
    )
    .unwrap();
    let team = materialization.definition().team_id().clone();
    let request = materialization.request().clone();

    assert_eq!(
        store.create_team_materialization(materialization),
        Ok(MaterializationRecordOutcome::Recorded)
    );
    assert_eq!(store.facts().runs().count(), 0);
    assert!(
        request
            .intent()
            .agents()
            .iter()
            .all(|agent| matches!(agent.agent(), RoleMaterializationAgent::External { .. }))
    );
    let persisted = fs::read(&path).unwrap();
    assert!(!contains(&persisted, b"workspace-path-private-canary"));
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let team_facts = reopened.facts().team(&team).unwrap();
    assert_eq!(team_facts.definition().name(), "Selected Team");
    let lifecycle = reopened
        .facts()
        .materialization_lifecycles()
        .next()
        .unwrap();
    assert!(matches!(
        lifecycle,
        crate::TeamMaterializationLifecycle::OutcomeUnknown(request)
            if request.intent().source() == MaterializationSource::Manual
                && request.intent().agents().iter().all(|agent| matches!(
                    agent.agent(),
                    RoleMaterializationAgent::External { .. }
                ))
    ));
    assert!(reopened.facts().materialization(&team).is_none());
    assert_eq!(
        reopened.materialization_receipt_recovery_teams(),
        vec![team.clone()]
    );
    assert_eq!(reopened.facts().runs().count(), 0);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn materialization_readback_confirms_an_ambiguous_durable_request_without_creating_a_run() {
    let path = test_path("materialization-readback-confirmation");
    let mut store = OrganizationStore::open(&path).unwrap();
    let materialization = crate::compile_manual_team_materialization(
        TeamId::try_new("team:readback").unwrap(),
        "Readback Team",
        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        vec![
            crate::ManualTeamRoleBinding::try_new(
                RoleId::try_new("leader").unwrap(),
                "Lead",
                ManagedAgentReference::try_new("existing-lead").unwrap(),
                true,
            )
            .unwrap(),
        ],
        IdempotencyKey::try_new("materialize:readback").unwrap(),
    )
    .unwrap();
    let team = materialization.definition().team_id().clone();
    assert_eq!(
        store.create_team_materialization(materialization),
        Ok(MaterializationRecordOutcome::Recorded)
    );
    store
        .record_team_materialization_outcome(&team, MaterializationOperationOutcome::OutcomeUnknown)
        .unwrap();
    let receipt = MaterializationReceipt::try_new(
        team.clone(),
        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        vec![RoleMaterializationReceipt::with_ownership(
            RoleId::try_new("leader").unwrap(),
            ManagedAgentReference::try_new("existing-lead").unwrap(),
            crate::RoleMaterializationOwnership::External,
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        )],
    )
    .unwrap();

    assert_eq!(
        store.confirm_team_materialization(receipt.clone()),
        Ok(MaterializationRecordOutcome::Recorded)
    );
    assert_eq!(store.facts().materialization(&team), Some(&receipt));
    assert_eq!(store.facts().runs().count(), 0);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(reopened.facts().materialization(&team), Some(&receipt));
    assert!(reopened.materialization_receipt_recovery_teams().is_empty());
    assert_eq!(reopened.facts().runs().count(), 0);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn external_manual_removal_stays_opaque_and_does_not_create_runs() {
    let path = test_path("external-manual-removal");
    let mut store = OrganizationStore::open(&path).unwrap();
    let materialization = crate::compile_manual_team_materialization(
        TeamId::try_new("team:external").unwrap(),
        "Selected Team",
        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        vec![
            crate::ManualTeamRoleBinding::try_new(
                RoleId::try_new("leader").unwrap(),
                "Lead",
                ManagedAgentReference::try_new("existing-lead").unwrap(),
                true,
            )
            .unwrap(),
        ],
        IdempotencyKey::try_new("materialize:external").unwrap(),
    )
    .unwrap();
    let team = materialization.definition().team_id().clone();
    store.create_team_materialization(materialization).unwrap();
    store
        .record_team_materialization_outcome(
            &team,
            MaterializationOperationOutcome::Confirmed {
                receipt: MaterializationReceipt::try_new(
                    team.clone(),
                    RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                    vec![RoleMaterializationReceipt::with_ownership(
                        RoleId::try_new("leader").unwrap(),
                        ManagedAgentReference::try_new("existing-lead").unwrap(),
                        crate::RoleMaterializationOwnership::External,
                        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                    )],
                )
                .unwrap(),
            },
        )
        .unwrap();
    store
        .tombstone_team(&team, IdempotencyKey::try_new("cleanup:external").unwrap())
        .unwrap();

    let removal = store.team_materialization_removal(&team).unwrap();
    assert!(matches!(
        removal.receipt().roles()[0].ownership(),
        crate::RoleMaterializationOwnership::External
    ));
    assert_eq!(store.facts().runs().count(), 0);
    let persisted = fs::read(&path).unwrap();
    assert!(!contains(&persisted, b"external-workspace-path-canary"));
    drop(store);
    remove_test_path(&path);
}

#[test]
fn only_confirmed_tombstoned_materializations_produce_fenced_removals() {
    let path = test_path("materialization-removal-fencing");
    let team = TeamId::try_new("team:one").unwrap();
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(provisionable_facts()).unwrap();
    let before = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.tombstone_team(&team, IdempotencyKey::try_new("cleanup:one").unwrap()),
        Ok(crate::TeamTombstoneOutcome::Tombstoned)
    );
    assert!(store.team_materialization_removal(&team).is_none());
    store
        .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2)
        .unwrap();
    store
        .settle_graph_run_cancellation(
            &GraphRunId::new("run:one"),
            "cancel:one",
            RoleAbortOutcome::Confirmed,
            3,
        )
        .unwrap();
    assert!(store.team_materialization_removal(&team).is_none());
    store
        .tombstone_graph_run(&GraphRunId::new("run:one"), "tombstone:one", 4)
        .unwrap();
    let removal = store
        .team_materialization_removal(&team)
        .expect("confirmed tombstone has one removal after all runs tombstone");
    assert_eq!(removal.receipt(), &terminal_materialization());
    assert_eq!(removal.idempotency_key().as_str(), "cleanup:one");
    let tombstoned_len = fs::metadata(&path).unwrap().len();
    assert!(tombstoned_len > before);
    assert_eq!(
        store.tombstone_team(&team, IdempotencyKey::try_new("cleanup:other").unwrap()),
        Ok(crate::TeamTombstoneOutcome::Replayed)
    );
    assert_eq!(
        store.team_materialization_removal(&team),
        Some(removal.clone())
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), tombstoned_len);

    assert_eq!(
        store.record_team_materialization_cleanup_outcome(
            &team,
            MaterializationOperationOutcome::Confirmed {
                receipt: terminal_materialization(),
            },
        ),
        Ok(MaterializationRecordOutcome::Recorded)
    );
    let confirmed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.record_team_materialization_cleanup_outcome(
            &team,
            MaterializationOperationOutcome::Confirmed {
                receipt: terminal_materialization(),
            },
        ),
        Ok(MaterializationRecordOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), confirmed_len);
    assert!(matches!(
        store
            .facts()
            .materialization_lifecycles()
            .next()
            .unwrap()
            .cleanup(),
        Some(crate::TeamMaterializationCleanup::Confirmed(recorded)) if recorded == &removal
    ));
    assert_eq!(store.facts().runs().count(), 1);
    assert!(matches!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .lifecycle()
            .state(),
        crate::GraphRunLifecycleState::Tombstoned { .. }
    ));
    drop(store);
    remove_test_path(&path);
}

#[test]
fn unknown_or_rejected_materializations_cannot_produce_removals() {
    for (name, outcome) in [
        ("unknown", MaterializationOperationOutcome::OutcomeUnknown),
        (
            "rejected",
            MaterializationOperationOutcome::Rejected {
                rejection: MaterializationRejection::Permanent,
            },
        ),
    ] {
        let path = test_path(name);
        let mut store = OrganizationStore::open(&path).unwrap();
        let materialization = crate::compile_manual_team_materialization(
            TeamId::try_new(format!("team:{name}")).unwrap(),
            "Selected Team",
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            vec![
                crate::ManualTeamRoleBinding::try_new(
                    RoleId::try_new("leader").unwrap(),
                    "Lead",
                    ManagedAgentReference::try_new("existing-lead").unwrap(),
                    true,
                )
                .unwrap(),
            ],
            IdempotencyKey::try_new(format!("materialize:{name}")).unwrap(),
        )
        .unwrap();
        let team = materialization.definition().team_id().clone();
        store.create_team_materialization(materialization).unwrap();
        store
            .record_team_materialization_outcome(&team, outcome)
            .unwrap();
        store
            .tombstone_team(
                &team,
                IdempotencyKey::try_new(format!("cleanup:{name}")).unwrap(),
            )
            .unwrap();

        assert!(store.team_materialization_removal(&team).is_none());
        assert_eq!(store.facts().runs().count(), 0);
        drop(store);
        remove_test_path(&path);
    }
}

#[test]
fn graph_run_lifecycle_is_append_only_idempotent_and_recovers_tombstones() {
    let path = test_path("graph-run-lifecycle");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(
            OrganizationFacts::restore(
                vec![TeamFacts::new(
                    team_definition(),
                    TeamRevision::initial(),
                    false,
                )],
                [],
                [],
                DeliveryLedgerSnapshot::new(Vec::new()),
            )
            .unwrap(),
        )
        .unwrap();
    let run =
        GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("lifecycle"), None).unwrap();

    assert_eq!(
        store.create_graph_run(run.clone(), "create:one"),
        Err(StoreFault::InvalidFacts)
    );
    assert!(store.facts().run(&GraphRunId::new("run:one")).is_none());
    store
        .replace_facts(
            OrganizationFacts::restore(
                vec![TeamFacts::new(
                    team_definition(),
                    TeamRevision::initial(),
                    false,
                )],
                vec![terminal_materialization()],
                [],
                DeliveryLedgerSnapshot::new(Vec::new()),
            )
            .unwrap(),
        )
        .unwrap();

    assert_eq!(
        store.create_graph_run(run.clone(), "create:one"),
        Ok(CreateGraphRunOutcome::Created(GraphRunId::new("run:one")))
    );
    let after_create = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.create_graph_run(run.clone(), "create:one"),
        Ok(CreateGraphRunOutcome::Replayed(GraphRunId::new("run:one")))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_create);
    assert_eq!(
        store.create_graph_run(run, "create:other"),
        Ok(CreateGraphRunOutcome::ExistingRun)
    );
    let conflicting_run = GraphRunFacts::new(
        team_id(),
        TeamRevision::initial(),
        graph_for_run("run:two", "conflicting"),
        None,
    )
    .unwrap();
    assert_eq!(
        store.create_graph_run(conflicting_run, "create:one"),
        Ok(CreateGraphRunOutcome::ConflictingIdempotency)
    );

    assert!(matches!(
        store.begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2),
        Ok(BeginCancellationOutcome::Started(_))
    ));
    let after_cancellation_started = fs::metadata(&path).unwrap().len();
    assert!(matches!(
        store.begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 3),
        Ok(BeginCancellationOutcome::Replayed(_))
    ));
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        after_cancellation_started
    );
    assert_eq!(
        store.settle_graph_run_cancellation(
            &GraphRunId::new("run:one"),
            "cancel:one",
            RoleAbortOutcome::Confirmed,
            4,
        ),
        Ok(SettleCancellationOutcome::Cancelled)
    );
    let after_cancellation_settled = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.settle_graph_run_cancellation(
            &GraphRunId::new("run:one"),
            "cancel:one",
            RoleAbortOutcome::Confirmed,
            5,
        ),
        Ok(SettleCancellationOutcome::Replayed)
    );
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        after_cancellation_settled
    );
    assert_eq!(
        store.tombstone_graph_run(&GraphRunId::new("run:one"), "delete:one", 6),
        Ok(TombstoneOutcome::Tombstoned)
    );
    let after_tombstone = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.tombstone_graph_run(&GraphRunId::new("run:one"), "delete:one", 7),
        Ok(TombstoneOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_tombstone);
    assert_eq!(
        store.resume_graph_runs(&team_id()),
        vec![ResumeOutcome::Tombstoned(GraphRunId::new("run:one"))]
    );
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened.resume_graph_runs(&team_id()),
        vec![ResumeOutcome::Tombstoned(GraphRunId::new("run:one"))]
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn workflow_plan_run_persists_complete_template_and_is_idempotent() {
    let path = test_path("workflow-plan-run-lifecycle");
    let team = team_id();
    let run_id = GraphRunId::new("run:workflow-plan");
    let creation_key = "create:workflow-plan";
    let plan = workflow_plan("run:workflow-plan", "template-key:workflow-plan");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(
            OrganizationFacts::restore(
                [TeamFacts::new(
                    team_definition(),
                    TeamRevision::initial(),
                    false,
                )],
                [terminal_materialization()],
                [],
                DeliveryLedgerSnapshot::new(Vec::new()),
            )
            .unwrap(),
        )
        .unwrap();

    let before_create = super::codec::recover_log(fs::File::open(&path).unwrap()).unwrap();
    assert_eq!(before_create.facts.templates().count(), 0);
    assert_eq!(before_create.facts.runs().count(), 0);
    assert_eq!(
        store.create_workflow_plan_run(
            team.clone(),
            run_id.clone(),
            creation_key,
            plan.clone(),
            "source:workflow-plan".to_owned(),
            7,
            42,
        ),
        Ok(CreateGraphRunOutcome::Created(run_id.clone()))
    );

    let after_create = super::codec::recover_log(fs::File::open(&path).unwrap()).unwrap();
    assert_eq!(after_create.epoch, before_create.epoch + 1);
    let persisted_template = after_create.facts.template(&team).unwrap();
    assert_eq!(persisted_template.team(), &team);
    assert_eq!(persisted_template.source_identity(), "source:workflow-plan");
    assert_eq!(persisted_template.revision(), 7);
    assert_eq!(persisted_template.plan(), &plan);
    let persisted_run = after_create.facts.run(&run_id).unwrap();
    let compiled = crate::run::compile_workflow_plan(&plan).unwrap();
    assert_eq!(persisted_run.graph().definition().run_id(), &run_id);
    assert_eq!(
        persisted_run.graph().definition().workflow_plan_id(),
        "graph-create:workflow-plan"
    );
    assert_eq!(
        persisted_run.graph().definition().title(),
        compiled.definition().title()
    );
    assert_eq!(
        persisted_run.graph().definition().nodes(),
        compiled.definition().nodes()
    );
    assert_eq!(
        persisted_run.graph().definition().edges(),
        compiled.definition().edges()
    );

    let committed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.create_workflow_plan_run(
            team.clone(),
            run_id.clone(),
            creation_key,
            plan.clone(),
            "source:workflow-plan".to_owned(),
            7,
            42,
        ),
        Ok(CreateGraphRunOutcome::Replayed(run_id.clone()))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    assert_eq!(
        store.create_workflow_plan_run(
            team.clone(),
            run_id.clone(),
            "create:other",
            plan.clone(),
            "source:workflow-plan".to_owned(),
            7,
            42,
        ),
        Ok(CreateGraphRunOutcome::ExistingRun)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    assert_eq!(
        store.create_workflow_plan_run(
            team.clone(),
            GraphRunId::new("run:other"),
            creation_key,
            workflow_plan("run:other", "template-key:other"),
            "source:other".to_owned(),
            7,
            43,
        ),
        Ok(CreateGraphRunOutcome::ConflictingIdempotency)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);

    drop(store);
    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(reopened.facts().template(&team).unwrap().plan(), &plan);
    assert_eq!(
        reopened.facts().run(&run_id).unwrap().graph().definition(),
        persisted_run.graph().definition()
    );
    assert_eq!(reopened.facts().templates().count(), 1);
    assert_eq!(reopened.facts().runs().count(), 1);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn workflow_plan_run_rejects_invalid_inputs_without_durable_side_effects() {
    let missing_receipt_path = test_path("workflow-plan-run-missing-receipt");
    let team = team_id();
    let run_id = GraphRunId::new("run:missing-receipt");
    let plan = workflow_plan("run:missing-receipt", "template-key:missing-receipt");
    let mut store = OrganizationStore::open(&missing_receipt_path).unwrap();
    store
        .replace_facts(
            OrganizationFacts::restore(
                [TeamFacts::new(
                    team_definition(),
                    TeamRevision::initial(),
                    false,
                )],
                [],
                [],
                DeliveryLedgerSnapshot::new(Vec::new()),
            )
            .unwrap(),
        )
        .unwrap();
    let before_facts = store.facts().clone();
    let before_epoch = super::codec::recover_log(fs::File::open(&missing_receipt_path).unwrap())
        .unwrap()
        .epoch;
    assert_eq!(
        store.create_workflow_plan_run(
            team.clone(),
            run_id,
            "create:missing-receipt",
            plan,
            "source:missing-receipt".to_owned(),
            1,
            1,
        ),
        Err(StoreFault::InvalidFacts)
    );
    assert_eq!(store.facts(), &before_facts);
    assert_eq!(
        super::codec::recover_log(fs::File::open(&missing_receipt_path).unwrap())
            .unwrap()
            .epoch,
        before_epoch
    );
    drop(store);
    let reopened = OrganizationStore::open(&missing_receipt_path).unwrap();
    assert_eq!(reopened.facts(), &before_facts);
    drop(reopened);
    remove_test_path(&missing_receipt_path);

    let invalid_plan_path = test_path("workflow-plan-run-invalid-plan");
    let mut store = OrganizationStore::open(&invalid_plan_path).unwrap();
    store
        .replace_facts(
            OrganizationFacts::restore(
                [TeamFacts::new(
                    team_definition(),
                    TeamRevision::initial(),
                    false,
                )],
                [terminal_materialization()],
                [],
                DeliveryLedgerSnapshot::new(Vec::new()),
            )
            .unwrap(),
        )
        .unwrap();
    let before_facts = store.facts().clone();
    let before_epoch = super::codec::recover_log(fs::File::open(&invalid_plan_path).unwrap())
        .unwrap()
        .epoch;
    let invalid_plan = crate::run::WorkflowPlan::new(
        "plan:invalid",
        "run:invalid",
        "",
        "active",
        Vec::new(),
        vec![crate::run::WorkflowTask::new(
            "task:invalid",
            "leader",
            "Invalid task",
            "prompt:invalid",
            Vec::new(),
            None,
        )],
        "template-key:invalid",
        1,
    );
    assert_eq!(
        store.create_workflow_plan_run(
            team.clone(),
            GraphRunId::new("run:invalid"),
            "create:invalid",
            invalid_plan,
            "source:invalid".to_owned(),
            1,
            1,
        ),
        Err(StoreFault::InvalidFacts)
    );
    assert_eq!(store.facts(), &before_facts);
    assert_eq!(
        super::codec::recover_log(fs::File::open(&invalid_plan_path).unwrap())
            .unwrap()
            .epoch,
        before_epoch
    );
    drop(store);
    let reopened = OrganizationStore::open(&invalid_plan_path).unwrap();
    assert_eq!(reopened.facts(), &before_facts);
    drop(reopened);
    remove_test_path(&invalid_plan_path);
}

#[test]
fn interrupted_graph_run_cancellation_recovers_to_unknown_without_replaying_abort() {
    let path = test_path("graph-run-cancellation-recovery");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("recovery", false))
        .unwrap();
    assert!(matches!(
        store.begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2),
        Ok(BeginCancellationOutcome::Started(_))
    ));
    drop(store);

    let recovered = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        recovered.resume_graph_runs(&team_id()),
        vec![ResumeOutcome::OutcomeUnknown(GraphRunId::new("run:one"))]
    );
    drop(recovered);
    remove_test_path(&path);
}

#[test]
fn cancellation_in_progress_remains_active_for_resume_projection() {
    let path = test_path("graph-run-cancellation-resume");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("cancelling", false))
        .unwrap();

    assert!(matches!(
        store.begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2),
        Ok(BeginCancellationOutcome::Started(_))
    ));
    assert_eq!(
        store.resume_graph_runs(&team_id()),
        vec![ResumeOutcome::Active(GraphRunId::new("run:one"))]
    );

    drop(store);
    remove_test_path(&path);
}

#[test]
fn graph_run_cancellation_unknown_blocks_tombstone_and_resume_reports_unknown() {
    let path = test_path("graph-run-cancellation-unknown");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("unknown", false))
        .unwrap();
    let before = fs::metadata(&path).unwrap().len();

    assert!(matches!(
        store.begin_graph_run_cancellation(&GraphRunId::new("run:one"), "cancel:one", 2),
        Ok(BeginCancellationOutcome::Started(_))
    ));
    assert_eq!(
        store.settle_graph_run_cancellation(
            &GraphRunId::new("run:one"),
            "cancel:one",
            RoleAbortOutcome::OutcomeUnknown,
            3,
        ),
        Ok(SettleCancellationOutcome::OutcomeUnknown)
    );
    assert_eq!(
        store.tombstone_graph_run(&GraphRunId::new("run:one"), "delete:one", 4),
        Ok(TombstoneOutcome::OutcomeUnknown)
    );
    assert_eq!(
        store.resume_graph_runs(&team_id()),
        vec![ResumeOutcome::OutcomeUnknown(GraphRunId::new("run:one"))]
    );
    assert!(fs::metadata(&path).unwrap().len() > before);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn durable_delivery_registration_records_once_replays_without_appending_and_survives_reopen() {
    let path = test_path("delivery-registration");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let request = delivery_request();

    assert!(matches!(
        store.register_delivery(request.clone()),
        Ok(RegisterOutcome::Recorded(_))
    ));
    let len_after_first_registration = fs::metadata(&path).unwrap().len();
    let bytes = fs::read(&path).unwrap();
    assert!(contains(&bytes, b"delivery:one"));
    for secret in [b"prompt-sentinel".as_slice(), b"workspace-grant-sentinel"] {
        assert!(!contains(&bytes, secret));
    }

    assert!(matches!(
        store.register_delivery(request.clone()),
        Ok(RegisterOutcome::Replayed(_))
    ));
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        len_after_first_registration
    );
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .deliveries()
            .delivery(&request.delivery_id)
            .map(Delivery::facts),
        Some(&request)
    );
    assert!(matches!(
        reopened.register_delivery(request),
        Ok(RegisterOutcome::Replayed(_))
    ));
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        len_after_first_registration
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn armed_trigger_facts_are_active_start_trigger_projections() {
    let active = facts_with_armed_webhook_run()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .clone();
    let inactive_graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:inactive",
            "plan:inactive",
            GraphRunId::new("run:inactive"),
            "inactive",
            vec![NodeDefinition::start(
                NodeId::new("cron-start"),
                "cron start",
                NonZeroU32::new(2).unwrap(),
                Some(StartTrigger::Cron {
                    expression: "* * * * *".to_owned(),
                }),
            )],
            Vec::new(),
        )
        .unwrap(),
        1,
    );
    let inactive = GraphRunFacts::with_lifecycle(
        team_id(),
        TeamRevision::initial(),
        inactive_graph,
        None,
        GraphRunLifecycle::restore(
            "create:inactive".to_owned(),
            GraphRunLifecycleState::Cancelled {
                idempotency_key: "cancel:inactive".to_owned(),
                cancelled_at: 3,
            },
        )
        .unwrap(),
    )
    .unwrap();
    let facts = OrganizationFacts::restore(
        [TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        [active, inactive],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap();

    let armed: Vec<ArmedTriggerFacts> = facts.armed_trigger_facts().collect();
    assert_eq!(armed.len(), 2);
    assert_eq!(armed[0].team_id, team_id());
    assert_eq!(armed[0].run_id, GraphRunId::new("run:one"));
    assert_eq!(armed[0].start_node_id, NodeId::new("start"));
    assert!(matches!(
        armed[0].trigger,
        StartTrigger::Webhook { ref path } if path == "/team/release"
    ));
    assert_eq!(armed[1].start_node_id, NodeId::new("alternate"));
    assert!(matches!(
        armed[1].trigger,
        StartTrigger::Webhook { ref path } if path == "alternate"
    ));
}

#[test]
fn trigger_fire_rejects_inactive_runs_without_committing() {
    let lifecycle_states = [
        GraphRunLifecycleState::Cancelling {
            idempotency_key: "cancel:one".to_owned(),
            requested_at: 2,
        },
        GraphRunLifecycleState::Cancelled {
            idempotency_key: "cancel:one".to_owned(),
            cancelled_at: 3,
        },
        GraphRunLifecycleState::OutcomeUnknown {
            idempotency_key: "cancel:one".to_owned(),
            observed_at: 3,
        },
        GraphRunLifecycleState::Tombstoned {
            idempotency_key: "cancel:one".to_owned(),
            tombstoned_at: 4,
        },
    ];

    for (index, state) in lifecycle_states.into_iter().enumerate() {
        let graph = facts_with_armed_webhook_run()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .clone();
        let run = GraphRunFacts::with_lifecycle(
            team_id(),
            TeamRevision::initial(),
            graph,
            None,
            GraphRunLifecycle::restore("create:one".to_owned(), state).unwrap(),
        )
        .unwrap();
        let facts = OrganizationFacts::restore(
            [TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            [],
            [run],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        let path = test_path(&format!("trigger-inactive-{index}"));
        let mut store = OrganizationStore::open(&path).unwrap();
        store.replace_facts(facts).unwrap();
        let before_graph = store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .clone();
        let before_triggers = store.facts().triggers().requests().count();
        let request = TriggerFireRequest::try_new(
            "run:one",
            "start",
            TriggerSource::Webhook,
            format!("request:inactive:{index}"),
        )
        .unwrap();

        assert_eq!(
            store.fire_trigger(request, 5),
            Err(StoreFault::TriggerFire(TriggerFireError::RunMismatch))
        );
        assert_eq!(store.facts().triggers().requests().count(), before_triggers);
        assert_eq!(
            store
                .facts()
                .run(&GraphRunId::new("run:one"))
                .unwrap()
                .graph(),
            &before_graph
        );
        drop(store);
        remove_test_path(&path);
    }
}

#[test]
fn trigger_fire_rejects_conflicts_and_invalid_run_or_trigger_without_committing() {
    let path = test_path("trigger-fire-reject");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts_with_armed_webhook_run()).unwrap();
    let baseline = fs::metadata(&path).unwrap().len();
    let original =
        TriggerFireRequest::try_new("run:one", "start", TriggerSource::Webhook, "request:one")
            .unwrap();
    store.fire_trigger(original, 2).unwrap();
    let after_first_fire = fs::metadata(&path).unwrap().len();

    let conflict = TriggerFireRequest::try_new(
        "run:one",
        "alternate",
        TriggerSource::Webhook,
        "request:one",
    )
    .unwrap();
    assert_eq!(
        store.fire_trigger(conflict, 3),
        Ok(TriggerRegistration::ConflictingIdempotencyKey {
            idempotency_key: "request:one".to_owned(),
        })
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_first_fire);

    let wrong_run = TriggerFireRequest::try_new(
        "run:missing",
        "start",
        TriggerSource::Webhook,
        "request:missing",
    )
    .unwrap();
    assert_eq!(
        store.fire_trigger(wrong_run, 3),
        Err(StoreFault::TriggerFire(TriggerFireError::RunMismatch))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_first_fire);

    let wrong_node = TriggerFireRequest::try_new(
        "run:one",
        "missing",
        TriggerSource::Webhook,
        "request:missing",
    )
    .unwrap();
    assert!(matches!(
        store.fire_trigger(wrong_node, 3),
        Err(StoreFault::TriggerFire(TriggerFireError::Reduce(
            crate::ReduceError::UnknownNode(node)
        ))) if node == NodeId::new("missing")
    ));
    assert_eq!(fs::metadata(&path).unwrap().len(), after_first_fire);

    let source_mismatch =
        TriggerFireRequest::try_new("run:one", "start", TriggerSource::Cron, "request:cron")
            .unwrap();
    assert_eq!(
        store.fire_trigger(source_mismatch, 3),
        Err(StoreFault::TriggerFire(TriggerFireError::SourceMismatch))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_first_fire);
    assert!(baseline < after_first_fire);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn observe_native_terminal_commits_once_replays_without_appending_and_survives_reopen() {
    let path = test_path("terminal-observation-transaction");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(delivered_terminal_facts()).unwrap();
    let before_observation = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.observe_native_terminal(
            native_terminal_target(&store),
            NativeTerminalStatus::Completed,
            4,
        ),
        Ok(TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution)
    );
    let after_observation = fs::metadata(&path).unwrap().len();
    assert!(after_observation > before_observation);
    assert_terminal_observation_projection(store.facts(), NativeTerminalStatus::Completed);

    assert_eq!(
        store.observe_native_terminal(
            native_terminal_target(&store),
            NativeTerminalStatus::Completed,
            4,
        ),
        Ok(TerminalObservationOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_observation);
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    assert_terminal_observation_projection(reopened.facts(), NativeTerminalStatus::Completed);
    assert_eq!(
        reopened.observe_native_terminal(
            native_terminal_target(&reopened),
            NativeTerminalStatus::Completed,
            4,
        ),
        Ok(TerminalObservationOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_observation);
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn observe_native_terminal_persists_each_native_terminal_status_projection() {
    for (native_terminal, expected_outcome, expected_status, expected_resolution) in [
        (
            NativeTerminalStatus::Completed,
            TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution,
            AttemptStatus::Waiting,
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
        ),
        (
            NativeTerminalStatus::Failed,
            TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution,
            AttemptStatus::Waiting,
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
        ),
        (
            NativeTerminalStatus::Interrupted,
            TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution,
            AttemptStatus::Waiting,
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
        ),
        (
            NativeTerminalStatus::Cancelled,
            TerminalObservationOutcome::RecordedNodeCancelled,
            AttemptStatus::Cancelled,
            TerminalObservationResolution::NodeCancelled,
        ),
    ] {
        let path = test_path("terminal-observation-status");
        let mut store = OrganizationStore::open(&path).unwrap();
        store.replace_facts(delivered_terminal_facts()).unwrap();

        assert_eq!(
            store.observe_native_terminal(native_terminal_target(&store), native_terminal, 4,),
            Ok(expected_outcome)
        );
        assert_native_terminal_projection(
            store.facts(),
            native_terminal,
            expected_status,
            &expected_resolution,
        );
        drop(store);

        let reopened = OrganizationStore::open(&path).unwrap();
        assert_native_terminal_projection(
            reopened.facts(),
            native_terminal,
            expected_status,
            &expected_resolution,
        );
        drop(reopened);
        remove_test_path(&path);
    }
}

#[test]
fn observe_native_terminal_uses_persisted_correlation_after_runtime_binding_drift() {
    let path = test_path("terminal-observation-runtime-binding-drift");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = delivered_delivery_and_graph();
    let initial = facts_with_delivery(delivery.clone(), graph.clone(), binding, Vec::new());
    store.replace_facts(initial).unwrap();

    let drifted_binding = RoleSessionReceipt::with_endpoint_session_id(
        team_id(),
        GraphRunId::new("run:one"),
        RoleId::try_new("leader").unwrap(),
        crate::RoleSessionRef::initial(),
        EndpointSessionId::try_new("native-session:two").unwrap(),
        ManagedAgentReference::try_new("agent:one").unwrap(),
        RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
    );
    let drifted = facts_with_delivery(delivery, graph, drifted_binding, Vec::new());
    store.replace_facts(drifted).unwrap();
    assert_eq!(
        store.observe_native_terminal(
            native_terminal_target(&store),
            NativeTerminalStatus::Completed,
            4,
        ),
        Ok(TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution)
    );
    assert_terminal_observation_projection(store.facts(), NativeTerminalStatus::Completed);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn native_terminal_target_redacts_and_limits_public_projections() {
    let path = test_path("terminal-observation-target-projection");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(delivered_terminal_facts()).unwrap();
    let target = native_terminal_target(&store);

    assert_eq!(
        target.correlation().endpoint_session_id().as_str(),
        "matcha-session-correlation-canary"
    );
    assert_eq!(
        target.correlation().native_run_receipt().as_str(),
        "matcha-native-run-correlation-canary"
    );
    let debug = format!("{target:?}");
    for value in [
        "delivery:one",
        "run:one",
        "start",
        "attempt",
        "leader",
        "matcha-session-correlation-canary",
        "matcha-native-run-correlation-canary",
    ] {
        assert!(!debug.contains(value));
    }

    let source = include_str!("terminal_observation.rs");
    assert!(!source.contains("pub fn delivery_id"));
    assert!(source.contains("pub fn graph_run_id"));
    assert!(!source.contains("pub fn node_id"));
    assert!(!source.contains("pub fn fence"));
    assert!(!source.contains("pub fn role_id"));
    drop(store);
    remove_test_path(&path);
}

#[test]
fn terminal_observation_round_trips_through_the_durable_log_with_its_new_phase() {
    let path = test_path("terminal-observation");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(terminal_facts()).unwrap();
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let delivery = reopened
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    assert!(matches!(
        delivery.phase(),
        DeliveryPhase::TerminalObserved { observation }
            if observation.native_terminal() == NativeTerminalStatus::Completed
                && observation.observed_at() == 4
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn agent_node_event_resolution_commits_once_replays_and_requires_terminal_observation() {
    let path = test_path("agent-node-event-resolution");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_work_delivery_and_graph();
    let facts = facts_with_delivery(delivery, graph, binding, Vec::new());
    store.replace_facts(facts).unwrap();
    let resolution = AgentNodeEventResolution::complete(
        AuthorizedGraphResolutionReceipt::try_new("agent-event:one").unwrap(),
        DeliveryId::new("delivery:one").unwrap(),
        "run:one",
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .fence()
            .clone(),
        None::<String>,
        5,
    )
    .unwrap();
    let (unobserved_delivery, unobserved_graph, unobserved_binding) =
        delivered_work_delivery_and_graph();
    let unobserved_facts = facts_with_delivery(
        unobserved_delivery,
        unobserved_graph,
        unobserved_binding,
        Vec::new(),
    );
    let unobserved_path = test_path("agent-node-event-unobserved");
    let mut unobserved_store = OrganizationStore::open(&unobserved_path).unwrap();
    unobserved_store.replace_facts(unobserved_facts).unwrap();
    let unobserved_size = fs::metadata(&unobserved_path).unwrap().len();
    assert_eq!(
        unobserved_store.apply_agent_node_event_resolution(resolution.clone()),
        Err(StoreFault::AgentNodeEventResolution(
            crate::AgentNodeEventResolutionError::AuthorizedResolution(
                crate::AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution,
            ),
        ))
    );
    assert_eq!(
        fs::metadata(&unobserved_path).unwrap().len(),
        unobserved_size
    );
    drop(unobserved_store);
    remove_test_path(&unobserved_path);

    assert_eq!(
        store.apply_agent_node_event_resolution(resolution.clone()),
        Ok(crate::AuthorizedGraphResolutionOutcome::Recorded)
    );
    let size_after_first = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.apply_agent_node_event_resolution(resolution),
        Ok(crate::AuthorizedGraphResolutionOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), size_after_first);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .output_port(),
        Some("completed")
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn agent_node_event_completion_summary_persists_and_replays_with_command_identity() {
    let path = test_path("agent-node-event-summary-artifact");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_work_delivery_and_graph();
    store
        .replace_facts(agent_event_facts(delivery, graph, binding))
        .unwrap();
    let fence = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("work"))
        .unwrap()
        .fence()
        .clone();
    let resolution = AgentNodeEventResolution::complete_with_summary(
        AuthorizedGraphResolutionReceipt::try_new("agent-event:summary").unwrap(),
        DeliveryId::new("delivery:one").unwrap(),
        "run:one",
        fence,
        "completed work".to_owned(),
        "command:summary",
        "terminal-key:summary",
        Some("completed"),
        5,
    )
    .unwrap();

    assert_eq!(
        store.apply_agent_node_event_resolution(resolution.clone()),
        Ok(crate::AuthorizedGraphResolutionOutcome::Recorded)
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    let artifact = store.facts().artifacts().next().unwrap();
    assert_eq!(artifact.summary(), Some("completed work"));
    assert_eq!(artifact.source_envelope_id(), "command:summary");
    assert_eq!(artifact.idempotency_key(), "terminal-key:summary");
    assert_eq!(store.facts().artifacts().count(), 1);

    assert_eq!(
        store.apply_agent_node_event_resolution(resolution),
        Ok(crate::AuthorizedGraphResolutionOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    assert_eq!(store.facts().artifacts().count(), 1);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let artifact = reopened.facts().artifacts().next().unwrap();
    assert_eq!(artifact.summary(), Some("completed work"));
    assert_eq!(artifact.source_envelope_id(), "command:summary");
    assert_eq!(artifact.idempotency_key(), "terminal-key:summary");
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn agent_node_event_resolution_defaults_review_completion_to_passed() {
    let path = test_path("agent-node-event-review");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_review_delivery_and_graph();
    store
        .replace_facts(agent_event_facts(delivery, graph, binding))
        .unwrap();
    let resolution = AgentNodeEventResolution::complete(
        AuthorizedGraphResolutionReceipt::try_new("agent-event:review").unwrap(),
        DeliveryId::new("delivery:one").unwrap(),
        "run:one",
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone(),
        None::<String>,
        5,
    )
    .unwrap();

    assert_eq!(
        store.apply_agent_node_event_resolution(resolution),
        Ok(crate::AuthorizedGraphResolutionOutcome::Recorded)
    );
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .output_port(),
        Some("passed")
    );
    drop(store);
    remove_test_path(&path);
}

#[test]
fn agent_node_event_resolution_defaults_rejection_to_failed() {
    let path = test_path("agent-node-event-reject");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_work_delivery_and_graph();
    store
        .replace_facts(agent_event_facts(delivery, graph, binding))
        .unwrap();
    let resolution = AgentNodeEventResolution::reject_with_summary(
        AuthorizedGraphResolutionReceipt::try_new("agent-event:reject").unwrap(),
        DeliveryId::new("delivery:one").unwrap(),
        "run:one",
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .fence()
            .clone(),
        "rejected work".to_owned(),
        "command:reject",
        "terminal-key:reject",
        None::<String>,
        5,
    )
    .unwrap();

    assert_eq!(
        store.apply_agent_node_event_resolution(resolution),
        Ok(crate::AuthorizedGraphResolutionOutcome::Recorded)
    );
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .output_port(),
        Some("failed")
    );
    assert_eq!(store.facts().artifacts().count(), 0);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn agent_node_event_resolution_requires_an_explicit_port_to_match_an_outgoing_edge() {
    let path = test_path("agent-node-event-output-port");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_routed_work_delivery_and_graph();
    store
        .replace_facts(agent_event_facts(delivery, graph, binding))
        .unwrap();
    let fence = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("work"))
        .unwrap()
        .fence()
        .clone();
    let wrong_port = AgentNodeEventResolution::complete(
        AuthorizedGraphResolutionReceipt::try_new("agent-event:wrong-port").unwrap(),
        DeliveryId::new("delivery:one").unwrap(),
        "run:one",
        fence.clone(),
        Some("failed"),
        5,
    )
    .unwrap();
    let size_before = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.apply_agent_node_event_resolution(wrong_port),
        Err(StoreFault::AgentNodeEventResolution(
            crate::AgentNodeEventResolutionError::AuthorizedResolution(
                crate::AuthorizedGraphResolutionError::OutputPortDoesNotMatchEdge,
            ),
        ))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), size_before);

    let routed = AgentNodeEventResolution::complete(
        AuthorizedGraphResolutionReceipt::try_new("agent-event:routed").unwrap(),
        DeliveryId::new("delivery:one").unwrap(),
        "run:one",
        fence,
        Some("completed"),
        5,
    )
    .unwrap();
    assert_eq!(
        store.apply_agent_node_event_resolution(routed),
        Ok(crate::AuthorizedGraphResolutionOutcome::Recorded)
    );
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .output_port(),
        Some("completed")
    );
    drop(store);
    remove_test_path(&path);
}

#[test]
fn authorized_graph_resolution_advances_the_durable_team_run_query() {
    let path = test_path("authorized-graph-resolution");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_delivery_and_graph();
    let facts = facts_with_delivery(delivery, graph, binding, Vec::new());
    store.replace_facts(facts).unwrap();
    let query = TeamRunQuery::get(team_id(), GraphRunId::new("run:one"));
    assert_eq!(
        query_team_run(store.facts(), &query),
        TeamRunQueryOutcome::OutcomeUnknown
    );

    let delivery = store
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
        panic!("fixture must await an authorized graph resolution");
    };
    store
        .apply_authorized_graph_resolution(
            AuthorizedGraphResolution::new(
                AuthorizedGraphResolutionReceipt::try_new("executor-output:one").unwrap(),
                delivery.facts().delivery_id.clone(),
                "run:one",
                observation.fence().clone(),
                AuthorizedGraphOutcome::Completed,
                "completed",
                5,
            )
            .unwrap(),
        )
        .unwrap();
    assert!(matches!(
        query_team_run(store.facts(), &query),
        TeamRunQueryOutcome::Available(_)
    ));
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert!(matches!(
        query_team_run(reopened.facts(), &query),
        TeamRunQueryOutcome::Available(_)
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn native_run_output_parses_team_message_resolves_graph_and_survives_reopen() {
    let path = test_path("native-run-output-resolution");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_work_delivery_and_graph();
    store
        .replace_facts(facts_with_delivery(delivery, graph, binding, Vec::new()))
        .unwrap();
    let target = native_terminal_target(&store);
    let final_text = r#"noise <team_message>{"summary":"已安全完成","decision":"completed","dispatch":[{"role_id":"leader","task":"复核结果"}]}</team_message>"#.to_owned();

    assert_eq!(
        store.resolve_native_run_output(
            target.clone(),
            AuthorizedGraphResolutionReceipt::try_new("native-output:one").unwrap(),
            final_text.clone(),
            5,
        ),
        Ok(crate::AuthorizedGraphResolutionOutcome::Recorded)
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    let delivery = store
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
        panic!("native output should keep the terminal observation fact");
    };
    let output = observation
        .output()
        .expect("native output should be durable");
    assert_eq!(output.final_assistant_text(), final_text);
    assert_eq!(output.summary(), "已安全完成");
    assert_eq!(output.decision(), "completed");
    assert_eq!(output.dispatch().len(), 1);
    assert_eq!(output.dispatch()[0].role_id(), "leader");
    assert_eq!(output.dispatch()[0].task(), "复核结果");
    assert!(matches!(
        observation.resolution(),
        TerminalObservationResolution::GraphResolved(resolution)
            if resolution.receipt().as_str() == "native-output:one"
                && resolution.output_port() == "completed"
    ));
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("work"))
            .unwrap()
            .output_port(),
        Some("completed")
    );

    assert_eq!(
        store.resolve_native_run_output(
            target,
            AuthorizedGraphResolutionReceipt::try_new("native-output:one").unwrap(),
            final_text.clone(),
            5,
        ),
        Ok(crate::AuthorizedGraphResolutionOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let delivery = reopened
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
        panic!("native output should survive reopen");
    };
    let output = observation
        .output()
        .expect("native output should survive reopen");
    assert_eq!(output.decision(), "completed");
    assert_eq!(output.dispatch().len(), 1);
    assert_eq!(output.dispatch()[0].role_id(), "leader");
    assert_eq!(output.dispatch()[0].task(), "复核结果");
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn activity_registration_accepts_deterministic_teamrun_completion_prompt_only() {
    let path = test_path("activity-completion-prompt-validation");
    let mut store = OrganizationStore::open(&path).unwrap();
    let binding = RoleSessionReceipt::with_endpoint_session_id(
        team_id(),
        GraphRunId::new("run:one"),
        RoleId::try_new("leader").unwrap(),
        crate::RoleSessionRef::initial(),
        EndpointSessionId::try_new("native-session:one").unwrap(),
        ManagedAgentReference::try_new("agent:one").unwrap(),
        RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
    );
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:one",
            "plan:one",
            GraphRunId::new("run:one"),
            "activity prompt",
            vec![NodeDefinition::work(
                NodeId::new("work"),
                "work",
                NonZeroU32::new(1).unwrap(),
                WorkAssignment::typed(
                    "task:one",
                    "private prompt",
                    ExecutorPolicy::team_role("leader"),
                    None,
                    None,
                ),
            )],
            Vec::new(),
        )
        .unwrap(),
        1,
    );
    store
        .replace_facts(
            OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
                teams: vec![TeamFacts::new(
                    team_definition(),
                    TeamRevision::initial(),
                    false,
                )],
                materializations: vec![terminal_materialization()],
                runs: vec![
                    GraphRunFacts::new(
                        team_id(),
                        TeamRevision::initial(),
                        graph,
                        Some(runtime(binding)),
                    )
                    .unwrap(),
                ],
                pending_workflow_plan_admissions: Vec::new(),
                templates: Vec::new(),
                deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
                activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
                triggers: Vec::new(),
                control_resolutions: Vec::new(),
                approvals: Vec::new(),
                events: EventLedgerSnapshot::default(),
                evidence: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
    let run = store.facts().run(&GraphRunId::new("run:one")).unwrap();
    let scheduled = crate::run::scheduler::schedule_ready_nodes(run.graph(), 1, 0).unwrap();
    let mut accepted = scheduled[0]
        .bind_activity_target(
            ActivityTarget::new(crate::ROLE_SESSION_REF_INITIAL).unwrap(),
            2,
            1,
        )
        .unwrap();
    accepted.activity_id = crate::ActivityId::new("activity:accepted").unwrap();
    accepted.idempotency_key = "activity:accepted".to_owned();
    assert!(matches!(
        store.register_activity(accepted),
        Ok(crate::ActivityRegistrationOutcome::Recorded(_))
    ));
    let run = store.facts().run(&GraphRunId::new("run:one")).unwrap();
    let scheduled = crate::run::scheduler::schedule_ready_nodes(run.graph(), 1, 0).unwrap();
    let mut rejected = scheduled[0]
        .bind_activity_target(
            ActivityTarget::new(crate::ROLE_SESSION_REF_INITIAL).unwrap(),
            3,
            1,
        )
        .unwrap();
    rejected.activity_id = crate::ActivityId::new("activity:rejected").unwrap();
    rejected.idempotency_key = "activity:rejected".to_owned();
    if let crate::ActivityKind::AgentTask { prompt, .. } = &mut rejected.activity_kind {
        *prompt = "private prompt".to_owned();
    }
    assert_eq!(
        store.register_activity(rejected),
        Err(StoreFault::InvalidFacts)
    );
    drop(store);
    remove_test_path(&path);
}

#[test]
fn native_run_output_rejects_invalid_team_message_without_appending() {
    let path = test_path("native-run-output-invalid");
    let mut store = OrganizationStore::open(&path).unwrap();
    let (delivery, graph, binding) = observed_work_delivery_and_graph();
    store
        .replace_facts(facts_with_delivery(delivery, graph, binding, Vec::new()))
        .unwrap();
    let target = native_terminal_target(&store);
    let before = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.resolve_native_run_output(
            target,
            AuthorizedGraphResolutionReceipt::try_new("native-output:bad").unwrap(),
            "final text without envelope".to_owned(),
            5,
        ),
        Err(StoreFault::NativeRunOutputResolution(
            crate::NativeRunOutputResolutionError::InvalidOutput,
        ))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), before);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn resolved_terminal_observation_round_trips_with_its_fenced_output_receipt() {
    let (mut delivery, mut graph, binding) = observed_delivery_and_graph();
    let fence = graph
        .current_attempt(&NodeId::new("start"))
        .unwrap()
        .fence()
        .clone();
    let delivery_id = delivery.facts().delivery_id.clone();
    resolve_authorized_graph_outcome(
        &mut delivery,
        &mut graph,
        AuthorizedGraphResolution::new(
            AuthorizedGraphResolutionReceipt::try_new("executor-output:one").unwrap(),
            delivery_id,
            "run:one",
            fence,
            AuthorizedGraphOutcome::Completed,
            "completed",
            5,
        )
        .unwrap(),
    )
    .unwrap();
    let facts = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        vec![terminal_materialization()],
        vec![
            GraphRunFacts::new(
                team_id(),
                TeamRevision::initial(),
                graph,
                Some(runtime(binding)),
            )
            .unwrap(),
        ],
        DeliveryLedgerSnapshot::new(vec![delivery.snapshot()]),
    )
    .unwrap();
    let path = test_path("resolved-terminal-observation");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let delivery = reopened
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    assert!(matches!(
        delivery.phase(),
        DeliveryPhase::TerminalObserved { observation }
            if matches!(
                observation.resolution(),
                crate::run::delivery::TerminalObservationResolution::GraphResolved(resolution)
                    if resolution.receipt().as_str() == "executor-output:one"
                        && resolution.delivery_id().as_str() == "delivery:one"
                        && resolution.graph_run_id() == "run:one"
                        && resolution.output_port() == "completed"
            )
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn legacy_delivered_snapshot_restores_without_a_terminal_observation() {
    let facts = DeliveryRequest {
        delivery_id: DeliveryId::new("delivery:one").unwrap(),
        team_id: "team:one".to_owned(),
        run_id: "run:one".to_owned(),
        node_id: "start".to_owned(),
        node_execution_id: "start:attempt:1".to_owned(),
        task_id: "task:one".to_owned(),
        role_id: "leader".to_owned(),
        session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
        idempotency_key: "delivery:one".to_owned(),
        message: "private prompt".to_owned(),
        requested_at: 1,
        max_attempts: 2,
    };
    let snapshot = DeliverySnapshot::new(
        facts,
        DeliveryPhaseSnapshot::Delivered {
            receipt: crate::DeliveryReceiptReference::try_new("receipt:one").unwrap(),
            native_correlation: None,
            accepted_at: 2,
        },
        0,
        2,
    );
    let ledger = DeliveryLedger::restore(DeliveryLedgerSnapshot::new(vec![snapshot])).unwrap();

    let restored = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ],
        ledger.snapshot(),
    )
    .unwrap();
    assert!(matches!(
        restored.deliveries().deliveries().next().unwrap().phase(),
        DeliveryPhase::Delivered { .. }
    ));
}

#[test]
fn native_terminal_target_requires_persisted_native_correlation() {
    let path = test_path("terminal-observation-no-correlation");
    let delivered = DeliverySnapshot::new(
        delivery_request(),
        DeliveryPhaseSnapshot::Delivered {
            receipt: crate::DeliveryReceiptReference::try_new("delivery-receipt:generic").unwrap(),
            native_correlation: None,
            accepted_at: 3,
        },
        0,
        2,
    );
    let facts = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ],
        DeliveryLedgerSnapshot::new(vec![delivered]),
    )
    .unwrap();
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();

    assert!(
        store
            .native_terminal_target(&DeliveryId::new("delivery:one").unwrap())
            .is_none()
    );
    drop(store);
    remove_test_path(&path);
}

#[test]
fn terminal_observation_restore_accepts_runtime_session_binding_drift() {
    let (delivery, graph, _) = observed_delivery_and_graph();
    let drifted_binding = RoleSessionReceipt::with_endpoint_session_id(
        team_id(),
        GraphRunId::new("run:one"),
        RoleId::try_new("leader").unwrap(),
        crate::RoleSessionRef::initial(),
        EndpointSessionId::try_new("different-native-session").unwrap(),
        ManagedAgentReference::try_new("agent:one").unwrap(),
        RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
    );
    let ledger =
        DeliveryLedger::restore(DeliveryLedgerSnapshot::new(vec![delivery.snapshot()])).unwrap();

    assert!(
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false
            )],
            vec![terminal_materialization()],
            vec![
                GraphRunFacts::new(
                    team_id(),
                    TeamRevision::initial(),
                    graph,
                    Some(runtime(drifted_binding)),
                )
                .unwrap()
            ],
            ledger.snapshot(),
        )
        .is_ok()
    );
}

#[test]
fn terminal_observation_restore_rejects_graph_output_spliced_after_native_observation() {
    let (delivery, graph, binding) = observed_delivery_and_graph();
    let fence = graph
        .current_attempt(&NodeId::new("start"))
        .unwrap()
        .fence()
        .clone();
    let graph = reduce(
        graph,
        GraphEvent::NodeCompleted {
            node_id: NodeId::new("start"),
            fence,
            output_port: "completed".to_owned(),
            completed_at: 5,
        },
    )
    .unwrap();
    let ledger =
        DeliveryLedger::restore(DeliveryLedgerSnapshot::new(vec![delivery.snapshot()])).unwrap();

    assert_eq!(
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false
            )],
            vec![terminal_materialization()],
            vec![
                GraphRunFacts::new(
                    team_id(),
                    TeamRevision::initial(),
                    graph,
                    Some(runtime(binding))
                )
                .unwrap()
            ],
            ledger.snapshot(),
        ),
        Err(super::OrganizationFactsError::InvalidTerminalObservation),
    );
}

#[test]
fn durable_evidence_records_once_in_the_organization_frame_and_survives_reopen() {
    let path = test_path("evidence-record");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let record = evidence_record("evidence:one", "run:one", "start:attempt:1");

    assert_eq!(
        store.record_evidence(record.clone()),
        Ok(crate::RecordOutcome::Recorded(record.clone()))
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store.record_evidence(record.clone()),
        Ok(crate::RecordOutcome::Replayed(record.clone()))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .evidence_records()
            .find(|stored| stored.evidence_id() == &EvidenceId::new("evidence:one").unwrap()),
        Some(&record)
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn durable_evidence_replays_after_its_node_is_reworked_without_appending() {
    let path = test_path("evidence-rework-replay");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let record = evidence_record("evidence:one", "run:one", "start:attempt:1");
    store.record_evidence(record.clone()).unwrap();

    let reworked_graph = reduce(
        graph("display"),
        GraphEvent::ReworkRequested {
            node_id: NodeId::new("start"),
            requested_at: 2,
        },
    )
    .unwrap();
    let reworked_facts =
        OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
            teams: vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )]
            .into_iter()
            .collect(),
            materializations: [].into_iter().collect(),
            runs: vec![
                GraphRunFacts::new(team_id(), TeamRevision::initial(), reworked_graph, None)
                    .unwrap(),
            ]
            .into_iter()
            .collect(),
            pending_workflow_plan_admissions: Vec::new(),
            templates: Vec::new(),
            deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
            activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
            triggers: [].into_iter().collect(),
            control_resolutions: [].into_iter().collect(),
            approvals: [].into_iter().collect(),
            events: EventLedger::default().snapshot(),
            evidence: [record.clone()].into_iter().collect(),
        })
        .unwrap();
    store.replace_facts(reworked_facts).unwrap();
    let committed_len = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.record_evidence(record.clone()),
        Ok(crate::RecordOutcome::Replayed(record))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn durable_evidence_rejects_conflict_foreign_and_stale_provenance_without_appending() {
    let path = test_path("evidence-provenance");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(facts_with_run("display", false))
        .unwrap();
    let record = evidence_record("evidence:one", "run:one", "start:attempt:1");
    store.record_evidence(record).unwrap();
    let committed_len = fs::metadata(&path).unwrap().len();

    assert!(matches!(
        store.record_evidence(evidence_record(
            "evidence:one",
            "run:one",
            "start:attempt:2"
        )),
        Err(StoreFault::Evidence(_))
    ));
    assert!(matches!(
        store.record_evidence(evidence_record(
            "evidence:foreign",
            "run:missing",
            "start:attempt:1"
        )),
        Err(StoreFault::Evidence(_))
    ));
    assert!(matches!(
        store.record_evidence(evidence_record(
            "evidence:stale",
            "run:one",
            "start:attempt:9"
        )),
        Err(StoreFault::Evidence(_))
    ));
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn durable_claim_is_committed_before_the_external_effect_handoff() {
    let path = test_path("delivery-claim");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts_with_pending_delivery()).unwrap();
    let before_claim = fs::metadata(&path).unwrap().len();

    let claim = match store
        .claim_delivery(&DeliveryId::new("delivery:one").unwrap(), 2)
        .unwrap()
    {
        DeliveryStart::Claimed(claim) => claim,
        other => panic!("expected durable delivery claim, got {other:?}"),
    };
    let after_claim = fs::metadata(&path).unwrap().len();
    assert!(after_claim > before_claim);
    assert!(matches!(
        store
            .facts()
            .deliveries()
            .delivery(claim.delivery_id())
            .unwrap()
            .phase(),
        DeliveryPhase::Delivering(active) if active == &claim
    ));
    drop(store);

    let reopened = OrganizationStore::open(&path).unwrap();
    let delivery = reopened
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    assert!(matches!(
        delivery.phase(),
        DeliveryPhase::OutcomeUnknown { .. }
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn durable_claim_replay_returns_the_same_claim_without_appending() {
    let path = test_path("delivery-claim-replay");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts_with_pending_delivery()).unwrap();
    let before_claim = fs::metadata(&path).unwrap().len();
    let claim = match store
        .claim_delivery(&DeliveryId::new("delivery:one").unwrap(), 2)
        .unwrap()
    {
        DeliveryStart::Claimed(claim) => claim,
        other => panic!("expected durable delivery claim, got {other:?}"),
    };
    let after_claim = fs::metadata(&path).unwrap().len();
    assert!(after_claim > before_claim);

    assert_eq!(
        store.claim_delivery(&DeliveryId::new("delivery:one").unwrap(), 3),
        Ok(DeliveryStart::AlreadyClaimed(claim.clone()))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), after_claim);
    drop(store);

    let recovered = super::codec::recover_log(fs::File::open(&path).unwrap()).unwrap();
    assert!(matches!(
        recovered
            .facts
            .deliveries()
            .delivery(&DeliveryId::new("delivery:one").unwrap())
            .unwrap()
            .phase(),
        DeliveryPhase::Delivering(active) if active == &claim
    ));
    assert!(recovered.had_interrupted_delivery);

    let reopened = OrganizationStore::open(&path).unwrap();
    assert!(matches!(
        reopened
            .facts()
            .deliveries()
            .delivery(&DeliveryId::new("delivery:one").unwrap())
            .unwrap()
            .phase(),
        DeliveryPhase::OutcomeUnknown { .. }
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn durable_delivery_settlement_appends_once_and_survives_reopen() {
    let cases = [
        (
            "accepted",
            DeliveryReceipt::Accepted {
                receipt: crate::DeliveryReceiptReference::try_new("receipt:one").unwrap(),
                native_correlation: None,
                accepted_at: 3,
            },
            DeliveryResolution::Delivered,
        ),
        (
            "rejected",
            DeliveryReceipt::Rejected {
                failure: crate::DeliveryFailure::PolicyRejected,
                observed_at: 3,
            },
            DeliveryResolution::Failed,
        ),
        (
            "unknown",
            DeliveryReceipt::OutcomeUnknown { observed_at: 3 },
            DeliveryResolution::OutcomeUnknown,
        ),
    ];

    for (name, receipt, expected) in cases {
        let path = test_path(name);
        let mut store = OrganizationStore::open(&path).unwrap();
        store.replace_facts(facts_with_pending_delivery()).unwrap();
        let claim = claimed_delivery(&mut store);
        let before_settlement = fs::metadata(&path).unwrap().len();

        assert_eq!(store.settle_delivery(&claim, receipt, 4), Ok(expected));
        let after_settlement = fs::metadata(&path).unwrap().len();
        assert!(after_settlement > before_settlement);
        assert_settled_delivery(store.facts(), expected);

        assert_eq!(
            store.settle_delivery(
                &claim,
                DeliveryReceipt::OutcomeUnknown { observed_at: 5 },
                6
            ),
            Err(StoreFault::DeliveryReceipt(Box::new(
                DeliveryReceiptError::NotDelivering {
                    phase: settled_phase(expected),
                },
            )))
        );
        assert_eq!(fs::metadata(&path).unwrap().len(), after_settlement);
        drop(store);

        let reopened = OrganizationStore::open(&path).unwrap();
        assert_settled_delivery(reopened.facts(), expected);
        drop(reopened);
        remove_test_path(&path);
    }
}

#[test]
fn stale_delivery_settlement_rejects_without_appending() {
    let path = test_path("delivery-stale-settlement");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts_with_pending_delivery()).unwrap();
    let stale_claim = claimed_delivery(&mut store);
    assert_eq!(
        store.settle_delivery(
            &stale_claim,
            DeliveryReceipt::Rejected {
                failure: crate::DeliveryFailure::Unavailable,
                observed_at: 3,
            },
            4,
        ),
        Ok(DeliveryResolution::RetryScheduled { retry_at: 30_003 })
    );
    let claim = match store
        .claim_delivery(&DeliveryId::new("delivery:one").unwrap(), 30_003)
        .unwrap()
    {
        DeliveryStart::Claimed(claim) => claim,
        other => panic!("expected next delivery claim, got {other:?}"),
    };
    let before_stale_settlement = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.settle_delivery(
            &stale_claim,
            DeliveryReceipt::OutcomeUnknown { observed_at: 5 },
            6
        ),
        Err(StoreFault::DeliveryReceipt(Box::new(
            DeliveryReceiptError::StaleClaim {
                delivery_id: DeliveryId::new("delivery:one").unwrap(),
            },
        )))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), before_stale_settlement);
    assert!(matches!(
        store
            .facts()
            .deliveries()
            .delivery(&DeliveryId::new("delivery:one").unwrap())
            .unwrap()
            .phase(),
        DeliveryPhase::Delivering(active) if active == &claim
    ));
    drop(store);
    remove_test_path(&path);
}

#[test]
fn reopen_converts_interrupted_delivery_to_outcome_unknown_without_replay() {
    let path = test_path("interrupted-delivery");
    let facts = facts_with_run("display", true);
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    let delivery = reopened
        .facts()
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    assert!(matches!(
        delivery.phase(),
        DeliveryPhase::OutcomeUnknown { .. }
    ));
    assert!(matches!(
        reopened.claim_delivery(&DeliveryId::new("delivery:one").unwrap(), 3),
        Ok(DeliveryStart::Terminal(
            DeliveryPhase::OutcomeUnknown { .. }
        ))
    ));
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn human_approval_decision_commits_graph_and_approval_once() {
    let path = test_path("human-approval-decision");
    let approval = Approval::request(ApprovalRequest {
        approval_id: "approval:decision".to_owned(),
        run_id: "run:one".to_owned(),
        stage_id: "decision".to_owned(),
        role_id: "leader".to_owned(),
        reason: "Human decision required.".to_owned(),
        requested_action: "Route the decision port.".to_owned(),
        risk_summary: "A human must select the route.".to_owned(),
        idempotency_key: "approval-request:decision".to_owned(),
        requested_at: 1,
        subject: ApprovalSubject::HumanDecision {
            node_id: "decision".to_owned(),
        },
        origin: ApprovalOrigin::HumanDecision,
        effect: ApprovalEffect::RouteDecisionPorts,
        execution_fence: Some("decision:attempt:1".to_owned()),
    });
    let facts = OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
        teams: vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )]
        .into_iter()
        .collect(),
        materializations: [].into_iter().collect(),
        runs: vec![
            GraphRunFacts::new(
                team_id(),
                TeamRevision::initial(),
                GraphState::initialize(
                    GraphDefinition::new(
                        "graph:decision",
                        "plan:decision",
                        GraphRunId::new("run:one"),
                        "decision graph",
                        vec![NodeDefinition::control(
                            NodeId::new("decision"),
                            NodeKind::HumanDecision,
                            "decision",
                            NonZeroU32::new(1).unwrap(),
                        )],
                        Vec::new(),
                    )
                    .unwrap(),
                    1,
                ),
                None,
            )
            .unwrap(),
        ]
        .into_iter()
        .collect(),
        pending_workflow_plan_admissions: Vec::new(),
        templates: Vec::new(),
        deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
        activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
        triggers: [].into_iter().collect(),
        control_resolutions: [].into_iter().collect(),
        approvals: vec![approval.durable_snapshot()].into_iter().collect(),
        events: EventLedger::default().snapshot(),
        evidence: [].into_iter().collect(),
    })
    .unwrap();
    let command = HumanDecisionCommand::new(
        GraphRunId::new("run:one"),
        OpaqueId::try_new("approval:decision").unwrap(),
        ApprovalDecision::Approve,
        Some("safe note".to_owned()),
        OpaqueId::try_new("approval-decision:one").unwrap(),
        2,
    )
    .unwrap();

    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(facts).unwrap();
    assert_eq!(
        store.resolve_human_decision(command.clone()),
        Ok(HumanDecisionOutcome::Recorded)
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("decision"))
            .unwrap()
            .output_port(),
        Some("approved")
    );
    assert_eq!(
        store
            .facts()
            .approvals()
            .next()
            .unwrap()
            .resolution()
            .unwrap()
            .note
            .as_deref(),
        Some("safe note")
    );
    assert_eq!(
        store.resolve_human_decision(command.clone()),
        Ok(HumanDecisionOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);

    let conflicting = HumanDecisionCommand::new(
        GraphRunId::new("run:one"),
        OpaqueId::try_new("approval:decision").unwrap(),
        ApprovalDecision::Deny,
        Some("different note".to_owned()),
        OpaqueId::try_new("approval-decision:one").unwrap(),
        2,
    )
    .unwrap();
    assert_eq!(
        store.resolve_human_decision(conflicting),
        Err(StoreFault::InvalidFacts)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);

    let mut reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened.resolve_human_decision(command),
        Ok(HumanDecisionOutcome::Replayed)
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn human_decision_resolution_commits_once_replays_and_survives_reopen() {
    let path = test_path("human-decision-resolution");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(control_facts(crate::NodeKind::HumanDecision))
        .unwrap();
    let resolution = ControlNodeResolution::human_decision(
        GraphRunId::new("run:one"),
        NodeId::new("decision"),
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("decision"))
            .unwrap()
            .fence()
            .clone(),
        crate::HumanDecision::Approve,
        2,
    )
    .unwrap();

    assert_eq!(
        store.apply_control_node_resolution(resolution.clone()),
        Ok(ControlNodeResolutionOutcome::Recorded)
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    assert_eq!(
        store
            .facts()
            .control_node_resolution(resolution.idempotency_key()),
        Some(&resolution)
    );
    let attempt = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("decision"))
        .unwrap();
    assert_eq!(attempt.status(), AttemptStatus::Completed);
    assert_eq!(attempt.output_port(), Some("approved"));

    assert_eq!(
        store.apply_control_node_resolution(resolution.clone()),
        Ok(ControlNodeResolutionOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);

    drop(store);
    let mut reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .control_node_resolution(resolution.idempotency_key()),
        Some(&resolution)
    );
    assert_eq!(
        reopened.apply_control_node_resolution(resolution),
        Ok(ControlNodeResolutionOutcome::Replayed)
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn control_resolution_requires_an_exact_outgoing_port_and_rejects_rewrites() {
    let path = test_path("control-resolution-port");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(control_facts_with_output_port("custom-outcome_2"))
        .unwrap();
    let fence = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("decision"))
        .unwrap()
        .fence()
        .clone();
    let before = fs::metadata(&path).unwrap().len();
    let unmatched = ControlNodeResolution::try_new(
        ControlAuthority::HumanDecision,
        GraphRunId::new("run:one"),
        NodeId::new("decision"),
        fence.clone(),
        AuthorizedGraphOutcome::Completed,
        "other-outcome",
        2,
    )
    .unwrap();

    assert_eq!(
        store.apply_control_node_resolution(unmatched),
        Err(StoreFault::ControlNodeResolution(
            ControlNodeResolutionError::OutputPortDoesNotMatchEdge {
                node_id: NodeId::new("decision"),
            }
        ))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), before);

    let resolution = ControlNodeResolution::try_new(
        ControlAuthority::HumanDecision,
        GraphRunId::new("run:one"),
        NodeId::new("decision"),
        fence,
        AuthorizedGraphOutcome::Completed,
        "custom-outcome_2",
        2,
    )
    .unwrap();
    assert_eq!(
        store.apply_control_node_resolution(resolution.clone()),
        Ok(ControlNodeResolutionOutcome::Recorded)
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    let conflicting = ControlNodeResolution::try_new(
        ControlAuthority::HumanDecision,
        GraphRunId::new("run:one"),
        NodeId::new("decision"),
        resolution.fence().clone(),
        AuthorizedGraphOutcome::Failed,
        "failed",
        3,
    )
    .unwrap();

    assert_eq!(
        store.apply_control_node_resolution(conflicting),
        Err(StoreFault::ControlNodeResolution(
            ControlNodeResolutionError::ConflictingResolution
        ))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);
    remove_test_path(&path);
}

#[test]
fn script_review_derives_its_resolution_from_durable_gate_facts() {
    let path = test_path("script-review-gate");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(script_review_facts()).unwrap();
    let upstream_fence = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("upstream"))
        .unwrap()
        .fence()
        .clone();
    let upstream = ControlNodeResolution::human_decision(
        GraphRunId::new("run:one"),
        NodeId::new("upstream"),
        upstream_fence,
        HumanDecision::Approve,
        2,
    )
    .unwrap();
    store.apply_control_node_resolution(upstream).unwrap();
    let graph = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph();
    let resolution = ControlNodeResolution::script_review(
        GraphRunId::new("run:one"),
        NodeId::new("review"),
        graph
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone(),
        ScriptReviewRule::AssertAllUpstreamCompleted,
        graph,
        3,
    )
    .unwrap();

    assert_eq!(resolution.output_port(), "passed");
    assert_eq!(
        store.apply_control_node_resolution(resolution.clone()),
        Ok(ControlNodeResolutionOutcome::Recorded)
    );
    drop(store);
    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .control_node_resolution(resolution.idempotency_key()),
        Some(&resolution)
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn script_review_rejects_rules_without_durable_facts() {
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:script-review",
            "plan:script-review",
            GraphRunId::new("run:one"),
            "script review",
            vec![NodeDefinition::control(
                NodeId::new("review"),
                crate::NodeKind::ScriptReview,
                "review",
                NonZeroU32::new(1).unwrap(),
            )],
            Vec::new(),
        )
        .unwrap(),
        1,
    );
    let fence = graph
        .current_attempt(&NodeId::new("review"))
        .unwrap()
        .fence()
        .clone();

    assert_eq!(
        ControlNodeResolution::script_review(
            GraphRunId::new("run:one"),
            NodeId::new("review"),
            fence.clone(),
            ScriptReviewRule::AssertNoBlockingGate,
            &graph,
            2,
        )
        .unwrap()
        .output_port(),
        "passed"
    );
    assert_eq!(
        ControlNodeResolution::script_review(
            GraphRunId::new("run:one"),
            NodeId::new("review"),
            fence,
            ScriptReviewRule::AssertArtifactExists,
            &graph,
            2,
        )
        .unwrap()
        .output_port(),
        "failed"
    );
}

#[test]
fn join_resolution_commits_after_gate_readiness_without_a_delivery_or_session_terminal() {
    let path = test_path("join-resolution");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(join_facts()).unwrap();
    let upstream_fence = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("upstream"))
        .unwrap()
        .fence()
        .clone();
    store
        .apply_control_node_resolution(
            ControlNodeResolution::human_decision(
                GraphRunId::new("run:one"),
                NodeId::new("upstream"),
                upstream_fence,
                HumanDecision::Approve,
                2,
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(store.facts().deliveries().deliveries().count(), 0);
    let graph = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph();
    let resolution = ControlNodeResolution::join(
        GraphRunId::new("run:one"),
        NodeId::new("join"),
        graph
            .current_attempt(&NodeId::new("join"))
            .unwrap()
            .fence()
            .clone(),
        graph,
        3,
    )
    .unwrap();

    assert_eq!(
        store.apply_control_node_resolution(resolution.clone()),
        Ok(ControlNodeResolutionOutcome::Recorded)
    );
    let committed_len = fs::metadata(&path).unwrap().len();
    let attempt = store
        .facts()
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("join"))
        .unwrap();
    assert_eq!(attempt.status(), AttemptStatus::Completed);
    assert_eq!(attempt.output_port(), Some("joined"));
    assert_eq!(
        store.apply_control_node_resolution(resolution.clone()),
        Ok(ControlNodeResolutionOutcome::Replayed)
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), committed_len);
    drop(store);
    let reopened = OrganizationStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .facts()
            .control_node_resolution(resolution.idempotency_key()),
        Some(&resolution)
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn runtime_receipt_installs_once_and_survives_reopen() {
    let path = test_path("runtime-receipt-install");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(provisionable_facts()).unwrap();
    let receipt = provisionable_runtime("agent:one");

    store.install_runtime_receipt(receipt.clone()).unwrap();
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .runtime(),
        Some(&receipt)
    );
    let bytes_after_install = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.install_runtime_receipt(receipt),
        Err(StoreFault::RuntimeReceipt(
            super::OrganizationFactsError::RuntimeAlreadyInstalled
        ))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), bytes_after_install);

    drop(store);
    let reopened = OrganizationStore::open(&path).unwrap();
    assert!(
        reopened
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .runtime()
            .is_some()
    );
    drop(reopened);
    remove_test_path(&path);
}

#[test]
fn runtime_receipt_install_accepts_agent_drift_with_matching_team_role_and_endpoint() {
    let path = test_path("runtime-receipt-agent-drift");
    let mut store = OrganizationStore::open(&path).unwrap();
    store.replace_facts(provisionable_facts()).unwrap();

    store
        .install_runtime_receipt(provisionable_runtime("agent:drifted"))
        .unwrap();
    assert_eq!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .runtime()
            .unwrap()
            .bindings()[0]
            .agent()
            .as_str(),
        "agent:drifted"
    );

    drop(store);
    remove_test_path(&path);
}

#[test]
fn tombstoned_team_rejects_runtime_receipt_without_appending() {
    let path = test_path("runtime-receipt-tombstoned-team");
    let mut store = OrganizationStore::open(&path).unwrap();
    store
        .replace_facts(tombstoned_provisionable_facts())
        .unwrap();
    let bytes_before = fs::metadata(&path).unwrap().len();

    assert_eq!(
        store.install_runtime_receipt(provisionable_runtime("agent:one")),
        Err(StoreFault::RuntimeReceipt(
            super::OrganizationFactsError::RuntimeTeamTombstoned
        ))
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), bytes_before);
    assert!(
        store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .runtime()
            .is_none()
    );

    drop(store);
    remove_test_path(&path);
}

#[test]
fn restore_accepts_runtime_receipt_with_agent_drift() {
    let runtime = provisionable_runtime("agent:drifted");
    let run = GraphRunFacts::new(
        team_id(),
        TeamRevision::initial(),
        graph("display"),
        Some(runtime),
    )
    .unwrap();

    assert!(
        OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false
            )],
            vec![terminal_materialization()],
            vec![run],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .is_ok()
    );
}

#[test]
fn invalid_facts_do_not_commit_or_leak_secret_sentinel() {
    let path = test_path("invalid-facts");
    let mut store = OrganizationStore::open(&path).unwrap();
    let invalid = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        [],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap();
    store.replace_facts(invalid).unwrap();
    let size_before = fs::metadata(&path).unwrap().len();

    let bad_run = GraphRunFacts::new(
        team_id(),
        TeamRevision::try_new(2).unwrap(),
        graph("secret-sentinel-must-not-reach-the-log"),
        None,
    )
    .unwrap();
    let error = OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![bad_run],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap_err();
    assert!(
        !error
            .to_string()
            .contains("secret-sentinel-must-not-reach-the-log")
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), size_before);
    drop(store);
    remove_test_path(&path);
}

fn control_facts(kind: crate::NodeKind) -> OrganizationFacts {
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:control",
            "plan:control",
            GraphRunId::new("run:one"),
            "control graph",
            vec![NodeDefinition::control(
                NodeId::new("decision"),
                kind,
                "decision",
                NonZeroU32::new(1).unwrap(),
            )],
            Vec::new(),
        )
        .unwrap(),
        1,
    );
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap()],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn control_facts_with_output_port(output_port: &str) -> OrganizationFacts {
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:control",
            "plan:control",
            GraphRunId::new("run:one"),
            "control graph",
            vec![
                NodeDefinition::control(
                    NodeId::new("decision"),
                    crate::NodeKind::HumanDecision,
                    "decision",
                    NonZeroU32::new(1).unwrap(),
                ),
                NodeDefinition::control(
                    NodeId::new("next"),
                    crate::NodeKind::Join,
                    "next",
                    NonZeroU32::new(1).unwrap(),
                ),
            ],
            vec![EdgeDefinition::new(
                EdgeId::new("decision-next"),
                NodeId::new("decision"),
                output_port,
                NodeId::new("next"),
                "input",
                EdgeAction::Activate,
            )],
        )
        .unwrap(),
        1,
    );
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap()],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn script_review_facts() -> OrganizationFacts {
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:script-review",
            "plan:script-review",
            GraphRunId::new("run:one"),
            "script review",
            vec![
                NodeDefinition::control(
                    NodeId::new("upstream"),
                    crate::NodeKind::HumanDecision,
                    "upstream",
                    NonZeroU32::new(1).unwrap(),
                ),
                NodeDefinition::control(
                    NodeId::new("review"),
                    crate::NodeKind::ScriptReview,
                    "review",
                    NonZeroU32::new(1).unwrap(),
                ),
            ],
            vec![EdgeDefinition::new(
                EdgeId::new("upstream-review"),
                NodeId::new("upstream"),
                "approved",
                NodeId::new("review"),
                "input",
                EdgeAction::Gate,
            )],
        )
        .unwrap(),
        1,
    );
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap()],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn join_facts() -> OrganizationFacts {
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:join",
            "plan:join",
            GraphRunId::new("run:one"),
            "join graph",
            vec![
                NodeDefinition::control(
                    NodeId::new("upstream"),
                    crate::NodeKind::HumanDecision,
                    "upstream",
                    NonZeroU32::new(1).unwrap(),
                ),
                NodeDefinition::control(
                    NodeId::new("join"),
                    crate::NodeKind::Join,
                    "join",
                    NonZeroU32::new(1).unwrap(),
                ),
            ],
            vec![EdgeDefinition::new(
                EdgeId::new("upstream-join"),
                NodeId::new("upstream"),
                "approved",
                NodeId::new("join"),
                "input",
                EdgeAction::Gate,
            )],
        )
        .unwrap(),
        1,
    );
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap()],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn provisionable_facts() -> OrganizationFacts {
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        vec![terminal_materialization()],
        vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn tombstoned_provisionable_facts() -> OrganizationFacts {
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            true,
        )],
        vec![terminal_materialization()],
        vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn provisionable_runtime(agent: &str) -> RunRuntimeReceipt {
    runtime(RoleSessionReceipt::with_endpoint_session_id(
        team_id(),
        GraphRunId::new("run:one"),
        RoleId::try_new("leader").unwrap(),
        crate::RoleSessionRef::initial(),
        EndpointSessionId::try_new("native-session:one").unwrap(),
        ManagedAgentReference::try_new(agent).unwrap(),
        RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
    ))
}

fn approval(approval_id: &str) -> Approval {
    Approval::request(ApprovalRequest {
        approval_id: approval_id.to_owned(),
        run_id: "run:one".to_owned(),
        stage_id: "work".to_owned(),
        role_id: "leader".to_owned(),
        reason: "Review required".to_owned(),
        requested_action: "Release".to_owned(),
        risk_summary: "Production impact".to_owned(),
        idempotency_key: format!("request:{approval_id}"),
        requested_at: 1,
        subject: ApprovalSubject::Stage {
            stage_id: "work".to_owned(),
        },
        origin: ApprovalOrigin::StageContinuation,
        effect: ApprovalEffect::ResumeStage,
        execution_fence: None,
    })
}

fn facts_with_approvals<const N: usize>(approval_ids: [&str; N]) -> OrganizationFacts {
    OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
        teams: vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )]
        .into_iter()
        .collect(),
        materializations: [].into_iter().collect(),
        runs: vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ]
        .into_iter()
        .collect(),
        pending_workflow_plan_admissions: Vec::new(),
        templates: Vec::new(),
        deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
        activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
        triggers: [].into_iter().collect(),
        control_resolutions: [].into_iter().collect(),
        approvals: approval_ids
            .into_iter()
            .map(approval)
            .map(|approval| approval.durable_snapshot())
            .collect(),
        events: EventLedger::default().snapshot(),
        evidence: [].into_iter().collect(),
    })
    .unwrap()
}

fn facts_with_pending_delivery() -> OrganizationFacts {
    let delivery = Delivery::request(delivery_request()).unwrap();
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(team_id(), TeamRevision::initial(), graph("display"), None).unwrap(),
        ],
        DeliveryLedgerSnapshot::new(vec![delivery.snapshot()]),
    )
    .unwrap()
}

fn evidence_record(evidence_id: &str, run_id: &str, node_execution_id: &str) -> EvidenceRecord {
    EvidenceRecord::new(
        EvidenceId::new(evidence_id).unwrap(),
        run_id,
        node_execution_id,
        EvidenceReference::opaque(
            crate::EvidenceReferenceKind::Artifact,
            "artifact:opaque",
            Some("result".to_owned()),
        )
        .unwrap(),
        2,
    )
    .unwrap()
}

fn delivery_request() -> DeliveryRequest {
    DeliveryRequest {
        delivery_id: DeliveryId::new("delivery:one").unwrap(),
        team_id: "team:one".to_owned(),
        run_id: "run:one".to_owned(),
        node_id: "start".to_owned(),
        node_execution_id: "start:attempt:1".to_owned(),
        task_id: "task:one".to_owned(),
        role_id: "leader".to_owned(),
        session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
        idempotency_key: "delivery:one".to_owned(),
        message: "private prompt".to_owned(),
        requested_at: 1,
        max_attempts: 2,
    }
}

fn claimed_delivery(store: &mut OrganizationStore) -> crate::DeliveryClaim {
    match store
        .claim_delivery(&DeliveryId::new("delivery:one").unwrap(), 2)
        .unwrap()
    {
        DeliveryStart::Claimed(claim) => claim,
        other => panic!("expected delivery claim, got {other:?}"),
    }
}

fn settled_phase(resolution: DeliveryResolution) -> DeliveryPhase {
    match resolution {
        DeliveryResolution::Delivered => DeliveryPhase::Delivered {
            receipt: crate::DeliveryReceiptReference::try_new("receipt:one").unwrap(),
            native_correlation: None,
            accepted_at: 3,
        },
        DeliveryResolution::Failed => DeliveryPhase::Failed {
            failed_at: 3,
            failure: crate::DeliveryFailure::PolicyRejected,
        },
        DeliveryResolution::OutcomeUnknown => DeliveryPhase::OutcomeUnknown { observed_at: 3 },
        DeliveryResolution::RetryScheduled { retry_at } => {
            panic!("unexpected retry settlement at {retry_at}")
        }
    }
}

fn assert_settled_delivery(facts: &OrganizationFacts, resolution: DeliveryResolution) {
    assert_eq!(
        facts
            .deliveries()
            .delivery(&DeliveryId::new("delivery:one").unwrap())
            .unwrap()
            .phase(),
        &settled_phase(resolution)
    );
}

fn terminal_facts() -> OrganizationFacts {
    let (delivery, graph, binding) = observed_delivery_and_graph();
    facts_with_delivery(delivery, graph, binding, Vec::new())
}

fn delivered_terminal_facts() -> OrganizationFacts {
    let (delivery, graph, binding) = delivered_delivery_and_graph();
    let second_run = GraphRunFacts::new(
        team_id(),
        TeamRevision::initial(),
        graph_for_run("run:two", "secondary display"),
        None,
    )
    .unwrap();
    facts_with_delivery(delivery, graph, binding, vec![second_run])
}

fn terminal_materialization() -> MaterializationReceipt {
    MaterializationReceipt::try_new(
        team_id(),
        RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
        vec![RoleMaterializationReceipt::with_native_workspace(
            RoleId::try_new("leader").unwrap(),
            ManagedAgentReference::try_new("agent:one").unwrap(),
            crate::RoleMaterializationOwnership::Managed,
            RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
            NativeWorkspaceReceipt::try_new("workspace:path:one").unwrap(),
        )],
    )
    .unwrap()
}

fn native_terminal_target(store: &OrganizationStore) -> super::NativeTerminalReceiptTarget {
    store
        .native_terminal_target(&DeliveryId::new("delivery:one").unwrap())
        .expect("delivered terminal fixture must provide a receipt target")
}

fn assert_terminal_observation_projection(
    facts: &OrganizationFacts,
    native_terminal: NativeTerminalStatus,
) {
    assert_native_terminal_projection(
        facts,
        native_terminal,
        AttemptStatus::Waiting,
        &TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
    );
}

fn assert_native_terminal_projection(
    facts: &OrganizationFacts,
    native_terminal: NativeTerminalStatus,
    expected_status: AttemptStatus,
    expected_resolution: &TerminalObservationResolution,
) {
    let delivery = facts
        .deliveries()
        .delivery(&DeliveryId::new("delivery:one").unwrap())
        .unwrap();
    assert!(matches!(
        delivery.phase(),
        DeliveryPhase::TerminalObserved { observation }
            if observation.native_terminal() == native_terminal
                && observation.observed_at() == 4
                && observation.resolution() == expected_resolution
    ));
    let attempt = facts
        .run(&GraphRunId::new("run:one"))
        .unwrap()
        .graph()
        .current_attempt(&NodeId::new("start"))
        .unwrap();
    assert_eq!(attempt.status(), expected_status);
    assert!(attempt.output_port().is_none());
    if matches!(
        expected_resolution,
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution
    ) {
        assert_eq!(
            query_team_run(
                facts,
                &TeamRunQuery::get(team_id(), GraphRunId::new("run:one")),
            ),
            TeamRunQueryOutcome::OutcomeUnknown
        );
    }
}

fn agent_event_facts(
    delivery: Delivery,
    graph: GraphState,
    binding: RoleSessionReceipt,
) -> OrganizationFacts {
    facts_with_delivery(delivery, graph, binding, Vec::new())
}

fn facts_with_delivery(
    delivery: Delivery,
    graph: GraphState,
    binding: RoleSessionReceipt,
    extra_runs: Vec<GraphRunFacts>,
) -> OrganizationFacts {
    let mut runs = vec![
        GraphRunFacts::new(
            team_id(),
            TeamRevision::initial(),
            graph,
            Some(runtime(binding)),
        )
        .unwrap(),
    ];
    runs.extend(extra_runs);
    OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
        teams: vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        materializations: vec![terminal_materialization()],
        runs,
        pending_workflow_plan_admissions: Vec::new(),
        templates: Vec::new(),
        deliveries: DeliveryLedgerSnapshot::new(vec![delivery.snapshot()]),
        activities: crate::ActivityLedgerSnapshot::new(Vec::new()),
        triggers: Vec::new(),
        control_resolutions: Vec::new(),
        approvals: Vec::new(),
        events: EventLedgerSnapshot::default(),
        evidence: Vec::new(),
    })
    .unwrap()
}

fn observed_work_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    observe_agent_delivery(delivered_work_delivery_and_graph())
}

fn observed_review_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    observe_agent_delivery(delivered_review_delivery_and_graph())
}

fn observed_routed_work_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    observe_agent_delivery(delivered_routed_work_delivery_and_graph())
}

fn observe_agent_delivery(
    (mut delivery, mut graph, binding): (Delivery, GraphState, RoleSessionReceipt),
) -> (Delivery, GraphState, RoleSessionReceipt) {
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        EndpointSessionId::try_new("matcha-session-correlation-canary").unwrap(),
        NativeRunReceiptReference::try_new("matcha-native-run-correlation-canary").unwrap(),
        NativeTerminalStatus::Completed,
        4,
    )
    .unwrap();
    (delivery, graph, binding)
}

fn observed_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    let (mut delivery, mut graph, binding) = delivered_delivery_and_graph();
    observe_native_terminal(
        &mut delivery,
        &mut graph,
        EndpointSessionId::try_new("matcha-session-correlation-canary").unwrap(),
        NativeRunReceiptReference::try_new("matcha-native-run-correlation-canary").unwrap(),
        NativeTerminalStatus::Completed,
        4,
    )
    .unwrap();
    (delivery, graph, binding)
}

fn delivered_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    delivery_and_graph_for_node("start", graph("display"))
}

fn delivered_work_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    delivery_and_graph_for_node("work", agent_graph(NodeKind::Work, Vec::new()))
}

fn delivered_review_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    delivery_and_graph_for_node("review", agent_graph(NodeKind::Review, Vec::new()))
}

fn delivered_routed_work_delivery_and_graph() -> (Delivery, GraphState, RoleSessionReceipt) {
    delivery_and_graph_for_node(
        "work",
        agent_graph(
            NodeKind::Work,
            vec![EdgeDefinition::new(
                EdgeId::new("work-next"),
                NodeId::new("work"),
                "completed",
                NodeId::new("next"),
                "input",
                EdgeAction::Activate,
            )],
        ),
    )
}

fn agent_graph(kind: NodeKind, edges: Vec<EdgeDefinition>) -> GraphState {
    let node_id = match kind {
        NodeKind::Work => NodeId::new("work"),
        NodeKind::Review => NodeId::new("review"),
        _ => unreachable!("agent event fixtures only model work and review nodes"),
    };
    let mut nodes = vec![match kind {
        NodeKind::Work => NodeDefinition::work(
            node_id.clone(),
            "work",
            NonZeroU32::new(1).unwrap(),
            WorkAssignment::typed(
                "task:one",
                "private prompt",
                ExecutorPolicy::team_role("leader"),
                None,
                None,
            ),
        ),
        NodeKind::Review => NodeDefinition::review(
            node_id.clone(),
            "review",
            NonZeroU32::new(1).unwrap(),
            ReviewAssignment::new("leader", "private prompt"),
        ),
        _ => unreachable!("agent event fixtures only model work and review nodes"),
    }];
    if !edges.is_empty() {
        nodes.push(NodeDefinition::control(
            NodeId::new("next"),
            NodeKind::End,
            "next",
            NonZeroU32::new(1).unwrap(),
        ));
    }
    GraphState::initialize(
        GraphDefinition::new(
            "graph:one",
            "plan:one",
            GraphRunId::new("run:one"),
            "agent event",
            nodes,
            edges,
        )
        .unwrap(),
        1,
    )
}

fn delivery_and_graph_for_node(
    node_id: &str,
    graph: GraphState,
) -> (Delivery, GraphState, RoleSessionReceipt) {
    let binding = RoleSessionReceipt::with_endpoint_session_id(
        team_id(),
        GraphRunId::new("run:one"),
        RoleId::try_new("leader").unwrap(),
        crate::RoleSessionRef::initial(),
        EndpointSessionId::try_new("native-session:one").unwrap(),
        ManagedAgentReference::try_new("agent:one").unwrap(),
        RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
    );
    let mut delivery = Delivery::request(DeliveryRequest {
        delivery_id: DeliveryId::new("delivery:one").unwrap(),
        team_id: "team:one".to_owned(),
        run_id: "run:one".to_owned(),
        node_id: node_id.to_owned(),
        node_execution_id: format!("{node_id}:attempt:1"),
        task_id: "task:one".to_owned(),
        role_id: "leader".to_owned(),
        session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
        idempotency_key: "delivery:one".to_owned(),
        message: "private prompt".to_owned(),
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
            receipt: crate::DeliveryReceiptReference::try_new("delivery-receipt:one").unwrap(),
            native_correlation: Some(NativeDeliveryCorrelation::new(
                EndpointSessionId::try_new("matcha-session-correlation-canary").unwrap(),
                NativeRunReceiptReference::try_new("matcha-native-run-correlation-canary").unwrap(),
            )),
            accepted_at: 3,
        },
        4,
    )
    .unwrap();
    let attempt_id = crate::AttemptId::for_node(&NodeId::new(node_id), NonZeroU32::new(1).unwrap());
    let fence = crate::ExecutionFence::new(
        attempt_id.clone(),
        crate::NodeExecutionId::for_attempt(&attempt_id),
    );
    let graph = reduce(
        graph,
        GraphEvent::AttemptStarted {
            node_id: NodeId::new(node_id),
            fence,
            started_at: 3,
        },
    )
    .unwrap();
    (delivery, graph, binding)
}

fn runtime(binding: RoleSessionReceipt) -> RunRuntimeReceipt {
    RunRuntimeReceipt::try_new(GraphRunId::new("run:one"), vec![binding]).unwrap()
}

fn facts_with_armed_webhook_run() -> OrganizationFacts {
    let definition = GraphDefinition::new(
        "graph:one",
        "plan:one",
        GraphRunId::new("run:one"),
        "display",
        vec![
            NodeDefinition::start(
                NodeId::new("start"),
                "webhook start",
                NonZeroU32::new(2).unwrap(),
                Some(StartTrigger::Webhook {
                    path: "/team/release".to_owned(),
                }),
            ),
            NodeDefinition::start(
                NodeId::new("alternate"),
                "alternate webhook start",
                NonZeroU32::new(2).unwrap(),
                Some(StartTrigger::Webhook {
                    path: "alternate".to_owned(),
                }),
            ),
        ],
        Vec::new(),
    )
    .unwrap();
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![
            GraphRunFacts::new(
                team_id(),
                TeamRevision::initial(),
                GraphState::initialize(definition, 1),
                None,
            )
            .unwrap(),
        ],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn facts_with_work_root() -> OrganizationFacts {
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:one",
            "plan:one",
            GraphRunId::new("run:one"),
            "graph",
            vec![NodeDefinition::work(
                NodeId::new("work"),
                "work",
                NonZeroU32::new(1).unwrap(),
                WorkAssignment::new("task:one", "leader"),
            )],
            Vec::new(),
        )
        .unwrap(),
        1,
    );
    OrganizationFacts::restore(
        [TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        [GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap()],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn facts_with_run(display_text: &str, interrupted_delivery: bool) -> OrganizationFacts {
    let graph = graph(display_text);
    let run = GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, None).unwrap();
    let deliveries = if interrupted_delivery {
        let mut delivery = Delivery::request(DeliveryRequest {
            delivery_id: DeliveryId::new("delivery:one").unwrap(),
            team_id: "team:one".to_owned(),
            run_id: "run:one".to_owned(),
            node_id: "start".to_owned(),
            node_execution_id: "start:attempt:1".to_owned(),
            task_id: "task:one".to_owned(),
            role_id: "leader".to_owned(),
            session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
            idempotency_key: "delivery:one".to_owned(),
            message: "private prompt".to_owned(),
            requested_at: 1,
            max_attempts: 2,
        })
        .unwrap();
        let _ = begin_delivery(&mut delivery, 2);
        DeliveryLedger::restore(DeliveryLedgerSnapshot::new(vec![delivery.snapshot()])).unwrap()
    } else {
        DeliveryLedger::default()
    };
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            team_definition(),
            TeamRevision::initial(),
            false,
        )],
        [],
        vec![run],
        deliveries.snapshot(),
    )
    .unwrap()
}

fn workflow_plan(run_id: &str, idempotency_key: &str) -> crate::run::WorkflowPlan {
    crate::run::WorkflowPlan::new(
        "plan:workflow",
        run_id,
        "Workflow title",
        "active",
        vec![crate::run::WorkflowGroup::new(
            "group:primary",
            "Primary work",
            vec!["task:one".to_owned(), "task:two".to_owned()],
            crate::run::WorkflowJoinPolicy::new(true, false, 2),
        )],
        vec![
            crate::run::WorkflowTask::new(
                "task:one",
                "leader",
                "Task one",
                "prompt:one",
                Vec::new(),
                Some("artifact:one".to_owned()),
            ),
            crate::run::WorkflowTask::new(
                "task:two",
                "leader",
                "Task two",
                "prompt:two",
                vec!["task:one".to_owned()],
                Some("artifact:two".to_owned()),
            ),
            crate::run::WorkflowTask::new(
                "task:three",
                "leader",
                "Task three",
                "prompt:three",
                Vec::new(),
                None,
            ),
        ],
        idempotency_key,
        42,
    )
}

fn graph(display_text: &str) -> GraphState {
    graph_for_run("run:one", display_text)
}

fn rich_replacement_definition() -> GraphDefinition {
    let attempts = NonZeroU32::new(3).unwrap();
    let node = |id| NodeId::new(id);
    let edge = |id, source, port, target, action| {
        EdgeDefinition::new(
            EdgeId::new(id),
            node(source),
            port,
            node(target),
            "input",
            action,
        )
    };
    GraphDefinition::new(
        "graph:replacement:rich",
        "plan:replacement:rich",
        GraphRunId::new("run:one"),
        "rich replacement",
        vec![
            NodeDefinition::control(
                node("control-start"),
                NodeKind::Start,
                "Control start",
                attempts,
            ),
            NodeDefinition::start(node("start"), "Start", attempts, None),
            NodeDefinition::work(
                node("work"),
                "Work",
                attempts,
                WorkAssignment::typed(
                    "task-work",
                    "work instruction",
                    ExecutorPolicy::team_role("role-work"),
                    Some("artifact-report".to_owned()),
                    Some(GroupId::new("group-work")),
                ),
            ),
            NodeDefinition::review(
                node("review"),
                "Review",
                attempts,
                ReviewAssignment::new("role-review", "review instruction"),
            ),
            NodeDefinition::join(
                node("typed-join"),
                "Typed join",
                attempts,
                WorkGroup::new(GroupId::new("group-typed"), JoinPolicy::new(true, false, 2)),
            ),
            NodeDefinition::control(
                node("control-review"),
                NodeKind::Review,
                "Review gate",
                attempts,
            ),
            NodeDefinition::control(
                node("human-decision"),
                NodeKind::HumanDecision,
                "Human decision",
                attempts,
            ),
            NodeDefinition::control(
                node("script-review"),
                NodeKind::ScriptReview,
                "Script review",
                attempts,
            ),
            NodeDefinition::control(node("control-join"), NodeKind::Join, "Join gate", attempts),
            NodeDefinition::control(node("end"), NodeKind::End, "End", attempts),
        ],
        vec![
            edge(
                "control-start-start",
                "control-start",
                "completed",
                "start",
                EdgeAction::Activate,
            ),
            edge(
                "start-work",
                "start",
                "completed",
                "work",
                EdgeAction::Activate,
            )
            .with_payload(EdgePayloadPolicy::new(false))
            .with_dependency(DependencyMetadata::new("task-start", "task-work")),
            edge(
                "work-review",
                "work",
                "completed",
                "review",
                EdgeAction::Activate,
            ),
            edge(
                "review-typed-join",
                "review",
                "completed",
                "typed-join",
                EdgeAction::Gate,
            ),
            edge(
                "typed-join-control-review",
                "typed-join",
                "joined",
                "control-review",
                EdgeAction::Activate,
            ),
            edge(
                "control-review-human-decision",
                "control-review",
                "approved",
                "human-decision",
                EdgeAction::Activate,
            ),
            edge(
                "human-decision-script-review",
                "human-decision",
                "approved",
                "script-review",
                EdgeAction::Activate,
            ),
            edge(
                "script-review-control-join",
                "script-review",
                "approved",
                "control-join",
                EdgeAction::Gate,
            ),
            edge(
                "control-join-end",
                "control-join",
                "joined",
                "end",
                EdgeAction::Finish,
            ),
        ],
    )
    .unwrap()
}

fn graph_for_run(run_id: &str, display_text: &str) -> GraphState {
    let definition = GraphDefinition::new(
        "graph:one",
        "plan:one",
        GraphRunId::new(run_id),
        display_text,
        vec![NodeDefinition::start(
            NodeId::new("start"),
            display_text,
            NonZeroU32::new(2).unwrap(),
            None,
        )],
        Vec::new(),
    )
    .unwrap();
    GraphState::initialize(definition, 1)
}

fn team_id() -> TeamId {
    TeamId::try_new("team:one").unwrap()
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
        team_id(),
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

fn test_path(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "matcha-organization-store-{name}-{}-{}",
            std::process::id(),
            NEXT_PATH_ID.fetch_add(1, Ordering::Relaxed)
        ))
        .join("facts.log")
}

fn remove_test_path(path: &Path) {
    let root = path
        .parent()
        .expect("test durable path has a unique parent");
    let _ = fs::remove_dir_all(root);
}

fn contains(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.windows(needle.len()).any(|window| window == needle)
}
