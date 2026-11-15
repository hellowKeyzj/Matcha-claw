use std::num::NonZeroU64;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::Metadata;
use crate::{
    ApprovalDecision, ApprovalStatus, GraphRunId, TeamId,
    run::event::{
        ApprovalAction, ApprovalCommand, CommandPayload, CommandRecord, CommandRejection,
        CommandStatus, GraphEdgeAction, GraphNodeKind, GraphPatch, GraphPatchOperation,
        NodeEventKind, NodeProgressCommand, OpaqueId, RunCommand, TeamEvent,
        TeamEventDurableInput, TeamEventPayload, TeamEventType,
    },
    store::{
        StoreFault,
        content::{ContentRef, ContentScope, ContentStore},
        schema::{RecordKey, RecordKind, StoredRecord},
    },
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandRow {
    team_id: String,
    run_id: String,
    command_id: String,
    idempotency_key: String,
    sequence: u64,
    payload: Payload,
    #[serde(with = "Status")]
    status: CommandStatus,
    rejection_reason: Option<Rejection>,
    created_at: u64,
    accepted_at: Option<u64>,
    rejected_at: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum Payload {
    GraphPatch {
        base_graph_id: String,
        base_workflow_plan_id: String,
        operations: Vec<Operation>,
        content_fingerprint: Option<String>,
    },
    ReworkContinue {
        batch_id: u64,
        source_node_id: String,
        source_port: String,
        source_node_execution_id: String,
        max_reworks: u32,
        expected_graph_version: String,
    },
    GraphReplace(serde_json::Value),
    HistoricalGraphReplace {
        schema: u8,
        definition: serde_json::Value,
        encoded_definition: ContentRef,
    },
    NodeProgress {
        node_execution_id: String,
        #[serde(with = "Progress")]
        event: NodeEventKind,
    },
    ApprovalRequest {
        approval_id: String,
        node_execution_id: String,
        role_id: String,
        #[serde(with = "Action")]
        action: ApprovalAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        submission: Option<ContentRef>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum Operation {
    AddNode {
        node_id: String,
        #[serde(with = "NodeKind")]
        kind: GraphNodeKind,
        role_id: Option<String>,
    },
    ReplaceNode {
        node_id: String,
        #[serde(with = "NodeKind")]
        kind: GraphNodeKind,
        role_id: Option<String>,
    },
    RemoveNode {
        node_id: String,
    },
    AddEdge {
        edge_id: String,
        source_node_id: String,
        target_node_id: String,
        action: Option<EdgeAction>,
    },
    ReplaceEdge {
        edge_id: String,
        source_node_id: String,
        target_node_id: String,
        action: Option<EdgeAction>,
    },
    RemoveEdge {
        edge_id: String,
    },
    SetReworkLimit {
        source_node_id: String,
        source_port: String,
        max_reworks: u32,
    },
    SetNodePosition {
        node_id: String,
        x: i64,
        y: i64,
    },
    SetMetadata {
        key: String,
        value: Metadata,
    },
}

#[derive(Serialize, Deserialize)]
enum EdgeAction {
    Activate,
    Rework,
    Gate,
    Finish,
}

impl From<GraphEdgeAction> for EdgeAction {
    fn from(value: GraphEdgeAction) -> Self {
        match value {
            GraphEdgeAction::Activate => Self::Activate,
            GraphEdgeAction::Rework => Self::Rework,
            GraphEdgeAction::Gate => Self::Gate,
            GraphEdgeAction::Finish => Self::Finish,
        }
    }
}

impl From<EdgeAction> for GraphEdgeAction {
    fn from(value: EdgeAction) -> Self {
        match value {
            EdgeAction::Activate => Self::Activate,
            EdgeAction::Rework => Self::Rework,
            EdgeAction::Gate => Self::Gate,
            EdgeAction::Finish => Self::Finish,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "GraphNodeKind")]
enum NodeKind {
    Start,
    Work,
    Review,
    HumanDecision,
    ScriptReview,
    Join,
    End,
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "CommandStatus")]
enum Status {
    Accepted,
    Rejected,
}

#[derive(Serialize, Deserialize)]
enum Rejection {
    UnknownRun,
    StaleNodeExecution,
    InvalidGraphPatch,
    AuthorizationDenied,
    TerminalReceiptRequired,
}

impl From<CommandRejection> for Rejection {
    fn from(value: CommandRejection) -> Self {
        match value {
            CommandRejection::UnknownRun => Self::UnknownRun,
            CommandRejection::StaleNodeExecution => Self::StaleNodeExecution,
            CommandRejection::InvalidGraphPatch => Self::InvalidGraphPatch,
            CommandRejection::AuthorizationDenied => Self::AuthorizationDenied,
            CommandRejection::TerminalReceiptRequired => Self::TerminalReceiptRequired,
        }
    }
}

impl From<Rejection> for CommandRejection {
    fn from(value: Rejection) -> Self {
        match value {
            Rejection::UnknownRun => Self::UnknownRun,
            Rejection::StaleNodeExecution => Self::StaleNodeExecution,
            Rejection::InvalidGraphPatch => Self::InvalidGraphPatch,
            Rejection::AuthorizationDenied => Self::AuthorizationDenied,
            Rejection::TerminalReceiptRequired => Self::TerminalReceiptRequired,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "NodeEventKind")]
enum Progress {
    Progress,
    RequestInput,
    Complete,
    Reject,
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "ApprovalAction")]
enum Action {
    ContinueNode,
    ExecuteTool,
    PublishResult,
    ExternalAction,
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "TeamEventType")]
enum EventType {
    GraphPatchAccepted,
    GraphReplaced,
    ReworkContinued,
    NodeProgressed,
    ApprovalRequested,
    ApprovalResolved,
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "ApprovalDecision")]
enum Decision {
    Approve,
    Deny,
    Abort,
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "ApprovalStatus")]
enum ApprovalState {
    Pending,
    Approved,
    Denied,
    Aborted,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventRow {
    team_id: String,
    event_id: String,
    run_id: String,
    sequence: u64,
    #[serde(with = "EventType")]
    event_type: TeamEventType,
    payload: EventPayload,
    causation_id: String,
    idempotency_key: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum EventPayload {
    GraphPatchAccepted {
        base_graph_id: String,
        base_workflow_plan_id: String,
        operation_count: u64,
    },
    ReworkContinued {
        batch_id: u64,
        source_node_id: String,
        source_port: String,
        source_node_execution_id: String,
        max_reworks: u32,
        expected_graph_version: String,
    },
    GraphReplaced {
        graph_id: String,
        workflow_plan_id: String,
    },
    NodeProgressed {
        node_execution_id: String,
    },
    ApprovalRequested {
        approval_id: String,
        node_execution_id: String,
        role_id: String,
        #[serde(with = "Action")]
        action: ApprovalAction,
    },
    ApprovalResolved {
        approval_id: String,
        #[serde(with = "Decision")]
        decision: ApprovalDecision,
        #[serde(with = "ApprovalState")]
        status: ApprovalStatus,
    },
}

pub(crate) fn encode_command(
    team: &TeamId,
    record: &CommandRecord,
    contents: &ContentStore,
) -> Result<StoredRecord, StoreFault> {
    let row = CommandRow {
        team_id: team.as_str().to_owned(),
        run_id: record.run_id().as_str().to_owned(),
        command_id: record.command_id().as_str().to_owned(),
        idempotency_key: record.idempotency_key().as_str().to_owned(),
        sequence: record.sequence(),
        payload: encode_payload(team, record.command(), contents)?,
        status: record.status(),
        rejection_reason: record.rejection_reason().map(Into::into),
        created_at: record.created_at(),
        accepted_at: record.accepted_at(),
        rejected_at: record.rejected_at(),
    };
    stored(
        RecordKind::Command,
        team,
        &row.run_id,
        &row.command_id,
        &row,
    )
}

pub(crate) fn decode_command(
    record: &StoredRecord,
    contents: &ContentStore,
) -> Result<CommandRecord, StoreFault> {
    let row: CommandRow = read(record)?;
    let team = check_key(
        record,
        RecordKind::Command,
        &row.team_id,
        &row.run_id,
        &row.command_id,
    )?;
    let run = GraphRunId::new(row.run_id.clone());
    let payload = decode_payload(&team, &run, row.payload, contents)?;
    let command = RunCommand::new(
        opaque(row.run_id)?,
        opaque(row.command_id)?,
        opaque(row.idempotency_key)?,
        payload,
        row.created_at,
    );
    let restored = CommandRecord::from_durable(
        nonzero(row.sequence)?,
        command,
        row.status,
        row.rejection_reason.map(Into::into),
    )
    .ok_or(StoreFault::InvalidFacts)?;
    if restored.accepted_at() != row.accepted_at || restored.rejected_at() != row.rejected_at {
        return Err(StoreFault::InvalidFacts);
    }
    Ok(restored)
}

fn encode_payload(
    team: &TeamId,
    command: &RunCommand,
    contents: &ContentStore,
) -> Result<Payload, StoreFault> {
    let run = GraphRunId::new(command.run_id().as_str());
    Ok(match command.payload() {
        CommandPayload::GraphPatch(patch) => Payload::GraphPatch {
            base_graph_id: patch.base_graph_id().to_owned(),
            base_workflow_plan_id: patch.base_workflow_plan_id().to_owned(),
            operations: patch.operations().iter().map(encode_operation).collect(),
            content_fingerprint: patch.content_fingerprint().map(|id| id.as_str().to_owned()),
        },
        CommandPayload::GraphReplace(definition) => {
            Payload::GraphReplace(definition_value(team, &run, definition, contents)?)
        }
        CommandPayload::HistoricalGraphReplace(historical) => {
            if !matches!(historical.schema(), 1 | 25 | 26 | 27) {
                return Err(StoreFault::InvalidFacts);
            }
            let definition = definition_value(team, &run, historical.definition(), contents)?;
            let reference = contents.put(
                ContentScope::Run { team, run: &run },
                historical.encoded_definition(),
            )?;
            Payload::HistoricalGraphReplace {
                schema: historical.schema(),
                definition,
                encoded_definition: reference,
            }
        }
        CommandPayload::ReworkContinue {
            batch_id,
            source_node_id,
            source_port,
            source_node_execution_id,
            max_reworks,
            expected_graph_version,
        } => Payload::ReworkContinue {
            batch_id: *batch_id,
            source_node_id: source_node_id.clone(),
            source_port: source_port.clone(),
            source_node_execution_id: source_node_execution_id.clone(),
            max_reworks: *max_reworks,
            expected_graph_version: expected_graph_version.clone(),
        },
        CommandPayload::NodeProgress(progress) => Payload::NodeProgress {
            node_execution_id: progress.node_execution_id().as_str().to_owned(),
            event: progress.event(),
        },
        CommandPayload::ApprovalRequest(approval) => Payload::ApprovalRequest {
            approval_id: approval.approval_id().as_str().to_owned(),
            node_execution_id: approval.node_execution_id().as_str().to_owned(),
            role_id: approval.role_id().as_str().to_owned(),
            action: approval.action(),
            submission: approval.submission().map(|submission| {
                let bytes = serde_json::to_vec(submission).map_err(|_| StoreFault::InvalidFacts)?;
                contents.put(ContentScope::Run { team, run: &run }, &bytes)
            }).transpose()?,
        },
    })
}

fn definition_value(
    team: &TeamId,
    run: &GraphRunId,
    definition: &crate::GraphDefinition,
    contents: &ContentStore,
) -> Result<serde_json::Value, StoreFault> {
    let row = super::definition::build_definition(team, run, definition, contents)?;
    serde_json::to_value(row).map_err(|_| StoreFault::InvalidFacts)
}

fn decode_payload(
    team: &TeamId,
    run: &GraphRunId,
    payload: Payload,
    contents: &ContentStore,
) -> Result<CommandPayload, StoreFault> {
    Ok(match payload {
        Payload::GraphPatch {
            base_graph_id,
            base_workflow_plan_id,
            operations,
            content_fingerprint,
        } => {
            let mut patch = GraphPatch::try_new(
                base_graph_id,
                base_workflow_plan_id,
                operations
                    .into_iter()
                    .map(decode_operation)
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
            if let Some(fingerprint) = content_fingerprint {
                patch = patch.with_content_fingerprint(opaque(fingerprint)?);
            }
            CommandPayload::GraphPatch(patch)
        }
        Payload::GraphReplace(value) => {
            if value
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|nodes| nodes.iter().any(|node| node.get("max_attempts").is_some()))
            {
                let raw = serde_json::to_vec(&value).map_err(|_| StoreFault::InvalidFacts)?;
                let definition = super::definition::decode_historical_sqlite_definition(
                    team, run, &raw, contents,
                )?;
                CommandPayload::historical_graph_replace(1, definition, raw)
            } else {
            CommandPayload::GraphReplace(restore_definition(team, run, value, contents)?)
            }
        }
        Payload::HistoricalGraphReplace {
            schema,
            definition,
            encoded_definition,
        } => {
            let definition = if definition
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|nodes| nodes.iter().any(|node| node.get("max_attempts").is_some()))
            {
                let bytes = serde_json::to_vec(&definition).map_err(|_| StoreFault::InvalidFacts)?;
                super::definition::decode_historical_sqlite_definition(team, run, &bytes, contents)?
            } else {
                restore_definition(team, run, definition, contents)?
            };
            let raw = contents.read(ContentScope::Run { team, run }, &encoded_definition)?;
            let restored = if schema == 1 {
                super::definition::decode_historical_sqlite_definition(team, run, &raw, contents)?
            } else {
                crate::store::codec::decode_historical_definition(schema, &raw)?
            };
            if restored != definition {
                return Err(StoreFault::InvalidFacts);
            }
            CommandPayload::historical_graph_replace(schema, definition, raw)
        }
        Payload::ReworkContinue {
            batch_id,
            source_node_id,
            source_port,
            source_node_execution_id,
            max_reworks,
            expected_graph_version,
        } => CommandPayload::ReworkContinue {
            batch_id,
            source_node_id,
            source_port,
            source_node_execution_id,
            max_reworks,
            expected_graph_version,
        },
        Payload::NodeProgress {
            node_execution_id,
            event,
        } => CommandPayload::NodeProgress(NodeProgressCommand::with_event(
            opaque(node_execution_id)?,
            event,
        )),
        Payload::ApprovalRequest {
            approval_id,
            node_execution_id,
            role_id,
            action,
            submission,
        } => {
            let command = ApprovalCommand::new(
                opaque(approval_id)?, opaque(node_execution_id)?, opaque(role_id)?, action,
            );
            CommandPayload::ApprovalRequest(match submission {
                Some(reference) => {
                    let bytes = contents.read(ContentScope::Run { team, run }, &reference)?;
                    command.with_submission(serde_json::from_slice(&bytes).map_err(|_| StoreFault::CorruptRecord)?)
                }
                None => command,
            })
        }
    })
}

fn restore_definition(
    team: &TeamId,
    run: &GraphRunId,
    value: serde_json::Value,
    contents: &ContentStore,
) -> Result<crate::GraphDefinition, StoreFault> {
    let row = serde_json::from_value(value).map_err(|_| StoreFault::CorruptRecord)?;
    super::definition::restore_definition(row, team, run, contents)
}

fn encode_operation(operation: &GraphPatchOperation) -> Operation {
    match operation {
        GraphPatchOperation::AddNode {
            node_id,
            kind,
            role_id,
        } => Operation::AddNode {
            node_id: node_id.clone(),
            kind: *kind,
            role_id: role_id.clone(),
        },
        GraphPatchOperation::ReplaceNode {
            node_id,
            kind,
            role_id,
        } => Operation::ReplaceNode {
            node_id: node_id.clone(),
            kind: *kind,
            role_id: role_id.clone(),
        },
        GraphPatchOperation::RemoveNode { node_id } => Operation::RemoveNode {
            node_id: node_id.clone(),
        },
        GraphPatchOperation::AddEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action,
        } => Operation::AddEdge {
            edge_id: edge_id.clone(),
            source_node_id: source_node_id.clone(),
            target_node_id: target_node_id.clone(),
            action: action.map(Into::into),
        },
        GraphPatchOperation::ReplaceEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action,
        } => Operation::ReplaceEdge {
            edge_id: edge_id.clone(),
            source_node_id: source_node_id.clone(),
            target_node_id: target_node_id.clone(),
            action: action.map(Into::into),
        },
        GraphPatchOperation::RemoveEdge { edge_id } => Operation::RemoveEdge {
            edge_id: edge_id.clone(),
        },
        GraphPatchOperation::SetReworkLimit {
            source_node_id,
            source_port,
            max_reworks,
        } => Operation::SetReworkLimit {
            source_node_id: source_node_id.clone(),
            source_port: source_port.clone(),
            max_reworks: *max_reworks,
        },
        GraphPatchOperation::SetNodePosition { node_id, x, y } => Operation::SetNodePosition {
            node_id: node_id.clone(),
            x: *x,
            y: *y,
        },
        GraphPatchOperation::SetMetadata { key, value } => Operation::SetMetadata {
            key: key.as_str().to_owned(),
            value: Metadata::from_domain(value),
        },
    }
}

fn decode_operation(operation: Operation) -> Result<GraphPatchOperation, StoreFault> {
    Ok(match operation {
        Operation::AddNode {
            node_id,
            kind,
            role_id,
        } => GraphPatchOperation::AddNode {
            node_id,
            kind,
            role_id,
        },
        Operation::ReplaceNode {
            node_id,
            kind,
            role_id,
        } => GraphPatchOperation::ReplaceNode {
            node_id,
            kind,
            role_id,
        },
        Operation::RemoveNode { node_id } => GraphPatchOperation::RemoveNode { node_id },
        Operation::AddEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action,
        } => GraphPatchOperation::AddEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action: action.map(Into::into),
        },
        Operation::ReplaceEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action,
        } => GraphPatchOperation::ReplaceEdge {
            edge_id,
            source_node_id,
            target_node_id,
            action: action.map(Into::into),
        },
        Operation::RemoveEdge { edge_id } => GraphPatchOperation::RemoveEdge { edge_id },
        Operation::SetReworkLimit {
            source_node_id,
            source_port,
            max_reworks,
        } => GraphPatchOperation::SetReworkLimit {
            source_node_id,
            source_port,
            max_reworks,
        },
        Operation::SetNodePosition { node_id, x, y } => {
            GraphPatchOperation::SetNodePosition { node_id, x, y }
        }
        Operation::SetMetadata { key, value } => GraphPatchOperation::SetMetadata {
            key: opaque(key)?,
            value: value.into_domain()?,
        },
    })
}

pub(crate) fn encode_event(team: &TeamId, event: &TeamEvent) -> Result<StoredRecord, StoreFault> {
    let payload = match event.payload() {
        TeamEventPayload::GraphPatchAccepted {
            base_graph_id,
            base_workflow_plan_id,
            operation_count,
        } => EventPayload::GraphPatchAccepted {
            base_graph_id: base_graph_id.clone(),
            base_workflow_plan_id: base_workflow_plan_id.clone(),
            operation_count: operation_count.get(),
        },
        TeamEventPayload::ReworkContinued {
            batch_id,
            source_node_id,
            source_port,
            source_node_execution_id,
            max_reworks,
            expected_graph_version,
        } => EventPayload::ReworkContinued {
            batch_id: *batch_id,
            source_node_id: source_node_id.clone(),
            source_port: source_port.clone(),
            source_node_execution_id: source_node_execution_id.clone(),
            max_reworks: *max_reworks,
            expected_graph_version: expected_graph_version.clone(),
        },
        TeamEventPayload::GraphReplaced {
            graph_id,
            workflow_plan_id,
        } => EventPayload::GraphReplaced {
            graph_id: graph_id.clone(),
            workflow_plan_id: workflow_plan_id.clone(),
        },
        TeamEventPayload::NodeProgressed { node_execution_id } => EventPayload::NodeProgressed {
            node_execution_id: node_execution_id.as_str().to_owned(),
        },
        TeamEventPayload::ApprovalRequested {
            approval_id,
            node_execution_id,
            role_id,
            action,
        } => EventPayload::ApprovalRequested {
            approval_id: approval_id.as_str().to_owned(),
            node_execution_id: node_execution_id.as_str().to_owned(),
            role_id: role_id.as_str().to_owned(),
            action: *action,
        },
        TeamEventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } => EventPayload::ApprovalResolved {
            approval_id: approval_id.as_str().to_owned(),
            decision: *decision,
            status: *status,
        },
    };
    let row = EventRow {
        team_id: team.as_str().to_owned(),
        event_id: event.event_id().to_owned(),
        run_id: event.run_id().to_owned(),
        sequence: event.sequence(),
        event_type: event.event_type(),
        payload,
        causation_id: event.causation_id().to_owned(),
        idempotency_key: event.idempotency_key().to_owned(),
        created_at: event.created_at(),
    };
    stored(RecordKind::Event, team, &row.run_id, &row.event_id, &row)
}

pub(crate) fn decode_event(record: &StoredRecord) -> Result<TeamEvent, StoreFault> {
    let row: EventRow = read(record)?;
    check_key(
        record,
        RecordKind::Event,
        &row.team_id,
        &row.run_id,
        &row.event_id,
    )?;
    let (event_type, payload) = match row.payload {
        EventPayload::GraphPatchAccepted {
            base_graph_id,
            base_workflow_plan_id,
            operation_count,
        } => (
            TeamEventType::GraphPatchAccepted,
            TeamEventPayload::GraphPatchAccepted {
                base_graph_id,
                base_workflow_plan_id,
                operation_count: nonzero(operation_count)?,
            },
        ),
        EventPayload::ReworkContinued {
            batch_id,
            source_node_id,
            source_port,
            source_node_execution_id,
            max_reworks,
            expected_graph_version,
        } => (
            TeamEventType::ReworkContinued,
            TeamEventPayload::ReworkContinued {
                batch_id,
                source_node_id,
                source_port,
                source_node_execution_id,
                max_reworks,
                expected_graph_version,
            },
        ),
        EventPayload::GraphReplaced {
            graph_id,
            workflow_plan_id,
        } => (
            TeamEventType::GraphReplaced,
            TeamEventPayload::GraphReplaced {
                graph_id,
                workflow_plan_id,
            },
        ),
        EventPayload::NodeProgressed { node_execution_id } => (
            TeamEventType::NodeProgressed,
            TeamEventPayload::NodeProgressed {
                node_execution_id: opaque(node_execution_id)?,
            },
        ),
        EventPayload::ApprovalRequested {
            approval_id,
            node_execution_id,
            role_id,
            action,
        } => (
            TeamEventType::ApprovalRequested,
            TeamEventPayload::ApprovalRequested {
                approval_id: opaque(approval_id)?,
                node_execution_id: opaque(node_execution_id)?,
                role_id: opaque(role_id)?,
                action,
            },
        ),
        EventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } => {
            if decision.status() != status {
                return Err(StoreFault::InvalidFacts);
            }
            (
                TeamEventType::ApprovalResolved,
                TeamEventPayload::ApprovalResolved {
                    approval_id: opaque(approval_id)?,
                    decision,
                    status,
                },
            )
        }
    };
    if row.event_type != event_type {
        return Err(StoreFault::InvalidFacts);
    }
    Ok(TeamEvent::from_durable(TeamEventDurableInput {
        event_id: opaque(row.event_id)?,
        run_id: opaque(row.run_id)?,
        sequence: nonzero(row.sequence)?,
        event_type,
        payload,
        causation_id: opaque(row.causation_id)?,
        idempotency_key: opaque(row.idempotency_key)?,
        created_at: row.created_at,
    }))
}

fn stored(
    kind: RecordKind,
    team: &TeamId,
    run: &str,
    id: &str,
    row: &impl Serialize,
) -> Result<StoredRecord, StoreFault> {
    Ok(StoredRecord {
        key: RecordKey {
            kind,
            scope: run.to_owned(),
            id: id.to_owned(),
        },
        team_id: Some(team.as_str().to_owned()),
        run_id: Some(run.to_owned()),
        payload: serde_json::to_vec(row).map_err(|_| StoreFault::InvalidFacts)?,
    })
}

fn check_key(
    record: &StoredRecord,
    kind: RecordKind,
    team: &str,
    run: &str,
    id: &str,
) -> Result<TeamId, StoreFault> {
    if record.key.kind != kind
        || record.key.scope != run
        || record.key.id != id
        || record.team_id.as_deref() != Some(team)
        || record.run_id.as_deref() != Some(run)
    {
        return Err(StoreFault::CorruptRecord);
    }
    TeamId::try_new(team).map_err(|_| StoreFault::InvalidFacts)
}

fn read<T: DeserializeOwned>(record: &StoredRecord) -> Result<T, StoreFault> {
    serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)
}

fn opaque(value: String) -> Result<OpaqueId, StoreFault> {
    OpaqueId::try_new(value).map_err(|_| StoreFault::InvalidFacts)
}

fn nonzero(value: u64) -> Result<NonZeroU64, StoreFault> {
    NonZeroU64::new(value).ok_or(StoreFault::InvalidFacts)
}
