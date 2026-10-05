use serde_json::{Value, json};
use sessions_module::goal::{SessionGoalAction, SessionGoalCommand, SessionGoalMutation, SessionGoalReceipt, SessionGoalView};

use crate::gateway::wire::{GatewayEvent, GatewayResponse};
use super::protocol::ProtocolError;

pub(crate) const START_CAPABILITY: &str = "session-goal-start-v1";

pub(crate) fn mutation_params(command: &SessionGoalCommand) -> (&'static str, Value) {
    let mut params = json!({
        "sessionKey": command.identity.session_key,
        "agentId": command.identity.agent_id,
        "sessionId": command.endpoint_session_id,
        "goalId": command.goal_id,
        "operationId": command.operation_id,
        "issuedAtMs": command.issued_at_ms,
    });
    let action = action(&command.mutation);
    if action == SessionGoalAction::Clear { return ("sessions.goal.clear", params); }
    params["action"] = json!(action);
    match &command.mutation {
        SessionGoalMutation::Edit { objective } => params["objective"] = json!(objective),
        SessionGoalMutation::Pause { note } | SessionGoalMutation::Resume { note }
        | SessionGoalMutation::Complete { note } | SessionGoalMutation::Block { note } => {
            if let Some(note) = note { params["note"] = json!(note); }
        }
        SessionGoalMutation::Clear => {}
    }
    ("sessions.goal.update", params)
}

pub(crate) fn action(mutation: &SessionGoalMutation) -> SessionGoalAction {
    match mutation {
        SessionGoalMutation::Edit { .. } => SessionGoalAction::Edit,
        SessionGoalMutation::Pause { .. } => SessionGoalAction::Pause,
        SessionGoalMutation::Resume { .. } => SessionGoalAction::Resume,
        SessionGoalMutation::Complete { .. } => SessionGoalAction::Complete,
        SessionGoalMutation::Block { .. } => SessionGoalAction::Block,
        SessionGoalMutation::Clear => SessionGoalAction::Clear,
    }
}

pub(crate) fn decode_receipt(id: &str, response: GatewayResponse) -> Result<SessionGoalReceipt, ProtocolError> {
    if response.request_id() != id { return Err(ProtocolError::MismatchedResponse); }
    match response {
        GatewayResponse::Success { payload: Some(mut payload), .. } => {
            // chat.send also returns admission fields; they are not Goal receipt facts.
            let object = payload.as_object_mut().ok_or(ProtocolError::InvalidSessionGoalResult)?;
            object.retain(|key, _| matches!(key.as_str(), "operationId" | "action" | "sessionId" | "goalId" | "goal" | "runId" | "replayed" | "status"));
            let receipt: SessionGoalReceipt = serde_json::from_value(payload).map_err(|_| ProtocolError::InvalidSessionGoalResult)?;
            receipt.validate().map_err(|_| ProtocolError::InvalidSessionGoalResult)?;
            Ok(receipt)
        }
        GatewayResponse::Failure { .. } => Err(ProtocolError::Rejected),
        _ => Err(ProtocolError::InvalidSessionGoalResult),
    }
}

pub(crate) fn view(row: &Value) -> Result<SessionGoalView, ProtocolError> {
    match row.get("goal") {
        None => Ok(SessionGoalView::Unknown),
        Some(goal) => {
            let goal = serde_json::from_value(goal.clone()).map_err(|_| ProtocolError::InvalidSessionGoalResult)?;
            let view = SessionGoalView::Known { goal };
            view.validate().map_err(|_| ProtocolError::InvalidSessionGoalResult)?;
            Ok(view)
        }
    }
}

pub(crate) fn changed(event: &GatewayEvent) -> Result<Option<(&str, &str, &str, SessionGoalView)>, ProtocolError> {
    if event.name != "sessions.changed" { return Ok(None); }
    let Some(payload) = event.payload.as_ref() else { return Ok(None); };
    if payload.get("goal").is_none() { return Ok(None); }
    let text = |key| payload.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
    let key = text("sessionKey").ok_or(ProtocolError::InvalidSessionEvent)?;
    let agent = text("agentId").ok_or(ProtocolError::InvalidSessionEvent)?;
    let session = text("sessionId").ok_or(ProtocolError::InvalidSessionEvent)?;
    Ok(Some((key, agent, session, view(payload)?)))
}
