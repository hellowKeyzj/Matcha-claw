use platform::trace::{identifier_hash, session_trace, with_session_trace};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sessions_module::{
    state::{SessionEndpoint, SessionIdentity, SessionProvider},
    thinking::{
        MAX_THINKING_LEVEL_BYTES, MAX_THINKING_OPTIONS, SessionThinkingAction,
        SessionThinkingCommand, SessionThinkingOutcome, SessionThinkingSnapshot, ThinkingModel,
        ThinkingRuntime, ThinkingScope,
    },
};

use super::{SessionOperation, next_request_id, request};
use crate::{
    gateway::{
        delivery::MutationDelivery,
        wire::{GatewayError, GatewayResponse},
    },
    session::protocol::{AgentId, SessionDescribeParams, SessionKey, openclaw_model_ref},
};

const RUNTIME: ThinkingRuntime = ThinkingRuntime::OpenClaw;

#[derive(Deserialize)]
struct Level {
    id: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    thinking_levels: Option<Vec<Level>>,
    thinking_default: Option<String>,
}

impl Profile {
    fn snapshot(
        self,
        level: Option<String>,
    ) -> Result<SessionThinkingSnapshot, SessionThinkingOutcome> {
        let levels = self.thinking_levels.ok_or_else(|| {
            session_trace(
                "openclaw.thinking.profile.invalid",
                || json!({"reason":"profile_missing_fields","field":"thinkingLevels"}),
            );
            SessionThinkingOutcome::Unavailable(RUNTIME)
        })?;
        if levels.len() > MAX_THINKING_OPTIONS
            || levels.iter().enumerate().any(|(index, option)| {
                !valid_level(&option.id)
                    || option.label.trim().is_empty()
                    || levels[..index]
                        .iter()
                        .any(|previous| previous.id == option.id)
            })
            || level.as_deref().is_some_and(|value| !valid_level(value))
            || self
                .thinking_default
                .as_deref()
                .is_some_and(|value| !valid_level(value))
        {
            session_trace("openclaw.thinking.profile.invalid", || {
                json!({
                    "reason":"profile_invalid_levels", "optionCount":levels.len(),
                })
            });
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        let effective_level = level.clone().or(self.thinking_default);
        session_trace("openclaw.thinking.profile", || {
            json!({
                "reason": if levels.is_empty() { "native_empty_options" } else { "profile_valid" },
                "optionCount": levels.len(),
                "options": levels.iter().map(|option| level_label(&option.id)).collect::<Vec<_>>(),
                "level": level.as_deref().map(level_label),
                "effectiveLevel": effective_level.as_deref().map(level_label),
            })
        });
        Ok(SessionThinkingSnapshot {
            runtime: RUNTIME,
            effective_level,
            level,
            options: levels.into_iter().map(|option| option.id).collect(),
        })
    }
}

#[derive(Deserialize)]
struct NativeRuntime {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRow {
    key: String,
    agent_id: String,
    session_id: String,
    model: String,
    model_provider: String,
    agent_runtime: NativeRuntime,
    thinking_level: Option<String>,
    #[serde(flatten)]
    profile: Profile,
}

impl SessionRow {
    fn matches(&self, identity: &SessionIdentity) -> bool {
        self.key == identity.session_key
            && self.agent_id == identity.agent_id
            && valid_string(&self.session_id)
            && valid_string(&self.model)
            && valid_string(&self.model_provider)
            && valid_string(&self.agent_runtime.id)
    }

    fn same_target(&self, other: &Self) -> bool {
        self.session_id == other.session_id
            && self.agent_runtime.id == other.agent_runtime.id
            && self.model_provider == other.model_provider
            && openclaw_model_ref(Some(&self.model_provider), &self.model)
                == openclaw_model_ref(Some(&other.model_provider), &other.model)
    }

    fn snapshot(self) -> Result<SessionThinkingSnapshot, SessionThinkingOutcome> {
        self.profile.snapshot(self.thinking_level)
    }
}

#[derive(Deserialize)]
struct Description {
    session: Option<SessionRow>,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRow {
    id: String,
    agent_runtime: NativeRuntime,
    #[serde(flatten)]
    profile: Profile,
}

#[derive(Deserialize)]
struct AgentList {
    agents: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelRow {
    id: String,
    provider: String,
    agent_runtime: NativeRuntime,
    #[serde(flatten)]
    profile: Profile,
}

#[derive(Deserialize)]
struct ModelList {
    models: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchEntry {
    session_id: String,
    thinking_level: Option<String>,
}

#[derive(Deserialize)]
struct PatchResult {
    ok: bool,
    key: String,
    entry: PatchEntry,
}

impl SessionOperation {
    pub(crate) async fn session_thinking(
        &self,
        command: SessionThinkingCommand,
    ) -> SessionThinkingOutcome {
        let trace_id = command.trace_id().map(str::to_owned);
        with_session_trace(trace_id, self.execute_thinking(command)).await
    }

    async fn execute_thinking(&self, command: SessionThinkingCommand) -> SessionThinkingOutcome {
        session_trace("openclaw.thinking.request", || {
            json!({
                "mutation": matches!(&command.action, SessionThinkingAction::Set { .. }),
                "modelHint": command.model.is_some(),
                "agentHash": identifier_hash(command.scope.agent_id()),
                "sessionHash": command.scope.identity().map(|identity| identifier_hash(&identity.session_key)),
            })
        });
        if command.scope.endpoint() != &SessionEndpoint::local(SessionProvider::OpenClaw)
            || AgentId::try_new(command.scope.agent_id()).is_err()
            || matches!(command.model.as_ref(), Some(ThinkingModel::Selection(_)))
        {
            session_trace(
                "openclaw.thinking.invalid",
                || json!({"reason":"invalid_scope_or_model"}),
            );
            return SessionThinkingOutcome::Rejected(RUNTIME);
        }
        match (command.scope, command.action) {
            (ThinkingScope::Agent { agent_id, .. }, SessionThinkingAction::Get) => {
                match self.agent_thinking(&agent_id, command.model).await {
                    Ok(snapshot) => SessionThinkingOutcome::Available(snapshot),
                    Err(outcome) => outcome,
                }
            }
            (ThinkingScope::Session { identity }, action) => {
                if crate::port::validate_observation_identity(&identity).is_err()
                    || (matches!(&action, SessionThinkingAction::Set { .. })
                        && command.model.is_some())
                {
                    session_trace(
                        "openclaw.thinking.invalid",
                        || json!({"reason":"invalid_identity_or_set"}),
                    );
                    return SessionThinkingOutcome::Rejected(RUNTIME);
                }
                let described = match self.describe_thinking(&identity).await {
                    Ok(row) => row,
                    Err(outcome) => return outcome,
                };
                match action {
                    SessionThinkingAction::Get => {
                        let snapshot = if let Some(model) = command.model {
                            self.agent_thinking(&identity.agent_id, Some(model)).await
                        } else {
                            self.session_thinking_row(&identity, &described)
                                .await
                                .and_then(SessionRow::snapshot)
                        };
                        match snapshot {
                            Ok(snapshot) => SessionThinkingOutcome::Available(snapshot),
                            Err(outcome) => outcome,
                        }
                    }
                    SessionThinkingAction::Set { level } => {
                        self.patch_thinking(&identity, described, level).await
                    }
                }
            }
            _ => {
                session_trace(
                    "openclaw.thinking.invalid",
                    || json!({"reason":"agent_set"}),
                );
                SessionThinkingOutcome::Rejected(RUNTIME)
            }
        }
    }

    async fn thinking_query<P: Serialize>(
        &self,
        method: &'static str,
        params: P,
    ) -> Result<Value, SessionThinkingOutcome> {
        let id = next_request_id("thinking").map_err(|_| {
            session_trace(
                "openclaw.thinking.rpc.failed",
                || json!({"method":method,"reason":"request_id_unavailable"}),
            );
            SessionThinkingOutcome::Unavailable(RUNTIME)
        })?;
        let request = request(&id, method, params).map_err(|_| {
            session_trace(
                "openclaw.thinking.rpc.failed",
                || json!({"method":method,"reason":"request_encode"}),
            );
            SessionThinkingOutcome::Unavailable(RUNTIME)
        })?;
        session_trace("openclaw.thinking.rpc.request", || json!({"method":method}));
        let response = self.gateway.rpc_ordered_query(request).await.map_err(|_| {
            session_trace(
                "openclaw.thinking.rpc.failed",
                || json!({"method":method,"reason":"rpc_transport"}),
            );
            SessionThinkingOutcome::Unavailable(RUNTIME)
        })?;
        if response.request_id() != id {
            session_trace(
                "openclaw.thinking.rpc.failed",
                || json!({"method":method,"reason":"response_id_mismatch"}),
            );
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        match response {
            GatewayResponse::Success {
                payload: Some(payload),
                ..
            } => Ok(payload),
            GatewayResponse::Failure { error, .. } => {
                session_trace("openclaw.thinking.rpc.failed", || {
                    json!({
                        "method":method, "reason":rpc_failure_reason(method, &error),
                    })
                });
                if error.code() == "FORBIDDEN" {
                    Err(SessionThinkingOutcome::Rejected(RUNTIME))
                } else {
                    Err(SessionThinkingOutcome::Unavailable(RUNTIME))
                }
            }
            _ => {
                session_trace(
                    "openclaw.thinking.rpc.failed",
                    || json!({"method":method,"reason":"response_payload_missing"}),
                );
                Err(SessionThinkingOutcome::Unavailable(RUNTIME))
            }
        }
    }

    async fn describe_thinking(
        &self,
        identity: &SessionIdentity,
    ) -> Result<SessionRow, SessionThinkingOutcome> {
        let key = SessionKey::try_new(identity.session_key.clone()).map_err(|_| {
            session_trace(
                "openclaw.thinking.binding.failed",
                || json!({"reason":"invalid_session_key"}),
            );
            SessionThinkingOutcome::Rejected(RUNTIME)
        })?;
        let payload = self
            .thinking_query(
                "sessions.describe",
                SessionDescribeParams::new(key, Some(&identity.agent_id)),
            )
            .await?;
        let described: Description = decode(payload, "session_description")?;
        let row = described.session.ok_or_else(|| {
            session_trace(
                "openclaw.thinking.binding.failed",
                || json!({"reason":"session_not_found"}),
            );
            SessionThinkingOutcome::Rejected(RUNTIME)
        })?;
        if !row.matches(identity) {
            session_trace(
                "openclaw.thinking.binding.failed",
                || json!({"reason":"session_identity_mismatch"}),
            );
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        Ok(row)
    }

    async fn session_thinking_row(
        &self,
        identity: &SessionIdentity,
        described: &SessionRow,
    ) -> Result<SessionRow, SessionThinkingOutcome> {
        // describe omits the prepared catalog; list projects model/runtime-aware options.
        let payload = self.thinking_query("sessions.list", json!({
            "agentId": identity.agent_id, "search": identity.session_key, "archived": "all", "limit": 100,
        })).await?;
        let list: SessionList = decode(payload, "session_list")?;
        let mut rows = list.sessions.into_iter().filter(|row| {
            row.get("key").and_then(Value::as_str) == Some(identity.session_key.as_str())
        });
        let row: SessionRow = decode(
            rows.next().ok_or_else(|| {
                session_trace(
                    "openclaw.thinking.binding.failed",
                    || json!({"reason":"session_not_found","matchCount":0}),
                );
                SessionThinkingOutcome::Unavailable(RUNTIME)
            })?,
            "session_row",
        )?;
        if rows.next().is_some() {
            session_trace(
                "openclaw.thinking.binding.failed",
                || json!({"reason":"session_duplicate","matchCountAtLeast":2}),
            );
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        if !row.matches(identity) || !row.same_target(described) {
            session_trace("openclaw.thinking.binding.failed", || {
                json!({
                    "reason":"session_binding_mismatch", "identityMatches":row.matches(identity),
                    "sessionMatches":row.session_id == described.session_id,
                    "runtimeMatches":row.agent_runtime.id == described.agent_runtime.id,
                    "targetMatches":row.same_target(described),
                })
            });
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        Ok(row)
    }

    async fn agent_thinking(
        &self,
        agent_id: &str,
        model: Option<ThinkingModel>,
    ) -> Result<SessionThinkingSnapshot, SessionThinkingOutcome> {
        let Some(model) = model else {
            let list: AgentList = decode(
                self.thinking_query("agents.list", json!({})).await?,
                "agent_list",
            )?;
            let mut agents = list
                .agents
                .into_iter()
                .filter(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id));
            let agent: AgentRow = decode(
                agents.next().ok_or_else(|| {
                    session_trace(
                        "openclaw.thinking.candidate.failed",
                        || json!({"reason":"candidate_not_found","kind":"agent","matchCount":0}),
                    );
                    SessionThinkingOutcome::Unavailable(RUNTIME)
                })?,
                "agent_row",
            )?;
            if agents.next().is_some() {
                session_trace(
                    "openclaw.thinking.candidate.failed",
                    || json!({"reason":"candidate_duplicate","kind":"agent","matchCountAtLeast":2}),
                );
                return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
            }
            if agent.id != agent_id || !valid_string(&agent.agent_runtime.id) {
                session_trace(
                    "openclaw.thinking.candidate.failed",
                    || json!({"reason":"candidate_binding_invalid","kind":"agent"}),
                );
                return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
            }
            return agent.profile.snapshot(None);
        };
        let ThinkingModel::Native {
            model, provider, ..
        } = model
        else {
            session_trace(
                "openclaw.thinking.invalid",
                || json!({"reason":"unresolved_model_selection"}),
            );
            return Err(SessionThinkingOutcome::Rejected(RUNTIME));
        };
        if !valid_string(&model)
            || provider
                .as_deref()
                .is_some_and(|value| !valid_string(value))
        {
            session_trace(
                "openclaw.thinking.invalid",
                || json!({"reason":"invalid_model_hint"}),
            );
            return Err(SessionThinkingOutcome::Rejected(RUNTIME));
        }
        let target = openclaw_model_ref(provider.as_deref(), &model);
        session_trace("openclaw.thinking.candidate.request", || {
            json!({
                "modelHash":identifier_hash(&target), "providerPresent":provider.is_some(),
            })
        });
        let list: ModelList = decode(
            self.thinking_query(
                "models.list",
                json!({
                    "agentId": agent_id, "view": "all", "preparedOnly": true,
                }),
            )
            .await?,
            "model_list",
        )?;
        // Native resolves the route/runtime for this agent; public rows do not expose protocol.
        let mut models = list.models.into_iter().filter(|row| {
            let Some(native_provider) = row.get("provider").and_then(Value::as_str) else {
                return false;
            };
            let Some(native_model) = row.get("id").and_then(Value::as_str) else {
                return false;
            };
            provider
                .as_deref()
                .is_none_or(|provider| provider == native_provider)
                && openclaw_model_ref(Some(native_provider), native_model) == target
        });
        let model: ModelRow = decode(
            models.next().ok_or_else(|| {
                session_trace(
                    "openclaw.thinking.candidate.failed",
                    || json!({"reason":"candidate_not_found","kind":"model","matchCount":0}),
                );
                SessionThinkingOutcome::Unavailable(RUNTIME)
            })?,
            "model_row",
        )?;
        if models.next().is_some() {
            session_trace(
                "openclaw.thinking.candidate.failed",
                || json!({"reason":"candidate_duplicate","kind":"model","matchCountAtLeast":2}),
            );
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        if !valid_string(&model.provider)
            || !valid_string(&model.id)
            || !valid_string(&model.agent_runtime.id)
        {
            session_trace(
                "openclaw.thinking.candidate.failed",
                || json!({"reason":"candidate_binding_invalid","kind":"model"}),
            );
            return Err(SessionThinkingOutcome::Unavailable(RUNTIME));
        }
        model.profile.snapshot(None)
    }

    async fn patch_thinking(
        &self,
        identity: &SessionIdentity,
        described: SessionRow,
        level: Option<String>,
    ) -> SessionThinkingOutcome {
        if let Some(level) = level.as_deref() {
            if !valid_level(level) {
                session_trace(
                    "openclaw.thinking.set.invalid",
                    || json!({"reason":"invalid_level"}),
                );
                return SessionThinkingOutcome::Rejected(RUNTIME);
            }
            let snapshot = match self
                .session_thinking_row(identity, &described)
                .await
                .and_then(SessionRow::snapshot)
            {
                Ok(snapshot) => snapshot,
                Err(outcome) => return outcome,
            };
            if !snapshot.options.iter().any(|option| option == level) {
                session_trace("openclaw.thinking.set.invalid", || {
                    json!({
                        "reason":"level_unsupported", "level":level_label(level), "optionCount":snapshot.options.len(),
                    })
                });
                return SessionThinkingOutcome::Rejected(RUNTIME);
            }
        }
        let Ok(id) = next_request_id("thinking-patch") else {
            session_trace(
                "openclaw.thinking.set.failed",
                || json!({"reason":"request_id_unavailable"}),
            );
            return SessionThinkingOutcome::Unavailable(RUNTIME);
        };
        let Ok(request) = request(
            &id,
            "sessions.patch",
            json!({
                "key": identity.session_key, "agentId": identity.agent_id,
                "expectedSessionId": described.session_id, "thinkingLevel": level,
            }),
        ) else {
            session_trace(
                "openclaw.thinking.set.failed",
                || json!({"reason":"request_encode"}),
            );
            return SessionThinkingOutcome::Rejected(RUNTIME);
        };
        session_trace("openclaw.thinking.set.request", || {
            json!({
                "expectedSessionHash":identifier_hash(&described.session_id),
                "level":level.as_deref().map(level_label),
            })
        });
        let response = match self.gateway.rpc_mutation_once(request).await {
            MutationDelivery::NotWritten(_) => {
                session_trace(
                    "openclaw.thinking.set.failed",
                    || json!({"reason":"delivery_not_written"}),
                );
                return SessionThinkingOutcome::Unavailable(RUNTIME);
            }
            MutationDelivery::MayHaveReached(_) => {
                session_trace(
                    "openclaw.thinking.set.failed",
                    || json!({"reason":"delivery_unknown"}),
                );
                return SessionThinkingOutcome::Unknown(RUNTIME);
            }
            MutationDelivery::Response(response) => response,
        };
        if response.request_id() != id {
            session_trace(
                "openclaw.thinking.set.failed",
                || json!({"reason":"response_id_mismatch"}),
            );
            return SessionThinkingOutcome::Unknown(RUNTIME);
        }
        let payload = match response {
            GatewayResponse::Success {
                payload: Some(payload),
                ..
            } => payload,
            GatewayResponse::Failure { error, .. } => {
                let reason = rpc_failure_reason("sessions.patch", &error);
                session_trace("openclaw.thinking.set.failed", || json!({"reason":reason}));
                return if reason == "rpc_method_missing" {
                    SessionThinkingOutcome::Unavailable(RUNTIME)
                } else if matches!(error.code(), "INVALID_REQUEST" | "FORBIDDEN") {
                    SessionThinkingOutcome::Rejected(RUNTIME)
                } else {
                    SessionThinkingOutcome::Unknown(RUNTIME)
                };
            }
            _ => {
                session_trace(
                    "openclaw.thinking.set.failed",
                    || json!({"reason":"ack_missing"}),
                );
                return SessionThinkingOutcome::Unknown(RUNTIME);
            }
        };
        let Ok(ack) = serde_json::from_value::<PatchResult>(payload) else {
            session_trace(
                "openclaw.thinking.set.failed",
                || json!({"reason":"ack_decode"}),
            );
            return SessionThinkingOutcome::Unknown(RUNTIME);
        };
        if !ack.ok
            || ack.key != identity.session_key
            || ack.entry.session_id != described.session_id
            || ack.entry.thinking_level != level
        {
            session_trace("openclaw.thinking.set.failed", || {
                json!({
                    "reason":"ack_readback_mismatch", "ok":ack.ok,
                    "keyMatches":ack.key == identity.session_key,
                    "sessionMatches":ack.entry.session_id == described.session_id,
                    "levelMatches":ack.entry.thinking_level == level,
                })
            });
            return SessionThinkingOutcome::Unknown(RUNTIME);
        }
        match self
            .session_thinking_row(identity, &described)
            .await
            .and_then(SessionRow::snapshot)
        {
            Ok(snapshot) if snapshot.level == level => {
                session_trace(
                    "openclaw.thinking.set.confirmed",
                    || json!({"applied":false,"level":level.as_deref().map(level_label)}),
                );
                SessionThinkingOutcome::Confirmed {
                    snapshot,
                    applied: false,
                }
            }
            Ok(snapshot) => {
                session_trace("openclaw.thinking.set.failed", || {
                    json!({
                        "reason":"readback_mismatch", "level":snapshot.level.as_deref().map(level_label),
                        "requestedLevel":level.as_deref().map(level_label),
                    })
                });
                SessionThinkingOutcome::Unknown(RUNTIME)
            }
            Err(_) => {
                session_trace(
                    "openclaw.thinking.set.failed",
                    || json!({"reason":"readback_failed"}),
                );
                SessionThinkingOutcome::Unknown(RUNTIME)
            }
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(
    payload: Value,
    step: &'static str,
) -> Result<T, SessionThinkingOutcome> {
    T::deserialize(&payload).map_err(|_| {
        session_trace("openclaw.thinking.decode.failed", || {
            let profile = payload
                .get("session")
                .filter(|value| value.is_object())
                .unwrap_or(&payload);
            let reason = if profile
                .get("thinkingLevels")
                .is_some_and(|value| !value.is_null() && Vec::<Level>::deserialize(value).is_err())
            {
                "profile_invalid_levels"
            } else if profile
                .get("thinkingDefault")
                .is_some_and(|value| !value.is_null() && !value.is_string())
            {
                "profile_invalid_default"
            } else {
                "response_decode"
            };
            json!({"step":step, "reason":reason,
                "hasThinkingLevels":profile.get("thinkingLevels").is_some(),
                "hasThinkingDefault":profile.get("thinkingDefault").is_some(),
            })
        });
        SessionThinkingOutcome::Unavailable(RUNTIME)
    })
}

fn rpc_failure_reason(method: &'static str, error: &GatewayError) -> &'static str {
    if error.code() == "FORBIDDEN" {
        "forbidden"
    } else if error.code() == "INVALID_REQUEST"
        && error.message() == format!("unknown method: {method}")
    {
        "rpc_method_missing"
    } else if error.code() == "INVALID_REQUEST" {
        "control_reject"
    } else {
        "rpc_rejected"
    }
}

fn level_label(value: &str) -> &str {
    match value {
        "off" | "on" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max"
        | "ultra" => value,
        _ => "other",
    }
}

fn valid_string(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && !value.chars().any(char::is_control)
}

fn valid_level(value: &str) -> bool {
    value.len() <= MAX_THINKING_LEVEL_BYTES && valid_string(value)
}
