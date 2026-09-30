use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use zeroize::Zeroize;

use super::SkillUploadOutcome;
use crate::gateway::{
    client::GatewayClient,
    config_patch::{destructive_array_replace_paths, merge_patch},
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

const DETAIL: &str = "skills.detail";
const INSTALL: &str = "skills.install";
const UPDATE: &str = "skills.update";
const UPLOAD_BEGIN: &str = "skills.upload.begin";
const UPLOAD_CHUNK: &str = "skills.upload.chunk";
const UPLOAD_COMMIT: &str = "skills.upload.commit";

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default, Eq, PartialEq)]
pub struct SkillRequestContext {
    agent_id: Option<String>,
}

impl SkillRequestContext {
    pub fn new(agent_id: Option<String>) -> Result<Self, SkillRequestError> {
        Ok(Self {
            agent_id: agent_id.map(clean_identity).transpose()?,
        })
    }

    fn apply_agent(&self, params: &mut Value) {
        let Some(params) = params.as_object_mut() else {
            return;
        };
        if let Some(agent_id) = &self.agent_id {
            params.insert("agentId".to_owned(), Value::String(agent_id.clone()));
        }
    }
}

impl fmt::Debug for SkillRequestContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SkillRequestContext")
            .field("agent_id", &self.agent_id.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetailRequest {
    slug: String,
}

impl SkillDetailRequest {
    pub fn try_new(slug: String) -> Result<Self, SkillRequestError> {
        let slug = canonical_slug(&slug).ok_or(SkillRequestError::InvalidSlug)?;
        Ok(Self { slug })
    }
    fn params(self) -> Value {
        json!({ "slug": self.slug })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetail {
    skill: Option<SkillDetailSkill>,
    latest_version: Option<SkillDetailLatestVersion>,
    metadata: Option<SkillDetailMetadata>,
    owner: Option<SkillDetailOwner>,
}

impl SkillDetail {
    pub fn skill(&self) -> Option<&SkillDetailSkill> {
        self.skill.as_ref()
    }
    pub fn latest_version(&self) -> Option<&SkillDetailLatestVersion> {
        self.latest_version.as_ref()
    }
    pub fn metadata(&self) -> Option<&SkillDetailMetadata> {
        self.metadata.as_ref()
    }
    pub fn owner(&self) -> Option<&SkillDetailOwner> {
        self.owner.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetailSkill {
    slug: String,
    display_name: String,
    summary: Option<String>,
    tags: std::collections::BTreeMap<String, String>,
    created_at: u64,
    updated_at: u64,
}

impl SkillDetailSkill {
    pub fn slug(&self) -> &str {
        &self.slug
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }
    pub fn tags(&self) -> &std::collections::BTreeMap<String, String> {
        &self.tags
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetailLatestVersion {
    version: String,
    created_at: u64,
    changelog: Option<String>,
}

impl SkillDetailLatestVersion {
    pub fn version(&self) -> &str {
        &self.version
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
    pub fn changelog(&self) -> Option<&str> {
        self.changelog.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetailMetadata {
    os: Option<Vec<String>>,
    systems: Option<Vec<String>>,
}

impl SkillDetailMetadata {
    pub fn os(&self) -> Option<&[String]> {
        self.os.as_deref()
    }
    pub fn systems(&self) -> Option<&[String]> {
        self.systems.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillDetailOwner {
    handle: Option<String>,
    display_name: Option<String>,
    image: Option<String>,
}

impl SkillDetailOwner {
    pub fn handle(&self) -> Option<&str> {
        self.handle.as_deref()
    }
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }
    pub fn image(&self) -> Option<&str> {
        self.image.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillRequestError {
    InvalidSlug,
    InvalidUpload,
    InvalidChunk,
    InvalidConfig,
    InvalidContext,
}

impl fmt::Display for SkillRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidSlug => "skill slug is invalid",
            Self::InvalidUpload => "skill upload request is invalid",
            Self::InvalidChunk => "skill upload chunk is invalid",
            Self::InvalidConfig => "skill config update is invalid",
            Self::InvalidContext => "skill request context is invalid",
        })
    }
}
impl std::error::Error for SkillRequestError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillInstallSource {
    Upload {
        upload_id: String,
        slug: String,
        force: Option<bool>,
        sha256: Option<String>,
    },
    Installer {
        package: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillInstallRequest {
    source: SkillInstallSource,
}

impl SkillInstallRequest {
    pub fn upload(
        upload_id: String,
        slug: String,
        force: Option<bool>,
        sha256: Option<String>,
    ) -> Result<Self, SkillRequestError> {
        if !valid_name(&upload_id) || canonical_slug(&slug).is_none() {
            return Err(SkillRequestError::InvalidUpload);
        }
        Ok(Self {
            source: SkillInstallSource::Upload {
                upload_id,
                slug: canonical_slug(&slug).expect("validated slug"),
                force,
                sha256: clean_optional(sha256),
            },
        })
    }
    pub fn installer(package: String) -> Result<Self, SkillRequestError> {
        if !valid_name(&package) {
            return Err(SkillRequestError::InvalidSlug);
        }
        Ok(Self {
            source: SkillInstallSource::Installer { package },
        })
    }
    fn params(self) -> Value {
        match self.source {
            SkillInstallSource::Upload {
                upload_id,
                slug,
                force,
                sha256,
            } => {
                let mut value = json!({ "source": "upload", "uploadId": upload_id, "slug": slug });
                if let Some(force) = force {
                    value["force"] = json!(force);
                }
                if let Some(sha256) = sha256 {
                    value["sha256"] = json!(sha256);
                }
                value
            }
            SkillInstallSource::Installer { package } => {
                json!({ "name": package, "installId": "runtime-host" })
            }
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum SkillUpdateRequest {
    Config {
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<PrivateSkillValue>,
        env: Option<std::collections::BTreeMap<String, PrivateSkillValue>>,
    },
    ClawHub {
        slug: Option<String>,
        all: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillConfigRemoveOutcome {
    Removed,
    NotFound,
    Rejected,
    Unknown,
}

impl SkillUpdateRequest {
    pub fn config(
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<String>,
        env: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<Self, SkillRequestError> {
        let skill_key =
            clean_openclaw_skill_key(skill_key).ok_or(SkillRequestError::InvalidConfig)?;
        Ok(Self::Config {
            skill_key,
            enabled,
            api_key: api_key.map(PrivateSkillValue::new),
            env: env.map(|values| {
                values
                    .into_iter()
                    .map(|(key, value)| (key, PrivateSkillValue::new(value)))
                    .collect()
            }),
        })
    }
    pub fn clawhub(slug: Option<String>, all: bool) -> Result<Self, SkillRequestError> {
        let slug = slug
            .map(|v| canonical_name(&v).ok_or(SkillRequestError::InvalidSlug))
            .transpose()?;
        if slug.is_none() && !all {
            return Err(SkillRequestError::InvalidSlug);
        }
        Ok(Self::ClawHub { slug, all })
    }
    fn params(self) -> Value {
        match self {
            Self::Config {
                skill_key,
                enabled,
                api_key,
                env,
            } => {
                let mut value = json!({ "skillKey": skill_key });
                if let Some(enabled) = enabled {
                    value["enabled"] = json!(enabled);
                }
                if let Some(mut api_key) = api_key {
                    value["apiKey"] = json!(api_key.as_str());
                    api_key.zeroize();
                }
                if let Some(mut env) = env {
                    let projected = env
                        .iter()
                        .map(|(key, value)| (key.clone(), Value::String(value.as_str().to_owned())))
                        .collect::<serde_json::Map<_, _>>();
                    value["env"] = Value::Object(projected);
                    env.values_mut().for_each(Zeroize::zeroize);
                }
                value
            }
            Self::ClawHub { slug, all } => {
                let mut value = json!({ "source": "clawhub" });
                if let Some(slug) = slug {
                    value["slug"] = json!(slug);
                }
                if all {
                    value["all"] = json!(true);
                }
                value
            }
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PrivateSkillValue(String);
impl fmt::Debug for SkillUpdateRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config {
                skill_key,
                enabled,
                api_key,
                env,
            } => f
                .debug_struct("Config")
                .field("skill_key", skill_key)
                .field("enabled", enabled)
                .field("api_key", &api_key.as_ref().map(|_| "[REDACTED]"))
                .field("env", &env.as_ref().map(|_| "[REDACTED]"))
                .finish(),
            Self::ClawHub { slug, all } => f
                .debug_struct("ClawHub")
                .field("slug", slug)
                .field("all", all)
                .finish(),
        }
    }
}

impl PrivateSkillValue {
    fn new(value: String) -> Self {
        Self(value)
    }
    fn as_str(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for PrivateSkillValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}
impl Zeroize for PrivateSkillValue {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}
impl Drop for PrivateSkillValue {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillUploadBegin {
    name: String,
    size: u64,
    sha256: Option<String>,
    force: Option<bool>,
    idempotency_key: Option<String>,
}
impl SkillUploadBegin {
    pub fn try_new(
        name: String,
        size: u64,
        sha256: Option<String>,
        force: Option<bool>,
        idempotency_key: Option<String>,
    ) -> Result<Self, SkillRequestError> {
        if !valid_name(&name) {
            return Err(SkillRequestError::InvalidUpload);
        }
        if sha256
            .as_deref()
            .is_some_and(|value| value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(SkillRequestError::InvalidUpload);
        }
        Ok(Self {
            name,
            size,
            sha256: sha256.map(|value| value.to_ascii_lowercase()),
            force,
            idempotency_key,
        })
    }
    fn params(self) -> Value {
        let mut value =
            json!({ "kind": "skill-archive", "slug": self.name, "sizeBytes": self.size });
        if let Some(sha256) = self.sha256 {
            value["sha256"] = json!(sha256);
        }
        if let Some(force) = self.force {
            value["force"] = json!(force);
        }
        if let Some(idempotency_key) = self.idempotency_key {
            value["idempotencyKey"] = json!(idempotency_key);
        }
        value
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillUploadChunk {
    upload_id: String,
    offset: u64,
    bytes: Vec<u8>,
}
impl SkillUploadChunk {
    pub fn try_new(
        upload_id: String,
        offset: u64,
        bytes: Vec<u8>,
    ) -> Result<Self, SkillRequestError> {
        if !valid_name(&upload_id) || bytes.is_empty() {
            return Err(SkillRequestError::InvalidChunk);
        }
        Ok(Self {
            upload_id,
            offset,
            bytes,
        })
    }
    fn params(self) -> Value {
        json!({ "uploadId": self.upload_id, "offset": self.offset, "dataBase64": STANDARD.encode(self.bytes) })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillUploadCommit {
    upload_id: String,
    sha256: Option<String>,
}
impl SkillUploadCommit {
    pub fn try_new(upload_id: String, sha256: Option<String>) -> Result<Self, SkillRequestError> {
        if !valid_name(&upload_id)
            || sha256.as_deref().is_some_and(|value| {
                value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err(SkillRequestError::InvalidUpload);
        }
        Ok(Self {
            upload_id,
            sha256: sha256.map(|value| value.to_ascii_lowercase()),
        })
    }
    fn params(self) -> Value {
        let mut value = json!({ "uploadId": self.upload_id });
        if let Some(sha256) = self.sha256 {
            value["sha256"] = json!(sha256);
        }
        value
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillMutationOutcome {
    Accepted,
    Rejected,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillReadError {
    Unavailable,
    Rejected,
    Protocol,
}

pub struct OpenClawSkillOperations {
    gateway: Arc<GatewayClient>,
    context: SkillRequestContext,
}
impl OpenClawSkillOperations {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self {
            gateway,
            context: SkillRequestContext::default(),
        }
    }

    pub fn with_context(gateway: Arc<GatewayClient>, context: SkillRequestContext) -> Self {
        Self { gateway, context }
    }

    pub fn for_agent(
        gateway: Arc<GatewayClient>,
        agent_id: String,
    ) -> Result<Self, SkillRequestError> {
        Ok(Self::with_context(
            gateway,
            SkillRequestContext::new(Some(agent_id))?,
        ))
    }

    pub async fn detail(&self, request: SkillDetailRequest) -> Result<SkillDetail, SkillReadError> {
        self.read(DETAIL, request.params(), decode_detail).await
    }
    pub async fn install(&self, request: SkillInstallRequest) -> SkillMutationOutcome {
        self.mutate(INSTALL, self.agent_params(request.params()))
            .await
    }
    pub async fn update(&self, request: SkillUpdateRequest) -> SkillMutationOutcome {
        let needs_agent = matches!(&request, SkillUpdateRequest::ClawHub { .. });
        let params = request.params();
        let params = if needs_agent {
            self.agent_params(params)
        } else {
            params
        };
        self.mutate(UPDATE, params).await
    }
    pub async fn configure(
        &self,
        request: SkillUpdateRequest,
    ) -> (SkillMutationOutcome, Vec<String>) {
        let env_keys = match &request {
            SkillUpdateRequest::Config { env, .. } => env
                .as_ref()
                .map(|env| env.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let invalid_keys = match &request {
            SkillUpdateRequest::Config { env, .. } => env
                .as_ref()
                .map(|env| {
                    env.keys()
                        .filter(|key| key.trim().is_empty())
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            _ => return (SkillMutationOutcome::Rejected, Vec::new()),
        };
        let Ok(request) = wire::operations_request(next_id(UPDATE), UPDATE, request.params())
        else {
            return (SkillMutationOutcome::Rejected, invalid_keys);
        };
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Success {
                payload: Some(Value::Object(payload)),
                ..
            }) if payload.get("ok") == Some(&Value::Bool(true)) => {
                let mut invalid_keys = invalid_keys;
                if let Some(keys) = payload.get("invalidKeys") {
                    let Some(keys) = keys
                        .as_array()
                        .filter(|keys| keys.len() <= env_keys.len())
                        .and_then(|keys| {
                            keys.iter()
                                .map(|key| {
                                    key.as_str()
                                        .filter(|key| env_keys.iter().any(|known| known == key))
                                        .map(str::to_owned)
                                })
                                .collect::<Option<Vec<_>>>()
                        })
                    else {
                        return (SkillMutationOutcome::Unknown, invalid_keys);
                    };
                    for key in keys {
                        if !invalid_keys.contains(&key) {
                            invalid_keys.push(key);
                        }
                    }
                }
                (SkillMutationOutcome::Accepted, invalid_keys)
            }
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                (SkillMutationOutcome::Rejected, invalid_keys)
            }
            _ => (SkillMutationOutcome::Unknown, invalid_keys),
        }
    }

    pub async fn remove_config(&self, skill_key: String) -> SkillConfigRemoveOutcome {
        let Some(skill_key) = clean_openclaw_skill_key(skill_key) else {
            return SkillConfigRemoveOutcome::Rejected;
        };
        for _ in 0..3 {
            match self.remove_config_once(&skill_key).await {
                ConfigRemoveAttempt::Conflict => {}
                ConfigRemoveAttempt::Outcome(outcome) => return outcome,
            }
        }
        SkillConfigRemoveOutcome::Rejected
    }

    async fn remove_config_once(&self, skill_key: &str) -> ConfigRemoveAttempt {
        let get = match wire::team::config_get_request(next_id("skill-config-get")) {
            Ok(request) => request,
            Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
        };
        let snapshot = match self.gateway.rpc_query(get).await {
            Ok(GatewayResponse::Failure { .. }) => {
                return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Rejected);
            }
            Ok(response) => match wire::team::decode_config_get(response) {
                Ok(snapshot) => snapshot,
                Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
            },
            Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
        };
        let (mut source, base_hash) = snapshot.into_source_config_parts();
        let mut target = source.clone();
        let Some(mut removed) = remove_skill_config_entry(&mut target, skill_key) else {
            zeroize_value(&mut source);
            zeroize_value(&mut target);
            return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::NotFound);
        };
        zeroize_value(&mut removed);
        let mut patch = merge_patch(&source, &target);
        let replace_paths = destructive_array_replace_paths(&source, &target);
        zeroize_value(&mut source);
        zeroize_value(&mut target);
        let raw = serde_json::to_string(&patch);
        zeroize_value(&mut patch);
        let raw = match raw {
            Ok(raw) => raw,
            Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
        };
        let document = match wire::team::ConfigDocument::new(raw) {
            Ok(document) => document,
            Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
        };
        let request = match wire::team::config_patch_request(
            next_id("skill-config-patch"),
            document,
            base_hash,
            replace_paths,
        ) {
            Ok(request) => request,
            Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
        };
        let request_id = request.request_id().to_owned();
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(_) => return ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
        };
        match self.gateway.rpc_encoded_mutation(request_id, encoded).await {
            MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
                if wire::channel::is_config_conflict(&error) {
                    ConfigRemoveAttempt::Conflict
                } else {
                    ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Rejected)
                }
            }
            MutationDelivery::Response(response) => {
                match wire::channel::decode_config_patch(response) {
                    Ok(_) => ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Removed),
                    Err(_) => ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown),
                }
            }
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                ConfigRemoveAttempt::Outcome(SkillConfigRemoveOutcome::Unknown)
            }
        }
    }
    pub async fn upload_begin(&self, request: SkillUploadBegin) -> SkillUploadOutcome {
        self.upload_progress(UPLOAD_BEGIN, request.params()).await
    }
    pub async fn upload_chunk(&self, request: SkillUploadChunk) -> SkillUploadOutcome {
        self.upload_progress(UPLOAD_CHUNK, request.params()).await
    }
    pub async fn upload_commit(&self, request: SkillUploadCommit) -> SkillUploadOutcome {
        self.upload_receipt(UPLOAD_COMMIT, request.params()).await
    }

    fn agent_params(&self, mut params: Value) -> Value {
        self.context.apply_agent(&mut params);
        params
    }
    async fn read<T>(
        &self,
        method: &'static str,
        params: Value,
        decode: fn(Value) -> Result<T, ()>,
    ) -> Result<T, SkillReadError> {
        let request = wire::operations_request(next_id(method), method, params)
            .map_err(|_| SkillReadError::Protocol)?;
        match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Success {
                payload: Some(payload),
                ..
            }) => decode(payload).map_err(|_| SkillReadError::Protocol),
            Ok(GatewayResponse::Failure { .. }) => Err(SkillReadError::Rejected),
            _ => Err(SkillReadError::Unavailable),
        }
    }
    async fn mutate(&self, method: &'static str, params: Value) -> SkillMutationOutcome {
        let Ok(request) = wire::operations_request(next_id(method), method, params) else {
            return SkillMutationOutcome::Rejected;
        };
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Success {
                payload: Some(Value::Object(payload)),
                ..
            }) if payload.get("ok") == Some(&Value::Bool(true)) => SkillMutationOutcome::Accepted,
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                SkillMutationOutcome::Rejected
            }
            MutationDelivery::Response(_) => SkillMutationOutcome::Unknown,
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                SkillMutationOutcome::Unknown
            }
        }
    }

    async fn upload_progress(&self, method: &'static str, params: Value) -> SkillUploadOutcome {
        match self.upload_exchange(method, params).await {
            MutationDelivery::Response(GatewayResponse::Success {
                payload: Some(payload),
                ..
            }) => decode_upload_progress(payload).map_or(
                SkillUploadOutcome::Unknown,
                |(upload_id, received_bytes, expires_at)| SkillUploadOutcome::Progress {
                    upload_id,
                    received_bytes,
                    expires_at,
                },
            ),
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                SkillUploadOutcome::Rejected
            }
            MutationDelivery::Response(_)
            | MutationDelivery::NotWritten(_)
            | MutationDelivery::MayHaveReached(_) => SkillUploadOutcome::Unknown,
        }
    }

    async fn upload_receipt(&self, method: &'static str, params: Value) -> SkillUploadOutcome {
        match self.upload_exchange(method, params).await {
            MutationDelivery::Response(GatewayResponse::Success {
                payload: Some(payload),
                ..
            }) => decode_upload_commit(payload).map_or(
                SkillUploadOutcome::Unknown,
                |(upload_id, received_bytes, sha256, expires_at)| SkillUploadOutcome::Commit {
                    upload_id,
                    received_bytes,
                    sha256,
                    expires_at,
                },
            ),
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                SkillUploadOutcome::Rejected
            }
            MutationDelivery::Response(_)
            | MutationDelivery::NotWritten(_)
            | MutationDelivery::MayHaveReached(_) => SkillUploadOutcome::Unknown,
        }
    }

    async fn upload_exchange(&self, method: &'static str, params: Value) -> MutationDelivery {
        let Ok(request) = wire::operations_request(next_id(method), method, params) else {
            return MutationDelivery::NotWritten(
                crate::gateway::delivery::DispatcherError::Protocol,
            );
        };
        self.gateway.rpc_mutation(request).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConfigRemoveAttempt {
    Conflict,
    Outcome(SkillConfigRemoveOutcome),
}

fn remove_skill_config_entry(document: &mut Value, skill_key: &str) -> Option<Value> {
    document
        .get_mut("skills")
        .and_then(Value::as_object_mut)
        .and_then(|skills| skills.get_mut("entries"))
        .and_then(Value::as_object_mut)
        .and_then(|entries| entries.remove(skill_key))
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(object) => object.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

impl fmt::Debug for OpenClawSkillOperations {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenClawSkillOperations")
            .finish_non_exhaustive()
    }
}

fn decode_upload_progress(payload: Value) -> Result<(String, u64, u64), ()> {
    let object = payload.as_object().ok_or(())?;
    Ok((
        required_upload_id(object.get("uploadId"))?,
        required_u64(object.get("receivedBytes"))?,
        required_u64(object.get("expiresAt"))?,
    ))
}

fn decode_upload_commit(payload: Value) -> Result<(String, u64, String, u64), ()> {
    let object = payload.as_object().ok_or(())?;
    Ok((
        required_upload_id(object.get("uploadId"))?,
        required_u64(object.get("receivedBytes"))?,
        required_sha256(object.get("sha256"))?,
        required_u64(object.get("expiresAt"))?,
    ))
}

fn required_upload_id(value: Option<&Value>) -> Result<String, ()> {
    let value = value.and_then(Value::as_str).ok_or(())?.trim();
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric()))
    .then_some(value.to_owned())
    .ok_or(())
}

fn required_sha256(value: Option<&Value>) -> Result<String, ()> {
    let value = value.and_then(Value::as_str).ok_or(())?;
    (value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(value.to_ascii_lowercase())
        .ok_or(())
}

pub(crate) fn decode_detail(payload: Value) -> Result<SkillDetail, ()> {
    let object = payload.as_object().ok_or(())?;
    let skill = match object.get("skill") {
        Some(Value::Object(skill)) => Some(decode_detail_skill(skill)?),
        Some(Value::Null) | None => None,
        _ => return Err(()),
    };
    let latest_version = match object.get("latestVersion") {
        Some(Value::Object(version)) => Some(SkillDetailLatestVersion {
            version: required_text(version.get("version"))?,
            created_at: required_u64(version.get("createdAt"))?,
            changelog: optional_text(version.get("changelog"))?,
        }),
        Some(Value::Null) | None => None,
        _ => return Err(()),
    };
    let metadata = match object.get("metadata") {
        Some(Value::Object(metadata)) => Some(SkillDetailMetadata {
            os: optional_identifier_array(metadata.get("os"))?,
            systems: optional_identifier_array(metadata.get("systems"))?,
        }),
        Some(Value::Null) | None => None,
        _ => return Err(()),
    };
    let owner = match object.get("owner") {
        Some(Value::Object(owner)) => Some(SkillDetailOwner {
            handle: optional_nullable_text(owner.get("handle"))?,
            display_name: optional_nullable_text(owner.get("displayName"))?,
            image: optional_nullable_text(owner.get("image"))?,
        }),
        Some(Value::Null) | None => None,
        _ => return Err(()),
    };
    Ok(SkillDetail {
        skill,
        latest_version,
        metadata,
        owner,
    })
}

fn decode_detail_skill(object: &serde_json::Map<String, Value>) -> Result<SkillDetailSkill, ()> {
    let tags = match object.get("tags") {
        None | Some(Value::Null) => std::collections::BTreeMap::new(),
        Some(Value::Object(tags)) => tags
            .iter()
            .map(|(key, value)| Ok((key.clone(), required_text(Some(value))?)))
            .collect::<Result<_, ()>>()?,
        _ => return Err(()),
    };
    Ok(SkillDetailSkill {
        slug: required_name(object.get("slug"))?,
        display_name: required_text(object.get("displayName"))?,
        summary: optional_text(object.get("summary"))?,
        tags,
        created_at: required_u64(object.get("createdAt"))?,
        updated_at: required_u64(object.get("updatedAt"))?,
    })
}
fn required_text(value: Option<&Value>) -> Result<String, ()> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(())
}
fn optional_text(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim().to_owned())),
        _ => Err(()),
    }
}
fn optional_nullable_text(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim().to_owned())),
        _ => Err(()),
    }
}
fn optional_identifier_array(value: Option<&Value>) -> Result<Option<Vec<String>>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| required_identifier(value))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        _ => Err(()),
    }
}
fn required_identifier(value: &Value) -> Result<String, ()> {
    let value = value.as_str().ok_or(())?.trim();
    (!value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
    .then_some(value.to_owned())
    .ok_or(())
}
fn required_u64(value: Option<&Value>) -> Result<u64, ()> {
    value.and_then(Value::as_u64).ok_or(())
}
fn required_name(value: Option<&Value>) -> Result<String, ()> {
    canonical_name(value.and_then(Value::as_str).ok_or(())?).ok_or(())
}
fn clean_identity(value: String) -> Result<String, SkillRequestError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        Err(SkillRequestError::InvalidContext)
    } else {
        Ok(value)
    }
}
fn clean_openclaw_skill_key(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty() && value.len() <= 4096 && !value.contains('\0')).then_some(value)
}
fn canonical_name(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    valid_name(&value).then_some(value)
}
fn canonical_slug(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    valid_slug(&value).then_some(value)
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("..")
}
fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|b| b.is_ascii_alphanumeric())
}
fn clean_optional(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}
fn next_id(method: &str) -> String {
    let n = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("skill-{}-{}", method.replace('.', "-"), n)
}
