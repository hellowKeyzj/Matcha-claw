use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::mcp::arguments::{optional_string, require_exact_keys, required_string};
use serde_json::{Map, Value, json};

use super::{design::DesignOperation, team_runtime::decode_team_graph_patch_value};
use crate::{
    ApprovalDecision, EvidenceId, EvidenceRecord, EvidenceReference, EvidenceReferenceKind,
    GraphRunId, OrganizationHandle, RecordOutcome, RequestAdmissionClosed,
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
        .map(|time| time.as_secs())
    else {
        return Ok(rejected());
    };
    match name {
        "team_graph_context" => graph_context(owner, args, resolver).await,
        "team_graph_patch" => graph_patch(owner, args, resolver).await,
        "team_node_event" => node_event(owner, args, now).await,
        "team_approval_resolve" => approval_resolve(owner, args, now).await,
        "team_run_decision_submit" => decision_submit(owner, args, now).await,
        "team_evidence_record" => evidence_record(owner, args, now).await,
        _ => Ok(invalid()),
    }
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
            .unwrap_or_else(|_| rejected()));
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
        .unwrap_or_else(|_| rejected()))
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
