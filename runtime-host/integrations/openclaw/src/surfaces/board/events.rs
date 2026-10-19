use ::board::{
    BoardChangedEvent, BoardCommand, BoardCommandEvent, BoardEvent, BoardFailure, BoardIdentity,
};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::Deserialize;

use super::identity::{
    MAX_SAFE_INTEGER, is_widget_name, observer_key, validate_endpoint, validate_identity,
};
use crate::{gateway::wire::GatewayEvent, session::protocol::AgentScopedSessionKey};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Changed {
    session_key: String,
    revision: u64,
    widget: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    session_key: String,
    agent_id: Option<String>,
    command: BoardCommand,
}

pub(crate) fn decode_event(
    endpoint: &RuntimeEndpoint,
    event: &GatewayEvent,
) -> Result<Option<BoardEvent>, BoardFailure> {
    match event.name.as_str() {
        "board.changed" => {
            validate_endpoint(endpoint)?;
            let changed: Changed =
                serde_json::from_value(event.payload.clone().ok_or(BoardFailure::Invalid)?)
                    .map_err(|_| BoardFailure::Invalid)?;
            if changed.revision > MAX_SAFE_INTEGER
                || changed
                    .widget
                    .as_ref()
                    .is_some_and(|name| !is_widget_name(name))
            {
                return Err(BoardFailure::Invalid);
            }
            Ok(Some(BoardEvent::Changed(BoardChangedEvent {
                identity: event_identity(endpoint, &changed.session_key, None)?,
                revision: changed.revision,
                widget: changed.widget,
            })))
        }
        "board.command" => {
            validate_endpoint(endpoint)?;
            let command: Command =
                serde_json::from_value(event.payload.clone().ok_or(BoardFailure::Invalid)?)
                    .map_err(|_| BoardFailure::Invalid)?;
            if let BoardCommand::FocusTab { tab_id } = &command.command {
                if tab_id.is_empty()
                    || tab_id.len() > 40
                    || !tab_id.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
                {
                    return Err(BoardFailure::Invalid);
                }
            }
            Ok(Some(BoardEvent::Command(BoardCommandEvent {
                identity: event_identity(
                    endpoint,
                    &command.session_key,
                    command.agent_id.as_deref(),
                )?,
                command: command.command,
            })))
        }
        _ => Ok(None),
    }
}

fn event_identity(
    endpoint: &RuntimeEndpoint,
    session_key: &str,
    agent_id: Option<&str>,
) -> Result<BoardIdentity, BoardFailure> {
    let scoped = match agent_id {
        Some(agent_id) => observer_key(session_key, agent_id)?,
        None => session_key.to_owned(),
    };
    let key = AgentScopedSessionKey::try_parse(&scoped).map_err(|_| BoardFailure::Invalid)?;
    if key.as_str() != scoped || agent_id.is_some_and(|agent_id| agent_id != key.agent_id()) {
        return Err(BoardFailure::Invalid);
    }
    let identity = BoardIdentity::try_new(endpoint.clone(), key.agent_id(), key.as_str())
        .map_err(|_| BoardFailure::Invalid)?;
    validate_identity(endpoint, &identity)?;
    Ok(identity)
}
