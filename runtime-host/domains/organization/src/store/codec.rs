use std::{
    io::{Read, Write},
    num::{NonZeroU32, NonZeroU64},
};

use crate::{
    ActivityClaimSnapshot, ActivityDispatchSnapshot, ActivityFailure, ActivityId, ActivityKind,
    ActivityLedgerSnapshot, ActivityPhaseSnapshot, ActivityRequest, ActivitySnapshot,
    ActivityTarget, ControlAuthority, ControlNodeResolution, DeliveryClaimSnapshot,
    DeliveryFailure, DeliveryId, DeliveryLedgerSnapshot, DeliveryPhaseSnapshot, DeliveryRequest,
    DeliverySnapshot, EdgeAction, EvidenceId, EvidenceRecord, EvidenceReference,
    EvidenceReferenceKind, ExecutionFence, GraphRunId, GraphState, IdempotencyKey,
    LocalSessionReference, ManagedAgentReference, MatchaDeliveryCorrelation,
    MaterializationReceipt, MaterializationRejection, MaterializationSource, MemberId,
    NodeDefinition, NodeId, NodeKind, RoleAgentMaterialization, RoleAssignment, RoleId, RoleKind,
    RoleMaterializationAgent, RoleMaterializationReceipt, RoleSessionReceipt, RunRuntimeReceipt,
    RuntimeEndpointReference, StartTrigger, TeamDefinition, TeamId, TeamMaterializationCleanup,
    TeamMaterializationIntent, TeamMaterializationLifecycle, TeamMaterializationRemoval,
    TeamMaterializationRequest, TeamMember, TeamRevision, TeamRole, TombstonedMaterialization,
    TriggerFireRequest, TriggerSource, WorkAssignment,
    run::task_board::{
        AutoRunnerFacts, MailboxKind, MailboxMessage, RunnerStatus, TaskBoardFacts, TaskId,
        TaskRecord, TaskRestoreInput, TaskStatus,
    },
    run::{
        approval::{
            ApprovalDecision, ApprovalDurableSnapshot, ApprovalEffect, ApprovalOrigin,
            ApprovalRequest, ApprovalResolution, ApprovalResolutionCause, ApprovalStatus,
            ApprovalSubject,
        },
        artifact::{ArtifactEvidenceProvenance, ArtifactId, ArtifactRecord},
        control::ControlNodeResolutionInput,
        decision::{
            TeamDecisionCommand, TeamDecisionEventSnapshot, TeamDecisionLedgerSnapshot,
            TeamDecisionSnapshot, TeamDecisionType,
        },
        delivery::{
            AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionReceipt,
            NativeRunReceiptReference, NativeTerminalStatus, TerminalObservationResolution,
            TerminalObservationSnapshot, TerminalObservationSnapshotInput,
        },
        event::{
            ApprovalAction, ApprovalCommand, CommandPayload, CommandRecord, CommandRejection,
            CommandStatus, EventLedgerSnapshot, GraphEdgeAction, GraphNodeKind, GraphPatch,
            GraphPatchOperation, MetadataValue, NodeEventKind, NodeProgressCommand, OpaqueId,
            RunCommand, TeamEvent, TeamEventDurableInput, TeamEventPayload, TeamEventType,
        },
        graph::{
            DurableAttemptReason, DurableDependencyMetadata, DurableEdgeDefinition,
            DurableExecutionFence, DurableInputReceipt, DurableNodeAttempt, DurableNodeDefinition,
            DurableNodeExecution, DurableReadyQueueItem, DurableReviewAssignment,
            DurableStartTrigger, DurableWorkAssignment, DurableWorkGroup, GraphDurableSnapshot,
        },
        lifecycle::{GraphRunLifecycle, GraphRunLifecycleState},
    },
};

use super::facts::{
    MaterializationLifecycleFactsRestoreInput, PendingWorkflowPlanAdmission, PurgedRunMarker,
    WorkflowTemplateFacts,
};
use super::{GraphRunFacts, OrganizationFacts, StoreFault, TeamFacts};

pub(super) const HEADER_LEN: usize = 17;
pub(super) const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
const LOG_MAGIC: [u8; 8] = *b"MORGDU01";
const CURRENT_SCHEMA_VERSION: u8 = 20;
const FRAME_MARKER: u8 = 0xA1;
const FRAME_METADATA_LEN: usize = 16;
const MAX_FACTS_BYTES: usize = 1024 * 1024;
const MAX_COLLECTION_ENTRIES: usize = 16_384;
const MAX_STRING_BYTES: usize = 16 * 1024;

pub(super) struct RecoveredFacts {
    pub(super) facts: OrganizationFacts,
    pub(super) epoch: u64,
    pub(super) committed_len: u64,
    pub(super) truncated_tail: bool,
    pub(super) had_interrupted_delivery: bool,
    pub(super) had_interrupted_activity: bool,
}

pub(super) fn initialize_log(mut output: impl Write) -> Result<(), StoreFault> {
    output
        .write_all(&LOG_MAGIC)
        .and_then(|()| output.write_all(&[CURRENT_SCHEMA_VERSION]))
        .and_then(|()| output.write_all(&0_u64.to_le_bytes()))
        .map_err(|error| StoreFault::Commit(error.kind()))
}

pub(super) fn recover_log(mut input: impl Read) -> Result<RecoveredFacts, StoreFault> {
    let mut content = Vec::new();
    input
        .by_ref()
        .take(MAX_LOG_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| StoreFault::Read(error.kind()))?;
    if content.len() > MAX_LOG_BYTES as usize {
        return Err(StoreFault::LogFull);
    }
    if content.len() < HEADER_LEN || content[..LOG_MAGIC.len()] != LOG_MAGIC {
        return Err(StoreFault::CorruptRecord);
    }
    let schema = content[LOG_MAGIC.len()];
    if schema != CURRENT_SCHEMA_VERSION {
        return Err(StoreFault::UnsupportedSchemaVersion(schema));
    }

    let mut epoch = u64::from_le_bytes(
        content[LOG_MAGIC.len() + 1..HEADER_LEN]
            .try_into()
            .map_err(|_| StoreFault::CorruptRecord)?,
    );
    let mut facts = OrganizationFacts::default();
    let mut offset = HEADER_LEN;
    let mut committed_len = HEADER_LEN;
    let mut truncated_tail = false;
    let mut had_interrupted_delivery = false;
    let mut had_interrupted_activity = false;

    while offset < content.len() {
        if content[offset] != FRAME_MARKER {
            return Err(StoreFault::CorruptRecord);
        }
        offset += 1;
        let metadata_end = offset
            .checked_add(FRAME_METADATA_LEN)
            .ok_or(StoreFault::CorruptRecord)?;
        if metadata_end > content.len() {
            truncated_tail = true;
            break;
        }
        let metadata = &content[offset..metadata_end];
        offset = metadata_end;
        let frame_epoch = u64::from_le_bytes(
            metadata[..8]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        );
        let payload_len = usize::try_from(u32::from_le_bytes(
            metadata[8..12]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
        .map_err(|_| StoreFault::CorruptRecord)?;
        if payload_len > MAX_FACTS_BYTES {
            return Err(StoreFault::CorruptRecord);
        }
        let expected_checksum = u32::from_le_bytes(
            metadata[12..]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        );
        let payload_end = offset
            .checked_add(payload_len)
            .ok_or(StoreFault::CorruptRecord)?;
        if payload_end > content.len() {
            truncated_tail = true;
            break;
        }
        let payload = &content[offset..payload_end];
        offset = payload_end;
        if expected_checksum != checksum_fn(payload) {
            return Err(StoreFault::CorruptRecord);
        }
        let expected_epoch = epoch.checked_add(1).ok_or(StoreFault::EpochOverflow)?;
        if frame_epoch != expected_epoch {
            return Err(StoreFault::CorruptRecord);
        }
        let decoded = decode_facts(payload)?;
        had_interrupted_delivery = decoded
            .deliveries()
            .deliveries()
            .any(|delivery| matches!(delivery.phase(), crate::DeliveryPhase::Delivering(_)));
        had_interrupted_activity = decoded.activities().activities().any(|activity| {
            matches!(
                activity.phase(),
                crate::ActivityPhase::Claimed(_) | crate::ActivityPhase::Dispatched(_)
            )
        });
        facts = decoded;
        epoch = frame_epoch;
        committed_len = offset;
    }

    Ok(RecoveredFacts {
        facts,
        epoch,
        committed_len: u64::try_from(committed_len).map_err(|_| StoreFault::LogFull)?,
        truncated_tail,
        had_interrupted_delivery,
        had_interrupted_activity,
    })
}

pub(super) fn encode_frame(epoch: u64, facts: &OrganizationFacts) -> Result<Vec<u8>, StoreFault> {
    let payload = encode_facts(facts)?;
    if payload.len() > MAX_FACTS_BYTES {
        return Err(StoreFault::RecordTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| StoreFault::RecordTooLarge)?;
    let mut frame = Vec::with_capacity(1 + FRAME_METADATA_LEN + payload.len());
    frame.push(FRAME_MARKER);
    frame.extend_from_slice(&epoch.to_le_bytes());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&checksum_fn(&payload).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn encode_facts(facts: &OrganizationFacts) -> Result<Vec<u8>, StoreFault> {
    let mut output = Vec::new();
    push_count(&mut output, facts.teams().count())?;
    for team in facts.teams() {
        encode_team_definition(&mut output, team.definition())?;
        output.extend_from_slice(&team.revision().get().to_le_bytes());
        output.push(u8::from(team.tombstoned()));
    }
    push_count(&mut output, facts.materialization_lifecycles().count())?;
    for lifecycle in facts.materialization_lifecycles() {
        encode_materialization_lifecycle(&mut output, lifecycle)?;
    }
    push_count(
        &mut output,
        facts.pending_workflow_plan_admissions().count(),
    )?;
    for admission in facts.pending_workflow_plan_admissions() {
        push_string(&mut output, admission.team_id().as_str())?;
        push_string(&mut output, admission.run_id().as_str())?;
        push_string(&mut output, admission.creation_idempotency_key())?;
        output.extend_from_slice(&admission.team_revision().get().to_le_bytes());
        push_string(&mut output, admission.source_identity())?;
        output.extend_from_slice(&admission.created_at().to_le_bytes());
    }

    push_count(&mut output, facts.runs().count())?;
    for run in facts.runs() {
        push_string(&mut output, run.team().as_str())?;
        output.extend_from_slice(&run.frozen_team_revision().get().to_le_bytes());
        encode_graph(&mut output, &run.durable_snapshot())?;
        push_optional_runtime(&mut output, run.runtime())?;
        encode_lifecycle(&mut output, run.lifecycle())?;
    }
    push_count(&mut output, facts.templates().count())?;
    for template in facts.templates() {
        push_string(&mut output, template.team().as_str())?;
        push_string(&mut output, template.source_identity())?;
        output.extend_from_slice(&template.revision().to_le_bytes());
        encode_workflow_plan(&mut output, template.plan())?;
    }
    encode_deliveries(&mut output, &facts.deliveries().snapshot())?;
    encode_activities(&mut output, &facts.activities().snapshot())?;
    encode_triggers(&mut output, facts.triggers())?;
    encode_control_resolutions(&mut output, facts.control_node_resolutions())?;
    encode_approvals(&mut output, facts.approvals())?;
    encode_events(&mut output, &facts.event_snapshot())?;
    encode_evidence(&mut output, facts.evidence_records())?;
    encode_artifacts(&mut output, facts.artifacts())?;
    encode_decisions(&mut output, &facts.decision_snapshot())?;
    encode_task_board(&mut output, facts.task_board())?;
    push_count(&mut output, facts.purged_run_markers().count())?;
    for marker in facts.purged_run_markers() {
        push_string(&mut output, marker.run_id().as_str())?;
        push_string(&mut output, marker.idempotency_key())?;
        output.extend_from_slice(&marker.purged_at().to_le_bytes());
    }
    Ok(output)
}

fn decode_facts(content: &[u8]) -> Result<OrganizationFacts, StoreFault> {
    let mut reader = Reader::new(content);
    let teams = (0..reader.count()?)
        .map(|_| {
            Ok(TeamFacts::new(
                reader.team_definition()?,
                TeamRevision::try_new(reader.u64()?).map_err(|_| StoreFault::InvalidFacts)?,
                reader.bool()?,
            ))
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    let materializations = (0..reader.count()?)
        .map(|_| reader.materialization_lifecycle())
        .collect::<Result<Vec<_>, _>>()?;
    let pending_workflow_plan_admissions = (0..reader.count()?)
        .map(|_| {
            PendingWorkflowPlanAdmission::try_new(
                TeamId::try_new(reader.string()?).map_err(|_| StoreFault::InvalidFacts)?,
                GraphRunId::new(reader.string()?),
                reader.string()?,
                TeamRevision::try_new(reader.u64()?).map_err(|_| StoreFault::InvalidFacts)?,
                reader.string()?,
                reader.u64()?,
            )
            .map_err(|_| StoreFault::InvalidFacts)
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    let runs = (0..reader.count()?)
        .map(|_| {
            let team = TeamId::try_new(reader.string()?).map_err(|_| StoreFault::InvalidFacts)?;
            let revision =
                TeamRevision::try_new(reader.u64()?).map_err(|_| StoreFault::InvalidFacts)?;
            let graph = GraphState::restore_durable(reader.graph()?)
                .map_err(|_| StoreFault::InvalidFacts)?;
            let runtime = reader.optional_runtime()?;
            let lifecycle = reader.lifecycle()?;
            GraphRunFacts::with_lifecycle(team, revision, graph, runtime, lifecycle)
                .map_err(|_| StoreFault::InvalidFacts)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let templates = (0..reader.count()?)
        .map(|_| {
            let team = TeamId::try_new(reader.string()?).map_err(|_| StoreFault::InvalidFacts)?;
            let source_identity = reader.string()?;
            let revision = reader.u64()?;
            let plan = reader.workflow_plan()?;
            WorkflowTemplateFacts::from_plan(team, source_identity, revision, plan)
                .map_err(|_| StoreFault::InvalidFacts)
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    let deliveries = reader.deliveries()?;
    let activities = reader.activities()?;
    let triggers = reader.triggers()?;
    let control_resolutions = reader.control_resolutions()?;
    let approvals = reader.approvals()?;
    let events = reader.events()?;
    let evidence = reader.evidence()?;
    let artifacts = reader.artifacts()?;
    let decisions = reader.decisions()?;
    let task_board = reader.task_board()?;
    let purged_runs = (0..reader.count()?)
        .map(|_| {
            PurgedRunMarker::try_new(
                GraphRunId::new(reader.string()?),
                reader.string()?,
                reader.u64()?,
            )
            .map_err(|_| StoreFault::InvalidFacts)
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    reader.finish()?;
    OrganizationFacts::restore_with_materialization_lifecycles_and_decisions_and_artifacts_and_task_board_and_purged_runs(
        MaterializationLifecycleFactsRestoreInput {
            teams,
            materializations,
            runs,
            pending_workflow_plan_admissions,
            templates,
            deliveries,
            activities,
            triggers,
            control_resolutions,
            approvals,
            events,
            evidence,
        },
        decisions,
        artifacts,
        task_board,
        purged_runs,
    )
    .map_err(|_| StoreFault::InvalidFacts)
}

fn encode_team_definition(
    output: &mut Vec<u8>,
    definition: &TeamDefinition,
) -> Result<(), StoreFault> {
    push_string(output, definition.team_id().as_str())?;
    push_string(output, definition.name())?;
    push_count(output, definition.members().len())?;
    for member in definition.members() {
        push_string(output, member.member_id().as_str())?;
        push_string(output, member.name())?;
    }
    push_count(output, definition.roles().len())?;
    for role in definition.roles() {
        push_string(output, role.role_id().as_str())?;
        push_string(output, role.name())?;
        output.push(match role.kind() {
            RoleKind::Leader => 0,
            RoleKind::Member => 1,
        });
    }
    push_count(output, definition.assignments().len())?;
    for assignment in definition.assignments() {
        push_string(output, assignment.member_id().as_str())?;
        push_string(output, assignment.role_id().as_str())?;
    }
    Ok(())
}

fn encode_materialization_lifecycle(
    output: &mut Vec<u8>,
    lifecycle: &TeamMaterializationLifecycle,
) -> Result<(), StoreFault> {
    match lifecycle {
        TeamMaterializationLifecycle::Requested(request) => {
            output.push(0);
            encode_materialization_request(output, request)?;
        }
        TeamMaterializationLifecycle::Rejected { request, rejection } => {
            output.push(1);
            encode_materialization_request(output, request)?;
            output.push(match rejection {
                MaterializationRejection::Permanent => 0,
                MaterializationRejection::Retryable => 1,
            });
        }
        TeamMaterializationLifecycle::OutcomeUnknown(request) => {
            output.push(2);
            encode_materialization_request(output, request)?;
        }
        TeamMaterializationLifecycle::Confirmed(receipt) => {
            output.push(3);
            encode_materialization(output, receipt)?;
        }
        TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::None(request)) => {
            output.push(4);
            encode_materialization_request(output, request)?;
        }
        TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::OutcomeUnknown(
            request,
        )) => {
            output.push(5);
            encode_materialization_request(output, request)?;
        }
        TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
            receipt,
            cleanup,
        }) => {
            output.push(6);
            encode_materialization(output, receipt)?;
            encode_materialization_cleanup(output, cleanup)?;
        }
    }
    Ok(())
}

fn encode_materialization_request(
    output: &mut Vec<u8>,
    request: &TeamMaterializationRequest,
) -> Result<(), StoreFault> {
    let intent = request.intent();
    push_string(output, intent.team().as_str())?;
    push_string(output, intent.endpoint().as_str())?;
    output.push(match intent.source() {
        MaterializationSource::Manual => 0,
        MaterializationSource::TeamSkill => 1,
    });
    push_count(output, intent.agents().len())?;
    for agent in intent.agents() {
        push_string(output, agent.role().as_str())?;
        match agent.agent() {
            RoleMaterializationAgent::Managed { name } => {
                output.push(0);
                push_string(output, name)?;
            }
            RoleMaterializationAgent::External { agent } => {
                output.push(1);
                push_string(output, agent.as_str())?;
            }
        }
    }
    push_string(output, request.idempotency_key().as_str())
}

fn encode_materialization_cleanup(
    output: &mut Vec<u8>,
    cleanup: &TeamMaterializationCleanup,
) -> Result<(), StoreFault> {
    match cleanup {
        TeamMaterializationCleanup::Pending(removal) => {
            output.push(0);
            encode_materialization_removal(output, removal)?;
        }
        TeamMaterializationCleanup::Confirmed(removal) => {
            output.push(3);
            encode_materialization_removal(output, removal)?;
        }
        TeamMaterializationCleanup::Rejected { removal, rejection } => {
            output.push(1);
            encode_materialization_removal(output, removal)?;
            output.push(match rejection {
                MaterializationRejection::Permanent => 0,
                MaterializationRejection::Retryable => 1,
            });
        }
        TeamMaterializationCleanup::OutcomeUnknown(removal) => {
            output.push(2);
            encode_materialization_removal(output, removal)?;
        }
    }
    Ok(())
}

fn encode_materialization_removal(
    output: &mut Vec<u8>,
    removal: &TeamMaterializationRemoval,
) -> Result<(), StoreFault> {
    encode_materialization(output, removal.receipt())?;
    push_string(output, removal.idempotency_key().as_str())
}

fn encode_materialization(
    output: &mut Vec<u8>,
    receipt: &MaterializationReceipt,
) -> Result<(), StoreFault> {
    push_string(output, receipt.team().as_str())?;
    push_string(output, receipt.endpoint().as_str())?;
    push_count(output, receipt.roles().len())?;
    for role in receipt.roles() {
        push_string(output, role.role().as_str())?;
        push_string(output, role.agent().as_str())?;
        output.push(match role.ownership() {
            crate::RoleMaterializationOwnership::Managed => 0,
            crate::RoleMaterializationOwnership::External => 1,
        });
        push_string(output, role.endpoint().as_str())?;
        push_optional_string(
            output,
            role.native_workspace()
                .map(crate::ports::materialization::NativeWorkspaceReceipt::as_str),
        )?;
    }
    Ok(())
}

fn encode_workflow_plan(
    output: &mut Vec<u8>,
    plan: &crate::run::WorkflowPlan,
) -> Result<(), StoreFault> {
    push_string(output, plan.workflow_plan_id())?;
    push_string(output, plan.run_id())?;
    push_string(output, plan.title())?;
    push_string(output, plan.status())?;
    push_count(output, plan.groups().len())?;
    for group in plan.groups() {
        push_string(output, group.group_id())?;
        push_string(output, group.title())?;
        push_count(output, group.task_ids().len())?;
        for task_id in group.task_ids() {
            push_string(output, task_id)?;
        }
        output.push(u8::from(group.join().require_completed()));
        output.push(u8::from(group.join().allow_failed()));
        output.extend_from_slice(&group.join().retry_limit().to_le_bytes());
    }
    push_count(output, plan.tasks().len())?;
    for task in plan.tasks() {
        push_string(output, task.task_id())?;
        push_string(output, task.role_id())?;
        push_string(output, task.title())?;
        push_string(output, task.prompt())?;
        push_count(output, task.depends_on_task_ids().len())?;
        for dependency in task.depends_on_task_ids() {
            push_string(output, dependency)?;
        }
        push_optional_string(output, task.output_artifact_kind())?;
    }
    push_string(output, plan.idempotency_key())?;
    output.extend_from_slice(&plan.created_at().to_le_bytes());
    Ok(())
}

fn encode_graph(output: &mut Vec<u8>, graph: &GraphDurableSnapshot) -> Result<(), StoreFault> {
    push_string(output, &graph.graph_id)?;
    push_string(output, &graph.workflow_plan_id)?;
    push_string(output, &graph.run_id)?;
    push_string(output, &graph.title)?;
    push_count(output, graph.metadata.len())?;
    for (key, value) in &graph.metadata {
        push_string(output, key.as_str())?;
        encode_metadata_value(output, value)?;
    }
    push_count(output, graph.nodes.len())?;
    for node in &graph.nodes {
        output.extend_from_slice(&node.order.to_le_bytes());
        push_string(output, &node.id)?;
        output.push(node_kind_tag(node.kind));
        push_string(output, &node.title)?;
        output.extend_from_slice(&node.max_attempts.to_le_bytes());
        output.push(u8::from(node.is_control));
        match &node.trigger {
            None => output.push(0),
            Some(DurableStartTrigger::Webhook { path }) => {
                output.push(1);
                push_string(output, path)?;
            }
            Some(DurableStartTrigger::Cron { expression }) => {
                output.push(2);
                push_string(output, expression)?;
            }
        }
        match &node.work {
            None => output.push(0),
            Some(work) => {
                output.push(1);
                push_string(output, &work.task_id)?;
                push_string(output, &work.prompt)?;
                push_string(output, &work.role_id)?;
                push_optional_string(output, work.output_artifact_kind.as_deref())?;
                push_optional_string(output, work.group_id.as_deref())?;
            }
        }
        match &node.review {
            None => output.push(0),
            Some(review) => {
                output.push(1);
                push_string(output, &review.role_id)?;
                push_string(output, &review.prompt)?;
            }
        }
        match &node.group {
            None => output.push(0),
            Some(group) => {
                output.push(1);
                push_string(output, &group.group_id)?;
                output.push(u8::from(group.require_completed));
                output.push(u8::from(group.allow_failed));
                output.extend_from_slice(&group.retry_limit.to_le_bytes());
            }
        }
    }
    push_count(output, graph.edges.len())?;
    for edge in &graph.edges {
        output.extend_from_slice(&edge.order.to_le_bytes());
        push_string(output, &edge.id)?;
        push_string(output, &edge.source_node_id)?;
        push_string(output, &edge.source_port)?;
        push_string(output, &edge.target_node_id)?;
        push_string(output, &edge.target_port)?;
        output.push(edge_action_tag(edge.action));
        output.push(u8::from(edge.include_upstream_result));
        match &edge.dependency {
            None => output.push(0),
            Some(dependency) => {
                output.push(1);
                push_string(output, &dependency.dependency_task_id)?;
                push_string(output, &dependency.task_id)?;
            }
        }
    }
    push_count(output, graph.executions.len())?;
    for execution in &graph.executions {
        push_string(output, &execution.node_id)?;
        push_count(output, execution.attempts.len())?;
        for attempt in &execution.attempts {
            encode_attempt(output, attempt)?;
        }
    }
    push_count(output, graph.ready_queue.len())?;
    for item in &graph.ready_queue {
        push_string(output, &item.node_id)?;
        encode_fence(output, &item.fence)?;
        output.extend_from_slice(&item.enqueued_at.to_le_bytes());
    }
    Ok(())
}

fn encode_attempt(output: &mut Vec<u8>, attempt: &DurableNodeAttempt) -> Result<(), StoreFault> {
    encode_fence(output, &attempt.fence)?;
    output.extend_from_slice(&attempt.number.to_le_bytes());
    push_string(output, &attempt.node_id)?;
    output.push(node_kind_tag(attempt.node_kind));
    output.push(attempt_status_tag(attempt.status));
    match &attempt.reason {
        DurableAttemptReason::Initial => output.push(0),
        DurableAttemptReason::Trigger => output.push(1),
        DurableAttemptReason::Edge { edge_id } => {
            output.push(2);
            push_string(output, edge_id)?;
        }
        DurableAttemptReason::Rework => output.push(3),
    }
    push_count(output, attempt.inputs.len())?;
    for input in &attempt.inputs {
        push_string(output, &input.edge_id)?;
        output.push(edge_action_tag(input.action));
        push_string(output, &input.source_node_id)?;
        push_string(output, &input.source_port)?;
        push_string(output, &input.target_port)?;
        encode_fence(output, &input.source_fence)?;
        output.extend_from_slice(&input.arrived_at.to_le_bytes());
    }
    push_optional_string(output, attempt.output_port.as_deref())?;
    output.extend_from_slice(&attempt.created_at.to_le_bytes());
    output.extend_from_slice(&attempt.updated_at.to_le_bytes());
    Ok(())
}

fn encode_fence(output: &mut Vec<u8>, fence: &DurableExecutionFence) -> Result<(), StoreFault> {
    push_string(output, &fence.attempt_id)?;
    push_string(output, &fence.node_execution_id)
}

fn encode_deliveries(
    output: &mut Vec<u8>,
    ledger: &DeliveryLedgerSnapshot,
) -> Result<(), StoreFault> {
    push_count(output, ledger.deliveries().len())?;
    for snapshot in ledger.deliveries() {
        let facts = snapshot.facts();
        push_string(output, facts.delivery_id.as_str())?;
        push_string(output, &facts.team_id)?;
        push_string(output, &facts.run_id)?;
        push_string(output, &facts.node_id)?;
        push_string(output, &facts.node_execution_id)?;
        push_string(output, &facts.task_id)?;
        push_string(output, &facts.role_id)?;
        push_string(output, &facts.idempotency_key)?;
        push_string(output, &facts.message)?;
        output.extend_from_slice(&facts.requested_at.to_le_bytes());
        output.extend_from_slice(&facts.max_attempts.to_le_bytes());
        encode_delivery_phase(output, snapshot.phase())?;
        output.extend_from_slice(&snapshot.completed_attempts().to_le_bytes());
        output.extend_from_slice(&snapshot.next_claim_generation().to_le_bytes());
    }
    Ok(())
}

fn encode_delivery_phase(
    output: &mut Vec<u8>,
    phase: &DeliveryPhaseSnapshot,
) -> Result<(), StoreFault> {
    match phase {
        DeliveryPhaseSnapshot::Pending => output.push(0),
        DeliveryPhaseSnapshot::Delivering(claim) => {
            output.push(1);
            push_string(output, claim.delivery_id().as_str())?;
            output.extend_from_slice(&claim.attempt().to_le_bytes());
            output.extend_from_slice(&claim.generation().to_le_bytes());
            output.extend_from_slice(&claim.claimed_at().to_le_bytes());
        }
        DeliveryPhaseSnapshot::RetryScheduled { retry_at, failure } => {
            output.push(2);
            output.extend_from_slice(&retry_at.to_le_bytes());
            output.push(delivery_failure_tag(*failure));
        }
        DeliveryPhaseSnapshot::Delivered {
            receipt,
            accepted_at,
            matcha_correlation,
        } => {
            output.push(3);
            push_string(output, receipt.as_str())?;
            output.extend_from_slice(&accepted_at.to_le_bytes());
            match matcha_correlation {
                None => output.push(0),
                Some(correlation) => {
                    output.push(1);
                    push_string(output, correlation.external_session().as_str())?;
                    push_string(output, correlation.native_run_receipt().as_str())?;
                }
            }
        }
        DeliveryPhaseSnapshot::TerminalObserved { observation } => {
            output.push(7);
            encode_terminal_observation(output, observation)?;
        }
        DeliveryPhaseSnapshot::Failed { failed_at, failure } => {
            output.push(4);
            output.extend_from_slice(&failed_at.to_le_bytes());
            output.push(delivery_failure_tag(*failure));
        }
        DeliveryPhaseSnapshot::OutcomeUnknown { observed_at } => {
            output.push(5);
            output.extend_from_slice(&observed_at.to_le_bytes());
        }
        DeliveryPhaseSnapshot::Cancelled { cancelled_at } => {
            output.push(6);
            output.extend_from_slice(&cancelled_at.to_le_bytes());
        }
    }
    Ok(())
}

fn encode_terminal_observation(
    output: &mut Vec<u8>,
    observation: &TerminalObservationSnapshot,
) -> Result<(), StoreFault> {
    push_string(output, observation.delivery_id().as_str())?;
    push_string(output, observation.graph_run_id())?;
    push_string(output, observation.node_id())?;
    encode_fence(
        output,
        &DurableExecutionFence {
            attempt_id: observation.fence().attempt_id().as_str().to_owned(),
            node_execution_id: observation.fence().node_execution_id().as_str().to_owned(),
        },
    )?;
    push_string(output, observation.role_id())?;
    let correlation = observation.correlation();
    push_string(output, correlation.external_session().as_str())?;
    push_string(output, observation.delivered_receipt().as_str())?;
    push_string(output, correlation.native_run_receipt().as_str())?;
    output.push(native_terminal_tag(observation.native_terminal()));
    output.extend_from_slice(&observation.observed_at().to_le_bytes());
    encode_terminal_resolution(output, observation.resolution())
}

fn encode_activities(
    output: &mut Vec<u8>,
    ledger: &ActivityLedgerSnapshot,
) -> Result<(), StoreFault> {
    push_count(output, ledger.activities().len())?;
    for snapshot in ledger.activities() {
        let facts = snapshot.facts();
        push_string(output, facts.activity_id.as_str())?;
        push_string(output, facts.run_id.as_str())?;
        push_string(output, facts.node_id.as_str())?;
        push_string(output, facts.node_execution_id.as_str())?;
        encode_fence(
            output,
            &DurableExecutionFence {
                attempt_id: facts.fence.attempt_id().as_str().to_owned(),
                node_execution_id: facts.fence.node_execution_id().as_str().to_owned(),
            },
        )?;
        encode_activity_kind(output, &facts.activity_kind)?;
        push_string(output, facts.target.as_str())?;
        push_string(output, &facts.idempotency_key)?;
        output.extend_from_slice(&facts.created_at.to_le_bytes());
        output.extend_from_slice(&facts.max_attempts.to_le_bytes());
        encode_activity_phase(output, snapshot.phase())?;
        output.extend_from_slice(&snapshot.completed_attempts().to_le_bytes());
        output.extend_from_slice(&snapshot.next_claim_generation().to_le_bytes());
    }
    Ok(())
}

fn encode_activity_kind(output: &mut Vec<u8>, kind: &ActivityKind) -> Result<(), StoreFault> {
    match kind {
        ActivityKind::AgentTask {
            task_id,
            role_id,
            prompt,
        } => {
            output.push(0);
            push_string(output, task_id)?;
            push_string(output, role_id)?;
            push_string(output, prompt)?;
        }
        ActivityKind::Control { action } => {
            output.push(1);
            push_string(output, action)?;
        }
    }
    Ok(())
}

fn encode_activity_phase(
    output: &mut Vec<u8>,
    phase: &ActivityPhaseSnapshot,
) -> Result<(), StoreFault> {
    match phase {
        ActivityPhaseSnapshot::Pending => output.push(0),
        ActivityPhaseSnapshot::Claimed(claim) => {
            output.push(1);
            encode_activity_claim(output, claim)?;
        }
        ActivityPhaseSnapshot::Dispatched(dispatch) => {
            output.push(2);
            encode_activity_claim(output, dispatch.claim())?;
            output.extend_from_slice(&dispatch.dispatched_at().to_le_bytes());
        }
        ActivityPhaseSnapshot::RetryScheduled { retry_at, failure } => {
            output.push(8);
            output.extend_from_slice(&retry_at.to_le_bytes());
            output.push(activity_failure_tag(*failure));
        }
        ActivityPhaseSnapshot::TerminalObserved { observed_at } => {
            output.push(3);
            output.extend_from_slice(&observed_at.to_le_bytes());
        }
        ActivityPhaseSnapshot::Completed { completed_at } => {
            output.push(4);
            output.extend_from_slice(&completed_at.to_le_bytes());
        }
        ActivityPhaseSnapshot::Failed { failed_at, failure } => {
            output.push(5);
            output.extend_from_slice(&failed_at.to_le_bytes());
            output.push(activity_failure_tag(*failure));
        }
        ActivityPhaseSnapshot::OutcomeUnknown { observed_at } => {
            output.push(6);
            output.extend_from_slice(&observed_at.to_le_bytes());
        }
        ActivityPhaseSnapshot::Cancelled { cancelled_at } => {
            output.push(7);
            output.extend_from_slice(&cancelled_at.to_le_bytes());
        }
    }
    Ok(())
}

fn encode_activity_claim(
    output: &mut Vec<u8>,
    claim: &ActivityClaimSnapshot,
) -> Result<(), StoreFault> {
    push_string(output, claim.activity_id().as_str())?;
    output.extend_from_slice(&claim.attempt().to_le_bytes());
    output.extend_from_slice(&claim.generation().to_le_bytes());
    output.extend_from_slice(&claim.claimed_at().to_le_bytes());
    Ok(())
}

fn encode_triggers(output: &mut Vec<u8>, ledger: &crate::TriggerLedger) -> Result<(), StoreFault> {
    push_count(output, ledger.requests().count())?;
    for request in ledger.requests() {
        push_string(output, &request.run_id)?;
        push_string(output, &request.start_node_id)?;
        output.push(trigger_source_tag(request.source));
        push_string(output, &request.idempotency_key)?;
    }
    Ok(())
}

fn encode_control_resolutions<'a>(
    output: &mut Vec<u8>,
    resolutions: impl Iterator<Item = &'a ControlNodeResolution>,
) -> Result<(), StoreFault> {
    let resolutions = resolutions.collect::<Vec<_>>();
    push_count(output, resolutions.len())?;
    for resolution in resolutions {
        output.push(control_authority_tag(resolution.authority()));
        push_string(output, resolution.graph_run_id().as_str())?;
        push_string(output, resolution.node_id().as_str())?;
        encode_fence(
            output,
            &DurableExecutionFence {
                attempt_id: resolution.fence().attempt_id().as_str().to_owned(),
                node_execution_id: resolution.fence().node_execution_id().as_str().to_owned(),
            },
        )?;
        output.push(authorized_graph_outcome_tag(resolution.outcome()));
        push_string(output, resolution.output_port())?;
        match resolution.script_review_rule() {
            None => output.push(0),
            Some(rule) => output.push(script_review_rule_tag(rule)),
        }
        output.extend_from_slice(&resolution.resolved_at().to_le_bytes());
    }
    Ok(())
}

fn encode_approvals<'a>(
    output: &mut Vec<u8>,
    approvals: impl Iterator<Item = &'a crate::Approval>,
) -> Result<(), StoreFault> {
    let approvals = approvals
        .map(crate::Approval::durable_snapshot)
        .collect::<Vec<_>>();
    push_count(output, approvals.len())?;
    for approval in approvals {
        let facts = approval.facts;
        push_string(output, &facts.approval_id)?;
        push_string(output, &facts.run_id)?;
        push_string(output, &facts.stage_id)?;
        push_string(output, &facts.role_id)?;
        push_string(output, &facts.reason)?;
        push_string(output, &facts.requested_action)?;
        push_string(output, &facts.risk_summary)?;
        push_string(output, &facts.idempotency_key)?;
        output.extend_from_slice(&facts.requested_at.to_le_bytes());
        encode_approval_subject(output, &facts.subject)?;
        output.push(approval_origin_tag(facts.origin));
        output.push(approval_effect_tag(facts.effect));
        push_optional_string(output, facts.execution_fence.as_deref())?;
        output.push(approval_status_tag(approval.status));
        push_count(output, approval.resolutions.len())?;
        for resolution in approval.resolutions {
            output.push(approval_decision_tag(resolution.decision));
            push_optional_string(output, resolution.note.as_deref())?;
            output.extend_from_slice(&resolution.resolved_at.to_le_bytes());
            push_string(output, &resolution.idempotency_key)?;
            output.push(approval_resolution_cause_tag(resolution.cause));
        }
    }
    Ok(())
}

fn encode_approval_subject(
    output: &mut Vec<u8>,
    subject: &ApprovalSubject,
) -> Result<(), StoreFault> {
    match subject {
        ApprovalSubject::Stage { stage_id } => {
            output.push(0);
            push_string(output, stage_id)
        }
        ApprovalSubject::WorkNode { node_id } => {
            output.push(1);
            push_string(output, node_id)
        }
        ApprovalSubject::HumanDecision { node_id } => {
            output.push(2);
            push_string(output, node_id)
        }
    }
}

fn encode_evidence<'a>(
    output: &mut Vec<u8>,
    records: impl Iterator<Item = &'a EvidenceRecord>,
) -> Result<(), StoreFault> {
    let records = records.collect::<Vec<_>>();
    push_count(output, records.len())?;
    for record in records {
        push_string(output, record.evidence_id().as_str())?;
        push_string(output, record.run_id())?;
        push_string(output, record.node_execution_id())?;
        output.push(evidence_reference_kind_tag(record.reference().kind()));
        push_string(output, record.reference().reference())?;
        push_optional_string(output, record.reference().label())?;
        output.extend_from_slice(&record.recorded_at().to_le_bytes());
    }
    Ok(())
}

fn encode_artifacts<'a>(
    output: &mut Vec<u8>,
    records: impl Iterator<Item = &'a ArtifactRecord>,
) -> Result<(), StoreFault> {
    let records = records.collect::<Vec<_>>();
    push_count(output, records.len())?;
    for record in records {
        push_string(output, record.artifact_id().as_str())?;
        push_string(output, record.run_id())?;
        push_string(output, record.node_id())?;
        push_string(output, record.node_execution_id())?;
        push_string(output, record.fence().attempt_id().as_str())?;
        push_string(output, record.fence().node_execution_id().as_str())?;
        push_string(output, record.role_id())?;
        push_string(output, record.kind())?;
        push_string(output, record.title())?;
        push_string(output, record.content_ref())?;
        push_optional_string(output, record.summary())?;
        push_count(output, record.evidence().len())?;
        for evidence in record.evidence() {
            push_string(output, evidence.evidence_id())?;
            push_string(output, evidence.reference_kind())?;
        }
        push_string(output, record.source_envelope_id())?;
        push_string(output, record.idempotency_key())?;
        output.extend_from_slice(&record.created_at().to_le_bytes());
    }
    Ok(())
}

fn encode_decisions(
    output: &mut Vec<u8>,
    snapshot: &TeamDecisionLedgerSnapshot,
) -> Result<(), StoreFault> {
    push_count(output, snapshot.decisions().len())?;
    for decision in snapshot.decisions() {
        encode_decision_snapshot(output, decision)?;
    }
    push_count(output, snapshot.events().len())?;
    for event in snapshot.events() {
        push_string(output, event.event_id())?;
        push_string(output, event.run_id())?;
        output.extend_from_slice(&event.sequence().to_le_bytes());
        encode_decision_snapshot(output, event.decision())?;
    }
    Ok(())
}

fn encode_decision_snapshot(
    output: &mut Vec<u8>,
    decision: &TeamDecisionSnapshot,
) -> Result<(), StoreFault> {
    let command = decision.command().map_err(|_| StoreFault::InvalidFacts)?;
    output.extend_from_slice(&decision.sequence().to_le_bytes());
    push_string(output, command.decision_id())?;
    push_string(output, command.run_id())?;
    push_string(output, command.stage_id())?;
    output.push(match command.decision() {
        TeamDecisionType::Retry => 0,
        TeamDecisionType::ProceedDegraded => 1,
        TeamDecisionType::Abort => 2,
    });
    push_optional_string(output, command.note())?;
    push_string(output, command.idempotency_key())?;
    output.extend_from_slice(&command.created_at().to_le_bytes());
    Ok(())
}

fn encode_events(output: &mut Vec<u8>, snapshot: &EventLedgerSnapshot) -> Result<(), StoreFault> {
    push_count(output, snapshot.commands().len())?;
    for record in snapshot.commands() {
        output.extend_from_slice(&record.sequence().to_le_bytes());
        encode_run_command(output, record.command())?;
        output.push(command_status_tag(record.status()));
        match record.rejection_reason() {
            None => output.push(0),
            Some(rejection) => {
                output.push(1);
                output.push(command_rejection_tag(rejection));
            }
        }
    }
    push_count(output, snapshot.events().len())?;
    for event in snapshot.events() {
        push_string(output, event.event_id())?;
        push_string(output, event.run_id())?;
        output.extend_from_slice(&event.sequence().to_le_bytes());
        output.push(team_event_type_tag(event.event_type()));
        encode_team_event_payload(output, event.payload())?;
        push_string(output, event.causation_id())?;
        push_string(output, event.idempotency_key())?;
        output.extend_from_slice(&event.created_at().to_le_bytes());
    }
    Ok(())
}

fn encode_run_command(output: &mut Vec<u8>, command: &RunCommand) -> Result<(), StoreFault> {
    push_string(output, command.run_id().as_str())?;
    push_string(output, command.command_id().as_str())?;
    push_string(output, command.idempotency_key().as_str())?;
    encode_command_payload(output, command.payload())?;
    output.extend_from_slice(&command.created_at().to_le_bytes());
    Ok(())
}

fn encode_command_payload(
    output: &mut Vec<u8>,
    payload: &CommandPayload,
) -> Result<(), StoreFault> {
    match payload {
        CommandPayload::GraphPatch(patch) => {
            output.push(0);
            push_string(output, patch.base_graph_id())?;
            push_string(output, patch.base_workflow_plan_id())?;
            push_count(output, patch.operations().len())?;
            for operation in patch.operations() {
                encode_graph_patch_operation(output, operation)?;
            }
            Ok(())
        }
        CommandPayload::GraphReplace(definition) => {
            output.push(3);
            encode_graph_definition(output, definition)
        }
        CommandPayload::NodeProgress(progress) => {
            output.push(1);
            push_string(output, progress.node_execution_id().as_str())?;
            output.push(node_event_kind_tag(progress.event()));
            Ok(())
        }
        CommandPayload::ApprovalRequest(approval) => {
            output.push(2);
            push_string(output, approval.approval_id().as_str())?;
            push_string(output, approval.node_execution_id().as_str())?;
            push_string(output, approval.role_id().as_str())?;
            output.push(approval_action_tag(approval.action()));
            Ok(())
        }
    }
}

fn encode_graph_definition(
    output: &mut Vec<u8>,
    definition: &crate::GraphDefinition,
) -> Result<(), StoreFault> {
    push_string(output, definition.graph_id())?;
    push_string(output, definition.workflow_plan_id())?;
    push_string(output, definition.run_id().as_str())?;
    push_string(output, definition.title())?;
    push_count(output, definition.nodes().len())?;
    for node in definition.nodes() {
        push_string(output, node.id().as_str())?;
        output.push(node_kind_tag(node.kind()));
        push_string(output, node.title())?;
        output.extend_from_slice(&node.max_attempts().get().to_le_bytes());
        output.push(u8::from(node.is_control()));
        match node.trigger() {
            None => output.push(0),
            Some(StartTrigger::Webhook { path }) => {
                output.push(1);
                push_string(output, path)?;
            }
            Some(StartTrigger::Cron { expression }) => {
                output.push(2);
                push_string(output, expression)?;
            }
        }
        match node.work_assignment() {
            None => output.push(0),
            Some(work) => {
                output.push(1);
                push_string(output, work.task_id())?;
                push_string(output, work.prompt())?;
                push_string(output, work.role_id())?;
                push_optional_string(output, work.output_artifact_kind())?;
                push_optional_string(output, work.group_id().map(crate::GroupId::as_str))?;
            }
        }
        match node.review_assignment() {
            None => output.push(0),
            Some(review) => {
                output.push(1);
                push_string(output, review.role_id())?;
                push_string(output, review.prompt())?;
            }
        }
        match node.work_group() {
            None => output.push(0),
            Some(group) => {
                output.push(1);
                push_string(output, group.id().as_str())?;
                output.push(u8::from(group.join_policy().require_completed()));
                output.push(u8::from(group.join_policy().allow_failed()));
                output.extend_from_slice(&group.join_policy().retry_limit().to_le_bytes());
            }
        }
    }
    push_count(output, definition.edges().len())?;
    for edge in definition.edges() {
        push_string(output, edge.id().as_str())?;
        push_string(output, edge.source_node_id().as_str())?;
        push_string(output, edge.source_port())?;
        push_string(output, edge.target_node_id().as_str())?;
        push_string(output, edge.target_port())?;
        output.push(edge_action_tag(edge.action()));
        output.push(u8::from(edge.payload().include_upstream_result()));
        match edge.dependency() {
            None => output.push(0),
            Some(dependency) => {
                output.push(1);
                push_string(output, dependency.dependency_task_id())?;
                push_string(output, dependency.task_id())?;
            }
        }
    }
    Ok(())
}

fn encode_graph_patch_operation(
    output: &mut Vec<u8>,
    operation: &GraphPatchOperation,
) -> Result<(), StoreFault> {
    match operation {
        GraphPatchOperation::AddNode {
            node_id,
            kind,
            role_id,
        } => {
            output.push(0);
            encode_graph_node(output, node_id, *kind, role_id.as_ref())
        }
        GraphPatchOperation::ReplaceNode {
            node_id,
            kind,
            role_id,
        } => {
            output.push(1);
            encode_graph_node(output, node_id, *kind, role_id.as_ref())
        }
        GraphPatchOperation::RemoveNode { node_id } => {
            output.push(2);
            push_string(output, node_id.as_str())
        }
        GraphPatchOperation::AddEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action,
        } => {
            output.push(3);
            encode_graph_edge(output, edge_id, source_node_id, target_node_id, *action)
        }
        GraphPatchOperation::ReplaceEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action,
        } => {
            output.push(4);
            encode_graph_edge(output, edge_id, source_node_id, target_node_id, *action)
        }
        GraphPatchOperation::RemoveEdge { edge_id } => {
            output.push(5);
            push_string(output, edge_id.as_str())
        }
        GraphPatchOperation::SetMetadata { key, value } => {
            output.push(6);
            push_string(output, key.as_str())?;
            encode_metadata_value(output, value)
        }
    }
}

fn encode_graph_node(
    output: &mut Vec<u8>,
    node_id: &str,
    kind: GraphNodeKind,
    role_id: Option<&String>,
) -> Result<(), StoreFault> {
    push_string(output, node_id)?;
    output.push(graph_node_kind_tag(kind));
    push_optional_string(output, role_id.map(String::as_str))
}

fn encode_graph_edge(
    output: &mut Vec<u8>,
    edge_id: &str,
    source_node_id: &str,
    target_node_id: &str,
    action: GraphEdgeAction,
) -> Result<(), StoreFault> {
    push_string(output, edge_id)?;
    push_string(output, source_node_id)?;
    push_string(output, target_node_id)?;
    output.push(graph_edge_action_tag(action));
    Ok(())
}

fn encode_metadata_value(output: &mut Vec<u8>, value: &MetadataValue) -> Result<(), StoreFault> {
    match value {
        MetadataValue::Enabled(value) => {
            output.push(0);
            output.push(u8::from(*value));
        }
        MetadataValue::Revision(value) => {
            output.push(1);
            output.extend_from_slice(&value.to_le_bytes());
        }
        MetadataValue::OpaqueId(value) => {
            output.push(2);
            push_string(output, value.as_str())?;
        }
    }
    Ok(())
}

fn encode_team_event_payload(
    output: &mut Vec<u8>,
    payload: &TeamEventPayload,
) -> Result<(), StoreFault> {
    match payload {
        TeamEventPayload::GraphPatchAccepted {
            base_graph_id,
            base_workflow_plan_id,
            operation_count,
        } => {
            output.push(0);
            push_string(output, base_graph_id)?;
            push_string(output, base_workflow_plan_id)?;
            output.extend_from_slice(&operation_count.get().to_le_bytes());
        }
        TeamEventPayload::GraphReplaced {
            graph_id,
            workflow_plan_id,
        } => {
            output.push(4);
            push_string(output, graph_id)?;
            push_string(output, workflow_plan_id)?;
        }
        TeamEventPayload::NodeProgressed { node_execution_id } => {
            output.push(1);
            push_string(output, node_execution_id.as_str())?;
        }
        TeamEventPayload::ApprovalRequested {
            approval_id,
            node_execution_id,
            role_id,
            action,
        } => {
            output.push(2);
            push_string(output, approval_id.as_str())?;
            push_string(output, node_execution_id.as_str())?;
            push_string(output, role_id.as_str())?;
            output.push(approval_action_tag(*action));
        }
        TeamEventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } => {
            output.push(3);
            push_string(output, approval_id.as_str())?;
            output.push(approval_decision_tag(*decision));
            output.push(approval_status_tag(*status));
        }
    }
    Ok(())
}

fn encode_terminal_resolution(
    output: &mut Vec<u8>,
    resolution: &TerminalObservationResolution,
) -> Result<(), StoreFault> {
    match resolution {
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution => output.push(0),
        TerminalObservationResolution::NodeCancelled => output.push(1),
        TerminalObservationResolution::GraphResolved(resolution) => {
            output.push(2);
            push_string(output, resolution.receipt().as_str())?;
            push_string(output, resolution.delivery_id().as_str())?;
            push_string(output, resolution.graph_run_id())?;
            encode_fence(
                output,
                &DurableExecutionFence {
                    attempt_id: resolution.fence().attempt_id().as_str().to_owned(),
                    node_execution_id: resolution.fence().node_execution_id().as_str().to_owned(),
                },
            )?;
            output.push(authorized_graph_outcome_tag(resolution.outcome()));
            push_string(output, resolution.output_port())?;
            output.extend_from_slice(&resolution.resolved_at().to_le_bytes());
        }
    }
    Ok(())
}

fn encode_task_board(output: &mut Vec<u8>, board: &TaskBoardFacts) -> Result<(), StoreFault> {
    let tasks = board.tasks().collect::<Vec<_>>();
    push_count(output, tasks.len())?;
    for task in tasks {
        push_string(output, task.team_id().as_str())?;
        push_string(output, task.run_id().as_str())?;
        push_string(output, task.task_id().as_str())?;
        push_string(output, task.title())?;
        push_string(output, task.instruction())?;
        push_count(output, task.depends_on().len())?;
        for dependency in task.depends_on() {
            push_string(output, dependency.as_str())?;
        }
        output.push(task_status_tag(task.status()));
        push_optional_string(output, task.owner_agent_id())?;
        push_optional_string(output, task.claim_session())?;
        push_optional_u64(output, task.claimed_at());
        push_optional_u64(output, task.lease_until());
        output.extend_from_slice(&task.attempt().to_le_bytes());
        push_optional_string(output, task.result_summary())?;
        push_optional_string(output, task.error())?;
        output.extend_from_slice(&task.created_at().to_le_bytes());
        output.extend_from_slice(&task.updated_at().to_le_bytes());
        push_string(output, task.command_fingerprint())?;
    }
    let runners = board.runners().collect::<Vec<_>>();
    push_count(output, runners.len())?;
    for runner in runners {
        push_string(output, runner.team_id().as_str())?;
        push_string(output, runner.run_id().as_str())?;
        push_string(output, runner.runner_id())?;
        push_string(output, runner.session())?;
        output.push(runner_status_tag(runner.status()));
        output.extend_from_slice(&runner.updated_at().to_le_bytes());
    }
    let mailbox = board.mailbox().collect::<Vec<_>>();
    push_count(output, mailbox.len())?;
    for message in mailbox {
        push_string(output, message.team_id().as_str())?;
        push_string(output, message.run_id().as_str())?;
        push_string(output, message.msg_id())?;
        push_string(output, message.from_agent_id())?;
        push_string(output, message.to())?;
        push_optional_string(output, message.related_task_id().map(TaskId::as_str))?;
        push_optional_string(output, message.reply_to_msg_id())?;
        output.push(mailbox_kind_tag(message.kind()));
        push_string(output, message.content())?;
        output.extend_from_slice(&message.created_at().to_le_bytes());
    }
    Ok(())
}

fn push_optional_u64(output: &mut Vec<u8>, value: Option<u64>) {
    match value {
        Some(value) => {
            output.push(1);
            output.extend_from_slice(&value.to_le_bytes());
        }
        None => output.push(0),
    }
}

fn encode_lifecycle(output: &mut Vec<u8>, lifecycle: &GraphRunLifecycle) -> Result<(), StoreFault> {
    push_string(output, lifecycle.creation_idempotency_key())?;
    match lifecycle.state() {
        GraphRunLifecycleState::Active => output.push(0),
        GraphRunLifecycleState::Cancelling {
            idempotency_key,
            requested_at,
        } => {
            output.push(1);
            push_string(output, idempotency_key)?;
            output.extend_from_slice(&requested_at.to_le_bytes());
        }
        GraphRunLifecycleState::Cancelled {
            idempotency_key,
            cancelled_at,
        } => {
            output.push(2);
            push_string(output, idempotency_key)?;
            output.extend_from_slice(&cancelled_at.to_le_bytes());
        }
        GraphRunLifecycleState::OutcomeUnknown {
            idempotency_key,
            observed_at,
        } => {
            output.push(3);
            push_string(output, idempotency_key)?;
            output.extend_from_slice(&observed_at.to_le_bytes());
        }
        GraphRunLifecycleState::Tombstoned {
            idempotency_key,
            tombstoned_at,
        } => {
            output.push(4);
            push_string(output, idempotency_key)?;
            output.extend_from_slice(&tombstoned_at.to_le_bytes());
        }
    }
    Ok(())
}

fn push_optional_runtime(
    output: &mut Vec<u8>,
    runtime: Option<&RunRuntimeReceipt>,
) -> Result<(), StoreFault> {
    let Some(runtime) = runtime else {
        output.push(0);
        return Ok(());
    };
    output.push(1);
    push_string(output, runtime.team_run().as_str())?;
    push_count(output, runtime.bindings().len())?;
    for binding in runtime.bindings() {
        push_string(output, binding.team().as_str())?;
        push_string(output, binding.team_run().as_str())?;
        push_string(output, binding.role().as_str())?;
        push_string(output, binding.local_session().as_str())?;
        push_string(output, binding.external_session().as_str())?;
        push_string(output, binding.agent().as_str())?;
        push_string(output, binding.endpoint().as_str())?;
    }
    Ok(())
}

struct Reader<'a> {
    remaining: &'a [u8],
}

impl<'a> Reader<'a> {
    const fn new(content: &'a [u8]) -> Self {
        Self { remaining: content }
    }

    fn finish(self) -> Result<(), StoreFault> {
        self.remaining
            .is_empty()
            .then_some(())
            .ok_or(StoreFault::CorruptRecord)
    }

    fn team_definition(&mut self) -> Result<TeamDefinition, StoreFault> {
        let team_id = TeamId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
        let name = self.string()?;
        let members = (0..self.count()?)
            .map(|_| {
                let member_id =
                    MemberId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                TeamMember::try_new(member_id, self.string()?).map_err(|_| StoreFault::InvalidFacts)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let roles = (0..self.count()?)
            .map(|_| {
                let role_id =
                    RoleId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let name = self.string()?;
                let kind = match self.byte()? {
                    0 => RoleKind::Leader,
                    1 => RoleKind::Member,
                    _ => return Err(StoreFault::InvalidFacts),
                };
                TeamRole::try_new(role_id, name, kind).map_err(|_| StoreFault::InvalidFacts)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let assignments = (0..self.count()?)
            .map(|_| {
                Ok(RoleAssignment::new(
                    MemberId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?,
                    RoleId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        TeamDefinition::try_new(team_id, name, members, roles, assignments)
            .map_err(|_| StoreFault::InvalidFacts)
    }

    fn materialization_lifecycle(
        &mut self,
    ) -> Result<(TeamId, TeamMaterializationLifecycle), StoreFault> {
        let tag = self.byte()?;
        let lifecycle = match tag {
            0 => TeamMaterializationLifecycle::requested(self.materialization_request()?),
            1 => {
                let request = self.materialization_request()?;
                let rejection = self.materialization_rejection()?;
                TeamMaterializationLifecycle::Rejected { request, rejection }
            }
            2 => TeamMaterializationLifecycle::OutcomeUnknown(self.materialization_request()?),
            3 => TeamMaterializationLifecycle::Confirmed(self.materialization()?),
            4 => TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::None(
                self.materialization_request()?,
            )),
            5 => TeamMaterializationLifecycle::Tombstoned(
                TombstonedMaterialization::OutcomeUnknown(self.materialization_request()?),
            ),
            6 => {
                let receipt = self.materialization()?;
                let cleanup = self.materialization_cleanup()?;
                TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
                    receipt,
                    cleanup,
                })
            }
            _ => return Err(StoreFault::InvalidFacts),
        };
        let team = lifecycle.team().cloned().ok_or(StoreFault::InvalidFacts)?;
        Ok((team, lifecycle))
    }

    fn materialization_request(&mut self) -> Result<TeamMaterializationRequest, StoreFault> {
        let team = TeamId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
        let endpoint = RuntimeEndpointReference::try_new(self.string()?)
            .map_err(|_| StoreFault::InvalidFacts)?;
        let source = match self.byte()? {
            0 => MaterializationSource::Manual,
            1 => MaterializationSource::TeamSkill,
            _ => return Err(StoreFault::InvalidFacts),
        };
        let agents = (0..self.count()?)
            .map(|_| {
                let role = RoleId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let agent = match self.byte()? {
                    0 => RoleMaterializationAgent::Managed {
                        name: self.string()?,
                    },
                    1 => RoleMaterializationAgent::External {
                        agent: ManagedAgentReference::try_new(self.string()?)
                            .map_err(|_| StoreFault::InvalidFacts)?,
                    },
                    _ => return Err(StoreFault::InvalidFacts),
                };
                match agent {
                    RoleMaterializationAgent::Managed { name } => {
                        RoleAgentMaterialization::managed(role, name)
                            .map_err(|_| StoreFault::InvalidFacts)
                    }
                    RoleMaterializationAgent::External { agent } => {
                        Ok(RoleAgentMaterialization::external(role, agent))
                    }
                }
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let intent = TeamMaterializationIntent::try_new(team, endpoint, source, agents)
            .map_err(|_| StoreFault::InvalidFacts)?;
        let idempotency_key =
            IdempotencyKey::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
        Ok(TeamMaterializationRequest::new(intent, idempotency_key))
    }

    fn materialization_rejection(&mut self) -> Result<MaterializationRejection, StoreFault> {
        match self.byte()? {
            0 => Ok(MaterializationRejection::Permanent),
            1 => Ok(MaterializationRejection::Retryable),
            _ => Err(StoreFault::InvalidFacts),
        }
    }

    fn materialization_cleanup(&mut self) -> Result<TeamMaterializationCleanup, StoreFault> {
        match self.byte()? {
            0 => Ok(TeamMaterializationCleanup::Pending(
                self.materialization_removal()?,
            )),
            1 => {
                let removal = self.materialization_removal()?;
                let _legacy_rejection = self.materialization_rejection()?;
                // Historical records classified cleanup rejection as terminal. A rejected
                // cleanup cannot prove the native resource was untouched, so normalize it
                // to the current conservative state while retaining its removal intent.
                Ok(TeamMaterializationCleanup::OutcomeUnknown(removal))
            }
            2 => Ok(TeamMaterializationCleanup::OutcomeUnknown(
                self.materialization_removal()?,
            )),
            3 => Ok(TeamMaterializationCleanup::Confirmed(
                self.materialization_removal()?,
            )),
            _ => Err(StoreFault::InvalidFacts),
        }
    }

    fn materialization_removal(&mut self) -> Result<TeamMaterializationRemoval, StoreFault> {
        let receipt = self.materialization()?;
        let idempotency_key =
            IdempotencyKey::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
        Ok(TeamMaterializationRemoval::new(receipt, idempotency_key))
    }

    fn materialization(&mut self) -> Result<MaterializationReceipt, StoreFault> {
        let team = TeamId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
        let endpoint = RuntimeEndpointReference::try_new(self.string()?)
            .map_err(|_| StoreFault::InvalidFacts)?;
        let roles = (0..self.count()?)
            .map(|_| {
                let role = RoleId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let agent = ManagedAgentReference::try_new(self.string()?)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let ownership = match self.byte()? {
                    0 => crate::RoleMaterializationOwnership::Managed,
                    1 => crate::RoleMaterializationOwnership::External,
                    _ => return Err(StoreFault::InvalidFacts),
                };
                let endpoint = RuntimeEndpointReference::try_new(self.string()?)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                Ok(match self.optional_string()? {
                    Some(workspace) => RoleMaterializationReceipt::with_native_workspace(
                        role,
                        agent,
                        ownership,
                        endpoint,
                        crate::ports::materialization::NativeWorkspaceReceipt::try_new(workspace)
                            .map_err(|_| StoreFault::InvalidFacts)?,
                    ),
                    None => {
                        RoleMaterializationReceipt::with_ownership(role, agent, ownership, endpoint)
                    }
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        MaterializationReceipt::try_new(team, endpoint, roles).map_err(|_| StoreFault::InvalidFacts)
    }

    fn workflow_plan(&mut self) -> Result<crate::run::WorkflowPlan, StoreFault> {
        let workflow_plan_id = self.string()?;
        let run_id = self.string()?;
        let title = self.string()?;
        let status = self.string()?;
        let groups = (0..self.count()?)
            .map(|_| {
                let group_id = self.string()?;
                let title = self.string()?;
                let task_ids = (0..self.count()?)
                    .map(|_| self.string())
                    .collect::<Result<Vec<_>, StoreFault>>()?;
                let join =
                    crate::run::WorkflowJoinPolicy::new(self.bool()?, self.bool()?, self.u32()?);
                Ok(crate::run::WorkflowGroup::new(
                    group_id, title, task_ids, join,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let tasks = (0..self.count()?)
            .map(|_| {
                let task_id = self.string()?;
                let role_id = self.string()?;
                let title = self.string()?;
                let prompt = self.string()?;
                let depends_on_task_ids = (0..self.count()?)
                    .map(|_| self.string())
                    .collect::<Result<Vec<_>, StoreFault>>()?;
                let output_artifact_kind = self.optional_string()?;
                Ok(crate::run::WorkflowTask::new(
                    task_id,
                    role_id,
                    title,
                    prompt,
                    depends_on_task_ids,
                    output_artifact_kind,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(crate::run::WorkflowPlan::new(
            workflow_plan_id,
            run_id,
            title,
            status,
            groups,
            tasks,
            self.string()?,
            self.u64()?,
        ))
    }

    fn graph(&mut self) -> Result<GraphDurableSnapshot, StoreFault> {
        let graph_id = self.string()?;
        let workflow_plan_id = self.string()?;
        let run_id = self.string()?;
        let title = self.string()?;
        let metadata =
            (0..self.count()?).try_fold(std::collections::BTreeMap::new(), |mut metadata, _| {
                let key = self.opaque_id()?;
                let value = self.metadata_value()?;
                if metadata.insert(key, value).is_some() {
                    return Err(StoreFault::CorruptRecord);
                }
                Ok(metadata)
            })?;
        let nodes = (0..self.count()?)
            .map(|_| {
                let order = self.u32()?;
                let id = self.string()?;
                let kind = self.node_kind()?;
                let title = self.string()?;
                let max_attempts = self.u32()?;
                let is_control = self.bool()?;
                let trigger = match self.byte()? {
                    0 => None,
                    1 => Some(DurableStartTrigger::Webhook {
                        path: self.string()?,
                    }),
                    2 => Some(DurableStartTrigger::Cron {
                        expression: self.string()?,
                    }),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let work = match self.byte()? {
                    0 => None,
                    1 => Some(DurableWorkAssignment {
                        task_id: self.string()?,
                        prompt: self.string()?,
                        role_id: self.string()?,
                        output_artifact_kind: self.optional_string()?,
                        group_id: self.optional_string()?,
                    }),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let review = match self.byte()? {
                    0 => None,
                    1 => Some(DurableReviewAssignment {
                        role_id: self.string()?,
                        prompt: self.string()?,
                    }),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let group = match self.byte()? {
                    0 => None,
                    1 => Some(DurableWorkGroup {
                        group_id: self.string()?,
                        require_completed: self.bool()?,
                        allow_failed: self.bool()?,
                        retry_limit: self.u32()?,
                    }),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let valid_payload = match (kind, is_control) {
                    (crate::NodeKind::Start, false) => {
                        work.is_none() && review.is_none() && group.is_none()
                    }
                    (crate::NodeKind::Work, false) => {
                        trigger.is_none() && work.is_some() && review.is_none() && group.is_none()
                    }
                    (crate::NodeKind::Review, false) => {
                        trigger.is_none() && work.is_none() && review.is_some() && group.is_none()
                    }
                    (crate::NodeKind::Join, false) => {
                        trigger.is_none() && work.is_none() && review.is_none() && group.is_some()
                    }
                    (
                        crate::NodeKind::Start
                        | crate::NodeKind::Review
                        | crate::NodeKind::HumanDecision
                        | crate::NodeKind::ScriptReview
                        | crate::NodeKind::Join
                        | crate::NodeKind::End,
                        true,
                    ) => trigger.is_none() && work.is_none() && review.is_none() && group.is_none(),
                    _ => false,
                };
                if !valid_payload {
                    return Err(StoreFault::InvalidFacts);
                }
                Ok(DurableNodeDefinition {
                    order,
                    id,
                    kind,
                    title,
                    max_attempts,
                    is_control,
                    trigger,
                    work,
                    review,
                    group,
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let edges = (0..self.count()?)
            .map(|_| {
                Ok(DurableEdgeDefinition {
                    order: self.u32()?,
                    id: self.string()?,
                    source_node_id: self.string()?,
                    source_port: self.string()?,
                    target_node_id: self.string()?,
                    target_port: self.string()?,
                    action: self.edge_action()?,
                    include_upstream_result: self.bool()?,
                    dependency: match self.byte()? {
                        0 => None,
                        1 => Some(DurableDependencyMetadata {
                            dependency_task_id: self.string()?,
                            task_id: self.string()?,
                        }),
                        _ => return Err(StoreFault::CorruptRecord),
                    },
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let executions = (0..self.count()?)
            .map(|_| {
                let node_id = self.string()?;
                let attempts = (0..self.count()?)
                    .map(|_| self.attempt())
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(DurableNodeExecution { node_id, attempts })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let ready_queue = (0..self.count()?)
            .map(|_| {
                Ok(DurableReadyQueueItem {
                    node_id: self.string()?,
                    fence: self.fence()?,
                    enqueued_at: self.u64()?,
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(GraphDurableSnapshot {
            graph_id,
            workflow_plan_id,
            run_id,
            title,
            metadata,
            nodes,
            edges,
            executions,
            ready_queue,
        })
    }

    fn attempt(&mut self) -> Result<DurableNodeAttempt, StoreFault> {
        let fence = self.fence()?;
        let number = self.u32()?;
        let node_id = self.string()?;
        let node_kind = self.node_kind()?;
        let status = self.attempt_status()?;
        let reason = match self.byte()? {
            0 => DurableAttemptReason::Initial,
            1 => DurableAttemptReason::Trigger,
            2 => DurableAttemptReason::Edge {
                edge_id: self.string()?,
            },
            3 => DurableAttemptReason::Rework,
            _ => return Err(StoreFault::CorruptRecord),
        };
        let inputs = (0..self.count()?)
            .map(|_| {
                Ok(DurableInputReceipt {
                    edge_id: self.string()?,
                    action: self.edge_action()?,
                    source_node_id: self.string()?,
                    source_port: self.string()?,
                    target_port: self.string()?,
                    source_fence: self.fence()?,
                    arrived_at: self.u64()?,
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(DurableNodeAttempt {
            fence,
            number,
            node_id,
            node_kind,
            status,
            reason,
            inputs,
            output_port: self.optional_string()?,
            created_at: self.u64()?,
            updated_at: self.u64()?,
        })
    }

    fn fence(&mut self) -> Result<DurableExecutionFence, StoreFault> {
        Ok(DurableExecutionFence {
            attempt_id: self.string()?,
            node_execution_id: self.string()?,
        })
    }

    fn deliveries(&mut self) -> Result<DeliveryLedgerSnapshot, StoreFault> {
        let snapshots = (0..self.count()?)
            .map(|_| {
                let facts = DeliveryRequest {
                    delivery_id: DeliveryId::new(self.string()?)
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    team_id: self.string()?,
                    run_id: self.string()?,
                    node_id: self.string()?,
                    node_execution_id: self.string()?,
                    task_id: self.string()?,
                    role_id: self.string()?,
                    idempotency_key: self.string()?,
                    message: self.string()?,
                    requested_at: self.u64()?,
                    max_attempts: self.u32()?,
                };
                let phase = self.delivery_phase()?;
                let completed_attempts = self.u32()?;
                let next_claim_generation = self.u64()?;
                Ok(DeliverySnapshot::new(
                    facts,
                    phase,
                    completed_attempts,
                    next_claim_generation,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(DeliveryLedgerSnapshot::new(snapshots))
    }

    fn delivery_phase(&mut self) -> Result<DeliveryPhaseSnapshot, StoreFault> {
        match self.byte()? {
            0 => Ok(DeliveryPhaseSnapshot::Pending),
            1 => Ok(DeliveryPhaseSnapshot::Delivering(
                DeliveryClaimSnapshot::new(
                    DeliveryId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?,
                    self.u32()?,
                    self.u64()?,
                    self.u64()?,
                ),
            )),
            2 => Ok(DeliveryPhaseSnapshot::RetryScheduled {
                retry_at: self.u64()?,
                failure: self.delivery_failure()?,
            }),
            3 => {
                let receipt = crate::DeliveryReceiptReference::try_new(self.string()?)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let accepted_at = self.u64()?;
                let matcha_correlation = match self.byte()? {
                    0 => None,
                    1 => Some(MatchaDeliveryCorrelation::new(
                        crate::ExternalSessionReference::try_new(self.string()?)
                            .map_err(|_| StoreFault::InvalidFacts)?,
                        NativeRunReceiptReference::try_new(self.string()?)
                            .map_err(|_| StoreFault::InvalidFacts)?,
                    )),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                Ok(DeliveryPhaseSnapshot::Delivered {
                    receipt,
                    accepted_at,
                    matcha_correlation,
                })
            }
            4 => Ok(DeliveryPhaseSnapshot::Failed {
                failed_at: self.u64()?,
                failure: self.delivery_failure()?,
            }),
            5 => Ok(DeliveryPhaseSnapshot::OutcomeUnknown {
                observed_at: self.u64()?,
            }),
            6 => Ok(DeliveryPhaseSnapshot::Cancelled {
                cancelled_at: self.u64()?,
            }),
            7 => Ok(DeliveryPhaseSnapshot::TerminalObserved {
                observation: self.terminal_observation()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn activities(&mut self) -> Result<ActivityLedgerSnapshot, StoreFault> {
        let snapshots = (0..self.count()?)
            .map(|_| {
                let activity_id =
                    ActivityId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let run_id = GraphRunId::new(self.string()?);
                let node_id = NodeId::new(self.string()?);
                let node_execution_id = crate::NodeExecutionId::from_durable(self.string()?);
                let fence = self.fence()?;
                let facts = ActivityRequest {
                    activity_id,
                    run_id,
                    node_id,
                    node_execution_id,
                    fence: ExecutionFence::from_durable(fence.attempt_id, fence.node_execution_id),
                    activity_kind: self.activity_kind()?,
                    target: ActivityTarget::new(self.string()?)
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    idempotency_key: self.string()?,
                    created_at: self.u64()?,
                    max_attempts: self.u32()?,
                };
                let phase = self.activity_phase()?;
                let completed_attempts = self.u32()?;
                let next_claim_generation = self.u64()?;
                Ok(ActivitySnapshot::new(
                    facts,
                    phase,
                    completed_attempts,
                    next_claim_generation,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(ActivityLedgerSnapshot::new(snapshots))
    }

    fn activity_kind(&mut self) -> Result<ActivityKind, StoreFault> {
        match self.byte()? {
            0 => Ok(ActivityKind::AgentTask {
                task_id: self.string()?,
                role_id: self.string()?,
                prompt: self.string()?,
            }),
            1 => Ok(ActivityKind::Control {
                action: self.string()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn activity_phase(&mut self) -> Result<ActivityPhaseSnapshot, StoreFault> {
        match self.byte()? {
            0 => Ok(ActivityPhaseSnapshot::Pending),
            1 => Ok(ActivityPhaseSnapshot::Claimed(self.activity_claim()?)),
            2 => Ok(ActivityPhaseSnapshot::Dispatched(
                ActivityDispatchSnapshot::new(self.activity_claim()?, self.u64()?),
            )),
            8 => Ok(ActivityPhaseSnapshot::RetryScheduled {
                retry_at: self.u64()?,
                failure: self.activity_failure()?,
            }),
            3 => Ok(ActivityPhaseSnapshot::TerminalObserved {
                observed_at: self.u64()?,
            }),
            4 => Ok(ActivityPhaseSnapshot::Completed {
                completed_at: self.u64()?,
            }),
            5 => Ok(ActivityPhaseSnapshot::Failed {
                failed_at: self.u64()?,
                failure: self.activity_failure()?,
            }),
            6 => Ok(ActivityPhaseSnapshot::OutcomeUnknown {
                observed_at: self.u64()?,
            }),
            7 => Ok(ActivityPhaseSnapshot::Cancelled {
                cancelled_at: self.u64()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn activity_claim(&mut self) -> Result<ActivityClaimSnapshot, StoreFault> {
        Ok(ActivityClaimSnapshot::new(
            ActivityId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?,
            self.u32()?,
            self.u64()?,
            self.u64()?,
        ))
    }

    fn activity_failure(&mut self) -> Result<ActivityFailure, StoreFault> {
        match self.byte()? {
            0 => Ok(ActivityFailure::Rejected),
            1 => Ok(ActivityFailure::Unavailable),
            2 => Ok(ActivityFailure::TimedOut),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn terminal_observation(&mut self) -> Result<TerminalObservationSnapshot, StoreFault> {
        let delivery_id = DeliveryId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
        let graph_run_id = self.string()?;
        let node_id = self.string()?;
        let fence = self.fence()?;
        let role_id = self.string()?;
        let external_session = crate::ExternalSessionReference::try_new(self.string()?)
            .map_err(|_| StoreFault::InvalidFacts)?;
        let delivered_receipt = crate::DeliveryReceiptReference::try_new(self.string()?)
            .map_err(|_| StoreFault::InvalidFacts)?;
        let correlation = MatchaDeliveryCorrelation::new(
            external_session,
            NativeRunReceiptReference::try_new(self.string()?)
                .map_err(|_| StoreFault::InvalidFacts)?,
        );
        let native_terminal = self.native_terminal()?;
        let observed_at = self.u64()?;
        let resolution = self.terminal_resolution()?;
        Ok(TerminalObservationSnapshot::new(
            TerminalObservationSnapshotInput {
                delivery_id,
                graph_run_id,
                node_id,
                fence: ExecutionFence::from_durable(fence.attempt_id, fence.node_execution_id),
                role_id,
                correlation,
                delivered_receipt,
                native_terminal,
                observed_at,
                resolution,
            },
        ))
    }

    fn task_board(&mut self) -> Result<TaskBoardFacts, StoreFault> {
        let tasks = (0..self.count()?)
            .map(|_| {
                let team_id =
                    TeamId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let run_id = GraphRunId::new(self.string()?);
                let task_id =
                    TaskId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let title = self.string()?;
                let instruction = self.string()?;
                let depends_on = (0..self.count()?)
                    .map(|_| TaskId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts))
                    .collect::<Result<Vec<_>, _>>()?;
                let status = self.task_status()?;
                let owner_agent_id = self.optional_string()?;
                let claim_session = self.optional_string()?;
                let claimed_at = self.optional_u64()?;
                let lease_until = self.optional_u64()?;
                let attempt = self.u32()?;
                let result_summary = self.optional_string()?;
                let error = self.optional_string()?;
                let created_at = self.u64()?;
                let updated_at = self.u64()?;
                let command_fingerprint = self.string()?;
                TaskRecord::restore(TaskRestoreInput {
                    team_id,
                    run_id,
                    task_id,
                    title,
                    instruction,
                    depends_on,
                    status,
                    owner_agent_id,
                    claim_session,
                    claimed_at,
                    lease_until,
                    attempt,
                    result_summary,
                    error,
                    created_at,
                    updated_at,
                    command_fingerprint,
                })
                .map_err(|_| StoreFault::InvalidFacts)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let runners = (0..self.count()?)
            .map(|_| {
                let team_id =
                    TeamId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let run_id = GraphRunId::new(self.string()?);
                let runner_id = self.string()?;
                let session = self.string()?;
                let status = self.runner_status()?;
                let updated_at = self.u64()?;
                let mut runner =
                    AutoRunnerFacts::new(team_id, run_id, runner_id, session, updated_at)
                        .map_err(|_| StoreFault::InvalidFacts)?;
                runner.set_status(status, updated_at);
                Ok(runner)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let mailbox = (0..self.count()?)
            .map(|_| {
                MailboxMessage::new(
                    TeamId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?,
                    GraphRunId::new(self.string()?),
                    self.string()?,
                    self.string()?,
                    self.string()?,
                    self.optional_string()?.map(TaskId::new),
                    self.optional_string()?,
                    self.mailbox_kind()?,
                    self.string()?,
                    self.u64()?,
                )
                .map_err(|_| StoreFault::InvalidFacts)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        TaskBoardFacts::restore(tasks, runners, mailbox).map_err(|_| StoreFault::InvalidFacts)
    }

    fn optional_u64(&mut self) -> Result<Option<u64>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(self.u64()?)),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn task_status(&mut self) -> Result<TaskStatus, StoreFault> {
        match self.byte()? {
            0 => Ok(TaskStatus::Todo),
            1 => Ok(TaskStatus::Claimed),
            2 => Ok(TaskStatus::Running),
            3 => Ok(TaskStatus::Blocked),
            4 => Ok(TaskStatus::Done),
            5 => Ok(TaskStatus::Failed),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn runner_status(&mut self) -> Result<RunnerStatus, StoreFault> {
        match self.byte()? {
            0 => Ok(RunnerStatus::Active),
            1 => Ok(RunnerStatus::Paused),
            2 => Ok(RunnerStatus::Closed),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn mailbox_kind(&mut self) -> Result<MailboxKind, StoreFault> {
        match self.byte()? {
            0 => Ok(MailboxKind::Question),
            1 => Ok(MailboxKind::Proposal),
            2 => Ok(MailboxKind::Decision),
            3 => Ok(MailboxKind::Report),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn lifecycle(&mut self) -> Result<GraphRunLifecycle, StoreFault> {
        let creation_idempotency_key = self.string()?;
        let state = match self.byte()? {
            0 => GraphRunLifecycleState::Active,
            1 => GraphRunLifecycleState::Cancelling {
                idempotency_key: self.string()?,
                requested_at: self.u64()?,
            },
            2 => GraphRunLifecycleState::Cancelled {
                idempotency_key: self.string()?,
                cancelled_at: self.u64()?,
            },
            3 => GraphRunLifecycleState::OutcomeUnknown {
                idempotency_key: self.string()?,
                observed_at: self.u64()?,
            },
            4 => GraphRunLifecycleState::Tombstoned {
                idempotency_key: self.string()?,
                tombstoned_at: self.u64()?,
            },
            _ => return Err(StoreFault::InvalidFacts),
        };
        GraphRunLifecycle::restore(creation_idempotency_key, state)
            .map_err(|_| StoreFault::InvalidFacts)
    }

    fn optional_runtime(&mut self) -> Result<Option<RunRuntimeReceipt>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => {
                let team_run = GraphRunId::new(self.string()?);
                let bindings = (0..self.count()?)
                    .map(|_| {
                        Ok(RoleSessionReceipt::new(
                            TeamId::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                            GraphRunId::new(self.string()?),
                            RoleId::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                            LocalSessionReference::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                            crate::ExternalSessionReference::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                            ManagedAgentReference::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                            RuntimeEndpointReference::try_new(self.string()?)
                                .map_err(|_| StoreFault::InvalidFacts)?,
                        ))
                    })
                    .collect::<Result<Vec<_>, StoreFault>>()?;
                RunRuntimeReceipt::try_new(team_run, bindings)
                    .map(Some)
                    .map_err(|_| StoreFault::InvalidFacts)
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn triggers(&mut self) -> Result<Vec<TriggerFireRequest>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                TriggerFireRequest::try_new(
                    self.string()?,
                    self.string()?,
                    self.trigger_source()?,
                    self.string()?,
                )
                .map_err(|_| StoreFault::InvalidFacts)
            })
            .collect()
    }

    fn control_resolutions(&mut self) -> Result<Vec<ControlNodeResolution>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let authority = self.control_authority()?;
                let graph_run_id = GraphRunId::new(self.string()?);
                let node_id = crate::NodeId::new(self.string()?);
                let fence = self.fence()?;
                let outcome = self.authorized_graph_outcome()?;
                let output_port = self.string()?;
                let script_review_rule = self.optional_script_review_rule()?;
                let resolved_at = self.u64()?;
                ControlNodeResolution::from_durable(ControlNodeResolutionInput {
                    authority,
                    graph_run_id,
                    node_id,
                    fence: ExecutionFence::from_durable(fence.attempt_id, fence.node_execution_id),
                    outcome,
                    output_port,
                    script_review_rule,
                    resolved_at,
                })
                .map_err(|_| StoreFault::InvalidFacts)
            })
            .collect()
    }

    fn approvals(&mut self) -> Result<Vec<ApprovalDurableSnapshot>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let facts = ApprovalRequest {
                    approval_id: self.string()?,
                    run_id: self.string()?,
                    stage_id: self.string()?,
                    role_id: self.string()?,
                    reason: self.string()?,
                    requested_action: self.string()?,
                    risk_summary: self.string()?,
                    idempotency_key: self.string()?,
                    requested_at: self.u64()?,
                    subject: self.approval_subject()?,
                    origin: self.approval_origin()?,
                    effect: self.approval_effect()?,
                    execution_fence: self.optional_string()?,
                };
                let status = self.approval_status()?;
                let resolutions = (0..self.count()?)
                    .map(|_| {
                        Ok(ApprovalResolution {
                            decision: self.approval_decision()?,
                            note: self.optional_string()?,
                            resolved_at: self.u64()?,
                            idempotency_key: self.string()?,
                            cause: self.approval_resolution_cause()?,
                        })
                    })
                    .collect::<Result<Vec<_>, StoreFault>>()?;
                Ok(ApprovalDurableSnapshot {
                    facts,
                    status,
                    resolutions,
                })
            })
            .collect()
    }

    fn evidence(&mut self) -> Result<Vec<EvidenceRecord>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let evidence_id =
                    EvidenceId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let run_id = self.string()?;
                let node_execution_id = self.string()?;
                let reference = EvidenceReference::opaque(
                    self.evidence_reference_kind()?,
                    self.string()?,
                    self.optional_string()?,
                )
                .map_err(|_| StoreFault::InvalidFacts)?;
                EvidenceRecord::new(
                    evidence_id,
                    run_id,
                    node_execution_id,
                    reference,
                    self.u64()?,
                )
                .map_err(|_| StoreFault::InvalidFacts)
            })
            .collect()
    }

    fn artifacts(&mut self) -> Result<Vec<ArtifactRecord>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let artifact_id =
                    ArtifactId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let run_id = self.string()?;
                let node_id = self.string()?;
                let node_execution_id = self.string()?;
                let fence = ExecutionFence::from_durable(self.string()?, self.string()?);
                let role_id = self.string()?;
                let kind = self.string()?;
                let title = self.string()?;
                let content_ref = self.string()?;
                let summary = self.optional_string()?;
                let evidence = (0..self.count()?)
                    .map(|_| {
                        ArtifactEvidenceProvenance::new(self.string()?, self.string()?)
                            .map_err(|_| StoreFault::InvalidFacts)
                    })
                    .collect::<Result<Vec<_>, StoreFault>>()?;
                let source_envelope_id = self.string()?;
                let idempotency_key = self.string()?;
                let created_at = self.u64()?;
                ArtifactRecord::new(
                    artifact_id,
                    run_id,
                    node_id,
                    node_execution_id,
                    fence,
                    role_id,
                    kind,
                    title,
                    content_ref,
                    summary,
                    evidence,
                    source_envelope_id,
                    idempotency_key,
                    created_at,
                )
                .map_err(|_| StoreFault::InvalidFacts)
            })
            .collect()
    }

    fn decisions(&mut self) -> Result<TeamDecisionLedgerSnapshot, StoreFault> {
        let decisions = (0..self.count()?)
            .map(|_| self.decision_snapshot())
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let events = (0..self.count()?)
            .map(|_| {
                Ok(TeamDecisionEventSnapshot::from_durable(
                    self.string()?,
                    self.string()?,
                    self.u64()?,
                    self.decision_snapshot()?,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(TeamDecisionLedgerSnapshot::from_durable(decisions, events))
    }

    fn decision_snapshot(&mut self) -> Result<TeamDecisionSnapshot, StoreFault> {
        let sequence = self.u64()?;
        let command = TeamDecisionCommand::try_new(
            self.string()?,
            self.string()?,
            self.string()?,
            match self.byte()? {
                0 => TeamDecisionType::Retry,
                1 => TeamDecisionType::ProceedDegraded,
                2 => TeamDecisionType::Abort,
                _ => return Err(StoreFault::CorruptRecord),
            },
            self.optional_string()?,
            self.string()?,
            self.u64()?,
        )
        .map_err(|_| StoreFault::InvalidFacts)?;
        Ok(TeamDecisionSnapshot::from_durable(sequence, command))
    }

    fn events(&mut self) -> Result<EventLedgerSnapshot, StoreFault> {
        let commands = (0..self.count()?)
            .map(|_| {
                let sequence = NonZeroU64::new(self.u64()?).ok_or(StoreFault::CorruptRecord)?;
                let command = self.run_command()?;
                let status = self.command_status()?;
                let rejection = match self.byte()? {
                    0 => None,
                    1 => Some(self.command_rejection()?),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                CommandRecord::from_durable(sequence, command, status, rejection)
                    .ok_or(StoreFault::CorruptRecord)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let events = (0..self.count()?)
            .map(|_| {
                let event_id = self.opaque_id()?;
                let run_id = self.opaque_id()?;
                let sequence = NonZeroU64::new(self.u64()?).ok_or(StoreFault::CorruptRecord)?;
                let event_type = self.team_event_type()?;
                let payload = self.team_event_payload()?;
                let causation_id = self.opaque_id()?;
                let idempotency_key = self.opaque_id()?;
                let created_at = self.u64()?;
                Ok(TeamEvent::from_durable(TeamEventDurableInput {
                    event_id,
                    run_id,
                    sequence,
                    event_type,
                    payload,
                    causation_id,
                    idempotency_key,
                    created_at,
                }))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(EventLedgerSnapshot::from_durable(commands, events))
    }

    fn run_command(&mut self) -> Result<RunCommand, StoreFault> {
        Ok(RunCommand::new(
            self.opaque_id()?,
            self.opaque_id()?,
            self.opaque_id()?,
            self.command_payload()?,
            self.u64()?,
        ))
    }

    fn command_payload(&mut self) -> Result<CommandPayload, StoreFault> {
        match self.byte()? {
            0 => {
                let graph_id = self.string()?;
                let workflow_plan_id = self.string()?;
                let operations = (0..self.count()?)
                    .map(|_| self.graph_patch_operation())
                    .collect::<Result<Vec<_>, _>>()?;
                GraphPatch::try_new(graph_id, workflow_plan_id, operations)
                    .map(CommandPayload::GraphPatch)
                    .map_err(|_| StoreFault::InvalidFacts)
            }
            1 => Ok(CommandPayload::NodeProgress(
                NodeProgressCommand::with_event(self.opaque_id()?, self.node_event_kind()?),
            )),
            3 => self.graph_definition().map(CommandPayload::GraphReplace),
            2 => Ok(CommandPayload::ApprovalRequest(ApprovalCommand::new(
                self.opaque_id()?,
                self.opaque_id()?,
                self.opaque_id()?,
                self.approval_action()?,
            ))),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn graph_definition(&mut self) -> Result<crate::GraphDefinition, StoreFault> {
        let graph_id = self.string()?;
        let workflow_plan_id = self.string()?;
        let run_id = GraphRunId::new(self.string()?);
        let title = self.string()?;
        let nodes = (0..self.count()?)
            .map(|_| {
                let id = NodeId::new(self.string()?);
                let kind = self.node_kind()?;
                let title = self.string()?;
                let max_attempts = NonZeroU32::new(self.u32()?).ok_or(StoreFault::InvalidFacts)?;
                let is_control = self.bool()?;
                let trigger = match self.byte()? {
                    0 => None,
                    1 => Some(StartTrigger::Webhook {
                        path: self.string()?,
                    }),
                    2 => Some(StartTrigger::Cron {
                        expression: self.string()?,
                    }),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let work = match self.byte()? {
                    0 => None,
                    1 => Some(WorkAssignment::typed(
                        self.string()?,
                        self.string()?,
                        crate::ExecutorPolicy::team_role(self.string()?),
                        self.optional_string()?,
                        self.optional_string()?.map(crate::GroupId::new),
                    )),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let review = match self.byte()? {
                    0 => None,
                    1 => Some(crate::ReviewAssignment::new(self.string()?, self.string()?)),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let group = match self.byte()? {
                    0 => None,
                    1 => Some(crate::WorkGroup::new(
                        crate::GroupId::new(self.string()?),
                        crate::JoinPolicy::new(self.bool()?, self.bool()?, self.u32()?),
                    )),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let node = match (kind, is_control) {
                    (NodeKind::Start, false)
                        if work.is_none() && review.is_none() && group.is_none() =>
                    {
                        NodeDefinition::start(id, title, max_attempts, trigger)
                    }
                    (NodeKind::Work, false)
                        if trigger.is_none() && review.is_none() && group.is_none() =>
                    {
                        NodeDefinition::work(
                            id,
                            title,
                            max_attempts,
                            work.ok_or(StoreFault::InvalidFacts)?,
                        )
                    }
                    (NodeKind::Review, false)
                        if trigger.is_none() && work.is_none() && group.is_none() =>
                    {
                        NodeDefinition::review(
                            id,
                            title,
                            max_attempts,
                            review.ok_or(StoreFault::InvalidFacts)?,
                        )
                    }
                    (NodeKind::Join, false)
                        if trigger.is_none() && work.is_none() && review.is_none() =>
                    {
                        NodeDefinition::join(
                            id,
                            title,
                            max_attempts,
                            group.ok_or(StoreFault::InvalidFacts)?,
                        )
                    }
                    (
                        NodeKind::Start
                        | NodeKind::Review
                        | NodeKind::HumanDecision
                        | NodeKind::ScriptReview
                        | NodeKind::Join
                        | NodeKind::End,
                        true,
                    ) if trigger.is_none()
                        && work.is_none()
                        && review.is_none()
                        && group.is_none() =>
                    {
                        NodeDefinition::control(id, kind, title, max_attempts)
                    }
                    _ => return Err(StoreFault::InvalidFacts),
                };
                Ok(node)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let edges = (0..self.count()?)
            .map(|_| {
                Ok(crate::EdgeDefinition::new(
                    crate::EdgeId::new(self.string()?),
                    NodeId::new(self.string()?),
                    self.string()?,
                    NodeId::new(self.string()?),
                    self.string()?,
                    self.edge_action()?,
                )
                .with_payload(crate::EdgePayloadPolicy::new(self.bool()?))
                .with_dependency_opt(match self.byte()? {
                    0 => None,
                    1 => Some(crate::DependencyMetadata::new(
                        self.string()?,
                        self.string()?,
                    )),
                    _ => return Err(StoreFault::CorruptRecord),
                }))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        crate::GraphDefinition::new(graph_id, workflow_plan_id, run_id, title, nodes, edges)
            .map_err(|_| StoreFault::InvalidFacts)
    }

    fn graph_patch_operation(&mut self) -> Result<GraphPatchOperation, StoreFault> {
        match self.byte()? {
            0 => {
                let (node_id, kind, role_id) = self.graph_node()?;
                Ok(GraphPatchOperation::AddNode {
                    node_id,
                    kind,
                    role_id,
                })
            }
            1 => {
                let (node_id, kind, role_id) = self.graph_node()?;
                Ok(GraphPatchOperation::ReplaceNode {
                    node_id,
                    kind,
                    role_id,
                })
            }
            2 => Ok(GraphPatchOperation::RemoveNode {
                node_id: self.string()?,
            }),
            3 => {
                let (edge_id, source_node_id, target_node_id, action) = self.graph_edge()?;
                Ok(GraphPatchOperation::AddEdge {
                    edge_id,
                    source_node_id,
                    target_node_id,
                    action,
                })
            }
            4 => {
                let (edge_id, source_node_id, target_node_id, action) = self.graph_edge()?;
                Ok(GraphPatchOperation::ReplaceEdge {
                    edge_id,
                    source_node_id,
                    target_node_id,
                    action,
                })
            }
            5 => Ok(GraphPatchOperation::RemoveEdge {
                edge_id: self.string()?,
            }),
            6 => Ok(GraphPatchOperation::SetMetadata {
                key: self.opaque_id()?,
                value: self.metadata_value()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn graph_node(&mut self) -> Result<(String, GraphNodeKind, Option<String>), StoreFault> {
        Ok((
            self.string()?,
            self.graph_node_kind()?,
            self.optional_string()?,
        ))
    }

    fn graph_edge(&mut self) -> Result<(String, String, String, GraphEdgeAction), StoreFault> {
        Ok((
            self.string()?,
            self.string()?,
            self.string()?,
            self.graph_edge_action()?,
        ))
    }

    fn metadata_value(&mut self) -> Result<MetadataValue, StoreFault> {
        match self.byte()? {
            0 => Ok(MetadataValue::Enabled(self.bool()?)),
            1 => Ok(MetadataValue::Revision(self.u64()?)),
            2 => Ok(MetadataValue::OpaqueId(self.opaque_id()?)),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn team_event_payload(&mut self) -> Result<TeamEventPayload, StoreFault> {
        match self.byte()? {
            0 => Ok(TeamEventPayload::GraphPatchAccepted {
                base_graph_id: self.string()?,
                base_workflow_plan_id: self.string()?,
                operation_count: NonZeroU64::new(self.u64()?).ok_or(StoreFault::CorruptRecord)?,
            }),
            1 => Ok(TeamEventPayload::NodeProgressed {
                node_execution_id: self.opaque_id()?,
            }),
            4 => Ok(TeamEventPayload::GraphReplaced {
                graph_id: self.string()?,
                workflow_plan_id: self.string()?,
            }),
            2 => Ok(TeamEventPayload::ApprovalRequested {
                approval_id: self.opaque_id()?,
                node_execution_id: self.opaque_id()?,
                role_id: self.opaque_id()?,
                action: self.approval_action()?,
            }),
            3 => {
                let approval_id = self.opaque_id()?;
                let decision = self.approval_decision()?;
                let status = self.approval_status()?;
                if decision.status() != status {
                    return Err(StoreFault::CorruptRecord);
                }
                Ok(TeamEventPayload::ApprovalResolved {
                    approval_id,
                    decision,
                    status,
                })
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn opaque_id(&mut self) -> Result<OpaqueId, StoreFault> {
        OpaqueId::try_new(self.string()?).map_err(|_| StoreFault::InvalidFacts)
    }

    fn approval_subject(&mut self) -> Result<ApprovalSubject, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalSubject::Stage {
                stage_id: self.string()?,
            }),
            1 => Ok(ApprovalSubject::WorkNode {
                node_id: self.string()?,
            }),
            2 => Ok(ApprovalSubject::HumanDecision {
                node_id: self.string()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn approval_origin(&mut self) -> Result<ApprovalOrigin, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalOrigin::StageContinuation),
            1 => Ok(ApprovalOrigin::WorkNode),
            2 => Ok(ApprovalOrigin::HumanDecision),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn approval_effect(&mut self) -> Result<ApprovalEffect, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalEffect::ResumeStage),
            1 => Ok(ApprovalEffect::KeepNodeWaiting),
            2 => Ok(ApprovalEffect::RouteDecisionPorts),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn approval_status(&mut self) -> Result<ApprovalStatus, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalStatus::Pending),
            1 => Ok(ApprovalStatus::Approved),
            2 => Ok(ApprovalStatus::Denied),
            3 => Ok(ApprovalStatus::Aborted),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn approval_decision(&mut self) -> Result<ApprovalDecision, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalDecision::Approve),
            1 => Ok(ApprovalDecision::Deny),
            2 => Ok(ApprovalDecision::Abort),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn approval_resolution_cause(&mut self) -> Result<ApprovalResolutionCause, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalResolutionCause::HumanDecision),
            1 => Ok(ApprovalResolutionCause::RunCancelled),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn command_status(&mut self) -> Result<CommandStatus, StoreFault> {
        match self.byte()? {
            0 => Ok(CommandStatus::Accepted),
            1 => Ok(CommandStatus::Rejected),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn command_rejection(&mut self) -> Result<CommandRejection, StoreFault> {
        match self.byte()? {
            0 => Ok(CommandRejection::UnknownRun),
            1 => Ok(CommandRejection::StaleNodeExecution),
            2 => Ok(CommandRejection::InvalidGraphPatch),
            3 => Ok(CommandRejection::AuthorizationDenied),
            4 => Ok(CommandRejection::TerminalReceiptRequired),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn node_event_kind(&mut self) -> Result<NodeEventKind, StoreFault> {
        match self.byte()? {
            0 => Ok(NodeEventKind::Progress),
            1 => Ok(NodeEventKind::RequestInput),
            2 => Ok(NodeEventKind::Complete),
            3 => Ok(NodeEventKind::Reject),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn team_event_type(&mut self) -> Result<TeamEventType, StoreFault> {
        match self.byte()? {
            0 => Ok(TeamEventType::GraphPatchAccepted),
            1 => Ok(TeamEventType::NodeProgressed),
            2 => Ok(TeamEventType::ApprovalRequested),
            3 => Ok(TeamEventType::ApprovalResolved),
            4 => Ok(TeamEventType::GraphReplaced),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn graph_node_kind(&mut self) -> Result<GraphNodeKind, StoreFault> {
        match self.byte()? {
            0 => Ok(GraphNodeKind::Start),
            1 => Ok(GraphNodeKind::Work),
            2 => Ok(GraphNodeKind::Review),
            3 => Ok(GraphNodeKind::HumanDecision),
            4 => Ok(GraphNodeKind::ScriptReview),
            5 => Ok(GraphNodeKind::Join),
            6 => Ok(GraphNodeKind::End),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn graph_edge_action(&mut self) -> Result<GraphEdgeAction, StoreFault> {
        match self.byte()? {
            0 => Ok(GraphEdgeAction::Activate),
            1 => Ok(GraphEdgeAction::Rework),
            2 => Ok(GraphEdgeAction::Gate),
            3 => Ok(GraphEdgeAction::Finish),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn approval_action(&mut self) -> Result<ApprovalAction, StoreFault> {
        match self.byte()? {
            0 => Ok(ApprovalAction::ContinueNode),
            1 => Ok(ApprovalAction::ExecuteTool),
            2 => Ok(ApprovalAction::PublishResult),
            3 => Ok(ApprovalAction::ExternalAction),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn control_authority(&mut self) -> Result<ControlAuthority, StoreFault> {
        match self.byte()? {
            0 => Ok(ControlAuthority::HumanDecision),
            1 => Ok(ControlAuthority::ScriptReview),
            2 => Ok(ControlAuthority::Join),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn optional_script_review_rule(
        &mut self,
    ) -> Result<Option<crate::ScriptReviewRule>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(crate::ScriptReviewRule::PassThrough)),
            2 => Ok(Some(crate::ScriptReviewRule::AssertAllUpstreamCompleted)),
            3 => Ok(Some(crate::ScriptReviewRule::AssertNoBlockingGate)),
            4 => Ok(Some(crate::ScriptReviewRule::AssertArtifactExists)),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn node_kind(&mut self) -> Result<NodeKind, StoreFault> {
        match self.byte()? {
            0 => Ok(NodeKind::Start),
            1 => Ok(NodeKind::Work),
            2 => Ok(NodeKind::Review),
            3 => Ok(NodeKind::HumanDecision),
            4 => Ok(NodeKind::ScriptReview),
            5 => Ok(NodeKind::Join),
            6 => Ok(NodeKind::End),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn edge_action(&mut self) -> Result<EdgeAction, StoreFault> {
        match self.byte()? {
            0 => Ok(EdgeAction::Activate),
            1 => Ok(EdgeAction::Rework),
            2 => Ok(EdgeAction::Gate),
            3 => Ok(EdgeAction::Finish),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn attempt_status(&mut self) -> Result<crate::AttemptStatus, StoreFault> {
        match self.byte()? {
            0 => Ok(crate::AttemptStatus::Pending),
            1 => Ok(crate::AttemptStatus::Ready),
            2 => Ok(crate::AttemptStatus::Running),
            3 => Ok(crate::AttemptStatus::Waiting),
            4 => Ok(crate::AttemptStatus::Completed),
            5 => Ok(crate::AttemptStatus::Failed),
            6 => Ok(crate::AttemptStatus::Cancelled),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn delivery_failure(&mut self) -> Result<DeliveryFailure, StoreFault> {
        match self.byte()? {
            0 => Ok(DeliveryFailure::ReceiverRejected),
            1 => Ok(DeliveryFailure::PolicyRejected),
            2 => Ok(DeliveryFailure::Unavailable),
            3 => Ok(DeliveryFailure::TimedOut),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn trigger_source(&mut self) -> Result<TriggerSource, StoreFault> {
        match self.byte()? {
            0 => Ok(TriggerSource::Cron),
            1 => Ok(TriggerSource::Webhook),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn evidence_reference_kind(&mut self) -> Result<EvidenceReferenceKind, StoreFault> {
        match self.byte()? {
            0 => Ok(EvidenceReferenceKind::WorkspacePath),
            1 => Ok(EvidenceReferenceKind::Uri),
            2 => Ok(EvidenceReferenceKind::Artifact),
            3 => Ok(EvidenceReferenceKind::InlineText),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn native_terminal(&mut self) -> Result<NativeTerminalStatus, StoreFault> {
        match self.byte()? {
            0 => Ok(NativeTerminalStatus::Completed),
            1 => Ok(NativeTerminalStatus::Cancelled),
            2 => Ok(NativeTerminalStatus::Failed),
            3 => Ok(NativeTerminalStatus::Interrupted),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn terminal_resolution(&mut self) -> Result<TerminalObservationResolution, StoreFault> {
        match self.byte()? {
            0 => Ok(TerminalObservationResolution::AwaitingAuthorizedGraphResolution),
            1 => Ok(TerminalObservationResolution::NodeCancelled),
            2 => {
                let receipt = AuthorizedGraphResolutionReceipt::try_new(self.string()?)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let delivery_id =
                    DeliveryId::new(self.string()?).map_err(|_| StoreFault::InvalidFacts)?;
                let graph_run_id = self.string()?;
                let fence = self.fence()?;
                let outcome = self.authorized_graph_outcome()?;
                let output_port = self.string()?;
                let resolved_at = self.u64()?;
                AuthorizedGraphResolution::new(
                    receipt,
                    delivery_id,
                    graph_run_id,
                    ExecutionFence::from_durable(fence.attempt_id, fence.node_execution_id),
                    outcome,
                    output_port,
                    resolved_at,
                )
                .map(TerminalObservationResolution::GraphResolved)
                .map_err(|_| StoreFault::InvalidFacts)
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn authorized_graph_outcome(&mut self) -> Result<AuthorizedGraphOutcome, StoreFault> {
        match self.byte()? {
            0 => Ok(AuthorizedGraphOutcome::Completed),
            1 => Ok(AuthorizedGraphOutcome::Failed),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn optional_string(&mut self) -> Result<Option<String>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.string().map(Some),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn bool(&mut self) -> Result<bool, StoreFault> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    fn string(&mut self) -> Result<String, StoreFault> {
        let length = usize::try_from(self.u32()?).map_err(|_| StoreFault::CorruptRecord)?;
        if length > MAX_STRING_BYTES {
            return Err(StoreFault::CorruptRecord);
        }
        std::str::from_utf8(self.take(length)?)
            .map(str::to_owned)
            .map_err(|_| StoreFault::CorruptRecord)
    }

    fn count(&mut self) -> Result<usize, StoreFault> {
        let count = usize::try_from(self.u32()?).map_err(|_| StoreFault::CorruptRecord)?;
        if count > MAX_COLLECTION_ENTRIES {
            return Err(StoreFault::CorruptRecord);
        }
        Ok(count)
    }

    fn byte(&mut self) -> Result<u8, StoreFault> {
        Ok(*self
            .take(1)?
            .first()
            .expect("one requested byte must exist"))
    }

    fn u32(&mut self) -> Result<u32, StoreFault> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, StoreFault> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], StoreFault> {
        if self.remaining.len() < count {
            return Err(StoreFault::CorruptRecord);
        }
        let (value, remaining) = self.remaining.split_at(count);
        self.remaining = remaining;
        Ok(value)
    }
}

fn push_count(output: &mut Vec<u8>, count: usize) -> Result<(), StoreFault> {
    if count > MAX_COLLECTION_ENTRIES {
        return Err(StoreFault::RecordTooLarge);
    }
    output.extend_from_slice(
        &u32::try_from(count)
            .map_err(|_| StoreFault::RecordTooLarge)?
            .to_le_bytes(),
    );
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), StoreFault> {
    if value.len() > MAX_STRING_BYTES {
        return Err(StoreFault::RecordTooLarge);
    }
    output.extend_from_slice(
        &u32::try_from(value.len())
            .map_err(|_| StoreFault::RecordTooLarge)?
            .to_le_bytes(),
    );
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn push_optional_string(output: &mut Vec<u8>, value: Option<&str>) -> Result<(), StoreFault> {
    match value {
        Some(value) => {
            output.push(1);
            push_string(output, value)
        }
        None => {
            output.push(0);
            Ok(())
        }
    }
}

fn node_kind_tag(kind: NodeKind) -> u8 {
    match kind {
        NodeKind::Start => 0,
        NodeKind::Work => 1,
        NodeKind::Review => 2,
        NodeKind::HumanDecision => 3,
        NodeKind::ScriptReview => 4,
        NodeKind::Join => 5,
        NodeKind::End => 6,
    }
}

fn edge_action_tag(action: EdgeAction) -> u8 {
    match action {
        EdgeAction::Activate => 0,
        EdgeAction::Rework => 1,
        EdgeAction::Gate => 2,
        EdgeAction::Finish => 3,
    }
}

fn task_status_tag(status: TaskStatus) -> u8 {
    match status {
        TaskStatus::Todo => 0,
        TaskStatus::Claimed => 1,
        TaskStatus::Running => 2,
        TaskStatus::Blocked => 3,
        TaskStatus::Done => 4,
        TaskStatus::Failed => 5,
    }
}
fn runner_status_tag(status: RunnerStatus) -> u8 {
    match status {
        RunnerStatus::Active => 0,
        RunnerStatus::Paused => 1,
        RunnerStatus::Closed => 2,
    }
}
fn mailbox_kind_tag(kind: MailboxKind) -> u8 {
    match kind {
        MailboxKind::Question => 0,
        MailboxKind::Proposal => 1,
        MailboxKind::Decision => 2,
        MailboxKind::Report => 3,
    }
}

fn attempt_status_tag(status: crate::AttemptStatus) -> u8 {
    match status {
        crate::AttemptStatus::Pending => 0,
        crate::AttemptStatus::Ready => 1,
        crate::AttemptStatus::Running => 2,
        crate::AttemptStatus::Waiting => 3,
        crate::AttemptStatus::Completed => 4,
        crate::AttemptStatus::Failed => 5,
        crate::AttemptStatus::Cancelled => 6,
    }
}

fn activity_failure_tag(failure: ActivityFailure) -> u8 {
    match failure {
        ActivityFailure::Rejected => 0,
        ActivityFailure::Unavailable => 1,
        ActivityFailure::TimedOut => 2,
    }
}

fn delivery_failure_tag(failure: DeliveryFailure) -> u8 {
    match failure {
        DeliveryFailure::ReceiverRejected => 0,
        DeliveryFailure::PolicyRejected => 1,
        DeliveryFailure::Unavailable => 2,
        DeliveryFailure::TimedOut => 3,
    }
}

fn trigger_source_tag(source: TriggerSource) -> u8 {
    match source {
        TriggerSource::Cron => 0,
        TriggerSource::Webhook => 1,
    }
}

fn evidence_reference_kind_tag(kind: EvidenceReferenceKind) -> u8 {
    match kind {
        EvidenceReferenceKind::WorkspacePath => 0,
        EvidenceReferenceKind::Uri => 1,
        EvidenceReferenceKind::Artifact => 2,
        EvidenceReferenceKind::InlineText => 3,
    }
}

fn native_terminal_tag(status: NativeTerminalStatus) -> u8 {
    match status {
        NativeTerminalStatus::Completed => 0,
        NativeTerminalStatus::Cancelled => 1,
        NativeTerminalStatus::Failed => 2,
        NativeTerminalStatus::Interrupted => 3,
    }
}

fn authorized_graph_outcome_tag(outcome: AuthorizedGraphOutcome) -> u8 {
    match outcome {
        AuthorizedGraphOutcome::Completed => 0,
        AuthorizedGraphOutcome::Failed => 1,
    }
}

fn control_authority_tag(authority: ControlAuthority) -> u8 {
    match authority {
        ControlAuthority::HumanDecision => 0,
        ControlAuthority::ScriptReview => 1,
        ControlAuthority::Join => 2,
    }
}

fn script_review_rule_tag(rule: crate::ScriptReviewRule) -> u8 {
    match rule {
        crate::ScriptReviewRule::PassThrough => 1,
        crate::ScriptReviewRule::AssertAllUpstreamCompleted => 2,
        crate::ScriptReviewRule::AssertNoBlockingGate => 3,
        crate::ScriptReviewRule::AssertArtifactExists => 4,
    }
}

fn approval_origin_tag(origin: ApprovalOrigin) -> u8 {
    match origin {
        ApprovalOrigin::StageContinuation => 0,
        ApprovalOrigin::WorkNode => 1,
        ApprovalOrigin::HumanDecision => 2,
    }
}

fn approval_effect_tag(effect: ApprovalEffect) -> u8 {
    match effect {
        ApprovalEffect::ResumeStage => 0,
        ApprovalEffect::KeepNodeWaiting => 1,
        ApprovalEffect::RouteDecisionPorts => 2,
    }
}

fn approval_status_tag(status: ApprovalStatus) -> u8 {
    match status {
        ApprovalStatus::Pending => 0,
        ApprovalStatus::Approved => 1,
        ApprovalStatus::Denied => 2,
        ApprovalStatus::Aborted => 3,
    }
}

fn approval_decision_tag(decision: ApprovalDecision) -> u8 {
    match decision {
        ApprovalDecision::Approve => 0,
        ApprovalDecision::Deny => 1,
        ApprovalDecision::Abort => 2,
    }
}

fn approval_resolution_cause_tag(cause: ApprovalResolutionCause) -> u8 {
    match cause {
        ApprovalResolutionCause::HumanDecision => 0,
        ApprovalResolutionCause::RunCancelled => 1,
    }
}

fn command_status_tag(status: CommandStatus) -> u8 {
    match status {
        CommandStatus::Accepted => 0,
        CommandStatus::Rejected => 1,
    }
}

fn command_rejection_tag(rejection: CommandRejection) -> u8 {
    match rejection {
        CommandRejection::UnknownRun => 0,
        CommandRejection::StaleNodeExecution => 1,
        CommandRejection::InvalidGraphPatch => 2,
        CommandRejection::AuthorizationDenied => 3,
        CommandRejection::TerminalReceiptRequired => 4,
    }
}

fn node_event_kind_tag(event: NodeEventKind) -> u8 {
    match event {
        NodeEventKind::Progress => 0,
        NodeEventKind::RequestInput => 1,
        NodeEventKind::Complete => 2,
        NodeEventKind::Reject => 3,
    }
}

fn team_event_type_tag(event_type: TeamEventType) -> u8 {
    match event_type {
        TeamEventType::GraphPatchAccepted => 0,
        TeamEventType::GraphReplaced => 4,
        TeamEventType::NodeProgressed => 1,
        TeamEventType::ApprovalRequested => 2,
        TeamEventType::ApprovalResolved => 3,
    }
}

fn graph_node_kind_tag(kind: GraphNodeKind) -> u8 {
    match kind {
        GraphNodeKind::Start => 0,
        GraphNodeKind::Work => 1,
        GraphNodeKind::Review => 2,
        GraphNodeKind::HumanDecision => 3,
        GraphNodeKind::ScriptReview => 4,
        GraphNodeKind::Join => 5,
        GraphNodeKind::End => 6,
    }
}

fn graph_edge_action_tag(action: GraphEdgeAction) -> u8 {
    match action {
        GraphEdgeAction::Activate => 0,
        GraphEdgeAction::Rework => 1,
        GraphEdgeAction::Gate => 2,
        GraphEdgeAction::Finish => 3,
    }
}

fn approval_action_tag(action: ApprovalAction) -> u8 {
    match action {
        ApprovalAction::ContinueNode => 0,
        ApprovalAction::ExecuteTool => 1,
        ApprovalAction::PublishResult => 2,
        ApprovalAction::ExternalAction => 3,
    }
}

fn checksum_fn(content: &[u8]) -> u32 {
    let mut value = 0x811C_9DC5_u32;
    for byte in content {
        value ^= u32::from(*byte);
        value = value.wrapping_mul(0x0100_0193);
    }
    value
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        num::NonZeroU32,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use crate::{
        DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, ManagedAgentReference,
        MaterializationReceipt, MemberId, NodeDefinition, NodeId, RoleAssignment, RoleId, RoleKind,
        RoleMaterializationOwnership, RoleMaterializationReceipt, RuntimeEndpointReference,
        StartTrigger, TeamDefinition, TeamFacts, TeamMember, TeamRevision, TeamRole,
        ports::materialization::NativeWorkspaceReceipt,
    };

    use super::*;

    static NEXT_TEST_PATH_ID: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn task_board_round_trips_through_facts_payload() {
        let team = crate::TeamId::try_new("team:board").unwrap();
        let run = crate::GraphRunId::new("run:board");
        let task_id = crate::run::task_board::TaskId::new("task:one");
        let mut facts = OrganizationFacts::default();
        crate::run::task_board::upsert_plan(
            facts.task_board_mut(),
            vec![crate::run::task_board::TaskPlanInput {
                team_id: team.clone(),
                run_id: run.clone(),
                task_id: task_id.clone(),
                title: "Task title".to_owned(),
                instruction: "Do the durable work".to_owned(),
                depends_on: Vec::new(),
            }],
            7,
            "fingerprint:one",
        )
        .unwrap();
        crate::run::task_board::start_runner(
            facts.task_board_mut(),
            &team,
            &run,
            "runner:one",
            "session:one",
            8,
        )
        .unwrap();
        crate::run::task_board::post(
            facts.task_board_mut(),
            crate::run::task_board::MailboxMessage::new(
                team.clone(),
                run.clone(),
                "msg:one".to_owned(),
                "agent:one".to_owned(),
                "agent:two".to_owned(),
                Some(task_id.clone()),
                Some("msg:prior".to_owned()),
                crate::run::task_board::MailboxKind::Report,
                "durable content".to_owned(),
                9,
            )
            .unwrap(),
        )
        .unwrap();

        let restored = decode_facts(&encode_facts(&facts).unwrap()).unwrap();
        let task = restored.task_board().task(&team, &run, &task_id).unwrap();
        assert_eq!(task.title(), "Task title");
        assert_eq!(task.instruction(), "Do the durable work");
        assert_eq!(task.command_fingerprint(), "fingerprint:one");
        let runner = restored.task_board().runners().next().unwrap();
        assert_eq!(runner.runner_id(), "runner:one");
        assert_eq!(
            runner.status(),
            crate::run::task_board::RunnerStatus::Active
        );
        let message = restored.task_board().mailbox().next().unwrap();
        assert_eq!(message.content(), "durable content");
        assert_eq!(message.related_task_id(), Some(&task_id));
    }

    #[test]
    fn frame_magic_schema_length_checksum_and_trailing_garbage_fail_closed() {
        let mut bad_magic = initialized_log();
        bad_magic[0] ^= 0xFF;
        assert!(matches!(
            recover_log(Cursor::new(bad_magic)),
            Err(StoreFault::CorruptRecord)
        ));

        for version in [CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 1] {
            let mut unsupported_schema = initialized_log();
            unsupported_schema[LOG_MAGIC.len()] = version;
            assert!(matches!(
                recover_log(Cursor::new(unsupported_schema)),
                Err(StoreFault::UnsupportedSchemaVersion(observed)) if observed == version
            ));
        }

        let mut invalid_length = initialized_log();
        let mut invalid_frame = encode_frame(1, &OrganizationFacts::default()).unwrap();
        invalid_frame[9..13]
            .copy_from_slice(&u32::try_from(MAX_FACTS_BYTES + 1).unwrap().to_le_bytes());
        invalid_length.extend_from_slice(&invalid_frame);
        assert!(matches!(
            recover_log(Cursor::new(invalid_length)),
            Err(StoreFault::CorruptRecord)
        ));

        let mut invalid_checksum = initialized_log();
        let mut checksum_frame = encode_frame(1, &OrganizationFacts::default()).unwrap();
        *checksum_frame.last_mut().unwrap() ^= 0xFF;
        invalid_checksum.extend_from_slice(&checksum_frame);
        assert!(matches!(
            recover_log(Cursor::new(invalid_checksum)),
            Err(StoreFault::CorruptRecord)
        ));

        let mut trailing_garbage = initialized_log();
        trailing_garbage
            .extend_from_slice(&encode_frame(1, &OrganizationFacts::default()).unwrap());
        trailing_garbage.push(0xFF);
        assert!(matches!(
            recover_log(Cursor::new(trailing_garbage)),
            Err(StoreFault::CorruptRecord)
        ));
    }

    #[test]
    fn frame_epoch_order_fails_closed() {
        for invalid_epoch in [1, 3] {
            let mut out_of_order = initialized_log();
            out_of_order
                .extend_from_slice(&encode_frame(1, &OrganizationFacts::default()).unwrap());
            out_of_order.extend_from_slice(
                &encode_frame(invalid_epoch, &OrganizationFacts::default()).unwrap(),
            );
            assert!(matches!(
                recover_log(Cursor::new(out_of_order)),
                Err(StoreFault::CorruptRecord)
            ));
        }
    }

    #[test]
    fn reopen_truncates_partial_tail_and_selects_the_last_complete_valid_frame() {
        let path = test_path("frame-recovery");
        let facts = OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition("team:recovered"),
                TeamRevision::initial(),
                false,
            )],
            [],
            [],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        let first = encode_frame(1, &OrganizationFacts::default()).unwrap();
        let second = encode_frame(2, &facts).unwrap();
        let incomplete = encode_frame(3, &facts).unwrap();
        let committed_len = HEADER_LEN + first.len() + second.len();

        let mut log = initialized_log();
        log.extend_from_slice(&first);
        log.extend_from_slice(&second);
        log.extend_from_slice(&incomplete[..1 + FRAME_METADATA_LEN + 1]);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, log).unwrap();

        let reopened = super::super::OrganizationStore::open(&path).unwrap();
        assert_eq!(reopened.facts().teams().count(), 1);
        assert_eq!(
            reopened.facts().teams().next().unwrap().team_id().as_str(),
            "team:recovered"
        );
        assert_eq!(fs::metadata(&path).unwrap().len(), committed_len as u64);
        drop(reopened);
        remove_test_path(&path);
    }

    #[test]
    fn recovery_rejects_evidence_with_spliced_run_provenance() {
        let mut facts = OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition("team:one"),
                TeamRevision::initial(),
                false,
            )],
            [],
            vec![
                GraphRunFacts::new(
                    TeamId::try_new("team:one").unwrap(),
                    TeamRevision::initial(),
                    GraphState::initialize(
                        GraphDefinition::new(
                            "graph:one",
                            "plan:one",
                            GraphRunId::new("run:one"),
                            "display",
                            vec![NodeDefinition::start(
                                NodeId::new("start"),
                                "start",
                                NonZeroU32::new(2).unwrap(),
                                None,
                            )],
                            Vec::new(),
                        )
                        .unwrap(),
                        1,
                    ),
                    None,
                )
                .unwrap(),
            ],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        facts
            .record_evidence(
                EvidenceRecord::new(
                    EvidenceId::new("evidence:one").unwrap(),
                    "run:one",
                    "start:attempt:1",
                    EvidenceReference::opaque(
                        EvidenceReferenceKind::Artifact,
                        "artifact:opaque",
                        None,
                    )
                    .unwrap(),
                    2,
                )
                .unwrap(),
            )
            .unwrap();
        let mut frame = encode_frame(1, &facts).unwrap();
        let evidence_id = b"evidence:one";
        let evidence_offset = frame
            .windows(evidence_id.len())
            .position(|window| window == evidence_id)
            .unwrap();
        let run_length_offset = evidence_offset + evidence_id.len();
        assert_eq!(
            u32::from_le_bytes(
                frame[run_length_offset..run_length_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            7
        );
        let run_offset = run_length_offset + 4;
        frame[run_offset..run_offset + 7].copy_from_slice(b"run:bad");
        let checksum = checksum_fn(&frame[17..]);
        frame[13..17].copy_from_slice(&checksum.to_le_bytes());

        let mut log = initialized_log();
        log.extend_from_slice(&frame);
        assert!(matches!(
            recover_log(Cursor::new(log)),
            Err(StoreFault::InvalidFacts)
        ));
    }

    #[test]
    fn team_definition_decode_rejects_tampered_member_role_and_assignment() {
        let facts = OrganizationFacts::restore(
            [TeamFacts::new(
                team_definition("team:one"),
                TeamRevision::initial(),
                false,
            )],
            [],
            [],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        let payload = encode_facts(&facts).unwrap();

        let member_offsets = payload
            .windows(b"member:leader".len())
            .enumerate()
            .filter_map(|(offset, window)| (window == b"member:leader").then_some(offset))
            .collect::<Vec<_>>();
        let role_offset = payload
            .windows(b"leader".len())
            .enumerate()
            .find_map(|(offset, window)| {
                (window == b"leader"
                    && offset >= std::mem::size_of::<u32>()
                    && u32::from_le_bytes(
                        payload[offset - std::mem::size_of::<u32>()..offset]
                            .try_into()
                            .unwrap(),
                    ) == b"leader".len() as u32)
                    .then_some(offset)
            })
            .unwrap();
        for offset in [member_offsets[0], role_offset, member_offsets[1]] {
            let marker_len = if offset == role_offset {
                b"leader".len()
            } else {
                b"member:leader".len()
            };
            let mut tampered = payload.clone();
            tampered[offset..offset + marker_len].fill(b' ');
            assert!(matches!(
                decode_facts(&tampered),
                Err(StoreFault::InvalidFacts)
            ));
        }
    }

    #[test]
    fn materialization_ownership_roundtrips_and_rejects_invalid_tags() {
        let endpoint = RuntimeEndpointReference::try_new("endpoint:one").unwrap();
        let facts = OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition("team:one"),
                TeamRevision::initial(),
                false,
            )],
            vec![
                MaterializationReceipt::try_new(
                    TeamId::try_new("team:one").unwrap(),
                    endpoint.clone(),
                    vec![
                        RoleMaterializationReceipt::with_native_workspace(
                            RoleId::try_new("managed").unwrap(),
                            ManagedAgentReference::try_new("agent:managed").unwrap(),
                            RoleMaterializationOwnership::Managed,
                            endpoint.clone(),
                            NativeWorkspaceReceipt::try_new("workspace:managed").unwrap(),
                        ),
                        RoleMaterializationReceipt::with_native_workspace(
                            RoleId::try_new("external").unwrap(),
                            ManagedAgentReference::try_new("agent:external").unwrap(),
                            RoleMaterializationOwnership::External,
                            endpoint.clone(),
                            NativeWorkspaceReceipt::try_new("workspace:external").unwrap(),
                        ),
                    ],
                )
                .unwrap(),
            ],
            [],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();

        let payload = encode_facts(&facts).unwrap();
        let restored = decode_facts(&payload).unwrap();
        let receipt = restored.materializations().next().unwrap();
        assert_eq!(
            receipt
                .roles()
                .iter()
                .map(RoleMaterializationReceipt::ownership)
                .collect::<Vec<_>>(),
            vec![
                RoleMaterializationOwnership::Managed,
                RoleMaterializationOwnership::External,
            ]
        );
        assert_eq!(
            receipt
                .roles()
                .iter()
                .map(|role| role.native_workspace().map(NativeWorkspaceReceipt::as_str))
                .collect::<Vec<_>>(),
            vec![Some("workspace:managed"), Some("workspace:external")]
        );

        let ownership_tag = payload
            .windows(b"agent:external".len())
            .position(|window| window == b"agent:external")
            .unwrap()
            + b"agent:external".len();
        let mut invalid_ownership = payload;
        invalid_ownership[ownership_tag] = 0xFF;
        assert!(matches!(
            decode_facts(&invalid_ownership),
            Err(StoreFault::InvalidFacts)
        ));
    }

    #[test]
    fn historical_rejected_cleanup_decodes_as_outcome_unknown() {
        let endpoint = RuntimeEndpointReference::try_new("endpoint:one").unwrap();
        let removal = TeamMaterializationRemoval::new(
            MaterializationReceipt::try_new(
                TeamId::try_new("team:one").unwrap(),
                endpoint.clone(),
                vec![RoleMaterializationReceipt::new(
                    RoleId::try_new("leader").unwrap(),
                    ManagedAgentReference::try_new("agent:leader").unwrap(),
                    endpoint,
                )],
            )
            .unwrap(),
            IdempotencyKey::try_new("cleanup:one").unwrap(),
        );
        let lifecycle =
            TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
                receipt: removal.receipt().clone(),
                cleanup: TeamMaterializationCleanup::Rejected {
                    removal: removal.clone(),
                    rejection: MaterializationRejection::Permanent,
                },
            });
        let facts = OrganizationFacts::restore_with_materialization_lifecycles_and_decisions_and_artifacts_and_task_board_and_purged_runs(
            MaterializationLifecycleFactsRestoreInput {
                teams: vec![TeamFacts::new(
                    team_definition("team:one"),
                    TeamRevision::initial(),
                    true,
                )],
                materializations: vec![(TeamId::try_new("team:one").unwrap(), lifecycle)],
                runs: Vec::new(),
                pending_workflow_plan_admissions: Vec::new(),
                templates: Vec::new(),
                deliveries: DeliveryLedgerSnapshot::new(Vec::new()),
                activities: ActivityLedgerSnapshot::new(Vec::new()),
                triggers: Vec::new(),
                control_resolutions: Vec::new(),
                approvals: Vec::new(),
                events: Default::default(),
                evidence: Vec::new(),
            },
            TeamDecisionLedgerSnapshot::default(),
            [],
            TaskBoardFacts::default(),
            [],
        )
        .unwrap();

        let restored = decode_facts(&encode_facts(&facts).unwrap()).unwrap();
        let lifecycle = restored.materialization_lifecycles().next().unwrap();
        assert!(matches!(
            lifecycle.cleanup(),
            Some(TeamMaterializationCleanup::OutcomeUnknown(recorded)) if recorded == &removal
        ));
        assert!(lifecycle.cleanup_request().is_none());
    }

    #[test]
    fn decoder_rejects_incomplete_current_frame_tails() {
        let facts = OrganizationFacts::restore(
            vec![TeamFacts::new(
                team_definition("team:one"),
                TeamRevision::initial(),
                false,
            )],
            [],
            vec![
                GraphRunFacts::new(
                    TeamId::try_new("team:one").unwrap(),
                    TeamRevision::initial(),
                    GraphState::initialize(
                        GraphDefinition::new(
                            "graph:one",
                            "plan:one",
                            GraphRunId::new("run:one"),
                            "display",
                            vec![NodeDefinition::start(
                                NodeId::new("start"),
                                "start",
                                NonZeroU32::new(2).unwrap(),
                                Some(StartTrigger::Webhook {
                                    path: "private-path".to_owned(),
                                }),
                            )],
                            Vec::new(),
                        )
                        .unwrap(),
                        1,
                    ),
                    None,
                )
                .unwrap(),
            ],
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        let payload = encode_facts(&facts).unwrap();

        for missing_tails in 1..=5 {
            let mut incomplete = payload.clone();
            incomplete.truncate(incomplete.len() - std::mem::size_of::<u32>() * missing_tails);
            assert!(matches!(
                decode_facts(&incomplete),
                Err(StoreFault::CorruptRecord)
            ));
        }
    }

    fn team_definition(team_id: &str) -> TeamDefinition {
        let member =
            TeamMember::try_new(MemberId::try_new("member:leader").unwrap(), "Leader").unwrap();
        let role = TeamRole::try_new(
            RoleId::try_new("leader").unwrap(),
            "Leader",
            RoleKind::Leader,
        )
        .unwrap();
        TeamDefinition::try_new(
            TeamId::try_new(team_id).unwrap(),
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

    fn initialized_log() -> Vec<u8> {
        let mut log = Vec::new();
        initialize_log(&mut log).unwrap();
        log
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "matcha-organization-frame-codec-{name}-{}-{}",
                std::process::id(),
                NEXT_TEST_PATH_ID.fetch_add(1, Ordering::Relaxed)
            ))
            .join("facts.log")
    }

    fn remove_test_path(path: &Path) {
        let root = path.parent().unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
