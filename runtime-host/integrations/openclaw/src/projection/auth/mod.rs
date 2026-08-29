use std::fmt;

use serde::{
    Deserialize,
    de::{self, IgnoredAny, MapAccess, Visitor},
};
use zeroize::Zeroizing;

use environment::CredentialReference;

use crate::lifecycle::state_dir::{AgentId, CanonicalStateDir, PrivateAuthProfiles, StateDirError};

const AUTH_PROFILE_STORE_VERSION: u8 = 1;
const CREDENTIAL_REFERENCE_PREFIX: &str = "credential:v1:";
const REDACTED: &str = "[REDACTED]";

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

pub struct PrivateCredential(Zeroizing<Vec<u8>>);

impl PrivateCredential {
    pub fn try_new(value: String) -> Result<Self, AuthProjectionError> {
        (!value.trim().is_empty())
            .then_some(Self(Zeroizing::new(value.into_bytes())))
            .ok_or(AuthProjectionError::EmptyCredential)
    }

    fn is_present(&self) -> bool {
        !self.0.is_empty()
    }
}

impl fmt::Debug for PrivateCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("PrivateCredential")
            .field(&REDACTED)
            .finish()
    }
}

impl<'de> Deserialize<'de> for PrivateCredential {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::try_new(String::deserialize(deserializer)?)
            .map_err(|_| de::Error::custom("invalid credential"))
    }
}

pub struct PrivateAuthProfile {
    profile: AuthProfile,
    credential: PrivateAuthCredential,
}

impl PrivateAuthProfile {
    pub fn api_key(id: ProfileId, provider: ProviderId, key: PrivateCredential) -> Self {
        Self::api_key_secret(id, provider, PrivateAuthSecret::Inline(key))
    }

    pub fn token(id: ProfileId, provider: ProviderId, token: PrivateCredential) -> Self {
        Self::token_secret(id, provider, PrivateAuthSecret::Inline(token))
    }

    fn api_key_secret(id: ProfileId, provider: ProviderId, key: PrivateAuthSecret) -> Self {
        Self::new(id, provider, PrivateAuthCredential::ApiKey(key))
    }

    fn token_secret(id: ProfileId, provider: ProviderId, token: PrivateAuthSecret) -> Self {
        Self::new(id, provider, PrivateAuthCredential::Token(token))
    }

    pub fn oauth(
        id: ProfileId,
        provider: ProviderId,
        access: PrivateCredential,
        refresh: PrivateCredential,
        expires: u64,
    ) -> Self {
        Self::new(
            id,
            provider,
            PrivateAuthCredential::OAuth {
                access,
                refresh,
                expires,
            },
        )
    }

    fn new(id: ProfileId, provider: ProviderId, credential: PrivateAuthCredential) -> Self {
        let kind = credential.kind();
        Self {
            profile: AuthProfile::new(id, provider, kind),
            credential,
        }
    }

    fn profile(&self) -> &AuthProfile {
        &self.profile
    }
}

impl fmt::Debug for PrivateAuthProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivateAuthProfile")
            .field("profile", &self.profile)
            .field("credential", &REDACTED)
            .finish()
    }
}

enum PrivateAuthCredential {
    ApiKey(PrivateAuthSecret),
    OAuth {
        access: PrivateCredential,
        refresh: PrivateCredential,
        expires: u64,
    },
    Token(PrivateAuthSecret),
}

impl PrivateAuthCredential {
    fn kind(&self) -> CredentialKind {
        match self {
            Self::ApiKey(_) => CredentialKind::ApiKey,
            Self::OAuth { .. } => CredentialKind::OAuth,
            Self::Token(_) => CredentialKind::Token,
        }
    }
}

enum PrivateAuthSecret {
    Inline(PrivateCredential),
    Reference(SecretReference),
}

impl PrivateAuthSecret {
    fn is_present(&self) -> bool {
        match self {
            Self::Inline(credential) => credential.is_present(),
            Self::Reference(_) => true,
        }
    }
}

struct SecretReference;

impl<'de> Deserialize<'de> for SecretReference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(SecretReferenceVisitor)
    }
}

struct SecretReferenceVisitor;

impl<'de> Visitor<'de> for SecretReferenceVisitor {
    type Value = SecretReference;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw secret reference")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut source = None;
        let mut provider = None;
        let mut id = None;
        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "source" if source.is_none() => source = Some(map.next_value::<String>()?),
                "provider" if provider.is_none() => provider = Some(map.next_value::<String>()?),
                "id" if id.is_none() => id = Some(map.next_value::<String>()?),
                _ => return Err(de::Error::custom("invalid secret reference field")),
            }
        }
        let source = source.ok_or_else(|| de::Error::missing_field("source"))?;
        if !matches!(source.as_str(), "env" | "file" | "exec") {
            return Err(de::Error::custom("invalid secret reference source"));
        }
        let provider = provider.ok_or_else(|| de::Error::missing_field("provider"))?;
        if !valid_identifier(&provider) {
            return Err(de::Error::custom("invalid secret reference provider"));
        }
        let id = id.ok_or_else(|| de::Error::missing_field("id"))?;
        if !valid_identifier(&id) {
            return Err(de::Error::custom("invalid secret reference id"));
        }
        Ok(SecretReference)
    }
}

/// Verifies a private credential/profile association without exposing credential material.
pub(crate) fn credential_is_available(
    state_dir: &CanonicalStateDir,
    provider_key: &str,
    reference: &CredentialReference,
    now_millis: u64,
) -> Result<bool, AuthProjectionError> {
    let agent = AgentId::try_new("main".into()).map_err(|_| AuthProjectionError::StateDirectory)?;
    let profiles = match state_dir.read_auth_profiles(&agent) {
        Ok(Some(contents)) => parse_auth_profiles(&contents)?,
        Ok(None) => Vec::new(),
        Err(_) => {
            trace_auth_profile_check(
                state_dir,
                &agent,
                provider_key,
                reference,
                "read-failed",
                0,
                String::new(),
                false,
            );
            return Err(AuthProjectionError::StateDirectory);
        }
    };
    let available = has_credential_for(&profiles, provider_key, reference, now_millis);
    trace_auth_profile_check(
        state_dir,
        &agent,
        provider_key,
        reference,
        "read-success",
        profiles.len(),
        auth_profile_provider_summary(&profiles),
        available,
    );
    Ok(available)
}

fn has_credential_for(
    profiles: &[PrivateAuthProfile],
    provider_key: &str,
    reference: &CredentialReference,
    now_millis: u64,
) -> bool {
    if !reference.as_str().starts_with(CREDENTIAL_REFERENCE_PREFIX) {
        return false;
    }
    profiles.iter().any(|profile| {
        profile.profile().provider().as_str() == provider_key
            && credential_is_usable(&profile.credential, now_millis)
    })
}

fn auth_profile_provider_summary(profiles: &[PrivateAuthProfile]) -> String {
    let mut providers = profiles
        .iter()
        .map(|profile| profile.profile().provider().as_str())
        .collect::<Vec<_>>();
    providers.sort_unstable();
    providers.dedup();
    providers.join(",")
}

fn trace_auth_profile_check(
    state_dir: &CanonicalStateDir,
    agent: &AgentId,
    provider_key: &str,
    reference: &CredentialReference,
    phase: &'static str,
    profile_count: usize,
    profile_providers: String,
    available: bool,
) {
    eprintln!(
        "[startup-trace] source=openclaw-auth-profiles phase={} state_dir={} agent={} required_provider={} credential_ref={} profile_count={} profile_providers={} available={}",
        phase,
        state_dir.as_path().display(),
        agent.as_str(),
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

fn credential_is_usable(credential: &PrivateAuthCredential, now_millis: u64) -> bool {
    match credential {
        PrivateAuthCredential::ApiKey(key) | PrivateAuthCredential::Token(key) => key.is_present(),
        PrivateAuthCredential::OAuth {
            access,
            refresh,
            expires,
        } => access.is_present() && refresh.is_present() && *expires > now_millis,
    }
}

fn parse_auth_profiles(
    contents: &PrivateAuthProfiles,
) -> Result<Vec<PrivateAuthProfile>, AuthProjectionError> {
    let document = serde_json::from_slice::<PersistedAuthProfileStoreDocument>(contents.as_bytes())
        .map_err(|_| AuthProjectionError::InvalidPersistedAuthProfiles)?;
    if document.version != AUTH_PROFILE_STORE_VERSION {
        return Err(AuthProjectionError::InvalidPersistedAuthProfiles);
    }
    Ok(document.profiles)
}

struct PersistedAuthProfileStoreDocument {
    version: u8,
    profiles: Vec<PrivateAuthProfile>,
}

impl<'de> Deserialize<'de> for PersistedAuthProfileStoreDocument {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(PersistedAuthProfileStoreVisitor)
    }
}

struct PersistedAuthProfileStoreVisitor;

impl<'de> Visitor<'de> for PersistedAuthProfileStoreVisitor {
    type Value = PersistedAuthProfileStoreDocument;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw auth profile document")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut version = None;
        let mut profiles = None;
        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "version" if version.is_none() => version = Some(map.next_value()?),
                "profiles" if profiles.is_none() => {
                    profiles = Some(map.next_value::<PersistedAuthProfilesDocument>()?.0)
                }
                "order" | "lastGood" | "usageStats" => {
                    let _ = map.next_value::<IgnoredAny>()?;
                }
                _ => return Err(de::Error::custom("invalid auth profile document")),
            }
        }
        Ok(PersistedAuthProfileStoreDocument {
            version: version.ok_or_else(|| de::Error::missing_field("version"))?,
            profiles: profiles.ok_or_else(|| de::Error::missing_field("profiles"))?,
        })
    }
}

struct PersistedAuthProfilesDocument(Vec<PrivateAuthProfile>);

impl<'de> Deserialize<'de> for PersistedAuthProfilesDocument {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(PersistedAuthProfilesVisitor)
    }
}

struct PersistedAuthProfilesVisitor;

impl<'de> Visitor<'de> for PersistedAuthProfilesVisitor {
    type Value = PersistedAuthProfilesDocument;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw auth profile map")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut profiles = Vec::new();
        while let Some(id) = map.next_key::<String>()? {
            let id = ProfileId::try_new(id)
                .map_err(|_| de::Error::custom("invalid auth profile identifier"))?;
            if profiles
                .iter()
                .any(|profile: &PrivateAuthProfile| profile.profile().id() == &id)
            {
                return Err(de::Error::custom("invalid auth profile identifier"));
            }
            let profile = map.next_value::<PersistedAuthProfileDocument>()?;
            profiles.push(profile.into_private(id));
        }
        Ok(PersistedAuthProfilesDocument(profiles))
    }
}

struct PersistedAuthProfileDocument {
    kind: PersistedAuthProfileKind,
    provider: ProviderId,
}

enum PersistedAuthProfileKind {
    ApiKey(PrivateAuthSecret),
    OAuth {
        access: PrivateCredential,
        refresh: PrivateCredential,
        expires: u64,
    },
    Token(PrivateAuthSecret),
}

impl PersistedAuthProfileDocument {
    fn into_private(self, id: ProfileId) -> PrivateAuthProfile {
        match self.kind {
            PersistedAuthProfileKind::ApiKey(key) => {
                PrivateAuthProfile::api_key_secret(id, self.provider, key)
            }
            PersistedAuthProfileKind::OAuth {
                access,
                refresh,
                expires,
            } => PrivateAuthProfile::oauth(id, self.provider, access, refresh, expires),
            PersistedAuthProfileKind::Token(token) => {
                PrivateAuthProfile::token_secret(id, self.provider, token)
            }
        }
    }
}

impl<'de> Deserialize<'de> for PersistedAuthProfileDocument {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_map(PersistedAuthProfileVisitor)
    }
}

struct PersistedAuthProfileVisitor;

impl<'de> Visitor<'de> for PersistedAuthProfileVisitor {
    type Value = PersistedAuthProfileDocument;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw auth profile")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut kind = None;
        let mut provider = None;
        let mut key = None;
        let mut token = None;
        let mut access = None;
        let mut refresh = None;
        let mut expires = None;
        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "type" if kind.is_none() => kind = Some(map.next_value::<String>()?),
                "provider" if provider.is_none() => provider = Some(map.next_value::<String>()?),
                "key" if key.is_none() => {
                    key = Some(PrivateAuthSecret::Inline(
                        map.next_value::<PrivateCredential>()?,
                    ))
                }
                "keyRef" if key.is_none() => {
                    key = Some(PrivateAuthSecret::Reference(
                        map.next_value::<SecretReference>()?,
                    ))
                }
                "token" if token.is_none() => {
                    token = Some(PrivateAuthSecret::Inline(
                        map.next_value::<PrivateCredential>()?,
                    ))
                }
                "tokenRef" if token.is_none() => {
                    token = Some(PrivateAuthSecret::Reference(
                        map.next_value::<SecretReference>()?,
                    ))
                }
                "access" if access.is_none() => {
                    access = Some(map.next_value::<PrivateCredential>()?)
                }
                "refresh" if refresh.is_none() => {
                    refresh = Some(map.next_value::<PrivateCredential>()?)
                }
                "expires" if expires.is_none() => expires = Some(map.next_value::<u64>()?),
                "copyToAgents" | "email" | "displayName" | "metadata" | "clientId"
                | "enterpriseUrl" | "projectId" | "accountId" | "chatgptPlanType" | "idToken" => {
                    let _ = map.next_value::<IgnoredAny>()?;
                }
                _ => return Err(de::Error::custom("invalid auth profile field")),
            }
        }
        let provider = provider
            .ok_or_else(|| de::Error::missing_field("provider"))
            .and_then(|provider| {
                ProviderId::try_new(provider).map_err(|_| de::Error::custom("invalid provider"))
            })?;
        match kind.as_deref() {
            Some("api_key")
                if token.is_none()
                    && access.is_none()
                    && refresh.is_none()
                    && expires.is_none() =>
            {
                let key = key.ok_or_else(|| de::Error::missing_field("key"))?;
                Ok(PersistedAuthProfileDocument {
                    kind: PersistedAuthProfileKind::ApiKey(key),
                    provider,
                })
            }
            Some("token")
                if key.is_none() && access.is_none() && refresh.is_none() && expires.is_none() =>
            {
                let token = token.ok_or_else(|| de::Error::missing_field("token"))?;
                Ok(PersistedAuthProfileDocument {
                    kind: PersistedAuthProfileKind::Token(token),
                    provider,
                })
            }
            Some("oauth") if key.is_none() && token.is_none() => {
                let access = access.ok_or_else(|| de::Error::missing_field("access"))?;
                let refresh = refresh.ok_or_else(|| de::Error::missing_field("refresh"))?;
                let expires = expires.ok_or_else(|| de::Error::missing_field("expires"))?;
                Ok(PersistedAuthProfileDocument {
                    kind: PersistedAuthProfileKind::OAuth {
                        access,
                        refresh,
                        expires,
                    },
                    provider,
                })
            }
            _ => Err(de::Error::custom("invalid auth profile type")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthProjectionError {
    EmptyCredential,
    InvalidProfileId,
    InvalidPersistedAuthProfiles,
    InvalidProviderId,
    StateDirectory,
}

impl fmt::Display for AuthProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyCredential => formatter.write_str("OpenClaw credential is invalid"),
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
            Self::EmptyCredential
            | Self::InvalidProfileId
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
