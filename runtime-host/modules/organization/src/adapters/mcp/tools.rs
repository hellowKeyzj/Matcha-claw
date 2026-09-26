use std::{
    num::NonZeroU32,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::mcp::arguments::{
    array, optional_string, require_exact_keys, require_required_keys, required_string,
};
use platform::mcp::{ToolCallError, ToolCallOutcome, ToolProvider};
use serde_json::{Map, Value, json};

use crate::{
    AttemptStatus, EdgeAction, EdgeDefinition, EdgeId, GraphPatchOperation, GraphStatus,
    NodeDefinition, NodeId, NodeKind, WorkAssignment, run::NodePosition,
};

use super::team_run::{
    TeamApprovalDecision, TeamApprovalResolutionCommand, TeamApprovalResolutionOutcome,
    TeamDecisionSubmitCommand, TeamEvidenceRecordCommand, TeamEvidenceRecordOutcome,
    TeamEvidenceReferenceKind, TeamGraphContextOutcome, TeamGraphContextRequest,
    TeamGraphContextRequestView, TeamGraphPatchCommand, TeamNodeEventCommand,
    TeamNodeEventCommandKind, TeamNodeEventOutcome as TeamRunMcpNodeEventOutcome,
    TeamNodeEventOutcomeKind, TeamNodeTerminalResolution, TeamRunMcpError, TeamRunMcpFacade,
};

impl ToolProvider for TeamRunMcpFacade {
    fn tools(&self) -> Vec<Value> {
        vec![
            node_event_tool(),
            approval_resolve_tool(),
            graph_patch_tool(),
            graph_context_tool(),
            decision_submit_tool(),
            evidence_record_tool(),
        ]
    }

    fn call(&mut self, name: &str, arguments: &Map<String, Value>) -> Option<ToolCallOutcome> {
        Some(match name {
            "team_graph_context" => team_graph_context(self, arguments),
            "team_graph_patch" => team_graph_patch(self, arguments),
            "team_node_event" => team_node_event(self, arguments),
            "team_approval_resolve" => team_approval_resolve(self, arguments),
            "team_run_decision_submit" => team_run_decision_submit(self, arguments),
            "team_evidence_record" => team_evidence_record(self, arguments),
            _ => return None,
        })
    }
}

fn team_graph_context(
    facade: &TeamRunMcpFacade,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    require_exact_keys(arguments, &["teamId", "runId", "view", "nodeExecutionId"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    let view = match required_string(arguments, "view").map_err(|_| ToolCallError::InvalidParams)? {
        "current_node" => TeamGraphContextRequestView::CurrentNode,
        "graph_summary" => TeamGraphContextRequestView::GraphSummary,
        _ => return Err(ToolCallError::InvalidParams),
    };
    let request = TeamGraphContextRequest::try_new(
        required_string(arguments, "teamId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "runId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        view,
        optional_string(arguments, "nodeExecutionId").map_err(|_| ToolCallError::InvalidParams)?,
    )
    .map_err(map_facade_error)?;
    let outcome = facade.graph_context(request).map_err(map_facade_error)?;
    Ok(context_outcome(outcome))
}

fn team_graph_patch(
    facade: &mut TeamRunMcpFacade,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    require_exact_keys(
        arguments,
        &[
            "runId",
            "commandId",
            "idempotencyKey",
            "baseGraphId",
            "baseWorkflowPlanId",
            "operations",
        ],
    )
    .map_err(|_| ToolCallError::InvalidParams)?;
    let request = TeamGraphPatchCommand::try_new(
        required_string(arguments, "runId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "commandId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "idempotencyKey")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "baseGraphId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "baseWorkflowPlanId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        array(arguments, "operations")
            .map_err(|_| ToolCallError::InvalidParams)?
            .iter()
            .map(parse_graph_patch_operation)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ToolCallError::InvalidParams)?,
        now_seconds()?,
    )
    .map_err(map_facade_error)?;
    let outcome = facade.graph_patch(request).map_err(map_facade_error)?;
    Ok(
        json!({ "accepted": outcome.accepted(), "replayed": outcome.replayed(), "sequence": outcome.sequence() }),
    )
}

fn team_node_event(
    facade: &mut TeamRunMcpFacade,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    require_exact_keys(
        arguments,
        &[
            "runId",
            "commandId",
            "idempotencyKey",
            "nodeExecutionId",
            "roleId",
            "event",
            "approvalAction",
            "deliveryId",
            "receipt",
            "nodeId",
            "attemptNumber",
            "summary",
            "outputPort",
        ],
    )
    .and_then(|_| {
        let event = required_string(arguments, "event")?;
        let terminal = matches!(event, "complete" | "reject");
        if terminal {
            require_required_keys(
                arguments,
                &[
                    "deliveryId",
                    "receipt",
                    "nodeId",
                    "attemptNumber",
                    "summary",
                    "outputPort",
                ],
            )?;
        }
        Ok(())
    })
    .map_err(|_| ToolCallError::InvalidParams)?;
    let event =
        match required_string(arguments, "event").map_err(|_| ToolCallError::InvalidParams)? {
            "progress" => TeamNodeEventCommandKind::progress(),
            "request_input" => TeamNodeEventCommandKind::request_input(),
            "request_approval" => TeamNodeEventCommandKind::request_approval(
                approval_action(arguments).map_err(|_| ToolCallError::InvalidParams)?,
            ),
            "complete" => TeamNodeEventCommandKind::complete(),
            "reject" => TeamNodeEventCommandKind::reject(),
            _ => return Err(ToolCallError::InvalidParams),
        };
    let terminal_resolution = if event.is_terminal() {
        Some(TeamNodeTerminalResolution::new(
            required_string(arguments, "deliveryId")
                .map_err(|_| ToolCallError::InvalidParams)?
                .to_owned(),
            required_string(arguments, "receipt")
                .map_err(|_| ToolCallError::InvalidParams)?
                .to_owned(),
            required_string(arguments, "nodeId")
                .map_err(|_| ToolCallError::InvalidParams)?
                .to_owned(),
            NonZeroU32::new(
                arguments
                    .get("attemptNumber")
                    .and_then(Value::as_u64)
                    .ok_or(ToolCallError::InvalidParams)?
                    .try_into()
                    .map_err(|_| ToolCallError::InvalidParams)?,
            )
            .ok_or(ToolCallError::InvalidParams)?,
            required_string(arguments, "summary")
                .map_err(|_| ToolCallError::InvalidParams)?
                .to_owned(),
            required_string(arguments, "outputPort")
                .map_err(|_| ToolCallError::InvalidParams)?
                .to_owned(),
        ))
    } else {
        None
    };
    let request = TeamNodeEventCommand::try_new(
        required_string(arguments, "runId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "commandId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "idempotencyKey")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "nodeExecutionId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        optional_string(arguments, "roleId").map_err(|_| ToolCallError::InvalidParams)?,
        event,
        terminal_resolution,
        now_seconds()?,
    )
    .map_err(map_facade_error)?;
    let outcome = facade.node_event(request).map_err(map_facade_error)?;
    Ok(node_event_outcome(outcome))
}

fn team_evidence_record(
    facade: &mut TeamRunMcpFacade,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    require_exact_keys(
        arguments,
        &[
            "evidenceId",
            "runId",
            "nodeExecutionId",
            "referenceKind",
            "reference",
            "label",
        ],
    )
    .and_then(|_| {
        require_required_keys(
            arguments,
            &[
                "evidenceId",
                "runId",
                "nodeExecutionId",
                "referenceKind",
                "reference",
            ],
        )
    })
    .map_err(|_| ToolCallError::InvalidParams)?;
    let reference_kind = match required_string(arguments, "referenceKind")
        .map_err(|_| ToolCallError::InvalidParams)?
    {
        "artifact" => TeamEvidenceReferenceKind::Artifact,
        _ => return Err(ToolCallError::InvalidParams),
    };
    let request = TeamEvidenceRecordCommand::try_new(
        required_string(arguments, "evidenceId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "runId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "nodeExecutionId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        reference_kind,
        required_string(arguments, "reference")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        optional_string(arguments, "label").map_err(|_| ToolCallError::InvalidParams)?,
        now_seconds()?,
    )
    .map_err(map_facade_error)?;
    let outcome = facade.record_evidence(request).map_err(map_facade_error)?;
    Ok(json!({
        "outcome": match outcome {
            TeamEvidenceRecordOutcome::Recorded => "recorded",
            TeamEvidenceRecordOutcome::Replayed => "replayed",
        }
    }))
}

fn team_run_decision_submit(
    facade: &mut TeamRunMcpFacade,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    require_exact_keys(
        arguments,
        &["runId", "stageId", "decision", "note", "idempotencyKey"],
    )
    .map_err(|_| ToolCallError::InvalidParams)?;
    let decision =
        match required_string(arguments, "decision").map_err(|_| ToolCallError::InvalidParams)? {
            "retry" => crate::TeamDecisionType::Retry,
            "proceed_degraded" => crate::TeamDecisionType::ProceedDegraded,
            "abort" => crate::TeamDecisionType::Abort,
            _ => return Err(ToolCallError::InvalidParams),
        };
    let request = TeamDecisionSubmitCommand::try_new(
        required_string(arguments, "runId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        optional_string(arguments, "stageId").map_err(|_| ToolCallError::InvalidParams)?,
        decision,
        optional_string(arguments, "note").map_err(|_| ToolCallError::InvalidParams)?,
        required_string(arguments, "idempotencyKey")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        now_seconds()?,
    )
    .map_err(map_facade_error)?;
    let outcome = facade.submit_decision(request).map_err(map_facade_error)?;
    Ok(json!({
        "outcome": if outcome.replayed() { "replayed" } else { "recorded" },
        "recorded": outcome.recorded(),
        "replayed": outcome.replayed(),
        "sequence": outcome.sequence(),
    }))
}

fn team_approval_resolve(
    facade: &mut TeamRunMcpFacade,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    require_exact_keys(
        arguments,
        &["runId", "approvalId", "decision", "note", "idempotencyKey"],
    )
    .map_err(|_| ToolCallError::InvalidParams)?;
    let decision =
        match required_string(arguments, "decision").map_err(|_| ToolCallError::InvalidParams)? {
            "approve" => TeamApprovalDecision::Approve,
            "deny" => TeamApprovalDecision::Deny,
            "abort" => TeamApprovalDecision::Abort,
            _ => return Err(ToolCallError::InvalidParams),
        };
    let request = TeamApprovalResolutionCommand::try_new(
        required_string(arguments, "runId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        required_string(arguments, "approvalId")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        decision,
        optional_string(arguments, "note").map_err(|_| ToolCallError::InvalidParams)?,
        required_string(arguments, "idempotencyKey")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        now_seconds()?,
    )
    .map_err(map_facade_error)?;
    let outcome = facade.resolve_approval(request).map_err(map_facade_error)?;
    Ok(json!({
        "outcome": match outcome {
            TeamApprovalResolutionOutcome::Recorded => "recorded",
            TeamApprovalResolutionOutcome::Replayed => "replayed",
        }
    }))
}

fn approval_resolve_tool() -> Value {
    json!({
        "name": "team_approval_resolve",
        "description": "Resolve an existing TeamRun approval receipt.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "runId": { "type": "string", "minLength": 1 },
                "approvalId": { "type": "string", "minLength": 1 },
                "decision": { "enum": ["approve", "deny", "abort"] },
                "note": { "type": ["string", "null"], "minLength": 1 },
                "idempotencyKey": { "type": "string", "minLength": 1 }
            },
            "required": ["runId", "approvalId", "decision", "idempotencyKey"]
        }
    })
}

fn graph_patch_tool() -> Value {
    json!({
        "name": "team_graph_patch",
        "description": "Apply a TeamRun graph patch.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "runId": { "type": "string", "minLength": 1 },
                "commandId": { "type": "string", "minLength": 1 },
                "idempotencyKey": { "type": "string", "minLength": 1 },
                "baseGraphId": { "type": "string", "minLength": 1 },
                "baseWorkflowPlanId": { "type": "string", "minLength": 1 },
                "operations": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "oneOf": [
                            {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "op": { "enum": ["add_node", "replace_node"] },
                                    "nodeId": { "type": "string", "minLength": 1 },
                                    "kind": { "enum": ["start", "work", "review", "human_decision", "script_review", "join", "end"] },
                                    "roleId": { "type": ["string", "null"], "minLength": 1 }
                                },
                                "required": ["op", "nodeId", "kind"]
                            },
                            {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "op": { "const": "remove_node" },
                                    "nodeId": { "type": "string", "minLength": 1 }
                                },
                                "required": ["op", "nodeId"]
                            },
                            {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "op": { "enum": ["add_edge", "replace_edge"] },
                                    "edgeId": { "type": "string", "minLength": 1 },
                                    "sourceNodeId": { "type": "string", "minLength": 1 },
                                    "targetNodeId": { "type": "string", "minLength": 1 },
                                    "action": { "enum": ["activate", "rework", "gate", "finish"] }
                                },
                                "required": ["op", "edgeId", "sourceNodeId", "targetNodeId", "action"]
                            },
                            {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "op": { "const": "remove_edge" },
                                    "edgeId": { "type": "string", "minLength": 1 }
                                },
                                "required": ["op", "edgeId"]
                            },
                            {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "op": { "const": "set_node_position" },
                                    "nodeId": { "type": "string", "minLength": 1 },
                                    "position": {
                                        "type": "object",
                                        "additionalProperties": false,
                                        "properties": {
                                            "x": { "type": "integer" },
                                            "y": { "type": "integer" }
                                        },
                                        "required": ["x", "y"]
                                    }
                                },
                                "required": ["op", "nodeId", "position"]
                            }
                        ]
                    }
                }
            },
            "required": ["runId", "commandId", "idempotencyKey", "baseGraphId", "baseWorkflowPlanId", "operations"]
        }
    })
}

fn graph_context_tool() -> Value {
    json!({
        "name": "team_graph_context",
        "description": "Read a redacted TeamRun graph context.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "teamId": { "type": "string", "minLength": 1 },
                "runId": { "type": "string", "minLength": 1 },
                "view": { "enum": ["current_node", "graph_summary"] },
                "nodeExecutionId": { "type": ["string", "null"], "minLength": 1 }
            },
            "required": ["teamId", "runId", "view"]
        }
    })
}

fn node_event_tool() -> Value {
    json!({
        "name": "team_node_event",
        "description": "Record a legacy/manual TeamRun node event. Terminal complete/reject events are accepted only as non-scheduler evidence; runtime terminal settle remains the completion path.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "runId": { "type": "string", "minLength": 1 },
                "commandId": { "type": "string", "minLength": 1 },
                "idempotencyKey": { "type": "string", "minLength": 1 },
                "nodeExecutionId": { "type": "string", "minLength": 1 },
                "roleId": { "type": ["string", "null"], "minLength": 1 },
                "event": { "enum": ["progress", "request_input", "request_approval", "complete", "reject"] },
                "approvalAction": { "enum": ["continue_node", "execute_tool", "publish_result", "external_action"] },
                "deliveryId": { "type": "string", "minLength": 1 },
                "receipt": { "type": "string", "minLength": 1 },
                "nodeId": { "type": "string", "minLength": 1 },
                "attemptNumber": { "type": "integer", "minimum": 1 },
                "summary": { "type": "string", "minLength": 1, "maxLength": 512 },
                "outputPort": { "type": "string", "minLength": 1 }
            },
            "required": ["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]
        }
    })
}

fn decision_submit_tool() -> Value {
    json!({
        "name": "team_run_decision_submit",
        "description": "Submit a TeamRun continuation decision for a paused run stage.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "runId": { "type": "string", "minLength": 1 },
                "stageId": { "type": ["string", "null"], "minLength": 1 },
                "decision": { "enum": ["retry", "proceed_degraded", "abort"] },
                "note": { "type": ["string", "null"], "minLength": 1 },
                "idempotencyKey": { "type": "string", "minLength": 1 }
            },
            "required": ["runId", "decision", "idempotencyKey"]
        }
    })
}

fn evidence_record_tool() -> Value {
    json!({
        "name": "team_evidence_record",
        "description": "Record an opaque artifact evidence reference for a current TeamRun node execution.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "evidenceId": { "type": "string", "minLength": 1 },
                "runId": { "type": "string", "minLength": 1 },
                "nodeExecutionId": { "type": "string", "minLength": 1 },
                "referenceKind": { "const": "artifact" },
                "reference": { "type": "string", "minLength": 1 },
                "label": { "type": ["string", "null"], "minLength": 1 }
            },
            "required": ["evidenceId", "runId", "nodeExecutionId", "referenceKind", "reference"]
        }
    })
}

fn context_outcome(outcome: TeamGraphContextOutcome) -> Value {
    match outcome.into_result() {
        crate::TeamGraphContextResult::Available(context) => json!({
            "outcome": "available",
            "teamId": context.team().as_str(),
            "runId": context.run().as_str(),
            "graphStatus": graph_status_value(context.graph_status()),
            "nodes": context.nodes().iter().map(|node| json!({ "nodeId": node.node_id(), "nodeExecutionId": node.node_execution_id(), "status": attempt_status_value(node.status()), "outputPort": node.output_port() })).collect::<Vec<_>>(),
            "edges": context.edges().iter().map(|edge| json!({ "edgeId": edge.edge_id(), "sourceNodeId": edge.source_node_id(), "targetNodeId": edge.target_node_id() })).collect::<Vec<_>>(),
            "pendingApprovalIds": context.pending_approval_ids(),
            "recentEventIds": context.recent_event_ids(),
        }),
        crate::TeamGraphContextResult::Unavailable => json!({ "outcome": "unavailable" }),
        crate::TeamGraphContextResult::OutcomeUnknown => json!({ "outcome": "outcome_unknown" }),
    }
}

const fn graph_status_value(status: GraphStatus) -> &'static str {
    match status {
        GraphStatus::Pending => "pending",
        GraphStatus::Ready => "ready",
        GraphStatus::Running => "running",
        GraphStatus::Waiting => "waiting",
        GraphStatus::Completed => "completed",
        GraphStatus::Failed => "failed",
        GraphStatus::Cancelled => "cancelled",
    }
}

const fn attempt_status_value(status: AttemptStatus) -> &'static str {
    match status {
        AttemptStatus::Pending => "pending",
        AttemptStatus::Ready => "ready",
        AttemptStatus::Running => "running",
        AttemptStatus::Waiting => "waiting",
        AttemptStatus::Completed => "completed",
        AttemptStatus::Failed => "failed",
        AttemptStatus::Cancelled => "cancelled",
    }
}

fn node_event_outcome(outcome: TeamRunMcpNodeEventOutcome) -> Value {
    match outcome.into_kind() {
        TeamNodeEventOutcomeKind::Progressed => json!({ "outcome": "progressed" }),
        TeamNodeEventOutcomeKind::WaitingForInput => json!({ "outcome": "waiting_for_input" }),
        TeamNodeEventOutcomeKind::ApprovalRequested => json!({ "outcome": "approval_requested" }),
        TeamNodeEventOutcomeKind::LegacyTerminalEvidence {
            summary,
            output_port,
        } => json!({
            "outcome": "legacy_terminal_evidence",
            "completionPath": "runtime_terminal_settle",
            "summary": summary,
            "outputPort": output_port,
        }),
    }
}

fn parse_graph_patch_operation(value: &Value) -> Result<GraphPatchOperation, ()> {
    let object = value.as_object().ok_or(())?;
    let op = required_string(object, "op")?;
    match op {
        "add_node" | "replace_node" => {
            require_exact_keys(object, &["op", "nodeId", "kind", "roleId"])?;
            let node_id = NodeId::new(required_string(object, "nodeId")?);
            let kind = node_kind(required_string(object, "kind")?)?;
            let node = match kind {
                NodeKind::Work => NodeDefinition::work(
                    node_id,
                    "mcp-work",
                    NonZeroU32::new(1).expect("one is non-zero"),
                    WorkAssignment::new("mcp-task", optional_string(object, "roleId")?.ok_or(())?),
                ),
                NodeKind::Start => NodeDefinition::start(
                    node_id,
                    "mcp-start",
                    NonZeroU32::new(1).expect("one is non-zero"),
                    None,
                ),
                kind => NodeDefinition::control(
                    node_id,
                    kind,
                    "mcp-control",
                    NonZeroU32::new(1).expect("one is non-zero"),
                ),
            };
            Ok(if op == "add_node" {
                GraphPatchOperation::AddNode(node)
            } else {
                GraphPatchOperation::ReplaceNode(node)
            })
        }
        "remove_node" => {
            require_exact_keys(object, &["op", "nodeId"])?;
            Ok(GraphPatchOperation::RemoveNode(NodeId::new(
                required_string(object, "nodeId")?,
            )))
        }
        "add_edge" | "replace_edge" => {
            require_exact_keys(
                object,
                &["op", "edgeId", "sourceNodeId", "targetNodeId", "action"],
            )?;
            let edge = EdgeDefinition::new(
                EdgeId::new(required_string(object, "edgeId")?),
                NodeId::new(required_string(object, "sourceNodeId")?),
                "out",
                NodeId::new(required_string(object, "targetNodeId")?),
                "in",
                edge_action(required_string(object, "action")?)?,
            );
            Ok(if op == "add_edge" {
                GraphPatchOperation::AddEdge(edge)
            } else {
                GraphPatchOperation::ReplaceEdge(edge)
            })
        }
        "remove_edge" => {
            require_exact_keys(object, &["op", "edgeId"])?;
            Ok(GraphPatchOperation::RemoveEdge(EdgeId::new(
                required_string(object, "edgeId")?,
            )))
        }
        "set_node_position" => {
            require_exact_keys(object, &["op", "nodeId", "position"])?;
            Ok(GraphPatchOperation::SetNodePosition {
                node_id: NodeId::new(required_string(object, "nodeId")?),
                position: parse_node_position(object.get("position").ok_or(())?)?,
            })
        }
        _ => Err(()),
    }
}

fn parse_node_position(value: &Value) -> Result<NodePosition, ()> {
    let object = value.as_object().ok_or(())?;
    require_exact_keys(object, &["x", "y"])?;
    Ok(NodePosition::new(
        object.get("x").and_then(Value::as_i64).ok_or(())?,
        object.get("y").and_then(Value::as_i64).ok_or(())?,
    ))
}

fn approval_action(arguments: &Map<String, Value>) -> Result<crate::ApprovalAction, ()> {
    match required_string(arguments, "approvalAction")? {
        "continue_node" => Ok(crate::ApprovalAction::ContinueNode),
        "execute_tool" => Ok(crate::ApprovalAction::ExecuteTool),
        "publish_result" => Ok(crate::ApprovalAction::PublishResult),
        "external_action" => Ok(crate::ApprovalAction::ExternalAction),
        _ => Err(()),
    }
}

fn node_kind(value: &str) -> Result<NodeKind, ()> {
    match value {
        "start" => Ok(NodeKind::Start),
        "work" => Ok(NodeKind::Work),
        "review" => Ok(NodeKind::Review),
        "human_decision" => Ok(NodeKind::HumanDecision),
        "script_review" => Ok(NodeKind::ScriptReview),
        "join" => Ok(NodeKind::Join),
        "end" => Ok(NodeKind::End),
        _ => Err(()),
    }
}

fn edge_action(value: &str) -> Result<EdgeAction, ()> {
    match value {
        "activate" => Ok(EdgeAction::Activate),
        "rework" => Ok(EdgeAction::Rework),
        "gate" => Ok(EdgeAction::Gate),
        "finish" => Ok(EdgeAction::Finish),
        _ => Err(()),
    }
}

fn now_seconds() -> Result<u64, ToolCallError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| ToolCallError::Internal)
}

const fn map_facade_error(error: TeamRunMcpError) -> ToolCallError {
    match error {
        TeamRunMcpError::Invalid => ToolCallError::InvalidParams,
        TeamRunMcpError::Unavailable => ToolCallError::Internal,
    }
}
