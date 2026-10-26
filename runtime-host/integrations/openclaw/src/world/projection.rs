use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use platform::state_dir::CanonicalStateDir;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::VerificationFailure;

pub(crate) const PROJECTION_ENV: &str = "MATCHA_WORLD_PROJECTION";
const FILE_NAME: &str = "openclaw-world.json";

#[derive(Debug)]
pub struct ProjectionError {
    source: Box<dyn std::error::Error + Send + Sync>,
}
impl ProjectionError {
    pub fn reason(&self) -> VerificationFailure {
        VerificationFailure::Configuration
    }

    fn caused_by(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}
impl std::fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpenClaw World private projection rejected")
    }
}
impl std::error::Error for ProjectionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

/// Private launch projection, deliberately separate from the public tool schemas.
#[derive(Clone)]
pub struct WorldRuntimeHost {
    directory: CanonicalStateDir,
}
impl std::fmt::Debug for WorldRuntimeHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WorldRuntimeHost([REDACTED])")
    }
}
impl WorldRuntimeHost {
    pub fn new(
        private_directory: CanonicalStateDir,
        endpoint: String,
        runtime_instance: String,
        key: Zeroizing<Vec<u8>>,
    ) -> Result<Self, ProjectionError> {
        let url = reqwest::Url::parse(&endpoint).map_err(ProjectionError::caused_by)?;
        if key.len() != 32
            || runtime_instance.is_empty()
            || runtime_instance.len() > 256
            || runtime_instance.chars().any(char::is_control)
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || url.path() != world_protocol::api::PEER_ENDPOINT
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ProjectionError::caused_by(
                VerificationFailure::Configuration,
            ));
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Material<'a> {
            endpoint: &'a str,
            runtime_instance: &'a str,
            signing_key: &'a str,
        }
        let encoded_key = Zeroizing::new(URL_SAFE_NO_PAD.encode(&key));
        let bytes = Zeroizing::new(
            serde_json::to_vec(&Material {
                endpoint: &endpoint,
                runtime_instance: &runtime_instance,
                signing_key: &encoded_key,
            })
            .map_err(ProjectionError::caused_by)?,
        );
        private_directory
            .replace_regular_file_bounded(FILE_NAME, &bytes, 4096)
            .map_err(ProjectionError::caused_by)?;
        Ok(Self {
            directory: private_directory,
        })
    }

    pub fn revoke_projection(&self) -> Result<(), ProjectionError> {
        self.directory
            .replace_regular_file_bounded(FILE_NAME, b"{}", 4096)
            .map_err(ProjectionError::caused_by)
    }

    pub(super) fn sign_investigation(&self, params: &mut Value) -> Result<(), ProjectionError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Material {
            endpoint: String,
            runtime_instance: String,
            signing_key: String,
        }
        let bytes = Zeroizing::new(self.directory.read_regular_file_bounded(FILE_NAME, 4096)
            .map_err(ProjectionError::caused_by)?
            .ok_or_else(|| ProjectionError::caused_by(VerificationFailure::Configuration))?);
        let material: Material = serde_json::from_slice(&bytes).map_err(ProjectionError::caused_by)?;
        let key_text = Zeroizing::new(material.signing_key);
        let key = Zeroizing::new(URL_SAFE_NO_PAD.decode(key_text.as_bytes()).map_err(ProjectionError::caused_by)?);
        let endpoint = reqwest::Url::parse(&material.endpoint).map_err(ProjectionError::caused_by)?;
        if key.len() != 32 || URL_SAFE_NO_PAD.encode(&key) != *key_text
            || material.runtime_instance.is_empty() || material.runtime_instance.len() > 256
            || material.runtime_instance.chars().any(char::is_control)
            || endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port().is_none() || endpoint.path() != world_protocol::api::PEER_ENDPOINT
            || !endpoint.username().is_empty() || endpoint.password().is_some()
            || endpoint.query().is_some() || endpoint.fragment().is_some()
        {
            return Err(ProjectionError::caused_by(VerificationFailure::Configuration));
        }
        params["worldInvestigation"]["producer"] = serde_json::json!({"runtimeInstance":material.runtime_instance});
        let bytes = serde_json::to_vec(&canonical(params.clone())).map_err(ProjectionError::caused_by)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key)
            .map_err(|_| ProjectionError::caused_by(VerificationFailure::Configuration))?;
        mac.update(b"matcha.world.investigation.openclaw.v1\n");
        mac.update(&bytes);
        params["worldInvestigation"]["producer"]["mac"] = Value::String(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()));
        Ok(())
    }

    pub(crate) fn path(&self) -> std::path::PathBuf {
        self.directory.as_path().join(FILE_NAME)
    }
}

pub(super) fn canonical(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(object.into_iter()
            .map(|(key, value)| (key, canonical(value)))
            .collect::<std::collections::BTreeMap<_, _>>().into_iter().collect()),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}
