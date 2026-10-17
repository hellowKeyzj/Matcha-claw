use crate::{
    client::{Client, Delivery, Error},
    session::{model::SessionRecord, projection::parse_session_key, rpc},
};
use serde_json::{Value, json};
use sessions_module::session_permission::{
    MatchaPermissionMode, NativeEndpoint, SessionPermissionAction, SessionPermissionCommand,
    SessionPermissionOutcome as Outcome, SessionPermissionSelection,
};

pub(super) async fn apply(client: &Client, command: SessionPermissionCommand) -> Outcome {
    if command.endpoint != NativeEndpoint::MatchaAgentLocal {
        return Outcome::Rejected;
    }
    let Some((agent, id)) = parse_session_key(command.session_key()) else {
        return Outcome::Rejected;
    };
    if command.agent_id() != agent {
        return Outcome::Rejected;
    }
    let selected = match command.action() {
        SessionPermissionAction::Get => None,
        SessionPermissionAction::Set {
            selection: SessionPermissionSelection::MatchaAgent(mode),
        } => Some(mode),
        SessionPermissionAction::Set { .. } => return Outcome::Rejected,
    };
    let session = match client
        .call("sessions.get", json!({ "sessionId": id }))
        .await
    {
        Ok(session) => session,
        Err(error) => return failure(error, false),
    };
    let mode = match session_mode(session, id, agent) {
        Ok(mode) => mode,
        Err(outcome) => return outcome,
    };
    let Some(selected) = selected else {
        // The record is durable selection, not an observation of the current CLI mode.
        return Outcome::MatchaSnapshot { mode };
    };
    let receipt = match client
        .call(
            "sessions.setMode",
            json!({ "sessionId": id, "mode": selected.as_str() }),
        )
        .await
    {
        Ok(receipt) => receipt,
        Err(error) => return failure(error, true),
    };
    let Some(session) = receipt.get("session").cloned() else {
        return Outcome::Unknown;
    };
    if !matches!(session_mode(session, id, agent), Ok(Some(mode)) if mode == selected) {
        return Outcome::Unknown;
    }
    let applied = match receipt.get("applied").and_then(Value::as_bool) {
        Some(true)
            if receipt.pointer("/response/mode").and_then(Value::as_str)
                == Some(selected.as_str()) =>
        {
            true
        }
        Some(false) if receipt.get("response") == Some(&Value::Null) => false,
        _ => return Outcome::Unknown,
    };
    // Native success follows the instance fence and durable save; false applies on next launch.
    Outcome::MatchaUpdated {
        mode: selected,
        applied,
    }
}

fn session_mode(
    session: Value,
    id: &str,
    agent: &str,
) -> Result<Option<MatchaPermissionMode>, Outcome> {
    let mode = session.get("mode").cloned().ok_or(Outcome::Unknown)?;
    let record: SessionRecord = rpc::decode(session).map_err(|_| Outcome::Unknown)?;
    if !record.validate(id, Some(agent)) {
        return Err(Outcome::Unknown);
    }
    // Missing and unknown modes are invalid readback; native null is an unselected session.
    serde_json::from_value(mode).map_err(|_| Outcome::Unknown)
}

fn failure(error: Error, mutation: bool) -> Outcome {
    match error.delivery() {
        Delivery::NotSent => return Outcome::Unavailable,
        Delivery::Unknown => {
            return if mutation {
                Outcome::Unknown
            } else {
                Outcome::Unavailable
            };
        }
        Delivery::ResponseReceived => {}
    }
    let data = error.data();
    let acknowledged = data
        .and_then(|data| data.get("nativeAcknowledged"))
        .and_then(Value::as_bool);
    let delivery = data
        .and_then(|data| data.get("delivery"))
        .and_then(Value::as_str);
    if mutation
        && (acknowledged == Some(true)
            || delivery == Some("unknown")
            || error.code() == Some(-32006))
    {
        return Outcome::Unknown;
    }
    if delivery == Some("notSent") {
        return Outcome::Unavailable;
    }
    match error.code() {
        Some(-32601) => Outcome::Unsupported,
        Some(-32602 | -32001 | -32002) => Outcome::Rejected,
        Some(-32004) if error.kind() == "native_control_error" && delivery == Some("sent") => {
            Outcome::Rejected
        }
        Some(-32003) => Outcome::Unavailable,
        Some(-32005) if mutation && acknowledged == Some(false) => Outcome::Rejected,
        _ if mutation => Outcome::Unknown,
        _ => Outcome::Unavailable,
    }
}
