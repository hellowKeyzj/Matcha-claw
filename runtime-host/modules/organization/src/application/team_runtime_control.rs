use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

use serde::Deserialize;
use serde_json::{Value, json};

use super::team_runtime::{
    TeamNodeEventCommandOutcome, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
    TeamRuntimeDecodeError, TeamRuntimeStatus, decode_team_runtime_command,
};

pub const TEAM_PUBLIC_PLACEHOLDER_PATH: &str = "";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityExecuteRequest {
    id: String,
    operation_id: String,
    scope: Value,
    target: Value,
    input: Value,
    #[serde(rename = "traceId", default)]
    trace_id: Option<String>,
}

pub struct TeamRuntimeCapabilityRequest {
    operation_id: String,
    trace_id: Option<String>,
    target_kind: Option<String>,
    team_id: Option<String>,
    run_id: Option<String>,
    command: TeamRuntimeCommand,
    projection_context: Option<TeamRuntimeProjectionContext>,
}

impl TeamRuntimeCapabilityRequest {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }

    pub fn target_kind(&self) -> Option<&str> {
        self.target_kind.as_deref()
    }

    pub fn team_id(&self) -> Option<&str> {
        self.team_id.as_deref()
    }

    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    pub(crate) fn single_stage(&self) -> bool {
        crate::call::runtime_single_stage(&self.command)
    }

    pub fn into_execution(self) -> (TeamRuntimeCommand, Option<TeamRuntimeProjectionContext>) {
        (self.command, self.projection_context)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum TeamRuntimeControlOutcome {
    Succeeded(Value),
    Unknown(Value),
    InvalidInput,
    Unavailable,
    Failed(&'static str),
}

impl TeamRuntimeControlOutcome {
    fn succeeded(result: Value) -> Self {
        Self::Succeeded(result)
    }

    fn unknown(result: Value) -> Self {
        Self::Unknown(result)
    }

    fn rejected(_: TeamRuntimeProjectionRejection, message: &'static str) -> Self {
        Self::Failed(message)
    }
}

type TeamRuntimeProjectionOutcome = TeamRuntimeControlOutcome;

struct TeamRuntimePrivateResult;

impl TeamRuntimePrivateResult {
    fn private(value: impl Into<Value>) -> Value {
        value.into()
    }
}

#[derive(Clone, Copy)]
enum TeamRuntimeProjectionRejection {
    Failed,
}

pub fn decode_team_runtime_capability_request(
    input: Value,
) -> Result<TeamRuntimeCapabilityRequest, TeamRuntimeDecodeError> {
    let request: CapabilityExecuteRequest =
        serde_json::from_value(input).map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    if request.id != "team.runtime" {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let endpoint =
        team_runtime_facade_endpoint(&request.scope).ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let input_object = request.input.as_object();
    let target_kind = team_runtime_target_kind(&request.target).map(str::to_owned);
    let team_id = team_runtime_input_string(input_object, "teamId").map(str::to_owned);
    let run_id = team_runtime_input_string(input_object, "runId").map(str::to_owned);
    let command = decode_team_runtime_command(
        &request.operation_id,
        &request.target,
        &request.input,
        endpoint,
    )?;
    let projection_context = TeamRuntimeProjectionContext::from_command(&command);
    Ok(TeamRuntimeCapabilityRequest {
        operation_id: request.operation_id,
        trace_id: request.trace_id,
        target_kind,
        team_id,
        run_id,
        command,
        projection_context,
    })
}

pub async fn execute_team_runtime_capability_request(
    owner: &organization::OrganizationHandle,
    resolver: &dyn organization::RoleSessionIdentityResolver,
    request: TeamRuntimeCapabilityRequest,
) -> Result<(String, TeamRuntimeControlOutcome), TeamRuntimeDecodeError> {
    execute_inline(owner, resolver, request).await
}

pub(crate) async fn execute_inline(
    owner: &organization::OrganizationHandle,
    resolver: &dyn organization::RoleSessionIdentityResolver,
    request: TeamRuntimeCapabilityRequest,
) -> Result<(String, TeamRuntimeControlOutcome), TeamRuntimeDecodeError> {
    let operation_id = request.operation_id().to_owned();
    let team_id = request.team_id().map(str::to_owned);
    let run_id = request.run_id().map(str::to_owned);
    let (command, projection_context) = request.into_execution();
    let outcome = owner
        .execute_team_runtime_inline(command)
        .await
        .map_err(|_| TeamRuntimeDecodeError::Unavailable)?;
    let outcome = project_team_runtime_outcome(
        outcome,
        team_id.as_deref(),
        run_id.as_deref(),
        projection_context.as_ref(),
        resolver,
    );
    Ok((operation_id, outcome))
}

pub fn is_team_runtime_facade_scope(value: &Value) -> bool {
    team_runtime_facade_endpoint(value).is_some()
}

fn team_runtime_facade_endpoint(value: &Value) -> Option<organization::RuntimeEndpointReference> {
    for identity in [
        runtime_directory::RuntimeDriverIdentity::open_claw(),
        runtime_directory::RuntimeDriverIdentity::matcha_agent(),
    ] {
        if is_native_runtime_scope_for(value, identity) {
            return organization::RuntimeEndpointReference::try_new(
                identity.runtime_endpoint_reference().to_owned(),
            )
            .ok();
        }
    }
    None
}

fn is_native_runtime_scope_for(
    value: &Value,
    identity: runtime_directory::RuntimeDriverIdentity,
) -> bool {
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

pub fn summarize_team_runtime_control_outcome(
    operation_id: &str,
    outcome: &TeamRuntimeControlOutcome,
) -> Value {
    match outcome {
        TeamRuntimeControlOutcome::Succeeded(result) => json!({
            "operationId": operation_id,
            "outcome": "succeeded",
            "contract": team_runtime_result_contract(result),
        }),
        TeamRuntimeControlOutcome::Unknown(result) => json!({
            "operationId": operation_id,
            "outcome": "unknown",
            "contract": team_runtime_result_contract(result),
        }),
        TeamRuntimeControlOutcome::Failed(_)
        | TeamRuntimeControlOutcome::InvalidInput
        | TeamRuntimeControlOutcome::Unavailable => json!({
            "operationId": operation_id,
            "outcome": "rejected",
        }),
    }
}

fn invalid_input() -> TeamRuntimeControlOutcome {
    TeamRuntimeControlOutcome::InvalidInput
}

fn unavailable() -> TeamRuntimeControlOutcome {
    TeamRuntimeControlOutcome::Unavailable
}

pub enum TeamRuntimeProjectionContext {
    DependencyPlan { package_root: PathBuf },
}

impl TeamRuntimeProjectionContext {
    fn from_command(command: &TeamRuntimeCommand) -> Option<Self> {
        match command {
            TeamRuntimeCommand::DependencyPlan { package_root } => Some(Self::DependencyPlan {
                package_root: package_root.clone(),
            }),
            _ => None,
        }
    }

    fn dependency_package_root(&self) -> &PathBuf {
        match self {
            Self::DependencyPlan { package_root } => package_root,
        }
    }
}

fn team_runtime_target_kind(target: &Value) -> Option<&str> {
    target
        .as_object()
        .and_then(|target| target.get("kind"))
        .and_then(Value::as_str)
}

fn team_runtime_input_string<'a>(
    input: Option<&'a serde_json::Map<String, Value>>,
    key: &str,
) -> Option<&'a str> {
    input?
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn team_runtime_result_contract(result: &Value) -> &'static str {
    let Some(result) = result.as_object() else {
        return "invalid";
    };
    if result.get("runs").is_some_and(Value::is_array) {
        return "run-list";
    }
    if result.get("diagnostics").is_some_and(Value::is_object) {
        return "snapshot";
    }
    if result
        .get("managedAgentCount")
        .is_some_and(Value::is_number)
    {
        return "provisioned";
    }
    if result.get("yaml").is_some_and(Value::is_string) {
        return "graph-yaml";
    }
    if result.get("triggers").is_some_and(Value::is_array) {
        return "trigger-list";
    }
    if result.get("status").is_some_and(Value::is_string) {
        return "package-validation";
    }
    "operation-result"
}

pub fn project_team_runtime_outcome(
    outcome: TeamRuntimeCommandOutcome,
    team_id: Option<&str>,
    run_id: Option<&str>,
    projection_context: Option<&TeamRuntimeProjectionContext>,
    resolver: &dyn organization::RoleSessionIdentityResolver,
) -> TeamRuntimeControlOutcome {
    team_runtime_outcome_with_context(outcome, team_id, run_id, projection_context, resolver)
}

fn team_runtime_outcome_with_context(
    outcome: TeamRuntimeCommandOutcome,
    team_id: Option<&str>,
    run_id: Option<&str>,
    projection_context: Option<&TeamRuntimeProjectionContext>,
    resolver: &dyn organization::RoleSessionIdentityResolver,
) -> TeamRuntimeProjectionOutcome {
    match outcome {
        TeamRuntimeCommandOutcome::PackageValidate(validation) => {
            TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(team_skill_package_validation_json(&validation)))
        }
        TeamRuntimeCommandOutcome::DependencyPlan(plan) => match team_skill_dependency_plan_json(
            &plan,
            projection_context.map(TeamRuntimeProjectionContext::dependency_package_root),
        ) {
            Some(result) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(result)),
            None => unavailable(),
        },
        TeamRuntimeCommandOutcome::ProvisionAgents(outcome) => match outcome {
            organization::TeamMaterializationCommandOutcome::Materialized {
                team_id,
                managed_agent_count,
            } => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "teamId": team_id.as_str(),
                "managedAgentCount": managed_agent_count,
            }))),
            organization::TeamMaterializationCommandOutcome::Rejected => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team agent materialization was rejected.")
            }
            organization::TeamMaterializationCommandOutcome::OutcomeUnknown => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            organization::TeamMaterializationCommandOutcome::Unavailable => unavailable(),
        },
        TeamRuntimeCommandOutcome::Delete(result) => match result {
            Ok(organization::TeamDeleteOutcome::Deleted) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "teamId": team_id,
                "state": "tombstoned",
            }))),
            Ok(organization::TeamDeleteOutcome::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "teamId": team_id, "state": "outcome_unknown" })))
            }
            Err(_) => TeamRuntimeProjectionOutcome::rejected(
                TeamRuntimeProjectionRejection::Failed,
                "Team deletion was rejected.",
            ),
        },
        TeamRuntimeCommandOutcome::RunCreate(result) => match result {
            Ok(organization::CreateGraphRunOutcome::Created(run_id)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "runId": run_id.as_str(),
                "status": "created",
                "revision": 1,
            }))),
            Ok(organization::CreateGraphRunOutcome::Replayed(run_id)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "runId": run_id.as_str(),
                "status": "created",
                "revision": 1,
                "replayed": true,
            }))),
            Ok(organization::CreateGraphRunOutcome::ExistingRun)
            | Ok(organization::CreateGraphRunOutcome::ConflictingIdempotency)
            | Err(TeamRuntimeStatus::Rejected) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team run creation was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunList(runs) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
            "teamId": team_id,
            "runs": runs.iter().filter_map(|run| team_run_list_item_legacy_json(run, resolver)).collect::<Vec<_>>(),
        }))),
        TeamRuntimeCommandOutcome::Resume {
            team_id,
            outcomes,
            runs,
        } => {
            let result = team_resume_legacy_json(&team_id, &outcomes, &runs, resolver);
            if outcomes
                .iter()
                .any(|outcome| matches!(outcome, organization::ResumeOutcome::OutcomeUnknown(_)))
            {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(result))
            } else {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(result))
            }
        },
        TeamRuntimeCommandOutcome::TriggerList(triggers) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
            "triggers": triggers.iter().map(team_trigger_json).collect::<Vec<_>>(),
        }))),
        TeamRuntimeCommandOutcome::TriggerFire(result) => match result {
            Ok(result) => team_run_trigger_outcome(result),
            Err(_) => TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team trigger was rejected."),
        },
        TeamRuntimeCommandOutcome::RunStartConfirm(result) => match result {
            Ok(organization::ConfirmRunStartOutcome::Started)
            | Ok(organization::ConfirmRunStartOutcome::Replayed) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                    "success": true,
                    "outcome": "started",
                })))
            }
            Ok(organization::ConfirmRunStartOutcome::Intake)
            | Ok(organization::ConfirmRunStartOutcome::ProposalMismatch) => TeamRuntimeProjectionOutcome::rejected(
                TeamRuntimeProjectionRejection::Failed,
                "Team run start proposal was rejected.",
            ),
            Err(_) => TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" }))),
        },
        TeamRuntimeCommandOutcome::RunStartContinue(result) => match result {
            Ok(organization::ContinueRunDiscussionOutcome::Intake)
            | Ok(organization::ContinueRunDiscussionOutcome::Replayed) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                    "success": true,
                    "outcome": "intake",
                })))
            }
            Ok(organization::ContinueRunDiscussionOutcome::AlreadyStarted)
            | Ok(organization::ContinueRunDiscussionOutcome::ProposalMismatch) => TeamRuntimeProjectionOutcome::rejected(
                TeamRuntimeProjectionRejection::Failed,
                "Team run start proposal was rejected.",
            ),
            Err(_) => TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" }))),
        },
        TeamRuntimeCommandOutcome::RunSnapshotInvalidInput => invalid_input(),
        TeamRuntimeCommandOutcome::RunSnapshot {
            snapshot,
            role_sessions,
        } => match snapshot {
            organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(snapshot) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(team_run_public_snapshot_legacy_json(&snapshot, role_sessions.as_deref(), resolver)))
            }
            organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Unavailable(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphExportYaml(result) => match result {
            Ok(yaml) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "runId": run_id,
                "fileName": run_id.map(|run_id| format!("{run_id}.yaml")),
                "yaml": yaml,
            }))),
            Err(TeamRuntimeStatus::Rejected) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team graph export was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphImportYaml(result) => match result {
            Ok(organization::TeamRunCommandOutcome::Available(run)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "runId": run.run().as_str(),
                "imported": true,
            }))),
            Ok(organization::TeamRunCommandOutcome::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Ok(organization::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Err(organization::StoreFault::CommitOutcomeUnknown(_)) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(organization::StoreFault::InvalidFacts | organization::StoreFault::EventLedger(_)) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team graph import was rejected.")
            }
            Err(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunDiagnostics(result) => match result {
            organization::TeamRunDiagnosticsQueryOutcome::Available(diagnostics) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(team_run_diagnostics_json(&diagnostics)))
            }
            organization::TeamRunDiagnosticsQueryOutcome::Unavailable(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::WebhookTriggerFire(result) => match result {
            Ok(organization::TeamTriggerFireOutcome::Recorded(request)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "fired": true,
                "runId": request.trigger.run_id,
                "outcome": "recorded",
            }))),
            Ok(organization::TeamTriggerFireOutcome::Replayed(request)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "fired": false,
                "runId": request.trigger.run_id,
                "outcome": "replayed",
            }))),
            Ok(organization::TeamTriggerFireOutcome::Conflicting { .. }) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team webhook trigger conflicted with an existing request.")
            }
            Ok(organization::TeamTriggerFireOutcome::NotFound) => unavailable(),
            Ok(organization::TeamTriggerFireOutcome::Unknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Ok(organization::TeamTriggerFireOutcome::Rejected) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team webhook trigger was rejected.")
            }
            Err(TeamRuntimeStatus::Rejected) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team webhook trigger was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphSave(result) => match result {
            Ok(organization::TeamRunCommandOutcome::Available(run)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "runId": run.run().as_str(),
                "saved": true,
                "outcome": "available",
            }))),
            Ok(organization::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Ok(organization::TeamRunCommandOutcome::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(_) => TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team graph command was rejected."),
        },
        TeamRuntimeCommandOutcome::GraphPatch(result) => match result {
            Ok(organization::TeamRunCommandOutcome::Available(run)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "runId": run.run().as_str(),
                "saved": true,
                "outcome": "available",
            }))),
            Ok(organization::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Ok(organization::TeamRunCommandOutcome::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(_) => TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Graph patch validation failed. Refresh the TeamRun graph and retry; use the Review rework outlet for upstream rework links."),
        },
        TeamRuntimeCommandOutcome::GraphContext(result) => match result {
            organization::TeamGraphContextResult::Available(context) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
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
            }))),
            organization::TeamGraphContextResult::Unavailable => unavailable(),
            organization::TeamGraphContextResult::OutcomeUnknown => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" })))
            }
        },
        TeamRuntimeCommandOutcome::NodePromptRetryDue(result) => match result {
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Available(plan) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                    "runId": plan.run_id().as_str(),
                    "processedDeliveryRecordIds": plan.due_items().map(|item| item.delivery_id().as_str()).collect::<Vec<_>>(),
                    "nextRetryAt": plan.next_retry_at(),
                    "items": plan.items().iter().map(node_prompt_retry_due_item_json).collect::<Vec<_>>(),
                })))
            }
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Unknown(reason) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "outcome": "unknown", "reason": node_prompt_retry_due_unknown_reason(reason) })))
            }
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Invalid(reason) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, node_prompt_retry_due_invalid_reason(reason))
            }
        },
        TeamRuntimeCommandOutcome::NodeEvent(result) => match result {
            Ok(TeamNodeEventCommandOutcome::NonTerminal(outcome)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "runId": run_id,
                "outcome": team_node_event_outcome_name(outcome),
            }))),
            Ok(TeamNodeEventCommandOutcome::Terminal(outcome)) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "runId": run_id,
                "outcome": team_node_terminal_outcome_name(outcome),
            }))),
            Err(TeamRuntimeStatus::Rejected) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team node event was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunDecisionSubmit(result) => match result {
            Ok(receipt) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
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
            }))),
            Err(TeamRuntimeStatus::Rejected) => {
                TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team decision was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::ApprovalResolve(result) => match result {
            Ok(organization::run::approval::HumanDecisionOutcome::Recorded) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({ "success": true, "outcome": "recorded" })))
            }
            Ok(organization::run::approval::HumanDecisionOutcome::Replayed) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({ "success": true, "outcome": "replayed" })))
            }
            Err(_) => TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "outcome": "outcome-unknown" }))),
        },
        TeamRuntimeCommandOutcome::RunCancel(result) => match result {
            Ok(organization::BeginCancellationOutcome::Started(_))
            | Ok(organization::BeginCancellationOutcome::Replayed(_)) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "cancelling",
                })))
            }
            Ok(organization::BeginCancellationOutcome::AlreadyCancelled) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "cancelled",
                })))
            }
            Ok(organization::BeginCancellationOutcome::Tombstoned) => {
                TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "tombstoned",
                })))
            }
            Ok(organization::BeginCancellationOutcome::OutcomeUnknown) | Err(_) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "state": "outcome_unknown" })))
            }
        },
        TeamRuntimeCommandOutcome::RunDelete(result) => match result {
            Ok(organization::GraphRunPurgeOutcome::Purged)
            | Ok(organization::GraphRunPurgeOutcome::Replayed) => TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "runId": run_id,
                "state": "purged",
            }))),
            Ok(organization::GraphRunPurgeOutcome::Rejected(_)) => TeamRuntimeProjectionOutcome::rejected(
                TeamRuntimeProjectionRejection::Failed,
                "Team run deletion was rejected.",
            ),
            Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(_)) => {
                TeamRuntimeProjectionOutcome::unknown(TeamRuntimePrivateResult::private(json!({ "runId": run_id, "state": "outcome_unknown" })))
            }
            Err(_) => TeamRuntimeProjectionOutcome::rejected(TeamRuntimeProjectionRejection::Failed, "Team run deletion was rejected."),
        },
    }
}

fn team_skill_dependency_plan_json(
    plan: &organization::package::TeamSkillDependencyPlanResult,
    package_root: Option<&PathBuf>,
) -> Option<Value> {
    match plan {
        organization::package::TeamSkillDependencyPlanResult::Available { plan } => {
            let package_root = package_root?;
            let root = organization::package::TeamSkillPackageRoot::open(package_root).ok()?;
            let package = organization::package::TeamSkillPackageReader::new(root)
                .read()
                .ok()?;
            let items = package
                .dependencies()
                .iter()
                .zip(plan.items())
                .map(|(dependency, item)| team_skill_dependency_plan_item_json(dependency, item))
                .collect::<Vec<_>>();
            Some(json!({
                "status": "available",
                "plan": {
                    "selectionId": plan.selection_id().as_str(),
                    "packageName": package.name(),
                    "packageVersion": package.version(),
                    "items": items,
                    "canProceed": plan.can_proceed(),
                },
            }))
        }
        organization::package::TeamSkillDependencyPlanResult::Invalid => Some(json!({
            "status": "invalid",
        })),
        organization::package::TeamSkillDependencyPlanResult::Unavailable => Some(json!({
            "status": "unavailable",
        })),
    }
}

fn team_skill_dependency_plan_item_json(
    dependency: &organization::package::Dependency,
    item: &organization::package::TeamSkillDependencyPlanItem,
) -> Value {
    json!({
        "kind": team_skill_dependency_kind_name(dependency.kind()),
        "name": dependency.name(),
        "required": dependency.required(),
        "purpose": dependency.purpose(),
        "status": team_skill_dependency_status_name(item.status()),
        "severity": team_skill_dependency_severity_name(item.severity()),
        "installable": item.installable(),
    })
}

fn team_skill_dependency_kind_name(kind: organization::package::DependencyKind) -> &'static str {
    match kind {
        organization::package::DependencyKind::Skill => "skill",
        organization::package::DependencyKind::Tool => "tool",
    }
}

fn team_skill_dependency_status_name(
    status: organization::package::TeamSkillDependencyStatus,
) -> &'static str {
    match status {
        organization::package::TeamSkillDependencyStatus::Available => "available",
        organization::package::TeamSkillDependencyStatus::Missing => "missing",
    }
}

fn team_skill_dependency_severity_name(
    severity: organization::package::TeamSkillDependencySeverity,
) -> &'static str {
    match severity {
        organization::package::TeamSkillDependencySeverity::Ok => "ok",
        organization::package::TeamSkillDependencySeverity::Warning => "warning",
        organization::package::TeamSkillDependencySeverity::Blocker => "blocker",
    }
}

fn team_skill_package_validation_json(
    validation: &organization::package::TeamSkillPackageValidation,
) -> Value {
    match validation {
        organization::package::TeamSkillPackageValidation::Valid { package } => json!({
            "status": "valid",
            "package": {
                "selectionId": package.selection_id().as_str(),
                "name": package.name(),
                "version": package.version(),
                "kind": "team-skill",
                "description": package.description(),
            },
        }),
        organization::package::TeamSkillPackageValidation::Invalid => json!({
            "status": "invalid",
        }),
        organization::package::TeamSkillPackageValidation::Unavailable => json!({
            "status": "unavailable",
        }),
    }
}

fn team_run_diagnostics_json(diagnostics: &organization::TeamRunDiagnosticsProjection) -> Value {
    json!({
        "runId": diagnostics.run_id(),
        "status": team_run_diagnostics_status_json(diagnostics.status()),
        "failure": team_run_diagnostics_failure_json(diagnostics.failure()),
        "retry": team_run_diagnostics_retry_json(diagnostics.retry()),
        "approval": team_run_diagnostics_approval_json(diagnostics.approval()),
        "delivery": team_run_diagnostics_delivery_json(diagnostics.delivery()),
        "recoveredFromStorage": diagnostics.recovered_from_storage(),
        "budgets": team_run_diagnostics_budgets_json(diagnostics.budgets()),
        "limits": team_run_diagnostics_limits_json(diagnostics.limits()),
        "staleDispatchExecutions": diagnostics.stale_dispatch_executions().iter().map(team_run_diagnostics_stale_execution_json).collect::<Vec<_>>(),
        "counts": diagnostics.counts().iter().map(|(key, value)| (key.clone(), json!(value))).collect::<BTreeMap<_, _>>(),
        "unavailableSections": diagnostics.unavailable_sections().iter().map(|section| team_run_diagnostics_unavailable_section_name(*section)).collect::<Vec<_>>(),
    })
}

fn team_run_diagnostics_status_json(status: &organization::TeamRunDiagnosticsStatus) -> Value {
    json!({
        "graph": team_run_diagnostics_graph_status_name(status.graph()),
        "lifecycle": team_run_diagnostics_lifecycle_status_name(status.lifecycle()),
        "confidence": team_run_diagnostics_confidence_name(status.confidence()),
    })
}

fn team_run_diagnostics_failure_json(
    failure: &organization::TeamRunDiagnosticsFailureSummary,
) -> Value {
    json!({
        "total": failure.total(),
        "failedAttempts": failure.failed_attempts(),
        "deliveryFailures": team_run_diagnostics_delivery_failure_json(failure.delivery_failures()),
        "unknownOutcomes": failure.unknown_outcomes(),
    })
}

fn team_run_diagnostics_delivery_failure_json(
    failure: &organization::TeamRunDiagnosticsDeliveryFailureSummary,
) -> Value {
    json!({
        "total": failure.total(),
        "receiverRejected": failure.receiver_rejected(),
        "policyRejected": failure.policy_rejected(),
        "unavailable": failure.unavailable(),
        "timedOut": failure.timed_out(),
    })
}

fn team_run_diagnostics_retry_json(retry: &organization::TeamRunDiagnosticsRetrySummary) -> Value {
    json!({
        "reworkAttempts": retry.rework_attempts(),
        "retryScheduled": retry.retry_scheduled(),
        "retryableFailures": retry.retryable_failures(),
        "nonRetryableFailures": retry.non_retryable_failures(),
        "retryDecisions": retry.retry_decisions(),
    })
}

fn team_run_diagnostics_approval_json(
    approval: &organization::TeamRunDiagnosticsApprovalSummary,
) -> Value {
    json!({
        "total": approval.total(),
        "pending": approval.pending(),
        "approved": approval.approved(),
        "denied": approval.denied(),
        "aborted": approval.aborted(),
        "resolutions": approval.resolutions(),
        "approveDecisions": approval.approve_decisions(),
        "denyDecisions": approval.deny_decisions(),
        "abortDecisions": approval.abort_decisions(),
        "humanDecisions": approval.human_decisions(),
        "runCancelled": approval.run_cancelled(),
    })
}

fn team_run_diagnostics_delivery_json(
    delivery: &organization::TeamRunDiagnosticsDeliverySummary,
) -> Value {
    json!({
        "total": delivery.total(),
        "pending": delivery.pending(),
        "delivering": delivery.delivering(),
        "retryScheduled": delivery.retry_scheduled(),
        "delivered": delivery.delivered(),
        "terminalObserved": delivery.terminal_observed(),
        "failed": delivery.failed(),
        "outcomeUnknown": delivery.outcome_unknown(),
        "cancelled": delivery.cancelled(),
        "failures": team_run_diagnostics_delivery_failure_json(delivery.failures()),
    })
}

fn team_run_diagnostics_budgets_json(budgets: &organization::TeamRunDiagnosticsBudgets) -> Value {
    json!({
        "totalWallClockBudgetMs": budgets.total_wall_clock_budget_ms(),
        "totalTokenBudget": budgets.total_token_budget(),
        "roleWallClockBudgetMs": budgets.role_wall_clock_budget_ms(),
        "roleTokenBudget": budgets.role_token_budget(),
        "elapsedMs": budgets.elapsed_ms(),
        "wallClockExceeded": budgets.wall_clock_exceeded(),
    })
}

fn team_run_diagnostics_limits_json(limits: &organization::TeamRunDiagnosticsLimits) -> Value {
    json!({
        "maxArtifactContentBytes": limits.max_artifact_content_bytes(),
        "maxMessageBodyBytes": limits.max_message_body_bytes(),
        "staleDispatchExecutionMs": limits.stale_dispatch_execution_ms(),
    })
}

fn team_run_diagnostics_stale_execution_json(
    stale_execution: &organization::TeamRunDiagnosticsStaleExecution,
) -> Value {
    json!({
        "executionId": stale_execution.execution_id(),
        "observedAt": stale_execution.observed_at(),
    })
}

fn team_run_diagnostics_confidence_name(
    confidence: organization::TeamRunDiagnosticsConfidence,
) -> &'static str {
    match confidence {
        organization::TeamRunDiagnosticsConfidence::Confirmed => "confirmed",
        organization::TeamRunDiagnosticsConfidence::Unknown => "unknown",
        organization::TeamRunDiagnosticsConfidence::Unavailable => "unavailable",
    }
}

fn team_run_diagnostics_graph_status_name(
    status: organization::TeamRunDiagnosticsGraphStatus,
) -> &'static str {
    match status {
        organization::TeamRunDiagnosticsGraphStatus::Pending => "pending",
        organization::TeamRunDiagnosticsGraphStatus::Ready => "ready",
        organization::TeamRunDiagnosticsGraphStatus::Running => "running",
        organization::TeamRunDiagnosticsGraphStatus::Waiting => "waiting",
        organization::TeamRunDiagnosticsGraphStatus::Completed => "completed",
        organization::TeamRunDiagnosticsGraphStatus::Failed => "failed",
        organization::TeamRunDiagnosticsGraphStatus::Cancelled => "cancelled",
    }
}

fn team_run_diagnostics_lifecycle_status_name(
    status: organization::TeamRunDiagnosticsLifecycleStatus,
) -> &'static str {
    match status {
        organization::TeamRunDiagnosticsLifecycleStatus::Active => "active",
        organization::TeamRunDiagnosticsLifecycleStatus::Cancelling => "cancelling",
        organization::TeamRunDiagnosticsLifecycleStatus::Cancelled => "cancelled",
        organization::TeamRunDiagnosticsLifecycleStatus::OutcomeUnknown => "outcome_unknown",
        organization::TeamRunDiagnosticsLifecycleStatus::Tombstoned => "tombstoned",
    }
}

fn team_run_diagnostics_unavailable_section_name(
    section: organization::TeamRunDiagnosticsUnavailableSection,
) -> &'static str {
    match section {
        organization::TeamRunDiagnosticsUnavailableSection::StorageRecovery => "storage_recovery",
        organization::TeamRunDiagnosticsUnavailableSection::StorageRoot => "storage_root",
        organization::TeamRunDiagnosticsUnavailableSection::Budgets => "budgets",
        organization::TeamRunDiagnosticsUnavailableSection::Limits => "limits",
        organization::TeamRunDiagnosticsUnavailableSection::StaleDispatchExecutions => {
            "stale_dispatch_executions"
        }
        organization::TeamRunDiagnosticsUnavailableSection::Roles => "roles",
        organization::TeamRunDiagnosticsUnavailableSection::Stages => "stages",
        organization::TeamRunDiagnosticsUnavailableSection::WorkflowPlan => "workflow_plan",
        organization::TeamRunDiagnosticsUnavailableSection::DispatchGroups => "dispatch_groups",
        organization::TeamRunDiagnosticsUnavailableSection::DispatchTasks => "dispatch_tasks",
        organization::TeamRunDiagnosticsUnavailableSection::Dispatches => "dispatches",
        organization::TeamRunDiagnosticsUnavailableSection::DispatchExecutions => {
            "dispatch_executions"
        }
        organization::TeamRunDiagnosticsUnavailableSection::Messages => "messages",
        organization::TeamRunDiagnosticsUnavailableSection::NodePromptDeliveries => {
            "node_prompt_deliveries"
        }
        organization::TeamRunDiagnosticsUnavailableSection::Gates => "gates",
        organization::TeamRunDiagnosticsUnavailableSection::Kickbacks => "kickbacks",
        organization::TeamRunDiagnosticsUnavailableSection::NodeInputStates => "node_input_states",
        organization::TeamRunDiagnosticsUnavailableSection::Workspace => "workspace",
        organization::TeamRunDiagnosticsUnavailableSection::Prompts => "prompts",
        organization::TeamRunDiagnosticsUnavailableSection::NativeSessions => "native_sessions",
        organization::TeamRunDiagnosticsUnavailableSection::RuntimeBindings => "runtime_bindings",
        organization::TeamRunDiagnosticsUnavailableSection::Receipts => "receipts",
        organization::TeamRunDiagnosticsUnavailableSection::Tokens => "tokens",
        organization::TeamRunDiagnosticsUnavailableSection::Transcripts => "transcripts",
        organization::TeamRunDiagnosticsUnavailableSection::RawPayloads => "raw_payloads",
    }
}

fn team_run_trigger_outcome(
    result: organization::TeamRunTriggerOutcome,
) -> TeamRuntimeProjectionOutcome {
    match result.registration() {
        organization::TriggerRegistration::Recorded(request) => {
            TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "fired": true,
                "runId": request.run_id.as_str(),
                "outcome": "recorded",
            })))
        }
        organization::TriggerRegistration::Replayed(request) => {
            TeamRuntimeProjectionOutcome::succeeded(TeamRuntimePrivateResult::private(json!({
                "success": true,
                "fired": false,
                "runId": request.run_id.as_str(),
                "outcome": "replayed",
            })))
        }
        organization::TriggerRegistration::ConflictingIdempotencyKey { .. } => {
            TeamRuntimeProjectionOutcome::rejected(
                TeamRuntimeProjectionRejection::Failed,
                "Team trigger was rejected.",
            )
        }
    }
}

fn team_run_list_item_legacy_json(
    outcome: &organization::TeamRunQueryOutcome,
    resolver: &dyn organization::RoleSessionIdentityResolver,
) -> Option<Value> {
    match outcome {
        organization::TeamRunQueryOutcome::Available(run) => {
            let sessions = team_role_session_receipts_legacy_json(run.role_sessions(), resolver);
            Some(json!({
                "runId": run.run().as_str(),
                "status": team_run_status_from_graph_status(run.graph_status()),
                "revision": run.team_revision().get(),
                "packageName": "",
                "packageVersion": "",
                "sourcePath": TEAM_PUBLIC_PLACEHOLDER_PATH,
                "createdAt": 0,
                "updatedAt": 0,
                "sessions": sessions,
            }))
        }
        organization::TeamRunQueryOutcome::Unavailable
        | organization::TeamRunQueryOutcome::OutcomeUnknown => None,
    }
}

fn team_run_public_snapshot_legacy_json(
    snapshot: &organization::run::public_projection::TeamRunPublicSnapshot,
    role_sessions: Option<&[organization::RoleSessionReceipt]>,
    resolver: &dyn organization::RoleSessionIdentityResolver,
) -> Value {
    let roles_available = role_sessions.is_some();
    let roles =
        role_sessions.map(|sessions| team_role_session_receipts_legacy_json(sessions, resolver));
    json!({
        "run": team_public_run_legacy_json(snapshot),
        "graph": team_public_graph_legacy_json(snapshot.run().run_id(), snapshot.graph()),
        "nodeInputStates": [],
        "nodeExecutions": snapshot.attempts().iter().map(|attempt| team_public_attempt_legacy_json(snapshot.run().run_id(), attempt)).collect::<Vec<_>>(),
        "nodeDeliveries": [],
        "roles": roles.unwrap_or_default(),
        "stages": [],
        "workflowPlan": null,
        "dispatchGroups": [],
        "dispatchTasks": [],
        "approvals": snapshot.approvals().iter().map(team_public_approval_legacy_json).collect::<Vec<_>>(),
        "artifacts": snapshot.artifacts().iter().map(team_public_artifact_legacy_json).collect::<Vec<_>>(),
        "dispatches": [],
        "dispatchExecutions": [],
        "messages": [],
        "nodePromptDeliveries": [],
        "gates": [],
        "kickbacks": [],
        "decisions": snapshot.decisions().iter().map(team_public_decision_legacy_json).collect::<Vec<_>>(),
        "unavailableSections": team_public_unavailable_sections_legacy_json(snapshot, roles_available),
        "diagnostics": team_public_diagnostics_legacy_json(snapshot.diagnostics()),
        "events": snapshot.events().iter().map(team_public_event_legacy_json).collect::<Vec<_>>(),
        "startGate": team_run_start_gate_legacy_json(snapshot.run()),
        "nextEventCursor": snapshot.next_event_cursor(),
    })
}

fn team_public_unavailable_sections_legacy_json(
    snapshot: &organization::run::public_projection::TeamRunPublicSnapshot,
    roles_available: bool,
) -> Vec<&'static str> {
    snapshot
        .unavailable_sections()
        .iter()
        .filter(|section| {
            !roles_available
                || **section
                    != organization::run::public_projection::TeamRunPublicUnavailableSection::Roles
        })
        .map(|section| team_public_unavailable_section_name(*section))
        .collect()
}

fn team_role_session_receipts_legacy_json(
    sessions: &[organization::RoleSessionReceipt],
    resolver: &dyn organization::RoleSessionIdentityResolver,
) -> Vec<Value> {
    sessions
        .iter()
        .filter_map(|session| {
            organization::adapters::loopback::role_session_json(session, resolver)
        })
        .collect()
}

pub(super) fn team_public_run_legacy_json(
    snapshot: &organization::run::public_projection::TeamRunPublicSnapshot,
) -> Value {
    let run = snapshot.run();
    json!({
        "runId": run.run_id(),
        "status": team_run_status_from_public_snapshot(snapshot),
        "revision": run.team_revision(),
        "packageName": "",
        "packageVersion": "",
        "sourcePath": TEAM_PUBLIC_PLACEHOLDER_PATH,
        "createdAt": 0,
        "updatedAt": 0,
    })
}

fn team_public_graph_legacy_json(
    run_id: &str,
    graph: &organization::run::public_projection::TeamPublicGraph,
) -> Value {
    json!({
        "runId": run_id,
        "graphId": graph.graph_id(),
        "workflowPlanId": graph.workflow_plan_id(),
        "title": graph.title(),
        "layout": team_public_graph_layout_legacy_json(graph.layout()),
        "nodes": graph.nodes().iter().map(team_public_node_legacy_json).collect::<Vec<_>>(),
        "edges": graph.edges().iter().map(team_public_edge_legacy_json).collect::<Vec<_>>(),
        "status": team_public_graph_status_name(graph.status()),
    })
}

fn team_public_graph_layout_legacy_json(
    layout: &organization::run::public_projection::TeamPublicGraphLayout,
) -> Value {
    json!({
        "nodePositions": layout.node_positions().iter().map(|(node_id, position)| {
            (node_id.clone(), json!({ "x": position.x(), "y": position.y() }))
        }).collect::<BTreeMap<_, _>>(),
    })
}

fn team_public_node_legacy_json(
    node: &organization::run::public_projection::TeamPublicNode,
) -> Value {
    json!({
        "nodeId": node.node_id(),
        "kind": team_public_node_kind_name(node.kind()),
        "title": node.title(),
        "roleId": node.role_id(),
        "taskId": node.task_id(),
        "status": team_public_attempt_status_name(node.attempt().status()),
        "statusReason": node.status_reason(),
        "maxAttempts": node.max_attempts(),
        "config": team_public_node_config_json(node),
    })
}

fn team_public_node_config_json(
    node: &organization::run::public_projection::TeamPublicNode,
) -> Value {
    match node.trigger() {
        Some(organization::run::public_projection::TeamPublicStartTrigger::Webhook) => {
            json!({ "trigger": { "mode": "webhook" } })
        }
        Some(organization::run::public_projection::TeamPublicStartTrigger::Cron { expression }) => {
            json!({ "trigger": { "mode": "cron", "cron": expression } })
        }
        None => json!({}),
    }
}

fn team_public_edge_legacy_json(
    edge: &organization::run::public_projection::TeamPublicEdge,
) -> Value {
    json!({
        "edgeId": edge.edge_id(),
        "sourceNodeId": edge.source_node_id(),
        "targetNodeId": edge.target_node_id(),
        "sourcePort": edge.source_port(),
        "targetPort": edge.target_port(),
        "action": team_public_edge_action_name(edge.action()),
        "payload": { "includeUpstreamResult": true },
        "status": team_public_edge_status_name(edge.status()),
    })
}

fn team_public_attempt_legacy_json(
    run_id: &str,
    attempt: &organization::run::public_projection::TeamRunPublicAttempt,
) -> Value {
    json!({
        "runId": run_id,
        "nodeId": attempt.node_id(),
        "nodeExecutionId": attempt.node_execution_id(),
        "attemptId": attempt.attempt_id(),
        "attemptNumber": attempt.number(),
        "reason": team_public_attempt_reason_name(attempt.reason()),
        "status": team_public_attempt_status_name(attempt.status()),
        "createdAt": attempt.created_at(),
        "updatedAt": attempt.updated_at(),
        "outputSummary": attempt.output_port().map(|port| json!({ "outputPort": port })),
    })
}

fn team_public_approval_legacy_json(
    approval: &organization::run::public_projection::TeamRunPublicApproval,
) -> Value {
    json!({
        "approvalId": approval.approval_id(),
        "runId": approval.run_id(),
        "stageId": approval.stage_id(),
        "roleId": approval.role_id(),
        "reason": approval.reason(),
        "requestedAction": approval.requested_action(),
        "risk": "",
        "status": team_public_approval_status_name(approval.status()),
        "decision": approval.decision().map(team_public_approval_decision_name),
        "idempotencyKey": "",
        "createdAt": approval.created_at(),
        "resolvedAt": approval.resolved_at(),
    })
}

fn team_public_artifact_legacy_json(
    artifact: &organization::run::public_projection::TeamRunPublicArtifact,
) -> Value {
    json!({
        "artifactId": artifact.artifact_id(),
        "runId": artifact.run_id(),
        "stageId": artifact.node_id(),
        "roleId": artifact.role_id(),
        "kind": artifact.kind(),
        "title": artifact.title(),
        "contentRef": "",
        "summary": artifact.summary(),
        "evidenceRefs": [],
        "idempotencyKey": "",
        "createdAt": artifact.created_at(),
        "updatedAt": artifact.updated_at(),
    })
}

fn team_public_decision_legacy_json(
    decision: &organization::run::public_projection::TeamRunPublicDecision,
) -> Value {
    json!({
        "decisionId": decision.decision_id(),
        "runId": decision.run_id(),
        "stageId": decision.stage_id(),
        "decision": team_public_decision_name(decision.decision()),
        "idempotencyKey": "",
        "createdAt": decision.created_at(),
    })
}

fn team_public_event_legacy_json(
    event: &organization::run::public_projection::TeamRunPublicEvent,
) -> Value {
    json!({
        "eventId": event.event_id(),
        "runId": event.run_id(),
        "revision": event.sequence(),
        "type": team_public_event_type_name(event.event_type()),
        "payload": {},
        "createdAt": event.created_at(),
    })
}

fn team_public_diagnostics_legacy_json(
    diagnostics: &organization::run::public_projection::TeamRunPublicDiagnostics,
) -> Value {
    let counts = diagnostics.counts();
    json!({
        "runId": diagnostics.run_id(),
        "recoveredFromStorage": false,
        "storageRoot": TEAM_PUBLIC_PLACEHOLDER_PATH,
        "budgets": {
            "roleWallClockBudgetMs": {},
            "roleTokenBudget": {},
            "wallClockExceeded": false,
        },
        "limits": {
            "maxArtifactContentBytes": 0,
            "maxMessageBodyBytes": 0,
            "staleDispatchExecutionMs": 0,
        },
        "staleDispatchExecutions": [],
        "counts": {
            "attempts": counts.attempts(),
            "deliveries": counts.deliveries(),
            "approvals": counts.approvals(),
            "decisions": counts.decisions(),
            "evidence": counts.evidence(),
            "artifacts": counts.artifacts(),
            "events": counts.events(),
        },
    })
}

fn team_run_start_gate_legacy_json(
    run: &organization::run::public_projection::TeamRunPublicRun,
) -> Value {
    let proposal = match run.start_gate() {
        organization::run::public_projection::TeamRunPublicStartGate::ProposalPending => {
            Some(json!({
                "proposalId": run.proposal_id(),
                "taskSummary": run.proposal_summary().unwrap_or_default(),
            }))
        }
        _ => None,
    };
    json!({
        "status": team_run_start_gate_status_name(run.start_gate()),
        "proposal": proposal,
    })
}

fn team_run_start_gate_status_name(
    status: organization::run::public_projection::TeamRunPublicStartGate,
) -> &'static str {
    match status {
        organization::run::public_projection::TeamRunPublicStartGate::Intake => "intake",
        organization::run::public_projection::TeamRunPublicStartGate::ProposalPending => {
            "proposal_pending"
        }
        organization::run::public_projection::TeamRunPublicStartGate::Started => "started",
    }
}

fn team_run_status_from_public_snapshot(
    snapshot: &organization::run::public_projection::TeamRunPublicSnapshot,
) -> &'static str {
    match snapshot.run().lifecycle() {
        organization::run::public_projection::TeamRunPublicLifecycle::Active => {
            if snapshot.run().runtime()
                == organization::run::public_projection::TeamRuntimeState::Unknown
            {
                "provisioning"
            } else {
                team_run_status_from_public_graph_status(snapshot.graph().status())
            }
        }
        organization::run::public_projection::TeamRunPublicLifecycle::Cancelling => "cancelling",
        organization::run::public_projection::TeamRunPublicLifecycle::Cancelled => "cancelled",
        organization::run::public_projection::TeamRunPublicLifecycle::OutcomeUnknown => {
            "provisioning"
        }
    }
}

fn team_run_status_from_graph_status(status: organization::GraphStatus) -> &'static str {
    match status {
        organization::GraphStatus::Pending | organization::GraphStatus::Ready => "created",
        organization::GraphStatus::Running => "running",
        organization::GraphStatus::Waiting => "waiting_for_user",
        organization::GraphStatus::Completed => "completed",
        organization::GraphStatus::Failed => "failed",
        organization::GraphStatus::Cancelled => "cancelled",
    }
}

fn team_run_status_from_public_graph_status(
    status: organization::run::public_projection::TeamPublicGraphStatus,
) -> &'static str {
    match status {
        organization::run::public_projection::TeamPublicGraphStatus::Pending
        | organization::run::public_projection::TeamPublicGraphStatus::Ready => "created",
        organization::run::public_projection::TeamPublicGraphStatus::Running => "running",
        organization::run::public_projection::TeamPublicGraphStatus::Waiting => "waiting_for_user",
        organization::run::public_projection::TeamPublicGraphStatus::Completed => "completed",
        organization::run::public_projection::TeamPublicGraphStatus::Failed => "failed",
        organization::run::public_projection::TeamPublicGraphStatus::Cancelled => "cancelled",
    }
}

fn team_public_graph_status_name(
    status: organization::run::public_projection::TeamPublicGraphStatus,
) -> &'static str {
    match status {
        organization::run::public_projection::TeamPublicGraphStatus::Pending => "pending",
        organization::run::public_projection::TeamPublicGraphStatus::Ready => "ready",
        organization::run::public_projection::TeamPublicGraphStatus::Running => "running",
        organization::run::public_projection::TeamPublicGraphStatus::Waiting => "waiting",
        organization::run::public_projection::TeamPublicGraphStatus::Completed => "completed",
        organization::run::public_projection::TeamPublicGraphStatus::Failed => "failed",
        organization::run::public_projection::TeamPublicGraphStatus::Cancelled => "cancelled",
    }
}

fn team_public_node_kind_name(
    kind: organization::run::public_projection::TeamPublicNodeKind,
) -> &'static str {
    match kind {
        organization::run::public_projection::TeamPublicNodeKind::Start => "start",
        organization::run::public_projection::TeamPublicNodeKind::Work => "work",
        organization::run::public_projection::TeamPublicNodeKind::Review => "review",
        organization::run::public_projection::TeamPublicNodeKind::HumanDecision => "human_decision",
        organization::run::public_projection::TeamPublicNodeKind::ScriptReview => "script_review",
        organization::run::public_projection::TeamPublicNodeKind::Join => "join",
        organization::run::public_projection::TeamPublicNodeKind::End => "end",
    }
}

fn team_public_attempt_status_name(
    status: organization::run::public_projection::TeamPublicAttemptStatus,
) -> &'static str {
    match status {
        organization::run::public_projection::TeamPublicAttemptStatus::Pending => "pending",
        organization::run::public_projection::TeamPublicAttemptStatus::Ready => "ready",
        organization::run::public_projection::TeamPublicAttemptStatus::Running => "running",
        organization::run::public_projection::TeamPublicAttemptStatus::Waiting => "waiting",
        organization::run::public_projection::TeamPublicAttemptStatus::Completed => "completed",
        organization::run::public_projection::TeamPublicAttemptStatus::Failed => "failed",
        organization::run::public_projection::TeamPublicAttemptStatus::Cancelled => "cancelled",
    }
}

fn team_public_attempt_reason_name(
    reason: &organization::run::public_projection::TeamPublicAttemptReason,
) -> &'static str {
    match reason {
        organization::run::public_projection::TeamPublicAttemptReason::Initial => "initial",
        organization::run::public_projection::TeamPublicAttemptReason::Trigger => "trigger",
        organization::run::public_projection::TeamPublicAttemptReason::Edge { .. } => "edge",
        organization::run::public_projection::TeamPublicAttemptReason::Rework => "rework",
    }
}

fn team_public_edge_action_name(
    action: organization::run::public_projection::TeamPublicEdgeAction,
) -> &'static str {
    match action {
        organization::run::public_projection::TeamPublicEdgeAction::Activate => "activate",
        organization::run::public_projection::TeamPublicEdgeAction::Rework => "rework",
        organization::run::public_projection::TeamPublicEdgeAction::Gate => "gate",
        organization::run::public_projection::TeamPublicEdgeAction::Finish => "finish",
    }
}

fn team_public_edge_status_name(
    status: organization::run::public_projection::TeamPublicEdgeStatus,
) -> &'static str {
    match status {
        organization::run::public_projection::TeamPublicEdgeStatus::Waiting => "waiting",
        organization::run::public_projection::TeamPublicEdgeStatus::Satisfied => "satisfied",
    }
}

fn team_public_approval_status_name(
    status: organization::run::public_projection::TeamPublicApprovalStatus,
) -> &'static str {
    match status {
        organization::run::public_projection::TeamPublicApprovalStatus::Pending => "pending",
        organization::run::public_projection::TeamPublicApprovalStatus::Approved => "approved",
        organization::run::public_projection::TeamPublicApprovalStatus::Denied => "denied",
        organization::run::public_projection::TeamPublicApprovalStatus::Aborted => "aborted",
    }
}

fn team_public_approval_decision_name(
    decision: organization::run::public_projection::TeamPublicApprovalDecision,
) -> &'static str {
    match decision {
        organization::run::public_projection::TeamPublicApprovalDecision::Approve => "approve",
        organization::run::public_projection::TeamPublicApprovalDecision::Deny => "deny",
        organization::run::public_projection::TeamPublicApprovalDecision::Abort => "abort",
    }
}

fn team_public_decision_name(
    decision: organization::run::public_projection::TeamPublicDecisionType,
) -> &'static str {
    match decision {
        organization::run::public_projection::TeamPublicDecisionType::Retry => "retry",
        organization::run::public_projection::TeamPublicDecisionType::ProceedDegraded => {
            "proceed_degraded"
        }
        organization::run::public_projection::TeamPublicDecisionType::Abort => "abort",
    }
}

fn team_public_event_type_name(
    event_type: organization::run::public_projection::TeamPublicEventType,
) -> &'static str {
    match event_type {
        organization::run::public_projection::TeamPublicEventType::GraphPatchAccepted => {
            "graph_patch_accepted"
        }
        organization::run::public_projection::TeamPublicEventType::GraphReplaced => {
            "graph_replaced"
        }
        organization::run::public_projection::TeamPublicEventType::NodeProgressed => {
            "node_progressed"
        }
        organization::run::public_projection::TeamPublicEventType::ApprovalRequested => {
            "approval_requested"
        }
        organization::run::public_projection::TeamPublicEventType::ApprovalResolved => {
            "approval_resolved"
        }
    }
}

pub fn team_public_unavailable_section_name(
    section: organization::run::public_projection::TeamRunPublicUnavailableSection,
) -> &'static str {
    match section {
        organization::run::public_projection::TeamRunPublicUnavailableSection::NodeInputStates => {
            "nodeInputStates"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::Roles => "roles",
        organization::run::public_projection::TeamRunPublicUnavailableSection::Stages => "stages",
        organization::run::public_projection::TeamRunPublicUnavailableSection::WorkflowPlan => {
            "workflowPlan"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::DispatchGroups => {
            "dispatchGroups"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::DispatchTasks => {
            "dispatchTasks"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::Dispatches => {
            "dispatches"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::DispatchExecutions => {
            "dispatchExecutions"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::Messages => "messages",
        organization::run::public_projection::TeamRunPublicUnavailableSection::NodePromptDeliveries => {
            "nodePromptDeliveries"
        }
        organization::run::public_projection::TeamRunPublicUnavailableSection::Gates => "gates",
        organization::run::public_projection::TeamRunPublicUnavailableSection::Kickbacks => {
            "kickbacks"
        }
    }
}

fn team_resume_legacy_json(
    team_id: &organization::TeamId,
    outcomes: &[organization::ResumeOutcome],
    runs: &[organization::TeamRunQueryOutcome],
    resolver: &dyn organization::RoleSessionIdentityResolver,
) -> Value {
    let terminal_run_ids = runs
        .iter()
        .filter_map(team_terminal_run_id)
        .collect::<BTreeSet<_>>();
    let restored_run_ids = outcomes.iter().map(team_resume_run_id).collect::<Vec<_>>();
    let active_run_ids = outcomes
        .iter()
        .filter_map(|outcome| match outcome {
            organization::ResumeOutcome::Active(run_id)
                if !terminal_run_ids.contains(run_id.as_str()) =>
            {
                Some(run_id.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut skipped_terminal_run_ids = BTreeSet::new();
    for outcome in outcomes {
        let run_id = team_resume_run_id(outcome);
        if terminal_run_ids.contains(run_id)
            || matches!(
                outcome,
                organization::ResumeOutcome::Cancelled(_)
                    | organization::ResumeOutcome::Tombstoned(_)
            )
        {
            skipped_terminal_run_ids.insert(run_id);
        }
    }
    json!({
        "success": true,
        "teamId": team_id.as_str(),
        "restoredRunIds": restored_run_ids,
        "activeRunIds": active_run_ids,
        "skippedTerminalRunIds": skipped_terminal_run_ids.into_iter().collect::<Vec<_>>(),
        "runs": runs.iter().filter_map(|run| team_run_list_item_legacy_json(run, resolver)).collect::<Vec<_>>(),
    })
}

fn team_resume_run_id(outcome: &organization::ResumeOutcome) -> &str {
    match outcome {
        organization::ResumeOutcome::Active(run_id)
        | organization::ResumeOutcome::Cancelled(run_id)
        | organization::ResumeOutcome::OutcomeUnknown(run_id)
        | organization::ResumeOutcome::Tombstoned(run_id) => run_id.as_str(),
    }
}

fn team_terminal_run_id(outcome: &organization::TeamRunQueryOutcome) -> Option<&str> {
    match outcome {
        organization::TeamRunQueryOutcome::Available(run)
            if matches!(
                run.graph_status(),
                organization::GraphStatus::Completed
                    | organization::GraphStatus::Failed
                    | organization::GraphStatus::Cancelled
            ) =>
        {
            Some(run.run().as_str())
        }
        _ => None,
    }
}

fn team_trigger_json(trigger: &organization::ArmedTrigger) -> Value {
    let trigger_value = match trigger.trigger() {
        organization::TeamTrigger::Webhook { .. } => json!({ "kind": "webhook" }),
        organization::TeamTrigger::Cron { expression } => {
            json!({ "kind": "cron", "expression": expression })
        }
    };
    json!({
        "teamId": trigger.team_id().as_str(),
        "runId": trigger.run_id().as_str(),
        "startNodeId": trigger.start_node_id(),
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

fn team_node_terminal_outcome_name(outcome: organization::TeamNodeTerminalResult) -> &'static str {
    match outcome {
        organization::TeamNodeTerminalResult::Recorded => "terminal_recorded",
        organization::TeamNodeTerminalResult::Replayed => "terminal_replayed",
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
