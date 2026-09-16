use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    facade::SkillsHandle,
    skills::bundle::{Bundle, BundleFile, Command, Outcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) const EXPORT_ENDPOINT: &str = "/api/subagents/skill-bundles/export";
pub(crate) const IMPORT_ENDPOINT: &str = "/api/subagents/skill-bundles/import";
const AUTHORIZATION_SCOPE: &str = "subagents:skill-bundles";
const AUTHORIZATION_CAPABILITY: &str = "subagentSkillBundles.transfer";
const AUTHORIZATION_SUBJECT: &str = "subagent-skill-bundles";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportRequest {
    skill_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    skill_bundles: Vec<WireBundle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireBundle {
    skill_key: String,
    files: Vec<WireBundleFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireBundleFile {
    path: String,
    content: String,
}

pub(crate) async fn export(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsHandle,
    now: u64,
) -> Result<Value, RequestError> {
    authorize(headers, &verifier, EXPORT_ENDPOINT, now).await?;
    let request =
        serde_json::from_slice::<ExportRequest>(body).map_err(|_| RequestError::Invalid)?;
    match handle
        .skill_bundles(Command::Export {
            skill_keys: request.skill_keys,
        })
        .await
    {
        Ok(Outcome::Exported(bundles)) => {
            Ok(json!({ "outcome": "accepted", "skillBundles": encode(bundles) }))
        }
        Ok(Outcome::Rejected) => Ok(json!({ "outcome": "rejected" })),
        Ok(Outcome::Accepted | Outcome::Unknown) | Err(_) => Ok(json!({ "outcome": "unknown" })),
    }
}

pub(crate) async fn import(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsHandle,
    now: u64,
) -> Result<Value, RequestError> {
    authorize(headers, &verifier, IMPORT_ENDPOINT, now).await?;
    let request =
        serde_json::from_slice::<ImportRequest>(body).map_err(|_| RequestError::Invalid)?;
    let bundles = request
        .skill_bundles
        .into_iter()
        .map(|bundle| {
            let files = bundle
                .files
                .into_iter()
                .map(|file| BundleFile::try_new(file.path, file.content))
                .collect::<Result<Vec<_>, _>>()?;
            crate::skills::bundle::Bundle::try_new(bundle.skill_key, files)
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RequestError::Invalid)?;
    crate::skills::bundle::validate_batch(&bundles).map_err(|_| RequestError::Invalid)?;
    match handle.skill_bundles(Command::Import { bundles }).await {
        Ok(Outcome::Accepted) => Ok(json!({ "outcome": "accepted" })),
        Ok(Outcome::Rejected) => Ok(json!({ "outcome": "rejected" })),
        Ok(Outcome::Exported(_) | Outcome::Unknown) | Err(_) => Ok(json!({ "outcome": "unknown" })),
    }
}

async fn authorize(
    headers: &[(String, String)],
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &str,
    now: u64,
) -> Result<(), RequestError> {
    let authorization = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    verifier
        .lock()
        .await
        .verify(
            authorization,
            now,
            endpoint,
            AUTHORIZATION_SCOPE,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .map(|_| ())
        .map_err(|_| RequestError::Unauthorized)
}

fn encode(bundles: Vec<Bundle>) -> Vec<Value> {
    bundles
        .into_iter()
        .map(|bundle| {
            json!({
                "skillKey": bundle.skill_key(),
                "files": bundle.files().iter().map(|file| json!({
                    "path": file.path(),
                    "content": file.content(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    const NOW: u64 = 1_000;

    #[tokio::test]
    async fn authorizes_only_the_fixed_skill_bundle_decision_without_echoing_it() {
        let decision = decision(EXPORT_ENDPOINT);
        let headers = vec![("authorization".into(), format!("Bearer {decision}"))];
        let verifier = Arc::new(Mutex::new(verifier()));

        assert_eq!(
            authorize(&headers, &verifier, EXPORT_ENDPOINT, NOW).await,
            Ok(())
        );
        assert!(!format!("{:?}", verifier.lock().await).contains(&decision));
    }

    #[tokio::test]
    async fn rejects_a_decision_for_another_endpoint() {
        let decision = decision(IMPORT_ENDPOINT);
        let headers = vec![("authorization".into(), format!("Bearer {decision}"))];
        let verifier = Arc::new(Mutex::new(verifier()));

        assert_eq!(
            authorize(&headers, &verifier, EXPORT_ENDPOINT, NOW).await,
            Err(RequestError::Unauthorized)
        );
    }

    fn verifier() -> CapabilityDecisionVerifier {
        let mut key = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        key.extend_from_slice(SigningKey::from_bytes(&[7; 32]).verifying_key().as_bytes());
        CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(key)).unwrap()
    }

    fn decision(endpoint: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "desktop-session:test",
            "endpoint": endpoint,
            "scope": AUTHORIZATION_SCOPE,
            "capability": AUTHORIZATION_CAPABILITY,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": NOW + 1,
            "correlation": format!("skill-bundle:{endpoint}"),
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(
            SigningKey::from_bytes(&[7; 32])
                .sign(signed.as_bytes())
                .to_bytes(),
        );
        format!("{signed}.{signature}")
    }
}
