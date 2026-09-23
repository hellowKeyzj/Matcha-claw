use platform::capability::CapabilityDecisionVerifier;

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use matcha_agent::lifecycle::secret::Secret;
use openclaw::gateway::client::GatewayClientMetadata;
use organization::adapters::loopback::trigger::WebhookToken;
use platform::state_dir::CanonicalStateDir;
use runtime_host::{
    HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig, open_organization_store,
};
use serde::Deserialize;
use zeroize::Zeroize;

const BOOTSTRAP_VERSION: u8 = 1;

pub(crate) struct Bootstrap {
    app_version: String,
    app_log_dir: PathBuf,
    runtime_host_state_dir: PathBuf,
    runtime_host_mcp_executable: PathBuf,
    parent_callback_base_url: String,
    parent_callback_dispatch_token: String,
    provider_credential_resolver: Option<runtime_host::ProviderCredentialResolver>,
    runtime_observation: RuntimeObservationConfig,
    matcha: MatchaConfig,
    open_claw: OpenClawConfig,
    delivery_verification_key: String,
    runtime_host_transport_port: u16,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

pub(crate) struct BootstrapParts {
    pub(crate) host: HostInput,
    pub(crate) verifier: CapabilityDecisionVerifier,
    pub(crate) provider_credential_resolver: Option<runtime_host::ProviderCredentialResolver>,
    pub(crate) webhook_token: WebhookToken,
    pub(crate) runtime_host_transport_port: u16,
}

impl Bootstrap {
    pub(crate) fn into_parts(self) -> Result<BootstrapParts, BootstrapError> {
        let state_dir =
            CanonicalStateDir::provision(&self.open_claw.state_dir).map_err(|_| BootstrapError)?;
        let runtime_host_state_dir =
            provision_runtime_host_state_dir(&self.runtime_host_state_dir)?;
        let webhook_token = super::webhook_token::load_or_create(&runtime_host_state_dir)?;
        let matcha_secret =
            runtime_secret().and_then(|value| Secret::new(value).map_err(|_| BootstrapError))?;
        let open_claw_secret = super::gateway_token::load_or_create(&state_dir)?;
        let metadata =
            GatewayClientMetadata::try_new(self.app_version, std::env::consts::OS.into())
                .map_err(|_| BootstrapError)?;
        let organization_store =
            open_organization_store(&runtime_host_state_dir).map_err(|_| BootstrapError)?;

        let verifier = CapabilityDecisionVerifier::try_new(&self.delivery_verification_key)
            .map_err(|_| BootstrapError)?;
        let runtime_host_transport_port = self.runtime_host_transport_port;
        let sealed_runtime_token = runtime_secret()?;
        let sealed_endpoint = format!("http://127.0.0.1:{runtime_host_transport_port}");
        Ok(BootstrapParts {
            host: HostInput {
                matcha: MatchaAgentInput {
                    bun_executable: self.matcha.bun_executable,
                    entry: self.matcha.entry,
                    working_directory: self.matcha.working_directory,
                    storage_root: self.matcha.storage_root,
                    port: self.matcha.port,
                    #[cfg(windows)]
                    git_bash: self.matcha.git_bash,
                    #[cfg(unix)]
                    guardian_executable: self.guardian_executable.clone(),
                },
                matcha_secret,
                open_claw: OpenClawInput {
                    team_run_mcp_executable: self.runtime_host_mcp_executable,
                    team_run_mcp_state_dir: runtime_host_state_dir.clone(),
                    electron_image: self.open_claw.electron_image,
                    working_directory: self.open_claw.working_directory,
                    openclaw_dir: self.open_claw.openclaw_dir,
                    managed_plugin_root: self.open_claw.managed_plugin_root,
                    companion_skill_source_root: self.open_claw.companion_skill_source_root,
                    subagent_template_dir: self.open_claw.subagent_template_dir,
                    entry: self.open_claw.entry,
                    state_dir,
                    port: self.open_claw.port,
                    sealed_endpoint: Some(sealed_endpoint),
                    sealed_token: Some(sealed_runtime_token),
                    client_metadata: metadata,
                    report_diagnostic: Arc::new(|_| {}),
                    #[cfg(unix)]
                    guardian_executable: self.guardian_executable,
                },
                open_claw_secret,
                organization_store,
                runtime_state_dir: runtime_host_state_dir,
                app_log_dir: self.app_log_dir,
                parent_callback_base_url: self.parent_callback_base_url,
                parent_callback_dispatch_token: self.parent_callback_dispatch_token,
                runtime_observation: self.runtime_observation,
            },
            verifier,
            provider_credential_resolver: self.provider_credential_resolver,
            webhook_token,
            runtime_host_transport_port,
        })
    }
}

pub(crate) fn decode(mut input: Vec<u8>) -> Result<Bootstrap, BootstrapError> {
    let parsed = serde_json::from_slice::<Wire>(&input);
    input.zeroize();
    let wire = parsed.map_err(|_| BootstrapError)?;
    if wire.version != BOOTSTRAP_VERSION {
        return Err(BootstrapError);
    }

    let app_version = non_empty(wire.app_version)?;
    let runtime_host_state_dir = absolute(wire.runtime_host_state_dir)?;
    let runtime_host_mcp_executable = absolute(wire.runtime_host_mcp_executable)?;
    let parent_callback_base_url = non_empty(wire.parent_callback_base_url)?;
    let parent_callback_dispatch_token = non_empty(wire.parent_callback_dispatch_token)?;
    let delivery_verification_key = non_empty(wire.delivery_verification_key)?;
    let provider_credential_resolver = wire
        .provider_credential_resolver
        .map(|value| {
            runtime_host::ProviderCredentialResolver::try_new(value.endpoint, value.authorization)
        })
        .transpose()
        .map_err(|_| BootstrapError)?;
    let runtime_observation = runtime_observation(wire.runtime_observation)?;
    let runtime_host_transport_port = port(wire.runtime_host_transport_port)?;
    let matcha = MatchaConfig {
        bun_executable: absolute(wire.matcha.bun_executable)?,
        entry: absolute(wire.matcha.entry)?,
        working_directory: absolute(wire.matcha.working_directory)?,
        storage_root: absolute(wire.matcha.storage_root)?,
        port: port(wire.matcha.port)?,
        #[cfg(windows)]
        git_bash: absolute(wire.matcha.git_bash)?,
    };
    let open_claw = OpenClawConfig {
        electron_image: absolute(wire.open_claw.electron_image)?,
        working_directory: absolute(wire.open_claw.working_directory)?,
        openclaw_dir: absolute(wire.open_claw.openclaw_dir)?,
        managed_plugin_root: absolute(wire.open_claw.managed_plugin_root)?,
        companion_skill_source_root: absolute(wire.open_claw.companion_skill_source_root)?,
        subagent_template_dir: absolute(wire.open_claw.subagent_template_dir)?,
        entry: absolute(wire.open_claw.entry)?,
        state_dir: absolute(wire.open_claw.state_dir)?,
        port: port(wire.open_claw.port)?,
    };
    if [runtime_host_transport_port, matcha.port, open_claw.port]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != 3
    {
        return Err(BootstrapError);
    }

    Ok(Bootstrap {
        app_version,
        app_log_dir: absolute(wire.app_log_dir)?,
        runtime_host_state_dir,
        runtime_host_mcp_executable,
        parent_callback_base_url,
        parent_callback_dispatch_token,
        provider_credential_resolver,
        runtime_observation,
        runtime_host_transport_port,
        matcha,
        open_claw,
        delivery_verification_key,
        #[cfg(unix)]
        guardian_executable: absolute(wire.guardian_executable)?,
    })
}

struct MatchaConfig {
    bun_executable: PathBuf,
    entry: PathBuf,
    working_directory: PathBuf,
    storage_root: PathBuf,
    port: u16,
    #[cfg(windows)]
    git_bash: PathBuf,
}

struct OpenClawConfig {
    electron_image: PathBuf,
    working_directory: PathBuf,
    openclaw_dir: PathBuf,
    companion_skill_source_root: PathBuf,
    managed_plugin_root: PathBuf,
    subagent_template_dir: PathBuf,
    entry: PathBuf,
    state_dir: PathBuf,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wire {
    version: u8,
    app_version: String,
    app_log_dir: String,
    runtime_host_state_dir: String,
    runtime_host_mcp_executable: String,
    parent_callback_base_url: String,
    parent_callback_dispatch_token: String,
    #[serde(default)]
    provider_credential_resolver: Option<ProviderCredentialResolverWire>,
    #[serde(default)]
    runtime_observation: RuntimeObservationWire,
    delivery_verification_key: String,
    runtime_host_transport_port: u16,
    matcha: MatchaWire,
    open_claw: OpenClawWire,
    #[cfg(unix)]
    guardian_executable: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeObservationWire {
    #[serde(default)]
    mode: RuntimeObservationModeWire,
    #[serde(default)]
    archive: bool,
    #[serde(default)]
    diagnostic_ttl_ms: Option<u64>,
}

impl Default for RuntimeObservationWire {
    fn default() -> Self {
        Self {
            mode: RuntimeObservationModeWire::Off,
            archive: false,
            diagnostic_ttl_ms: None,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RuntimeObservationModeWire {
    Off,
    Normal,
    Diagnostic,
}

impl Default for RuntimeObservationModeWire {
    fn default() -> Self {
        Self::Off
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderCredentialResolverWire {
    endpoint: String,
    authorization: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatchaWire {
    bun_executable: String,
    entry: String,
    working_directory: String,
    storage_root: String,
    port: u16,
    #[cfg(windows)]
    git_bash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenClawWire {
    electron_image: String,
    working_directory: String,
    openclaw_dir: String,
    companion_skill_source_root: String,
    managed_plugin_root: String,
    subagent_template_dir: String,
    entry: String,
    state_dir: String,
    port: u16,
}

fn runtime_observation(
    wire: RuntimeObservationWire,
) -> Result<RuntimeObservationConfig, BootstrapError> {
    match wire.mode {
        RuntimeObservationModeWire::Off => Ok(RuntimeObservationConfig::off()),
        RuntimeObservationModeWire::Normal => Ok(RuntimeObservationConfig::normal(wire.archive)),
        RuntimeObservationModeWire::Diagnostic => {
            let ttl = wire
                .diagnostic_ttl_ms
                .filter(|value| *value != 0)
                .ok_or(BootstrapError)?;
            Ok(RuntimeObservationConfig::diagnostic(
                wire.archive,
                Duration::from_millis(ttl),
            ))
        }
    }
}

fn port(value: u16) -> Result<u16, BootstrapError> {
    (value != 0).then_some(value).ok_or(BootstrapError)
}

fn provision_runtime_host_state_dir(path: &Path) -> Result<PathBuf, BootstrapError> {
    foundation::storage::provision_private_directory(path).map_err(|_| BootstrapError)?;
    Ok(path.to_path_buf())
}

fn absolute(value: String) -> Result<PathBuf, BootstrapError> {
    if value.contains('\0') {
        return Err(BootstrapError);
    }

    let path = PathBuf::from(value);
    path.is_absolute().then_some(path).ok_or(BootstrapError)
}

fn non_empty(value: String) -> Result<String, BootstrapError> {
    (!value.trim().is_empty() && !value.contains('\0'))
        .then_some(value)
        .ok_or(BootstrapError)
}

fn runtime_secret() -> Result<String, BootstrapError> {
    let mut bytes = [0_u8; 48];
    getrandom::fill(&mut bytes).map_err(|_| BootstrapError)?;
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    bytes.zeroize();
    Ok(encoded)
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct BootstrapError;

impl fmt::Display for BootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("runtime-host bootstrap configuration is invalid")
    }
}

impl std::error::Error for BootstrapError {}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
