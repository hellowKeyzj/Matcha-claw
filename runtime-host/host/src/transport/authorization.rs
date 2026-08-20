use std::collections::HashMap;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use serde::Deserialize;

const PREFIX: &str = "capability-decision.v1";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Clone)]
pub struct CapabilityDecisionVerifier {
    key: VerifyingKey,
    redeemed: HashMap<String, u64>,
}

impl CapabilityDecisionVerifier {
    pub fn try_new(verification_key: &str) -> Result<Self, CapabilityDecisionError> {
        let key = URL_SAFE_NO_PAD
            .decode(verification_key)
            .map_err(|_| CapabilityDecisionError::Rejected)?;
        let raw_key = key
            .strip_prefix(&ED25519_SPKI_PREFIX)
            .ok_or(CapabilityDecisionError::Rejected)?;
        let raw_key: [u8; 32] = raw_key
            .try_into()
            .map_err(|_| CapabilityDecisionError::Rejected)?;
        let key =
            VerifyingKey::from_bytes(&raw_key).map_err(|_| CapabilityDecisionError::Rejected)?;
        Ok(Self {
            key,
            redeemed: HashMap::new(),
        })
    }

    pub fn verify(
        &mut self,
        value: &str,
        now: u64,
        endpoint: &str,
        scope: &str,
        capability: &str,
        subject: &str,
    ) -> Result<VerifiedCapabilityDecision, CapabilityDecisionError> {
        self.redeemed.retain(|_, expires_at| *expires_at > now);
        let (prefix, payload, signature) = split(value)?;
        if prefix != PREFIX {
            return Err(CapabilityDecisionError::Rejected);
        }
        let signed = format!("{prefix}.{payload}");
        let signature = Signature::from_slice(
            &URL_SAFE_NO_PAD
                .decode(signature)
                .map_err(|_| CapabilityDecisionError::Rejected)?,
        )
        .map_err(|_| CapabilityDecisionError::Rejected)?;
        self.key
            .verify(signed.as_bytes(), &signature)
            .map_err(|_| CapabilityDecisionError::Rejected)?;

        let wire: Wire = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| CapabilityDecisionError::Rejected)?,
        )
        .map_err(|_| CapabilityDecisionError::Rejected)?;
        if wire.version != 1
            || wire.expires_at <= now
            || wire.endpoint != endpoint
            || wire.scope != scope
            || wire.capability != capability
            || wire.subject != subject
            || !valid_opaque(&wire.principal)
            || !valid_opaque(&wire.correlation)
            || !valid_opaque(&wire.revision)
            || self.redeemed.contains_key(&wire.correlation)
        {
            return Err(CapabilityDecisionError::Rejected);
        }
        self.redeemed
            .insert(wire.correlation.clone(), wire.expires_at);

        Ok(VerifiedCapabilityDecision {
            principal: wire.principal,
            correlation: wire.correlation,
            revision: wire.revision,
        })
    }
}

impl core::fmt::Debug for CapabilityDecisionVerifier {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("CapabilityDecisionVerifier")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedCapabilityDecision {
    principal: String,
    correlation: String,
    revision: String,
}

impl VerifiedCapabilityDecision {
    pub fn principal(&self) -> &str {
        &self.principal
    }

    pub fn correlation(&self) -> &str {
        &self.correlation
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityDecisionError {
    Rejected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wire {
    version: u8,
    principal: String,
    endpoint: String,
    scope: String,
    capability: String,
    subject: String,
    expires_at: u64,
    correlation: String,
    revision: String,
}

fn split(value: &str) -> Result<(&str, &str, &str), CapabilityDecisionError> {
    let mut parts = value.split('.');
    let prefix = parts.next().ok_or(CapabilityDecisionError::Rejected)?;
    let version = parts.next().ok_or(CapabilityDecisionError::Rejected)?;
    let payload = parts.next().ok_or(CapabilityDecisionError::Rejected)?;
    let signature = parts.next().ok_or(CapabilityDecisionError::Rejected)?;
    if prefix != "capability-decision"
        || version != "v1"
        || parts.next().is_some()
        || payload.is_empty()
        || signature.is_empty()
    {
        return Err(CapabilityDecisionError::Rejected);
    }
    Ok((PREFIX, payload, signature))
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains('\0')
}
