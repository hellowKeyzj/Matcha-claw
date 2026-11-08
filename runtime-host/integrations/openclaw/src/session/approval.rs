use serde_json::Value;
use sessions_module::{
    approval::{
        PendingApproval, PendingApprovals, PendingApprovalsCommand, PendingApprovalsOutcome,
        SessionApprovalCommand, SessionApprovalOutcome,
    },
    endpoint::NativeEndpoint,
    state::{ApprovalDetails, ApprovalPhase, ApprovalText, ApprovalView, SessionIdentity},
};

use super::{
    OperationError, SessionOperation, next_request_id,
    protocol::{
        ApprovalId, ApprovalOptionId, ProtocolError, RunId, SessionApprovalEvent,
        SessionApprovalLifecycle, SessionApprovalSource, SessionKey,
    },
    request,
};
use crate::gateway::{delivery::MutationDelivery, wire::GatewayResponse};

pub(crate) fn decode_presentation(mut value: Value) -> Result<ApprovalDetails, ProtocolError> {
    let invalid = ProtocolError::InvalidSessionEvent;
    let object = value.as_object_mut().ok_or(invalid)?;
    let text_fields: &[(&str, bool, bool)] = match object.get("kind").and_then(Value::as_str) {
        Some("exec") => &[
            ("commandText", true, false),
            ("commandPreview", false, true),
            ("warningText", false, true),
            ("host", false, true),
            ("nodeId", true, true),
            ("agentId", true, true),
        ],
        Some("plugin") => &[
            ("title", true, false),
            ("description", true, false),
            ("detail", true, false),
            ("pluginId", true, true),
            ("toolName", true, true),
            ("agentId", true, true),
        ],
        Some("system-agent") => &[
            ("title", true, false),
            ("description", true, false),
            ("agentId", true, true),
        ],
        _ => return Err(invalid),
    };
    for &(field, nonempty, nullable) in text_fields {
        if let Some(value) = object.get_mut(field) {
            if nullable && value.is_null() {
                continue;
            }
            project_text(value, nonempty)?;
        }
    }
    if let Some(scope) = object.get_mut("scope") {
        let scope = scope.as_object_mut().ok_or(invalid)?;
        let fields: &[&str] = match scope.get("kind").and_then(Value::as_str) {
            Some("message-send" | "external-post") => &["target"],
            Some("payment") => &["amount", "currency", "target"],
            Some("standing-grant") => &["automation", "command"],
            _ => return Err(invalid),
        };
        for field in fields {
            project_text(scope.get_mut(*field).ok_or(invalid)?, true)?;
        }
        if let Some(recipients) = scope.get_mut("recipients") {
            for recipient in recipients.as_array_mut().ok_or(invalid)? {
                project_text(recipient, true)?;
            }
        }
    }
    if let Some(external) = object.get_mut("externalResolution") {
        project_text(external.get_mut("label").ok_or(invalid)?, true)?;
    }
    let details: ApprovalDetails = serde_json::from_value(value).map_err(|_| invalid)?;
    details.validate().map_err(|_| invalid)?;
    Ok(details)
}

fn project_text(value: &mut Value, nonempty: bool) -> Result<(), ProtocolError> {
    let invalid = ProtocolError::InvalidSessionEvent;
    let text = value
        .as_str()
        .filter(|text| !nonempty || !text.is_empty())
        .ok_or(invalid)?;
    *value = serde_json::to_value(ApprovalText::try_from_text(text).map_err(|_| invalid)?)
        .map_err(|_| invalid)?;
    Ok(())
}

pub(crate) fn option_ids(details: &ApprovalDetails) -> Vec<ApprovalOptionId> {
    let decisions = match details {
        ApprovalDetails::Exec {
            allowed_decisions, ..
        }
        | ApprovalDetails::Plugin {
            allowed_decisions, ..
        }
        | ApprovalDetails::SystemAgent {
            allowed_decisions, ..
        } => allowed_decisions,
        ApprovalDetails::Tool { .. } => unreachable!("native approval presentation"),
    };
    decisions
        .iter()
        .map(|decision| {
            let id = match decision {
                sessions_module::state::ApprovalDecision::AllowOnce => "allow-once",
                sessions_module::state::ApprovalDecision::AllowAlways => "allow-always",
                sessions_module::state::ApprovalDecision::Deny => "deny",
            };
            ApprovalOptionId::try_new(id.to_owned()).expect("native decision is nonempty")
        })
        .collect()
}

pub(crate) fn view(
    id: &ApprovalId,
    run: Option<&RunId>,
    phase: ApprovalPhase,
    options: &[ApprovalOptionId],
    details: &ApprovalDetails,
) -> ApprovalView {
    ApprovalView {
        approval_id: id.as_str().to_owned(),
        run_id: run.map(|run| run.as_str().to_owned()),
        phase,
        option_ids: options.iter().map(|id| id.as_str().to_owned()).collect(),
        details: Some(details.clone()),
    }
}

pub(crate) fn event_view(approval: &SessionApprovalEvent) -> ApprovalView {
    view(
        &approval.approval_id,
        approval.run_id.as_ref(),
        if approval.lifecycle == SessionApprovalLifecycle::Requested {
            ApprovalPhase::Requested
        } else {
            ApprovalPhase::Resolved
        },
        &approval.option_ids,
        &approval.details,
    )
}

pub(crate) fn kind(source: SessionApprovalSource) -> &'static str {
    match source {
        SessionApprovalSource::Exec => "exec",
        SessionApprovalSource::Plugin => "plugin",
        SessionApprovalSource::SystemAgent => "system-agent",
    }
}

pub(crate) fn decode_snapshot(
    snapshot: Value,
    session_key: SessionKey,
) -> Result<SessionApprovalEvent, ProtocolError> {
    let invalid = ProtocolError::InvalidSessionEvent;
    let object = snapshot.as_object().ok_or(invalid)?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && !matches!(*id, "." | ".."))
        .ok_or(invalid)?;
    let details = decode_presentation(object.get("presentation").cloned().ok_or(invalid)?)?;
    let source = match &details {
        ApprovalDetails::Exec { .. } => SessionApprovalSource::Exec,
        ApprovalDetails::Plugin { .. } => SessionApprovalSource::Plugin,
        ApprovalDetails::SystemAgent { .. } => SessionApprovalSource::SystemAgent,
        _ => return Err(invalid),
    };
    let lifecycle = match object.get("status").and_then(Value::as_str) {
        Some("pending") => SessionApprovalLifecycle::Requested,
        Some("allowed" | "denied" | "expired" | "cancelled") => SessionApprovalLifecycle::Resolved,
        _ => return Err(invalid),
    };
    Ok(SessionApprovalEvent {
        source,
        lifecycle,
        approval_id: ApprovalId::try_new(id.to_owned()).map_err(|_| invalid)?,
        session_key,
        run_id: None,
        option_ids: option_ids(&details),
        details,
    })
}

pub(crate) struct ObservedApprovals {
    pub(crate) generation: u64,
    pub(crate) epoch: u64,
    pub(crate) approvals: Vec<ApprovalView>,
}

impl SessionOperation {
    async fn validate_approval_identity(
        &self,
        endpoint: NativeEndpoint,
        identity: &SessionIdentity,
        session_id: &str,
    ) -> Result<SessionKey, OperationError> {
        if endpoint != NativeEndpoint::OpenClawLocal
            || crate::port::validate_observation_identity(identity).is_err()
        {
            return Err(OperationError::Rejected);
        }
        let key = SessionKey::try_new(identity.session_key.clone())
            .map_err(|_| OperationError::Rejected)?;
        let row = self
            .describe_session(super::protocol::SessionDescribeParams::new(
                key.clone(),
                Some(&identity.agent_id),
            ))
            .await?
            .ok_or(OperationError::Rejected)?;
        if row.key.as_deref() != Some(identity.session_key.as_str())
            || row.agent_id.as_ref().map(|id| id.as_str()) != Some(identity.agent_id.as_str())
            || row.session_id.as_deref() != Some(session_id)
        {
            return Err(OperationError::Rejected);
        }
        Ok(key)
    }

    pub(crate) async fn pending_approvals(
        &self,
        command: PendingApprovalsCommand,
    ) -> PendingApprovalsOutcome {
        let _native = self
            .gateway
            .observations
            .lock_native(&command.identity)
            .await;
        if let Err(error) = self
            .validate_approval_identity(command.endpoint, &command.identity, &command.session_id)
            .await
        {
            return if rejected(&error) {
                PendingApprovalsOutcome::Rejected
            } else {
                PendingApprovalsOutcome::Unavailable
            };
        }
        match self
            .gateway
            .pending_session_approvals(&command.identity, &command.session_id)
            .await
        {
            Ok(observed) => PendingApprovalsOutcome::Found(PendingApprovals {
                approvals: observed
                    .approvals
                    .into_iter()
                    .map(|approval| PendingApproval {
                        approval_id: approval.approval_id,
                        option_ids: approval.option_ids,
                        details: approval.details,
                    })
                    .collect(),
            }),
            Err(sessions_module::ports::RuntimeOperationFailure::TargetRejected) => {
                PendingApprovalsOutcome::Rejected
            }
            Err(_) => PendingApprovalsOutcome::Unavailable,
        }
    }

    pub(crate) async fn respond_to_approval(
        &self,
        command: SessionApprovalCommand,
    ) -> SessionApprovalOutcome {
        use SessionApprovalOutcome as Outcome;
        let _native = self
            .gateway
            .observations
            .lock_native(&command.identity)
            .await;
        let key = match self
            .validate_approval_identity(command.endpoint, &command.identity, &command.session_id)
            .await
        {
            Ok(key) => key,
            Err(error) => {
                return if rejected(&error) {
                    Outcome::Rejected
                } else {
                    Outcome::Unavailable
                };
            }
        };
        let observed = match self
            .gateway
            .pending_session_approvals(&command.identity, &command.session_id)
            .await
        {
            Ok(observed) => observed,
            Err(sessions_module::ports::RuntimeOperationFailure::TargetRejected) => {
                return Outcome::Rejected;
            }
            Err(_) => return Outcome::Unavailable,
        };
        let Some(pending) = observed
            .approvals
            .iter()
            .find(|approval| approval.approval_id == command.approval_id)
        else {
            return Outcome::Rejected;
        };
        if !pending.option_ids.contains(&command.option_id) {
            return Outcome::Rejected;
        }
        let approval = match self.get_approval(&command.approval_id, key.clone()).await {
            Ok(approval) => approval,
            Err(error) => {
                return if rejected(&error) {
                    Outcome::Rejected
                } else {
                    Outcome::Unavailable
                };
            }
        };
        if approval.approval_id.as_str() != command.approval_id
            || approval.lifecycle != SessionApprovalLifecycle::Requested
            || !approval
                .option_ids
                .iter()
                .any(|id| id.as_str() == command.option_id)
            || pending.details.as_ref() != Some(&approval.details)
        {
            return Outcome::Rejected;
        }
        let Ok(id) = next_request_id("approval-resolve") else {
            return Outcome::Unavailable;
        };
        let Ok(request) = request(
            &id,
            "approval.resolve",
            serde_json::json!({
                "id": command.approval_id, "kind": kind(approval.source), "decision": command.option_id,
            }),
        ) else {
            return Outcome::Rejected;
        };
        let delivery = match self
            .gateway
            .resolve_observed_approval(
                &command.identity,
                &command.session_id,
                &observed,
                pending,
                request,
            )
            .await
        {
            Ok(delivery) => delivery,
            Err(_) => return Outcome::Unavailable,
        };
        let result = match delivery {
            MutationDelivery::NotWritten(_) => return Outcome::Unavailable,
            MutationDelivery::MayHaveReached(_) => return Outcome::Unknown,
            MutationDelivery::Response(response) => match approval_payload(&id, response) {
                Ok(result) => result,
                Err(error) => {
                    return if rejected(&error) {
                        Outcome::Rejected
                    } else if error
                        .gateway_rejection()
                        .is_some_and(|(code, _)| code == "UNAVAILABLE")
                    {
                        Outcome::Unavailable
                    } else {
                        Outcome::Unknown
                    };
                }
            },
        };
        let Some(applied) = result.get("applied").and_then(Value::as_bool) else {
            return Outcome::Unknown;
        };
        let Some(snapshot) = result.get("approval") else {
            return Outcome::Unknown;
        };
        let terminal = match decode_snapshot(snapshot.clone(), key) {
            Ok(terminal) => terminal,
            Err(_) => return Outcome::Unknown,
        };
        if terminal.approval_id != approval.approval_id
            || terminal.source != approval.source
            || terminal.lifecycle != SessionApprovalLifecycle::Resolved
        {
            return Outcome::Unknown;
        }
        if !applied {
            return Outcome::Rejected;
        }
        let expected_status = if command.option_id == "deny" {
            "denied"
        } else {
            "allowed"
        };
        if snapshot.get("status").and_then(Value::as_str) != Some(expected_status)
            || snapshot.get("decision").and_then(Value::as_str) != Some(command.option_id.as_str())
        {
            return Outcome::Unknown;
        }
        Outcome::Responded
    }

    async fn get_approval(
        &self,
        approval_id: &str,
        key: SessionKey,
    ) -> Result<SessionApprovalEvent, OperationError> {
        let id = next_request_id("approval-get")?;
        let request = request(
            &id,
            "approval.get",
            serde_json::json!({ "id": approval_id }),
        )?;
        let result = approval_payload(&id, self.gateway.rpc_query(request).await?)?;
        decode_snapshot(
            result
                .get("approval")
                .cloned()
                .ok_or(OperationError::Protocol)?,
            key,
        )
        .map_err(Into::into)
    }
}

fn approval_payload(id: &str, response: GatewayResponse) -> Result<Value, OperationError> {
    if response.request_id() != id {
        return Err(OperationError::UnknownResponse);
    }
    match response {
        GatewayResponse::Success {
            payload: Some(payload),
            ..
        } => Ok(payload),
        GatewayResponse::Failure { error, .. } => Err(OperationError::gateway_rejected(error)),
        _ => Err(OperationError::Protocol),
    }
}

fn rejected(error: &OperationError) -> bool {
    matches!(error, OperationError::Rejected)
        || error
            .gateway_rejection()
            .is_some_and(|(code, _)| code == "INVALID_REQUEST")
}
