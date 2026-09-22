use crate as fleet;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::owner::handle::FleetHandle;
const TERMINAL_WEBSOCKET_PATH: &str = "/api/remote-fleet/terminal/stream";
use fleet::topology::{NodeId, RuntimeId};
use platform::endpoint::EndpointId;

use super::projection::{Delivery, snapshot_session_status_name, timestamp};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TerminalOpenPayload {
    #[serde(default, deserialize_with = "deserialize_optional_identifier")]
    pub(super) node_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_identifier")]
    pub(super) runtime_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_identifier")]
    pub(super) endpoint_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_terminal_size")]
    pub(super) size: Option<TerminalSizePayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TerminalSizePayload {
    pub(super) rows: u16,
    pub(super) cols: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TerminalSessionPayload {
    pub(super) session_id: String,
}

fn deserialize_optional_identifier<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Value::deserialize(deserializer)? {
        Value::String(value) => Ok(Some(value)),
        Value::Null => Err(serde::de::Error::custom(
            "terminal selector must not be null",
        )),
        _ => Err(serde::de::Error::custom(
            "terminal selector must be a string",
        )),
    }
}

fn deserialize_optional_terminal_size<'de, D>(
    deserializer: D,
) -> Result<Option<TerminalSizePayload>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("terminal size must not be null"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn parse_terminal_open(
    payload: TerminalOpenPayload,
) -> Result<
    (
        crate::owner::actor::FleetTerminalTargetSelector,
        fleet::terminal::Dimensions,
    ),
    (),
> {
    let selector = match (payload.node_id, payload.runtime_id, payload.endpoint_id) {
        (Some(node_id), None, None) => crate::owner::actor::FleetTerminalTargetSelector::Node(
            NodeId::try_new(node_id).map_err(|_| ())?,
        ),
        (None, Some(runtime_id), None) => {
            crate::owner::actor::FleetTerminalTargetSelector::Runtime(
                RuntimeId::try_new(runtime_id).map_err(|_| ())?,
            )
        }
        (None, None, Some(endpoint_id)) => {
            crate::owner::actor::FleetTerminalTargetSelector::Endpoint(
                EndpointId::try_new(endpoint_id).map_err(|_| ())?,
            )
        }
        _ => return Err(()),
    };
    let dimensions = payload
        .size
        .map_or_else(
            || fleet::terminal::Dimensions::try_new(24, 80),
            |size| fleet::terminal::Dimensions::try_new(size.rows, size.cols),
        )
        .map_err(|_| ())?;
    Ok((selector, dimensions))
}

pub(super) async fn terminal_open_delivery(
    owner: &FleetHandle,
    payload: TerminalOpenPayload,
) -> Delivery {
    let (selector, dimensions) = match parse_terminal_open(payload) {
        Ok(value) => value,
        Err(()) => return Delivery::Invalid,
    };
    match owner.terminal_open_allocated(selector, dimensions).await {
        Err(_) => Delivery::Unavailable,
        Ok(Err(_)) => Delivery::Invalid,
        Ok(Ok(opened)) => Delivery::Mutation(terminal_session_json(
            "terminalOpened",
            &opened.opened,
            &opened.context,
        )),
    }
}

pub(super) async fn terminal_reconnect_delivery(
    owner: &FleetHandle,
    payload: TerminalSessionPayload,
) -> Delivery {
    let session = match fleet::terminal::SessionId::try_new(payload.session_id) {
        Ok(session) => session,
        Err(_) => return Delivery::Invalid,
    };
    let opened = match owner.terminal_reconnect(session).await {
        Err(_) => return Delivery::Unavailable,
        Ok(Err(_)) => return Delivery::Invalid,
        Ok(Ok(opened)) => opened,
    };
    let context = match owner.terminal_context(opened.session.clone()).await {
        Err(_) | Ok(Err(_)) => {
            let _ = owner
                .terminal_close_fenced(opened.session.id().clone(), opened.session.generation())
                .await;
            return Delivery::Unavailable;
        }
        Ok(Ok(None)) => {
            let _ = owner
                .terminal_close_fenced(opened.session.id().clone(), opened.session.generation())
                .await;
            return Delivery::Invalid;
        }
        Ok(Ok(Some(context))) => context,
    };
    Delivery::Mutation(terminal_session_json(
        "terminalReconnected",
        &opened,
        &context,
    ))
}

pub(super) fn terminal_session_json(
    outcome: &str,
    opened: &fleet::terminal::OpenedSession,
    context: &crate::application::terminal::TerminalContext,
) -> Value {
    json!({
        "outcome": outcome,
        "session": {
            "id": opened.session.id().as_str(),
            "nodeId": context.node.as_str(),
            "endpointId": context.endpoint.as_str(),
            "status": snapshot_session_status_name(opened.session.status()),
            "createdAt": timestamp(opened.session.created_at()),
            "updatedAt": timestamp(opened.session.updated_at()),
            "expiresAt": timestamp(opened.session.expires_at()),
        },
        "terminalConnection": {
            "sessionId": opened.session.id().as_str(),
            "ticket": base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(opened.ticket.as_bytes()),
            "websocketPath": TERMINAL_WEBSOCKET_PATH,
            "expiresAt": timestamp(opened.session.expires_at()),
        },
    })
}

pub(super) async fn terminal_begin_close_delivery(
    owner: &FleetHandle,
    payload: TerminalSessionPayload,
) -> Delivery {
    let session = match fleet::terminal::SessionId::try_new(payload.session_id) {
        Ok(session) => session,
        Err(_) => return Delivery::Invalid,
    };
    owner
        .terminal_begin_close(session)
        .await
        .map_or(Delivery::Unavailable, |result| {
            result.map_or(Delivery::Invalid, |_| {
                Delivery::Mutation(json!({"outcome":"terminalClosing"}))
            })
        })
}

pub(super) async fn terminal_finish_close_delivery(
    owner: &FleetHandle,
    payload: TerminalSessionPayload,
) -> Delivery {
    let session = match fleet::terminal::SessionId::try_new(payload.session_id) {
        Ok(session) => session,
        Err(_) => return Delivery::Invalid,
    };
    owner
        .terminal_finish_close(session)
        .await
        .map_or(Delivery::Unavailable, |result| {
            result.map_or(Delivery::Invalid, |_| {
                Delivery::Mutation(json!({"outcome":"terminalClosed"}))
            })
        })
}

pub(super) async fn terminal_close_delivery(
    owner: &FleetHandle,
    payload: TerminalSessionPayload,
) -> Delivery {
    let session = match fleet::terminal::SessionId::try_new(payload.session_id) {
        Ok(session) => session,
        Err(_) => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .terminal_close(session)
        .await
        .map_or(Delivery::Unavailable, |result| {
            result.map_or(Delivery::Mutation(json!({"outcome":"error"})), |_| {
                Delivery::Mutation(json!({"outcome":"terminalClosed"}))
            })
        })
}

fn terminal_list_session_status_name(status: fleet::terminal::SessionStatus) -> &'static str {
    match status {
        fleet::terminal::SessionStatus::Opening => "Opening",
        fleet::terminal::SessionStatus::Connected => "Connected",
        fleet::terminal::SessionStatus::Closing => "Closing",
        fleet::terminal::SessionStatus::Closed => "Closed",
        fleet::terminal::SessionStatus::Failed => "Failed",
        fleet::terminal::SessionStatus::Expired => "Expired",
    }
}

pub(super) async fn terminal_list_delivery(owner: &FleetHandle) -> Delivery {
    owner
        .terminal_list()
        .await
        .map(|sessions| {
            Delivery::Mutation(json!({
                "sessions": sessions
                    .iter()
                    .map(|session| json!({
                        "id": session.id().as_str(),
                        "targetId": session.target().as_str(),
                        "provider": session.provider().as_str(),
                        "generation": session.generation().get(),
                        "status": terminal_list_session_status_name(session.status()),
                        "expiresAt": timestamp(session.expires_at()),
                    }))
                    .collect::<Vec<_>>()
            }))
        })
        .map_or(Delivery::Unavailable, |delivery| delivery)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::terminal::{
        Dimensions, ProviderId, SessionId, TargetId as TerminalTargetId, TerminalSessionOwner,
    };
    use platform::endpoint::EndpointId;

    #[test]
    fn terminal_close_delivery_is_sealed_and_uses_public_failures() {
        let success = Delivery::Mutation(json!({"outcome":"terminalClosed"}));
        assert_eq!(success.status_code(), 200);
        assert_eq!(success.body(), json!({"outcome":"terminalClosed"}));

        let failure = Delivery::Mutation(json!({"outcome":"error"}));
        assert_eq!(failure.status_code(), 200);
        assert_eq!(failure.body(), json!({"outcome":"error"}));

        let unavailable = Delivery::Unavailable;
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(
            unavailable.body(),
            json!({"success":false,"error":"Fleet data is unavailable"})
        );
    }

    #[test]
    fn terminal_session_projection_uses_public_websocket_path() {
        let mut owner = TerminalSessionOwner::default();
        let opened = owner
            .open(
                SessionId::try_new("session-1").unwrap(),
                TerminalTargetId::try_new("target-1").unwrap(),
                ProviderId::try_new("docker").unwrap(),
                Dimensions::try_new(24, 80).unwrap(),
                SystemTime::UNIX_EPOCH + Duration::from_secs(1),
            )
            .unwrap();
        let context = crate::application::terminal::TerminalContext {
            session: opened.session.id().clone(),
            target: opened.session.target().clone(),
            provider: opened.session.provider().clone(),
            generation: opened.session.generation(),
            node: NodeId::try_new("node-1").unwrap(),
            endpoint: EndpointId::try_new("endpoint-1").unwrap(),
            rows: 24,
            cols: 80,
        };

        let value = terminal_session_json("terminalOpened", &opened, &context);

        assert_eq!(
            value["terminalConnection"]["websocketPath"],
            json!(TERMINAL_WEBSOCKET_PATH)
        );
        for forbidden in ["targetId", "provider", "dimensions", "generation", "ticket"] {
            assert!(
                !value["session"]
                    .as_object()
                    .unwrap()
                    .contains_key(forbidden)
            );
        }
    }
}
