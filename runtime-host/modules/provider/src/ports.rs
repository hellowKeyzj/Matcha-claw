use std::{collections::BTreeSet, fmt, future::Future, pin::Pin, time::Duration};

use connectors::{
    ConnectorSecretAuthorityPortError, ConnectorSecretRef, ConnectorSecretResolution,
    ConnectorSecretResolutionMetadata, ConnectorSecretResolverPort, ConnectorSecretSourceStatus,
    ConnectorSecretValue,
};

use crate::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountId, ProviderModelCatalog,
    ProviderRouting,
};

pub type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ProviderRuntimeDirectory: Send + Sync {
    fn provider_config_ops(&self) -> Vec<&dyn ProviderConfigOps>;
    fn provider_model_discovery_ops(&self) -> Option<&dyn ProviderModelDiscoveryOps>;
    fn provider_runtime_identity_ops(&self) -> Option<&dyn ProviderRuntimeIdentityOps>;
    fn provider_private_projection_ops(&self) -> Option<&dyn ProviderPrivateProjectionOps>;
}

pub trait ProviderConfigOps: Send + Sync {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: ProviderNativeConfigurationCommand<'a>,
    ) -> ProviderFuture<'a, ProviderNativeConfigurationEffect>;
}

pub trait ProviderModelDiscoveryOps: Send + Sync {
    fn discover_provider_models<'a>(
        &'a self,
        account: &'a ProviderAccount,
        identity: &'a ProviderRuntimeIdentity,
    ) -> ProviderFuture<'a, ProviderModelDiscoveryPortOutcome>;
}

pub trait ProviderRuntimeIdentityOps: Send + Sync {
    fn runtime_identities(
        &self,
        accounts: &[ProviderAccount],
    ) -> Result<Vec<ProviderRuntimeIdentity>, ()>;

    fn runtime_identity(&self, account: &ProviderAccount) -> Result<ProviderRuntimeIdentity, ()>;

    fn runtime_model_ref(
        &self,
        identity: &ProviderRuntimeIdentity,
        kind: crate::ProviderAccountKind,
        model_id: &str,
    ) -> String;
}

pub trait ProviderPrivateProjectionOps: Send + Sync {
    fn prepare_private_projection(
        &self,
        command: ProviderPrivateProjectionCommand<'_>,
    ) -> ProviderPrivateProjectionEffect;
}

pub struct ProviderNativeConfigurationCommand<'a> {
    pub accounts: &'a [ProviderAccount],
    pub models: &'a ProviderModelCatalog,
    pub routing: Option<&'a ProviderRouting>,
    pub retired: &'a [ProviderAccount],
    pub required_auth_accounts: &'a BTreeSet<ProviderAccountId>,
    pub auth_state_refresh_required: bool,
    pub now_millis: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderNativeConfigurationEffect {
    Evidence(ProviderNativeConfigurationEvidence),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderNativeConfigurationEvidence {
    changed: bool,
    applied: ProviderAppliedStatus,
    observed: ProviderObservedStatus,
    diagnostic: Option<ProviderNativeConfigurationDiagnostic>,
}

impl ProviderNativeConfigurationEvidence {
    pub fn new(
        changed: bool,
        applied: ProviderAppliedStatus,
        observed: ProviderObservedStatus,
    ) -> Self {
        Self {
            changed,
            applied,
            observed,
            diagnostic: None,
        }
    }

    pub fn with_diagnostic(
        changed: bool,
        applied: ProviderAppliedStatus,
        observed: ProviderObservedStatus,
        diagnostic: ProviderNativeConfigurationDiagnostic,
    ) -> Self {
        Self {
            changed,
            applied,
            observed,
            diagnostic: Some(diagnostic),
        }
    }

    pub const fn changed(&self) -> bool {
        self.changed
    }

    pub const fn applied(&self) -> ProviderAppliedStatus {
        self.applied
    }

    pub const fn observed(&self) -> ProviderObservedStatus {
        self.observed
    }

    pub fn diagnostic(&self) -> Option<&ProviderNativeConfigurationDiagnostic> {
        self.diagnostic.as_ref()
    }
}

impl ProviderNativeConfigurationEffect {
    pub fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Evidence(left), Self::Evidence(right)) => Self::Evidence(left.merge(right)),
            (Self::Unavailable, effect) | (effect, Self::Unavailable) => effect,
        }
    }
}

impl ProviderNativeConfigurationEvidence {
    fn merge(self, other: Self) -> Self {
        Self {
            changed: self.changed || other.changed,
            applied: self.applied.merge(other.applied),
            observed: self.observed.merge(other.observed),
            diagnostic: self.diagnostic.or(other.diagnostic),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAppliedStatus {
    Confirmed,
    Unknown,
}

impl ProviderAppliedStatus {
    const fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Confirmed, Self::Confirmed) => Self::Confirmed,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderObservedStatus {
    Matches,
    Mismatch,
    Unavailable,
}

impl ProviderObservedStatus {
    const fn merge(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unavailable, value) | (value, Self::Unavailable) => value,
            (Self::Matches, Self::Matches) => Self::Matches,
            _ => Self::Mismatch,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderNativeConfigurationDiagnostic {
    phase: String,
    reason: String,
    config_path: String,
    method: Option<String>,
    expected_path: Option<String>,
    detail: Option<String>,
}

impl ProviderNativeConfigurationDiagnostic {
    pub fn new(
        phase: impl Into<String>,
        reason: impl Into<String>,
        config_path: impl Into<String>,
        method: Option<String>,
        expected_path: Option<String>,
        detail: Option<String>,
    ) -> Self {
        Self {
            phase: phase.into(),
            reason: reason.into(),
            config_path: config_path.into(),
            method,
            expected_path,
            detail,
        }
    }

    pub fn phase(&self) -> &str {
        &self.phase
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn config_path(&self) -> &str {
        &self.config_path
    }

    pub fn method(&self) -> Option<&str> {
        self.method.as_deref()
    }

    pub fn expected_path(&self) -> Option<&str> {
        self.expected_path.as_deref()
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderModelDiscoveryPortOutcome {
    Discovered(Vec<DiscoveredProviderModel>),
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredProviderModel {
    pub id: String,
    pub input: Vec<String>,
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRuntimeIdentity {
    account_id: String,
    provider_key: String,
}

impl ProviderRuntimeIdentity {
    pub fn new(account_id: impl Into<String>, provider_key: impl Into<String>) -> Self {
        Self {
            account_id: account_id.into(),
            provider_key: provider_key.into(),
        }
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn provider_key(&self) -> &str {
        &self.provider_key
    }
}

pub struct ProviderPrivateProjectionCommand<'a> {
    pub accounts: &'a [ProviderAccount],
    pub models: &'a ProviderModelCatalog,
    pub routing: Option<&'a ProviderRouting>,
    pub now_millis: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderPrivateProjectionEffect {
    pub providers: ProviderConfigWriteEffect,
    pub restart: ProviderRestartPreparation,
}

impl ProviderPrivateProjectionEffect {
    pub fn unknown(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            providers: ProviderConfigWriteEffect::Unknown(ProviderProjectionBuildDiagnostic::new(
                reason,
                "models.providers",
                detail,
            )),
            restart: ProviderRestartPreparation::Unknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderConfigWriteEffect {
    Unchanged,
    Written,
    Unknown(ProviderProjectionBuildDiagnostic),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderProjectionBuildDiagnostic {
    reason: &'static str,
    expected_path: &'static str,
    detail: String,
}

impl ProviderProjectionBuildDiagnostic {
    pub fn new(
        reason: &'static str,
        expected_path: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            reason,
            expected_path,
            detail: detail.into(),
        }
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }

    pub fn expected_path(&self) -> &'static str {
        self.expected_path
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderRestartPreparation {
    NotRequired,
    Required,
    Unknown,
}

const MAX_REQUEST_BYTES: usize = 512;
const MAX_RESOLVE_BYTES: usize = 256 * 1024;
const MAX_RESOLVER_ERROR_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolverConfigurationError {
    InvalidEndpoint,
    InvalidAuthorization,
}

impl fmt::Display for ResolverConfigurationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEndpoint => "provider credential resolver endpoint is invalid",
            Self::InvalidAuthorization => "provider credential resolver authorization is invalid",
        })
    }
}

impl std::error::Error for ResolverConfigurationError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolverFailure {
    reason: String,
    status: Option<u16>,
}

impl ResolverFailure {
    pub(crate) fn safe_code(&self) -> crate::call::ProviderCallPrivateResolverCode {
        self.reason
            .strip_prefix("private-resolver-")
            .and_then(|code| {
                serde_json::from_value(serde_json::Value::String(code.to_owned())).ok()
            })
            .unwrap_or(crate::call::ProviderCallPrivateResolverCode::Unknown)
    }

    fn new(reason: impl Into<String>, status: Option<u16>) -> Self {
        Self {
            reason: reason.into(),
            status,
        }
    }
}

impl fmt::Display for ResolverFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "{} status={status}", self.reason),
            None => formatter.write_str(&self.reason),
        }
    }
}

impl std::error::Error for ResolverFailure {}

#[derive(Clone)]
pub struct Resolver {
    endpoint: String,
    authorization: String,
}

impl Resolver {
    pub fn disabled() -> Self {
        Self {
            endpoint: String::new(),
            authorization: String::new(),
        }
    }

    pub fn try_new(
        endpoint: String,
        authorization: String,
    ) -> Result<Self, ResolverConfigurationError> {
        let port = endpoint
            .strip_prefix("http://127.0.0.1:")
            .and_then(|value| value.strip_suffix("/resolve"))
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .ok_or(ResolverConfigurationError::InvalidEndpoint)?;
        if endpoint != format!("http://127.0.0.1:{port}/resolve") {
            return Err(ResolverConfigurationError::InvalidEndpoint);
        }
        if authorization.len() != 43
            || !authorization
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(ResolverConfigurationError::InvalidAuthorization);
        }
        Ok(Self {
            endpoint,
            authorization,
        })
    }

    pub fn claim_account_transaction(
        &self,
        transaction_id: &str,
        reference: &str,
        revision: u64,
    ) -> Result<(), ResolverFailure> {
        self.request_no_content(reqwest::Method::POST, serde_json::json!({
            "operation": "claim", "transactionId": transaction_id, "reference": reference, "revision": revision,
        }))
    }

    pub fn settle_account_transaction(
        &self,
        transaction_id: &str,
        reference: &str,
        revision: u64,
        settlement: &str,
    ) -> Result<(), ResolverFailure> {
        self.request_no_content(reqwest::Method::POST, serde_json::json!({
            "operation": "settle", "transactionId": transaction_id, "reference": reference, "revision": revision, "settlement": settlement,
        }))
    }

    pub fn apply(
        &self,
        reference: &str,
        profile_provider: &str,
        credential_provider: &str,
        mode: ProviderAccountAuthMode,
        revision: u64,
    ) -> Result<(), ResolverFailure> {
        self.request_no_content(
            reqwest::Method::POST,
            serde_json::json!({
                "reference": reference,
                "provider": profile_provider,
                "credentialProvider": credential_provider,
                "authMode": auth_mode_name(mode),
                "revision": revision,
            }),
        )
    }

    pub fn delete(
        &self,
        reference: &str,
        profile_provider: &str,
        revision: u64,
    ) -> Result<(), ResolverFailure> {
        self.request_no_content(
            reqwest::Method::DELETE,
            serde_json::json!({
                "reference": reference,
                "provider": profile_provider,
                "revision": revision,
            }),
        )
    }

    pub fn discard(
        &self,
        reference: &str,
        profile_provider: &str,
        revision: u64,
    ) -> Result<(), ResolverFailure> {
        self.request_no_content(
            reqwest::Method::PUT,
            serde_json::json!({
                "reference": reference,
                "provider": profile_provider,
                "revision": revision,
            }),
        )
    }

    fn request_no_content(
        &self,
        method: reqwest::Method,
        body: serde_json::Value,
    ) -> Result<(), ResolverFailure> {
        let response = self.request(method, body)?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(());
        }
        Err(resolver_response_failure(response, status))
    }

    fn resolve_private(
        &self,
        reference: &str,
    ) -> Result<ConnectorSecretResolution, ConnectorSecretAuthorityPortError> {
        if self.endpoint.is_empty() {
            return Ok(ConnectorSecretResolution::Unavailable {
                metadata: ConnectorSecretResolutionMetadata {
                    source: ConnectorSecretSourceStatus::Unavailable,
                },
            });
        }
        let response = self
            .request(
                reqwest::Method::POST,
                serde_json::json!({ "reference": reference }),
            )
            .map_err(|_| ConnectorSecretAuthorityPortError::SourceFailed)?;
        if response.status().as_u16() == 404 {
            return Ok(ConnectorSecretResolution::NotFound {
                metadata: ConnectorSecretResolutionMetadata {
                    source: ConnectorSecretSourceStatus::NotFound,
                },
            });
        }
        if !response.status().is_success() {
            return Err(ConnectorSecretAuthorityPortError::SourceFailed);
        }
        let bytes = response
            .bytes()
            .map_err(|_| ConnectorSecretAuthorityPortError::SourceFailed)?;
        if bytes.len() > MAX_RESOLVE_BYTES {
            return Err(ConnectorSecretAuthorityPortError::SourceFailed);
        }
        let value = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .ok_or(ConnectorSecretAuthorityPortError::SourceFailed)?;
        let value = ConnectorSecretValue::from_secret(value)
            .map_err(|_| ConnectorSecretAuthorityPortError::SourceFailed)?;
        Ok(ConnectorSecretResolution::Resolved {
            value,
            metadata: ConnectorSecretResolutionMetadata {
                source: ConnectorSecretSourceStatus::Resolved,
            },
        })
    }

    fn request(
        &self,
        method: reqwest::Method,
        body: serde_json::Value,
    ) -> Result<reqwest::blocking::Response, ResolverFailure> {
        if self.endpoint.is_empty() {
            return Err(ResolverFailure::new("private-resolver-disabled", None));
        }
        let body = serde_json::to_vec(&body)
            .map_err(|_| ResolverFailure::new("private-resolver-request-encode-failed", None))?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(ResolverFailure::new(
                "private-resolver-request-too-large",
                None,
            ));
        }
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| ResolverFailure::new("private-resolver-client-build-failed", None))?
            .request(method, &self.endpoint)
            .bearer_auth(&self.authorization)
            .header("content-type", "application/json")
            .header("content-length", body.len())
            .body(body)
            .send()
            .map_err(|_| ResolverFailure::new("private-resolver-request-failed", None))
    }
}

fn resolver_response_failure(
    response: reqwest::blocking::Response,
    status: u16,
) -> ResolverFailure {
    let reason = response
        .bytes()
        .ok()
        .filter(|bytes| bytes.len() <= MAX_RESOLVER_ERROR_BYTES)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .filter(|error| is_safe_error_code(error))
                .map(|error| format!("private-resolver-{error}"))
        })
        .unwrap_or_else(|| "private-resolver-rejected".to_owned());
    ResolverFailure::new(reason, Some(status))
}

fn is_safe_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

impl ConnectorSecretResolverPort for Resolver {
    fn resolve(
        &self,
        reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretResolution, ConnectorSecretAuthorityPortError> {
        self.resolve_private(reference.as_str())
    }
}

impl fmt::Debug for Resolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderCredentialResolver([REDACTED])")
    }
}

fn auth_mode_name(mode: ProviderAccountAuthMode) -> &'static str {
    match mode {
        ProviderAccountAuthMode::ApiKey => "apiKey",
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cliReuse",
        ProviderAccountAuthMode::OAuthBrowser => "oauthBrowser",
        ProviderAccountAuthMode::OAuthDevice => "oauthDevice",
        ProviderAccountAuthMode::Local => "local",
    }
}
