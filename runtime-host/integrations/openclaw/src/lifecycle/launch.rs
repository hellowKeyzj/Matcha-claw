use std::{
    ffi::{OsStr, OsString},
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
};

#[cfg(windows)]
use foundation::process::windows_system_root;
use foundation::process::{
    LaunchAttemptFuture, LaunchAttemptMaterializer, LaunchMaterializationFailure, LaunchSpec,
    StdioMode, StdioSpec, supervision::LaunchFailure,
};
use zeroize::Zeroizing;

use crate::gateway::auth::GatewaySecret;

use platform::state_dir::CanonicalStateDir;

use super::channel_bootstrap;

mod attempt;
mod stale_gateway_lock;

use attempt::PreparedAttempt;

const ELECTRON_RUN_AS_NODE: &str = "ELECTRON_RUN_AS_NODE";
const PATH_ENV: &str = "PATH";
#[cfg(windows)]
const SYSTEM_ROOT: &str = "SystemRoot";
const OPENCLAW_GATEWAY_PORT: &str = "OPENCLAW_GATEWAY_PORT";
const OPENCLAW_GATEWAY_TOKEN: &str = "OPENCLAW_GATEWAY_TOKEN";
const OPENCLAW_EXEC_SHELL_SNAPSHOT: &str = "OPENCLAW_EXEC_SHELL_SNAPSHOT";
const OPENCLAW_STATE_DIR: &str = "OPENCLAW_STATE_DIR";
const OPENCLAW_CONFIG_DIR: &str = "OPENCLAW_CONFIG_DIR";
const MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: &str = "MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT";
const MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: &str = "MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN";
const MATCHA_SEALED_ENDPOINT: &str = "MATCHA_SEALED_ENDPOINT";
const MATCHA_SEALED_TOKEN: &str = "MATCHA_SEALED_TOKEN";
const MATCHA_SEALED_RUNTIME: &str = "MATCHA_SEALED_RUNTIME";
const OPENCLAW_SEALED_RUNTIME: &str = "openclaw";
const OPENCLAW_NO_RESPAWN: &str = "OPENCLAW_NO_RESPAWN";
const OPENCLAW_DISABLE_BONJOUR: &str = "OPENCLAW_DISABLE_BONJOUR";
const OPENCLAW_SKIP_CHANNELS: &str = "OPENCLAW_SKIP_CHANNELS";
const CLAWDBOT_SKIP_CHANNELS: &str = "CLAWDBOT_SKIP_CHANNELS";
const UV_PYTHON_INSTALL_MIRROR: &str = "UV_PYTHON_INSTALL_MIRROR";
const UV_PYTHON_INSTALL_MIRROR_URL: &str =
    "https://registry.npmmirror.com/-/binary/python-build-standalone/";
const UV_INDEX_URL: &str = "UV_INDEX_URL";
const UV_INDEX_MIRROR_URL: &str = "https://pypi.tuna.tsinghua.edu.cn/simple/";
const OPENCLAW_PROXY_URL: &str = "OPENCLAW_PROXY_URL";
const PROXY_ENV_KEYS: [&str; 9] = [
    OPENCLAW_PROXY_URL,
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];
const SYSTEMD_SUPERVISOR_ENV_KEYS: [&str; 4] = [
    "OPENCLAW_SYSTEMD_UNIT",
    "INVOCATION_ID",
    "SYSTEMD_EXEC_PID",
    "JOURNAL_STREAM",
];
const NON_LEGACY_LAUNCH_ENV_KEYS: [&str; 7] = [
    "OPENCLAW_SEALED_LAUNCH",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_DIR",
    "MATCHACLAW_OPENCLAW_CONFIG_FD",
    "MATCHACLAW_OPENCLAW_TLS_CERT_FD",
    "MATCHACLAW_OPENCLAW_TLS_KEY_FD",
];
const CANONICAL_CONFIG_FILE: &str = "openclaw.json";
const OPENCLAW_STDIO: StdioSpec =
    StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped);

#[derive(Clone)]
pub struct OpenClawLaunchInput {
    pub electron_image: PathBuf,
    pub working_directory: PathBuf,
    pub openclaw_dir: PathBuf,
    pub entry: PathBuf,
    pub state_dir: CanonicalStateDir,
    pub port: u16,
    pub secret: Arc<GatewaySecret>,
}

impl OpenClawLaunchInput {
    pub fn try_into_launch_factory(self) -> Result<LaunchFactory, LaunchError> {
        self.try_into_launch_factory_with_sealed_runtime_host(None)
    }

    pub fn try_into_launch_factory_with_sealed_runtime_host(
        self,
        sealed_runtime_host: Option<SealedRuntimeHost>,
    ) -> Result<LaunchFactory, LaunchError> {
        validate_input(&self)?;
        validate_sealed_runtime_host(sealed_runtime_host.as_ref())?;
        let factory = LaunchFactory {
            electron_image: self.electron_image,
            working_directory: self.working_directory,
            openclaw_dir: self.openclaw_dir,
            entry: self.entry,
            state_dir: self.state_dir,
            port: self.port,
            secret: self.secret,
            sealed_runtime_host,
        };
        factory.validate_spec()?;
        #[cfg(windows)]
        crate::native_config::config_store::OpenClawConfigStore::new(factory.state_dir.clone())
            .ensure_canonical_document()
            .map_err(|_| LaunchError::InvalidInput)?;
        Ok(factory)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SealedRuntimeHost {
    pub endpoint: String,
    pub token: String,
}

impl fmt::Debug for SealedRuntimeHost {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("SealedRuntimeHost")
            .field("endpoint", &self.endpoint)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

pub struct LaunchFactory {
    electron_image: PathBuf,
    working_directory: PathBuf,
    openclaw_dir: PathBuf,
    entry: PathBuf,
    state_dir: CanonicalStateDir,
    port: u16,
    secret: Arc<GatewaySecret>,
    sealed_runtime_host: Option<SealedRuntimeHost>,
}

impl LaunchFactory {
    fn prepare_attempt(&mut self) -> Result<PreparedAttempt, LaunchFailure> {
        stale_gateway_lock::remove_stale_gateway_lock_artifacts(&self.state_dir)
            .map_err(|_| LaunchFailure::ResourceUnavailable)?;
        let skip_channels = channel_bootstrap::skip_channels(&self.state_dir)
            .map_err(|_| LaunchFailure::ResourceUnavailable)?;
        #[cfg(unix)]
        let spec = self
            .build_spec(skip_channels)
            .map_err(|_| LaunchFailure::PlatformRejected)?;
        #[cfg(windows)]
        let spec = self
            .build_spec(skip_channels)
            .map_err(|_| LaunchFailure::PlatformRejected)?;
        Ok(PreparedAttempt::new(spec, self.state_dir.clone()))
    }

    fn validate_spec(&self) -> Result<(), LaunchError> {
        self.build_spec(false).map(|_| ())
    }

    #[cfg(unix)]
    fn build_spec(&self, skip_channels: bool) -> Result<LaunchSpec, LaunchError> {
        self.build_spec_with_environment(skip_channels)
    }

    #[cfg(windows)]
    fn build_spec(&self, skip_channels: bool) -> Result<LaunchSpec, LaunchError> {
        self.build_spec_with_environment(skip_channels)
    }

    fn build_spec_with_environment(&self, skip_channels: bool) -> Result<LaunchSpec, LaunchError> {
        let gateway_port = OsString::from(self.port.to_string());
        let gateway_token = gateway_token_os_string(&self.secret)?;
        let arguments = [
            self.entry.clone().into_os_string(),
            OsString::from("gateway"),
            OsString::from("--port"),
            gateway_port.clone(),
            OsString::from("--token"),
            gateway_token.clone(),
            OsString::from("--allow-unconfigured"),
        ];
        let mut public_environment = base_launch_environment(&self.working_directory)?;
        public_environment.extend([
            (OPENCLAW_GATEWAY_PORT.into(), gateway_port.clone()),
            (OPENCLAW_GATEWAY_TOKEN.into(), gateway_token.clone()),
            (OPENCLAW_EXEC_SHELL_SNAPSHOT.into(), "0".into()),
            (OPENCLAW_STATE_DIR.into(), self.state_dir.as_path().into()),
            (OPENCLAW_CONFIG_DIR.into(), self.state_dir.as_path().into()),
            (MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT.into(), gateway_port),
            (MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN.into(), gateway_token),
            (OPENCLAW_NO_RESPAWN.into(), "1".into()),
            (OPENCLAW_DISABLE_BONJOUR.into(), "1".into()),
        ]);
        if let Some(sealed_runtime_host) = &self.sealed_runtime_host {
            public_environment.extend([
                (
                    MATCHA_SEALED_ENDPOINT.into(),
                    sealed_runtime_host.endpoint.clone().into(),
                ),
                (
                    MATCHA_SEALED_TOKEN.into(),
                    sealed_runtime_host.token.clone().into(),
                ),
                (MATCHA_SEALED_RUNTIME.into(), OPENCLAW_SEALED_RUNTIME.into()),
            ]);
        }
        if skip_channels {
            public_environment.push((OPENCLAW_SKIP_CHANNELS.into(), "1".into()));
            public_environment.push((CLAWDBOT_SKIP_CHANNELS.into(), "1".into()));
        }

        LaunchSpec::try_new(
            self.electron_image.clone(),
            self.openclaw_dir.clone(),
            arguments,
            public_environment,
            OPENCLAW_STDIO,
        )
        .map_err(|_| LaunchError::InvalidInput)
    }
}

fn gateway_token_os_string(secret: &GatewaySecret) -> Result<OsString, LaunchError> {
    let mut token = Zeroizing::new(Vec::new());
    secret.append_json_string(&mut token);
    let value: String = serde_json::from_slice(&token).map_err(|_| LaunchError::InvalidInput)?;
    Ok(value.into())
}

fn base_launch_environment(
    working_directory: &Path,
) -> Result<Vec<(OsString, OsString)>, LaunchError> {
    let mut environment = sanitize_inherited_environment(std::env::vars_os());
    ensure_electron_run_as_node(&mut environment);
    patch_path_environment(&mut environment, working_directory);
    #[cfg(windows)]
    {
        environment.retain(|(key, _)| !key.eq_ignore_ascii_case(OsStr::new(SYSTEM_ROOT)));
        environment.push((
            SYSTEM_ROOT.into(),
            windows_system_root().map_err(|_| LaunchError::InvalidInput)?,
        ));
    }
    environment.extend(uv_environment());
    Ok(environment)
}

fn sanitize_inherited_environment(
    source: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let mut environment = Vec::new();
    for (key, value) in source {
        if key.eq_ignore_ascii_case(OsStr::new("NODE_OPTIONS"))
            || SYSTEMD_SUPERVISOR_ENV_KEYS
                .iter()
                .any(|denied| key.eq_ignore_ascii_case(OsStr::new(denied)))
            || NON_LEGACY_LAUNCH_ENV_KEYS
                .iter()
                .any(|denied| key.eq_ignore_ascii_case(OsStr::new(denied)))
            || is_managed_launch_env_key(&key)
            || is_proxy_env_key(&key)
            || environment
                .iter()
                .any(|(existing, _): &(OsString, OsString)| existing.eq_ignore_ascii_case(&key))
        {
            continue;
        }
        environment.push((key, value));
    }
    environment
}

fn is_managed_launch_env_key(key: &OsStr) -> bool {
    [
        ELECTRON_RUN_AS_NODE,
        OPENCLAW_GATEWAY_PORT,
        OPENCLAW_GATEWAY_TOKEN,
        OPENCLAW_EXEC_SHELL_SNAPSHOT,
        OPENCLAW_STATE_DIR,
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT,
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN,
        MATCHA_SEALED_ENDPOINT,
        MATCHA_SEALED_TOKEN,
        MATCHA_SEALED_RUNTIME,
        OPENCLAW_NO_RESPAWN,
        OPENCLAW_DISABLE_BONJOUR,
        OPENCLAW_SKIP_CHANNELS,
        CLAWDBOT_SKIP_CHANNELS,
        UV_PYTHON_INSTALL_MIRROR,
        UV_INDEX_URL,
        OPENCLAW_PROXY_URL,
    ]
    .iter()
    .any(|managed| key.eq_ignore_ascii_case(OsStr::new(managed)))
}

fn is_proxy_env_key(key: &OsStr) -> bool {
    PROXY_ENV_KEYS
        .iter()
        .any(|proxy_key| key.eq_ignore_ascii_case(OsStr::new(proxy_key)))
}

fn ensure_electron_run_as_node(environment: &mut Vec<(OsString, OsString)>) {
    environment.push((ELECTRON_RUN_AS_NODE.into(), "1".into()));
}

fn patch_path_environment(environment: &mut Vec<(OsString, OsString)>, working_directory: &Path) {
    let paths = [
        cli_path(working_directory),
        bundled_bin_path(working_directory),
    ];
    if paths.iter().all(Option::is_none) {
        return;
    }
    let inherited_path = select_path_environment(environment.iter().cloned(), cfg!(windows));
    let (key, mut current) =
        inherited_path.unwrap_or_else(|| (preferred_path_key(), OsString::new()));
    for path in paths.into_iter().rev().flatten() {
        current = prepend_path(&path, &current);
    }
    environment.retain(|(existing, _)| !existing.eq_ignore_ascii_case(OsStr::new(PATH_ENV)));
    environment.push((key, current));
}

fn uv_environment() -> [(OsString, OsString); 2] {
    [
        (
            UV_PYTHON_INSTALL_MIRROR.into(),
            UV_PYTHON_INSTALL_MIRROR_URL.into(),
        ),
        (UV_INDEX_URL.into(), UV_INDEX_MIRROR_URL.into()),
    ]
}

fn cli_path(working_directory: &Path) -> Option<PathBuf> {
    let packaged = working_directory.join("cli");
    if packaged.is_dir() {
        return Some(packaged);
    }

    let development = working_directory.join("node_modules").join(".bin");
    development.is_dir().then_some(development)
}

fn bundled_bin_path(working_directory: &Path) -> Option<PathBuf> {
    let packaged = working_directory.join("bin");
    if packaged.is_dir() {
        return Some(packaged);
    }

    let target = bundled_target_name()?;
    let development = working_directory.join("resources").join("bin").join(target);
    development.is_dir().then_some(development)
}

fn bundled_target_name() -> Option<String> {
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("{platform}-{architecture}"))
}

fn select_path_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
    windows: bool,
) -> Option<(OsString, OsString)> {
    let mut selected: Option<(OsString, OsString)> = None;
    for (key, value) in environment {
        if !key.eq_ignore_ascii_case(OsStr::new(PATH_ENV)) {
            continue;
        }
        let should_replace = selected.as_ref().is_none_or(|(selected_key, _)| {
            path_key_priority(&key, windows) < path_key_priority(selected_key.as_os_str(), windows)
        });
        if should_replace {
            selected = Some((key, value));
        }
    }
    selected
}

fn path_key_priority(key: &OsStr, windows: bool) -> u8 {
    if windows {
        if key == OsStr::new("Path") {
            0
        } else if key == OsStr::new(PATH_ENV) {
            1
        } else {
            2
        }
    } else if key == OsStr::new(PATH_ENV) {
        0
    } else {
        1
    }
}

fn preferred_path_key() -> OsString {
    if cfg!(windows) {
        OsString::from("Path")
    } else {
        OsString::from(PATH_ENV)
    }
}

fn prepend_path(entry: &Path, current: &OsStr) -> OsString {
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    if current.is_empty() {
        entry.as_os_str().to_owned()
    } else {
        let mut value = entry.as_os_str().to_owned();
        value.push(delimiter);
        value.push(current);
        value
    }
}

impl LaunchAttemptMaterializer for LaunchFactory {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let prepared = match self.prepare_attempt() {
            Ok(prepared) => prepared,
            Err(error) => {
                return Box::pin(async move { Err(LaunchMaterializationFailure::new(error)) });
            }
        };
        Box::pin(async move { prepared.materialize() })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchError {
    InvalidInput,
}

impl fmt::Display for LaunchError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("OpenClaw launch input is invalid")
    }
}

impl std::error::Error for LaunchError {}

fn validate_input(input: &OpenClawLaunchInput) -> Result<(), LaunchError> {
    if input.port == 0
        || !input.electron_image.is_absolute()
        || !input.working_directory.is_absolute()
        || !input.openclaw_dir.is_absolute()
        || !input.entry.is_absolute()
    {
        return Err(LaunchError::InvalidInput);
    }
    let state_dir = input.state_dir.as_path();
    if state_dir.join(CANONICAL_CONFIG_FILE).to_str().is_none() {
        return Err(LaunchError::InvalidInput);
    }
    Ok(())
}

fn validate_sealed_runtime_host(
    sealed_runtime_host: Option<&SealedRuntimeHost>,
) -> Result<(), LaunchError> {
    let Some(sealed_runtime_host) = sealed_runtime_host else {
        return Ok(());
    };
    if sealed_runtime_host.endpoint.is_empty() || sealed_runtime_host.token.is_empty() {
        return Err(LaunchError::InvalidInput);
    }
    Ok(())
}

#[cfg(test)]
#[path = "launch/tests.rs"]
mod tests;
