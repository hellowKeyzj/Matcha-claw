use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use world_protocol::{ids::*, process::{StateValue, StateWrite, MAX_STATE_KEY_BYTES, MAX_STATE_VALUE_BYTES}, state::{StateFailure, KV_CHECKPOINT_FORMAT}};

use super::StateError;

#[derive(Clone, Copy)]
pub struct StateLimits {
    pub maximum_keys: u64,
    pub maximum_bytes: u64,
}

impl Default for StateLimits {
    fn default() -> Self { Self { maximum_keys: 4096, maximum_bytes: 16 * 1024 * 1024 } }
}

impl StateLimits {
    pub(super) fn encoded_limit(self) -> Result<i64, StateError> {
        self.maximum_bytes.checked_mul(6).and_then(|bytes| self.maximum_keys.checked_mul(128).and_then(|keys| bytes.checked_add(keys)))
            .and_then(|bytes| bytes.checked_add(4096)).and_then(|bytes| i64::try_from(bytes).ok())
            .ok_or_else(|| StateFailure::SizeLimit.into())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StateData {
    pub format: String,
    pub entries: BTreeMap<String, StateValue>,
}

pub(super) struct StatePatch {
    pub expected_root: StateRef,
    pub data: StateData,
    pub value: StateValue,
}

impl StateData {
    pub(super) fn empty() -> Self { Self { format: KV_CHECKPOINT_FORMAT.into(), entries: BTreeMap::new() } }

    pub(super) fn validate(&self, limits: StateLimits) -> Result<(), StateError> {
        if self.format != KV_CHECKPOINT_FORMAT { return Err(StateFailure::ShadowValidationFailed.into()); }
        if self.entries.len() as u64 > limits.maximum_keys { return Err(StateFailure::SizeLimit.into()); }
        let mut bytes = 0u64;
        for (key, value) in &self.entries {
            validate_key(key)?;
            if value.revision.0 == 0 || value.revision.0 > i64::MAX as u64 || value.value.len() > MAX_STATE_VALUE_BYTES {
                return Err(StateFailure::ShadowValidationFailed.into());
            }
            bytes = bytes.checked_add(key.len() as u64).and_then(|bytes| bytes.checked_add(value.value.len() as u64))
                .filter(|bytes| *bytes <= limits.maximum_bytes).ok_or(StateFailure::SizeLimit)?;
        }
        Ok(())
    }

    pub(super) fn propose(mut self, root: StateRef, request: &StateWrite, limits: StateLimits) -> Result<StatePatch, StateError> {
        validate_key(&request.key)?;
        if request.value.len() > MAX_STATE_VALUE_BYTES { return Err(StateFailure::SizeLimit.into()); }
        let actual = self.entries.get(&request.key).map(|value| value.revision);
        if actual != request.expected_revision {
            return Err(StateFailure::RevisionConflict { expected: request.expected_revision, actual }.into());
        }
        let revision = actual.map_or(Some(1), |revision| revision.0.checked_add(1))
            .filter(|revision| *revision <= i64::MAX as u64).map(Revision).ok_or(StateFailure::SizeLimit)?;
        let value = StateValue { revision, value: request.value.clone() };
        self.entries.insert(request.key.clone(), value.clone());
        self.validate(limits)?;
        Ok(StatePatch { expected_root: root, data: self, value })
    }

    pub(super) fn digest(&self) -> Result<Digest, StateError> {
        let mut hash = Sha256::new();
        hash.update(b"matcha.world-kv.1\n");
        hash.update(serde_json::to_vec(self)?);
        Ok(Digest::try_new(format!("sha256:{:x}", hash.finalize())).expect("SHA256 digest syntax"))
    }
}

pub(super) fn validate_key(key: &str) -> Result<(), StateError> {
    if key.is_empty() || key.len() > MAX_STATE_KEY_BYTES || key.chars().any(char::is_control) {
        return Err(StateFailure::KeyInvalid.into());
    }
    Ok(())
}
