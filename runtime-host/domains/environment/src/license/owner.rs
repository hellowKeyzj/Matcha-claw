use serde::Serialize;

use super::{
    LicenseCacheMetadata, LicenseDeviceIdentity, LicenseKey, LicensePrivateError,
    LicenseProjection, LicenseProjectionReason, LicenseProjectionState,
    authority::{
        AuthorityError, LicenseAuthorityClient, LicenseClientContext, LicenseConfig,
        LicensePolicyMode,
    },
    store::LicensePrivateStore,
};

const LICENSE_PREFIX: &str = "MATCHACLAW";
const LICENSE_KEY_SEGMENTS: usize = 5;
const CHECKSUM_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CHECKSUM_CONTEXT: &str = "matchaclaw-license-v2";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LicenseGateState {
    Checking,
    Granted,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LicenseGateProjection {
    pub state: LicenseGateState,
    pub reason: String,
    pub checked_at_ms: u64,
    pub has_stored_key: bool,
    pub has_usable_cache: bool,
    pub next_revalidate_at_ms: Option<u64>,
    pub last_validation: Option<LicenseValidationResult>,
    pub renewal_alert: Option<LicenseRenewalAlert>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseRenewalAlert {
    NearExpiryRenewFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LicenseStoredKeySummary {
    pub has_stored_key: bool,
    pub masked: Option<String>,
    pub last4: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LicenseValidationResult {
    pub valid: bool,
    pub code: String,
    pub masked: Option<String>,
    pub last4: Option<String>,
    pub mode: String,
    pub source: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<String>,
    #[serde(rename = "refreshAfterSec")]
    pub refresh_after_sec: Option<u64>,
    #[serde(rename = "offlineGraceUntilMs")]
    pub offline_grace_until_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LicenseOwnerError {
    InvalidInput,
    NoStoredKey,
    StorageUnavailable,
    AuthorityUnavailable,
}

impl From<LicensePrivateError> for LicenseOwnerError {
    fn from(error: LicensePrivateError) -> Self {
        match error {
            LicensePrivateError::InvalidInput => Self::InvalidInput,
            LicensePrivateError::NoStoredKey => Self::NoStoredKey,
            LicensePrivateError::StorageUnavailable
            | LicensePrivateError::CorruptState
            | LicensePrivateError::CryptoUnavailable
            | LicensePrivateError::IdentityMismatch
            | LicensePrivateError::KeyHashMismatch
            | LicensePrivateError::NoCachedValidation
            | LicensePrivateError::Expired => Self::StorageUnavailable,
        }
    }
}

/// Canonical Environment owner for private license facts and validation effects.
///
/// Raw keys never leave this owner. Delivery receives only the safe projections above.
pub struct LicenseOwner {
    store: LicensePrivateStore,
    identity: LicenseDeviceIdentity,
    config: LicenseConfig,
    authority: Option<LicenseAuthorityClient>,
}

impl LicenseOwner {
    pub fn open(
        private_root: impl AsRef<std::path::Path>,
        device_identity: impl AsRef<str>,
        config: LicenseConfig,
        context: LicenseClientContext,
    ) -> Result<Self, LicenseOwnerError> {
        let private_root = private_root.as_ref();
        let store = LicensePrivateStore::open(private_root).map_err(LicenseOwnerError::from)?;
        let identity =
            LicenseDeviceIdentity::try_new(device_identity).map_err(LicenseOwnerError::from)?;
        if !store.has_state()? {
            if let Some(legacy_state) = super::legacy::import(
                private_root.parent().unwrap_or(private_root),
                &identity,
                config.product(),
            )? {
                store.store_key(&identity, legacy_state.key, legacy_state.cache)?;
                super::legacy::cleanup(private_root.parent().unwrap_or(private_root))?;
            }
        }
        let authority = match config.endpoint() {
            None => None,
            Some(_) => Some(
                LicenseAuthorityClient::new(&config, context)
                    .map_err(|_| LicenseOwnerError::AuthorityUnavailable)?,
            ),
        };
        Ok(Self {
            store,
            identity,
            config,
            authority,
        })
    }

    pub fn gate(&self, now_ms: u64) -> LicenseGateProjection {
        let projection = self.store.snapshot(&self.identity, now_ms);
        let state = match projection.state {
            LicenseProjectionState::CacheBacked => LicenseGateState::Granted,
            LicenseProjectionState::Unknown | LicenseProjectionState::Unavailable => {
                LicenseGateState::Blocked
            }
            LicenseProjectionState::Expired => LicenseGateState::Blocked,
        };
        let reason = match projection.reason {
            super::LicenseProjectionReason::CacheGraceValid => "cache_grace_valid",
            super::LicenseProjectionReason::RevalidationDue => "revalidation_due",
            super::LicenseProjectionReason::Expired => "expired",
            super::LicenseProjectionReason::NoStoredKey => "no_stored_key",
            super::LicenseProjectionReason::NoCachedValidation => "no_cached_validation",
            super::LicenseProjectionReason::IdentityMismatch => "identity_mismatch",
            super::LicenseProjectionReason::KeyHashMismatch => "key_hash_mismatch",
            super::LicenseProjectionReason::CorruptState => "corrupt_state",
            super::LicenseProjectionReason::StorageUnavailable => "storage_unavailable",
            super::LicenseProjectionReason::CryptoUnavailable => "crypto_unavailable",
        };
        LicenseGateProjection {
            state,
            reason: reason.to_owned(),
            checked_at_ms: now_ms,
            has_stored_key: projection.has_stored_key,
            has_usable_cache: projection.has_usable_cache,
            // The private snapshot exposes whether revalidation is due, but not
            // the authority-provided timestamp. Do not invent a due time.
            next_revalidate_at_ms: None,
            last_validation: self.last_validation_projection(&projection),
            renewal_alert: None,
        }
    }

    pub fn stored_key(&self) -> Result<LicenseStoredKeySummary, LicenseOwnerError> {
        let key = match self.store.read_key(&self.identity) {
            Ok(key) => key,
            Err(LicensePrivateError::NoStoredKey) => {
                return Ok(LicenseStoredKeySummary {
                    has_stored_key: false,
                    masked: None,
                    last4: None,
                });
            }
            Err(error) => return Err(LicenseOwnerError::from(error)),
        };
        Ok(summary(key.as_str()))
    }

    pub async fn validate(
        &mut self,
        raw_key: String,
        now_ms: u64,
    ) -> Result<LicenseValidationResult, LicenseOwnerError> {
        let normalized = raw_key.trim().to_ascii_uppercase();
        let key = LicenseKey::try_new(&normalized).map_err(LicenseOwnerError::from)?;
        if !is_license_format(&normalized) {
            return Ok(result(false, "format_invalid", "none", None, &normalized));
        }

        if self.config.allowlist_contains(&key) {
            return self.persist_local(key, now_ms, true, "allowlist");
        }

        if self.config.policy_mode() == LicensePolicyMode::OfflineLocal {
            return self.persist_local(key, now_ms, checksum_valid(&normalized), "checksum");
        }

        let Some(authority) = self.authority.as_ref() else {
            return Ok(result(
                false,
                "service_unconfigured",
                "none",
                None,
                &normalized,
            ));
        };
        match authority.validate(&key, &self.identity).await {
            Ok(validation) => {
                let valid = validation.valid;
                let code = normalize_code(validation.code.as_deref(), valid);
                let mode = "online";
                let source = Some("server");
                let offline_grace_until_ms = if valid {
                    let grace_hours = validation
                        .offline_grace_hours
                        .unwrap_or(self.config.offline_grace_hours());
                    let grace_until = now_ms.saturating_add(grace_hours.saturating_mul(3_600_000));
                    let revalidate_after = validation
                        .refresh_after_sec
                        .map(|seconds| now_ms.saturating_add(seconds.saturating_mul(1_000)));
                    let expires_at_ms = validation
                        .expires_at
                        .as_deref()
                        .map(parse_expiry_timestamp)
                        .transpose()
                        .map_err(|_| LicenseOwnerError::AuthorityUnavailable)?;
                    let cache = LicenseCacheMetadata::try_new(
                        now_ms,
                        grace_until,
                        expires_at_ms,
                        revalidate_after,
                    )
                    .map_err(LicenseOwnerError::from)?;
                    self.store
                        .store_key(&self.identity, key, Some(cache))
                        .map_err(LicenseOwnerError::from)?;
                    Some(grace_until)
                } else {
                    None
                };
                Ok(LicenseValidationResult {
                    valid,
                    code,
                    masked: Some(masked(&normalized)),
                    last4: Some(last4(&normalized)),
                    mode: mode.to_owned(),
                    source: source.map(str::to_owned),
                    expires_at: validation.expires_at,
                    refresh_after_sec: validation.refresh_after_sec,
                    offline_grace_until_ms,
                })
            }
            Err(AuthorityError::Network) | Err(AuthorityError::Unavailable) => {
                if self.config.policy_mode() == LicensePolicyMode::OnlineOptional {
                    return self.persist_local(
                        key,
                        now_ms,
                        checksum_valid(&normalized),
                        "checksum",
                    );
                }
                if let Ok(cached_key) = self.store.read_key(&self.identity) {
                    if cached_key.as_str() == normalized {
                        let cached = self.store.snapshot(&self.identity, now_ms);
                        if cached.has_usable_cache {
                            return Ok(result(
                                true,
                                "cache_grace_valid",
                                "cache",
                                Some("cache"),
                                &normalized,
                            ));
                        }
                    }
                }
                Ok(result(
                    false,
                    "network_error",
                    "online",
                    Some("server"),
                    &normalized,
                ))
            }
            Err(AuthorityError::Unconfigured | AuthorityError::InvalidConfiguration)
            | Err(AuthorityError::InvalidResponse) => Ok(result(
                false,
                "server_rejected",
                "online",
                Some("server"),
                &normalized,
            )),
        }
    }

    pub async fn revalidate(
        &mut self,
        now_ms: u64,
    ) -> Result<LicenseValidationResult, LicenseOwnerError> {
        let key = self
            .store
            .read_key(&self.identity)
            .map_err(LicenseOwnerError::from)?;
        self.validate(key.as_str().to_owned(), now_ms).await
    }

    pub fn clear(&self) -> Result<(), LicenseOwnerError> {
        self.store.clear().map_err(LicenseOwnerError::from)
    }

    fn persist_local(
        &self,
        key: LicenseKey,
        now_ms: u64,
        valid: bool,
        mode: &str,
    ) -> Result<LicenseValidationResult, LicenseOwnerError> {
        if !valid {
            return Ok(result(
                false,
                "checksum_invalid",
                mode,
                Some("local"),
                key.as_str(),
            ));
        }
        let grace_until =
            now_ms.saturating_add(self.config.offline_grace_hours().saturating_mul(3_600_000));
        let cache = LicenseCacheMetadata::try_new(now_ms, grace_until, None, None)
            .map_err(LicenseOwnerError::from)?;
        let validation = result(true, "valid", mode, Some("local"), key.as_str());
        self.store
            .store_key(&self.identity, key, Some(cache))
            .map_err(LicenseOwnerError::from)?;
        Ok(validation)
    }

    fn last_validation_projection(
        &self,
        projection: &LicenseProjection,
    ) -> Option<LicenseValidationResult> {
        let (valid, code, mode, source) = match projection.reason {
            LicenseProjectionReason::CacheGraceValid | LicenseProjectionReason::RevalidationDue => {
                (true, "cache_grace_valid", "cache", Some("cache"))
            }
            LicenseProjectionReason::Expired => (false, "expired", "cache", Some("cache")),
            _ => return None,
        };
        let key = self.store.read_key(&self.identity).ok()?;
        let mut validation = result(valid, code, mode, source, key.as_str());
        validation.expires_at = projection
            .expires_at_ms
            .and_then(|value| i64::try_from(value).ok())
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        validation.offline_grace_until_ms = None;
        Some(validation)
    }
}

fn result(
    valid: bool,
    code: &str,
    mode: &str,
    source: Option<&str>,
    key: &str,
) -> LicenseValidationResult {
    let (masked_value, last4_value) = if key.is_empty() {
        (None, None)
    } else {
        (Some(masked(key)), Some(last4(key)))
    };
    LicenseValidationResult {
        valid,
        code: code.to_owned(),
        masked: masked_value,
        last4: last4_value,
        mode: mode.to_owned(),
        source: source.map(str::to_owned),
        expires_at: None,
        refresh_after_sec: None,
        offline_grace_until_ms: None,
    }
}

fn summary(key: &str) -> LicenseStoredKeySummary {
    LicenseStoredKeySummary {
        has_stored_key: true,
        masked: Some(masked(key)),
        last4: Some(last4(key)),
    }
}

fn masked(key: &str) -> String {
    format!("{LICENSE_PREFIX}-****-****-****-{}", last4(key))
}

fn last4(key: &str) -> String {
    key.chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn is_license_format(value: &str) -> bool {
    let segments: Vec<_> = value.split('-').collect();
    segments.len() == LICENSE_KEY_SEGMENTS
        && segments[0] == LICENSE_PREFIX
        && segments[1..].iter().all(|segment| {
            segment.len() == 4
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        })
}

fn checksum_valid(key: &str) -> bool {
    if !is_license_format(key) {
        return false;
    }
    let segments: Vec<_> = key.split('-').collect();
    let payload = format!("{}-{}-{}", segments[1], segments[2], segments[3]);
    checksum_segment(&payload) == segments[4]
}

fn checksum_segment(payload: &str) -> String {
    let mut state = stable_hash(&format!("{CHECKSUM_CONTEXT}:{payload}"));
    let mut output = String::with_capacity(4);
    for index in 0..4_u32 {
        state = (state ^ (index + 1))
            .wrapping_mul(1_103_515_245)
            .wrapping_add(12_345);
        output.push(CHECKSUM_ALPHABET[(state as usize) % CHECKSUM_ALPHABET.len()] as char);
    }
    output
}

fn stable_hash(value: &str) -> u32 {
    value.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16_776_619)
    })
}

fn parse_expiry_timestamp(value: &str) -> Result<u64, ()> {
    let timestamp = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| ())?
        .timestamp_millis();
    u64::try_from(timestamp).map_err(|_| ())
}

fn normalize_code(code: Option<&str>, valid: bool) -> String {
    let code = code.unwrap_or(if valid { "valid" } else { "server_rejected" });
    match code {
        "valid"
        | "empty"
        | "format_invalid"
        | "service_unconfigured"
        | "network_error"
        | "server_rejected"
        | "cache_grace_valid"
        | "expired"
        | "device_mismatch"
        | "not_allowed"
        | "checksum_invalid" => code.to_owned(),
        _ => "server_rejected".to_owned(),
    }
}
