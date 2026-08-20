use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    RuntimeSessionError, capability_directory,
    openclaw_session::{
        AbortChatRequest, AbortChatResponse, ChatHistoryResponse, InvalidPayload, SendChatRequest,
        SendChatResponse,
    },
    owner::{
        Handle, TeamNodeEventCommandOutcome, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
        TeamRuntimeCreateSource, TeamRuntimeStatus,
    },
    runtime_driver::RuntimeDriverIdentity,
};

use super::wire::{Command, CommandInput, CommandOutcome, RejectionCode};

const INVALID_INPUT_MESSAGE: &str = "Runtime Host command input is invalid.";
const RUNTIME_UNAVAILABLE_MESSAGE: &str = "Runtime Host is unavailable.";
const COMMAND_FAILED_MESSAGE: &str = "Runtime Host command failed.";
const CRON_DESCRIPTOR_NOT_GENERIC_EXECUTE_MESSAGE: &str =
    "Scheduler Cron operations are not generic execute commands.";

pub(crate) async fn execute(owner: &Handle, command: Command) -> CommandOutcome {
    match command {
        Command::HostHealth {} => super::lifecycle::host_health(owner).await,
        Command::HostRuntimeSnapshot {} => super::lifecycle::runtime_snapshot(owner).await,
        Command::HostCapabilitiesList {} => capability_directory::list(),
        Command::HostCapabilitiesDescribe { input } => capability_directory::describe(input),
        Command::HostRuntimeExecute { input } => runtime_host_execute(owner, input).await,
        Command::OpenClawSkillsExecute { input } => openclaw_skills_execute(owner, input).await,
        Command::TeamRuntimeExecute { input } => team_runtime_execute(owner, input).await,
        Command::OpenClawPluginsExecute { input } => openclaw_plugins_execute(owner, input).await,
        Command::MatchaStatus {} => super::lifecycle::matcha_status(owner).await,
        Command::MatchaStart {} => super::lifecycle::start_matcha(owner).await,
        Command::MatchaStop {} => super::lifecycle::stop_matcha(owner).await,
        Command::MatchaRestart {} => super::lifecycle::restart_matcha(owner).await,
        Command::OpenClawStatus {} => super::lifecycle::status(owner).await,
        Command::OpenClawPluginsCatalog {} => plugins_catalog(owner).await,
        Command::OpenClawPluginsRuntime {} => plugins_runtime(owner).await,
        Command::OpenClawPluginsSetEnabled { input } => plugins_set_enabled(owner, input).await,
        Command::OpenClawPluginsOperation { input } => plugins_operation(owner, input).await,
        Command::OpenClawEnvironmentStatus {} => openclaw_environment_status(owner).await,
        Command::OpenClawRuntimePaths {} => openclaw_runtime_paths(owner).await,
        Command::OpenClawCliCommand {} => openclaw_cli_command(owner).await,
        Command::OpenClawToolPermissionGet {} => openclaw_tool_permission_get(owner).await,
        Command::OpenClawToolPermissionSet { input } => {
            openclaw_tool_permission_set(owner, input).await
        }
        Command::OpenClawToolchainStatus {} => openclaw_toolchain_status(owner).await,
        Command::OpenClawToolchainInstallUv {} => openclaw_toolchain_install_uv(owner).await,
        Command::OpenClawToolchainInstallSubmit {} => {
            openclaw_toolchain_install_submit(owner).await
        }
        Command::OpenClawToolchainJobGet { input } => {
            openclaw_toolchain_job_get(owner, input).await
        }
        Command::OpenClawSubagentTemplateCatalog {} => subagent_template_catalog(owner).await,
        Command::OpenClawSubagentTemplate { input } => subagent_template(owner, input).await,
        Command::OpenClawStart {} => super::lifecycle::start(owner).await,
        Command::OpenClawStop {} => super::lifecycle::stop(owner).await,
        Command::OpenClawRestart {} => super::lifecycle::restart(owner).await,
        Command::OpenClawLogs { input } => super::lifecycle::logs(owner, input).await,
        Command::OpenClawControlReady {} => super::lifecycle::control_ready(owner).await,
        Command::OpenClawGatewayHealth {} => super::lifecycle::gateway_health(owner).await,
        Command::OpenClawGatewayStatus {} => super::lifecycle::gateway_status(owner).await,
        Command::OpenClawControlUiUrl {} => super::lifecycle::control_ui_url(owner).await,
        Command::OpenClawManualCronTrigger { input } => {
            manually_trigger_openclaw_cron(owner, input).await
        }
        Command::OpenClawChatHistory { input } => history_openclaw_chat(owner, input).await,
        Command::OpenClawChatSend { input } => send_openclaw_chat(owner, input).await,
        Command::OpenClawChatAbort { input } => abort_openclaw_chat(owner, input).await,
        Command::FleetCredentialsWrite { input } => fleet_credentials_write(owner, input).await,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityExecuteRequest {
    id: String,
    operation_id: String,
    scope: Value,
    target: Value,
    input: Value,
}

async fn runtime_host_execute(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };
    if is_scheduler_cron_descriptor_execute_request(&request) {
        return scheduler_cron_not_generic_execute();
    }
    if request.id != "runtime.host" || !is_native_runtime_scope(&request.scope) {
        return invalid_input();
    }
    match request.operation_id.as_str() {
        "runtimeHost.prepareGatewayLaunch" => {
            if !is_gateway_control_target(&request.target) || !request.input.is_object() {
                return invalid_input();
            }
            super::lifecycle::start(owner).await
        }
        "runtimeHost.gatewayLifecycle" => {
            if !is_gateway_control_target(&request.target) || !request.input.is_object() {
                return invalid_input();
            }
            super::lifecycle::status(owner).await
        }
        "runtimeHost.gatewayReady" => {
            if !is_gateway_control_target(&request.target) || !request.input.is_object() {
                return invalid_input();
            }
            super::lifecycle::control_ready(owner).await
        }
        "runtimeHost.gatewayControlUiAutoApprove" => {
            if !is_gateway_control_target(&request.target) || !request.input.is_object() {
                return invalid_input();
            }
            super::lifecycle::control_ui_url(owner).await
        }
        "runtimeHost.jobGet" => {
            let Some(target_job_id) = runtime_job_target_id(&request.target) else {
                return invalid_input();
            };
            if request.input.get("jobId").and_then(Value::as_str) != Some(target_job_id) {
                return invalid_input();
            }
            openclaw_toolchain_job_get(owner, CommandInput(request.input)).await
        }
        _ => unavailable(),
    }
}

fn is_scheduler_cron_descriptor_execute_request(request: &CapabilityExecuteRequest) -> bool {
    request.id == "scheduler.cron"
        && is_native_runtime_scope(&request.scope)
        && matches!(
            request.operation_id.as_str(),
            "cron.trigger" | "cron.create" | "cron.update" | "cron.delete" | "cron.toggle"
        )
}

fn is_gateway_control_target(value: &Value) -> bool {
    value.as_object().is_some_and(|target| {
        target.len() == 1 && target.get("kind") == Some(&json!("gateway-control"))
    })
}

fn runtime_job_target_id(value: &Value) -> Option<&str> {
    value.as_object().and_then(|target| {
        (target.len() == 2 && target.get("kind") == Some(&json!("runtime-job")))
            .then(|| target.get("jobId").and_then(Value::as_str))?
    })
}

async fn team_runtime_execute(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) if request.id == "team.runtime" => request,
        _ => return invalid_input(),
    };
    if !is_team_runtime_facade_scope(&request.scope) {
        return invalid_input();
    }

    let team_id = request
        .input
        .get("teamId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let run_id = request
        .input
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let command = match team_runtime_command(&request.operation_id, &request.target, &request.input)
    {
        Ok(command) => command,
        Err(TeamRuntimeDecodeError::Unavailable) => return unavailable(),
        Err(TeamRuntimeDecodeError::InvalidInput) => return invalid_input(),
    };
    match owner.team_runtime(command).await {
        Ok(outcome) => team_runtime_outcome(outcome, team_id.as_deref(), run_id.as_deref()),
        Err(_) => unavailable(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TeamRuntimeDecodeError {
    InvalidInput,
    Unavailable,
}

fn team_runtime_command(
    operation_id: &str,
    target: &Value,
    input: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let input = input
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    match operation_id {
        "team.packageValidate" | "team.dependencyPlan" => {
            let target = target
                .as_object()
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            if target.len() != 2
                || target.get("kind") != Some(&json!("team"))
                || input.len() != 1
                || target.get("packagePath") != input.get("packagePath")
            {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            let package_path = input
                .get("packagePath")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            let package_root = PathBuf::from(package_path);
            if operation_id == "team.packageValidate" {
                Ok(TeamRuntimeCommand::PackageValidate { package_root })
            } else {
                Ok(TeamRuntimeCommand::DependencyPlan { package_root })
            }
        }
        "team.provisionAgents" => decode_team_provision(input, target),
        "team.delete" => decode_team_delete(input, target),
        "team.runDelete" => decode_team_run_delete(input, target),
        "team.runList" => {
            let team_id = decode_team_id_target(target, input)?;
            if input.len() != 1 {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            Ok(TeamRuntimeCommand::RunList { team_id })
        }
        "team.resume" => decode_team_resume(input, target),
        "team.triggerList" => {
            if !input.is_empty() {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            let team_id = match target {
                Value::Null => None,
                Value::Object(target)
                    if target.len() == 1 && target.get("kind") == Some(&json!("team")) =>
                {
                    None
                }
                Value::Object(target)
                    if target.len() == 2 && target.get("kind") == Some(&json!("team")) =>
                {
                    target
                        .get("teamId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(|value| organization::TeamId::try_new(value.to_owned()))
                        .transpose()
                        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?
                }
                _ => return Err(TeamRuntimeDecodeError::InvalidInput),
            };
            Ok(TeamRuntimeCommand::TriggerList { team_id })
        }
        "team.runCreate" => decode_team_run_create(input, target),
        "team.webhookTriggerFire" => decode_team_webhook_trigger(input, target),
        "team.graphSave" => decode_team_graph_save(input, target),
        "team.graphPatch" => decode_team_graph_patch(input, target),
        "team.graphContext" => decode_team_graph_context(input, target),
        "team.nodePromptRetryDue" => decode_team_node_prompt_retry_due(input, target),
        "team.nodePromptSettled" => decode_team_node_prompt_settled(input, target),
        "team.nodeEvent" => decode_team_node_event(input, target),
        "team.runDecisionSubmit" => decode_team_run_decision(input, target),
        "team.runSnapshot" => decode_team_snapshot(input, target),
        "team.graphExportYaml" => decode_team_graph_export(input, target),
        "team.graphImportYaml" => decode_team_graph_import(input, target),
        "team.runDiagnostics" => decode_team_run_diagnostics(input, target),
        "team.roleMessageSubmit" => decode_team_role_message(input, target),
        "team.triggerFire" => decode_team_trigger(input, target),
        "team.approvalResolve" => decode_team_approval(input, target),
        "team.runCancel" => decode_team_run_cancel(input, target),
        _ => Err(TeamRuntimeDecodeError::Unavailable),
    }
}

fn team_runtime_outcome(
    outcome: TeamRuntimeCommandOutcome,
    team_id: Option<&str>,
    run_id: Option<&str>,
) -> CommandOutcome {
    match outcome {
        TeamRuntimeCommandOutcome::PackageValidate(validation) => CommandOutcome::succeeded(
            serde_json::to_value(validation).expect("package validation serializable"),
        ),
        TeamRuntimeCommandOutcome::DependencyPlan(plan) => CommandOutcome::succeeded(
            serde_json::to_value(plan).expect("dependency plan serializable"),
        ),
        TeamRuntimeCommandOutcome::ProvisionAgents(outcome) => match outcome {
            crate::composition::TeamMaterializationCommandOutcome::Materialized => {
                CommandOutcome::succeeded(json!({ "success": true, "outcome": "materialized" }))
            }
            crate::composition::TeamMaterializationCommandOutcome::Rejected => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team agent materialization was rejected.")
            }
            crate::composition::TeamMaterializationCommandOutcome::OutcomeUnknown => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
            crate::composition::TeamMaterializationCommandOutcome::Unavailable => unavailable(),
        },
        TeamRuntimeCommandOutcome::Delete(result) => match result {
            Ok(crate::composition::TeamDeleteOutcome::Deleted) => CommandOutcome::succeeded(json!({
                "teamId": team_id,
                "state": "tombstoned",
            })),
            Ok(crate::composition::TeamDeleteOutcome::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "teamId": team_id, "state": "outcome_unknown" }))
            }
            Err(_) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team deletion was rejected.",
            ),
        },
        TeamRuntimeCommandOutcome::RunCreate(result) => match result {
            Ok(organization::CreateGraphRunOutcome::Created(run_id)) => CommandOutcome::succeeded(json!({
                "runId": run_id.as_str(),
                "status": "created",
                "revision": 1,
            })),
            Ok(organization::CreateGraphRunOutcome::Replayed(run_id)) => CommandOutcome::succeeded(json!({
                "runId": run_id.as_str(),
                "status": "created",
                "revision": 1,
                "replayed": true,
            })),
            Ok(organization::CreateGraphRunOutcome::ExistingRun)
            | Ok(organization::CreateGraphRunOutcome::ConflictingIdempotency)
            | Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team run creation was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunList(runs) => CommandOutcome::succeeded(json!({
            "teamId": team_id,
            "runs": runs.iter().map(team_run_json).collect::<Vec<_>>(),
        })),
        TeamRuntimeCommandOutcome::TriggerList(triggers) => CommandOutcome::succeeded(json!({
            "triggers": triggers.iter().map(team_trigger_json).collect::<Vec<_>>(),
        })),
        TeamRuntimeCommandOutcome::TriggerFire(result) => match result {
            Ok(result) => team_run_trigger_outcome(result),
            Err(_) => CommandOutcome::rejected(RejectionCode::Failed, "Team trigger was rejected."),
        },
        TeamRuntimeCommandOutcome::RoleMessageSubmit(result)
        | TeamRuntimeCommandOutcome::RoleMessageSubmitForRun(result) => match result {
            Ok(organization::RoleChatAdmissionOutcome::Accepted { delivery_id }) => {
                CommandOutcome::succeeded(json!({
                    "success": true,
                    "outcome": "accepted",
                    "deliveryId": delivery_id.as_str(),
                }))
            }
            Ok(organization::RoleChatAdmissionOutcome::Rejected(_)) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team role message was rejected.",
            ),
            Ok(organization::RoleChatAdmissionOutcome::OutcomeUnknown) | Err(_) => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
        },
        TeamRuntimeCommandOutcome::RunSnapshotInvalidInput => invalid_input(),
        TeamRuntimeCommandOutcome::RunSnapshot(snapshot) => match snapshot {
            organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(snapshot) => {
                CommandOutcome::succeeded(serde_json::to_value(snapshot).expect("snapshot serializable"))
            }
            organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Unavailable(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphExportYaml(result) => match result {
            Ok(yaml) => CommandOutcome::succeeded(json!({
                "runId": run_id,
                "yaml": yaml,
            })),
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team graph export was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "outcome": "outcome-unknown" }))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphImportYaml(result) => match result {
            Ok(crate::composition::TeamRunCommandOutcome::Available(run)) => CommandOutcome::succeeded(json!({
                "runId": run.run().as_str(),
                "imported": true,
            })),
            Ok(crate::composition::TeamRunCommandOutcome::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "outcome": "outcome-unknown" }))
            }
            Ok(crate::composition::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Err(organization::StoreFault::CommitOutcomeUnknown(_)) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "outcome": "outcome-unknown" }))
            }
            Err(organization::StoreFault::InvalidFacts | organization::StoreFault::EventLedger(_)) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team graph import was rejected.")
            }
            Err(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunDiagnostics(result) => match result {
            organization::TeamRunDiagnosticsQueryOutcome::Available(diagnostics) => {
                CommandOutcome::succeeded(serde_json::to_value(diagnostics).expect("diagnostics serializable"))
            }
            organization::TeamRunDiagnosticsQueryOutcome::Unavailable(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::WebhookTriggerFire(result) => match result {
            Ok(organization::TeamTriggerFireOutcome::Recorded(request)) => CommandOutcome::succeeded(json!({
                "success": true,
                "fired": true,
                "runId": request.trigger.run_id,
                "outcome": "recorded",
            })),
            Ok(organization::TeamTriggerFireOutcome::Replayed(request)) => CommandOutcome::succeeded(json!({
                "success": true,
                "fired": false,
                "runId": request.trigger.run_id,
                "outcome": "replayed",
            })),
            Ok(organization::TeamTriggerFireOutcome::Conflicting { .. }) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team webhook trigger conflicted with an existing request.")
            }
            Ok(organization::TeamTriggerFireOutcome::NotFound) => unavailable(),
            Ok(organization::TeamTriggerFireOutcome::Unknown) => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
            Ok(organization::TeamTriggerFireOutcome::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team webhook trigger was rejected.")
            }
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team webhook trigger was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphSave(result)
        | TeamRuntimeCommandOutcome::GraphPatch(result) => match result {
            Ok(crate::composition::TeamRunCommandOutcome::Available(run)) => CommandOutcome::succeeded(json!({
                "success": true,
                "runId": run.run().as_str(),
                "saved": true,
                "outcome": "available",
            })),
            Ok(crate::composition::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Ok(crate::composition::TeamRunCommandOutcome::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
            Err(_) => CommandOutcome::rejected(RejectionCode::Failed, "Team graph command was rejected."),
        },
        TeamRuntimeCommandOutcome::GraphContext(result) => match result {
            organization::TeamGraphContextResult::Available(context) => CommandOutcome::succeeded(json!({
                "teamId": context.team().as_str(),
                "runId": context.run().as_str(),
                "graphStatus": team_graph_status_name(context.graph_status()),
                "nodes": context.nodes().iter().map(|node| json!({
                    "nodeId": node.node_id(),
                    "nodeExecutionId": node.node_execution_id(),
                    "status": format!("{:?}", node.status()).to_lowercase(),
                    "outputPort": node.output_port(),
                })).collect::<Vec<_>>(),
                "edges": context.edges().iter().map(|edge| json!({
                    "edgeId": edge.edge_id(),
                    "sourceNodeId": edge.source_node_id(),
                    "targetNodeId": edge.target_node_id(),
                })).collect::<Vec<_>>(),
                "pendingApprovalIds": context.pending_approval_ids(),
                "recentEventIds": context.recent_event_ids(),
            })),
            organization::TeamGraphContextResult::Unavailable => unavailable(),
            organization::TeamGraphContextResult::OutcomeUnknown => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
        },
        TeamRuntimeCommandOutcome::NodePromptRetryDue(result) => match result {
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Available(plan) => {
                CommandOutcome::succeeded(json!({
                    "runId": plan.run_id().as_str(),
                    "processedDeliveryRecordIds": plan.due_items().map(|item| item.delivery_id().as_str()).collect::<Vec<_>>(),
                    "nextRetryAt": plan.next_retry_at(),
                    "items": plan.items().iter().map(node_prompt_retry_due_item_json).collect::<Vec<_>>(),
                }))
            }
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Unknown(reason) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "outcome": "unknown", "reason": node_prompt_retry_due_unknown_reason(reason) }))
            }
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Invalid(reason) => {
                CommandOutcome::rejected(RejectionCode::Failed, node_prompt_retry_due_invalid_reason(reason))
            }
        },
        TeamRuntimeCommandOutcome::NodeEvent(result) => match result {
            Ok(TeamNodeEventCommandOutcome::NonTerminal(outcome)) => CommandOutcome::succeeded(json!({
                "success": true,
                "runId": run_id,
                "outcome": team_node_event_outcome_name(outcome),
            })),
            Ok(TeamNodeEventCommandOutcome::Terminal(outcome)) => CommandOutcome::succeeded(json!({
                "success": true,
                "runId": run_id,
                "outcome": team_node_terminal_outcome_name(outcome),
            })),
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team node event was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "outcome": "outcome-unknown" }))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::NodePromptSettled(result) => match result {
            Ok(crate::composition::TeamNodePromptSettledResult::Recorded(run_id)) => {
                CommandOutcome::succeeded(json!({ "settled": true, "runId": run_id.as_str(), "snapshot": null }))
            }
            Ok(crate::composition::TeamNodePromptSettledResult::Replayed(run_id)) => {
                CommandOutcome::succeeded(json!({ "settled": true, "runId": run_id.as_str(), "snapshot": null }))
            }
            Ok(crate::composition::TeamNodePromptSettledResult::NotFound) => {
                CommandOutcome::succeeded(json!({ "settled": false, "runId": null, "snapshot": null }))
            }
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team node prompt settlement was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" }))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunDecisionSubmit(result) => match result {
            Ok(receipt) => CommandOutcome::succeeded(json!({
                "runId": receipt.decision().run_id(),
                "decisionId": receipt.decision().decision_id(),
                "stageId": receipt.decision().stage_id(),
                "decision": match receipt.decision().decision() {
                    organization::TeamDecisionType::Retry => "retry",
                    organization::TeamDecisionType::ProceedDegraded => "proceed_degraded",
                    organization::TeamDecisionType::Abort => "abort",
                },
                "sequence": receipt.decision().sequence(),
                "replayed": receipt.is_replay(),
            })),
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team decision was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "outcome": "outcome-unknown" }))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::ApprovalResolve(result) => match result {
            Ok(organization::run::approval::HumanDecisionOutcome::Recorded) => {
                CommandOutcome::succeeded(json!({ "success": true, "outcome": "recorded" }))
            }
            Ok(organization::run::approval::HumanDecisionOutcome::Replayed) => {
                CommandOutcome::succeeded(json!({ "success": true, "outcome": "replayed" }))
            }
            Err(_) => CommandOutcome::unknown(json!({ "outcome": "outcome-unknown" })),
        },
        TeamRuntimeCommandOutcome::RunCancel(result) => match result {
            Ok(organization::BeginCancellationOutcome::Started(_))
            | Ok(organization::BeginCancellationOutcome::Replayed(_)) => {
                CommandOutcome::succeeded(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "cancelling",
                }))
            }
            Ok(organization::BeginCancellationOutcome::AlreadyCancelled) => {
                CommandOutcome::succeeded(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "cancelled",
                }))
            }
            Ok(organization::BeginCancellationOutcome::Tombstoned) => {
                CommandOutcome::succeeded(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "tombstoned",
                }))
            }
            Ok(organization::BeginCancellationOutcome::OutcomeUnknown) | Err(_) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "state": "outcome_unknown" }))
            }
        },
        TeamRuntimeCommandOutcome::RunDelete(result) => match result {
            Ok(organization::GraphRunPurgeOutcome::Purged)
            | Ok(organization::GraphRunPurgeOutcome::Replayed) => CommandOutcome::succeeded(json!({
                "runId": run_id,
                "state": "purged",
            })),
            Ok(organization::GraphRunPurgeOutcome::Rejected(_)) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team run deletion was rejected.",
            ),
            Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(_)) => {
                CommandOutcome::unknown(json!({ "runId": run_id, "state": "outcome_unknown" }))
            }
            Err(_) => CommandOutcome::rejected(RejectionCode::Failed, "Team run deletion was rejected."),
        },
        _ => unavailable(),
    }
}

fn decode_team_run_cancel(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "reason" | "idempotencyKey"
        )
    }) || input
        .get("reason")
        .is_some_and(|value| value.as_str().is_none())
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = organization::IdempotencyKey::try_new(idempotency_key.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::RunCancel {
        run_id,
        idempotency_key,
        requested_at: now_millis(),
    })
}

fn decode_team_delete(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.len() != 2
        || target.get("kind") != Some(&json!("team"))
        || input.len() != 2
        || target.get("teamId") != input.get("teamId")
        || input.get("kind") != Some(&json!("team"))
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_id = organization::TeamId::try_new(
        input
            .get("teamId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key =
        organization::IdempotencyKey::try_new(format!("team-delete:{}", team_id.as_str()))
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::Delete {
        team_id,
        idempotency_key,
        observed_at: now_millis(),
    })
}

fn decode_team_run_delete(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key =
        organization::IdempotencyKey::try_new(format!("run-delete:{}", run_id.as_str()))
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::RunDelete {
        run_id,
        idempotency_key,
        tombstoned_at: now_millis(),
    })
}

fn decode_team_run_create(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team"))
        || !(target.len() == 2 || target.len() == 3)
        || target.get("packagePath") != input.get("packagePath")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "packagePath" | "teamId" | "runId" | "idempotencyKey" | "sourceType"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let package_path = input
        .get("packagePath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let team_id = decode_optional_team_id(input.get("teamId"), target.get("teamId"))?;
    let run_id = input
        .get("runId")
        .map(|value| {
            value
                .as_str()
                .filter(|value| valid_identifier(value))
                .map(|value| organization::GraphRunId::new(value.to_owned()))
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    let idempotency_key = decode_idempotency_key(input, "idempotencyKey")?;
    let source = decode_team_runtime_source(input.get("sourceType"))?;
    Ok(TeamRuntimeCommand::RunCreate {
        team_id,
        package_root: PathBuf::from(package_path),
        run_id,
        idempotency_key,
        source,
    })
}

fn decode_optional_team_id(
    input_team: Option<&Value>,
    target_team: Option<&Value>,
) -> Result<Option<organization::TeamId>, TeamRuntimeDecodeError> {
    match (target_team, input_team) {
        (None, None) => Ok(None),
        (Some(target_team), Some(input_team)) if target_team == input_team => {
            let team_id = input_team
                .as_str()
                .filter(|value| valid_identifier(value))
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            organization::TeamId::try_new(team_id.to_owned())
                .map(Some)
                .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
        }
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_idempotency_key(
    input: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<organization::IdempotencyKey, TeamRuntimeDecodeError> {
    let value = input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    organization::IdempotencyKey::try_new(value.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_runtime_source(
    value: Option<&Value>,
) -> Result<TeamRuntimeCreateSource, TeamRuntimeDecodeError> {
    match value.and_then(Value::as_str) {
        None | Some("teamskill") => Ok(TeamRuntimeCreateSource::TeamSkill),
        Some("manual") => Ok(TeamRuntimeCreateSource::Manual),
        Some(_) => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_provision(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team"))
        || !(target.len() == 2 || target.len() == 3)
        || target.get("packagePath") != input.get("packagePath")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_id = match (target.get("teamId"), input.get("teamId")) {
        (None, None) => None,
        (Some(target_team), Some(input_team)) if target_team == input_team => Some(
            organization::TeamId::try_new(
                input_team
                    .as_str()
                    .filter(|value| valid_identifier(value))
                    .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                    .to_owned(),
            )
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?,
        ),
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let package_path = input
        .get("packagePath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = organization::IdempotencyKey::try_new(idempotency_key.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let source = match input.get("sourceType").and_then(Value::as_str) {
        None | Some("teamskill") => TeamRuntimeCreateSource::TeamSkill,
        Some("manual") => return Err(TeamRuntimeDecodeError::Unavailable),
        Some(_) => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    if input.contains_key("manualTeam") {
        return Err(TeamRuntimeDecodeError::Unavailable);
    }
    if team_id.is_none() {
        return Err(TeamRuntimeDecodeError::Unavailable);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "packagePath" | "teamId" | "idempotencyKey" | "sourceType"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::ProvisionAgents {
        package_root: PathBuf::from(package_path),
        team_id,
        idempotency_key,
        source,
    })
}

fn decode_team_snapshot(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (team_id, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "eventCursor" | "eventLimit"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let event_cursor = optional_u64(input, "eventCursor")?;
    if let Some(event_limit) = optional_u64(input, "eventLimit")? {
        usize::try_from(event_limit).map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    }
    Ok(TeamRuntimeCommand::RunSnapshot {
        team_id,
        run_id,
        event_cursor,
        event_limit: optional_u64(input, "eventLimit")?,
    })
}

fn decode_team_graph_export(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::GraphExportYaml { run_id })
}

fn decode_team_graph_import(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 3 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let yaml = input
        .get("yaml")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let definition = organization::import_for_run(yaml, &run_id)
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id =
        decode_opaque_value(&format!("graph-import-yaml:{}", idempotency_key.as_str()))?;
    let run_id = decode_opaque_value(run_id.as_str())?;
    Ok(TeamRuntimeCommand::GraphImportYaml {
        command: Box::new(organization::RunCommand::new(
            run_id,
            command_id,
            idempotency_key,
            organization::CommandPayload::GraphReplace(definition.clone()),
            now_millis(),
        )),
        definition,
    })
}

fn decode_team_run_diagnostics(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::RunDiagnostics { run_id })
}

fn decode_team_node_prompt_retry_due(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::NodePromptRetryDue { run_id })
}

fn decode_team_trigger(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    let source = match input.get("triggerSource").and_then(Value::as_str) {
        Some("cron") => organization::TriggerSource::Cron,
        Some("webhook") => organization::TriggerSource::Webhook,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    if input.contains_key("payloadSummary") {
        return Err(TeamRuntimeDecodeError::Unavailable);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "startNodeId" | "triggerSource" | "idempotencyKey"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let request = organization::TriggerFireRequest::try_new(
        run_id.as_str(),
        input
            .get("startNodeId")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        source,
        input
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::TriggerFire {
        request,
        fired_at: now_millis(),
    })
}

fn decode_team_role_message(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (team_id, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "roleId" | "text" | "idempotencyKey"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if team_id.is_none() {
        let role_id = organization::RoleId::try_new(
            input
                .get("roleId")
                .and_then(Value::as_str)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
        )
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
        let message = input
            .get("text")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned();
        let idempotency_key = input
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned();
        return Ok(TeamRuntimeCommand::RoleMessageSubmitForRun {
            run_id,
            role_id,
            message,
            idempotency_key,
            requested_at: now_millis(),
        });
    }
    let Some(team_id) = team_id else {
        return Err(TeamRuntimeDecodeError::Unavailable);
    };
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "roleId" | "text" | "idempotencyKey"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let role_id = organization::RoleId::try_new(
        input
            .get("roleId")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let message = input
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let admission = organization::RoleChatAdmission::new(
        team_id,
        run_id,
        role_id,
        message.to_owned(),
        idempotency_key.to_owned(),
        now_millis(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::RoleMessageSubmit { admission })
}

fn decode_team_approval(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.len() != 3
        || target.get("kind") != Some(&json!("team-approval"))
        || target.get("runId") != input.get("runId")
        || target.get("approvalId") != input.get("approvalId")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let decision = match input.get("decision").and_then(Value::as_str) {
        Some("approve") => organization::ApprovalDecision::Approve,
        Some("deny") => organization::ApprovalDecision::Deny,
        Some("abort") => organization::ApprovalDecision::Abort,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let allowed = ["runId", "approvalId", "decision", "note", "idempotencyKey"];
    if !input.keys().all(|key| allowed.contains(&key.as_str()))
        || !input.contains_key("runId")
        || !input.contains_key("approvalId")
        || !input.contains_key("idempotencyKey")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let run_id = organization::GraphRunId::new(
        input
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    );
    let approval_id = organization::run::event::OpaqueId::try_new(
        input
            .get("approvalId")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = organization::run::event::OpaqueId::try_new(
        input
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let note = input.get("note").map(|note| {
        note.as_str()
            .filter(|note| !note.trim().is_empty())
            .map(str::to_owned)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)
    });
    let note = match note {
        None => None,
        Some(note) => Some(note?),
    };
    let command = organization::run::approval::HumanDecisionCommand::new(
        run_id,
        approval_id,
        decision,
        note,
        idempotency_key,
        now_millis(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::ApprovalResolve { command })
}

fn decode_team_id_target(
    target: &Value,
    input: &serde_json::Map<String, Value>,
) -> Result<organization::TeamId, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team"))
        || target.len() != 2
        || target.get("teamId") != input.get("teamId")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    organization::TeamId::try_new(
        input
            .get("teamId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_resume(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let team_id = decode_team_id_target(target, input)?;
    if input.len() != 2 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    organization::IdempotencyKey::try_new(idempotency_key.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::Resume { team_id })
}

fn decode_team_webhook_trigger(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    if !(target.is_null()
        || target
            .as_object()
            .is_some_and(|target| target.len() == 1 && target.get("kind") == Some(&json!("team"))))
        || !input
            .keys()
            .all(|key| matches!(key.as_str(), "webhookPath" | "idempotencyKey"))
        || input.len() != 2
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let webhook_path = input
        .get("webhookPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?
        .to_owned();
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?
        .to_owned();
    organization::run::trigger::TriggerFireRequest::try_new(
        "webhook",
        "webhook",
        organization::TriggerSource::Webhook,
        &idempotency_key,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::WebhookTriggerFire {
        webhook_path,
        idempotency_key,
        fired_at: now_millis(),
    })
}

fn decode_team_graph_context(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (team_id, run_id) = decode_team_target(target, input, true)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "view" | "nodeExecutionId"
        )
    }) || input.len() < 2
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let view = match input.get("view").and_then(Value::as_str) {
        Some("current_node") | Some("currentNode") => {
            organization::TeamGraphContextView::CurrentNode
        }
        Some("graph_summary") | Some("graphSummary") => {
            organization::TeamGraphContextView::GraphSummary
        }
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let node_execution_id = input
        .get("nodeExecutionId")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    Ok(TeamRuntimeCommand::GraphContext {
        team_id,
        run_id,
        view,
        node_execution_id,
    })
}

fn decode_team_graph_save(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 3 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let graph = input
        .get("graph")
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let definition = decode_team_graph_definition(graph, &run_id)?;
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id = decode_opaque_value(&format!("graph-save:{}", idempotency_key.as_str()))?;
    let run_id = decode_opaque_value(run_id.as_str())?;
    Ok(TeamRuntimeCommand::GraphSave {
        command: Box::new(organization::RunCommand::new(
            run_id,
            command_id,
            idempotency_key,
            organization::CommandPayload::GraphReplace(definition.clone()),
            now_millis(),
        )),
        definition,
    })
}

fn decode_team_graph_patch(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "summary" | "patch" | "idempotencyKey"
        )
    }) || input.len() != 4
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let patch = decode_team_graph_patch_value(
        input
            .get("patch")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )?;
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id = decode_opaque_value(&format!("graph-patch:{}", idempotency_key.as_str()))?;
    let run_id = decode_opaque_value(run_id.as_str())?;
    Ok(TeamRuntimeCommand::GraphPatch {
        command: Box::new(organization::RunCommand::new(
            run_id,
            command_id,
            idempotency_key.clone(),
            organization::CommandPayload::GraphPatch(decode_team_event_graph_patch(&patch)?),
            now_millis(),
        )),
        patch,
    })
}

fn decode_team_node_prompt_settled(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    if !(target.is_null()
        || target
            .as_object()
            .is_some_and(|target| target.len() == 1 && target.get("kind") == Some(&json!("none"))))
        || input.len() != 3
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let phase = match input.get("phase").and_then(Value::as_str) {
        Some("final") => crate::owner::TeamRuntimePromptPhase::Final,
        Some("error") => crate::owner::TeamRuntimePromptPhase::Error,
        Some("aborted") => crate::owner::TeamRuntimePromptPhase::Aborted,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    Ok(TeamRuntimeCommand::NodePromptSettled {
        session_key: decode_opaque(input, "sessionKey")?,
        prompt_run_id: decode_opaque(input, "promptRunId")?,
        phase,
    })
}

fn decode_team_node_event(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId"
                | "nodeExecutionId"
                | "event"
                | "summary"
                | "idempotencyKey"
                | "roleId"
                | "outputPort"
                | "evidenceRefs"
                | "requestedAction"
                | "risk"
                | "metadata"
                | "result"
                | "deliveryId"
                | "receipt"
                | "nodeId"
                | "attemptNumber"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let event = decode_opaque(input, "event")?;
    if !matches!(
        event.as_str(),
        "progress" | "request_input" | "request_approval" | "reject" | "complete"
    ) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let node_execution_id = decode_opaque(input, "nodeExecutionId")?;
    let summary = input
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            input
                .get("result")
                .and_then(Value::as_object)
                .and_then(|result| result.get("summary"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
        })
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let terminal_resolution = if matches!(event.as_str(), "complete" | "reject") {
        decode_optional_team_node_terminal_resolution(input)?
    } else {
        None
    };
    let role_id = input
        .get("roleId")
        .map(|_| decode_opaque(input, "roleId"))
        .transpose()?;
    let requested_action = input
        .get("requestedAction")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    let output_port = input
        .get("outputPort")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    if let Some(value) = input.get("metadata")
        && !value.is_object()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(value) = input.get("evidenceRefs")
        && !value.is_array()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::NodeEvent {
        run_id,
        node_execution_id,
        event,
        summary,
        role_id,
        requested_action,
        idempotency_key: decode_idempotency_key(input, "idempotencyKey")?,
        terminal_resolution,
        output_port,
    })
}

fn decode_optional_team_node_terminal_resolution(
    input: &serde_json::Map<String, Value>,
) -> Result<
    Option<crate::composition::team_run_mcp::TeamNodeTerminalResolution>,
    TeamRuntimeDecodeError,
> {
    if !(input.contains_key("deliveryId")
        || input.contains_key("receipt")
        || input.contains_key("nodeId")
        || input.contains_key("attemptNumber"))
    {
        return Ok(None);
    }
    let attempt_number = input
        .get("attemptNumber")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .and_then(std::num::NonZeroU32::new)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    Ok(Some(
        crate::composition::team_run_mcp::TeamNodeTerminalResolution {
            delivery_id: input
                .get("deliveryId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
            receipt: input
                .get("receipt")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
            node_id: input
                .get("nodeId")
                .and_then(Value::as_str)
                .filter(|value| valid_identifier(value))
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
            attempt_number,
            summary: input
                .get("summary")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
            output_port: input
                .get("outputPort")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
        },
    ))
}

fn decode_team_run_decision(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "decision" | "note" | "idempotencyKey"
        )
    }) || input.len() < 3
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let decision = match input.get("decision").and_then(Value::as_str) {
        Some("retry") => organization::TeamDecisionType::Retry,
        Some("proceed_degraded") => organization::TeamDecisionType::ProceedDegraded,
        Some("abort") => organization::TeamDecisionType::Abort,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let note = input
        .get("note")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    Ok(TeamRuntimeCommand::RunDecisionSubmit {
        run_id,
        decision,
        note,
        idempotency_key: decode_opaque(input, "idempotencyKey")?,
        resolved_at: now_millis(),
    })
}

fn decode_opaque(
    input: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<organization::run::event::OpaqueId, TeamRuntimeDecodeError> {
    decode_opaque_value(
        input
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )
}

fn decode_opaque_value(
    value: &str,
) -> Result<organization::run::event::OpaqueId, TeamRuntimeDecodeError> {
    organization::run::event::OpaqueId::try_new(value.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_graph_definition(
    value: &Value,
    run_id: &organization::GraphRunId,
) -> Result<organization::GraphDefinition, TeamRuntimeDecodeError> {
    let graph = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if graph.len() != 6 || graph.get("runId") != Some(&json!(run_id.as_str())) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let graph_id = graph
        .get("graphId")
        .and_then(Value::as_str)
        .filter(|value| valid_identifier(value))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let workflow_plan_id = graph
        .get("workflowPlanId")
        .and_then(Value::as_str)
        .filter(|value| valid_identifier(value))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let title = graph
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| valid_identifier(value))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let nodes = decode_team_graph_nodes(
        graph
            .get("nodes")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )?;
    let edges = decode_team_graph_edges(
        graph
            .get("edges")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )?;
    organization::GraphDefinition::new(
        graph_id,
        workflow_plan_id,
        run_id.clone(),
        title,
        nodes,
        edges,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_graph_nodes(
    value: &Value,
) -> Result<Vec<organization::NodeDefinition>, TeamRuntimeDecodeError> {
    let nodes = value
        .as_array()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    nodes.iter().map(decode_team_graph_node).collect()
}

fn decode_team_graph_node(
    value: &Value,
) -> Result<organization::NodeDefinition, TeamRuntimeDecodeError> {
    let node = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let id = organization::NodeId::new(
        node.get("nodeId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    );
    let title = node.get("title").and_then(Value::as_str).unwrap_or("node");
    let max_attempts = node
        .get("config")
        .and_then(Value::as_object)
        .and_then(|config| config.get("maxAttempts"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .and_then(std::num::NonZeroU32::new)
        .unwrap_or_else(|| std::num::NonZeroU32::new(1).expect("nonzero"));
    let kind = match node.get("kind").and_then(Value::as_str).unwrap_or("work") {
        "start" => organization::NodeKind::Start,
        "work" => organization::NodeKind::Work,
        "review" => organization::NodeKind::Review,
        "humanDecision" => organization::NodeKind::HumanDecision,
        "scriptReview" => organization::NodeKind::ScriptReview,
        "join" => organization::NodeKind::Join,
        "end" => organization::NodeKind::End,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let title = title.to_owned();
    match kind {
        organization::NodeKind::Start => Ok(organization::NodeDefinition::start(
            id,
            title,
            max_attempts,
            None,
        )),
        organization::NodeKind::Work => {
            let task_id = node
                .get("taskId")
                .and_then(Value::as_str)
                .unwrap_or(node.get("nodeId").and_then(Value::as_str).unwrap_or("task"));
            let role_id = node.get("roleId").and_then(Value::as_str).unwrap_or("team");
            Ok(organization::NodeDefinition::work(
                id,
                title,
                max_attempts,
                organization::WorkAssignment::typed(
                    task_id,
                    "",
                    organization::ExecutorPolicy::team_role(role_id),
                    None,
                    None,
                ),
            ))
        }
        organization::NodeKind::Join => Ok(organization::NodeDefinition::join(
            id,
            title,
            max_attempts,
            organization::WorkGroup::new(
                organization::GroupId::new(
                    node.get("groupId")
                        .and_then(Value::as_str)
                        .unwrap_or("group"),
                ),
                organization::JoinPolicy::new(true, false, 0),
            ),
        )),
        _ => Ok(organization::NodeDefinition::control(
            id,
            kind,
            title,
            max_attempts,
        )),
    }
}

fn decode_team_graph_edges(
    value: &Value,
) -> Result<Vec<organization::EdgeDefinition>, TeamRuntimeDecodeError> {
    let edges = value
        .as_array()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    edges
        .iter()
        .map(|value| {
            let edge = value
                .as_object()
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            let action = match edge
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("activate")
            {
                "activate" => organization::EdgeAction::Activate,
                "rework" => organization::EdgeAction::Rework,
                "gate" => organization::EdgeAction::Gate,
                "finish" => organization::EdgeAction::Finish,
                _ => return Err(TeamRuntimeDecodeError::InvalidInput),
            };
            Ok(organization::EdgeDefinition::new(
                organization::EdgeId::new(
                    edge.get("edgeId")
                        .and_then(Value::as_str)
                        .filter(|value| valid_identifier(value))
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
                organization::NodeId::new(
                    edge.get("sourceNodeId")
                        .and_then(Value::as_str)
                        .filter(|value| valid_identifier(value))
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
                edge.get("sourcePort")
                    .and_then(Value::as_str)
                    .unwrap_or("default"),
                organization::NodeId::new(
                    edge.get("targetNodeId")
                        .and_then(Value::as_str)
                        .filter(|value| valid_identifier(value))
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
                edge.get("targetPort")
                    .and_then(Value::as_str)
                    .unwrap_or("default"),
                action,
            ))
        })
        .collect()
}

fn decode_team_event_graph_patch(
    patch: &organization::GraphPatch,
) -> Result<organization::run::event::GraphPatch, TeamRuntimeDecodeError> {
    let operations = patch
        .operations()
        .iter()
        .map(|operation| match operation {
            organization::GraphPatchOperation::RemoveNode(node_id) => {
                Ok(organization::run::event::GraphPatchOperation::RemoveNode {
                    node_id: decode_opaque_value(node_id.as_str())?,
                })
            }
            organization::GraphPatchOperation::RemoveEdge(edge_id) => {
                Ok(organization::run::event::GraphPatchOperation::RemoveEdge {
                    edge_id: decode_opaque_value(edge_id.as_str())?,
                })
            }
            _ => Err(TeamRuntimeDecodeError::Unavailable),
        })
        .collect::<Result<Vec<_>, _>>()?;
    organization::run::event::GraphPatch::try_new(
        decode_opaque_value(patch.expected_graph_id())?,
        decode_opaque_value(patch.expected_workflow_plan_id())?,
        operations,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_graph_patch_value(
    value: &Value,
) -> Result<organization::GraphPatch, TeamRuntimeDecodeError> {
    let patch = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let base_graph_id = patch
        .get("baseGraphId")
        .and_then(Value::as_str)
        .filter(|value| valid_identifier(value))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let base_workflow_plan_id = patch
        .get("baseWorkflowPlanId")
        .and_then(Value::as_str)
        .filter(|value| valid_identifier(value))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let operations = patch
        .get("operations")
        .and_then(Value::as_array)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let operations = operations
        .iter()
        .map(|value| {
            let operation = value
                .as_object()
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            let op = operation
                .get("op")
                .and_then(Value::as_str)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            match op {
                "remove_node" => Ok(organization::GraphPatchOperation::RemoveNode(
                    organization::NodeId::new(
                        operation
                            .get("nodeId")
                            .and_then(Value::as_str)
                            .filter(|value| valid_identifier(value))
                            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                    ),
                )),
                "remove_edge" => Ok(organization::GraphPatchOperation::RemoveEdge(
                    organization::EdgeId::new(
                        operation
                            .get("edgeId")
                            .and_then(Value::as_str)
                            .filter(|value| valid_identifier(value))
                            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                    ),
                )),
                _ => Err(TeamRuntimeDecodeError::Unavailable),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    organization::GraphPatch::new(base_graph_id, base_workflow_plan_id, operations)
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_target(
    target: &Value,
    input: &serde_json::Map<String, Value>,
    require_team_id: bool,
) -> Result<(Option<organization::TeamId>, organization::GraphRunId), TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team-run"))
        || !(target.len() == 2 || target.len() == 3)
        || target.get("runId") != input.get("runId")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let run_id = organization::GraphRunId::new(
        input
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    );
    let target_team = target.get("teamId");
    let input_team = input.get("teamId");
    if target_team.is_some() != input_team.is_some()
        || target_team != input_team
        || (require_team_id && target_team.is_none())
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_id = target_team
        .map(|value| {
            organization::TeamId::try_new(
                value
                    .as_str()
                    .filter(|value| valid_identifier(value))
                    .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                    .to_owned(),
            )
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    Ok((team_id, run_id))
}

fn optional_u64(
    input: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<u64>, TeamRuntimeDecodeError> {
    input
        .get(field)
        .map(|value| value.as_u64().ok_or(TeamRuntimeDecodeError::InvalidInput))
        .transpose()
}

fn team_run_trigger_outcome(result: crate::composition::TeamRunTriggerOutcome) -> CommandOutcome {
    let registration = result.registration;
    match registration {
        organization::TriggerRegistration::Recorded(request) => CommandOutcome::succeeded(json!({
            "success": true,
            "fired": true,
            "runId": request.run_id,
            "outcome": "recorded",
        })),
        organization::TriggerRegistration::Replayed(request) => CommandOutcome::succeeded(json!({
            "success": true,
            "fired": false,
            "runId": request.run_id,
            "outcome": "replayed",
        })),
        organization::TriggerRegistration::ConflictingIdempotencyKey { .. } => {
            CommandOutcome::rejected(RejectionCode::Failed, "Team trigger was rejected.")
        }
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

fn team_run_json(outcome: &organization::TeamRunQueryOutcome) -> Value {
    match outcome {
        organization::TeamRunQueryOutcome::Available(run) => json!({
            "state": "available",
            "teamId": run.team().as_str(),
            "runId": run.run().as_str(),
            "teamRevision": run.team_revision().get(),
            "graphStatus": team_graph_status_name(run.graph_status()),
        }),
        organization::TeamRunQueryOutcome::Unavailable => json!({ "state": "unavailable" }),
        organization::TeamRunQueryOutcome::OutcomeUnknown => {
            json!({ "state": "outcome_unknown" })
        }
    }
}

fn team_resume_json(outcome: &organization::ResumeOutcome) -> Value {
    match outcome {
        organization::ResumeOutcome::Active(run_id) => {
            json!({ "runId": run_id.as_str(), "state": "active" })
        }
        organization::ResumeOutcome::Cancelled(run_id) => {
            json!({ "runId": run_id.as_str(), "state": "cancelled" })
        }
        organization::ResumeOutcome::OutcomeUnknown(run_id) => {
            json!({ "runId": run_id.as_str(), "state": "outcome_unknown" })
        }
        organization::ResumeOutcome::Tombstoned(run_id) => {
            json!({ "runId": run_id.as_str(), "state": "tombstoned" })
        }
    }
}

fn team_trigger_json(trigger: &crate::composition::ArmedTrigger) -> Value {
    let trigger_value = match &trigger.trigger {
        crate::composition::TeamTrigger::Webhook { .. } => json!({ "kind": "webhook" }),
        crate::composition::TeamTrigger::Cron { expression } => {
            json!({ "kind": "cron", "expression": expression })
        }
    };
    json!({
        "teamId": trigger.team_id.as_str(),
        "runId": trigger.run_id.as_str(),
        "startNodeId": trigger.start_node_id,
        "trigger": trigger_value,
    })
}

fn team_graph_status_name(status: organization::GraphStatus) -> &'static str {
    match status {
        organization::GraphStatus::Pending => "pending",
        organization::GraphStatus::Ready => "ready",
        organization::GraphStatus::Running => "running",
        organization::GraphStatus::Waiting => "waiting",
        organization::GraphStatus::Completed => "completed",
        organization::GraphStatus::Failed => "failed",
        organization::GraphStatus::Cancelled => "cancelled",
    }
}

fn team_node_terminal_outcome_name(
    outcome: crate::composition::TeamNodeTerminalResult,
) -> &'static str {
    match outcome {
        crate::composition::TeamNodeTerminalResult::Recorded => "terminal_recorded",
        crate::composition::TeamNodeTerminalResult::Replayed => "terminal_replayed",
    }
}

fn team_node_event_outcome_name(outcome: organization::TeamNodeEventOutcome) -> &'static str {
    match outcome {
        organization::TeamNodeEventOutcome::Progressed => "progressed",
        organization::TeamNodeEventOutcome::WaitingForInput => "waiting_for_input",
        organization::TeamNodeEventOutcome::ApprovalRequested => "approval_requested",
        organization::TeamNodeEventOutcome::TerminalReceiptRequired => "terminal_receipt_required",
    }
}

fn node_prompt_retry_due_item_json(
    item: &organization::run::scheduler::NodePromptRetryDueItem,
) -> Value {
    json!({
        "deliveryId": item.delivery_id().as_str(),
        "nodeId": item.node_id().as_str(),
        "nodeExecutionId": item.node_execution_id(),
        "resolution": node_prompt_retry_due_resolution_json(item.resolution()),
    })
}

fn node_prompt_retry_due_resolution_json(
    resolution: &organization::run::scheduler::NodePromptRetryDueResolution,
) -> Value {
    match resolution {
        organization::run::scheduler::NodePromptRetryDueResolution::Due { retry_at } => {
            json!({ "state": "due", "retryAt": retry_at })
        }
        organization::run::scheduler::NodePromptRetryDueResolution::NotDue { retry_at } => {
            json!({ "state": "not_due", "retryAt": retry_at })
        }
        organization::run::scheduler::NodePromptRetryDueResolution::Unknown(reason) => {
            json!({ "state": "unknown", "reason": node_prompt_retry_due_unknown_reason(*reason) })
        }
        organization::run::scheduler::NodePromptRetryDueResolution::Invalid(reason) => {
            json!({ "state": "invalid", "reason": node_prompt_retry_due_invalid_reason(*reason) })
        }
    }
}

fn node_prompt_retry_due_unknown_reason(
    reason: organization::run::scheduler::NodePromptRetryDueUnknownReason,
) -> &'static str {
    match reason {
        organization::run::scheduler::NodePromptRetryDueUnknownReason::RunUnavailable => {
            "run_unavailable"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::RunLifecycleUncertain => {
            "run_lifecycle_uncertain"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::RuntimeReceiptUnavailable => {
            "runtime_receipt_unavailable"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::DeliveryPending => {
            "delivery_pending"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::DeliveryInFlight => {
            "delivery_in_flight"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::DeliveryOutcomeUnknown => {
            "delivery_outcome_unknown"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::DeliveryTerminalObserved => {
            "delivery_terminal_observed"
        }
        organization::run::scheduler::NodePromptRetryDueUnknownReason::DeliveryTerminal => {
            "delivery_terminal"
        }
    }
}

fn node_prompt_retry_due_invalid_reason(
    reason: organization::run::scheduler::NodePromptRetryDueInvalidReason,
) -> &'static str {
    match reason {
        organization::run::scheduler::NodePromptRetryDueInvalidReason::InvalidFacts => {
            "invalid_facts"
        }
        organization::run::scheduler::NodePromptRetryDueInvalidReason::StaleDeliveryIdentity => {
            "stale_delivery_identity"
        }
    }
}

async fn openclaw_skills_execute(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) if request.id == "skill.management" => request,
        _ => return invalid_input(),
    };
    if !is_native_runtime_scope(&request.scope)
        || !is_skill_capability_request(&request.operation_id, &request.target, &request.input)
    {
        return invalid_input();
    }
    dispatch_skill_operation(owner, request.operation_id, request.target, request.input).await
}

async fn openclaw_plugins_execute(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) if request.id == "plugin.runtime" => request,
        _ => return invalid_input(),
    };
    if !is_native_runtime_scope(&request.scope)
        || request.operation_id != "plugins.setEnabled"
        || !is_plugin_target(&request.target, &request.input)
    {
        return invalid_input();
    }
    let Some(plugin_id) = request.target.get("pluginId").and_then(Value::as_str) else {
        return invalid_input();
    };
    let Some(enabled) = request.input.get("enabled").and_then(Value::as_bool) else {
        return invalid_input();
    };
    match owner
        .plugins_set_enabled(plugin_id.to_owned(), enabled)
        .await
    {
        Ok(crate::plugin::ConfigurationOutcome::Configured) => {
            CommandOutcome::succeeded(json!({ "success": true, "outcome": "configured" }))
        }
        Ok(crate::plugin::ConfigurationOutcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Plugin configuration was rejected.")
        }
        Ok(crate::plugin::ConfigurationOutcome::Unknown) => {
            CommandOutcome::unknown(json!({ "outcome": "unknown" }))
        }
        Err(_) => unavailable(),
    }
}

fn is_native_runtime_scope(value: &Value) -> bool {
    is_native_runtime_scope_for(value, RuntimeDriverIdentity::open_claw())
}

fn is_team_runtime_facade_scope(value: &Value) -> bool {
    is_native_runtime_scope_for(value, RuntimeDriverIdentity::open_claw())
        || is_native_runtime_scope_for(value, RuntimeDriverIdentity::matcha_agent())
}

fn is_native_runtime_scope_for(value: &Value, identity: RuntimeDriverIdentity) -> bool {
    value
        == &json!({
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": identity.runtime_adapter_id(),
                "runtimeInstanceId": identity.runtime_instance_id(),
            },
        })
}

fn is_skill_capability_request(operation: &str, target: &Value, input: &Value) -> bool {
    let Some(target) = target.as_object() else {
        return false;
    };
    let Some(input) = input.as_object() else {
        return false;
    };
    match operation {
        "skills.refreshStatus" => {
            target.len() == 1 && target.get("kind") == Some(&json!("none")) && input.is_empty()
        }
        "skills.exportBundles" => {
            target.len() == 1
                && target.get("kind") == Some(&json!("skill-bundle"))
                && skill_keys_input(input)
        }
        "skills.importBundles" => {
            target.len() == 1
                && target.get("kind") == Some(&json!("skill-bundle"))
                && input.len() == 1
                && input
                    .get("skillBundles")
                    .is_some_and(|bundles| bundles.is_array())
        }
        "skills.updateBatchState" => {
            target.len() == 1
                && target.get("kind") == Some(&json!("skill"))
                && input
                    .get("skillKeys")
                    .and_then(Value::as_array)
                    .is_some_and(|keys| {
                        !keys.is_empty()
                            && keys
                                .iter()
                                .all(|key| key.as_str().is_some_and(valid_skill_key))
                    })
                && input.get("enabled").is_some_and(Value::is_boolean)
                && input.len() == 2
        }
        "skills.updateConfig" => {
            skill_target_matches_input(target, input)
                && input.contains_key("apiKey")
                && input.contains_key("env")
                && input.len() == 3
        }
        "skills.updateState" => {
            skill_target_matches_input(target, input)
                && input.get("enabled").is_some_and(Value::is_boolean)
                && input.len() == 2
        }
        "clawhub.openReadme" | "clawhub.openPath" => {
            skill_target_matches_input(target, input)
                && input
                    .keys()
                    .all(|key| matches!(key.as_str(), "skillKey" | "slug" | "filePath" | "baseDir"))
        }
        _ => false,
    }
}

fn skill_target_matches_input(
    target: &serde_json::Map<String, Value>,
    input: &serde_json::Map<String, Value>,
) -> bool {
    target.len() == 3
        && target.get("kind") == Some(&json!("skill"))
        && target
            .get("skillId")
            .and_then(Value::as_str)
            .is_some_and(valid_skill_key)
        && target
            .get("slug")
            .and_then(Value::as_str)
            .is_some_and(valid_skill_key)
        && input.get("skillKey") == target.get("skillId")
}

fn skill_keys_input(input: &serde_json::Map<String, Value>) -> bool {
    input.len() == 1
        && input
            .get("skillKeys")
            .and_then(Value::as_array)
            .is_some_and(|keys| {
                !keys.is_empty()
                    && keys
                        .iter()
                        .all(|key| key.as_str().is_some_and(valid_skill_key))
            })
}

fn valid_skill_key(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'))
        && !value.ends_with('-')
}

fn is_plugin_target(target: &Value, input: &Value) -> bool {
    let Some(plugin_id) = target.get("pluginId").and_then(Value::as_str) else {
        return false;
    };
    let capability_managed = matches!(
        plugin_id,
        "task-manager"
            | "security-core"
            | "browser-relay"
            | "memory-lancedb-pro"
            | "matchaclaw-media"
    );
    capability_managed
        && !plugin_id.trim().is_empty()
        && target
            .as_object()
            .is_some_and(|object| object.len() == 2 && object.get("kind") == Some(&json!("plugin")))
        && input.get("enabled").and_then(Value::as_bool).is_some()
        && input
            .get("pluginIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(plugin_id))
        && input.as_object().is_some_and(|object| object.len() == 2)
}

async fn dispatch_skill_operation(
    owner: &Handle,
    operation_id: String,
    target: Value,
    input: Value,
) -> CommandOutcome {
    match operation_id.as_str() {
        "skills.updateConfig" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let command = match crate::skill_management::Command::config(
                skill_key.to_owned(),
                None,
                input
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input.get("env").and_then(Value::as_object).map(|env| {
                    env.iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_owned()))
                        })
                        .collect()
                }),
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            skill_management_outcome(owner.manage_skills(command).await)
        }
        "skills.updateState" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let Some(enabled) = input.get("enabled").and_then(Value::as_bool) else {
                return invalid_input();
            };
            let command = match crate::skill_management::Command::config(
                skill_key.to_owned(),
                Some(enabled),
                None,
                None,
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            skill_management_outcome(owner.manage_skills(command).await)
        }
        "skills.updateBatchState" => {
            let Some(skill_keys) = input
                .get("skillKeys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
            else {
                return invalid_input();
            };
            let Some(enabled) = input.get("enabled").and_then(Value::as_bool) else {
                return invalid_input();
            };
            if skill_keys.is_empty() || skill_keys.iter().any(|key| key.trim().is_empty()) {
                return invalid_input();
            }
            let mut outcome = CommandOutcome::succeeded(
                json!({ "success": true, "updated": skill_keys, "enabled": enabled }),
            );
            for skill_key in skill_keys {
                let command = match crate::skill_management::Command::config(
                    skill_key,
                    Some(enabled),
                    None,
                    None,
                ) {
                    Ok(command) => command,
                    Err(_) => return invalid_input(),
                };
                outcome = skill_management_outcome(owner.manage_skills(command).await);
                if !matches!(outcome, CommandOutcome::Succeeded { .. }) {
                    return outcome;
                }
            }
            outcome
        }
        "skills.refreshStatus" => skill_status_outcome(owner.skill_status().await),
        "skills.exportBundles" => {
            let Some(skill_keys) = input
                .get("skillKeys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
            else {
                return invalid_input();
            };
            match owner
                .skill_bundles(crate::skill_bundle::Command::Export { skill_keys })
                .await
            {
                Ok(crate::skill_bundle::Outcome::Exported(bundles)) => CommandOutcome::succeeded(
                    json!({ "skillBundles": bundles.iter().map(|bundle| json!({ "skillKey": bundle.skill_key(), "files": bundle.files().iter().map(|file| json!({ "path": file.path(), "content": file.content() })).collect::<Vec<_>>() })).collect::<Vec<_>>() }),
                ),
                Ok(crate::skill_bundle::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill bundle export was rejected.",
                ),
                Ok(crate::skill_bundle::Outcome::Unknown)
                | Ok(crate::skill_bundle::Outcome::Accepted) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill bundle export outcome is unknown.",
                ),
                Err(_) => unavailable(),
            }
        }
        "skills.importBundles" => {
            let Some(bundles) = decode_skill_bundles(&input) else {
                return invalid_input();
            };
            match owner
                .skill_bundles(crate::skill_bundle::Command::Import { bundles })
                .await
            {
                Ok(crate::skill_bundle::Outcome::Accepted) => {
                    CommandOutcome::succeeded(json!({ "ok": true }))
                }
                Ok(crate::skill_bundle::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill bundle import was rejected.",
                ),
                Ok(crate::skill_bundle::Outcome::Unknown) => {
                    CommandOutcome::unknown(json!({ "outcome": "unknown" }))
                }
                Ok(crate::skill_bundle::Outcome::Exported(_)) => internal_error(),
                Err(_) => unavailable(),
            }
        }
        "clawhub.openReadme" | "clawhub.openPath" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let command = match crate::skill_management::Command::readme(
                skill_key.to_owned(),
                input
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input
                    .get("baseDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            match owner.manage_skills(command).await {
                Ok(crate::skill_management::Outcome::Readme(Ok(receipt))) => {
                    CommandOutcome::succeeded(json!({
                        "success": true,
                        "content": receipt.content,
                        "filePath": receipt.file_path,
                    }))
                }
                Ok(crate::skill_management::Outcome::Readme(Err(_)))
                | Ok(crate::skill_management::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill path receipt was rejected.",
                ),
                Ok(crate::skill_management::Outcome::Unavailable) | Err(_) => unavailable(),
                _ => internal_error(),
            }
        }
        _ => {
            let _ = target;
            invalid_input()
        }
    }
}

fn decode_skill_bundles(input: &Value) -> Option<Vec<crate::skill_bundle::Bundle>> {
    let bundles = input.get("skillBundles")?.as_array()?;
    if bundles.is_empty() {
        return None;
    }
    let mut decoded = Vec::with_capacity(bundles.len());
    for bundle in bundles {
        let object = bundle.as_object()?;
        if object.len() != 2 {
            return None;
        }
        let skill_key = object.get("skillKey")?.as_str()?.to_owned();
        let files = object.get("files")?.as_array()?;
        let mut decoded_files = Vec::with_capacity(files.len());
        for file in files {
            let file = file.as_object()?;
            if file.len() != 2 {
                return None;
            }
            decoded_files.push(
                crate::skill_bundle::BundleFile::try_new(
                    file.get("path")?.as_str()?.to_owned(),
                    file.get("content")?.as_str()?.to_owned(),
                )
                .ok()?,
            );
        }
        decoded.push(crate::skill_bundle::Bundle::try_new(skill_key, decoded_files).ok()?);
    }
    crate::skill_bundle::validate_batch(&decoded).ok()?;
    Some(decoded)
}

fn skill_management_outcome(
    result: Result<crate::skill_management::Outcome, crate::owner::Error>,
) -> CommandOutcome {
    match result {
        Ok(crate::skill_management::Outcome::Mutation(
            crate::skill_management::MutationOutcome::Accepted,
        ))
        | Ok(crate::skill_management::Outcome::Import(
            crate::skill_management::ImportOutcome::Accepted,
        )) => CommandOutcome::succeeded(json!({ "success": true })),
        Ok(crate::skill_management::Outcome::Mutation(
            crate::skill_management::MutationOutcome::Rejected,
        ))
        | Ok(crate::skill_management::Outcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Skill mutation was rejected.")
        }
        Ok(crate::skill_management::Outcome::Mutation(
            crate::skill_management::MutationOutcome::Unknown,
        ))
        | Ok(crate::skill_management::Outcome::Import(
            crate::skill_management::ImportOutcome::Unknown,
        )) => CommandOutcome::unknown(json!({ "outcome": "unknown" })),
        Ok(crate::skill_management::Outcome::Unavailable) | Err(_) => unavailable(),
        _ => internal_error(),
    }
}

fn skill_status_outcome(
    result: Result<crate::skill_status::Outcome, crate::owner::Error>,
) -> CommandOutcome {
    match result {
        Ok(crate::skill_status::Outcome::Available(catalog)) => CommandOutcome::succeeded(json!({
            "skills": catalog.entries.iter().map(|entry| json!({
                "key": entry.key,
                "name": entry.name,
                "description": entry.description,
                "enabled": entry.enabled,
                "selectable": entry.selectable,
                "installed": entry.installed,
                "eligible": entry.eligible,
                "blockedByAllowlist": entry.blocked_by_allowlist,
                "blockedByAgentFilter": entry.blocked_by_agent_filter,
                "unavailableReason": entry.unavailable_reason.map(|reason| format!("{reason:?}").to_ascii_lowercase()),
                "missingCategories": entry.missing_categories.iter().map(|category| format!("{category:?}").to_ascii_lowercase()).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
        })),
        Ok(crate::skill_status::Outcome::Unavailable) | Err(_) => unavailable(),
    }
}

async fn plugins_catalog(owner: &Handle) -> CommandOutcome {
    match owner.plugins_catalog().await {
        Ok(Ok(catalog)) => CommandOutcome::succeeded(json!({ "result": catalog })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn plugins_runtime(owner: &Handle) -> CommandOutcome {
    match owner.plugins_runtime().await {
        Ok(Ok(runtime)) => CommandOutcome::succeeded(json!({ "result": runtime })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginSetEnabledRequest {
    plugin_id: String,
    enabled: bool,
}

async fn plugins_set_enabled(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request: PluginSetEnabledRequest = match decode::<PluginSetEnabledRequest>(input) {
        Ok(request) if !request.plugin_id.trim().is_empty() => request,
        Err(_) | Ok(_) => return invalid_input(),
    };
    match owner
        .plugins_set_enabled(request.plugin_id, request.enabled)
        .await
    {
        Ok(crate::plugin::ConfigurationOutcome::Configured) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "configured" } }))
        }
        Ok(crate::plugin::ConfigurationOutcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Plugin configuration was rejected.")
        }
        Ok(crate::plugin::ConfigurationOutcome::Unknown) => CommandOutcome::rejected(
            RejectionCode::Failed,
            "Plugin configuration outcome is unknown.",
        ),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginOperationRequest {
    operation: String,
    plugin_id: String,
}

async fn plugins_operation(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request: PluginOperationRequest = match decode::<PluginOperationRequest>(input) {
        Ok(request) if !request.plugin_id.trim().is_empty() => request,
        Err(_) | Ok(_) => return invalid_input(),
    };
    let operation = match request.operation.as_str() {
        "install" => crate::plugin::Operation::Install,
        "update" => crate::plugin::Operation::Update,
        "uninstall" => crate::plugin::Operation::Uninstall,
        _ => return invalid_input(),
    };
    match owner.plugins_operation(operation, request.plugin_id).await {
        Ok(crate::plugin::OperationOutcome::Configured) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "configured" } }))
        }
        Ok(crate::plugin::OperationOutcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Plugin operation was rejected.")
        }
        Ok(crate::plugin::OperationOutcome::Unknown) => {
            CommandOutcome::unknown(json!({ "outcome": "unknown" }))
        }
        Err(_) => unavailable(),
    }
}

async fn openclaw_environment_status(owner: &Handle) -> CommandOutcome {
    match owner.open_claw_installation_status().await {
        Ok(Some(status)) => CommandOutcome::succeeded(json!({ "result": status })),
        Ok(None) | Err(_) => unavailable(),
    }
}

async fn openclaw_runtime_paths(owner: &Handle) -> CommandOutcome {
    match owner.open_claw_runtime_paths().await {
        Ok(Ok(paths)) => CommandOutcome::succeeded(json!({
            "result": {
                "openclawDirectory": paths.openclaw_directory(),
                "configDirectory": paths.config_directory(),
                "workspaceDirectory": paths.workspace_directory(),
                "taskWorkspaceDirectories": paths.task_workspace_directories(),
                "skillsDirectory": paths.skills_directory(),
            }
        })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn openclaw_cli_command(owner: &Handle) -> CommandOutcome {
    match owner.open_claw_cli_command().await {
        Ok(Ok(command)) => {
            CommandOutcome::succeeded(json!({ "result": { "command": command.command() } }))
        }
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn openclaw_tool_permission_get(owner: &Handle) -> CommandOutcome {
    match owner.open_claw_tool_permission_mode().await {
        Ok(Ok(mode)) => CommandOutcome::succeeded(json!({ "result": { "mode": mode } })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolPermissionModeRequest {
    mode: openclaw::projection::tool_permission::Mode,
}

async fn openclaw_tool_permission_set(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request = match decode::<ToolPermissionModeRequest>(input) {
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };
    match owner.set_open_claw_tool_permission_mode(request.mode).await {
        Ok(Ok(openclaw::projection::tool_permission::Effect::Unchanged)) => {
            CommandOutcome::succeeded(
                json!({ "result": { "mode": request.mode, "changed": false } }),
            )
        }
        Ok(Ok(openclaw::projection::tool_permission::Effect::Written)) => {
            CommandOutcome::succeeded(
                json!({ "result": { "mode": request.mode, "changed": true } }),
            )
        }
        Ok(Err(openclaw::projection::tool_permission::Error::Unavailable)) => unavailable(),
        Ok(Err(openclaw::projection::tool_permission::Error::Unknown)) | Err(_) => internal_error(),
    }
}

async fn openclaw_toolchain_status(owner: &Handle) -> CommandOutcome {
    match owner.open_claw_toolchain_status().await {
        Ok(Ok(status)) => CommandOutcome::succeeded(json!({
            "result": serde_json::to_value(status).expect("toolchain status serializable")
        })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn openclaw_toolchain_install_uv(owner: &Handle) -> CommandOutcome {
    match owner.install_open_claw_uv().await {
        Ok(Ok(openclaw::toolchain::UvInstallOutcome::Installed)) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "installed" } }))
        }
        Ok(Ok(openclaw::toolchain::UvInstallOutcome::Rejected)) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "rejected" } }))
        }
        Ok(Ok(openclaw::toolchain::UvInstallOutcome::Unknown)) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "unknown" } }))
        }
        Ok(Ok(openclaw::toolchain::UvInstallOutcome::Unavailable)) => unavailable(),
        Ok(Ok(openclaw::toolchain::UvInstallOutcome::Unsupported)) => unavailable(),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn openclaw_toolchain_install_submit(owner: &Handle) -> CommandOutcome {
    match owner.submit_open_claw_toolchain_install().await {
        Ok(Ok(submission)) => CommandOutcome::succeeded(
            serde_json::to_value(submission).unwrap_or_else(|_| json!({ "job": null })),
        ),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn openclaw_toolchain_job_get(owner: &Handle, input: CommandInput) -> CommandOutcome {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct JobGetInput {
        job_id: String,
    }
    let Ok(input) = decode::<JobGetInput>(input) else {
        return invalid_input();
    };
    if input.job_id.trim().is_empty() || input.job_id.len() > 128 {
        return invalid_input();
    }
    match owner.get_compatible_runtime_job(input.job_id).await {
        Ok(Ok(lookup)) => CommandOutcome::succeeded(
            serde_json::to_value(lookup)
                .unwrap_or_else(|_| json!({ "job": null, "outcome": "unknown" })),
        ),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

async fn subagent_template_catalog(owner: &Handle) -> CommandOutcome {
    match owner.list_subagent_templates().await {
        Ok(Ok(catalog)) => CommandOutcome::succeeded(json!({ "result": catalog })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubagentTemplateRequest {
    id: String,
}

async fn subagent_template(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request: SubagentTemplateRequest = match decode::<SubagentTemplateRequest>(input) {
        Ok(request) if !request.id.trim().is_empty() => request,
        Err(_) | Ok(_) => return invalid_input(),
    };
    match owner.subagent_template(request.id).await {
        Ok(Ok(template)) => CommandOutcome::succeeded(json!({ "result": template })),
        Ok(Err(openclaw::projection::subagent_templates::SubagentTemplateError::NotFound)) => {
            CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_INPUT_MESSAGE)
        }
        Ok(Err(openclaw::projection::subagent_templates::SubagentTemplateError::Unavailable))
        | Err(_) => unavailable(),
    }
}

async fn manually_trigger_openclaw_cron(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request = match decode_manual_cron_trigger(input) {
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };
    match owner.trigger_open_claw_cron(request.job_id).await {
        Ok(Ok(openclaw::port::CronTriggerOutcome::Accepted)) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "accepted" } }))
        }
        Ok(Ok(openclaw::port::CronTriggerOutcome::Skipped(disposition))) => {
            let reason = match disposition {
                openclaw::port::CronRunDisposition::AlreadyRunning => "already-running",
                openclaw::port::CronRunDisposition::NotDue => "not-due",
                openclaw::port::CronRunDisposition::InvalidSpec => "invalid-spec",
            };
            CommandOutcome::succeeded(
                json!({ "result": { "outcome": "skipped", "reason": reason } }),
            )
        }
        Ok(Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown)) => {
            CommandOutcome::succeeded(json!({ "result": { "outcome": "outcome-unknown" } }))
        }
        Ok(Err(_)) | Err(_) => {
            CommandOutcome::rejected(RejectionCode::Unavailable, RUNTIME_UNAVAILABLE_MESSAGE)
        }
    }
}

async fn send_openclaw_chat(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let params = match decode_send(input) {
        Ok(params) => params,
        Err(_) => return invalid_input(),
    };
    let outcome = match owner.send_open_claw_chat(params).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => return session_failure(error),
        Err(_) => return internal_error(),
    };
    CommandOutcome::succeeded(json!({ "result": SendChatResponse::from(outcome) }))
}

async fn history_openclaw_chat(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let params = match decode_history(input) {
        Ok(params) => params,
        Err(_) => return invalid_input(),
    };
    let result = match owner.history_open_claw_chat(params).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => return session_failure(error),
        Err(_) => return internal_error(),
    };
    CommandOutcome::succeeded(json!({ "result": ChatHistoryResponse::from(result) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetCredentialWriteCommand {
    operation_id: String,
    credential_id: String,
    credential_name: String,
    plaintext_value: String,
}

async fn fleet_credentials_write(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let request: FleetCredentialWriteCommand = match decode::<FleetCredentialWriteCommand>(input) {
        Ok(request)
            if !request.operation_id.trim().is_empty()
                && !request.credential_id.trim().is_empty() =>
        {
            request
        }
        _ => return invalid_input(),
    };
    let name = match request.credential_name.as_str() {
        "sshPassword" => crate::fleet::credentials::FleetCredentialName::SshPassword,
        "sshPrivateKey" => crate::fleet::credentials::FleetCredentialName::SshPrivateKey,
        "dockerBearerToken" => crate::fleet::credentials::FleetCredentialName::DockerBearerToken,
        "kubeBearerToken" => crate::fleet::credentials::FleetCredentialName::KubeBearerToken,
        _ => return invalid_input(),
    };
    let plaintext =
        match crate::fleet::credentials::FleetCredentialPlaintext::new(request.plaintext_value) {
            Ok(value) => value,
            Err(_) => return invalid_input(),
        };
    let write = crate::fleet::credentials::FleetCredentialWriteRequest {
        operation_id: request.operation_id,
        credential_id: request.credential_id,
        credential_name: name,
        plaintext,
        written_at: chrono::Utc::now().to_rfc3339(),
    };
    match owner.fleet_write_credential(write).await {
        Ok(Ok(crate::fleet::credentials::FleetCredentialWriteOutcome::Written(receipt))) => {
            CommandOutcome::succeeded(
                json!({"credentialRef": receipt.credential_ref.as_str(), "operationId": receipt.operation_id, "credentialName": receipt.credential_name.as_str(), "writtenAt": receipt.written_at}),
            )
        }
        Ok(Ok(crate::fleet::credentials::FleetCredentialWriteOutcome::OperationConflict)) => {
            CommandOutcome::rejected(
                RejectionCode::Failed,
                "Fleet credential operation conflicts with an existing receipt.",
            )
        }
        Ok(Err(_)) | Err(_) => internal_error(),
    }
}

async fn abort_openclaw_chat(owner: &Handle, input: CommandInput) -> CommandOutcome {
    let params = match decode_abort(input) {
        Ok(params) => params,
        Err(_) => return invalid_input(),
    };
    let outcome = match owner.abort_open_claw_chat(params).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => return session_failure(error),
        Err(_) => return internal_error(),
    };
    CommandOutcome::succeeded(json!({ "result": AbortChatResponse::from(outcome) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManualCronTriggerRequest {
    job_id: String,
}

fn decode_manual_cron_trigger(
    input: CommandInput,
) -> Result<ManualCronTriggerRequest, InvalidPayload> {
    let request: ManualCronTriggerRequest = decode(input)?;
    (!request.job_id.trim().is_empty())
        .then_some(request)
        .ok_or(InvalidPayload)
}

fn decode_send(
    input: CommandInput,
) -> Result<openclaw::session::protocol::ChatSendParams, InvalidPayload> {
    decode::<SendChatRequest>(input)?.into_params()
}

fn decode_history(
    input: CommandInput,
) -> Result<openclaw::session::protocol::ChatHistoryParams, InvalidPayload> {
    decode(input)
}

fn decode_abort(
    input: CommandInput,
) -> Result<openclaw::session::protocol::ChatAbortParams, InvalidPayload> {
    let request: AbortChatRequest = decode(input)?;
    request.into_params()
}

fn decode<T: DeserializeOwned>(input: CommandInput) -> Result<T, InvalidPayload> {
    serde_json::from_value(input.into_value()).map_err(|_| InvalidPayload)
}

fn invalid_input() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_INPUT_MESSAGE)
}

fn internal_error() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::Failed, COMMAND_FAILED_MESSAGE)
}

fn unavailable() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::Unavailable, RUNTIME_UNAVAILABLE_MESSAGE)
}

fn scheduler_cron_not_generic_execute() -> CommandOutcome {
    CommandOutcome::rejected(
        RejectionCode::InvalidInput,
        CRON_DESCRIPTOR_NOT_GENERIC_EXECUTE_MESSAGE,
    )
}

fn session_failure<E>(error: RuntimeSessionError<E>) -> CommandOutcome {
    match error {
        RuntimeSessionError::AdmissionClosed(_) | RuntimeSessionError::RuntimeUnavailable => {
            CommandOutcome::rejected(RejectionCode::Unavailable, RUNTIME_UNAVAILABLE_MESSAGE)
        }
        RuntimeSessionError::Client(_) => internal_error(),
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
