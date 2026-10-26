use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::{capability::CapabilityDecisionVerifier, loopback};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    state::{SessionEndpoint, SessionIdentity},
    thinking::{
        SessionThinkingAction, SessionThinkingCommand, SessionThinkingOutcome,
        SessionThinkingSnapshot, ThinkingModel, ThinkingRuntime, ThinkingScope,
    },
};

pub(super) const PATH: &str = "/api/sessions/thinking";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    operation_id: String,
    scope: Address,
    target: Address,
    input: Value,
}

#[derive(Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Address {
    Agent {
        endpoint: SessionEndpoint,
        agent_id: String,
    },
    Session {
        identity: SessionIdentity,
    },
}

impl Request {
    fn into_command(self) -> Option<SessionThinkingCommand> {
        if self.id != "session.thinking" || self.scope != self.target {
            return None;
        }
        let input = self.input.as_object()?;
        let (action, model) = match self.operation_id.as_str() {
            "sessions.thinking.get" => {
                if input.len() > 1 || input.keys().any(|key| key != "modelSelectionId") {
                    return None;
                }
                let model = match input.get("modelSelectionId") {
                    Some(value) => Some(ThinkingModel::Selection(value.as_str()?.to_owned())),
                    None => None,
                };
                (SessionThinkingAction::Get, model)
            }
            "sessions.thinking.set" => {
                if input.len() != 1 {
                    return None;
                }
                let level = match input.get("level")? {
                    Value::Null => None,
                    Value::String(level) => Some(level.clone()),
                    _ => return None,
                };
                (SessionThinkingAction::Set { level }, None)
            }
            _ => return None,
        };
        let scope = match self.scope {
            Address::Agent { endpoint, agent_id } => ThinkingScope::Agent { endpoint, agent_id },
            Address::Session { identity } => ThinkingScope::Session { identity },
        };
        SessionThinkingCommand::try_new(scope, action, model)
    }
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
enum Delivery {
    Available {
        #[serde(flatten)]
        snapshot: SessionThinkingSnapshot,
    },
    Confirmed {
        #[serde(flatten)]
        snapshot: SessionThinkingSnapshot,
        persisted: bool,
        applied: bool,
    },
    Unsupported {
        runtime: ThinkingRuntime,
    },
    Unavailable {
        runtime: ThinkingRuntime,
    },
    Rejected {
        runtime: ThinkingRuntime,
    },
    Unknown {
        runtime: ThinkingRuntime,
    },
}

impl From<SessionThinkingOutcome> for Delivery {
    fn from(outcome: SessionThinkingOutcome) -> Self {
        match outcome {
            SessionThinkingOutcome::Available(snapshot) => Self::Available { snapshot },
            SessionThinkingOutcome::Confirmed { snapshot, applied } => Self::Confirmed {
                snapshot,
                persisted: true,
                applied,
            },
            SessionThinkingOutcome::Unsupported(runtime) => Self::Unsupported { runtime },
            SessionThinkingOutcome::Unavailable(runtime) => Self::Unavailable { runtime },
            SessionThinkingOutcome::Rejected(runtime) => Self::Rejected { runtime },
            SessionThinkingOutcome::Unknown(runtime) => Self::Unknown { runtime },
        }
    }
}

pub(super) async fn handle(
    request: &loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    session: crate::SessionHandle,
) -> loopback::Response {
    let trace_id = crate::trace::trace_id(&request.head.headers);
    crate::trace::log("runtime.thinking.request", trace_id, || {
        serde_json::json!({ "method": "POST" })
    });
    let invalid = || {
        crate::trace::log("runtime.thinking.failed", trace_id, || {
            serde_json::json!({ "reason": "invalid_command" })
        });
        loopback::Response::error(400, "Session thinking request is invalid")
    };
    let unauthorized = || {
        crate::trace::log("runtime.thinking.failed", trace_id, || {
            serde_json::json!({ "reason": "authorization_invalid" })
        });
        loopback::Response::error(401, "Session thinking authorization is invalid")
    };
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
    };
    let Ok(input) = serde_json::from_slice::<Request>(&request.body) else {
        return invalid();
    };
    let scope = match input.operation_id.as_str() {
        "sessions.thinking.get" => "sessions:read",
        "sessions.thinking.set" => "sessions:write",
        _ => return invalid(),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    if verifier
        .lock()
        .await
        .verify(
            authorization,
            now,
            PATH,
            scope,
            "session.thinking",
            "session-thinking",
        )
        .is_err()
    {
        return unauthorized();
    }
    let Some(command) = input.into_command() else {
        return invalid();
    };
    let command = command.with_trace_id(trace_id.map(str::to_owned));
    let runtime = command.runtime();
    let is_set = matches!(command.action, SessionThinkingAction::Set { .. });
    crate::trace::log("runtime.thinking.command", trace_id, || {
        serde_json::json!({
            "operation": if is_set { "set" } else { "get" }, "runtime": runtime,
        })
    });
    let outcome = session.session_thinking(command).await.unwrap_or_else(|_| {
        crate::trace::log("runtime.thinking.failed", trace_id, || {
            serde_json::json!({ "runtime": runtime, "reason": "owner_unavailable" })
        });
        if is_set {
            SessionThinkingOutcome::Unknown(runtime)
        } else {
            SessionThinkingOutcome::Unavailable(runtime)
        }
    });
    crate::trace::log("runtime.thinking.outcome", trace_id, || {
        serde_json::json!({
            "runtime": runtime,
            "outcome": match &outcome {
                SessionThinkingOutcome::Available(_) => "available",
                SessionThinkingOutcome::Confirmed { .. } => "confirmed",
                SessionThinkingOutcome::Unsupported(_) => "unsupported",
                SessionThinkingOutcome::Unavailable(_) => "unavailable",
                SessionThinkingOutcome::Rejected(_) => "rejected",
                SessionThinkingOutcome::Unknown(_) => "unknown",
            },
        })
    });
    loopback::Response::json(
        200,
        serde_json::to_value(Delivery::from(outcome))
            .expect("Session thinking delivery serialization"),
    )
}
