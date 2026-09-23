use std::{fmt, path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use ::provider::CredentialReference;

use platform::state_dir::{CanonicalStateDir, StateDirError};

const AUTH_PROFILE_STORE_VERSION: u8 = 1;
const AUTH_PROFILES_STATE_KEY: &str = "authProfiles.store";
const AUTH_PROFILES_STATE_STATE_KEY: &str = "authProfiles.state";
const AUTH_SHARED_STORE_STATE_KEY: &str = "auth.sharedStore";
const CREDENTIAL_REFERENCE_PREFIX: &str = "credential:v1:";
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialKind {
    ApiKey,
    OAuth,
    Token,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProfileId(String);

impl ProfileId {
    pub fn try_new(value: String) -> Result<Self, AuthProjectionError> {
        valid_profile_id(&value)
            .then_some(Self(value))
            .ok_or(AuthProjectionError::InvalidProfileId)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProfileId").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn try_new(value: String) -> Result<Self, AuthProjectionError> {
        valid_identifier(&value)
            .then_some(Self(value))
            .ok_or(AuthProjectionError::InvalidProviderId)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ProviderId").field(&self.0).finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthProfile {
    id: ProfileId,
    provider: ProviderId,
    kind: CredentialKind,
}

impl AuthProfile {
    pub fn new(id: ProfileId, provider: ProviderId, kind: CredentialKind) -> Self {
        Self { id, provider, kind }
    }

    pub fn id(&self) -> &ProfileId {
        &self.id
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    pub fn kind(&self) -> CredentialKind {
        self.kind
    }
}

/// Verifies a private credential/profile association without exposing credential material.
pub(crate) fn credential_is_available(
    state_dir: &CanonicalStateDir,
    provider_key: &str,
    reference: &CredentialReference,
    now_millis: u64,
) -> Result<bool, AuthProjectionError> {
    let profiles = match read_shared_auth_profiles(state_dir) {
        Ok(Some(profiles)) => profiles,
        Ok(None) => Vec::new(),
        Err(error) => {
            trace_auth_profile_check(
                state_dir,
                provider_key,
                reference,
                "read-failed",
                0,
                String::new(),
                false,
            );
            return Err(error);
        }
    };
    let available = has_credential_for(&profiles, provider_key, now_millis);
    trace_auth_profile_check(
        state_dir,
        provider_key,
        reference,
        "read-success",
        profiles.len(),
        auth_profile_provider_summary(&profiles),
        available,
    );
    Ok(available)
}

fn read_shared_auth_profiles(
    state_dir: &CanonicalStateDir,
) -> Result<Option<Vec<StateDbAuthProfile>>, AuthProjectionError> {
    let database_path = state_dir.as_path().join("state").join("openclaw.sqlite");
    let values = read_auth_state_values(&database_path)?;
    let Some(shared_store) = values.shared_store else {
        return Ok(None);
    };
    if !is_state_db_shared_store(&shared_store) {
        return Ok(None);
    }
    let Some(store) = values.store else {
        return Ok(None);
    };
    parse_state_db_auth_profiles(&store, values.state.as_ref()).map(Some)
}

struct AuthStateValues {
    shared_store: Option<Value>,
    store: Option<Value>,
    state: Option<Value>,
}

fn read_auth_state_values(database_path: &Path) -> Result<AuthStateValues, AuthProjectionError> {
    if !database_path
        .try_exists()
        .map_err(|_| AuthProjectionError::StateDirectory)?
    {
        return Ok(AuthStateValues {
            shared_store: None,
            store: None,
            state: None,
        });
    }

    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| AuthProjectionError::StateDirectory)?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|_| AuthProjectionError::StateDirectory)?;
    if !has_config_machine_state_table(&connection)? {
        return Ok(AuthStateValues {
            shared_store: None,
            store: None,
            state: None,
        });
    }
    Ok(AuthStateValues {
        shared_store: read_config_machine_state_value(&connection, AUTH_SHARED_STORE_STATE_KEY)?,
        store: read_config_machine_state_value(&connection, AUTH_PROFILES_STATE_KEY)?,
        state: read_config_machine_state_value(&connection, AUTH_PROFILES_STATE_STATE_KEY)?,
    })
}

fn has_config_machine_state_table(connection: &Connection) -> Result<bool, AuthProjectionError> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|_| AuthProjectionError::StateDirectory)
}

fn read_config_machine_state_value(
    connection: &Connection,
    state_key: &str,
) -> Result<Option<Value>, AuthProjectionError> {
    let value_json = connection
        .query_row(
            "SELECT value_json FROM config_machine_state WHERE state_key = ?1",
            [state_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| AuthProjectionError::StateDirectory)?;
    value_json
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| AuthProjectionError::InvalidPersistedAuthProfiles)
        })
        .transpose()
}

fn is_state_db_shared_store(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("location"))
        .and_then(Value::as_str)
        == Some("state-db")
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StateDbAuthProfile {
    id: ProfileId,
    provider: ProviderId,
    kind: CredentialKind,
    expires: Option<u64>,
}

fn parse_state_db_auth_profiles(
    store: &Value,
    state: Option<&Value>,
) -> Result<Vec<StateDbAuthProfile>, AuthProjectionError> {
    let store_profiles = auth_profiles_store_object(store)?;
    if let Some(state) = state {
        validate_auth_profiles_state(state)?;
    }
    let mut profiles = Vec::new();
    for (id, profile) in store_profiles {
        let kind = auth_profile_kind(profile)?;
        let Some(expires) = auth_profile_credential_expires(profile, kind)? else {
            continue;
        };
        profiles.push(StateDbAuthProfile {
            id: ProfileId::try_new(id.to_owned())?,
            provider: auth_profile_provider(profile)?,
            kind,
            expires,
        });
    }
    Ok(profiles)
}

fn auth_profiles_store_object(
    value: &Value,
) -> Result<&serde_json::Map<String, Value>, AuthProjectionError> {
    let object = value
        .as_object()
        .ok_or(AuthProjectionError::InvalidPersistedAuthProfiles)?;
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(AUTH_PROFILE_STORE_VERSION))
    {
        return Err(AuthProjectionError::InvalidPersistedAuthProfiles);
    }
    object
        .get("profiles")
        .and_then(Value::as_object)
        .ok_or(AuthProjectionError::InvalidPersistedAuthProfiles)
}

fn validate_auth_profiles_state(value: &Value) -> Result<(), AuthProjectionError> {
    let object = value
        .as_object()
        .ok_or(AuthProjectionError::InvalidPersistedAuthProfiles)?;
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(AUTH_PROFILE_STORE_VERSION))
    {
        return Err(AuthProjectionError::InvalidPersistedAuthProfiles);
    }
    Ok(())
}

fn auth_profile_provider(value: &Value) -> Result<ProviderId, AuthProjectionError> {
    value
        .as_object()
        .and_then(|object| object.get("provider"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(AuthProjectionError::InvalidPersistedAuthProfiles)
        .and_then(ProviderId::try_new)
}

fn auth_profile_kind(value: &Value) -> Result<CredentialKind, AuthProjectionError> {
    match value
        .as_object()
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
    {
        Some("api_key") => Ok(CredentialKind::ApiKey),
        Some("oauth") => Ok(CredentialKind::OAuth),
        Some("token") => Ok(CredentialKind::Token),
        _ => Err(AuthProjectionError::InvalidPersistedAuthProfiles),
    }
}

fn auth_profile_credential_expires(
    value: &Value,
    kind: CredentialKind,
) -> Result<Option<Option<u64>>, AuthProjectionError> {
    let Some(profile) = value.as_object() else {
        return Ok(None);
    };
    match kind {
        CredentialKind::ApiKey => Ok((has_present_field(profile, "key")
            || has_present_field(profile, "keyRef"))
        .then_some(None)),
        CredentialKind::OAuth => Ok((has_present_field(profile, "access")
            || has_present_field(profile, "refresh"))
        .then_some(None)),
        CredentialKind::Token => {
            if !(has_present_field(profile, "token") || has_present_field(profile, "tokenRef")) {
                return Ok(None);
            }
            profile
                .get("expires")
                .map(|value| {
                    value
                        .as_u64()
                        .ok_or(AuthProjectionError::InvalidPersistedAuthProfiles)
                })
                .transpose()
                .map(Some)
        }
    }
}

fn has_present_field(profile: &serde_json::Map<String, Value>, field: &str) -> bool {
    match profile.get(field) {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn has_credential_for(
    profiles: &[StateDbAuthProfile],
    provider_key: &str,
    now_millis: u64,
) -> bool {
    profiles
        .iter()
        .any(|profile| auth_profile_is_available(profile, provider_key, now_millis))
}

fn auth_profile_is_available(
    profile: &StateDbAuthProfile,
    provider_key: &str,
    now_millis: u64,
) -> bool {
    if profile.provider.as_str() != provider_key {
        return false;
    }
    match profile.kind {
        CredentialKind::ApiKey | CredentialKind::OAuth => true,
        CredentialKind::Token => match profile.expires {
            Some(expires) => expires > now_millis,
            None => true,
        },
    }
}

fn auth_profile_provider_summary(profiles: &[StateDbAuthProfile]) -> String {
    let mut providers = profiles
        .iter()
        .map(|profile| profile.provider.as_str())
        .collect::<Vec<_>>();
    providers.sort_unstable();
    providers.dedup();
    providers.join(",")
}

fn trace_auth_profile_check(
    state_dir: &CanonicalStateDir,
    provider_key: &str,
    reference: &CredentialReference,
    phase: &'static str,
    profile_count: usize,
    profile_providers: String,
    available: bool,
) {
    eprintln!(
        "[startup-trace] source=openclaw-auth-state-db phase={} state_dir={} required_provider={} credential_ref={} profile_count={} profile_providers={} available={}",
        phase,
        state_dir.as_path().display(),
        provider_key,
        summarize_reference(reference.as_str()),
        profile_count,
        profile_providers,
        available,
    );
}

fn summarize_reference(reference: &str) -> String {
    let suffix = reference
        .strip_prefix(CREDENTIAL_REFERENCE_PREFIX)
        .unwrap_or(reference);
    format!(
        "len:{} tail:{}",
        suffix.len(),
        suffix.rsplit(':').next().unwrap_or(suffix)
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthProjectionError {
    InvalidProfileId,
    InvalidPersistedAuthProfiles,
    InvalidProviderId,
    StateDirectory,
}

impl fmt::Display for AuthProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProfileId => {
                formatter.write_str("OpenClaw auth profile identifier is invalid")
            }
            Self::InvalidPersistedAuthProfiles => {
                formatter.write_str("OpenClaw private auth profile document is invalid")
            }
            Self::InvalidProviderId => {
                formatter.write_str("OpenClaw provider identifier is invalid")
            }
            Self::StateDirectory => {
                formatter.write_str("OpenClaw private auth profile state directory unavailable")
            }
        }
    }
}

impl std::error::Error for AuthProjectionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidProfileId
            | Self::InvalidPersistedAuthProfiles
            | Self::InvalidProviderId
            | Self::StateDirectory => None,
        }
    }
}

impl From<StateDirError> for AuthProjectionError {
    fn from(_: StateDirError) -> Self {
        Self::StateDirectory
    }
}

fn valid_profile_id(value: &str) -> bool {
    CredentialReference::try_new(format!("credential:v1:{value}")).is_ok()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[cfg(test)]
mod tests;
