use super::settings::{self, Applied, Target};
use crate::{config::ConfigStore, rpc, session::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "PermissionDenied",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
];
const PROMPT_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
];
const AGENT_EVENTS: &[&str] = &["Stop", "SubagentStop"];

type Hooks = BTreeMap<String, Vec<Matcher>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Set {
    agent_id: String,
    session_id: Option<String>,
    hooks: Hooks,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Matcher {
    #[serde(skip_serializing_if = "Option::is_none")]
    matcher: Option<String>,
    hooks: Vec<Hook>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Hook {
    Command {
        command: String,
        #[serde(flatten)]
        options: Options,
        #[serde(skip_serializing_if = "Option::is_none")]
        shell: Option<Shell>,
        #[serde(rename = "async", skip_serializing_if = "Option::is_none")]
        asynchronous: Option<bool>,
        #[serde(rename = "asyncRewake", skip_serializing_if = "Option::is_none")]
        async_rewake: Option<bool>,
    },
    Prompt {
        prompt: String,
        #[serde(flatten)]
        options: Options,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    Agent {
        prompt: String,
        #[serde(flatten)]
        options: Options,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    Http {
        url: String,
        #[serde(flatten)]
        options: Options,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, String>>,
        #[serde(rename = "allowedEnvVars", skip_serializing_if = "Option::is_none")]
        allowed_env_vars: Option<Vec<String>>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Shell {
    Bash,
    Powershell,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
    condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    once: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
enum HookError {
    #[error("The hook event is not known to the native CLI")]
    Event,
    #[error("This hook type requires a native execution context unavailable for this event")]
    EventType,
    #[error("Hook timeout must be positive and finite")]
    Timeout,
    #[error("HTTP hooks require an absolute http or https URL")]
    Url,
    #[error("Hook configuration does not match the native persisted hook schema")]
    Shape,
}

impl From<HookError> for rpc::Error {
    fn from(error: HookError) -> Self {
        let kind = match error {
            HookError::Event => "hooks_event_unknown",
            HookError::EventType => "hooks_event_type_unsupported",
            HookError::Timeout => "hooks_timeout_invalid",
            HookError::Url => "hooks_url_invalid",
            HookError::Shape => "hooks_schema_invalid",
        };
        rpc::Error::new(-32602, kind, error.to_string())
    }
}

fn view(hooks: &Value) -> Value {
    let mut result = settings::select(hooks, EVENTS);
    for matchers in result
        .as_object_mut()
        .expect("selected events form an object")
        .values_mut()
    {
        for matcher in matchers.as_array_mut().into_iter().flatten() {
            for hook in matcher
                .get_mut("hooks")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if let Some(headers) = hook.get_mut("headers") {
                    // Native user/managed files do not pass through the server config writer.
                    if crate::config::validate_settings(&json!({"headers": &*headers})).is_err() {
                        if let Some(headers) = headers.as_object_mut() {
                            for value in headers.values_mut() {
                                *value = json!("[redacted]");
                            }
                        } else {
                            *headers = json!("[redacted]");
                        }
                    }
                }
            }
        }
    }
    result
}

pub(super) async fn get(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    let target: Target = rpc::params(params)?;
    let mut result = settings::query(&target, "hooks", view, config, sessions).await?;
    result["capabilities"] = json!({
        "knownNativeEvents": EVENTS,
        "persistedTypes": ["command", "prompt", "agent", "http"],
        "promptEventsWithContext": PROMPT_EVENTS,
        "agentEventsWithMessages": AGENT_EVENTS,
        "callbackRegistration": "initializeOnly, not persisted hooks",
        "callbackResponseOwner": "interaction.hooks.pending/respond",
        "eventAvailability": "Native lifecycle, tool, Team, worktree and watcher entrypoints are conditional; known event is not a guarantee it fires",
        "policy": "Native managed-only, disableAllHooks, workspace trust and simple-mode rules remain in force",
        "liveArrayMerge": "Native arrays concatenate; replacement or removal of an existing flag matcher requires a new CLI instance",
    });
    Ok(result)
}

pub(super) async fn set(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    // Serde's flattened common fields cannot enforce unknown keys on their own.
    validate_shape(params.get("hooks").ok_or(HookError::Shape)?)?;
    let request: Set = serde_json::from_value(params).map_err(|_| HookError::Shape)?;
    let target = Target {
        agent_id: request.agent_id,
        session_id: request.session_id,
    };
    target.validate()?;
    if request.hooks.is_empty() {
        return Err(rpc::Error::invalid(
            "Provide at least one event; use an empty event array to remove its configured hooks",
        ));
    }
    for (event, matchers) in &request.hooks {
        if !EVENTS.contains(&event.as_str()) {
            return Err(HookError::Event.into());
        }
        for matcher in matchers {
            for hook in &matcher.hooks {
                let options = match hook {
                    Hook::Command { options, .. } => options,
                    Hook::Prompt { options, .. } => {
                        if !PROMPT_EVENTS.contains(&event.as_str()) {
                            return Err(HookError::EventType.into());
                        }
                        options
                    }
                    Hook::Agent { options, .. } => {
                        if !AGENT_EVENTS.contains(&event.as_str()) {
                            return Err(HookError::EventType.into());
                        }
                        options
                    }
                    Hook::Http { url, options, .. } => {
                        let uri: axum::http::Uri = url.parse().map_err(|_| HookError::Url)?;
                        if !matches!(uri.scheme_str(), Some("http" | "https"))
                            || uri.host().is_none()
                        {
                            return Err(HookError::Url.into());
                        }
                        options
                    }
                };
                if options
                    .timeout
                    .is_some_and(|timeout| !timeout.is_finite() || timeout <= 0.0)
                {
                    return Err(HookError::Timeout.into());
                }
            }
        }
    }
    let incoming = rpc::value(&request.hooks)?;
    let _guard = sessions.agent_guard(&target.agent_id).await;
    let native = settings::native_settings(&target, sessions).await?;
    config
        .update(|config| {
            let next = settings::patch(
                settings::section(config, &target.agent_id, "hooks")?,
                incoming.clone(),
            )?;
            settings::replace(config, &target.agent_id, "hooks", next)
        })
        .await?;
    let mut applied = Applied::new();
    if let Some(native) = native.as_ref() {
        let current = native.flag_section("hooks");
        let mut live = current.clone();
        let mut has_live_change = false;
        for (event, matchers) in incoming.as_object().expect("hooks is an object") {
            if settings::additions_only(current.get(event), matchers) {
                live[event] = matchers.clone();
                has_live_change = true;
            } else {
                applied.restart_fields.push(format!("hooks.{event}"));
            }
        }
        if has_live_change {
            applied
                .control(
                    &target,
                    native,
                    sessions,
                    json!({
                        "subtype": "apply_flag_settings", "settings": { "hooks": live },
                    }),
                    "apply_flag_settings",
                )
                .await?;
        }
    }
    let mut result = applied.receipt(&target, native.as_ref());
    result["execution"] = json!("notInvokedByServer");
    result["callbackRegistration"] = json!("unchangedInitializeOnly");
    Ok(result)
}

fn validate_shape(hooks: &Value) -> Result<(), HookError> {
    let events = hooks.as_object().ok_or(HookError::Shape)?;
    for matchers in events.values() {
        for matcher in matchers.as_array().ok_or(HookError::Shape)? {
            let matcher = matcher.as_object().ok_or(HookError::Shape)?;
            if matcher
                .keys()
                .any(|key| !matches!(key.as_str(), "matcher" | "hooks"))
                || matcher.values().any(Value::is_null)
            {
                return Err(HookError::Shape);
            }
            for hook in matcher
                .get("hooks")
                .and_then(Value::as_array)
                .ok_or(HookError::Shape)?
            {
                let hook = hook.as_object().ok_or(HookError::Shape)?;
                let kind = hook
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or(HookError::Shape)?;
                if hook.values().any(Value::is_null) {
                    return Err(HookError::Shape);
                }
                for field in hook.keys() {
                    let common = matches!(
                        field.as_str(),
                        "type" | "if" | "timeout" | "statusMessage" | "once"
                    );
                    let specific = match kind {
                        "command" => matches!(
                            field.as_str(),
                            "command" | "shell" | "async" | "asyncRewake"
                        ),
                        "prompt" | "agent" => matches!(field.as_str(), "prompt" | "model"),
                        "http" => matches!(field.as_str(), "url" | "headers" | "allowedEnvVars"),
                        _ => return Err(HookError::Shape),
                    };
                    if !common && !specific {
                        return Err(HookError::Shape);
                    }
                }
            }
        }
    }
    Ok(())
}
