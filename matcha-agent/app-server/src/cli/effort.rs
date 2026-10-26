use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    config::{Config, Paths},
    provider::{ProviderKind, SELECTOR_ENVS},
    rpc,
};

pub(crate) const CONTROL_WINDOW: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Level {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Level {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Capabilities {
    pub(crate) model: String,
    pub(crate) supports_effort: bool,
    pub(crate) supported_effort_levels: Vec<Level>,
    pub(crate) effective_level: Option<Level>,
}

impl Capabilities {
    fn validate(self) -> rpc::Result<Self> {
        if self.model.trim().is_empty()
            || self.model.chars().any(char::is_control)
            || self.supports_effort == self.supported_effort_levels.is_empty()
            || self
                .supported_effort_levels
                .iter()
                .enumerate()
                .any(|(index, level)| self.supported_effort_levels[..index].contains(level))
        {
            return Err(response_error());
        }
        Ok(self)
    }

    pub(crate) fn view(&self, level: Option<Level>) -> Value {
        json!({
            "level": level,
            "effectiveLevel": self.effective_level,
            "options": self.supported_effort_levels,
        })
    }

    pub(crate) fn accepts(&self, level: Level) -> bool {
        self.supports_effort && self.supported_effort_levels.contains(&level)
    }
}

pub(crate) async fn query(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    level: Option<Level>,
    protocol: Option<ProviderKind>,
) -> rpc::Result<Capabilities> {
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| rpc::Error::not_found("Agent"))?;
    let model = super::projection::model(config, agent)?;
    let mut args = vec![
        "--effort-capabilities".into(),
        model.clone().unwrap_or_else(|| "default".into()),
    ];
    if let Some(level) = level {
        args.extend(["--effort".into(), level.as_str().into()]);
    }
    let mut launch = super::projection::launch(config, paths, agent_id, args).await?;
    if let Some(protocol) = protocol {
        // Draft routing changes only this read-only child, never Provider facts or credentials.
        for selector in SELECTOR_ENVS {
            launch.env.insert(selector.into(), "0".into());
        }
        launch
            .env
            .insert("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".into(), "1".into());
        if let Some(selector) = protocol.selector() {
            launch.env.insert(selector.into(), "1".into());
        }
        for name in ["OPENAI_MODEL", "GEMINI_MODEL", "GROK_MODEL"] {
            launch.env.remove(name);
        }
        let model_env = match protocol {
            ProviderKind::Openai | ProviderKind::OpenaiResponses => Some("OPENAI_MODEL"),
            ProviderKind::Gemini => Some("GEMINI_MODEL"),
            ProviderKind::Grok => Some("GROK_MODEL"),
            _ => None,
        };
        if let (Some(name), Some(model)) = (model_env, model) {
            launch.env.insert(name.into(), model);
        }
    }
    let output = super::command::run_bounded(launch, 16 * 1024, CONTROL_WINDOW).await?;
    let mut lines = output.stdout.lines();
    let line = lines
        .next()
        .filter(|line| !line.trim().is_empty())
        .ok_or_else(response_error)?;
    if lines.next().is_some() {
        return Err(response_error());
    }
    serde_json::from_str::<Capabilities>(line)
        .map_err(|source| response_error().with_source(source))?
        .validate()
}

pub(crate) fn readback(response: &Value) -> rpc::Result<Capabilities> {
    let applied = response
        .get("applied")
        .filter(|value| value.is_object())
        .ok_or_else(response_error)?;
    decode_fields(applied, "effort")
}

pub(crate) fn acknowledgement(
    response: &Value,
    requested: Option<Level>,
) -> rpc::Result<Capabilities> {
    let requested_value = response.get("effort").ok_or_else(response_error)?;
    let observed: Option<Level> = serde_json::from_value(requested_value.clone())
        .map_err(|source| response_error().with_source(source))?;
    if observed != requested {
        return Err(response_error());
    }
    let capabilities = decode_fields(response, "appliedEffort")?;
    if requested.is_some_and(|level| !capabilities.accepts(level)) {
        return Err(response_error());
    }
    Ok(capabilities)
}

fn decode_fields(response: &Value, effective: &str) -> rpc::Result<Capabilities> {
    for field in [
        "model",
        "supportsEffort",
        "supportedEffortLevels",
        effective,
    ] {
        if response.get(field).is_none() {
            return Err(response_error());
        }
    }
    serde_json::from_value::<Capabilities>(json!({
        "model": response["model"],
        "supportsEffort": response["supportsEffort"],
        "supportedEffortLevels": response["supportedEffortLevels"],
        "effectiveLevel": response[effective],
    }))
    .map_err(|source| response_error().with_source(source))?
    .validate()
}

fn response_error() -> rpc::Error {
    rpc::Error::new(
        -32004,
        "thinking_native_response",
        "Native thinking capability response is invalid",
    )
}
