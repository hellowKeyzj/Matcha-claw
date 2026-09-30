use platform::capability::CapabilityDecisionVerifier;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    SkillsModule,
    bundle::{BundleFile, Command, Outcome},
};

pub(super) const EXPORT_ENDPOINT: &str = "/api/subagents/skill-bundles/export";
pub(super) const IMPORT_ENDPOINT: &str = "/api/subagents/skill-bundles/import";
const AUTHORIZATION_SCOPE: &str = "subagents:skill-bundles";
const AUTHORIZATION_CAPABILITY: &str = "subagentSkillBundles.transfer";
const AUTHORIZATION_SUBJECT: &str = "subagent-skill-bundles";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RequestError {
    Invalid,
    Unauthorized,
    Admission(platform::call::CallLogError),
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

pub(super) async fn export(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsModule,
    now: u64,
    call: Option<crate::operation::RecordedCall>,
) -> Result<(u16, Value), RequestError> {
    let token = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    let principal = verifier
        .lock()
        .await
        .verify(
            token,
            now,
            EXPORT_ENDPOINT,
            AUTHORIZATION_SCOPE,
            AUTHORIZATION_CAPABILITY,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| RequestError::Unauthorized)?
        .principal()
        .to_owned();
    let request =
        serde_json::from_slice::<ExportRequest>(body).map_err(|_| RequestError::Invalid)?;
    let call = call.ok_or(RequestError::Admission(
        platform::call::CallLogError::Unavailable,
    ))?;
    let access = crate::result::ResultAccess {
        principal,
        scope: AUTHORIZATION_SCOPE.into(),
        capability: AUTHORIZATION_CAPABILITY.into(),
        subject: AUTHORIZATION_SUBJECT.into(),
        private: false,
    };
    let worker = handle.clone();
    let receipt = handle
        .submit_result(
            call,
            access,
            crate::result::BUNDLE_RESULT_BUDGET,
            async move {
                Ok(crate::result::export_bundles(
                    &worker,
                    Command::Export {
                        skill_keys: request.skill_keys,
                    },
                )
                .await)
            },
        )
        .await
        .map_err(RequestError::Admission)?;
    Ok((202, json!(receipt)))
}

pub(super) async fn import(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsModule,
    now: u64,
    call: Option<crate::operation::RecordedCall>,
) -> Result<(u16, Value), RequestError> {
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
            crate::bundle::Bundle::try_new(bundle.skill_key, files)
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RequestError::Invalid)?;
    crate::bundle::validate_batch(&bundles).map_err(|_| RequestError::Invalid)?;
    let call = call.ok_or(RequestError::Admission(
        platform::call::CallLogError::Unavailable,
    ))?;
    {
        let worker = handle.clone();
        let receipt = handle
            .submit_operation(call, async move {
                let body = import_response(worker.skill_bundles(Command::Import { bundles }).await);
                platform::loopback::Response::json(200, body)
            })
            .await
            .map_err(RequestError::Admission)?;
        return Ok((202, json!(receipt)));
    }
}

fn import_response(outcome: Result<Outcome, ()>) -> Value {
    match outcome {
        Ok(Outcome::Accepted) => json!({ "outcome": "accepted" }),
        Ok(Outcome::Rejected) => json!({ "outcome": "rejected" }),
        Ok(Outcome::Exported(_) | Outcome::Unknown) | Err(_) => json!({ "outcome": "unknown" }),
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
