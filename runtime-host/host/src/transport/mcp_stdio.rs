use std::{
    io::{self, BufRead, Write},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

use crate::{
    TeamGraphContextOutcome, TeamGraphContextRequest, TeamGraphContextRequestView,
    TeamGraphPatchCommand, TeamNodeEventCommand, TeamNodeEventCommandKind, TeamNodeEventOutcome,
    TeamRunMcpError, TeamRunMcpFacade,
    composition::team_run_mcp::{
        TeamApprovalDecision, TeamApprovalResolutionCommand, TeamApprovalResolutionOutcome,
        TeamDecisionSubmitCommand, TeamEvidenceRecordCommand, TeamEvidenceRecordOutcome,
        TeamEvidenceReferenceKind, TeamNodeTerminalResolution,
    },
    transport::{
        mcp::{
            DecodeError, Framing, RequestId, decode_request, detect_framing, encode_error,
            encode_result,
        },
        mcp_tool_arguments::{
            approval_action, array, optional_string, parse_graph_patch_operation,
            require_exact_keys, require_required_keys, required_string, strict_object,
        },
    },
};

const SERVER_VERSION: &str = "0.0.0";
const INVALID_REQUEST: &str = "Invalid Request";
const PARSE_ERROR: &str = "Parse error";
const METHOD_NOT_FOUND: &str = "Method not found";
const INVALID_PARAMS: &str = "Invalid params";
const INTERNAL_ERROR: &str = "Internal error";

pub fn run<R: BufRead, W: Write>(facade: TeamRunMcpFacade, input: R, output: W) -> io::Result<()> {
    Server { facade }.run(input, output)
}

struct Server {
    facade: TeamRunMcpFacade,
}

impl Server {
    fn run<R: BufRead, W: Write>(&mut self, mut input: R, mut output: W) -> io::Result<()> {
        let mut buffer = Vec::new();
        loop {
            let mut chunk = [0_u8; 8192];
            let read = input.read(&mut chunk)?;
            if read == 0 {
                self.drain(&mut buffer, &mut output, true)?;
                return Ok(());
            }
            buffer.extend_from_slice(&chunk[..read]);
            self.drain(&mut buffer, &mut output, false)?;
        }
    }

    fn drain<W: Write>(
        &mut self,
        buffer: &mut Vec<u8>,
        output: &mut W,
        eof: bool,
    ) -> io::Result<()> {
        while let Some((framing, payload, consumed)) = next_message(buffer, eof) {
            buffer.drain(..consumed);
            let response = match payload {
                Ok(payload) => self.handle_payload(payload),
                Err(error) => encode_error(
                    Some(&RequestId::Null),
                    error.json_rpc_error_code(),
                    decode_message(error),
                ),
            };
            if let Some(response) = response {
                write_response(output, framing, &response)?;
            }
        }
        Ok(())
    }

    fn handle_payload(&mut self, payload: Vec<u8>) -> Option<Vec<u8>> {
        let request = match decode_request(&payload) {
            Ok(request) => request,
            Err(error) => {
                let id = extract_request_id(&payload);
                return encode_error(
                    id.as_ref(),
                    error.json_rpc_error_code(),
                    decode_message(error),
                );
            }
        };
        let result = match request.method() {
            "initialize" => Ok(initialize_result()),
            "notifications/initialized" => Ok(Value::Null),
            "tools/list" => Ok(tools_result()),
            "tools/call" => self.call_tool(request.params()),
            _ => Err((-32601, METHOD_NOT_FOUND)),
        };
        match result {
            Ok(value) => encode_result(request.id(), value),
            Err((code, message)) => encode_error(request.id(), code, message),
        }
    }

    fn call_tool(&mut self, params: Option<&Value>) -> Result<Value, (i32, &'static str)> {
        let params = strict_object(params).map_err(|_| invalid_params())?;
        require_exact_keys(params, &["name", "arguments"]).map_err(|_| invalid_params())?;
        let name = required_string(params, "name").map_err(|_| invalid_params())?;
        let arguments = strict_object(params.get("arguments")).map_err(|_| invalid_params())?;
        validate_argument_keys(name, arguments)?;
        let result = match name {
            "team_graph_context" => self.team_graph_context(arguments),
            "team_graph_patch" => self.team_graph_patch(arguments),
            "team_node_event" => self.team_node_event(arguments),
            "team_approval_resolve" => self.team_approval_resolve(arguments),
            "team_run_decision_submit" => self.team_run_decision_submit(arguments),
            "team_evidence_record" => self.team_evidence_record(arguments),
            _ => return Err(invalid_params()),
        }?;
        Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string(&result).expect("closed MCP result is serializable") }]
        }))
    }

    fn team_graph_context(
        &self,
        arguments: &Map<String, Value>,
    ) -> Result<Value, (i32, &'static str)> {
        require_exact_keys(arguments, &["teamId", "runId", "view", "nodeExecutionId"])
            .map_err(|_| invalid_params())?;
        let view = match required_string(arguments, "view").map_err(|_| invalid_params())? {
            "current_node" => TeamGraphContextRequestView::CurrentNode,
            "graph_summary" => TeamGraphContextRequestView::GraphSummary,
            _ => return Err(invalid_params()),
        };
        let outcome = self
            .facade
            .graph_context(TeamGraphContextRequest {
                team_id: required_string(arguments, "teamId")
                    .map_err(|_| invalid_params())?
                    .to_owned(),
                run_id: required_string(arguments, "runId")
                    .map_err(|_| invalid_params())?
                    .to_owned(),
                view,
                node_execution_id: optional_string(arguments, "nodeExecutionId")
                    .map_err(|_| invalid_params())?,
            })
            .map_err(map_facade_error)?;
        Ok(context_outcome(outcome))
    }

    fn team_graph_patch(
        &mut self,
        arguments: &Map<String, Value>,
    ) -> Result<Value, (i32, &'static str)> {
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
        .map_err(|_| invalid_params())?;
        let outcome = self
            .facade
            .graph_patch(
                TeamGraphPatchCommand {
                    run_id: required_string(arguments, "runId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    command_id: required_string(arguments, "commandId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    idempotency_key: required_string(arguments, "idempotencyKey")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    base_graph_id: required_string(arguments, "baseGraphId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    base_workflow_plan_id: required_string(arguments, "baseWorkflowPlanId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    operations: array(arguments, "operations")
                        .map_err(|_| invalid_params())?
                        .iter()
                        .map(parse_graph_patch_operation)
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| invalid_params())?,
                },
                now_seconds()?,
            )
            .map_err(map_facade_error)?;
        Ok(
            json!({ "accepted": outcome.accepted, "replayed": outcome.replayed, "sequence": outcome.sequence }),
        )
    }

    fn team_node_event(
        &mut self,
        arguments: &Map<String, Value>,
    ) -> Result<Value, (i32, &'static str)> {
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
        .map_err(|_| invalid_params())?;
        let event = match required_string(arguments, "event").map_err(|_| invalid_params())? {
            "progress" => TeamNodeEventCommandKind::Progress,
            "request_input" => TeamNodeEventCommandKind::RequestInput,
            "request_approval" => TeamNodeEventCommandKind::RequestApproval(
                approval_action(arguments).map_err(|_| invalid_params())?,
            ),
            "complete" => TeamNodeEventCommandKind::Complete,
            "reject" => TeamNodeEventCommandKind::Reject,
            _ => return Err(invalid_params()),
        };
        let outcome = self
            .facade
            .node_event(
                TeamNodeEventCommand {
                    run_id: required_string(arguments, "runId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    command_id: required_string(arguments, "commandId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    idempotency_key: required_string(arguments, "idempotencyKey")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    node_execution_id: required_string(arguments, "nodeExecutionId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    role_id: optional_string(arguments, "roleId").map_err(|_| invalid_params())?,
                    terminal_resolution: if matches!(
                        event,
                        TeamNodeEventCommandKind::Complete | TeamNodeEventCommandKind::Reject
                    ) {
                        Some(TeamNodeTerminalResolution {
                            delivery_id: required_string(arguments, "deliveryId")
                                .map_err(|_| invalid_params())?
                                .to_owned(),
                            receipt: required_string(arguments, "receipt")
                                .map_err(|_| invalid_params())?
                                .to_owned(),
                            node_id: required_string(arguments, "nodeId")
                                .map_err(|_| invalid_params())?
                                .to_owned(),
                            attempt_number: std::num::NonZeroU32::new(
                                arguments
                                    .get("attemptNumber")
                                    .and_then(Value::as_u64)
                                    .ok_or(invalid_params())?
                                    .try_into()
                                    .map_err(|_| invalid_params())?,
                            )
                            .ok_or(invalid_params())?,
                            summary: required_string(arguments, "summary")
                                .map_err(|_| invalid_params())?
                                .to_owned(),
                            output_port: required_string(arguments, "outputPort")
                                .map_err(|_| invalid_params())?
                                .to_owned(),
                        })
                    } else {
                        None
                    },
                    event,
                },
                now_seconds()?,
            )
            .map_err(map_facade_error)?;
        Ok(node_event_outcome(outcome))
    }

    fn team_evidence_record(
        &mut self,
        arguments: &Map<String, Value>,
    ) -> Result<Value, (i32, &'static str)> {
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
        .map_err(|_| invalid_params())?;
        let reference_kind =
            match required_string(arguments, "referenceKind").map_err(|_| invalid_params())? {
                "artifact" => TeamEvidenceReferenceKind::Artifact,
                _ => return Err(invalid_params()),
            };
        let outcome = self
            .facade
            .record_evidence(
                TeamEvidenceRecordCommand {
                    evidence_id: required_string(arguments, "evidenceId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    run_id: required_string(arguments, "runId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    node_execution_id: required_string(arguments, "nodeExecutionId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    reference_kind,
                    reference: required_string(arguments, "reference")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    label: optional_string(arguments, "label").map_err(|_| invalid_params())?,
                },
                now_seconds()?,
            )
            .map_err(map_facade_error)?;
        Ok(json!({
            "outcome": match outcome {
                TeamEvidenceRecordOutcome::Recorded => "recorded",
                TeamEvidenceRecordOutcome::Replayed => "replayed",
            }
        }))
    }

    fn team_run_decision_submit(
        &mut self,
        arguments: &Map<String, Value>,
    ) -> Result<Value, (i32, &'static str)> {
        require_exact_keys(
            arguments,
            &["runId", "stageId", "decision", "note", "idempotencyKey"],
        )
        .map_err(|_| invalid_params())?;
        let decision = match required_string(arguments, "decision").map_err(|_| invalid_params())? {
            "retry" => organization::TeamDecisionType::Retry,
            "proceed_degraded" => organization::TeamDecisionType::ProceedDegraded,
            "abort" => organization::TeamDecisionType::Abort,
            _ => return Err(invalid_params()),
        };
        let outcome = self
            .facade
            .submit_decision(
                TeamDecisionSubmitCommand {
                    run_id: required_string(arguments, "runId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    stage_id: optional_string(arguments, "stageId")
                        .map_err(|_| invalid_params())?,
                    decision,
                    note: optional_string(arguments, "note").map_err(|_| invalid_params())?,
                    idempotency_key: required_string(arguments, "idempotencyKey")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                },
                now_seconds()?,
            )
            .map_err(map_facade_error)?;
        Ok(json!({
            "outcome": if outcome.replayed { "replayed" } else { "recorded" },
            "recorded": outcome.recorded,
            "replayed": outcome.replayed,
            "sequence": outcome.sequence,
        }))
    }

    fn team_approval_resolve(
        &mut self,
        arguments: &Map<String, Value>,
    ) -> Result<Value, (i32, &'static str)> {
        require_exact_keys(
            arguments,
            &["runId", "approvalId", "decision", "note", "idempotencyKey"],
        )
        .map_err(|_| invalid_params())?;
        let decision = match required_string(arguments, "decision").map_err(|_| invalid_params())? {
            "approve" => TeamApprovalDecision::Approve,
            "deny" => TeamApprovalDecision::Deny,
            "abort" => TeamApprovalDecision::Abort,
            _ => return Err(invalid_params()),
        };
        let outcome = self
            .facade
            .resolve_approval(
                TeamApprovalResolutionCommand {
                    run_id: required_string(arguments, "runId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    approval_id: required_string(arguments, "approvalId")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                    decision,
                    note: optional_string(arguments, "note").map_err(|_| invalid_params())?,
                    idempotency_key: required_string(arguments, "idempotencyKey")
                        .map_err(|_| invalid_params())?
                        .to_owned(),
                },
                now_seconds()?,
            )
            .map_err(map_facade_error)?;
        Ok(json!({
            "outcome": match outcome {
                TeamApprovalResolutionOutcome::Recorded => "recorded",
                TeamApprovalResolutionOutcome::Replayed => "replayed",
            }
        }))
    }
}

fn next_message(
    buffer: &[u8],
    eof: bool,
) -> Option<(Framing, Result<Vec<u8>, DecodeError>, usize)> {
    let framing = match detect_framing(buffer) {
        Ok(Some(framing)) => framing,
        Ok(None) => {
            return eof
                .then_some((
                    Framing::JsonLines,
                    Err(DecodeError::MalformedHeader),
                    buffer.len(),
                ))
                .filter(|_| !buffer.is_empty());
        }
        Err(error) => return Some((Framing::JsonLines, Err(error), buffer.len())),
    };
    match framing {
        Framing::JsonLines => match buffer.iter().position(|byte| *byte == b'\n') {
            Some(end) => Some((
                Framing::JsonLines,
                Ok(trim_line(&buffer[..end]).to_vec()),
                end + 1,
            )),
            None if eof => Some((
                Framing::JsonLines,
                Ok(trim_line(buffer).to_vec()),
                buffer.len(),
            )),
            None => None,
        },
        Framing::ContentLength { body_bytes } => {
            let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")? + 4;
            let total = header_end.checked_add(body_bytes)?;
            if buffer.len() < total {
                return eof.then_some((framing, Err(DecodeError::MalformedJson), buffer.len()));
            }
            Some((framing, Ok(buffer[header_end..total].to_vec()), total))
        }
    }
}

fn trim_line(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn extract_request_id(payload: &[u8]) -> Option<RequestId> {
    let value = serde_json::from_slice::<Value>(payload).ok()?;
    match value.as_object()?.get("id")? {
        Value::Null => Some(RequestId::Null),
        Value::String(value) => Some(RequestId::String(value.clone())),
        Value::Number(value) => Some(RequestId::Number(value.clone())),
        _ => None,
    }
}

fn write_response<W: Write>(output: &mut W, framing: Framing, response: &[u8]) -> io::Result<()> {
    match framing {
        Framing::JsonLines => {
            output.write_all(response)?;
            output.write_all(b"\n")?;
        }
        Framing::ContentLength { .. } => {
            write!(output, "Content-Length: {}\r\n\r\n", response.len())?;
            output.write_all(response)?;
        }
    }
    output.flush()
}

fn initialize_result() -> Value {
    json!({ "protocolVersion": "2024-11-05", "capabilities": { "tools": {} }, "serverInfo": { "name": "matcha", "version": SERVER_VERSION } })
}

fn tools_result() -> Value {
    json!({ "tools": [
        node_event_tool(),
        tool("team_approval_resolve", "Resolve an existing TeamRun approval receipt."),
        tool("team_graph_patch", "Apply a TeamRun graph patch."),
        tool("team_graph_context", "Read a redacted TeamRun graph context."),
        decision_submit_tool(),
        evidence_record_tool(),
    ] })
}

fn tool(name: &'static str, description: &'static str) -> Value {
    json!({ "name": name, "description": description, "inputSchema": { "type": "object" } })
}

fn node_event_tool() -> Value {
    json!({
        "name": "team_node_event",
        "description": "Record a TeamRun node event. Terminal complete/reject events require the exact delivery, receipt, node attempt, summary, and routed output port.",
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
    match outcome {
        TeamGraphContextOutcome::Available {
            team_id,
            run_id,
            graph_status,
            nodes,
            edges,
            pending_approval_ids,
            recent_event_ids,
        } => json!({
            "outcome": "available", "teamId": team_id, "runId": run_id, "graphStatus": graph_status,
            "nodes": nodes.into_iter().map(|node| json!({ "nodeId": node.node_id, "nodeExecutionId": node.node_execution_id, "status": node.status, "outputPort": node.output_port })).collect::<Vec<_>>(),
            "edges": edges.into_iter().map(|edge| json!({ "edgeId": edge.edge_id, "sourceNodeId": edge.source_node_id, "targetNodeId": edge.target_node_id })).collect::<Vec<_>>(),
            "pendingApprovalIds": pending_approval_ids, "recentEventIds": recent_event_ids,
        }),
        TeamGraphContextOutcome::Unavailable => json!({ "outcome": "unavailable" }),
        TeamGraphContextOutcome::OutcomeUnknown => json!({ "outcome": "outcome_unknown" }),
    }
}

fn node_event_outcome(outcome: TeamNodeEventOutcome) -> Value {
    match outcome {
        TeamNodeEventOutcome::Progressed => json!({ "outcome": "progressed" }),
        TeamNodeEventOutcome::WaitingForInput => json!({ "outcome": "waiting_for_input" }),
        TeamNodeEventOutcome::ApprovalRequested => json!({ "outcome": "approval_requested" }),
        TeamNodeEventOutcome::TerminalResolved {
            outcome,
            summary,
            output_port,
        } => json!({
            "outcome": outcome,
            "summary": summary,
            "outputPort": output_port,
        }),
    }
}

fn validate_argument_keys(
    tool: &str,
    arguments: &Map<String, Value>,
) -> Result<(), (i32, &'static str)> {
    let allowed = match tool {
        "team_graph_context" => &["teamId", "runId", "view", "nodeExecutionId"][..],
        "team_graph_patch" => &[
            "runId",
            "commandId",
            "idempotencyKey",
            "baseGraphId",
            "baseWorkflowPlanId",
            "operations",
        ][..],
        "team_node_event" => &[
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
        ][..],
        "team_approval_resolve" => {
            &["runId", "approvalId", "decision", "note", "idempotencyKey"][..]
        }
        "team_run_decision_submit" => {
            &["runId", "stageId", "decision", "note", "idempotencyKey"][..]
        }
        "team_evidence_record" => &[
            "evidenceId",
            "runId",
            "nodeExecutionId",
            "referenceKind",
            "reference",
            "label",
        ][..],
        _ => return Err(invalid_params()),
    };
    require_exact_keys(arguments, allowed).map_err(|_| invalid_params())
}

fn now_seconds() -> Result<u64, (i32, &'static str)> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| internal_error())
}

const fn decode_message(error: DecodeError) -> &'static str {
    match error {
        DecodeError::MalformedJson => PARSE_ERROR,
        DecodeError::HeaderTooLarge
        | DecodeError::BodyTooLarge
        | DecodeError::MalformedHeader
        | DecodeError::InvalidRequest => INVALID_REQUEST,
    }
}

const fn map_facade_error(error: TeamRunMcpError) -> (i32, &'static str) {
    match error {
        TeamRunMcpError::Invalid => invalid_params(),
        TeamRunMcpError::Unavailable => internal_error(),
    }
}

const fn invalid_params() -> (i32, &'static str) {
    (-32602, INVALID_PARAMS)
}
const fn internal_error() -> (i32, &'static str) {
    (-32603, INTERNAL_ERROR)
}
