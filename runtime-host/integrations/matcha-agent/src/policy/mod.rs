//! Native settings are not the OpenClaw SecurityOps/SettingsOps product contract.
//! The CLI remains the permission/hook/sandbox authority; no tool is evaluated here.

mod product;

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{client, driver::MatchaRuntimeDriver};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyTarget {
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

// No Debug on policy inputs/results: rules and native settings can contain commands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySnapshot {
    pub agent_id: String,
    pub configured: Value,
    pub configured_source: String,
    pub projection: String,
    pub native: Option<NativeSettings>,
    pub native_observation: NativeObservation,
    pub platform: Option<SandboxPlatform>,
    pub isolation: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPlatform {
    pub name: String,
    pub support: String,
    pub native_dependencies: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSettings {
    pub status: String,
    pub session_id: String,
    pub instance_id: String,
    pub effective: Value,
    pub sources: Vec<SettingsSource>,
}

#[derive(Deserialize)]
pub struct SettingsSource {
    pub source: String,
    pub settings: Value,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum NativeObservation {
    NotRequested,
    NotRunning,
    Observed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyMutation {
    pub agent_id: String,
    pub persisted: bool,
    pub projection: String,
    pub live: LiveApplication,
    pub restart_required: bool,
    pub restart_fields: Vec<String>,
    pub other_sessions: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveApplication {
    pub status: LiveStatus,
    pub session_id: Option<String>,
    pub instance_id: Option<String>,
    pub steps: Vec<String>,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LiveStatus {
    NotRequested,
    NotRunning,
    RestartRequired,
    Acknowledged,
}

pub struct NativePolicyError {
    cause: Option<client::Error>,
    response: Option<Value>,
}

impl NativePolicyError {
    pub fn code(&self) -> Option<i64> {
        self.cause.as_ref().and_then(client::Error::code)
    }

    pub fn kind(&self) -> &str {
        self.cause
            .as_ref()
            .map_or("policy_response_invalid", client::Error::kind)
    }

    /// Private adapter evidence only; never serialize this into product errors or logs.
    pub fn private_data(&self) -> Option<&Value> {
        self.cause
            .as_ref()
            .and_then(client::Error::data)
            .or(self.response.as_ref())
    }

    pub fn delivery(&self) -> client::Delivery {
        self.cause
            .as_ref()
            .map_or(client::Delivery::ResponseReceived, client::Error::delivery)
    }

    pub fn persisted(&self) -> Option<bool> {
        self.private_data()?.get("persisted")?.as_bool()
    }

    pub fn acknowledged_steps(&self) -> Vec<&str> {
        self.private_data()
            .and_then(|data| {
                data.get("acknowledgedSteps")
                    .or_else(|| data.get("live")?.get("steps"))
            })
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|step| matches!(*step, "apply_flag_settings" | "set_permission_mode"))
            .collect()
    }
}

impl fmt::Debug for NativePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativePolicyError")
            .field("code", &self.code())
            .field("delivery", &self.delivery())
            .finish_non_exhaustive()
    }
}

impl fmt::Display for NativePolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Native policy operation failed; inspect private delivery evidence")
    }
}

impl std::error::Error for NativePolicyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|cause| cause as &dyn std::error::Error)
    }
}

impl From<client::Error> for NativePolicyError {
    fn from(cause: client::Error) -> Self {
        Self {
            cause: Some(cause),
            response: None,
        }
    }
}

impl MatchaRuntimeDriver {
    pub async fn native_permissions_get(
        &self,
        target: PolicyTarget,
    ) -> Result<PolicySnapshot, NativePolicyError> {
        self.policy_get("permissions.get", "permissions", target)
            .await
    }

    pub async fn native_permissions_set(
        &self,
        target: PolicyTarget,
        permissions: Value,
    ) -> Result<PolicyMutation, NativePolicyError> {
        self.policy_set("permissions.set", "permissions", target, permissions)
            .await
    }

    pub async fn native_hooks_get(
        &self,
        target: PolicyTarget,
    ) -> Result<PolicySnapshot, NativePolicyError> {
        self.policy_get("hooks.get", "hooks", target).await
    }

    pub async fn native_hooks_set(
        &self,
        target: PolicyTarget,
        hooks: Value,
    ) -> Result<PolicyMutation, NativePolicyError> {
        self.policy_set("hooks.set", "hooks", target, hooks).await
    }

    pub async fn native_sandbox_status(
        &self,
        target: PolicyTarget,
    ) -> Result<PolicySnapshot, NativePolicyError> {
        self.policy_get("sandbox.status", "sandbox", target).await
    }

    pub async fn native_sandbox_set(
        &self,
        target: PolicyTarget,
        sandbox: Value,
    ) -> Result<PolicyMutation, NativePolicyError> {
        self.policy_set("sandbox.set", "sandbox", target, sandbox)
            .await
    }

    async fn policy_get(
        &self,
        method: &str,
        section: &str,
        target: PolicyTarget,
    ) -> Result<PolicySnapshot, NativePolicyError> {
        let response = self.native_client().call(method, json!(&target)).await?;
        let mut snapshot: PolicySnapshot = serde_json::from_value(response.clone())
            .map_err(|_| invalid_response(response.clone()))?;
        if snapshot.agent_id != target.agent_id
            || snapshot.configured_source != "serverAgentSettings"
            || snapshot.projection != "nextLaunchFlagSettings"
            || snapshot.native.as_ref().is_some_and(|native| {
                Some(native.session_id.as_str()) != target.session_id.as_deref()
                    || native.instance_id.is_empty()
                    || native.status != "observedSettings"
            })
            || (snapshot.native_observation == NativeObservation::Observed)
                != snapshot.native.is_some()
        {
            return Err(invalid_response(response));
        }
        snapshot.configured = safe_section(section, &snapshot.configured);
        if let Some(native) = &mut snapshot.native {
            native.effective = safe_section(section, &native.effective);
            for source in &mut native.sources {
                source.settings = safe_section(section, &source.settings);
            }
        }
        Ok(snapshot)
    }

    async fn policy_set(
        &self,
        method: &str,
        section: &str,
        target: PolicyTarget,
        patch: Value,
    ) -> Result<PolicyMutation, NativePolicyError> {
        let mut params = json!(&target);
        params[section] = patch;
        let response = self.native_client().call(method, params).await?;
        let receipt: PolicyMutation = serde_json::from_value(response.clone())
            .map_err(|_| invalid_response(response.clone()))?;
        if receipt.agent_id != target.agent_id
            || !receipt.persisted
            || receipt.projection != "nextLaunchFlagSettings"
            || receipt.other_sessions != "notApplied"
            || receipt.live.session_id != target.session_id
            || receipt
                .live
                .steps
                .iter()
                .any(|step| !matches!(step.as_str(), "apply_flag_settings" | "set_permission_mode"))
            || receipt
                .restart_fields
                .iter()
                .any(|field| !product::restart_field(field))
            || receipt
                .live
                .instance_id
                .as_ref()
                .is_some_and(String::is_empty)
            || match receipt.live.status {
                LiveStatus::NotRequested => {
                    target.session_id.is_some()
                        || receipt.live.instance_id.is_some()
                        || !receipt.live.steps.is_empty()
                }
                LiveStatus::NotRunning => {
                    target.session_id.is_none()
                        || receipt.live.instance_id.is_some()
                        || !receipt.live.steps.is_empty()
                }
                LiveStatus::RestartRequired => {
                    !receipt.restart_required || !receipt.live.steps.is_empty()
                }
                LiveStatus::Acknowledged => {
                    target.session_id.is_none()
                        || receipt.live.instance_id.is_none()
                        || receipt.live.steps.is_empty()
                }
            }
        {
            return Err(invalid_response(response));
        }
        Ok(receipt)
    }
}

fn invalid_response(response: Value) -> NativePolicyError {
    NativePolicyError {
        cause: None,
        response: Some(response),
    }
}

fn safe_section(section: &str, value: &Value) -> Value {
    if section == "hooks" {
        return Value::Object(
            value
                .as_object()
                .into_iter()
                .flatten()
                .map(|(event, matchers)| {
                    let matchers = matchers.as_array();
                    let hooks = matchers
                        .into_iter()
                        .flatten()
                        .filter_map(|matcher| matcher.get("hooks").and_then(Value::as_array))
                        .map(Vec::len)
                        .sum::<usize>();
                    (
                        event.clone(),
                        json!({"matcherCount": matchers.map_or(0, Vec::len), "hookCount": hooks}),
                    )
                })
                .collect(),
        );
    }
    let mut safe = value.clone();
    if section == "sandbox" {
        if let Some(fields) = safe.as_object_mut() {
            let configured = fields.remove("ripgrep").is_some();
            fields.insert("ripgrepConfigured".into(), json!(configured));
        }
    }
    safe
}
