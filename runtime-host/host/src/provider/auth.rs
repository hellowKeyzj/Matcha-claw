use std::{fmt, time::Duration};

use environment::{
    ConnectorSecretAuthorityPortError, ConnectorSecretRef, ConnectorSecretResolution,
    ConnectorSecretResolutionMetadata, ConnectorSecretResolverPort, ConnectorSecretSourceStatus,
    ConnectorSecretValue, ProviderAccountAuthMode,
};

const MAX_REQUEST_BYTES: usize = 512;
const MAX_RESOLVE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolverConfigurationError {
    InvalidEndpoint,
    InvalidAuthorization,
}

impl std::fmt::Display for ResolverConfigurationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEndpoint => "provider credential resolver endpoint is invalid",
            Self::InvalidAuthorization => "provider credential resolver authorization is invalid",
        })
    }
}

const MAX_RESOLVER_ERROR_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolverFailure {
    reason: String,
    status: Option<u16>,
}

impl ResolverFailure {
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

/// Main owns credential bytes and OpenClaw's private auth-profile file. Rust can only ask
/// Main to settle a named, non-secret reference after its durable account operation is ready.
#[derive(Clone)]
pub struct Resolver {
    endpoint: String,
    authorization: String,
}

impl Resolver {
    pub(crate) fn disabled() -> Self {
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

    pub(crate) fn apply(
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

    pub(crate) fn delete(
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

    pub(crate) fn discard(
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

impl std::fmt::Debug for Resolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
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
