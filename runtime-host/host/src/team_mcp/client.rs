use std::{path::Path, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use platform::mcp::{ToolCallError, ToolCallOutcome};
use serde_json::{Map, Value, json};
use zeroize::{Zeroize, Zeroizing};

use super::{CAPABILITY, MAX_BYTES, PRINCIPAL, ROUTE, SCOPE, discovery, now_millis, revision};

pub fn team_provider(state_dir: &Path) -> Result<organization::TeamRunMcpFacade, ()> {
    let state_dir = state_dir.to_owned();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ())?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| ())?;
    Ok(organization::TeamRunMcpFacade::new(
        move |name, arguments| runtime.block_on(call(&client, &state_dir, name, arguments)),
    ))
}

async fn call(
    client: &reqwest::Client,
    state_dir: &Path,
    name: &str,
    arguments: &Map<String, Value>,
) -> ToolCallOutcome {
    let mut metadata = discovery::read(state_dir).map_err(|_| ToolCallError::Internal)?;
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
    if body.len() > MAX_BYTES {
        return Err(ToolCallError::InvalidParams);
    }
    let now = now_millis().map_err(|_| ToolCallError::Internal)?;
    let mut correlation = [0_u8; 16];
    getrandom::fill(&mut correlation).map_err(|_| ToolCallError::Internal)?;
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "version": 1, "principal": PRINCIPAL, "endpoint": ROUTE,
            "scope": SCOPE, "capability": CAPABILITY, "subject": name,
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
    let mut response = client
        .post(format!("http://127.0.0.1:{}{ROUTE}", metadata.port))
        .header(reqwest::header::AUTHORIZATION, authorization.as_str())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| ToolCallError::Internal)?;
    if response.status() == reqwest::StatusCode::BAD_REQUEST {
        return Err(ToolCallError::InvalidParams);
    }
    if !response.status().is_success() {
        return Err(ToolCallError::Internal);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ToolCallError::Internal)?
    {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(ToolCallError::Internal);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ToolCallError::Internal)
}
