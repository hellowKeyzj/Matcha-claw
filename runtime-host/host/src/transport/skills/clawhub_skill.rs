use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    facade::SkillsHandle,
    skills::install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) const ENDPOINT: &str = "/api/clawhub/skills/install";
const AUTHORIZATION_SCOPE: &str = "skills:install";
const AUTHORIZATION_CAPABILITY: &str = "clawhubSkill.install";
const AUTHORIZATION_SUBJECT: &str = "clawhub-skill-install";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRequest {
    slug: String,
    version: Option<String>,
    force: bool,
}

struct InstallCommand {
    command: SkillInstallCommand,
    slug: String,
    version: Option<String>,
}

impl InstallRequest {
    fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<InstallCommand, RequestError> {
        verifier
            .verify(
                authorization,
                now,
                ENDPOINT,
                AUTHORIZATION_SCOPE,
                AUTHORIZATION_CAPABILITY,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| RequestError::Unauthorized)?;
        if value.get("version").is_some_and(Value::is_null) {
            return Err(RequestError::Invalid);
        }
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        let slug = request.slug.trim().to_owned();
        let version = request.version.map(|version| version.trim().to_owned());
        if version.as_deref().is_some_and(str::is_empty) {
            return Err(RequestError::Invalid);
        }
        let command = SkillInstallCommand::new(slug.clone(), version.clone(), request.force);
        crate::skills::management::Command::clawhub_install(
            slug.clone(),
            version.clone(),
            request.force,
        )
        .map_err(|_| RequestError::Invalid)?;
        Ok(InstallCommand {
            command,
            slug,
            version,
        })
    }
}

pub(crate) struct Delivery {
    outcome: &'static str,
    slug: String,
    version: Option<String>,
}

impl Delivery {
    fn accepted(slug: String, version: Option<String>) -> Self {
        Self {
            outcome: "accepted",
            slug,
            version,
        }
    }

    fn rejected(slug: String, version: Option<String>) -> Self {
        Self {
            outcome: "rejected",
            slug,
            version,
        }
    }

    fn unknown(slug: String, version: Option<String>) -> Self {
        Self {
            outcome: "unknown",
            slug,
            version,
        }
    }

    pub(crate) fn body(&self) -> Value {
        let mut body = json!({
            "outcome": self.outcome,
            "slug": self.slug,
        });
        if let Some(version) = &self.version {
            body.as_object_mut()
                .expect("ClawHub skill install response is an object")
                .insert("version".into(), Value::String(version.clone()));
        }
        body
    }
}

pub(crate) async fn handle(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: SkillsHandle,
    now: u64,
) -> Result<Delivery, RequestError> {
    let authorization = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    let value = serde_json::from_slice::<Value>(body).map_err(|_| RequestError::Invalid)?;
    let mut verifier = verifier.lock().await;
    let command = InstallRequest::decode(value, authorization, &mut verifier, now)?;
    drop(verifier);

    let InstallCommand {
        command,
        slug,
        version,
    } = command;
    let delivery = match handle.install_clawhub_skill(command).await {
        Ok(SkillInstallOutcome::Accepted { .. }) => Delivery::accepted(slug, version),
        Ok(SkillInstallOutcome::Rejected) => Delivery::rejected(slug, version),
        Ok(SkillInstallOutcome::Unknown) | Err(_) => Delivery::unknown(slug, version),
    };
    Ok(delivery)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    const NOW: u64 = 1_000;

    #[test]
    fn decodes_only_the_fixed_signed_install_dto() {
        let command = decode(json!({
            "slug": " safe-skill ",
            "version": " 1.2.3 ",
            "force": true,
        }))
        .expect("valid fixed install request");
        assert_eq!(command.slug, "safe-skill");
        assert_eq!(command.version.as_deref(), Some("1.2.3"));
        for invalid in [
            json!({ "slug": "safe-skill", "force": false, "extra": "private" }),
            json!({ "slug": "safe-skill", "force": "false" }),
            json!({ "slug": "safe-skill", "version": null, "force": false }),
            json!({ "slug": "../private-workspace", "force": false }),
            json!({ "slug": "@owner/safe-skill", "force": false }),
            json!({ "slug": "skills-sh:owner/repo/safe-skill", "force": false }),
            json!({ "slug": "safe-skill", "version": " ", "force": false }),
        ] {
            assert!(matches!(decode(invalid), Err(RequestError::Invalid)));
        }
    }

    #[test]
    fn rejects_unsigned_or_wrongly_scoped_requests_without_disclosing_input() {
        let private_slug = "private-skill-name";
        let value = json!({ "slug": private_slug, "force": false });
        let mut capability_verifier = verifier();
        assert!(matches!(
            InstallRequest::decode(value.clone(), "invalid", &mut capability_verifier, NOW),
            Err(RequestError::Unauthorized)
        ));

        let mut capability_verifier = verifier();
        assert!(matches!(
            InstallRequest::decode(
                value,
                &decision("other.capability"),
                &mut capability_verifier,
                NOW,
            ),
            Err(RequestError::Unauthorized)
        ));
    }

    #[test]
    fn delivery_returns_only_the_fixed_public_receipt() {
        assert_eq!(
            Delivery::accepted("safe-skill".into(), Some("1.2.3".into())).body(),
            json!({
                "outcome": "accepted",
                "slug": "safe-skill",
                "version": "1.2.3",
            })
        );
        assert_eq!(
            Delivery::rejected("safe-skill".into(), None).body(),
            json!({ "outcome": "rejected", "slug": "safe-skill" })
        );
        assert_eq!(
            Delivery::unknown("safe-skill".into(), None).body(),
            json!({ "outcome": "unknown", "slug": "safe-skill" })
        );
    }

    fn decode(value: Value) -> Result<InstallCommand, RequestError> {
        let mut verifier = verifier();
        InstallRequest::decode(
            value,
            &decision(AUTHORIZATION_CAPABILITY),
            &mut verifier,
            NOW,
        )
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[11; 32])
    }

    fn verifier() -> CapabilityDecisionVerifier {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(bytes)).expect("verifier")
    }

    fn decision(capability: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": capability,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": NOW + 1,
            "correlation": format!("clawhub-skill-install-{capability}"),
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
