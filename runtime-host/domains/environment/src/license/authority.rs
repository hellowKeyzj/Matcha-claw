use std::{env, fmt, time::Duration};

use reqwest::{Client, header};
use serde::{Deserialize, Serialize};

use super::{LicenseDeviceIdentity, LicenseKey};

pub const BUILTIN_LICENSE_ENDPOINT: &str = "https://www.supercnm.top/claw-license/activate";
pub const BUILTIN_LICENSE_PRODUCT: &str = "matchaclaw-desktop";
pub const DEFAULT_LICENSE_TIMEOUT_MS: u64 = 8_000;
pub const DEFAULT_OFFLINE_GRACE_HOURS: u64 = 72;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LicensePolicyMode {
    OnlineRequired,
    OnlineOptional,
    OfflineLocal,
}

impl Default for LicensePolicyMode {
    fn default() -> Self {
        Self::OnlineRequired
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct LicenseConfig {
    endpoint: Option<String>,
    product: String,
    policy_mode: LicensePolicyMode,
    timeout_ms: u64,
    offline_grace_hours: u64,
    allowlist_env: String,
}

impl fmt::Debug for LicenseConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LicenseConfig")
            .field("endpoint", &self.endpoint)
            .field("product", &self.product)
            .field("policy_mode", &self.policy_mode)
            .field("timeout_ms", &self.timeout_ms)
            .field("offline_grace_hours", &self.offline_grace_hours)
            .finish_non_exhaustive()
    }
}

impl Default for LicenseConfig {
    fn default() -> Self {
        Self {
            endpoint: Some(BUILTIN_LICENSE_ENDPOINT.to_owned()),
            product: BUILTIN_LICENSE_PRODUCT.to_owned(),
            policy_mode: LicensePolicyMode::OnlineRequired,
            timeout_ms: DEFAULT_LICENSE_TIMEOUT_MS,
            offline_grace_hours: DEFAULT_OFFLINE_GRACE_HOURS,
            allowlist_env: String::new(),
        }
    }
}

impl LicenseConfig {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let endpoint = env::var("MATCHACLAW_LICENSE_ENDPOINT")
            .ok()
            .and_then(|value| {
                let value = value.trim().to_owned();
                (!value.is_empty()).then_some(value)
            })
            .or(defaults.endpoint.clone());
        let policy_mode = env::var("MATCHACLAW_LICENSE_MODE")
            .ok()
            .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
                "online-required" => Some(LicensePolicyMode::OnlineRequired),
                "online-optional" => Some(LicensePolicyMode::OnlineOptional),
                "offline-local" => Some(LicensePolicyMode::OfflineLocal),
                _ => None,
            })
            .unwrap_or(defaults.policy_mode);
        let product = env::var("MATCHACLAW_LICENSE_PRODUCT")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or(defaults.product);
        let timeout_ms = positive_env("MATCHACLAW_LICENSE_TIMEOUT_MS", defaults.timeout_ms);
        let offline_grace_hours = positive_env(
            "MATCHACLAW_LICENSE_OFFLINE_GRACE_HOURS",
            defaults.offline_grace_hours,
        );
        Self {
            endpoint,
            product,
            policy_mode,
            timeout_ms,
            offline_grace_hours,
            allowlist_env: env::var("MATCHACLAW_LICENSE_KEYS").unwrap_or_default(),
        }
    }

    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }

    pub fn product(&self) -> &str {
        &self.product
    }

    pub const fn policy_mode(&self) -> LicensePolicyMode {
        self.policy_mode
    }

    pub const fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    pub const fn offline_grace_hours(&self) -> u64 {
        self.offline_grace_hours
    }

    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        let endpoint = endpoint.into().trim().to_owned();
        self.endpoint = (!endpoint.is_empty()).then_some(endpoint);
        self
    }

    pub fn without_endpoint(mut self) -> Self {
        self.endpoint = None;
        self
    }

    pub fn with_product(mut self, product: impl Into<String>) -> Self {
        self.product = product.into().trim().to_owned();
        self
    }

    pub const fn with_policy_mode(mut self, policy_mode: LicensePolicyMode) -> Self {
        self.policy_mode = policy_mode;
        self
    }

    pub const fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    pub const fn with_offline_grace_hours(mut self, hours: u64) -> Self {
        self.offline_grace_hours = hours;
        self
    }

    pub fn with_allowlist_env(mut self, allowlist_env: impl Into<String>) -> Self {
        self.allowlist_env = allowlist_env.into();
        self
    }

    pub(crate) fn allowlist_contains(&self, key: &LicenseKey) -> bool {
        let normalized = key.as_str();
        self.allowlist_env
            .split(|character: char| character.is_ascii_whitespace() || ",;".contains(character))
            .map(str::trim)
            .map(str::to_ascii_uppercase)
            .any(|candidate| candidate == normalized)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LicenseClientContext {
    app_version: String,
    platform: String,
    machine_name: String,
}

impl Default for LicenseClientContext {
    fn default() -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: env::consts::OS.to_owned(),
            machine_name: "unknown".to_owned(),
        }
    }
}

impl LicenseClientContext {
    pub fn new(
        app_version: impl Into<String>,
        platform: impl Into<String>,
        machine_name: impl Into<String>,
    ) -> Self {
        Self {
            app_version: app_version.into(),
            platform: platform.into(),
            machine_name: machine_name.into(),
        }
    }

    pub fn app_version(&self) -> &str {
        &self.app_version
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }

    pub fn machine_name(&self) -> &str {
        &self.machine_name
    }
}

pub(crate) struct LicenseAuthorityClient {
    client: Client,
    endpoint: String,
    product: String,
    context: LicenseClientContext,
}

impl LicenseAuthorityClient {
    pub(crate) fn new(
        config: &LicenseConfig,
        context: LicenseClientContext,
    ) -> Result<Self, AuthorityError> {
        let endpoint = config.endpoint().ok_or(AuthorityError::Unconfigured)?;
        let parsed = endpoint
            .parse::<reqwest::Url>()
            .map_err(|_| AuthorityError::InvalidConfiguration)?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(AuthorityError::InvalidConfiguration);
        }
        let client = Client::builder()
            .timeout(Duration::from_millis(config.timeout_ms().max(1)))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AuthorityError::Unavailable)?;
        Ok(Self {
            client,
            endpoint: endpoint.to_owned(),
            product: config.product().to_owned(),
            context,
        })
    }

    pub(crate) async fn validate(
        &self,
        key: &LicenseKey,
        identity: &LicenseDeviceIdentity,
    ) -> Result<AuthorityValidation, AuthorityError> {
        let payload = AuthorityRequest {
            license_key: key.as_str(),
            product: &self.product,
            device_id: identity.as_str(),
            install_id: identity.as_str(),
            app_version: &self.context.app_version,
            platform: &self.context.platform,
            machine_name: &self.context.machine_name,
        };
        let body = serde_json::to_vec(&payload).map_err(|_| AuthorityError::Unavailable)?;
        let response = self
            .client
            .post(&self.endpoint)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| AuthorityError::Network)?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| AuthorityError::Network)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(AuthorityError::InvalidResponse);
        }
        let parsed = serde_json::from_slice::<AuthorityResponse>(&bytes)
            .map_err(|_| AuthorityError::InvalidResponse)?;
        let valid = parsed.valid.unwrap_or(false);
        if !status.is_success() && parsed.code.is_none() {
            return Ok(AuthorityValidation {
                valid: false,
                code: Some(format!("http_{}", status.as_u16())),
                expires_at: None,
                refresh_after_sec: None,
                offline_grace_hours: None,
            });
        }
        Ok(AuthorityValidation {
            valid,
            code: parsed.code,
            expires_at: parsed.expires_at,
            refresh_after_sec: parsed.refresh_after_sec,
            offline_grace_hours: parsed.offline_grace_hours,
        })
    }
}

#[derive(Serialize)]
struct AuthorityRequest<'a> {
    #[serde(rename = "licenseKey")]
    license_key: &'a str,
    product: &'a str,
    #[serde(rename = "deviceId")]
    device_id: &'a str,
    #[serde(rename = "installId")]
    install_id: &'a str,
    #[serde(rename = "appVersion")]
    app_version: &'a str,
    platform: &'a str,
    #[serde(rename = "machineName")]
    machine_name: &'a str,
}

#[derive(Deserialize)]
struct AuthorityResponse {
    valid: Option<bool>,
    code: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    #[serde(rename = "refreshAfterSec")]
    refresh_after_sec: Option<u64>,
    #[serde(rename = "offlineGraceHours")]
    offline_grace_hours: Option<u64>,
}

pub(crate) struct AuthorityValidation {
    pub(crate) valid: bool,
    pub(crate) code: Option<String>,
    pub(crate) expires_at: Option<String>,
    pub(crate) refresh_after_sec: Option<u64>,
    pub(crate) offline_grace_hours: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AuthorityError {
    Unconfigured,
    InvalidConfiguration,
    Unavailable,
    Network,
    InvalidResponse,
}

fn positive_env(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}
