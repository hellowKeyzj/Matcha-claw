pub(crate) mod server;

use serde_json::{Value, json};

use crate::{
    organization::OrganizationHandle, transport::authorization::CapabilityDecisionVerifier,
};

const AUTHORIZATION_ENDPOINT: &str = "/api/team/lifecycle";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_SUBJECT: &str = "team-lifecycle";
const LIST_OPERATION: &str = "team.lifecycle.list";
const CREATE_OPERATION: &str = "team.lifecycle.create";
const DELETE_OPERATION: &str = "team.lifecycle.delete";
const RESUME_OPERATION: &str = "team.lifecycle.resume";
const CANCEL_OPERATION: &str = "team.lifecycle.cancel";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    List {
        team_id: organization::TeamId,
    },
    Create {
        team_id: organization::TeamId,
        run_id: organization::GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
    },
    Delete {
        target: DeleteTarget,
        idempotency_key: String,
    },
    Resume {
        team_id: organization::TeamId,
        idempotency_key: String,
    },
    Cancel {
        run_id: organization::GraphRunId,
        idempotency_key: String,
    },
}

pub(crate) enum Delivery {
    Listed(Vec<organization::TeamRunQueryOutcome>),
    Created {
        run_id: String,
        outcome: CreateState,
    },
    TeamDeleted {
        team_id: String,
        outcome: TeamDeleteState,
    },
    Resumed(Vec<organization::ResumeOutcome>),
    Cancellation {
        run_id: String,
        state: CancellationState,
    },
    RunDeleted {
        run_id: String,
        state: TombstoneState,
    },
    Rejected,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CancellationState {
    Cancelling,
    Cancelled,
    OutcomeUnknown,
    Tombstoned,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CreateState {
    Created,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamDeleteState {
    Deleted,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DeleteTarget {
    Team(organization::TeamId),
    Run(organization::GraphRunId),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TombstoneState {
    Purged,
    Rejected,
    OutcomeUnknown,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Listed(_)
            | Self::Created { .. }
            | Self::TeamDeleted {
                outcome: TeamDeleteState::Deleted,
                ..
            }
            | Self::Resumed(_)
            | Self::Cancellation {
                state:
                    CancellationState::Cancelling
                    | CancellationState::Cancelled
                    | CancellationState::Tombstoned,
                ..
            }
            | Self::RunDeleted {
                state: TombstoneState::Purged | TombstoneState::Rejected,
                ..
            } => 200,
            Self::TeamDeleted {
                outcome: TeamDeleteState::OutcomeUnknown,
                ..
            }
            | Self::Cancellation {
                state: CancellationState::OutcomeUnknown,
                ..
            }
            | Self::RunDeleted {
                state: TombstoneState::OutcomeUnknown,
                ..
            }
            | Self::Rejected => 409,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::TeamDeleted {
                outcome: TeamDeleteState::OutcomeUnknown,
                ..
            }
            | Self::Cancellation {
                state: CancellationState::OutcomeUnknown,
                ..
            }
            | Self::RunDeleted {
                state: TombstoneState::OutcomeUnknown,
                ..
            } => json!({
                "success": false,
                "error": "Team lifecycle outcome is unknown",
            }),
            Self::Listed(runs) => json!({
                "success": true,
                "action": "list",
                "runs": runs.iter().map(run_json).collect::<Vec<_>>(),
            }),
            Self::Created { run_id, outcome } => json!({
                "success": true,
                "action": "create",
                "runId": run_id,
                "outcome": create_state_name(*outcome),
            }),
            Self::TeamDeleted { team_id, outcome } => json!({
                "success": true,
                "action": "delete",
                "teamId": team_id,
                "outcome": team_delete_state_name(*outcome),
            }),
            Self::Resumed(outcomes) => json!({
                "success": true,
                "action": "resume",
                "runs": outcomes.iter().map(resume_json).collect::<Vec<_>>(),
            }),
            Self::Cancellation { run_id, state } => json!({
                "success": true,
                "action": "cancel",
                "runId": run_id,
                "state": cancellation_state_name(*state),
            }),
            Self::RunDeleted { run_id, state } => json!({
                "success": true,
                "action": "delete",
                "runId": run_id,
                "state": tombstone_state_name(*state),
            }),
            Self::Rejected => json!({
                "success": false,
                "error": "Team lifecycle request was rejected",
            }),
            Self::Unavailable => json!({
                "success": false,
                "error": "Team lifecycle is unavailable",
            }),
        }
    }
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    let Some(Value::String(action)) = body.get("action") else {
        return Err(DecodeError::Invalid);
    };
    let operation = match action.as_str() {
        "list" => LIST_OPERATION,
        "create" => CREATE_OPERATION,
        "delete" => DELETE_OPERATION,
        "resume" => RESUME_OPERATION,
        "cancel" => CANCEL_OPERATION,
        _ => return Err(DecodeError::Invalid),
    };
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            operation,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;

    match action.as_str() {
        "list" if has_keys(&body, &["action", "teamId"]) => Ok(Request::List {
            team_id: team_id(body.get("teamId"))?,
        }),
        "create"
            if has_keys(
                &body,
                &[
                    "action",
                    "teamId",
                    "runId",
                    "idempotencyKey",
                    "workflowPlan",
                    "sourceIdentity",
                    "templateRevision",
                ],
            ) =>
        {
            let request_run_id = run_id(body.get("runId"))?;
            let workflow_plan_value = body.get("workflowPlan").ok_or(DecodeError::Invalid)?;
            let workflow_plan_run_id = workflow_plan_value
                .as_object()
                .and_then(|plan| plan.get("runId"))
                .and_then(Value::as_str)
                .ok_or(DecodeError::Invalid)?;
            if workflow_plan_run_id != request_run_id.as_str() {
                return Err(DecodeError::Invalid);
            }
            Ok(Request::Create {
                team_id: team_id(body.get("teamId"))?,
                run_id: request_run_id,
                idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
                workflow_plan: decode_workflow_plan(Some(workflow_plan_value))?,
                source_identity: valid_text(string(body.get("sourceIdentity"))?)?.to_owned(),
                template_revision: body
                    .get("templateRevision")
                    .and_then(Value::as_u64)
                    .ok_or(DecodeError::Invalid)?,
            })
        }
        "delete" if has_keys(&body, &["action", "teamId", "idempotencyKey"]) => {
            Ok(Request::Delete {
                target: DeleteTarget::Team(team_id(body.get("teamId"))?),
                idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
            })
        }
        "delete" if has_keys(&body, &["action", "runId", "idempotencyKey"]) => {
            Ok(Request::Delete {
                target: DeleteTarget::Run(run_id(body.get("runId"))?),
                idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
            })
        }
        "resume" if has_keys(&body, &["action", "teamId", "idempotencyKey"]) => {
            Ok(Request::Resume {
                team_id: team_id(body.get("teamId"))?,
                idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
            })
        }
        "cancel" if has_keys(&body, &["action", "runId", "idempotencyKey"]) => {
            Ok(Request::Cancel {
                run_id: run_id(body.get("runId"))?,
                idempotency_key: opaque_id(string(body.get("idempotencyKey"))?)?,
            })
        }
        _ => Err(DecodeError::Invalid),
    }
}

pub(crate) async fn handle(
    owner: &OrganizationHandle,
    request: Request,
    observed_at: u64,
) -> Delivery {
    match request {
        Request::List { team_id } => owner
            .run_list(team_id)
            .await
            .map_or(Delivery::Unavailable, Delivery::Listed),
        Request::Create {
            team_id,
            run_id,
            idempotency_key,
            workflow_plan,
            source_identity,
            template_revision,
        } => {
            let response_run_id = run_id.as_str().to_owned();
            match owner
                .run_create(
                    team_id,
                    run_id,
                    idempotency_key,
                    workflow_plan,
                    source_identity,
                    template_revision,
                    observed_at,
                )
                .await
            {
                Ok(Ok(organization::CreateGraphRunOutcome::Created(_))) => Delivery::Created {
                    run_id: response_run_id,
                    outcome: CreateState::Created,
                },
                Ok(Ok(organization::CreateGraphRunOutcome::Replayed(_))) => Delivery::Created {
                    run_id: response_run_id,
                    outcome: CreateState::Replayed,
                },
                Ok(Ok(
                    organization::CreateGraphRunOutcome::ConflictingIdempotency
                    | organization::CreateGraphRunOutcome::ExistingRun,
                ))
                | Ok(Err(_)) => Delivery::Rejected,
                Err(_) => Delivery::Unavailable,
            }
        }
        Request::Delete {
            target: DeleteTarget::Team(team_id),
            idempotency_key,
        } => {
            let response_team_id = team_id.as_str().to_owned();
            let idempotency_key = match organization::IdempotencyKey::try_new(idempotency_key) {
                Ok(idempotency_key) => idempotency_key,
                Err(_) => return Delivery::Rejected,
            };
            match owner
                .team_delete(team_id, idempotency_key, observed_at)
                .await
            {
                Ok(Ok(crate::composition::TeamDeleteOutcome::Deleted)) => Delivery::TeamDeleted {
                    team_id: response_team_id,
                    outcome: TeamDeleteState::Deleted,
                },
                Ok(Ok(crate::composition::TeamDeleteOutcome::OutcomeUnknown)) => {
                    Delivery::TeamDeleted {
                        team_id: response_team_id,
                        outcome: TeamDeleteState::OutcomeUnknown,
                    }
                }
                Ok(Err(_)) => Delivery::Rejected,
                Err(_) => Delivery::Unavailable,
            }
        }
        Request::Resume {
            idempotency_key, ..
        } => {
            debug_assert!(!idempotency_key.is_empty());
            Delivery::Unavailable
        }
        Request::Cancel {
            run_id,
            idempotency_key,
        } => {
            let response_run_id = run_id.as_str().to_owned();
            match owner.run_cancel(run_id, idempotency_key, observed_at).await {
                Ok(Ok(outcome)) => Delivery::Cancellation {
                    run_id: response_run_id,
                    state: cancellation_state(outcome),
                },
                Ok(Err(_)) => Delivery::Rejected,
                Err(_) => Delivery::Unavailable,
            }
        }
        Request::Delete {
            target: DeleteTarget::Run(run_id),
            idempotency_key,
        } => {
            let response_run_id = run_id.as_str().to_owned();
            match owner
                .run_delete_and_purge(run_id, idempotency_key, observed_at)
                .await
            {
                Ok(Ok(outcome)) => Delivery::RunDeleted {
                    run_id: response_run_id,
                    state: purge_state(outcome),
                },
                Ok(Err(_)) => Delivery::Rejected,
                Err(_) => Delivery::Unavailable,
            }
        }
    }
}

fn cancellation_state(outcome: organization::BeginCancellationOutcome) -> CancellationState {
    match outcome {
        organization::BeginCancellationOutcome::Started(_)
        | organization::BeginCancellationOutcome::Replayed(_) => CancellationState::Cancelling,
        organization::BeginCancellationOutcome::AlreadyCancelled => CancellationState::Cancelled,
        organization::BeginCancellationOutcome::OutcomeUnknown => CancellationState::OutcomeUnknown,
        organization::BeginCancellationOutcome::Tombstoned => CancellationState::Tombstoned,
    }
}

fn purge_state(outcome: organization::GraphRunPurgeOutcome) -> TombstoneState {
    match outcome {
        organization::GraphRunPurgeOutcome::Purged
        | organization::GraphRunPurgeOutcome::Replayed => TombstoneState::Purged,
        organization::GraphRunPurgeOutcome::Rejected(_) => TombstoneState::Rejected,
        organization::GraphRunPurgeOutcome::OutcomeUnknown(_) => TombstoneState::OutcomeUnknown,
    }
}

fn run_json(outcome: &organization::TeamRunQueryOutcome) -> Value {
    match outcome {
        organization::TeamRunQueryOutcome::Available(run) => json!({
            "state": "available",
            "teamId": run.team().as_str(),
            "runId": run.run().as_str(),
            "teamRevision": run.team_revision().get(),
            "graphStatus": graph_status_name(run.graph_status()),
        }),
        organization::TeamRunQueryOutcome::Unavailable => json!({ "state": "unavailable" }),
        organization::TeamRunQueryOutcome::OutcomeUnknown => json!({ "state": "outcome_unknown" }),
    }
}

fn resume_json(outcome: &organization::ResumeOutcome) -> Value {
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

fn graph_status_name(status: organization::GraphStatus) -> &'static str {
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

fn create_state_name(state: CreateState) -> &'static str {
    match state {
        CreateState::Created => "created",
        CreateState::Replayed => "replayed",
    }
}

fn team_delete_state_name(state: TeamDeleteState) -> &'static str {
    match state {
        TeamDeleteState::Deleted => "deleted",
        TeamDeleteState::OutcomeUnknown => "outcome_unknown",
    }
}

fn cancellation_state_name(state: CancellationState) -> &'static str {
    match state {
        CancellationState::Cancelling => "cancelling",
        CancellationState::Cancelled => "cancelled",
        CancellationState::OutcomeUnknown => "outcome_unknown",
        CancellationState::Tombstoned => "tombstoned",
    }
}

fn tombstone_state_name(state: TombstoneState) -> &'static str {
    match state {
        TombstoneState::Purged => "purged",
        TombstoneState::Rejected => "rejected",
        TombstoneState::OutcomeUnknown => "outcome_unknown",
    }
}

fn has_keys(body: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    body.len() == keys.len() && keys.iter().all(|key| body.contains_key(*key))
}

fn string(value: Option<&Value>) -> Result<&str, DecodeError> {
    value.and_then(Value::as_str).ok_or(DecodeError::Invalid)
}

fn team_id(value: Option<&Value>) -> Result<organization::TeamId, DecodeError> {
    organization::TeamId::try_new(string(value)?.to_owned()).map_err(|_| DecodeError::Invalid)
}

fn decode_workflow_plan(value: Option<&Value>) -> Result<organization::WorkflowPlan, DecodeError> {
    let Value::Object(plan) = value.ok_or(DecodeError::Invalid)? else {
        return Err(DecodeError::Invalid);
    };
    if plan.len() != 8 {
        return Err(DecodeError::Invalid);
    }
    let groups = plan
        .get("groups")
        .and_then(Value::as_array)
        .ok_or(DecodeError::Invalid)?
        .iter()
        .map(decode_workflow_group)
        .collect::<Result<Vec<_>, _>>()?;
    let tasks = plan
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or(DecodeError::Invalid)?
        .iter()
        .map(decode_workflow_task)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(organization::WorkflowPlan::new(
        text_field(plan, "workflowPlanId")?,
        text_field(plan, "runId")?,
        text_field(plan, "title")?,
        text_field(plan, "status")?,
        groups,
        tasks,
        text_field(plan, "idempotencyKey")?,
        plan.get("createdAt")
            .and_then(Value::as_u64)
            .ok_or(DecodeError::Invalid)?,
    ))
}

fn decode_workflow_task(value: &Value) -> Result<organization::WorkflowTask, DecodeError> {
    let Value::Object(task) = value else {
        return Err(DecodeError::Invalid);
    };
    if task.len() != 6 {
        return Err(DecodeError::Invalid);
    }
    let dependencies = task
        .get("dependsOnTaskIds")
        .and_then(Value::as_array)
        .ok_or(DecodeError::Invalid)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or(DecodeError::Invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let output = match task.get("outputArtifactKind") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) => None,
        _ => return Err(DecodeError::Invalid),
    };
    Ok(organization::WorkflowTask::new(
        text_field(task, "taskId")?,
        text_field(task, "roleId")?,
        text_field(task, "title")?,
        text_field(task, "prompt")?,
        dependencies,
        output,
    ))
}

fn decode_workflow_group(value: &Value) -> Result<organization::WorkflowGroup, DecodeError> {
    let Value::Object(group) = value else {
        return Err(DecodeError::Invalid);
    };
    if group.len() != 4 {
        return Err(DecodeError::Invalid);
    }
    let task_ids = group
        .get("taskIds")
        .and_then(Value::as_array)
        .ok_or(DecodeError::Invalid)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or(DecodeError::Invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Value::Object(join) = group.get("join").ok_or(DecodeError::Invalid)? else {
        return Err(DecodeError::Invalid);
    };
    if join.len() != 3 {
        return Err(DecodeError::Invalid);
    }
    Ok(organization::WorkflowGroup::new(
        text_field(group, "groupId")?,
        text_field(group, "title")?,
        task_ids,
        organization::WorkflowJoinPolicy::new(
            join.get("requireCompleted")
                .and_then(Value::as_bool)
                .ok_or(DecodeError::Invalid)?,
            join.get("allowFailed")
                .and_then(Value::as_bool)
                .ok_or(DecodeError::Invalid)?,
            join.get("retryLimit")
                .and_then(Value::as_u64)
                .and_then(|value| value.try_into().ok())
                .ok_or(DecodeError::Invalid)?,
        ),
    ))
}

fn text_field(object: &serde_json::Map<String, Value>, field: &str) -> Result<String, DecodeError> {
    valid_text(
        object
            .get(field)
            .and_then(Value::as_str)
            .ok_or(DecodeError::Invalid)?,
    )
    .map(ToOwned::to_owned)
}

fn valid_text(value: &str) -> Result<&str, DecodeError> {
    valid_identifier(value)
        .then_some(value)
        .ok_or(DecodeError::Invalid)
}

fn run_id(value: Option<&Value>) -> Result<organization::GraphRunId, DecodeError> {
    let value = string(value)?;
    valid_identifier(value)
        .then(|| organization::GraphRunId::new(value.to_owned()))
        .ok_or(DecodeError::Invalid)
}

fn opaque_id(value: &str) -> Result<String, DecodeError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'));
    valid.then(|| value.to_owned()).ok_or(DecodeError::Invalid)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_only_closed_lifecycle_requests_bound_to_each_operation() {
        let list = decode_with_authorization(
            json!({ "action": "list", "teamId": "team:one" }),
            LIST_OPERATION,
        )
        .expect("list request");
        assert!(matches!(list, Request::List { .. }));

        let create = decode_with_authorization(
            json!({
                "action": "create",
                "teamId": "team:one",
                "runId": "run:one",
                "idempotencyKey": "create:one",
                "workflowPlan": {
                    "workflowPlanId": "plan:one",
                    "runId": "run:one",
                    "title": "Team plan",
                    "status": "planned",
                    "groups": [{
                        "groupId": "group:one",
                        "title": "Primary work",
                        "taskIds": ["task:one"],
                        "join": { "requireCompleted": true, "allowFailed": false, "retryLimit": 0 }
                    }],
                    "tasks": [{
                        "taskId": "task:one",
                        "roleId": "role:one",
                        "title": "Primary task",
                        "prompt": "Do the work",
                        "dependsOnTaskIds": [],
                        "outputArtifactKind": null
                    }],
                    "idempotencyKey": "plan:one",
                    "createdAt": 1
                },
                "sourceIdentity": "teamskill:source",
                "templateRevision": 1,
            }),
            CREATE_OPERATION,
        )
        .expect("create request");
        assert!(matches!(create, Request::Create { .. }));

        let delete_team = decode_with_authorization(
            json!({
                "action": "delete",
                "teamId": "team:one",
                "idempotencyKey": "delete:one",
            }),
            DELETE_OPERATION,
        )
        .expect("team delete request");
        assert!(matches!(
            delete_team,
            Request::Delete {
                target: DeleteTarget::Team(_),
                ..
            }
        ));

        let resume = decode_with_authorization(
            json!({
                "action": "resume",
                "teamId": "team:one",
                "idempotencyKey": "resume:one",
            }),
            RESUME_OPERATION,
        )
        .expect("resume request");
        assert!(matches!(resume, Request::Resume { .. }));

        let cancel = decode_with_authorization(
            json!({
                "action": "cancel",
                "runId": "run:one",
                "idempotencyKey": "cancel:one",
            }),
            CANCEL_OPERATION,
        )
        .expect("cancel request");
        assert!(matches!(cancel, Request::Cancel { .. }));

        let delete_run = decode_with_authorization(
            json!({
                "action": "delete",
                "runId": "run:one",
                "idempotencyKey": "delete:one",
            }),
            DELETE_OPERATION,
        )
        .expect("run delete request");
        assert!(matches!(
            delete_run,
            Request::Delete {
                target: DeleteTarget::Run(_),
                ..
            }
        ));

        for malformed in [
            json!({ "action": "list", "teamId": "team:one", "packagePath": "C:/private" }),
            json!({ "action": "create", "teamId": "team:one", "runId": "run:one", "idempotencyKey": "create:one", "packagePath": "C:/private" }),
            json!({ "action": "delete", "teamId": "team:one" }),
            json!({ "action": "cancel", "runId": "run:one", "idempotencyKey": "cancel:one", "selectionId": "teamskill:v1:secret" }),
            json!({ "action": "delete", "runId": "run:\none", "idempotencyKey": "delete:one" }),
            json!({ "action": "resume", "runId": "run:one" }),
        ] {
            assert!(matches!(
                decode_with_authorization(malformed, LIST_OPERATION),
                Err(DecodeError::Invalid) | Err(DecodeError::Unauthorized)
            ));
        }
    }

    #[test]
    fn rejects_a_capability_decision_for_another_lifecycle_action() {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        assert!(matches!(
            decode(
                json!({
                    "action": "cancel",
                    "runId": "run:one",
                    "idempotencyKey": "cancel:one",
                }),
                &decision(LIST_OPERATION),
                &mut verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn create_and_delete_never_project_private_lifecycle_facts() {
        let created = Delivery::Created {
            run_id: "run:one".to_owned(),
            outcome: CreateState::Created,
        };
        assert_eq!(
            created.body(),
            json!({
                "success": true,
                "action": "create",
                "runId": "run:one",
                "outcome": "created",
            })
        );

        let deleted = Delivery::TeamDeleted {
            team_id: "team:one".to_owned(),
            outcome: TeamDeleteState::OutcomeUnknown,
        };
        assert_eq!(
            deleted.body(),
            json!({
                "success": true,
                "action": "delete",
                "teamId": "team:one",
                "outcome": "outcome_unknown",
            })
        );
    }

    #[test]
    fn cancellation_and_run_delete_never_project_private_plans() {
        let cancellation = Delivery::Cancellation {
            run_id: "run:one".to_owned(),
            state: CancellationState::Cancelling,
        };
        assert_eq!(
            cancellation.body(),
            json!({
                "success": true,
                "action": "cancel",
                "runId": "run:one",
                "state": "cancelling",
            })
        );

        let deleted = Delivery::RunDeleted {
            run_id: "run:one".to_owned(),
            state: TombstoneState::Purged,
        };
        assert_eq!(
            deleted.body(),
            json!({
                "success": true,
                "action": "delete",
                "runId": "run:one",
                "state": "purged",
            })
        );
    }

    #[test]
    fn unavailable_delivery_is_fixed_and_redacted() {
        assert_eq!(Delivery::Unavailable.status_code(), 503);
        assert_eq!(
            Delivery::Unavailable.body(),
            json!({ "success": false, "error": "Team lifecycle is unavailable" })
        );
    }

    fn decode_with_authorization(value: Value, operation: &str) -> Result<Request, DecodeError> {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        decode(value, &decision(operation), &mut verifier, 1)
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[31; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(operation: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": operation,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": "team-lifecycle-test",
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
