use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::mcp::arguments::{optional_string, require_exact_keys, required_string};
use serde_json::{Map, Value, json};

use super::{design::DesignOperation, team_runtime::decode_team_graph_patch_value};
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
    scope: Option<crate::TeamRunExecutionScope>,
) -> Result<Value, RequestAdmissionClosed> {
    let Some(args) = args.as_object() else {
        return Ok(invalid());
    };
    let Some(now) = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|time| time.as_secs())
    else {
        return Ok(rejected());
    };
    match name {
        "team_graph_context" if args.get("view").and_then(Value::as_str) == Some("run_prompts") => {
            runtime_graph_context(owner, args, scope).await
        }
        "team_graph_patch" if !args.contains_key("designEpoch") && !args.contains_key("promptGeneration") => {
            runtime_graph_patch(owner, args, scope, now).await
        }
        "team_graph_context" if scope.is_none() => graph_context(owner, args, resolver).await,
        "team_graph_patch" if scope.is_none() => graph_patch(owner, args, resolver).await,
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
    scope: Option<crate::TeamRunExecutionScope>,
) -> Result<Value, RequestAdmissionClosed> {
    if require_exact_keys(args, &["teamId", "runId", "view"]).is_err() {
        return Ok(invalid());
    }
    let scope = match execution_scope(args, scope) {
        Ok(scope) => scope,
        Err(error) => return Ok(error),
    };
    Ok(owner.runtime_graph_context(scope).await?.unwrap_or_else(runtime_graph_rejected))
}

async fn runtime_graph_patch(
    owner: &OrganizationHandle,
    args: &Map<String, Value>,
    scope: Option<crate::TeamRunExecutionScope>,
    now: u64,
) -> Result<Value, RequestAdmissionClosed> {
    let parsed = (|| {
        require_exact_keys(args, &[
            "teamId", "runId", "expectedGraphVersion", "commandId", "idempotencyKey", "operations",
        ])?;
        let version = required_string(args, "expectedGraphVersion")?;
        if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err(());
        }
        let operations = args.get("operations").and_then(Value::as_array).ok_or(())?;
        if operations.is_empty() {
            return Err(());
        }
        let operations = operations.iter().map(|operation| {
            let operation = operation.as_object().ok_or(())?;
            require_exact_keys(operation, &["op", "nodeId", "prompt"])?;
            if required_string(operation, "op")? != "set_node_prompt" {
                return Err(());
            }
            Ok(crate::store::NodePromptPatch {
                node_id: crate::NodeId::new(opaque(operation, "nodeId")?.as_str()),
                prompt: required_string(operation, "prompt")?.to_owned(),
            })
        }).collect::<Result<Vec<_>, ()>>()?;
        Ok(crate::store::RuntimePromptPatch {
            command_id: opaque(args, "commandId")?,
            idempotency_key: opaque(args, "idempotencyKey")?,
            expected_graph_version: version.to_owned(),
            operations,
            created_at: now,
        })
    })();
    let Ok(patch) = parsed else { return Ok(invalid()); };
    let scope = match execution_scope(args, scope) {
        Ok(scope) => scope,
        Err(error) => return Ok(error),
    };
    Ok(owner.runtime_graph_patch(scope, patch).await?.unwrap_or_else(runtime_graph_rejected))
}

fn execution_scope(
    args: &Map<String, Value>,
    scope: Option<crate::TeamRunExecutionScope>,
) -> Result<crate::TeamRunExecutionScope, Value> {
    let team = required_string(args, "teamId").map_err(|_| invalid())?;
    let run = required_string(args, "runId").map_err(|_| invalid())?;
    let scope = scope.ok_or_else(|| design_error(
        "execution_authority_required",
        "Use executionAuthority from the current node's team_run_authority context; do not invent authorization.",
        None, None,
    ))?;
    if scope.team_id.as_str() != team || scope.run_id.as_str() != run {
        return Err(design_error(
            "execution_authority_invalid",
            "Execution authorization does not grant access to this team and run; use the exact current node context.",
            None, None,
        ));
    }
    Ok(scope)
}

fn runtime_graph_rejected(fault: crate::StoreFault) -> Value {
    use crate::{StoreFault, store::RuntimeGraphError};
    let (code, message, node) = match &fault {
        StoreFault::RuntimeGraph(reason) => match reason {
            RuntimeGraphError::UnknownRun | RuntimeGraphError::TeamMismatch => (
                "execution_authority_invalid", "Execution authorization is no longer valid for this run; stop graph access.", None,
            ),
            RuntimeGraphError::RunInactive => (
                "run_not_active", "The run is not active and started; stop runtime graph access.", None,
            ),
            RuntimeGraphError::ExecutionInactive => (
                "execution_expired", "This node execution is no longer current and in flight; stop using its authorization.", None,
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
        let team_id = TeamId::try_new(required_string(args, "teamId")?).map_err(|_| ())?;
        let run_id = GraphRunId::new(required_string(args, "runId")?);
        let view = match required_string(args, "view")? {
            "current_node" => TeamGraphContextView::CurrentNode,
            "graph_summary" => TeamGraphContextView::GraphSummary,
            _ => return Err(()),
        };
        let node = optional_string(args, "nodeExecutionId")?;
        match (
            args.contains_key("designEpoch"),
            args.contains_key("promptGeneration"),
        ) {
            (false, false) => Ok((
                None,
                Some(TeamGraphContextQuery::new(team_id, run_id, view, node).map_err(|_| ())?),
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
            _ => Err(()),
        }
    })();
    let Ok((design, query)) = parsed else {
        return Ok(invalid());
    };
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
        let team_id = TeamId::try_new(required_string(args, "teamId")?).map_err(|_| ())?;
        let run_id = opaque(args, "runId")?;
        let epoch = required_string(args, "designEpoch")?.to_owned();
        let generation = required_string(args, "promptGeneration")?.to_owned();
        let version = required_string(args, "expectedGraphVersion")?;
        if version.len() != 64
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(());
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
        .map_err(|_| ())?;
        if patch
            .operations
            .iter()
            .any(|operation| matches!(operation, GraphPatchOperation::SetNodePosition { .. }))
        {
            return Err(());
        }
        Ok(DesignOperation::Patch {
            team_id,
            epoch,
            generation: Some(generation),
            version: version.to_owned(),
            patch,
        })
    })();
    let Ok(operation) = parsed else {
        return Ok(invalid());
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
                "deliveryId",
                "receipt",
                "nodeId",
                "attemptNumber",
                "summary",
                "outputPort",
            ],
        )?;
        let run_id = opaque(args, "runId")?;
        let command_id = opaque(args, "commandId")?;
        let idempotency_key = opaque(args, "idempotencyKey")?;
        let node = opaque(args, "nodeExecutionId")?;
        let role = optional_string(args, "roleId")?
            .map(OpaqueId::try_new)
            .transpose()
            .map_err(|_| ())?;
        let event = match required_string(args, "event")? {
            "progress" => TeamNodeEvent::progress(node, role),
            "request_input" => TeamNodeEvent::request_input(node, role),
            "request_approval" => {
                let action = match required_string(args, "approvalAction")? {
                    "continue_node" => crate::ApprovalAction::ContinueNode,
                    "execute_tool" => crate::ApprovalAction::ExecuteTool,
                    "publish_result" => crate::ApprovalAction::PublishResult,
                    "external_action" => crate::ApprovalAction::ExternalAction,
                    _ => return Err(()),
                };
                TeamNodeEvent::request_approval(node, role, action)
            }
            "complete" | "reject" => {
                for key in ["deliveryId", "receipt", "nodeId"] {
                    required_string(args, key)?;
                }
                let attempt = args
                    .get("attemptNumber")
                    .and_then(Value::as_u64)
                    .ok_or(())?;
                if attempt == 0 || attempt > u32::MAX as u64 {
                    return Err(());
                }
                let summary = required_string(args, "summary")?;
                let port = required_string(args, "outputPort")?;
                return Ok((
                    None,
                    Some(json!({
                        "outcome": "legacy_terminal_evidence", "completionPath": "runtime_terminal_settle",
                        "summary": summary, "outputPort": port,
                    })),
                ));
            }
            _ => return Err(()),
        };
        let event =
            TeamNodeEventProducer::non_terminal(run_id, command_id, idempotency_key, event, now)
                .map_err(|_| ())?;
        Ok((Some(event), None))
    })();
    let Ok((event, evidence)) = parsed else {
        return Ok(invalid());
    };
    if let Some(evidence) = evidence {
        return Ok(evidence);
    }
    let (command, event) = event.expect("non-terminal event is decoded").into_parts();
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
            _ => return Err(()),
        };
        HumanDecisionCommand::new(
            GraphRunId::new(opaque(args, "runId")?.as_str()),
            opaque(args, "approvalId")?,
            decision,
            optional_string(args, "note")?.map(|note| note.trim().to_owned()),
            opaque(args, "idempotencyKey")?,
            now,
        )
        .map_err(|_| ())
    })();
    let Ok(command) = parsed else {
        return Ok(invalid());
    };
    Ok(match owner.approval_resolve(command).await? {
        Ok(HumanDecisionOutcome::Recorded) => json!({"outcome":"recorded"}),
        Ok(HumanDecisionOutcome::Replayed) => json!({"outcome":"replayed"}),
        Err(crate::StoreFault::InvalidFacts) => invalid(),
        Err(_) => rejected(),
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
            _ => return Err(()),
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
        .map_err(|_| ())
    })();
    let Ok(command) = parsed else {
        return Ok(invalid());
    };
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
            return Err(());
        }
        let reference = EvidenceReference::opaque(
            EvidenceReferenceKind::Artifact,
            opaque(args, "reference")?.as_str(),
            optional_string(args, "label")?
                .map(OpaqueId::try_new)
                .transpose()
                .map_err(|_| ())?
                .map(|label| label.as_str().to_owned()),
        )
        .map_err(|_| ())?;
        EvidenceRecord::new(
            EvidenceId::new(opaque(args, "evidenceId")?.as_str()).map_err(|_| ())?,
            opaque(args, "runId")?.as_str(),
            opaque(args, "nodeExecutionId")?.as_str(),
            reference,
            now,
        )
        .map_err(|_| ())
    })();
    let Ok(record) = parsed else {
        return Ok(invalid());
    };
    Ok(match owner.record_evidence(record).await? {
        Ok(RecordOutcome::Recorded(_)) => json!({"outcome":"recorded"}),
        Ok(RecordOutcome::Replayed(_)) => json!({"outcome":"replayed"}),
        Ok(RecordOutcome::ConflictingEvidenceId { .. })
        | Err(crate::StoreFault::InvalidFacts | crate::StoreFault::Evidence(_)) => invalid(),
        Err(_) => rejected(),
    })
}

fn opaque(args: &Map<String, Value>, key: &str) -> Result<OpaqueId, ()> {
    OpaqueId::try_new(required_string(args, key)?).map_err(|_| ())
}

fn invalid() -> Value {
    json!({"success":false,"error":"Invalid Team tool parameters","errorCode":"invalid_params"})
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
                "The design epoch is stale; stop using this authorization and use the latest leader design context.",
                None,
            ),
            DesignError::StaleGeneration => (
                "stale_prompt_generation",
                "The prompt generation is no longer authorized; stop this patch sequence and use the latest leader design context.",
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
                "The node's roleId and config.sessionRef do not match a binding in this run; copy the matching pair from the current context roles.",
                Some(node.as_str()),
            ),
        },
        StoreFault::GraphPatch(source) => return graph_patch_rejected(source),
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
        DefinitionError::InvalidWorkEdgeSourcePort { edge_id, .. } => (
            "invalid_work_source_port",
            "The edge leaves a Work node; set sourcePort to 'completed'.",
            None,
            Some(edge_id.as_str()),
        ),
        DefinitionError::InvalidReviewEdgeSourcePort { edge_id, .. } => (
            "invalid_review_source_port",
            "The edge leaves an assigned Review node; use sourcePort 'completed' or 'rework'.",
            None,
            Some(edge_id.as_str()),
        ),
        DefinitionError::InvalidReworkEdgeAction(edge) => (
            "invalid_rework_action",
            "An edge with sourcePort 'rework' must use action 'rework'.",
            None,
            Some(edge.as_str()),
        ),
        DefinitionError::InvalidCompletedEdgeAction(edge) => (
            "invalid_completed_action",
            "An edge with sourcePort 'completed' cannot use action 'rework'; use a forward action, or the Review 'rework' outlet for rework.",
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
            "pendingApprovalIds": context.pending_approval_ids(), "recentEventIds": context.recent_event_ids(),
        }),
        TeamGraphContextResult::Unavailable => json!({"outcome":"unavailable"}),
        TeamGraphContextResult::OutcomeUnknown => json!({"outcome":"outcome_unknown"}),
    }
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
