use crate::{
    client::{Client, Delivery},
    provider::native_protocol,
    session::{
        model::valid_agent_id,
        rpc::{self, Failure, FailureKind},
    },
};
use platform::trace::{identifier_hash, session_trace, with_session_trace};
use provider_module::ProviderApiProtocol;
use serde_json::{Value, json};
use sessions_module::{
    state::{SessionEndpoint, SessionProvider},
    thinking::{
        SessionThinkingAction, SessionThinkingCommand, SessionThinkingOutcome as Outcome,
        SessionThinkingSnapshot as Snapshot, ThinkingModel, ThinkingRuntime, ThinkingScope,
    },
};

const RUNTIME: ThinkingRuntime = ThinkingRuntime::MatchaAgent;

pub(super) async fn apply(client: &Client, command: SessionThinkingCommand) -> Outcome {
    let trace_id = command.trace_id().map(str::to_owned);
    with_session_trace(trace_id, async move {
        let mutation = matches!(&command.action, SessionThinkingAction::Set { .. });
        session_trace("matcha.thinking.request", || json!({
            "mutation": mutation,
            "modelHint": command.model.is_some(),
            "agentHash": identifier_hash(command.scope.agent_id()),
            "sessionHash": command.scope.identity().map(|identity| identifier_hash(&identity.session_key)),
        }));
        match execute(client, command).await {
            Ok(outcome) => outcome,
            Err(error) => failure(error, mutation),
        }
    })
    .await
}

async fn execute(client: &Client, command: SessionThinkingCommand) -> Result<Outcome, Failure> {
    if command.scope.endpoint() != &SessionEndpoint::local(SessionProvider::MatchaAgent)
        || !valid_agent_id(command.scope.agent_id())
    {
        session_trace(
            "matcha.thinking.invalid",
            || json!({"reason":"invalid_scope"}),
        );
        return Err(Failure::InvalidInput);
    }
    match (&command.scope, &command.action) {
        (ThinkingScope::Agent { agent_id, .. }, SessionThinkingAction::Get) => Ok(available(
            models(client, agent_id, command.model.as_ref()).await?,
        )),
        (ThinkingScope::Agent { .. }, SessionThinkingAction::Set { .. }) => {
            session_trace("matcha.thinking.invalid", || json!({"reason":"agent_set"}));
            Err(Failure::InvalidInput)
        }
        (ThinkingScope::Session { identity }, action) => {
            if let SessionThinkingAction::Set { level } = action
                && (command.model.is_some()
                    || level.as_deref().is_some_and(|level| !valid_level(level)))
            {
                session_trace(
                    "matcha.thinking.invalid",
                    || json!({"reason":"invalid_set"}),
                );
                return Err(Failure::InvalidInput);
            }
            let record = rpc::bound(client, identity, None)
                .await
                .inspect_err(|error| trace_failure("session_binding", error))?;
            let id = record.session_id.as_str();
            match action {
                SessionThinkingAction::Get => {
                    if let Some(model) = &command.model {
                        return Ok(available(
                            models(client, &record.agent_id, Some(model)).await?,
                        ));
                    }
                    let value = rpc::call(client, "sessions.thinking.get", json!({"sessionId":id}))
                        .await
                        .inspect_err(|error| trace_failure("sessions.thinking.get", error))?;
                    Ok(available(snapshot(&value, false)?))
                }
                SessionThinkingAction::Set { level } => {
                    session_trace("matcha.thinking.set.request", || {
                        json!({
                            "sessionHash": identifier_hash(id), "level": level,
                        })
                    });
                    let value = rpc::call(
                        client,
                        "sessions.thinking.set",
                        json!({"sessionId":id,"level":level}),
                    )
                    .await
                    .inspect_err(|error| trace_failure("sessions.thinking.set", error))?;
                    let observed = snapshot(&value, true)?;
                    if value.get("persisted") != Some(&Value::Bool(true))
                        || observed.level != *level
                    {
                        session_trace("matcha.thinking.set.invalid", || {
                            json!({
                                "reason":"readback_mismatch",
                                "persisted": value.get("persisted").and_then(Value::as_bool),
                                "levelMatches": observed.level == *level,
                            })
                        });
                        return Err(Failure::InvalidReadback);
                    }
                    let applied =
                        value
                            .get("applied")
                            .and_then(Value::as_bool)
                            .ok_or_else(|| {
                                session_trace(
                                    "matcha.thinking.set.invalid",
                                    || json!({"reason":"ack_applied_invalid"}),
                                );
                                Failure::InvalidReadback
                            })?;
                    session_trace(
                        "matcha.thinking.set.confirmed",
                        || json!({"applied":applied,"level":observed.level}),
                    );
                    Ok(Outcome::Confirmed {
                        snapshot: observed,
                        applied,
                    })
                }
            }
        }
    }
}

async fn models(
    client: &Client,
    agent: &str,
    model: Option<&ThinkingModel>,
) -> Result<Snapshot, Failure> {
    let mut params = json!({"agentId":agent});
    match model {
        None => {}
        Some(ThinkingModel::Native {
            model,
            provider,
            protocol,
        }) => {
            if provider.is_some() || model.trim().is_empty() || model.chars().any(char::is_control)
            {
                session_trace(
                    "matcha.thinking.invalid",
                    || json!({"reason":"invalid_model_hint"}),
                );
                return Err(Failure::InvalidInput);
            }
            params["model"] = json!(model);
            if let Some(protocol) = protocol {
                let protocol = match protocol.as_str() {
                    "anthropic_messages" => ProviderApiProtocol::AnthropicMessages,
                    "google_generative_ai" => ProviderApiProtocol::GoogleGenerativeAi,
                    "open_ai_completions" => ProviderApiProtocol::OpenAiCompletions,
                    "open_ai_responses" => ProviderApiProtocol::OpenAiResponses,
                    _ => {
                        session_trace(
                            "matcha.thinking.invalid",
                            || json!({"reason":"invalid_protocol"}),
                        );
                        return Err(Failure::InvalidInput);
                    }
                };
                params["protocol"] = json!(native_protocol(protocol));
            }
        }
        Some(ThinkingModel::Selection(_)) => {
            session_trace(
                "matcha.thinking.invalid",
                || json!({"reason":"unresolved_model_selection"}),
            );
            return Err(Failure::InvalidInput);
        }
    }
    session_trace("matcha.thinking.models.request", || {
        json!({
            "agentHash": identifier_hash(agent),
            "modelHash": params.get("model").and_then(Value::as_str).map(identifier_hash),
            "protocol": params.get("protocol").and_then(Value::as_str),
        })
    });
    let value = rpc::call(client, "models.thinking", params)
        .await
        .inspect_err(|error| trace_failure("models.thinking", error))?;
    let observed = snapshot(&value, false)?;
    if observed.level.is_some() {
        session_trace(
            "matcha.thinking.models.invalid",
            || json!({"reason":"candidate_has_override"}),
        );
        return Err(Failure::InvalidReadback);
    }
    Ok(observed)
}

fn available(snapshot: Snapshot) -> Outcome {
    if snapshot.options.is_empty() && snapshot.level.is_none() {
        Outcome::Unsupported(RUNTIME)
    } else {
        Outcome::Available(snapshot)
    }
}

fn snapshot(value: &Value, update: bool) -> Result<Snapshot, Failure> {
    let fields = value.as_object().ok_or_else(|| {
        session_trace(
            "matcha.thinking.profile.invalid",
            || json!({"reason":"profile_shape_invalid","update":update}),
        );
        Failure::InvalidReadback
    })?;
    let expected: &[&str] = if update {
        &["level", "effectiveLevel", "options", "persisted", "applied"]
    } else {
        &["level", "effectiveLevel", "options"]
    };
    let missing = expected
        .iter()
        .filter(|field| !fields.contains_key(**field))
        .count();
    if fields.len() != expected.len() || missing > 0 {
        session_trace("matcha.thinking.profile.invalid", || {
            json!({
                "reason": if missing > 0 { "profile_missing_fields" } else { "profile_shape_invalid" },
                "update": update, "fieldCount": fields.len(), "missingFieldCount": missing,
            })
        });
        return Err(Failure::InvalidReadback);
    }
    let level = read_level(value.get("level"), "level")?;
    let effective_level = read_level(value.get("effectiveLevel"), "effectiveLevel")?;
    let options: Vec<String> = rpc::decode(value["options"].clone()).inspect_err(|_| {
        session_trace(
            "matcha.thinking.profile.invalid",
            || json!({"reason":"profile_invalid_levels"}),
        );
    })?;
    if options
        .iter()
        .enumerate()
        .any(|(index, level)| !valid_level(level) || options[..index].contains(level))
    {
        session_trace("matcha.thinking.profile.invalid", || {
            json!({
                "reason":"profile_invalid_levels", "optionCount":options.len(),
            })
        });
        return Err(Failure::InvalidReadback);
    }
    session_trace("matcha.thinking.profile", || {
        json!({
            "reason": if options.is_empty() { "native_empty_options" } else { "profile_valid" },
            "update": update, "level": level, "effectiveLevel": effective_level, "options": options,
        })
    });
    Ok(Snapshot {
        runtime: RUNTIME,
        level,
        effective_level,
        options,
    })
}

fn read_level(value: Option<&Value>, field: &'static str) -> Result<Option<String>, Failure> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(level)) if valid_level(level) => Ok(Some(level.clone())),
        _ => {
            session_trace(
                "matcha.thinking.profile.invalid",
                || json!({"reason":"profile_invalid_level","field":field}),
            );
            Err(Failure::InvalidReadback)
        }
    }
}

fn valid_level(level: &str) -> bool {
    matches!(level, "low" | "medium" | "high" | "xhigh" | "max")
}

fn trace_failure(step: &'static str, error: &Failure) {
    session_trace("matcha.thinking.failed", || {
        let data = error.data();
        let reason = match error.native_kind() {
            Some("native_control_error") => "control_reject",
            Some("thinking_native_response") => "native_profile_invalid",
            Some("thinking_native_ack_invalid") => "native_ack_invalid",
            Some("thinking_control_timeout" | "thinking_control_unknown") => {
                "control_delivery_unknown"
            }
            Some("thinking_instance_changed" | "thinking_session_changed") => "session_changed",
            Some("thinking_level_unsupported" | "thinking_level_model_conflict") => {
                "level_unsupported"
            }
            Some("session_busy") => "session_busy",
            Some("session_transition_in_progress") => "session_transition_in_progress",
            Some("native_cleanup_unconfirmed") => "native_cleanup_unconfirmed",
            Some("thinking_read_timeout") => "control_read_timeout",
            _ if error.code() == Some(-32601) => "rpc_method_missing",
            _ if error.is_not_found() => "native_target_not_found",
            _ => match error {
                Failure::InvalidInput => "invalid_identity",
                Failure::InvalidReadback => "readback_mismatch",
                Failure::Native(_) => "rpc_failed",
            },
        };
        json!({
            "step": step, "reason": reason, "failure": error.trace_summary(),
            "nativeAcknowledged": data.and_then(|data| data.get("nativeAcknowledged")).and_then(Value::as_bool),
            "persisted": data.and_then(|data| data.get("persisted")).and_then(Value::as_bool),
            "nativeDelivery": data.and_then(|data| data.get("delivery")).and_then(Value::as_str)
                .map(|delivery| match delivery { "sent" | "unknown" | "notSent" => delivery, _ => "other" }),
        })
    });
}

fn failure(error: Failure, mutation: bool) -> Outcome {
    if error.delivery() == Some(Delivery::ResponseReceived) {
        let data = error.data();
        if mutation
            && (data
                .and_then(|data| data.get("nativeAcknowledged"))
                .and_then(Value::as_bool)
                == Some(true)
                || data
                    .and_then(|data| data.get("delivery"))
                    .and_then(Value::as_str)
                    == Some("unknown"))
        {
            return Outcome::Unknown(RUNTIME);
        }
        if error.code() == Some(-32601) {
            return Outcome::Unsupported(RUNTIME);
        }
        if error.code() == Some(-32004)
            && !(error.native_kind() == Some("native_control_error")
                && data
                    .and_then(|data| data.get("delivery"))
                    .and_then(Value::as_str)
                    == Some("sent"))
        {
            return Outcome::Unknown(RUNTIME);
        }
    }
    match error.kind() {
        FailureKind::Rejected => Outcome::Rejected(RUNTIME),
        FailureKind::Unavailable | FailureKind::Cancelled => Outcome::Unavailable(RUNTIME),
        FailureKind::Unknown => Outcome::Unknown(RUNTIME),
    }
}
