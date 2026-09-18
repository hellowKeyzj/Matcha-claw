use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use ::organization;
use serde_json::{Value, json};

use crate::{
    organization::{
        ManualTeamProvision, OrganizationHandle, TeamGraphPatchDraft, TeamNodeEventCommandOutcome,
        TeamNodeTerminalResolution, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
        TeamRuntimeCreateSource, TeamRuntimePromptPhase, TeamRuntimeStatus,
    },
    runtime::driver::RuntimeDriverIdentity,
    transport::{sessions::trace as session_trace, team::role_sessions as team_role_sessions},
};

use super::{
    CapabilityExecuteRequest, CommandInput, CommandOutcome, CommandResult, RejectionCode, decode,
    invalid_input, is_team_runtime_facade_scope, team_runtime_facade_endpoint, unavailable,
};

pub(super) const TEAM_PUBLIC_PLACEHOLDER_PATH: &str = "";

#[derive(Clone, Copy)]
enum RunCommandIdentityKind {
    GraphImportYaml,
    GraphSave,
    GraphPatch,
    TeamNodeEvent,
}

impl RunCommandIdentityKind {
    const fn label(self) -> &'static str {
        match self {
            Self::GraphImportYaml => "graph-import-yaml",
            Self::GraphSave => "graph-save",
            Self::GraphPatch => "graph-patch",
            Self::TeamNodeEvent => "team-node-event",
        }
    }
}

pub(super) async fn team_runtime_execute(
    owner: &OrganizationHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) if request.id == "team.runtime" => request,
        _ => return invalid_input(),
    };
    let trace_id = request.trace_id.as_deref();
    let input_object = request.input.as_object();
    session_trace::log(
        "runtime.team.runtime.request",
        trace_id,
        json!({
            "operationId": &request.operation_id,
            "targetKind": team_runtime_target_kind(&request.target),
            "teamId": session_trace::id_shape(team_runtime_input_string(input_object, "teamId")),
            "runId": session_trace::id_shape(team_runtime_input_string(input_object, "runId")),
        }),
    );
    if !is_team_runtime_facade_scope(&request.scope) {
        session_trace::log(
            "runtime.team.runtime.scope-invalid",
            trace_id,
            json!({ "operationId": &request.operation_id }),
        );
        return invalid_input();
    }
    let endpoint = team_runtime_facade_endpoint(&request.scope)
        .expect("validated team runtime facade scope has a runtime endpoint");

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
    let command = match team_runtime_command(
        &request.operation_id,
        &request.target,
        &request.input,
        endpoint,
    ) {
        Ok(command) => {
            session_trace::log(
                "runtime.team.runtime.decode",
                trace_id,
                json!({ "operationId": &request.operation_id, "status": "ok" }),
            );
            command
        }
        Err(error) => {
            let status = match error {
                TeamRuntimeDecodeError::Unavailable => "unavailable",
                TeamRuntimeDecodeError::InvalidInput => "invalid-input",
            };
            session_trace::log(
                "runtime.team.runtime.decode",
                trace_id,
                json!({ "operationId": &request.operation_id, "status": status }),
            );
            return match error {
                TeamRuntimeDecodeError::Unavailable => unavailable(),
                TeamRuntimeDecodeError::InvalidInput => invalid_input(),
            };
        }
    };
    let projection_context = TeamRuntimeProjectionContext::from_command(&command);
    session_trace::log(
        "runtime.team.runtime.owner.request",
        trace_id,
        json!({ "operationId": &request.operation_id }),
    );
    let outcome = match execute_team_runtime(owner, command).await {
        Some(outcome) => {
            session_trace::log(
                "runtime.team.runtime.owner.response",
                trace_id,
                json!({ "operationId": &request.operation_id, "status": "ok" }),
            );
            outcome
        }
        None => {
            session_trace::log(
                "runtime.team.runtime.owner.response",
                trace_id,
                json!({ "operationId": &request.operation_id, "status": "unavailable" }),
            );
            return unavailable();
        }
    };
    let response = team_runtime_outcome_with_context(
        outcome,
        team_id.as_deref(),
        run_id.as_deref(),
        projection_context.as_ref(),
    );
    session_trace::log(
        "runtime.team.runtime.response",
        trace_id,
        summarize_team_runtime_response(&request.operation_id, &response),
    );
    response
}

async fn execute_team_runtime(
    owner: &OrganizationHandle,
    command: TeamRuntimeCommand,
) -> Option<TeamRuntimeCommandOutcome> {
    Some(match command {
        TeamRuntimeCommand::PackageValidate { package_root } => {
            TeamRuntimeCommandOutcome::PackageValidate(
                owner.team_skill_validate(package_root).await.ok()?,
            )
        }
        TeamRuntimeCommand::DependencyPlan { package_root } => {
            TeamRuntimeCommandOutcome::DependencyPlan(
                owner.team_skill_dependency_plan(package_root).await.ok()?,
            )
        }
        TeamRuntimeCommand::ProvisionAgents {
            package_root,
            team_id: Some(team_id),
            idempotency_key,
            endpoint,
            source: TeamRuntimeCreateSource::TeamSkill,
            manual_team: None,
        } if endpoint.as_str()
            == RuntimeDriverIdentity::open_claw().runtime_endpoint_reference() =>
        {
            let selection_id = match owner.team_skill_authorize(package_root).await.ok()? {
                Ok(selection_id) => selection_id,
                Err(organization::package::TeamSkillSelectionError::InvalidSelection) => {
                    return Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                        crate::organization::TeamMaterializationCommandOutcome::Rejected,
                    ));
                }
                Err(organization::package::TeamSkillSelectionError::Unavailable) => {
                    return Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                        crate::organization::TeamMaterializationCommandOutcome::Unavailable,
                    ));
                }
            };
            TeamRuntimeCommandOutcome::ProvisionAgents(
                owner
                    .team_skill_materialize(selection_id, team_id, idempotency_key)
                    .await
                    .ok()?,
            )
        }
        TeamRuntimeCommand::ProvisionAgents {
            team_id: Some(team_id),
            idempotency_key,
            endpoint,
            source: TeamRuntimeCreateSource::Manual,
            manual_team: Some(manual_team),
            ..
        } => TeamRuntimeCommandOutcome::ProvisionAgents(
            owner
                .manual_team_materialize(
                    team_id,
                    manual_team.team_name,
                    endpoint,
                    manual_team.roles,
                    idempotency_key,
                )
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::ProvisionAgents { .. } => TeamRuntimeCommandOutcome::ProvisionAgents(
            crate::organization::TeamMaterializationCommandOutcome::Rejected,
        ),
        TeamRuntimeCommand::Delete {
            team_id,
            idempotency_key,
            observed_at,
        } => TeamRuntimeCommandOutcome::Delete(
            owner
                .team_delete(team_id, idempotency_key, observed_at)
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunCreate {
            team_id,
            package_root,
            run_id,
            idempotency_key,
            source,
        } => {
            let run_id = run_id.unwrap_or_else(|| {
                organization::GraphRunId::new(format!("team-run:{}", idempotency_key.as_str()))
            });
            match source {
                TeamRuntimeCreateSource::TeamSkill => {
                    let selection_id = match owner.team_skill_authorize(package_root).await.ok()? {
                        Ok(selection_id) => selection_id,
                        Err(organization::package::TeamSkillSelectionError::InvalidSelection) => {
                            return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                TeamRuntimeStatus::Rejected,
                            )));
                        }
                        Err(organization::package::TeamSkillSelectionError::Unavailable) => {
                            return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                TeamRuntimeStatus::Unavailable,
                            )));
                        }
                    };
                    let team_id = match team_id {
                        Some(team_id) => team_id,
                        None => match owner
                            .team_skill_selection_validate(selection_id.clone())
                            .await
                            .ok()?
                        {
                            organization::package::TeamSkillPackageValidation::Valid {
                                package,
                            } => match organization::TeamId::try_new(package.name().to_owned()) {
                                Ok(team_id) => team_id,
                                Err(_) => {
                                    return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                        TeamRuntimeStatus::Rejected,
                                    )));
                                }
                            },
                            organization::package::TeamSkillPackageValidation::Invalid => {
                                return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                    TeamRuntimeStatus::Rejected,
                                )));
                            }
                            organization::package::TeamSkillPackageValidation::Unavailable => {
                                return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                                    TeamRuntimeStatus::Unavailable,
                                )));
                            }
                        },
                    };
                    match owner
                        .team_skill_materialize(
                            selection_id,
                            team_id.clone(),
                            idempotency_key.clone(),
                        )
                        .await
                        .ok()?
                    {
                        crate::organization::TeamMaterializationCommandOutcome::Materialized {
                            ..
                        } => TeamRuntimeCommandOutcome::RunCreate(
                            owner
                                .run_create_from_team_template(
                                    team_id,
                                    run_id,
                                    idempotency_key,
                                    now_millis(),
                                )
                                .await
                                .ok()?,
                        ),
                        outcome => TeamRuntimeCommandOutcome::RunCreate(Err(
                            team_materialization_status(outcome),
                        )),
                    }
                }
                TeamRuntimeCreateSource::Manual => {
                    let Some(team_id) = team_id else {
                        return Some(TeamRuntimeCommandOutcome::RunCreate(Err(
                            TeamRuntimeStatus::Rejected,
                        )));
                    };
                    TeamRuntimeCommandOutcome::RunCreate(
                        owner
                            .run_create_from_team_template(
                                team_id,
                                run_id,
                                idempotency_key,
                                now_millis(),
                            )
                            .await
                            .ok()?,
                    )
                }
            }
        }
        TeamRuntimeCommand::RunList { team_id } => {
            TeamRuntimeCommandOutcome::RunList(owner.run_list(team_id).await.ok()?)
        }
        TeamRuntimeCommand::TriggerList { team_id } => {
            TeamRuntimeCommandOutcome::TriggerList(owner.trigger_list(team_id).await.ok()?)
        }
        TeamRuntimeCommand::WebhookTriggerFire {
            webhook_path,
            idempotency_key,
            fired_at,
        } => TeamRuntimeCommandOutcome::WebhookTriggerFire(
            owner
                .webhook_trigger_fire(webhook_path, idempotency_key, fired_at)
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunSnapshot {
            team_id,
            run_id,
            event_cursor,
            event_limit,
        } => match owner
            .team_run_public_snapshot(team_id.clone(), run_id.clone(), event_cursor, event_limit)
            .await
            .ok()?
        {
            Some(snapshot) => {
                let query_team_id = match (&team_id, &snapshot) {
                    (Some(team_id), _) => Some(team_id.clone()),
                    (None, organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(snapshot)) => {
                        organization::TeamId::try_new(snapshot.run().team_id().to_owned()).ok()
                    }
                    (None, organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Unavailable(_)) => None,
                };
                let role_sessions =
                    match query_team_id {
                        Some(team_id) => owner.role_sessions(team_id).await.ok().and_then(
                            |outcome| match outcome {
                                organization::TeamRoleSessionQueryOutcome::Available(sessions) => {
                                    Some(
                                        sessions
                                            .into_iter()
                                            .filter(|session| session.run_id() == run_id.as_str())
                                            .collect(),
                                    )
                                }
                                organization::TeamRoleSessionQueryOutcome::Unavailable
                                | organization::TeamRoleSessionQueryOutcome::OutcomeUnknown => None,
                            },
                        ),
                        None => None,
                    };
                TeamRuntimeCommandOutcome::RunSnapshot {
                    snapshot,
                    role_sessions,
                }
            }
            None => TeamRuntimeCommandOutcome::RunSnapshotInvalidInput,
        },
        TeamRuntimeCommand::GraphSave {
            command,
            definition,
        } => {
            TeamRuntimeCommandOutcome::GraphSave(owner.graph_save(*command, definition).await.ok()?)
        }
        TeamRuntimeCommand::GraphPatch { patch } => {
            TeamRuntimeCommandOutcome::GraphPatch(owner.graph_patch(patch).await.ok()?)
        }
        TeamRuntimeCommand::GraphContext {
            team_id,
            run_id,
            view,
            node_execution_id,
        } => {
            let outcome = if let Some(team_id) = team_id {
                match organization::TeamGraphContextQuery::new(
                    team_id,
                    run_id,
                    view,
                    node_execution_id,
                ) {
                    Ok(query) => owner
                        .graph_context(query)
                        .await
                        .unwrap_or(organization::TeamGraphContextResult::Unavailable),
                    Err(_) => organization::TeamGraphContextResult::Unavailable,
                }
            } else {
                organization::TeamGraphContextResult::Unavailable
            };
            TeamRuntimeCommandOutcome::GraphContext(outcome)
        }
        TeamRuntimeCommand::GraphExportYaml { run_id } => {
            let outcome = owner
                .graph_yaml(run_id)
                .await
                .ok()?
                .ok_or(TeamRuntimeStatus::Unavailable);
            TeamRuntimeCommandOutcome::GraphExportYaml(outcome)
        }
        TeamRuntimeCommand::GraphImportYaml {
            command,
            definition,
        } => TeamRuntimeCommandOutcome::GraphImportYaml(
            owner.graph_save(*command, definition).await.ok()?,
        ),
        TeamRuntimeCommand::TriggerFire { request, fired_at } => {
            TeamRuntimeCommandOutcome::TriggerFire(
                owner.trigger_fire(request, fired_at).await.ok()?,
            )
        }
        TeamRuntimeCommand::RoleMessageSubmit { admission } => {
            TeamRuntimeCommandOutcome::RoleMessageSubmit(
                owner.role_message_submit(admission).await.ok()?,
            )
        }
        TeamRuntimeCommand::RoleMessageSubmitForRun {
            run_id,
            role_id,
            message,
            idempotency_key,
            requested_at,
        } => TeamRuntimeCommandOutcome::RoleMessageSubmitForRun(
            owner
                .role_message_submit_for_run(
                    run_id,
                    role_id,
                    message,
                    idempotency_key,
                    requested_at,
                )
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunStartConfirm {
            run_id,
            proposal_id,
        } => TeamRuntimeCommandOutcome::RunStartConfirm(
            owner.run_start_confirm(run_id, proposal_id).await.ok()?,
        ),
        TeamRuntimeCommand::RunStartContinue {
            run_id,
            proposal_id,
        } => TeamRuntimeCommandOutcome::RunStartContinue(
            owner.run_start_continue(run_id, proposal_id).await.ok()?,
        ),
        TeamRuntimeCommand::NodePromptRetryDue { run_id } => {
            TeamRuntimeCommandOutcome::NodePromptRetryDue(
                owner.node_prompt_retry_due(run_id).await.ok()?,
            )
        }
        TeamRuntimeCommand::NodePromptSettled {
            session_key,
            prompt_run_id,
            phase,
        } => TeamRuntimeCommandOutcome::NodePromptSettled(
            owner
                .node_prompt_settled(
                    session_key.as_str().to_owned(),
                    prompt_run_id.as_str().to_owned(),
                    phase,
                    now_millis(),
                )
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::NodeEvent {
            run_id,
            node_execution_id,
            event,
            summary,
            role_id,
            requested_action,
            idempotency_key,
            terminal_resolution,
            output_port,
        } => TeamRuntimeCommandOutcome::NodeEvent(
            execute_team_node_event(
                owner,
                run_id,
                node_execution_id,
                event,
                summary,
                role_id,
                requested_action,
                idempotency_key,
                terminal_resolution,
                output_port,
            )
            .await,
        ),
        TeamRuntimeCommand::RunDiagnostics { run_id } => TeamRuntimeCommandOutcome::RunDiagnostics(
            owner.team_run_diagnostics(run_id).await.ok()?,
        ),
        TeamRuntimeCommand::RunDecisionSubmit {
            run_id,
            decision,
            note,
            idempotency_key,
            resolved_at,
        } => {
            let command = organization::TeamDecisionCommand::try_new(
                format!("team-decision-{}", idempotency_key.as_str()),
                run_id.as_str().to_owned(),
                "run",
                decision,
                note,
                idempotency_key.as_str().to_owned(),
                resolved_at,
            );
            TeamRuntimeCommandOutcome::RunDecisionSubmit(match command {
                Ok(command) => owner
                    .decision_submit(command)
                    .await
                    .ok()?
                    .map_err(|_| TeamRuntimeStatus::Unavailable),
                Err(_) => Err(TeamRuntimeStatus::Rejected),
            })
        }
        TeamRuntimeCommand::Resume { team_id } => {
            let outcomes = owner.resume(team_id.clone()).await.ok()?;
            let runs = owner.run_list(team_id.clone()).await.ok()?;
            TeamRuntimeCommandOutcome::Resume {
                team_id,
                outcomes,
                runs,
            }
        }
        TeamRuntimeCommand::ApprovalResolve { command } => {
            TeamRuntimeCommandOutcome::ApprovalResolve(owner.approval_resolve(command).await.ok()?)
        }
        TeamRuntimeCommand::RunCancel {
            run_id,
            idempotency_key,
            requested_at,
        } => TeamRuntimeCommandOutcome::RunCancel(
            owner
                .run_cancel(run_id, idempotency_key.as_str().to_owned(), requested_at)
                .await
                .ok()?,
        ),
        TeamRuntimeCommand::RunDelete {
            run_id,
            idempotency_key,
            tombstoned_at,
        } => TeamRuntimeCommandOutcome::RunDelete(
            owner
                .run_delete_and_purge(run_id, idempotency_key.as_str().to_owned(), tombstoned_at)
                .await
                .ok()?,
        ),
    })
}

async fn execute_team_node_event(
    owner: &OrganizationHandle,
    run_id: organization::GraphRunId,
    node_execution_id: organization::run::event::OpaqueId,
    event: organization::run::event::OpaqueId,
    summary: String,
    role_id: Option<organization::run::event::OpaqueId>,
    requested_action: Option<String>,
    idempotency_key: organization::IdempotencyKey,
    terminal_resolution: Option<TeamNodeTerminalResolution>,
    output_port: Option<String>,
) -> Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus> {
    if matches!(event.as_str(), "complete" | "reject") {
        let Some(terminal) = terminal_resolution else {
            return Err(TeamRuntimeStatus::Rejected);
        };
        return owner
            .node_terminal_resolve(
                run_id,
                node_execution_id,
                event.as_str().to_owned(),
                Some(terminal),
                summary,
                output_port,
                idempotency_key.as_str().to_owned(),
                now_millis(),
            )
            .await
            .map_err(|_| TeamRuntimeStatus::Unavailable)?
            .map(TeamNodeEventCommandOutcome::Terminal)
            .map_err(|_| TeamRuntimeStatus::Unavailable);
    }
    let event = match event.as_str() {
        "progress" => organization::TeamNodeEvent::progress(node_execution_id, role_id),
        "request_input" => organization::TeamNodeEvent::request_input(node_execution_id, role_id),
        "request_approval" => match requested_action.as_deref().and_then(team_approval_action) {
            Some(action) => {
                organization::TeamNodeEvent::request_approval(node_execution_id, role_id, action)
            }
            None => return Err(TeamRuntimeStatus::Rejected),
        },
        _ => return Err(TeamRuntimeStatus::Rejected),
    };
    let command_id = bounded_run_command_id(
        RunCommandIdentityKind::TeamNodeEvent,
        idempotency_key.as_str(),
    )
    .map_err(|_| TeamRuntimeStatus::Rejected)?;
    let event = organization::TeamNodeEventProducer::non_terminal(
        organization::run::event::OpaqueId::try_new(run_id.as_str())
            .map_err(|_| TeamRuntimeStatus::Rejected)?,
        command_id,
        organization::run::event::OpaqueId::try_new(idempotency_key.as_str().to_owned())
            .map_err(|_| TeamRuntimeStatus::Rejected)?,
        event,
        now_millis(),
    )
    .map_err(|_| TeamRuntimeStatus::Rejected)?;
    let (command, event) = event.into_parts();
    owner
        .node_event(command, event)
        .await
        .map_err(|_| TeamRuntimeStatus::Unavailable)?
        .map(TeamNodeEventCommandOutcome::NonTerminal)
        .map_err(|_| TeamRuntimeStatus::Unavailable)
}

fn team_approval_action(value: &str) -> Option<organization::ApprovalAction> {
    match value {
        "continue_node" => Some(organization::ApprovalAction::ContinueNode),
        "execute_tool" => Some(organization::ApprovalAction::ExecuteTool),
        "publish_result" => Some(organization::ApprovalAction::PublishResult),
        "external_action" => Some(organization::ApprovalAction::ExternalAction),
        _ => None,
    }
}

fn team_materialization_status(
    outcome: crate::organization::TeamMaterializationCommandOutcome,
) -> TeamRuntimeStatus {
    match outcome {
        crate::organization::TeamMaterializationCommandOutcome::Materialized { .. } => {
            TeamRuntimeStatus::OutcomeUnknown
        }
        crate::organization::TeamMaterializationCommandOutcome::Rejected => {
            TeamRuntimeStatus::Rejected
        }
        crate::organization::TeamMaterializationCommandOutcome::OutcomeUnknown => {
            TeamRuntimeStatus::OutcomeUnknown
        }
        crate::organization::TeamMaterializationCommandOutcome::Unavailable => {
            TeamRuntimeStatus::Unavailable
        }
    }
}

enum TeamRuntimeProjectionContext {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TeamRuntimeDecodeError {
    InvalidInput,
    Unavailable,
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

fn summarize_team_runtime_response(operation_id: &str, response: &CommandOutcome) -> Value {
    match response {
        CommandOutcome::Succeeded { result } => json!({
            "operationId": operation_id,
            "outcome": "succeeded",
            "contract": team_runtime_result_contract(result.as_value()),
        }),
        CommandOutcome::Unknown { result } => json!({
            "operationId": operation_id,
            "outcome": "unknown",
            "contract": team_runtime_result_contract(result.as_value()),
        }),
        CommandOutcome::Rejected { .. } => json!({
            "operationId": operation_id,
            "outcome": "rejected",
        }),
        CommandOutcome::TimedOut => json!({
            "operationId": operation_id,
            "outcome": "timed-out",
        }),
    }
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

pub(super) fn team_runtime_command(
    operation_id: &str,
    target: &Value,
    input: &Value,
    endpoint: organization::RuntimeEndpointReference,
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
        "team.provisionAgents" => decode_team_provision(input, target, endpoint),
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
        "team.proposalConfirm" | "team.runStartConfirm" => {
            decode_team_run_start_confirm(input, target)
        }
        "team.proposalContinue"
        | "team.proposalCancel"
        | "team.runStartContinue"
        | "team.runStartReject" => decode_team_run_start_continue(input, target),
        "team.triggerFire" => decode_team_trigger(input, target),
        "team.approvalResolve" => decode_team_approval(input, target),
        "team.runCancel" => decode_team_run_cancel(input, target),
        _ => Err(TeamRuntimeDecodeError::Unavailable),
    }
}

#[cfg(test)]
pub(super) fn team_runtime_outcome(
    outcome: TeamRuntimeCommandOutcome,
    team_id: Option<&str>,
    run_id: Option<&str>,
) -> CommandOutcome {
    team_runtime_outcome_with_context(outcome, team_id, run_id, None)
}

fn team_runtime_outcome_with_context(
    outcome: TeamRuntimeCommandOutcome,
    team_id: Option<&str>,
    run_id: Option<&str>,
    projection_context: Option<&TeamRuntimeProjectionContext>,
) -> CommandOutcome {
    match outcome {
        TeamRuntimeCommandOutcome::PackageValidate(validation) => {
            CommandOutcome::succeeded(CommandResult::private(team_skill_package_validation_json(&validation)))
        }
        TeamRuntimeCommandOutcome::DependencyPlan(plan) => match team_skill_dependency_plan_json(
            &plan,
            projection_context.map(TeamRuntimeProjectionContext::dependency_package_root),
        ) {
            Some(result) => CommandOutcome::succeeded(CommandResult::private(result)),
            None => unavailable(),
        },
        TeamRuntimeCommandOutcome::ProvisionAgents(outcome) => match outcome {
            crate::organization::TeamMaterializationCommandOutcome::Materialized {
                team_id,
                managed_agent_count,
            } => CommandOutcome::succeeded(CommandResult::private(json!({
                "teamId": team_id.as_str(),
                "managedAgentCount": managed_agent_count,
            }))),
            crate::organization::TeamMaterializationCommandOutcome::Rejected => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team agent materialization was rejected.")
            }
            crate::organization::TeamMaterializationCommandOutcome::OutcomeUnknown => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            crate::organization::TeamMaterializationCommandOutcome::Unavailable => unavailable(),
        },
        TeamRuntimeCommandOutcome::Delete(result) => match result {
            Ok(crate::organization::TeamDeleteOutcome::Deleted) => CommandOutcome::succeeded(CommandResult::private(json!({
                "teamId": team_id,
                "state": "tombstoned",
            }))),
            Ok(crate::organization::TeamDeleteOutcome::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "teamId": team_id, "state": "outcome_unknown" })))
            }
            Err(_) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team deletion was rejected.",
            ),
        },
        TeamRuntimeCommandOutcome::RunCreate(result) => match result {
            Ok(organization::CreateGraphRunOutcome::Created(run_id)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "runId": run_id.as_str(),
                "status": "created",
                "revision": 1,
            }))),
            Ok(organization::CreateGraphRunOutcome::Replayed(run_id)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "runId": run_id.as_str(),
                "status": "created",
                "revision": 1,
                "replayed": true,
            }))),
            Ok(organization::CreateGraphRunOutcome::ExistingRun)
            | Ok(organization::CreateGraphRunOutcome::ConflictingIdempotency)
            | Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team run creation was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunList(runs) => CommandOutcome::succeeded(CommandResult::private(json!({
            "teamId": team_id,
            "runs": runs.iter().filter_map(team_run_list_item_legacy_json).collect::<Vec<_>>(),
        }))),
        TeamRuntimeCommandOutcome::Resume {
            team_id,
            outcomes,
            runs,
        } => {
            let result = team_resume_legacy_json(&team_id, &outcomes, &runs);
            if outcomes
                .iter()
                .any(|outcome| matches!(outcome, organization::ResumeOutcome::OutcomeUnknown(_)))
            {
                CommandOutcome::unknown(CommandResult::private(result))
            } else {
                CommandOutcome::succeeded(CommandResult::private(result))
            }
        },
        TeamRuntimeCommandOutcome::TriggerList(triggers) => CommandOutcome::succeeded(CommandResult::private(json!({
            "triggers": triggers.iter().map(team_trigger_json).collect::<Vec<_>>(),
        }))),
        TeamRuntimeCommandOutcome::TriggerFire(result) => match result {
            Ok(result) => team_run_trigger_outcome(result),
            Err(_) => CommandOutcome::rejected(RejectionCode::Failed, "Team trigger was rejected."),
        },
        TeamRuntimeCommandOutcome::RoleMessageSubmit(result)
        | TeamRuntimeCommandOutcome::RoleMessageSubmitForRun(result) => match result {
            Ok(organization::RoleChatAdmissionOutcome::Accepted { delivery_id }) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "success": true,
                    "outcome": "accepted",
                    "deliveryId": delivery_id.as_str(),
                })))
            }
            Ok(organization::RoleChatAdmissionOutcome::Rejected(_)) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team role message was rejected.",
            ),
            Ok(organization::RoleChatAdmissionOutcome::OutcomeUnknown) | Err(_) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
        },
        TeamRuntimeCommandOutcome::RunStartConfirm(result) => match result {
            Ok(organization::ConfirmRunStartOutcome::Started)
            | Ok(organization::ConfirmRunStartOutcome::Replayed) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "success": true,
                    "outcome": "started",
                })))
            }
            Ok(organization::ConfirmRunStartOutcome::Intake)
            | Ok(organization::ConfirmRunStartOutcome::ProposalMismatch) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team run start proposal was rejected.",
            ),
            Err(_) => CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" }))),
        },
        TeamRuntimeCommandOutcome::RunStartContinue(result) => match result {
            Ok(organization::ContinueRunDiscussionOutcome::Intake)
            | Ok(organization::ContinueRunDiscussionOutcome::Replayed) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "success": true,
                    "outcome": "intake",
                })))
            }
            Ok(organization::ContinueRunDiscussionOutcome::AlreadyStarted)
            | Ok(organization::ContinueRunDiscussionOutcome::ProposalMismatch) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team run start proposal was rejected.",
            ),
            Err(_) => CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" }))),
        },
        TeamRuntimeCommandOutcome::RunSnapshotInvalidInput => invalid_input(),
        TeamRuntimeCommandOutcome::RunSnapshot {
            snapshot,
            role_sessions,
        } => match snapshot {
            organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(snapshot) => {
                CommandOutcome::succeeded(CommandResult::private(team_run_public_snapshot_legacy_json(&snapshot, role_sessions.as_deref())))
            }
            organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Unavailable(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphExportYaml(result) => match result {
            Ok(yaml) => CommandOutcome::succeeded(CommandResult::private(json!({
                "runId": run_id,
                "fileName": run_id.map(|run_id| format!("{run_id}.yaml")),
                "yaml": yaml,
            }))),
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team graph export was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphImportYaml(result) => match result {
            Ok(crate::organization::TeamRunCommandOutcome::Available(run)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "runId": run.run().as_str(),
                "imported": true,
            }))),
            Ok(crate::organization::TeamRunCommandOutcome::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Ok(crate::organization::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Err(organization::StoreFault::CommitOutcomeUnknown(_)) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(organization::StoreFault::InvalidFacts | organization::StoreFault::EventLedger(_)) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team graph import was rejected.")
            }
            Err(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunDiagnostics(result) => match result {
            organization::TeamRunDiagnosticsQueryOutcome::Available(diagnostics) => {
                CommandOutcome::succeeded(CommandResult::private(team_run_diagnostics_json(&diagnostics)))
            }
            organization::TeamRunDiagnosticsQueryOutcome::Unavailable(_) => unavailable(),
        },
        TeamRuntimeCommandOutcome::WebhookTriggerFire(result) => match result {
            Ok(organization::TeamTriggerFireOutcome::Recorded(request)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "fired": true,
                "runId": request.trigger.run_id,
                "outcome": "recorded",
            }))),
            Ok(organization::TeamTriggerFireOutcome::Replayed(request)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "fired": false,
                "runId": request.trigger.run_id,
                "outcome": "replayed",
            }))),
            Ok(organization::TeamTriggerFireOutcome::Conflicting { .. }) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team webhook trigger conflicted with an existing request.")
            }
            Ok(organization::TeamTriggerFireOutcome::NotFound) => unavailable(),
            Ok(organization::TeamTriggerFireOutcome::Unknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Ok(organization::TeamTriggerFireOutcome::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team webhook trigger was rejected.")
            }
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team webhook trigger was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::GraphSave(result)
        | TeamRuntimeCommandOutcome::GraphPatch(result) => match result {
            Ok(crate::organization::TeamRunCommandOutcome::Available(run)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "runId": run.run().as_str(),
                "saved": true,
                "outcome": "available",
            }))),
            Ok(crate::organization::TeamRunCommandOutcome::Unavailable) => unavailable(),
            Ok(crate::organization::TeamRunCommandOutcome::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(_) => CommandOutcome::rejected(RejectionCode::Failed, "Team graph command was rejected."),
        },
        TeamRuntimeCommandOutcome::GraphContext(result) => match result {
            organization::TeamGraphContextResult::Available(context) => CommandOutcome::succeeded(CommandResult::private(json!({
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
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
        },
        TeamRuntimeCommandOutcome::NodePromptRetryDue(result) => match result {
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Available(plan) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "runId": plan.run_id().as_str(),
                    "processedDeliveryRecordIds": plan.due_items().map(|item| item.delivery_id().as_str()).collect::<Vec<_>>(),
                    "nextRetryAt": plan.next_retry_at(),
                    "items": plan.items().iter().map(node_prompt_retry_due_item_json).collect::<Vec<_>>(),
                })))
            }
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Unknown(reason) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "outcome": "unknown", "reason": node_prompt_retry_due_unknown_reason(reason) })))
            }
            organization::run::scheduler::NodePromptRetryDueQueryOutcome::Invalid(reason) => {
                CommandOutcome::rejected(RejectionCode::Failed, node_prompt_retry_due_invalid_reason(reason))
            }
        },
        TeamRuntimeCommandOutcome::NodeEvent(result) => match result {
            Ok(TeamNodeEventCommandOutcome::NonTerminal(outcome)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "runId": run_id,
                "outcome": team_node_event_outcome_name(outcome),
            }))),
            Ok(TeamNodeEventCommandOutcome::Terminal(outcome)) => CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "runId": run_id,
                "outcome": team_node_terminal_outcome_name(outcome),
            }))),
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team node event was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::NodePromptSettled(result) => match result {
            Ok(crate::organization::TeamNodePromptSettledResult::Recorded(run_id)) => {
                CommandOutcome::succeeded(CommandResult::private(json!({ "settled": true, "runId": run_id.as_str(), "snapshot": null })))
            }
            Ok(crate::organization::TeamNodePromptSettledResult::Replayed(run_id)) => {
                CommandOutcome::succeeded(CommandResult::private(json!({ "settled": true, "runId": run_id.as_str(), "snapshot": null })))
            }
            Ok(crate::organization::TeamNodePromptSettledResult::NotFound) => {
                CommandOutcome::succeeded(CommandResult::private(json!({ "settled": false, "runId": null, "snapshot": null })))
            }
            Err(TeamRuntimeStatus::Rejected) => {
                CommandOutcome::rejected(RejectionCode::Failed, "Team node prompt settlement was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::RunDecisionSubmit(result) => match result {
            Ok(receipt) => CommandOutcome::succeeded(CommandResult::private(json!({
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
                CommandOutcome::rejected(RejectionCode::Failed, "Team decision was rejected.")
            }
            Err(TeamRuntimeStatus::OutcomeUnknown) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "outcome": "outcome-unknown" })))
            }
            Err(TeamRuntimeStatus::Unavailable) => unavailable(),
        },
        TeamRuntimeCommandOutcome::ApprovalResolve(result) => match result {
            Ok(organization::run::approval::HumanDecisionOutcome::Recorded) => {
                CommandOutcome::succeeded(CommandResult::private(json!({ "success": true, "outcome": "recorded" })))
            }
            Ok(organization::run::approval::HumanDecisionOutcome::Replayed) => {
                CommandOutcome::succeeded(CommandResult::private(json!({ "success": true, "outcome": "replayed" })))
            }
            Err(_) => CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "outcome-unknown" }))),
        },
        TeamRuntimeCommandOutcome::RunCancel(result) => match result {
            Ok(organization::BeginCancellationOutcome::Started(_))
            | Ok(organization::BeginCancellationOutcome::Replayed(_)) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "cancelling",
                })))
            }
            Ok(organization::BeginCancellationOutcome::AlreadyCancelled) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "cancelled",
                })))
            }
            Ok(organization::BeginCancellationOutcome::Tombstoned) => {
                CommandOutcome::succeeded(CommandResult::private(json!({
                    "success": true,
                    "runId": run_id,
                    "state": "tombstoned",
                })))
            }
            Ok(organization::BeginCancellationOutcome::OutcomeUnknown) | Err(_) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "state": "outcome_unknown" })))
            }
        },
        TeamRuntimeCommandOutcome::RunDelete(result) => match result {
            Ok(organization::GraphRunPurgeOutcome::Purged)
            | Ok(organization::GraphRunPurgeOutcome::Replayed) => CommandOutcome::succeeded(CommandResult::private(json!({
                "runId": run_id,
                "state": "purged",
            }))),
            Ok(organization::GraphRunPurgeOutcome::Rejected(_)) => CommandOutcome::rejected(
                RejectionCode::Failed,
                "Team run deletion was rejected.",
            ),
            Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(_)) => {
                CommandOutcome::unknown(CommandResult::private(json!({ "runId": run_id, "state": "outcome_unknown" })))
            }
            Err(_) => CommandOutcome::rejected(RejectionCode::Failed, "Team run deletion was rejected."),
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

fn decode_team_run_start_confirm(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    let proposal_id = decode_start_proposal_id(input)?;
    Ok(TeamRuntimeCommand::RunStartConfirm {
        run_id,
        proposal_id,
    })
}

fn decode_team_run_start_continue(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    let proposal_id = decode_start_proposal_id(input)?;
    Ok(TeamRuntimeCommand::RunStartContinue {
        run_id,
        proposal_id,
    })
}

fn decode_start_proposal_id(
    input: &serde_json::Map<String, Value>,
) -> Result<String, TeamRuntimeDecodeError> {
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "proposalId" | "idempotencyKey"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    input
        .get("proposalId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)
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
    endpoint: organization::RuntimeEndpointReference,
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
    let team_id = decode_optional_team_id(input.get("teamId"), target.get("teamId"))?;
    let package_path = input
        .get("packagePath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = decode_idempotency_key(input, "idempotencyKey")?;
    let source = decode_team_runtime_source(input.get("sourceType"))?;
    let manual_team = match source {
        TeamRuntimeCreateSource::TeamSkill => {
            if input.contains_key("manualTeam") {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            None
        }
        TeamRuntimeCreateSource::Manual => Some(decode_manual_team_provision(
            input
                .get("manualTeam")
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        )?),
    };
    if team_id.is_none() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "packagePath" | "teamId" | "idempotencyKey" | "sourceType" | "manualTeam"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::ProvisionAgents {
        package_root: PathBuf::from(package_path),
        team_id,
        idempotency_key,
        endpoint,
        source,
        manual_team,
    })
}

fn decode_manual_team_provision(
    value: &Value,
) -> Result<ManualTeamProvision, TeamRuntimeDecodeError> {
    let record = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if !record
        .keys()
        .all(|key| matches!(key.as_str(), "name" | "description" | "version" | "members"))
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_name = manual_required_string(record, "name")?;
    let members = record
        .get("members")
        .and_then(Value::as_array)
        .filter(|members| !members.is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let mut leader_count = 0usize;
    let mut role_ids = BTreeSet::new();
    let mut agent_ids = BTreeSet::new();
    let mut roles = Vec::with_capacity(members.len());
    for member in members {
        roles.push(decode_manual_team_member_provision(
            member,
            &mut leader_count,
            &mut role_ids,
            &mut agent_ids,
        )?);
    }
    if leader_count != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(ManualTeamProvision {
        team_name: team_name.to_owned(),
        roles,
    })
}

fn decode_manual_team_member_provision(
    value: &Value,
    leader_count: &mut usize,
    role_ids: &mut BTreeSet<String>,
    agent_ids: &mut BTreeSet<String>,
) -> Result<organization::ManualTeamRoleBinding, TeamRuntimeDecodeError> {
    let member = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if !member.keys().all(|key| {
        matches!(
            key.as_str(),
            "agentId"
                | "agentName"
                | "workspace"
                | "roleId"
                | "skills"
                | "tools"
                | "model"
                | "isLeader"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let agent_id = manual_required_string(member, "agentId")?;
    let _workspace = manual_required_string(member, "workspace")?;
    let declared_role = manual_required_string(member, "roleId")?;
    let leader = matches!(member.get("isLeader").and_then(Value::as_bool), Some(true));
    let role_id = if leader {
        *leader_count += 1;
        organization::LEADER_ROLE_ID
    } else {
        if declared_role == organization::LEADER_ROLE_ID {
            return Err(TeamRuntimeDecodeError::InvalidInput);
        }
        declared_role
    };
    if !agent_ids.insert(agent_id.to_owned()) || !role_ids.insert(role_id.to_owned()) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let member_name = member
        .get("agentName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(agent_id);
    let role = organization::RoleId::try_new(role_id.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let agent = organization::ManagedAgentReference::try_new(agent_id.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    organization::ManualTeamRoleBinding::try_new(role, member_name.to_owned(), agent, leader)
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn manual_required_string<'a>(
    record: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, TeamRuntimeDecodeError> {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)
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
    let command_id = bounded_run_command_id(
        RunCommandIdentityKind::GraphImportYaml,
        idempotency_key.as_str(),
    )?;
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
    if let Some(value) = input.get("payloadSummary")
        && !value.is_string()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId"
                | "teamId"
                | "startNodeId"
                | "triggerSource"
                | "payloadSummary"
                | "idempotencyKey"
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
    match view {
        organization::TeamGraphContextView::CurrentNode if node_execution_id.is_none() => {
            return Err(TeamRuntimeDecodeError::InvalidInput);
        }
        organization::TeamGraphContextView::GraphSummary if node_execution_id.is_some() => {
            return Err(TeamRuntimeDecodeError::InvalidInput);
        }
        _ => {}
    }
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
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "graph" | "idempotencyKey" | "summary" | "metadata"
        )
    }) || input.len() < 3
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(summary) = input.get("summary")
        && !summary.is_string()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(metadata) = input.get("metadata")
        && !metadata.is_object()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let graph = input
        .get("graph")
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let definition = decode_team_graph_definition(graph, &run_id)?;
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id =
        bounded_run_command_id(RunCommandIdentityKind::GraphSave, idempotency_key.as_str())?;
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
            "runId" | "summary" | "patch" | "idempotencyKey" | "metadata"
        )
    }) || input.len() < 4
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if input.get("summary").and_then(Value::as_str).is_none() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(metadata) = input.get("metadata")
        && !metadata.is_object()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id =
        bounded_run_command_id(RunCommandIdentityKind::GraphPatch, idempotency_key.as_str())?;
    let audit_run_id = decode_opaque_value(run_id.as_str())?;
    let patch = decode_team_graph_patch_value(
        input
            .get("patch")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        run_id,
        audit_run_id,
        command_id,
        idempotency_key,
    )?;
    Ok(TeamRuntimeCommand::GraphPatch { patch })
}

fn decode_team_node_prompt_settled(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    if !target.is_null() || input.len() != 3 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let phase = match input.get("phase").and_then(Value::as_str) {
        Some("final") => TeamRuntimePromptPhase::Final,
        Some("error") => TeamRuntimePromptPhase::Error,
        Some("aborted") => TeamRuntimePromptPhase::Aborted,
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
) -> Result<Option<TeamNodeTerminalResolution>, TeamRuntimeDecodeError> {
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
    Ok(Some(TeamNodeTerminalResolution {
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
    }))
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

fn bounded_run_command_id(
    kind: RunCommandIdentityKind,
    idempotency_key: &str,
) -> Result<organization::run::event::OpaqueId, TeamRuntimeDecodeError> {
    let label = kind.label();
    let candidate = format!("{label}:{idempotency_key}");
    if let Ok(command_id) = decode_opaque_value(&candidate) {
        return Ok(command_id);
    }

    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(idempotency_key.as_bytes());
    let mut value = String::with_capacity(label.len() + 65);
    value.push_str(label);
    value.push(':');
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    decode_opaque_value(&value)
}

fn decode_team_graph_definition(
    value: &Value,
    run_id: &organization::GraphRunId,
) -> Result<organization::GraphDefinition, TeamRuntimeDecodeError> {
    let graph = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if let Some(graph_run_id) = graph.get("runId")
        && graph_run_id.as_str() != Some(run_id.as_str())
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let graph_id = graph_string_field(graph, "graphId")
        .map(str::to_owned)
        .unwrap_or_else(|| default_team_graph_id(run_id));
    let workflow_plan_id = graph_string_field(graph, "workflowPlanId")
        .map(str::to_owned)
        .unwrap_or_else(|| default_team_workflow_plan_id(run_id));
    let title = graph_string_field(graph, "title")
        .map(str::to_owned)
        .unwrap_or_else(|| "Team graph".to_owned());
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

fn default_team_graph_id(run_id: &organization::GraphRunId) -> String {
    format!("graph:{}", run_id.as_str())
}

fn default_team_workflow_plan_id(run_id: &organization::GraphRunId) -> String {
    format!("workflow:{}", run_id.as_str())
}

fn graph_string_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && valid_identifier(value))
}

fn graph_text_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
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
    let node_id = graph_string_field(node, "nodeId")
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?
        .to_owned();
    let id = organization::NodeId::new(node_id.clone());
    let title = graph_string_field(node, "title")
        .unwrap_or(node_id.as_str())
        .to_owned();
    let config = node.get("config").and_then(Value::as_object);
    let max_attempts = decode_team_graph_node_max_attempts(node, config);
    let kind =
        decode_team_graph_node_kind(node.get("kind").and_then(Value::as_str).unwrap_or("work"))?;
    match kind {
        organization::NodeKind::Start => Ok(organization::NodeDefinition::start(
            id,
            title,
            max_attempts,
            decode_team_graph_start_trigger(config)?,
        )),
        organization::NodeKind::Work => {
            let task_id = graph_string_field(node, "taskId").unwrap_or(node_id.as_str());
            let role_id = decode_team_graph_role_id(node).unwrap_or("team");
            let prompt = config
                .and_then(|config| graph_text_field(config, "prompt"))
                .unwrap_or("");
            let output_artifact_kind = config
                .and_then(|config| graph_text_field(config, "outputArtifactKind"))
                .map(str::to_owned);
            let group_id = graph_string_field(node, "groupId")
                .map(|group_id| organization::GroupId::new(group_id.to_owned()));
            Ok(organization::NodeDefinition::work(
                id,
                title,
                max_attempts,
                organization::WorkAssignment::typed(
                    task_id,
                    prompt,
                    organization::ExecutorPolicy::team_role(role_id),
                    output_artifact_kind,
                    group_id,
                ),
            ))
        }
        organization::NodeKind::Review => {
            let role_id = decode_team_graph_role_id(node);
            let prompt = config.and_then(|config| graph_text_field(config, "prompt"));
            if let (Some(role_id), Some(prompt)) = (role_id, prompt) {
                Ok(organization::NodeDefinition::review(
                    id,
                    title,
                    max_attempts,
                    organization::ReviewAssignment::new(role_id, prompt),
                ))
            } else {
                Ok(organization::NodeDefinition::control(
                    id,
                    kind,
                    title,
                    max_attempts,
                ))
            }
        }
        organization::NodeKind::Join => Ok(organization::NodeDefinition::join(
            id,
            title,
            max_attempts,
            organization::WorkGroup::new(
                organization::GroupId::new(graph_string_field(node, "groupId").unwrap_or("group")),
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

fn decode_team_graph_node_kind(
    kind: &str,
) -> Result<organization::NodeKind, TeamRuntimeDecodeError> {
    match kind {
        "start" => Ok(organization::NodeKind::Start),
        "work" => Ok(organization::NodeKind::Work),
        "review" => Ok(organization::NodeKind::Review),
        "human_decision" | "humanDecision" => Ok(organization::NodeKind::HumanDecision),
        "script_review" | "scriptReview" => Ok(organization::NodeKind::ScriptReview),
        "join" => Ok(organization::NodeKind::Join),
        "end" => Ok(organization::NodeKind::End),
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_graph_node_max_attempts(
    node: &serde_json::Map<String, Value>,
    config: Option<&serde_json::Map<String, Value>>,
) -> std::num::NonZeroU32 {
    node.get("maxAttempts")
        .or_else(|| config.and_then(|config| config.get("maxAttempts")))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .and_then(std::num::NonZeroU32::new)
        .unwrap_or_else(|| std::num::NonZeroU32::new(1).expect("nonzero"))
}

fn decode_team_graph_role_id(node: &serde_json::Map<String, Value>) -> Option<&str> {
    graph_string_field(node, "roleId").or_else(|| {
        node.get("executor")
            .and_then(Value::as_object)
            .and_then(|executor| graph_string_field(executor, "roleId"))
    })
}

fn decode_team_graph_start_trigger(
    config: Option<&serde_json::Map<String, Value>>,
) -> Result<Option<organization::StartTrigger>, TeamRuntimeDecodeError> {
    let Some(trigger) = config
        .and_then(|config| config.get("trigger"))
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    match trigger
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("webhook")
    {
        "cron" => Ok(Some(organization::StartTrigger::Cron {
            expression: graph_text_field(trigger, "cron")
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
        })),
        "webhook" => {
            Ok(
                graph_text_field(trigger, "path").map(|path| organization::StartTrigger::Webhook {
                    path: path.to_owned(),
                }),
            )
        }
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_graph_edges(
    value: &Value,
) -> Result<Vec<organization::EdgeDefinition>, TeamRuntimeDecodeError> {
    let edges = value
        .as_array()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    edges.iter().map(decode_team_graph_edge).collect()
}

fn decode_team_graph_edge(
    value: &Value,
) -> Result<organization::EdgeDefinition, TeamRuntimeDecodeError> {
    let edge = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let action = decode_team_graph_edge_action(
        edge.get("action")
            .and_then(Value::as_str)
            .unwrap_or("activate"),
    )?;
    let source_node_id = graph_string_field(edge, "sourceNodeId")
        .or_else(|| graph_string_field(edge, "fromNodeId"))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let target_node_id = graph_string_field(edge, "targetNodeId")
        .or_else(|| graph_string_field(edge, "toNodeId"))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let include_upstream_result = match edge
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("includeUpstreamResult"))
    {
        Some(value) => value
            .as_bool()
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        None => true,
    };
    Ok(organization::EdgeDefinition::new(
        organization::EdgeId::new(
            graph_string_field(edge, "edgeId").ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        ),
        organization::NodeId::new(source_node_id),
        graph_string_field(edge, "sourcePort").unwrap_or("default"),
        organization::NodeId::new(target_node_id),
        graph_string_field(edge, "targetPort").unwrap_or("default"),
        action,
    )
    .with_payload(organization::EdgePayloadPolicy::new(
        include_upstream_result,
    )))
}

fn decode_team_graph_edge_action(
    action: &str,
) -> Result<organization::EdgeAction, TeamRuntimeDecodeError> {
    match action {
        "activate" => Ok(organization::EdgeAction::Activate),
        "rework" => Ok(organization::EdgeAction::Rework),
        "gate" => Ok(organization::EdgeAction::Gate),
        "finish" => Ok(organization::EdgeAction::Finish),
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_graph_patch_value(
    value: &Value,
    run_id: organization::GraphRunId,
    audit_run_id: organization::run::event::OpaqueId,
    command_id: organization::run::event::OpaqueId,
    idempotency_key: organization::run::event::OpaqueId,
) -> Result<TeamGraphPatchDraft, TeamRuntimeDecodeError> {
    let patch = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let base_graph_id = graph_string_field(patch, "baseGraphId").map(str::to_owned);
    let base_workflow_plan_id = graph_string_field(patch, "baseWorkflowPlanId").map(str::to_owned);
    let operation_values = patch
        .get("operations")
        .and_then(Value::as_array)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let mut operations = Vec::with_capacity(operation_values.len());
    for value in operation_values {
        let operation = value
            .as_object()
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
        let op = operation
            .get("op")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
        match op {
            "add_node" => operations.push(organization::GraphPatchOperation::AddNode(
                decode_team_graph_node(
                    operation
                        .get("node")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "replace_node" => operations.push(organization::GraphPatchOperation::ReplaceNode(
                decode_team_graph_node(
                    operation
                        .get("node")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "remove_node" => operations.push(organization::GraphPatchOperation::RemoveNode(
                organization::NodeId::new(
                    graph_string_field(operation, "nodeId")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
            )),
            "add_edge" => operations.push(organization::GraphPatchOperation::AddEdge(
                decode_team_graph_edge(
                    operation
                        .get("edge")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "replace_edge" => operations.push(organization::GraphPatchOperation::ReplaceEdge(
                decode_team_graph_edge(
                    operation
                        .get("edge")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "remove_edge" => operations.push(organization::GraphPatchOperation::RemoveEdge(
                organization::EdgeId::new(
                    graph_string_field(operation, "edgeId")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
            )),
            "set_metadata" => decode_team_graph_metadata_patch(operation, &mut operations)?,
            _ => return Err(TeamRuntimeDecodeError::Unavailable),
        }
    }
    if operations.is_empty() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamGraphPatchDraft {
        run_id,
        audit_run_id,
        command_id,
        idempotency_key,
        base_graph_id,
        base_workflow_plan_id,
        operations,
        created_at: now_millis(),
    })
}

fn decode_team_graph_metadata_patch(
    operation: &serde_json::Map<String, Value>,
    operations: &mut Vec<organization::GraphPatchOperation>,
) -> Result<(), TeamRuntimeDecodeError> {
    let metadata = operation
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if metadata.is_empty() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    for (key, value) in metadata {
        operations.push(organization::GraphPatchOperation::SetMetadata {
            key: decode_opaque_value(key)?,
            value: decode_team_graph_metadata_value(value)?,
        });
    }
    Ok(())
}

fn decode_team_graph_metadata_value(
    value: &Value,
) -> Result<organization::run::event::MetadataValue, TeamRuntimeDecodeError> {
    match value {
        Value::Bool(value) => Ok(organization::run::event::MetadataValue::Enabled(*value)),
        Value::Number(value) => value
            .as_u64()
            .map(organization::run::event::MetadataValue::Revision)
            .ok_or(TeamRuntimeDecodeError::InvalidInput),
        Value::String(value) => Ok(organization::run::event::MetadataValue::OpaqueId(
            decode_opaque_value(value)?,
        )),
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
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

fn team_run_trigger_outcome(result: crate::organization::TeamRunTriggerOutcome) -> CommandOutcome {
    let registration = result.registration;
    match registration {
        organization::TriggerRegistration::Recorded(request) => {
            CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "fired": true,
                "runId": request.run_id,
                "outcome": "recorded",
            })))
        }
        organization::TriggerRegistration::Replayed(request) => {
            CommandOutcome::succeeded(CommandResult::private(json!({
                "success": true,
                "fired": false,
                "runId": request.run_id,
                "outcome": "replayed",
            })))
        }
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

fn team_run_list_item_legacy_json(outcome: &organization::TeamRunQueryOutcome) -> Option<Value> {
    match outcome {
        organization::TeamRunQueryOutcome::Available(run) => {
            let sessions = team_role_bindings_legacy_json(run.role_sessions())?;
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
    role_sessions: Option<&[organization::TeamRoleSessionProjection]>,
) -> Value {
    let roles = role_sessions.map(team_role_session_projections_legacy_json);
    json!({
        "run": team_public_run_legacy_json(snapshot),
        "graph": team_public_graph_legacy_json(snapshot.run().run_id(), snapshot.graph()),
        "nodeInputStates": [],
        "nodeExecutions": snapshot.attempts().iter().map(|attempt| team_public_attempt_legacy_json(snapshot.run().run_id(), attempt)).collect::<Vec<_>>(),
        "nodeDeliveries": [],
        "roles": roles.clone().unwrap_or_default(),
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
        "unavailableSections": team_public_unavailable_sections_legacy_json(snapshot, roles.is_some()),
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

fn team_role_bindings_legacy_json(
    bindings: &[organization::RoleSessionReceipt],
) -> Option<Vec<Value>> {
    bindings.iter().map(team_role_binding_legacy_json).collect()
}

fn team_role_session_projections_legacy_json(
    sessions: &[organization::TeamRoleSessionProjection],
) -> Vec<Value> {
    sessions
        .iter()
        .map(team_role_sessions::role_session_json)
        .collect()
}

pub(super) fn team_role_binding_legacy_json(
    binding: &organization::RoleSessionReceipt,
) -> Option<Value> {
    Some(json!({
        "teamId": binding.team().as_str(),
        "runId": binding.team_run().as_str(),
        "roleId": binding.role().as_str(),
        "sessionRef": binding.session_ref().as_str(),
        "status": "available",
    }))
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
        "nodes": graph.nodes().iter().map(team_public_node_legacy_json).collect::<Vec<_>>(),
        "edges": graph.edges().iter().map(team_public_edge_legacy_json).collect::<Vec<_>>(),
        "status": team_public_graph_status_name(graph.status()),
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

pub(super) fn team_public_unavailable_section_name(
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
        "runs": runs.iter().filter_map(team_run_list_item_legacy_json).collect::<Vec<_>>(),
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

fn team_trigger_json(trigger: &crate::organization::ArmedTrigger) -> Value {
    let trigger_value = match &trigger.trigger {
        crate::organization::TeamTrigger::Webhook { .. } => json!({ "kind": "webhook" }),
        crate::organization::TeamTrigger::Cron { expression } => {
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
    outcome: crate::organization::TeamNodeTerminalResult,
) -> &'static str {
    match outcome {
        crate::organization::TeamNodeTerminalResult::Recorded => "terminal_recorded",
        crate::organization::TeamNodeTerminalResult::Replayed => "terminal_replayed",
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
