use crate::{
    config::{Config, ConfigStore, validate_id},
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Target {
    pub agent_id: String,
    pub session_id: Option<String>,
}

impl Target {
    pub fn validate(&self) -> rpc::Result<()> {
        validate_id(&self.agent_id)?;
        if self.session_id.as_ref().is_some_and(|id| id.is_empty()) {
            return Err(rpc::Error::invalid("sessionId must not be empty"));
        }
        Ok(())
    }
}

pub(super) fn section(config: &Config, agent_id: &str, field: &str) -> rpc::Result<Value> {
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| rpc::Error::not_found("agent"))?;
    Ok(agent
        .settings
        .get(field)
        .cloned()
        .unwrap_or_else(|| json!({})))
}

pub(super) fn replace(
    config: &mut Config,
    agent_id: &str,
    field: &str,
    value: Value,
) -> rpc::Result<()> {
    let agent = config
        .agents
        .get_mut(agent_id)
        .ok_or_else(|| rpc::Error::not_found("agent"))?;
    let settings = agent.settings.as_object_mut().ok_or_else(|| {
        rpc::Error::conflict("policy_settings_shape", "Agent settings must be an object")
    })?;
    settings.insert(field.to_owned(), value);
    Ok(())
}

pub(super) fn patch(current: Value, incoming: Value) -> rpc::Result<Value> {
    let mut current = current.as_object().cloned().ok_or_else(|| {
        rpc::Error::conflict(
            "policy_settings_shape",
            "The configured policy section must be an object",
        )
    })?;
    let incoming = incoming
        .as_object()
        .ok_or_else(|| rpc::Error::invalid("Expected an object"))?;
    current.extend(incoming.clone());
    Ok(Value::Object(current))
}

pub(super) fn select(section: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|field| {
                section
                    .get(*field)
                    .cloned()
                    .map(|value| ((*field).to_owned(), value))
            })
            .collect(),
    )
}

pub(super) struct NativeSettings {
    pub session_id: String,
    pub instance_id: String,
    effective: Value,
    sources: Vec<Value>,
}

impl NativeSettings {
    pub fn flag_section(&self, field: &str) -> Value {
        self.sources
            .iter()
            .find(|source| source["source"] == "flagSettings")
            .and_then(|source| source["settings"].get(field))
            .cloned()
            .unwrap_or_else(|| json!({}))
    }

    pub fn view(&self, field: &str, project: fn(&Value) -> Value) -> Value {
        json!({
            "status": "observedSettings",
            "sessionId": self.session_id,
            "instanceId": self.instance_id,
            "effective": project(&self.effective[field]),
            "sources": self.sources.iter().map(|source| json!({
                "source": source["source"],
                "settings": project(&source["settings"][field]),
            })).collect::<Vec<_>>(),
            "meaning": "Native merged settings, not proof of runtime authorization or OS isolation",
        })
    }
}

pub(super) async fn native_settings(
    target: &Target,
    sessions: &Sessions,
) -> rpc::Result<Option<NativeSettings>> {
    let Some(session_id) = &target.session_id else {
        return Ok(None);
    };
    let snapshot = sessions.native_snapshot(session_id).await?;
    if snapshot["agentId"].as_str() != Some(target.agent_id.as_str()) {
        return Err(rpc::Error::conflict(
            "policy_session_agent_mismatch",
            "The session does not belong to this agent",
        ));
    }
    let Some(instance_id) = snapshot["instanceId"].as_str() else {
        return Ok(None);
    };
    let settings = sessions
        .control_instance(
            session_id,
            instance_id,
            json!({
                "subtype": "get_settings",
            }),
        )
        .await?;
    let effective = settings.get("effective").filter(|value| value.is_object());
    let sources = settings.get("sources").and_then(Value::as_array);
    let (Some(effective), Some(sources)) = (effective, sources) else {
        return Err(rpc::Error::new(
            -32004,
            "policy_native_settings_schema",
            "The CLI returned an invalid settings response",
        ));
    };
    if sources.iter().any(|source| {
        !matches!(
            source["source"].as_str(),
            Some(
                "userSettings"
                    | "projectSettings"
                    | "localSettings"
                    | "flagSettings"
                    | "policySettings"
            )
        ) || !source["settings"].is_object()
    }) {
        return Err(rpc::Error::new(
            -32004,
            "policy_native_settings_schema",
            "The CLI returned invalid settings sources",
        ));
    }
    Ok(Some(NativeSettings {
        session_id: session_id.clone(),
        instance_id: instance_id.to_owned(),
        effective: effective.clone(),
        sources: sources.clone(),
    }))
}

pub(super) async fn query(
    target: &Target,
    field: &str,
    project: fn(&Value) -> Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    target.validate()?;
    let configured = section(&config.snapshot().await, &target.agent_id, field)?;
    let observed = native_settings(target, sessions).await?;
    Ok(json!({
        "agentId": target.agent_id,
        "configured": project(&configured),
        "configuredSource": "serverAgentSettings",
        "projection": "nextLaunchFlagSettings",
        "native": observed.as_ref().map(|native| native.view(field, project)),
        "nativeObservation": if target.session_id.is_none() { "notRequested" }
            else if observed.is_none() { "notRunning" } else { "observed" },
    }))
}

pub(super) struct Applied {
    pub steps: Vec<&'static str>,
    pub restart_fields: Vec<String>,
}

impl Applied {
    pub fn new() -> Self {
        Self {
            steps: Vec::new(),
            restart_fields: Vec::new(),
        }
    }

    pub fn receipt(&self, target: &Target, native: Option<&NativeSettings>) -> Value {
        json!({
            "agentId": target.agent_id,
            "persisted": true,
            "projection": "nextLaunchFlagSettings",
            "live": {
                "status": if target.session_id.is_none() { "notRequested" }
                    else if native.is_none() { "notRunning" }
                    else if self.steps.is_empty() { "restartRequired" } else { "acknowledged" },
                "sessionId": target.session_id,
                "instanceId": native.map(|native| native.instance_id.as_str()),
                "steps": self.steps,
                "meaning": "ACK confirms only the named native controls, not every field or hook execution",
            },
            "restartRequired": native.is_none() || !self.restart_fields.is_empty(),
            "restartFields": self.restart_fields,
            "otherSessions": "notApplied",
        })
    }

    pub async fn control(
        &mut self,
        target: &Target,
        native: &NativeSettings,
        sessions: &Sessions,
        request: Value,
        step: &'static str,
    ) -> rpc::Result<Value> {
        let response = sessions
            .control_instance(&native.session_id, &native.instance_id, request)
            .await
            .map_err(|error| {
                error.with_data(json!({
                    "agentId": target.agent_id,
                    "sessionId": native.session_id,
                    "instanceId": native.instance_id,
                    "persisted": true,
                    "projection": "nextLaunchFlagSettings",
                    "failedStep": step,
                    "acknowledgedSteps": self.steps,
                    "restartRequired": true,
                    "restartFields": self.restart_fields,
                    "otherSessions": "notApplied",
                }))
            })?;
        self.steps.push(step);
        Ok(response)
    }
}

pub(super) fn additions_only(previous: Option<&Value>, next: &Value) -> bool {
    match (previous, next.as_array()) {
        (None, Some(_)) => true,
        (Some(Value::Array(previous)), Some(next)) => {
            previous.iter().all(|value| next.contains(value))
        }
        _ => false,
    }
}

pub(super) fn nonempty_patch(patch: &Map<String, Value>) -> rpc::Result<()> {
    if patch.is_empty() {
        return Err(rpc::Error::invalid(
            "At least one policy field must be provided",
        ));
    }
    Ok(())
}
