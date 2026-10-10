use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::mcp::arguments;
use serde_json::{Map, Value, json};

use super::{
    design::DesignOperation,
    team_runtime::{GraphPatchDraftOperation, decode_team_graph_patch_value},
};
use crate::{
    ApprovalDecision, EvidenceId, EvidenceRecord, EvidenceReference, EvidenceReferenceKind,
    GraphPatchOperation, GraphRunId, OrganizationHandle, RecordOutcome, RequestAdmissionClosed,
    RoleSessionIdentityResolver, TeamDecisionCommand, TeamDecisionType, TeamGraphContextQuery,
    TeamGraphContextResult, TeamGraphContextView, TeamId, TeamNodeEvent, TeamNodeEventOutcome,
    TeamNodeEventProducer,
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
    },
};

pub(crate) async fn execute(
    owner: &OrganizationHandle,
    name: &str,
    args: Value,
    resolver: Arc<dyn RoleSessionIdentityResolver>,
) -> Result<Value, RequestAdmissionClosed> {
    let Some(args) = args.as_object() else {
        return Ok(invalid());
    };
    let Some(now) = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_millis()).ok())
    else {
        return Ok(rejected());
    };
    match name {
        "team_graph_context" if args.get("view").and_then(Value::as_str) == Some("run_prompts") => {
            runtime_graph_context(owner, args).await
        }
        "team_graph_context" => graph_context(owner, args, resolver).await,
        "team_graph_patch"
            if args.get("operations").and_then(Value::as_array).is_some_and(|operations| {
                operations.iter().any(|operation| {
                    operation.get("op").and_then(Value::as_str) == Some("set_node_prompt")
                })
            }) =>
        {
            runtime_graph_patch(owner, args, now).await
        }
        "team_graph_patch" => graph_patch(owner, args, resolver).await,
        "team_node_event" => node_event(owner, args, now).await,
        "team_approval_resolve" => approval_resolve(owner, args, now).await,
        "team_run_decision_submit" => decision_submit(owner, args, now).await,
        "team_evidence_record" => evidence_record(owner, args, now).await,
        _ => Ok(invalid()),
    }
}

async fn runtime_graph_context(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
) -> Result<Value, RequestAdmissionClosed> {
    if let Err(error) = require_exact_keys(args, &["teamId", "runId", "nodeId", "nodeExecutionId", "view"]) {
        return Ok(error);
    }
    let scope = match execution_scope(args) {
        Ok(scope) => scope,
        Err(error) => return Ok(error),
    };
    Ok(owner.runtime_graph_context(scope).await?.unwrap_or_else(runtime_graph_rejected))
}

async fn runtime_graph_patch(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    now: u64,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(args, &[
            "teamId", "runId", "nodeId", "nodeExecutionId", "expectedGraphVersion", "commandId", "idempotencyKey", "operations",
        ])?;
        let version = required_string(args, "expectedGraphVersion")?;
        if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err(invalid_field("expectedGraphVersion", "Use the 64-character lowercase hexadecimal graphVersion from current context."));
        }
        let operations = args.get("operations").and_then(Value::as_array)
            .ok_or_else(|| invalid_field("operations", "Provide a nonempty array of prompt operations."))?;
        if operations.is_empty() {
            return Err(invalid_field("operations", "Provide at least one prompt operation."));
        }
        let operations = operations.iter().enumerate().map(|(index, operation)| {
            let parsed = (|| {
                let operation = operation.as_object()
                    .ok_or_else(|| invalid_field("arguments", "Provide an operation object."))?;
                if operation.get("op").and_then(Value::as_str) != Some("set_node_prompt") {
                    return Err(invalid_field("op", "Do not mix set_node_prompt with design operations; runtime patches require only set_node_prompt with nodeId and prompt at the operation level."));
                }
                require_exact_keys(operation, &["op", "nodeId", "prompt"])
                    .map_err(|_| invalid_field("arguments", "A set_node_prompt operation accepts only op, nodeId, and prompt; put nodeId and prompt directly in the operation."))?;
                Ok(crate::store::NodePromptPatch {
                    node_id: crate::NodeId::new(opaque(operation, "nodeId")?.as_str()),
                    prompt: required_string(operation, "prompt")?.to_owned(),
                })
            })();
            parsed.map_err(|mut error: Value| {
                let field = error["fieldPath"].as_str().expect("parser errors have a field path");
                error["fieldPath"] = json!(if field == "arguments" {
                    format!("operations[{index}]")
                } else {
                    format!("operations[{index}].{field}")
                });
                error
            })
        }).collect::<Result<Vec<_>, Value>>()?;
        Ok(crate::store::RuntimePromptPatch {
            command_id: opaque(args, "commandId")?,
            idempotency_key: opaque(args, "idempotencyKey")?,
            expected_graph_version: version.to_owned(),
            operations,
            created_at: now,
        })
    })();
    let patch = match parsed { Ok(value) => value, Err(error) => return Ok(error) };
    let scope = match execution_scope(args) {
        Ok(scope) => scope,
        Err(error) => return Ok(error),
    };
    Ok(owner.runtime_graph_patch(scope, patch).await?.unwrap_or_else(runtime_graph_rejected))
}

fn execution_scope(
    args: &Map<String, Value>,
) -> Result<crate::TeamRunExecutionScope, Value> {
    let team_id = TeamId::try_new(required_string(args, "teamId")?)
        .map_err(|_| invalid_field("teamId", "Use a valid team identifier from current context."))?;
    Ok(crate::TeamRunExecutionScope {
        team_id,
        run_id: GraphRunId::new(opaque(args, "runId")?.as_str()),
        node_id: crate::NodeId::new(opaque(args, "nodeId")?.as_str()),
        node_execution_id: crate::NodeExecutionId::from_durable(
            opaque(args, "nodeExecutionId")?.as_str().to_owned(),
        ),
    })
}

fn runtime_graph_rejected(fault: crate::StoreFault) -> Value {
    use crate::{StoreFault, store::RuntimeGraphError};
    let (code, message, node) = match &fault {
        StoreFault::RuntimeGraph(reason) => match reason {
            RuntimeGraphError::UnknownRun | RuntimeGraphError::TeamMismatch => (
                "runtime_context_invalid", "The team and run identifiers do not match a known run; stop runtime graph access.", None,
            ),
            RuntimeGraphError::RunInactive => (
                "run_not_active", "The run is not active and started; stop runtime graph access.", None,
            ),
            RuntimeGraphError::ExecutionInactive => (
                "execution_expired", "This node execution is no longer current and in flight; stop runtime graph access.", None,
            ),
            RuntimeGraphError::StaleGraphVersion => (
                "graph_version_mismatch", "The graph changed; read team_graph_context with view=run_prompts and recompute the patch using its graphVersion.", None,
            ),
            RuntimeGraphError::UnknownNode(node) => (
                "node_not_found", "The target node does not exist; read the current runtime graph before editing.", Some(node.as_str()),
            ),
            RuntimeGraphError::InvalidNode(node) => (
                "node_prompt_not_editable", "Only existing work and review task prompts may be changed; topology and bindings cannot be changed.", Some(node.as_str()),
            ),
            RuntimeGraphError::EmptyPrompt(node) => (
                "empty_assignment_prompt", "The task prompt must contain non-whitespace text.", Some(node.as_str()),
            ),
        },
        StoreFault::EventLedger(crate::RecordCommandError::IdempotencyConflict) => (
            "idempotency_conflict", "Replay the exact original patch or use fresh commandId and idempotencyKey for a different patch.", None,
        ),
        StoreFault::EventLedger(crate::RecordCommandError::CommandIdConflict) => (
            "command_id_conflict", "This commandId is already used; use fresh commandId and idempotencyKey for a new patch.", None,
        ),
        StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired => (
            "graph_outcome_unknown", "The patch outcome is unknown; read the current graph before deciding whether to retry.", None,
        ),
        _ => ("graph_unavailable", "The runtime graph operation could not be completed; read the current graph before retrying.", None),
    };
    design_error(code, message, node, None)
}

async fn graph_context(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    resolver: Arc<dyn RoleSessionIdentityResolver>,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(
            args,
            &[
                "teamId",
                "runId",
                "view",
                "nodeExecutionId",
                "designEpoch",
                "promptGeneration",
            ],
        )?;
        let team_id = TeamId::try_new(required_string(args, "teamId")?).map_err(|_| invalid_field("teamId", "Use a valid team identifier from current context."))?;
        let run_id = GraphRunId::new(required_string(args, "runId")?);
        let view = match required_string(args, "view")? {
            "current_node" => TeamGraphContextView::CurrentNode,
            "graph_summary" => TeamGraphContextView::GraphSummary,
            _ => return Err(invalid_field("view", "Use current_node, graph_summary, or run_prompts.")),
        };
        let node = optional_string(args, "nodeExecutionId")?;
        match (
            args.contains_key("designEpoch"),
            args.contains_key("promptGeneration"),
        ) {
            (false, false) => Ok((
                None,
                Some(TeamGraphContextQuery::new(team_id, run_id, view, node).map_err(|error| {
                    use crate::run::context::TeamGraphContextQueryError as Error;
                    match error {
                        Error::InvalidContextIdentity => invalid_field("arguments", "Use bounded teamId and runId from current context."),
                        Error::InvalidNodeExecutionId | Error::NodeExecutionIdRequired => invalid_field("nodeExecutionId", "For current_node, provide the current bounded node execution identifier."),
                    }
                })?),
            )),
            (true, true) => Ok((
                Some(DesignOperation::Context {
                    team_id,
                    run_id,
                    epoch: required_string(args, "designEpoch")?.to_owned(),
                    generation: required_string(args, "promptGeneration")?.to_owned(),
                }),
                None,
            )),
            _ => Err(invalid_field("arguments", "Provide designEpoch and promptGeneration together, or omit both for non-design context.")),
        }
    })();
    let (design, query) = match parsed { Ok(value) => value, Err(error) => return Ok(error) };
    if let Some(operation) = design {
        return Ok(owner
            .design_operation(operation, resolver)
            .await?
            .unwrap_or_else(design_rejected));
    }
    Ok(context_result(
        owner
            .graph_context(query.expect("running context has a query"))
            .await?,
    ))
}

async fn graph_patch(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    resolver: Arc<dyn RoleSessionIdentityResolver>,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(
            args,
            &[
                "teamId",
                "runId",
                "designEpoch",
                "promptGeneration",
                "expectedGraphVersion",
                "commandId",
                "idempotencyKey",
                "baseGraphId",
                "baseWorkflowPlanId",
                "operations",
            ],
        )?;
        let team_id = TeamId::try_new(required_string(args, "teamId")?)
            .map_err(|_| invalid_field("teamId", "Use a valid team identifier from current context."))?;
        let run_id = opaque(args, "runId")?;
        let epoch = required_string(args, "designEpoch")?.to_owned();
        let generation = required_string(args, "promptGeneration")?.to_owned();
        let version = required_string(args, "expectedGraphVersion")?;
        if version.len() != 64
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid_field("expectedGraphVersion", "Use the 64-character lowercase hexadecimal graphVersion from current context."));
        }
        required_string(args, "baseGraphId")?;
        required_string(args, "baseWorkflowPlanId")?;
        let patch = decode_team_graph_patch_value(
            &Value::Object(args.clone()),
            GraphRunId::new(run_id.as_str()),
            run_id,
            opaque(args, "commandId")?,
            opaque(args, "idempotencyKey")?,
        )
        .map_err(|error| match error {
            super::team_runtime::TeamRuntimeDecodeError::GraphDefinition(reason) => {
                definition_rejected(&reason)
            }
            super::team_runtime::TeamRuntimeDecodeError::InvalidField { field_path, message } => invalid_field(&field_path, message),
            _ => invalid_field("operations", "Check graph operations against the tool schema."),
        })?;
        if patch.operations.iter().any(|operation| {
            matches!(
                operation,
                GraphPatchDraftOperation::Graph(GraphPatchOperation::SetNodePosition { .. })
            )
        }) {
            return Err(invalid_field("operations", "MCP graph patches cannot set layout positions; omit set_node_position."));
        }
        Ok(DesignOperation::Patch {
            team_id,
            epoch,
            generation: Some(generation),
            version: version.to_owned(),
            patch,
        })
    })();
    let operation = match parsed {
        Ok(operation) => operation,
        Err(error) => return Ok(error),
    };
    Ok(owner
        .design_operation(operation, resolver)
        .await?
        .unwrap_or_else(design_rejected))
}

async fn node_event(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    now: u64,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(
            args,
            &[
                "runId",
                "commandId",
                "idempotencyKey",
                "nodeExecutionId",
                "roleId",
                "event",
                "approvalAction",
            ],
        )?;
        let run_id = opaque(args, "runId")?;
        let command_id = opaque(args, "commandId")?;
        let idempotency_key = opaque(args, "idempotencyKey")?;
        let node = opaque(args, "nodeExecutionId")?;
        let role = optional_string(args, "roleId")?
            .map(OpaqueId::try_new)
            .transpose()
            .map_err(|_| invalid_field("roleId", "Use a bounded role identifier from current context."))?;
        let event = match required_string(args, "event")? {
            "progress" => TeamNodeEvent::progress(node, role),
            "request_input" => TeamNodeEvent::request_input(node, role),
            "request_approval" => {
                let action = match required_string(args, "approvalAction")? {
                    "continue_node" => crate::ApprovalAction::ContinueNode,
                    "execute_tool" => crate::ApprovalAction::ExecuteTool,
                    "publish_result" => crate::ApprovalAction::PublishResult,
                    "external_action" => crate::ApprovalAction::ExternalAction,
                    _ => return Err(invalid_field("approvalAction", "Use continue_node, execute_tool, publish_result, or external_action.")),
                };
                TeamNodeEvent::request_approval(node, role, action)
            }
            _ => return Err(invalid_field("event", "Use progress, request_input, or request_approval; terminal results use runtime receipts.")),
        };
        TeamNodeEventProducer::non_terminal(run_id, command_id, idempotency_key, event, now)
            .map_err(|_| invalid_field("arguments", "For request_approval, provide roleId and a bounded idempotencyKey short enough for the generated approval identifier."))
    })();
    let event = match parsed { Ok(value) => value, Err(error) => return Ok(error) };
    let (command, event) = event.into_parts();
    Ok(match owner.node_event(command, event).await? {
        Ok(TeamNodeEventOutcome::Progressed) => json!({"outcome":"progressed"}),
        Ok(TeamNodeEventOutcome::WaitingForInput) => json!({"outcome":"waiting_for_input"}),
        Ok(TeamNodeEventOutcome::ApprovalRequested) => json!({"outcome":"approval_requested"}),
        Ok(TeamNodeEventOutcome::TerminalReceiptRequired) | Err(_) => rejected(),
    })
}

async fn approval_resolve(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    now: u64,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(
            args,
            &["runId", "approvalId", "decision", "note", "idempotencyKey"],
        )?;
        let decision = match required_string(args, "decision")? {
            "approve" => ApprovalDecision::Approve,
            "deny" => ApprovalDecision::Deny,
            "abort" => ApprovalDecision::Abort,
            _ => return Err(invalid_field("decision", "Use approve, deny, or abort.")),
        };
        HumanDecisionCommand::new(
            GraphRunId::new(opaque(args, "runId")?.as_str()),
            opaque(args, "approvalId")?,
            decision,
            optional_string(args, "note")?.map(|note| note.trim().to_owned()),
            opaque(args, "idempotencyKey")?,
            now,
        )
        .map_err(|_| invalid_field("note", "Omit note or provide nonblank text no longer than 256 bytes."))
    })();
    let command = match parsed { Ok(value) => value, Err(error) => return Ok(error) };
    Ok(match owner.approval_resolve(command).await? {
        Ok(HumanDecisionOutcome::Recorded) => json!({"outcome":"recorded"}),
        Ok(HumanDecisionOutcome::Replayed) => json!({"outcome":"replayed"}),
        Err(crate::StoreFault::InvalidFacts) => design_error(
            "approval_rejected", "The approval decision was rejected; read the current approval before retrying.", None, None,
        ),
        Err(_) => json!({
            "success": false, "outcome": "outcome_unknown", "errorCode": "approval_outcome_unknown",
            "error": "The approval outcome is unknown; read the current approval before retrying.",
        }),
    })
}

async fn decision_submit(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    now: u64,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(
            args,
            &["runId", "stageId", "decision", "note", "idempotencyKey"],
        )?;
        let decision = match required_string(args, "decision")? {
            "retry" => TeamDecisionType::Retry,
            "proceed_degraded" => TeamDecisionType::ProceedDegraded,
            "abort" => TeamDecisionType::Abort,
            _ => return Err(invalid_field("decision", "Use retry, proceed_degraded, or abort.")),
        };
        let idempotency = required_string(args, "idempotencyKey")?;
        TeamDecisionCommand::try_new(
            format!("team-decision-{idempotency}"),
            required_string(args, "runId")?,
            optional_string(args, "stageId")?.unwrap_or_else(|| "run".to_owned()),
            decision,
            optional_string(args, "note")?,
            idempotency,
            now,
        )
        .map_err(|error| {
            use crate::run::decision::TeamDecisionCommandError as Error;
            match error {
                Error::InvalidDecisionId | Error::InvalidIdempotencyKey => invalid_field("idempotencyKey", "Use a bounded identifier short enough for the generated decision identifier."),
                Error::InvalidRunId => invalid_field("runId", "Use a bounded run identifier from current context."),
                Error::InvalidStageId => invalid_field("stageId", "Omit stageId or use a bounded stage identifier."),
                Error::InvalidNote => invalid_field("note", "Omit note or provide nonblank text no longer than 256 bytes."),
            }
        })
    })();
    let command = match parsed { Ok(value) => value, Err(error) => return Ok(error) };
    Ok(match owner.decision_submit(command).await? {
        Ok(receipt) => json!({
            "outcome": if receipt.is_replay() { "replayed" } else { "recorded" },
            "recorded": !receipt.is_replay(), "replayed": receipt.is_replay(),
            "sequence": receipt.decision().sequence(),
        }),
        Err(_) => rejected(),
    })
}

async fn evidence_record(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    now: u64,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(
            args,
            &[
                "evidenceId",
                "runId",
                "nodeExecutionId",
                "referenceKind",
                "reference",
                "label",
            ],
        )?;
        if required_string(args, "referenceKind")? != "artifact" {
            return Err(invalid_field("referenceKind", "Use artifact for an opaque artifact reference."));
        }
        let reference = EvidenceReference::opaque(
            EvidenceReferenceKind::Artifact,
            opaque(args, "reference")?.as_str(),
            optional_string(args, "label")?
                .map(OpaqueId::try_new)
                .transpose()
                .map_err(|_| invalid_field("label", "Omit label or use a bounded opaque identifier."))?
                .map(|label| label.as_str().to_owned()),
        )
        .map_err(|error| {
            use crate::EvidenceReferenceError as Error;
            match error {
                Error::BlankReference | Error::ReferenceTooLong => invalid_field("reference", "Use a nonblank artifact reference no longer than 128 bytes."),
                Error::BlankLabel | Error::LabelTooLong => invalid_field("label", "Omit label or use nonblank text no longer than 128 bytes."),
            }
        })?;
        EvidenceRecord::new(
            EvidenceId::new(opaque(args, "evidenceId")?.as_str()).map_err(|_| invalid_field("evidenceId", "Use a bounded evidence identifier."))?,
            opaque(args, "runId")?.as_str(),
            opaque(args, "nodeExecutionId")?.as_str(),
            reference,
            now,
        )
        .map_err(|error| match error {
            crate::EvidenceRecordError::BlankRunId => invalid_field("runId", "Use a bounded run identifier."),
            crate::EvidenceRecordError::BlankNodeExecutionId => invalid_field("nodeExecutionId", "Use a bounded node execution identifier."),
        })
    })();
    let record = match parsed { Ok(value) => value, Err(error) => return Ok(error) };
    Ok(match owner.record_evidence(record).await? {
        Ok(RecordOutcome::Recorded(_)) => json!({"outcome":"recorded"}),
        Ok(RecordOutcome::Replayed(_)) => json!({"outcome":"replayed"}),
        Ok(RecordOutcome::ConflictingEvidenceId { .. })
        | Err(crate::StoreFault::InvalidFacts | crate::StoreFault::Evidence(_)) => invalid(),
        Err(_) => rejected(),
    })
}

fn opaque(args: &Map<String, Value>, key: &'static str) -> Result<OpaqueId, Value> {
    OpaqueId::try_new(required_string(args, key)?)
        .map_err(|_| invalid_field(key, "Use a bounded opaque identifier from the current context."))
}

fn required_string<'a>(args: &'a Map<String, Value>, key: &'static str) -> Result<&'a str, Value> {
    arguments::required_string(args, key)
        .map_err(|_| invalid_field(key, "Provide a nonempty string."))
}

fn optional_string(args: &Map<String, Value>, key: &'static str) -> Result<Option<String>, Value> {
    arguments::optional_string(args, key)
        .map_err(|_| invalid_field(key, "Omit this field, use null, or provide a nonempty string."))
}

fn require_exact_keys(args: &Map<String, Value>, allowed: &[&str]) -> Result<(), Value> {
    arguments::require_exact_keys(args, allowed)
        .map_err(|_| invalid_field("arguments", "Remove unsupported fields; use only fields listed in this tool's input schema."))
}

fn invalid_field(field: &str, message: &'static str) -> Value {
    json!({"success":false,"error":message,"errorCode":"invalid_params","fieldPath":field})
}

fn invalid() -> Value {
    invalid_field("arguments", "Check the tool parameters against its input schema and current context.")
}

fn rejected() -> Value {
    json!({"success":false,"error":"Team tool request was rejected"})
}

pub(crate) fn design_rejected(fault: crate::StoreFault) -> Value {
    use crate::{StoreFault, store::DesignError};
    let (code, message, node) = match &fault {
        StoreFault::Design(reason) => match reason {
            DesignError::UnknownRun => (
                "design_run_not_found",
                "Run not found; use the teamId and runId from the current design context.",
                None,
            ),
            DesignError::TeamMismatch => (
                "design_team_mismatch",
                "The run does not belong to this team; use the exact teamId and runId from the current design context.",
                None,
            ),
            DesignError::NotDesigning => (
                "not_designing",
                "The run is not in a design phase; enter workflow design before changing or starting the workflow.",
                None,
            ),
            DesignError::RunInactive => (
                "run_not_active",
                "The run is no longer active; select an active run before starting.",
                None,
            ),
            DesignError::StaleEpoch => (
                "stale_design_epoch",
                "The design epoch is stale; stop using this stale design context and obtain the latest leader design context.",
                None,
            ),
            DesignError::StaleGeneration => (
                "stale_prompt_generation",
                "The prompt generation is no longer current; stop this patch sequence and wait for the latest leader design context supplied by the system.",
                None,
            ),
            DesignError::StaleGraphVersion => (
                "graph_version_mismatch",
                "The graph changed; refresh the current graph and retry with its graphVersion.",
                None,
            ),
            DesignError::UnknownTeam => (
                "design_team_not_found",
                "The design team is unavailable; reopen the team before continuing.",
                None,
            ),
            DesignError::MissingStartOrEnd => (
                "missing_start_or_end",
                "The workflow needs a Start node and an End node; add the missing node before starting.",
                None,
            ),
            DesignError::IncompletePath(node) => (
                "incomplete_execution_path",
                "The node needs a forward path from Start to End; connect the workflow before starting.",
                Some(node.as_str()),
            ),
            DesignError::MissingAssignment(node) => (
                "missing_assignment",
                "The node needs an assignment; set roleId and a nonempty config.prompt with a matching config.sessionRef from the current context roles.",
                Some(node.as_str()),
            ),
            DesignError::EmptyPrompt(node) => (
                "empty_assignment_prompt",
                "The node's assignment prompt is empty; provide a nonempty config.prompt.",
                Some(node.as_str()),
            ),
            DesignError::UnknownRole(node) => (
                "assignment_role_not_found",
                "The node's roleId is not a team role; choose a roleId from the current context roles.",
                Some(node.as_str()),
            ),
            DesignError::SessionBindingMismatch(node) => (
                "assignment_session_mismatch",
                "No current run binding matches this node's roleId and config.sessionRef selection; refresh context.roles and choose a matching pair. Omit config.sessionRef only when that role has exactly one binding.",
                Some(node.as_str()),
            ),
            DesignError::SessionBindingAmbiguous(node) => (
                "assignment_session_ambiguous",
                "This role has multiple bindings in the current run; read context.roles and explicitly set config.sessionRef to the intended binding for this role.",
                Some(node.as_str()),
            ),
        },
        StoreFault::GraphPatch(source) => return graph_patch_rejected(source),
        StoreFault::ControlExecution(source) => return control_execution_rejected(source),
        StoreFault::GraphReduce(source) => return graph_reduce_rejected(source),
        StoreFault::ReadySchedule(crate::run::scheduler::ReadyScheduleError::StaleReadyQueue(node)) => (
            "stale_ready_queue",
            "The node's ready state is stale; refresh this run before retrying scheduling.",
            Some(node.as_str()),
        ),
        StoreFault::ReadySchedule(_) => (
            "invalid_parallel_limit",
            "Scheduling capacity is inconsistent; check this run's parallel execution limit before retrying.",
            None,
        ),
        StoreFault::GraphPatchInput(_) => (
            "invalid_patch_identity",
            "The patch audit identity is invalid; use the current graphId/workflowPlanId and bounded opaque commandId/idempotencyKey.",
            None,
        ),
        StoreFault::EventLedger(crate::RecordCommandError::IdempotencyConflict) => (
            "idempotency_conflict",
            "This idempotencyKey is already bound to a different command or payload; replay the exact original request or use fresh commandId and idempotencyKey for a new patch.",
            None,
        ),
        StoreFault::EventLedger(crate::RecordCommandError::CommandIdConflict) => (
            "command_id_conflict",
            "This commandId is already used; use fresh commandId and idempotencyKey for a new patch.",
            None,
        ),
        StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired => (
            "design_outcome_unknown",
            "The design operation outcome is unknown; reopen and read the current graph before deciding whether to retry.",
            None,
        ),
        _ => (
            "design_unavailable",
            "The design operation could not be completed; reopen and read the current graph before retrying.",
            None,
        ),
    };
    design_error(code, message, node, None)
}

fn control_execution_rejected(reason: &crate::run::control::ControlExecutionError) -> Value {
    use crate::{
        ControlNodeResolutionError as Resolution, run::control::ControlExecutionError as Error,
    };
    let (code, message, node) = match reason {
        Error::InvalidDefinition(source) => return definition_rejected(source),
        Error::Reduce(source) => return graph_reduce_rejected(source),
        Error::GraphDefinitionMismatch => (
            "graph_definition_mismatch",
            "The execution graph does not match the saved definition; reopen this run before retrying.",
            None,
        ),
        Error::UnknownReadyNode(node) | Error::StaleReadyQueue(node) => (
            "stale_ready_queue",
            "The node's ready state is stale; refresh this run before retrying scheduling.",
            Some(node.as_str()),
        ),
        Error::OutputPortDoesNotMatchEdge { node_id } => (
            "output_port_not_connected",
            "The node's actual output has no matching edge; correct its outgoing branch using sourcePorts from the current graph.",
            Some(node_id.as_str()),
        ),
        Error::ControlResolution(source) => match source {
            Resolution::UnknownNode(node) => (
                "node_not_found",
                "The control node no longer exists; refresh this run before retrying.",
                Some(node.as_str()),
            ),
            Resolution::BlankOutputPort { node_id }
            | Resolution::UnsafeOutputPort { node_id }
            | Resolution::OutputPortDoesNotMatchEdge { node_id } => (
                "invalid_control_output_port",
                "The control output does not match this node's ports; correct its outgoing branch using the current graph.",
                Some(node_id.as_str()),
            ),
            Resolution::StaleFence { node_id }
            | Resolution::NodeNotAwaitingResolution { node_id, .. } => (
                "stale_node_execution",
                "The control node execution has changed; refresh this run rather than replaying its old result.",
                Some(node_id.as_str()),
            ),
            Resolution::UnexpectedNodeKind { node_id, .. } => (
                "unexpected_control_node_kind",
                "This node cannot handle that control result; inspect the node kind in the current graph.",
                Some(node_id.as_str()),
            ),
            Resolution::MissingScriptReviewFacts { .. } | Resolution::MissingScriptReviewRule => (
                "missing_script_review_facts",
                "The script review needs its rule and input facts before it can resolve; check the review configuration.",
                None,
            ),
            Resolution::BlankGraphRunId
            | Resolution::GraphRunMismatch
            | Resolution::GraphStateMismatch
            | Resolution::ConflictingResolution => (
                "control_resolution_conflict",
                "The control result does not match this run's current execution; refresh the run before retrying.",
                None,
            ),
        },
    };
    design_error(code, message, node, None)
}

fn graph_reduce_rejected(reason: &crate::ReduceError) -> Value {
    use crate::ReduceError as Error;
    let (code, message, node) = match reason {
        Error::InvalidDefinition(source) => return definition_rejected(source),
        Error::UnknownNode(node) => (
            "node_not_found",
            "The execution node no longer exists; refresh the current graph.",
            Some(node.as_str()),
        ),
        Error::TriggerNotArmed(node) => (
            "trigger_not_armed",
            "The Start node is not armed for this trigger; check its trigger configuration.",
            Some(node.as_str()),
        ),
        Error::StaleFence { node_id } | Error::InvalidTransition { node_id, .. } => (
            "stale_node_execution",
            "The node execution state has changed; refresh this run before retrying.",
            Some(node_id.as_str()),
        ),
        Error::AttemptLimitExceeded { node_id, .. } => (
            "attempt_limit_exceeded",
            "This node has exhausted its attempt budget; inspect its history and increase maxAttempts before requesting another attempt.",
            Some(node_id.as_str()),
        ),
        Error::StaleGraphIdentity => (
            "graph_base_mismatch",
            "The execution references an older graph; refresh this run before retrying.",
            None,
        ),
        Error::InvalidGraphPatch => (
            "invalid_graph_patch",
            "The graph change violates an execution invariant; inspect the current nodes and edges before retrying.",
            None,
        ),
        Error::InvalidSettlementEvent => (
            "invalid_settlement_event",
            "The node result cannot settle this execution; refresh the current run and inspect its node status.",
            None,
        ),
        Error::InvalidOutputPort { node_id } => (
            "invalid_node_output_port",
            "The completed result uses an output outside this node's contract; inspect its kind and sourcePorts before submitting the result again.",
            Some(node_id.as_str()),
        ),
    };
    design_error(code, message, node, None)
}

fn graph_patch_rejected(reason: &crate::GraphPatchError) -> Value {
    use crate::GraphPatchError;
    let (code, message, node, edge) = match reason {
        GraphPatchError::Definition(source) => return definition_rejected(source),
        GraphPatchError::StaleRevision => (
            "graph_base_mismatch",
            "The patch base does not match this run; read team_graph_context and use its graphId and workflowPlanId.",
            None,
            None,
        ),
        GraphPatchError::UnknownRun => (
            "design_run_not_found",
            "Run not found; use the runId from the current design context.",
            None,
            None,
        ),
        GraphPatchError::EmptyPatch => (
            "empty_graph_patch",
            "The patch has no operations; provide at least one graph operation.",
            None,
            None,
        ),
        GraphPatchError::UnknownNode(node) => (
            "node_not_found",
            "The operation references a missing node; use an existing nodeId or add the node before referencing it.",
            Some(node.as_str()),
            None,
        ),
        GraphPatchError::NodeAlreadyExists(node) => (
            "node_already_exists",
            "The node already exists; use replace_node to edit it or choose a new nodeId.",
            Some(node.as_str()),
            None,
        ),
        GraphPatchError::NodeKindChanged(node) => (
            "node_kind_changed",
            "An existing node's kind cannot change; create a new node with a different nodeId.",
            Some(node.as_str()),
            None,
        ),
        GraphPatchError::UnknownEdge(edge) => (
            "edge_not_found",
            "The operation references a missing edge; use an existing edgeId or add the edge first.",
            None,
            Some(edge.as_str()),
        ),
        GraphPatchError::EdgeAlreadyExists(edge) => (
            "edge_already_exists",
            "The edge already exists; use replace_edge to edit it or choose a new edgeId.",
            None,
            Some(edge.as_str()),
        ),
        GraphPatchError::ConsumedEdge(edge) => (
            "consumed_edge",
            "This edge is already recorded in node execution inputs; preserve its endpoints, ports and action, or create a new edge with a new edgeId.",
            None,
            Some(edge.as_str()),
        ),
        GraphPatchError::InvalidDefinition => (
            "invalid_graph_patch",
            "The graph patch violates a graph invariant; check the operation payloads against the current graph and tool schema.",
            None,
            None,
        ),
    };
    design_error(code, message, node, edge)
}

fn definition_rejected(reason: &crate::run::graph::DefinitionError) -> Value {
    use crate::run::graph::DefinitionError;
    let (code, message, node, edge) = match reason {
        DefinitionError::InvalidEdgeSourcePort {
            edge_id, node_id, ..
        } => (
            "invalid_edge_source_port",
            "Read this node's sourcePorts from the current graph and select a listed business branch; omit sourcePort only for a single outlet. A node with no outlets cannot be an edge source.",
            Some(node_id.as_str()),
            Some(edge_id.as_str()),
        ),
        DefinitionError::MissingEdgeSourcePort { edge_id, node_id } => (
            "missing_edge_source_port",
            "This source has multiple or no outlets. Select a business branch from the node's sourcePorts; a node with no outlets cannot be an edge source.",
            Some(node_id.as_str()),
            Some(edge_id.as_str()),
        ),
        DefinitionError::InvalidEdgeTargetPort {
            edge_id, node_id, ..
        } => (
            "invalid_edge_target_port",
            "Omit targetPort to use the target node's unique inlet, or use an exact value from its targetPorts. A node with no inlets cannot be an edge target.",
            Some(node_id.as_str()),
            Some(edge_id.as_str()),
        ),
        DefinitionError::MissingEdgeTargetPort { edge_id, node_id } => (
            "missing_edge_target_port",
            "The target has no unique inlet; select a valid target from the current graph. Start nodes cannot receive incoming edges.",
            Some(node_id.as_str()),
            Some(edge_id.as_str()),
        ),
        DefinitionError::AmbiguousEdgeAction(edge) => (
            "ambiguous_edge_action",
            "Multiple actions are valid for this source port and target. Read the source node's sourcePortActions and choose an explicit action for the intended business behavior; Join targets allow only gate.",
            None,
            Some(edge.as_str()),
        ),
        DefinitionError::InvalidEdgeAction(edge) => (
            "invalid_edge_action",
            "The action is invalid or no action is valid for these endpoints. Choose an action from the source node's sourcePortActions that also satisfies the target constraint; if none exists, change the branch or target. Every edge into Join requires gate. Review rework requires action=rework; rework is otherwise allowed only on human rejected/aborted or script failed branches and cannot target Join.",
            None,
            Some(edge.as_str()),
        ),
        DefinitionError::UnknownEdgeSource { edge_id, node_id } => (
            "edge_source_not_found",
            "The edge sourceNodeId does not exist; use an existing nodeId or add the source node before the edge.",
            Some(node_id.as_str()),
            Some(edge_id.as_str()),
        ),
        DefinitionError::UnknownEdgeTarget { edge_id, node_id } => (
            "edge_target_not_found",
            "The edge targetNodeId does not exist; use an existing nodeId or add the target node before the edge.",
            Some(node_id.as_str()),
            Some(edge_id.as_str()),
        ),
        DefinitionError::MissingAssignmentRole(node) => (
            "missing_assignment_role",
            "Work and review nodes require roleId; choose it with config.sessionRef from the current run's context roles.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::MissingAssignmentSession(node) => (
            "missing_assignment_session",
            "Work and review nodes require config.sessionRef; copy the matching roleId/sessionRef pair from the current run's context roles.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::JoinWithoutIncomingGate(node) => (
            "join_without_incoming_gate",
            "Join needs at least one incoming gate edge before execution; connect the upstream nodes it must wait for.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::DependencyTaskMismatch(edge) => (
            "dependency_task_mismatch",
            "For work-to-work edges, dependencyTaskId and taskId must match the source and target task IDs; use dependency={} to derive them.",
            None,
            Some(edge.as_str()),
        ),
        DefinitionError::MissingDependencyTask(edge) => (
            "missing_dependency_task",
            "Dependency task IDs can be derived only for work-to-work edges; supply both identifiers for other endpoints, or omit dependency metadata.",
            None,
            Some(edge.as_str()),
        ),
        DefinitionError::InvalidWorkAssignment(node) => (
            "invalid_work_assignment",
            "The Work node needs a valid work assignment with nonempty taskId and roleId.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::InvalidReviewAssignment(node) => (
            "invalid_review_assignment",
            "The Review node needs a valid review assignment with nonempty roleId and config.prompt.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::MissingScriptReviewRule(node) => (
            "missing_script_review_rule",
            "ScriptReview requires an explicit config.rule from the graph tool schema; there is no default rule.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::InvalidStartCronExpression(node) => (
            "invalid_start_cron_expression",
            "Provide a valid cron expression in the Start node's config.trigger.cron.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::ActivationCycle(node) => (
            "activation_cycle",
            "The graph has a forward-edge cycle at this node; remove the cycle and use Review rework edges for rework.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::UnreachableNode(node) => (
            "unreachable_node",
            "The node is unreachable; connect it to an execution root.",
            Some(node.as_str()),
            None,
        ),
        DefinitionError::NoNodes => (
            "empty_graph",
            "The patch would leave no nodes; retain or add at least one node.",
            None,
            None,
        ),
        _ => (
            "invalid_graph_definition",
            "The resulting graph violates a definition invariant; check node and edge definitions against the current graph and tool schema.",
            None,
            None,
        ),
    };
    design_error(code, message, node, edge)
}

fn design_error(code: &str, message: &str, node: Option<&str>, edge: Option<&str>) -> Value {
    let mut result = json!({"success":false,"error":message,"errorCode":code});
    // Only bounded opaque graph identifiers may leave this error boundary, never raw paths or payloads.
    for (field, id) in [("nodeId", node), ("edgeId", edge)] {
        if let Some(id) = id.and_then(|id| OpaqueId::try_new(id).ok()) {
            result[field] = json!(id.as_str());
        }
    }
    result
}

fn context_result(outcome: TeamGraphContextResult) -> Value {
    match outcome {
        TeamGraphContextResult::Available(context) => json!({
            "outcome": "available", "teamId": context.team().as_str(), "runId": context.run().as_str(),
            "graphStatus": graph_status(context.graph_status()),
            "nodes": context.nodes().iter().map(|node| json!({
                "nodeId": node.node_id(), "nodeExecutionId": node.node_execution_id(),
                "status": attempt_status(node.status()), "outputPort": node.output_port(),
            })).collect::<Vec<_>>(),
            "edges": context.edges().iter().map(|edge| json!({
                "edgeId": edge.edge_id(), "sourceNodeId": edge.source_node_id(), "targetNodeId": edge.target_node_id(),
            })).collect::<Vec<_>>(),
            "pendingApprovalIds": context.pending_approval_ids(),
            "approvals": context.approvals().iter().map(context_approval_json).collect::<Vec<_>>(),
            "recentEventIds": context.recent_event_ids(),
        }),
        TeamGraphContextResult::Unavailable => json!({"outcome":"unavailable"}),
        TeamGraphContextResult::OutcomeUnknown => json!({"outcome":"outcome_unknown"}),
    }
}

pub(crate) fn context_approval_json(approval: &crate::run::context::ContextApproval) -> Value {
    json!({
        "approvalId": approval.approval_id(),
        "subject": match approval.subject() {
            crate::ApprovalSubject::Stage { .. } => "stage",
            crate::ApprovalSubject::WorkNode { .. } => "work_node",
            crate::ApprovalSubject::HumanDecision { .. } => "human_decision",
        },
        "status": match approval.status() {
            crate::ApprovalStatus::Pending => "pending",
            crate::ApprovalStatus::Approved => "approved",
            crate::ApprovalStatus::Denied => "denied",
            crate::ApprovalStatus::Aborted => "aborted",
        },
        "decision": approval.decision().map(|decision| match decision {
            crate::ApprovalDecision::Approve => "approve",
            crate::ApprovalDecision::Deny => "deny",
            crate::ApprovalDecision::Abort => "abort",
        }),
    })
}

fn graph_status(status: crate::GraphStatus) -> &'static str {
    match status {
        crate::GraphStatus::Pending => "pending",
        crate::GraphStatus::Ready => "ready",
        crate::GraphStatus::Running => "running",
        crate::GraphStatus::Waiting => "waiting",
        crate::GraphStatus::Completed => "completed",
        crate::GraphStatus::Failed => "failed",
        crate::GraphStatus::Cancelled => "cancelled",
    }
}

fn attempt_status(status: crate::AttemptStatus) -> &'static str {
    match status {
        crate::AttemptStatus::Pending => "pending",
        crate::AttemptStatus::Ready => "ready",
        crate::AttemptStatus::Running => "running",
        crate::AttemptStatus::Waiting => "waiting",
        crate::AttemptStatus::Completed => "completed",
        crate::AttemptStatus::Failed => "failed",
        crate::AttemptStatus::Cancelled => "cancelled",
    }
}
