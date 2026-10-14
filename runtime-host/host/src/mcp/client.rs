use std::{path::PathBuf, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use platform::mcp::{ToolCallError, ToolCallOutcome};
use serde_json::{Map, Value, json};
use zeroize::{Zeroize, Zeroizing};

use super::{Family, MAX_BYTES, discovery, now_millis, revision};

pub(super) struct Client {
    client: reqwest::Client,
    state_dir: PathBuf,
}

impl Client {
    pub(super) fn new(state_dir: PathBuf) -> Result<Self, ()> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ())?;
        Ok(Self { client, state_dir })
    }

    pub(super) async fn call(
        &self,
        family: Family,
        name: &str,
        arguments: &Map<String, Value>,
    ) -> ToolCallOutcome {
        let mut metadata = discovery::read(&self.state_dir).map_err(|_| ToolCallError::Internal)?;
        let key = URL_SAFE_NO_PAD.decode(&metadata.signing_key);
        metadata.signing_key.zeroize();
        let key = Zeroizing::new(key.map_err(|_| ToolCallError::Internal)?);
        let key: &[u8; 32] = key
            .as_slice()
            .try_into()
            .map_err(|_| ToolCallError::Internal)?;
        let signing_key = SigningKey::from_bytes(key);
        let body = serde_json::to_vec(&json!({ "name": name, "arguments": arguments }))
            .map_err(|_| ToolCallError::Internal)?;
        if matches!(family, Family::Team) && body.len() > MAX_BYTES {
            return Err(ToolCallError::InvalidParams);
        }
        let now = now_millis().map_err(|_| ToolCallError::Internal)?;
        let mut correlation = [0_u8; 16];
        getrandom::fill(&mut correlation).map_err(|_| ToolCallError::Internal)?;
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "version": 1, "principal": family.principal(), "endpoint": family.path(),
                "scope": family.scope(), "capability": family.scope(), "subject": name,
                "expiresAt": now + 30_000, "correlation": URL_SAFE_NO_PAD.encode(correlation),
                "revision": revision(&body),
            }))
            .map_err(|_| ToolCallError::Internal)?,
        );
        let signed = format!("capability-decision.v1.{payload}");
        let authorization = Zeroizing::new(format!(
            "Bearer {signed}.{}",
            URL_SAFE_NO_PAD.encode(signing_key.sign(signed.as_bytes()).to_bytes())
        ));
        let request = self
            .client
            .post(format!(
                "http://127.0.0.1:{}{}",
                metadata.port,
                family.path()
            ))
            .header(reqwest::header::AUTHORIZATION, authorization.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        let request = match family {
            Family::Team => request.timeout(Duration::from_secs(30)),
            Family::Wiki => request,
        };
        let mut response = request.send().await.map_err(|_| ToolCallError::Internal)?;
        let status = response.status();
        if status == reqwest::StatusCode::BAD_REQUEST {
            return Err(ToolCallError::InvalidParams);
        }
        let successful = match family {
            Family::Team => status.is_success(),
            Family::Wiki => status == reqwest::StatusCode::OK,
        };
        if !successful {
            return Err(ToolCallError::Internal);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ToolCallError::Internal)?
        {
            if matches!(family, Family::Team) && bytes.len() + chunk.len() > MAX_BYTES {
                return Err(ToolCallError::Internal);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ToolCallError::Internal)
    }
}
