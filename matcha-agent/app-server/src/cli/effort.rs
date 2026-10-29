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

fn arguments(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    level: Option<Level>,
) -> rpc::Result<Vec<String>> {
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| rpc::Error::not_found("Agent"))?;
    let model = super::projection::model(config, agent)?;
    let settings = super::projection::settings(paths, agent_id, agent)?;
    let settings = serde_json::to_string(&settings)
        .map_err(|source| rpc::Error::internal("native_settings_encode").with_source(source))?;
    let mut args = vec![
        "--effort-capabilities".into(),
        model.clone().unwrap_or_else(|| "default".into()),
        "--settings".into(),
        settings,
    ];
    if let Some(level) = level {
        args.extend(["--effort".into(), level.as_str().into()]);
    }
    Ok(args)
}

pub(crate) async fn prepare(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    level: Option<Level>,
    protocol: Option<ProviderKind>,
) -> rpc::Result<super::process::Launch> {
    let args = arguments(config, paths, agent_id, level)?;
    let mut launch = super::projection::launch(config, paths, agent_id, args).await?;
    route(&mut launch.env, protocol);
    Ok(launch)
}

fn route(
    environment: &mut std::collections::BTreeMap<String, String>,
    protocol: Option<ProviderKind>,
) {
    if let Some(protocol) = protocol {
        // Draft routing changes only this read-only child, never Provider facts or credentials.
        for selector in SELECTOR_ENVS {
            environment.insert(selector.into(), "0".into());
        }
        environment.insert("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST".into(), "1".into());
        if let Some(selector) = protocol.selector() {
            environment.insert(selector.into(), "1".into());
        }
        for name in ["OPENAI_MODEL", "GEMINI_MODEL", "GROK_MODEL"] {
            environment.remove(name);
        }
    }
}

pub(crate) async fn query(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    level: Option<Level>,
    protocol: Option<ProviderKind>,
) -> rpc::Result<Capabilities> {
    inspect(&prepare(config, paths, agent_id, level, protocol).await?).await
}

pub(crate) fn ensure_current(
    expected: &super::process::Launch,
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    level: Option<Level>,
    protocol: Option<ProviderKind>,
) -> rpc::Result<()> {
    let agent = config
        .agents
        .get(agent_id)
        .ok_or_else(|| rpc::Error::not_found("Agent"))?;
    let mut environment = super::projection::provider_environment(config, agent)?;
    // prepare adds these Server-owned paths after resolving the provider environment.
    for name in [
        "WEIXIN_STATE_DIR",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
    ] {
        if let Some(value) = expected.env.get(name) {
            environment.insert(name.into(), value.clone());
        }
    }
    route(&mut environment, protocol);
    let mut args = config.cli.args.clone();
    args.extend(arguments(config, paths, agent_id, level)?);
    if expected.command != config.cli.command
        || expected.args != args
        || expected.env != environment
        || expected.cwd != paths.workspace(agent_id)?
    {
        return Err(rpc::Error::unavailable(
            "thinking_instance_changed",
            "The native configuration changed while reading thinking; retry the read",
        ));
    }
    Ok(())
}

pub(crate) async fn inspect(launch: &super::process::Launch) -> rpc::Result<Capabilities> {
    let launch = super::process::Launch {
        command: launch.command.clone(),
        args: launch.args.clone(),
        env: launch.env.clone(),
        cwd: launch.cwd.clone(),
    };
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
