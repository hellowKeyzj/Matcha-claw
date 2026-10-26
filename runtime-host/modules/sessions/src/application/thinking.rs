use serde::Serialize;

use crate::state::{SessionEndpoint, SessionIdentity, SessionProvider};

pub const MAX_THINKING_LEVEL_BYTES: usize = 64;
pub const MAX_THINKING_OPTIONS: usize = 16;

pub(crate) fn valid_value(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThinkingScope {
    Agent {
        endpoint: SessionEndpoint,
        agent_id: String,
    },
    Session {
        identity: SessionIdentity,
    },
}

impl ThinkingScope {
    pub fn endpoint(&self) -> &SessionEndpoint {
        match self {
            Self::Agent { endpoint, .. } => endpoint,
            Self::Session { identity } => &identity.endpoint,
        }
    }

    pub fn agent_id(&self) -> &str {
        match self {
            Self::Agent { agent_id, .. } => agent_id,
            Self::Session { identity } => &identity.agent_id,
        }
    }

    pub fn identity(&self) -> Option<&SessionIdentity> {
        match self {
            Self::Agent { .. } => None,
            Self::Session { identity } => Some(identity),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionThinkingAction {
    Get,
    Set { level: Option<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThinkingModel {
    Selection(String),
    Native {
        model: String,
        provider: Option<String>,
        protocol: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionThinkingCommand {
    pub scope: ThinkingScope,
    pub action: SessionThinkingAction,
    pub model: Option<ThinkingModel>,
    /// Host-private transport correlation; never serialized or projected to a peer.
    trace_id: Option<String>,
}

impl SessionThinkingCommand {
    pub fn try_new(
        scope: ThinkingScope,
        action: SessionThinkingAction,
        model: Option<ThinkingModel>,
    ) -> Option<Self> {
        let command = Self {
            scope,
            action,
            model,
            trace_id: None,
        };
        command.valid().then_some(command)
    }

    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }

    pub fn runtime(&self) -> ThinkingRuntime {
        match self.scope.endpoint().provider() {
            SessionProvider::OpenClaw => ThinkingRuntime::OpenClaw,
            SessionProvider::MatchaAgent => ThinkingRuntime::MatchaAgent,
        }
    }

    pub(crate) fn valid(&self) -> bool {
        let endpoint = self.scope.endpoint();
        if endpoint != &SessionEndpoint::local(endpoint.provider())
            || !valid_value(self.scope.agent_id(), 256)
            || self.scope.identity().is_some_and(|identity| {
                identity.validate().is_err() || !valid_value(&identity.session_key, 4096)
            })
        {
            return false;
        }
        match &self.action {
            SessionThinkingAction::Get => self.model.as_ref().is_none_or(|model| match model {
                ThinkingModel::Selection(id) => valid_value(id, 4096),
                ThinkingModel::Native {
                    model,
                    provider,
                    protocol,
                } => {
                    valid_value(model, 4096)
                        && provider
                            .as_deref()
                            .is_none_or(|value| valid_value(value, 4096))
                        && protocol
                            .as_deref()
                            .is_none_or(|value| valid_value(value, 128))
                }
            }),
            SessionThinkingAction::Set { level } => {
                self.scope.identity().is_some()
                    && self.model.is_none()
                    && level
                        .as_deref()
                        .is_none_or(|value| valid_value(value, MAX_THINKING_LEVEL_BYTES))
            }
        }
    }

    pub(crate) fn validate_outcome(
        &self,
        outcome: SessionThinkingOutcome,
    ) -> SessionThinkingOutcome {
        let runtime = self.runtime();
        let valid = match &outcome {
            SessionThinkingOutcome::Available(snapshot) => {
                matches!(self.action, SessionThinkingAction::Get)
                    && snapshot.runtime == runtime
                    && snapshot.valid()
            }
            SessionThinkingOutcome::Confirmed { snapshot, .. } => {
                matches!(&self.action, SessionThinkingAction::Set { level } if level == &snapshot.level)
                    && snapshot.runtime == runtime
                    && snapshot.valid()
            }
            SessionThinkingOutcome::Unsupported(received)
            | SessionThinkingOutcome::Unavailable(received)
            | SessionThinkingOutcome::Rejected(received)
            | SessionThinkingOutcome::Unknown(received) => *received == runtime,
        };
        if valid {
            outcome
        } else {
            crate::trace::log("runtime.thinking.readback-invalid", self.trace_id(), || {
                serde_json::json!({ "runtime": runtime, "reason": "invalid_readback" })
            });
            SessionThinkingOutcome::Unknown(runtime)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThinkingRuntime {
    #[serde(rename = "openclaw")]
    OpenClaw,
    MatchaAgent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionThinkingSnapshot {
    pub runtime: ThinkingRuntime,
    pub level: Option<String>,
    pub effective_level: Option<String>,
    pub options: Vec<String>,
}

impl SessionThinkingSnapshot {
    fn valid(&self) -> bool {
        self.level
            .as_deref()
            .is_none_or(|value| valid_value(value, MAX_THINKING_LEVEL_BYTES))
            && self
                .effective_level
                .as_deref()
                .is_none_or(|value| valid_value(value, MAX_THINKING_LEVEL_BYTES))
            && self.options.len() <= MAX_THINKING_OPTIONS
            && self.options.iter().enumerate().all(|(index, option)| {
                valid_value(option, MAX_THINKING_LEVEL_BYTES)
                    && !self.options[..index].contains(option)
            })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionThinkingOutcome {
    Available(SessionThinkingSnapshot),
    Confirmed {
        snapshot: SessionThinkingSnapshot,
        applied: bool,
    },
    Unsupported(ThinkingRuntime),
    Unavailable(ThinkingRuntime),
    Rejected(ThinkingRuntime),
    Unknown(ThinkingRuntime),
}
