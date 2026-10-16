use super::settings::{self, Applied, Target};
use crate::{config::ConfigStore, rpc, session::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const FIELDS: &[&str] = &[
    "enabled",
    "failIfUnavailable",
    "autoAllowBashIfSandboxed",
    "allowUnsandboxedCommands",
    "enabledPlatforms",
    "network",
    "filesystem",
    "ignoreViolations",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
    "excludedCommands",
    "ripgrep",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Set {
    agent_id: String,
    session_id: Option<String>,
    sandbox: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Sandbox {
    enabled: Option<bool>,
    fail_if_unavailable: Option<bool>,
    auto_allow_bash_if_sandboxed: Option<bool>,
    allow_unsandboxed_commands: Option<bool>,
    enabled_platforms: Option<Vec<Platform>>,
    network: Option<Network>,
    filesystem: Option<Filesystem>,
    ignore_violations: Option<BTreeMap<String, Vec<String>>>,
    enable_weaker_nested_sandbox: Option<bool>,
    enable_weaker_network_isolation: Option<bool>,
    excluded_commands: Option<Vec<String>>,
    ripgrep: Option<Ripgrep>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Platform {
    Macos,
    Windows,
    Wsl,
    Linux,
    Unknown,
}

impl Platform {
    fn name(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
            Self::Wsl => "wsl",
            Self::Linux => "linux",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Network {
    allowed_domains: Option<Vec<String>>,
    allow_managed_domains_only: Option<bool>,
    allow_unix_sockets: Option<Vec<String>>,
    allow_all_unix_sockets: Option<bool>,
    allow_local_binding: Option<bool>,
    http_proxy_port: Option<u16>,
    socks_proxy_port: Option<u16>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Filesystem {
    allow_write: Option<Vec<String>>,
    deny_write: Option<Vec<String>>,
    deny_read: Option<Vec<String>>,
    allow_read: Option<Vec<String>>,
    allow_managed_read_paths_only: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ripgrep {
    command: String,
    args: Option<Vec<String>>,
}

#[derive(Debug, thiserror::Error)]
enum SandboxError {
    #[error(
        "The native sandbox does not support Windows; use a CLI running on macOS, Linux or WSL2"
    )]
    Windows,
    #[error("The native sandbox does not support WSL1; use WSL2")]
    Wsl1,
    #[error("The native sandbox does not support this operating system")]
    Platform,
    #[error("The current platform is excluded by sandbox.enabledPlatforms")]
    ExcludedPlatform,
    #[error(
        "Explicit sandboxing requires enabled=true, failIfUnavailable=true and allowUnsandboxedCommands=false"
    )]
    SilentFallback,
    #[error(
        "excludedCommands would execute outside an explicitly required sandbox; remove exclusions"
    )]
    ExcludedCommands,
    #[error("Sandbox fields must use the native types and cannot be null")]
    Shape,
}

impl From<SandboxError> for rpc::Error {
    fn from(error: SandboxError) -> Self {
        let (code, kind) = match error {
            SandboxError::Windows => (-32003, "sandbox_windows_unsupported"),
            SandboxError::Wsl1 => (-32003, "sandbox_wsl1_unsupported"),
            SandboxError::Platform => (-32003, "sandbox_platform_unsupported"),
            SandboxError::ExcludedPlatform => (-32602, "sandbox_platform_excluded"),
            SandboxError::SilentFallback => (-32602, "sandbox_silent_fallback_forbidden"),
            SandboxError::ExcludedCommands => (-32602, "sandbox_unsandboxed_exclusions"),
            SandboxError::Shape => (-32602, "sandbox_settings_invalid"),
        };
        rpc::Error::new(code, kind, error.to_string())
    }
}

fn view(sandbox: &Value) -> Value {
    settings::select(sandbox, FIELDS)
}

pub(crate) async fn validate_required_sandbox(effective: &Value) -> rpc::Result<()> {
    let sandbox = effective
        .as_object()
        .and_then(|settings| settings.get("sandbox"))
        .and_then(Value::as_object)
        .ok_or(SandboxError::Shape)?;
    let enabled = sandbox
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or(SandboxError::Shape)?;
    let required = sandbox
        .get("failIfUnavailable")
        .and_then(Value::as_bool)
        .ok_or(SandboxError::Shape)?;
    let fallback = sandbox
        .get("allowUnsandboxedCommands")
        .and_then(Value::as_bool)
        .ok_or(SandboxError::Shape)?;
    if !enabled || !required || fallback {
        return Err(SandboxError::SilentFallback.into());
    }
    if let Some(commands) = sandbox.get("excludedCommands") {
        let commands: Vec<String> =
            serde_json::from_value(commands.clone()).map_err(|_| SandboxError::Shape)?;
        if !commands.is_empty() {
            return Err(SandboxError::ExcludedCommands.into());
        }
    }
    let (platform, wsl1) = platform().await?;
    ensure_supported(platform, wsl1)?;
    if let Some(platforms) = sandbox.get("enabledPlatforms") {
        let platforms: Vec<Platform> =
            serde_json::from_value(platforms.clone()).map_err(|_| SandboxError::Shape)?;
        if !platforms
            .iter()
            .any(|allowed| allowed.name() == platform.name())
        {
            return Err(SandboxError::ExcludedPlatform.into());
        }
    }
    Ok(())
}

pub(super) async fn status(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    let target: Target = rpc::params(params)?;
    let mut result = settings::query(&target, "sandbox", view, config, sessions).await?;
    let (platform, wsl1) = platform().await?;
    result["platform"] = json!({
        "name": platform.name(),
        "support": match platform {
            Platform::Windows => "unsupportedWindows",
            Platform::Wsl if wsl1 => "unsupportedWsl1",
            Platform::Macos | Platform::Linux | Platform::Wsl => "nativeDependencyCheckRequired",
            Platform::Unknown => "unsupportedPlatform",
        },
        "nativeDependencies": "notProbedByServer",
    });
    result["isolation"] = json!("notObserved");
    result["scope"] = json!(
        "Native sandbox wraps eligible shell commands; settings are not whole-agent OS isolation"
    );
    result["limitations"] = json!([
        "Native CLI startup performs platform, dependency and required-sandbox checks",
        "allowUnixSockets paths are enforced on macOS, not Linux/WSL",
        "Linux/WSL path globs have native limitations",
        "Managed sandbox settings and native permission deny rules remain authoritative",
    ]);
    Ok(result)
}

pub(super) async fn set(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    let request: Set = rpc::params(params)?;
    let target = Target {
        agent_id: request.agent_id,
        session_id: request.session_id,
    };
    target.validate()?;
    let patch = request.sandbox.as_object().ok_or(SandboxError::Shape)?;
    settings::nonempty_patch(patch)?;
    if has_null(&request.sandbox) {
        return Err(SandboxError::Shape.into());
    }
    let _: Sandbox =
        serde_json::from_value(request.sandbox.clone()).map_err(|_| SandboxError::Shape)?;
    let (platform, wsl1) = platform().await?;
    let _guard = sessions.agent_guard(&target.agent_id).await;
    // Binding is checked without changing the running process or asking it to enable isolation.
    if let Some(session_id) = &target.session_id {
        let snapshot = sessions.native_snapshot(session_id).await?;
        if snapshot["agentId"].as_str() != Some(target.agent_id.as_str()) {
            return Err(rpc::Error::conflict(
                "policy_session_agent_mismatch",
                "The session does not belong to this agent",
            ));
        }
    }
    let incoming = request.sandbox;
    config
        .update(|config| {
            let current = settings::section(config, &target.agent_id, "sandbox")?;
            let mut next = merge(current, incoming.clone())?;
            if next["enabled"] == true {
                ensure_supported(platform, wsl1)?;
                if incoming["failIfUnavailable"] == false
                    || incoming["allowUnsandboxedCommands"] == true
                {
                    return Err(SandboxError::SilentFallback.into());
                }
                if next["excludedCommands"]
                    .as_array()
                    .is_some_and(|commands| !commands.is_empty())
                {
                    return Err(SandboxError::ExcludedCommands.into());
                }
                if next["enabledPlatforms"]
                    .as_array()
                    .is_some_and(|platforms| {
                        !platforms
                            .iter()
                            .any(|item| item.as_str() == Some(platform.name()))
                    })
                {
                    return Err(SandboxError::ExcludedPlatform.into());
                }
                next["failIfUnavailable"] = json!(true);
                next["allowUnsandboxedCommands"] = json!(false);
            }
            let _: Sandbox =
                serde_json::from_value(next.clone()).map_err(|_| SandboxError::Shape)?;
            settings::replace(config, &target.agent_id, "sandbox", next)
        })
        .await?;
    let mut applied = Applied::new();
    applied.restart_fields.push("sandbox".to_owned());
    let mut result = applied.receipt(&target, None);
    result["live"]["status"] = json!("restartRequired");
    result["isolation"] = json!("notObserved");
    result["reason"] = json!(
        "Native sandbox initialization and required checks run at CLI startup; no live enable was sent"
    );
    Ok(result)
}

fn merge(current: Value, incoming: Value) -> rpc::Result<Value> {
    let mut next = settings::patch(current.clone(), incoming.clone())?;
    for field in ["network", "filesystem"] {
        if let Some(patch) = incoming.get(field) {
            next[field] = settings::patch(
                current.get(field).cloned().unwrap_or_else(|| json!({})),
                patch.clone(),
            )?;
        }
    }
    Ok(next)
}

fn has_null(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(fields) => fields.values().any(has_null),
        Value::Array(values) => values.iter().any(has_null),
        _ => false,
    }
}

fn ensure_supported(platform: Platform, wsl1: bool) -> rpc::Result<()> {
    match platform {
        Platform::Windows => Err(SandboxError::Windows.into()),
        Platform::Wsl if wsl1 => Err(SandboxError::Wsl1.into()),
        Platform::Unknown => Err(SandboxError::Platform.into()),
        _ => Ok(()),
    }
}

async fn platform() -> rpc::Result<(Platform, bool)> {
    if cfg!(target_os = "windows") {
        return Ok((Platform::Windows, false));
    }
    if cfg!(target_os = "macos") {
        return Ok((Platform::Macos, false));
    }
    if !cfg!(target_os = "linux") {
        return Ok((Platform::Unknown, false));
    }
    // Match the native CLI's WSL detection without invoking a shell or probe tool.
    let version = tokio::fs::read_to_string("/proc/version")
        .await
        .map_err(|error| {
            rpc::Error::unavailable(
                "sandbox_platform_probe",
                "Could not read the Linux platform identity",
            )
            .with_data(json!({"ioKind": format!("{:?}", error.kind())}))
        })?;
    let version = version.to_ascii_lowercase();
    let wsl = version.contains("microsoft") || version.contains("wsl");
    let wsl1 = wsl && !version.contains("wsl2") && !version.contains("wsl3");
    Ok((if wsl { Platform::Wsl } else { Platform::Linux }, wsl1))
}
