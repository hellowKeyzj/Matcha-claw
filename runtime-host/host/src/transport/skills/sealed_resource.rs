use std::{collections::HashMap, path::PathBuf, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    facade::{AgentsHandle, SkillsHandle},
    sealed_resource::{
        AgentKey, PackageRelativePath, SealedResourceError, SealedSkillCatalogEntry, SkillKey,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) const STATUS_ENDPOINT: &str = "/api/sealed-skills/status";
pub(crate) const EXPORT_ENDPOINT: &str = "/api/sealed-skills/export";
pub(crate) const INSTALL_ENDPOINT: &str = "/api/sealed-skills/install";
pub(crate) const UNINSTALL_ENDPOINT: &str = "/api/sealed-skills/uninstall";
pub(crate) const READ_ENDPOINT_PREFIX: &str = "/api/sealed-skills/read/";
pub(crate) const AGENT_READ_ENDPOINT_PREFIX: &str = "/api/sealed-agents/read/";

const AUTHORIZATION_HEADER: &str = "authorization";
const SEALED_RUNTIME_AUTHORIZATION_HEADER: &str = "x-matcha-sealed-token";
const SEALED_RUNTIME_HEADER: &str = "x-matcha-sealed-runtime";
const BEARER_PREFIX: &str = "Bearer ";
const OPENCLAW_RUNTIME: &str = "openclaw";
const MAX_OPENCLAW_SKILL_KEY_BYTES: usize = 4 * 1024;
const MAX_PACKAGE_PATH_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Route {
    Status,
    Export,
    Install,
    Uninstall,
    SkillRead,
    AgentRead,
}

impl Route {
    fn from_request(method: &str, endpoint: &str) -> Result<Self, RequestError> {
        match (method, endpoint) {
            ("GET", STATUS_ENDPOINT) => Ok(Self::Status),
            ("POST", EXPORT_ENDPOINT) => Ok(Self::Export),
            ("POST", INSTALL_ENDPOINT) => Ok(Self::Install),
            ("POST", UNINSTALL_ENDPOINT) => Ok(Self::Uninstall),
            ("GET", value) if value.starts_with(READ_ENDPOINT_PREFIX) => Ok(Self::SkillRead),
            ("GET", value) if value.starts_with(AGENT_READ_ENDPOINT_PREFIX) => Ok(Self::AgentRead),
            _ => Err(RequestError::Invalid),
        }
    }

    const fn authorization(
        self,
    ) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
        match self {
            Self::Status => Some((
                STATUS_ENDPOINT,
                "sealed-skills:read",
                "sealedSkills.status",
                "sealed-skills-status",
            )),
            Self::Export => Some((
                EXPORT_ENDPOINT,
                "sealed-skills:package",
                "sealedSkills.export",
                "sealed-skills-export",
            )),
            Self::Install => Some((
                INSTALL_ENDPOINT,
                "sealed-skills:package",
                "sealedSkills.install",
                "sealed-skills-install",
            )),
            Self::Uninstall => Some((
                UNINSTALL_ENDPOINT,
                "sealed-skills:package",
                "sealedSkills.uninstall",
                "sealed-skills-uninstall",
            )),
            Self::SkillRead | Self::AgentRead => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillKeyRequest {
    skill_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRequest {
    package_path: String,
}

pub(crate) async fn handle(
    endpoint: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
    agents: AgentsHandle,
    now: u64,
) -> Result<(u16, Value), RequestError> {
    let route = Route::from_request(method, endpoint)?;
    if let Some((auth_endpoint, scope, capability, subject)) = route.authorization() {
        authorize(
            headers,
            verifier,
            now,
            auth_endpoint,
            scope,
            capability,
            subject,
        )
        .await?;
    }
    match route {
        Route::Status => status(body, skills).await,
        Route::Export => export(body, skills),
        Route::Install => install(body, skills),
        Route::Uninstall => uninstall(body, skills),
        Route::SkillRead => read_skill(endpoint, headers, body, skills),
        Route::AgentRead => read_agent(endpoint, headers, body, agents),
    }
}

async fn status(body: &[u8], handle: SkillsHandle) -> Result<(u16, Value), RequestError> {
    if !body.is_empty() {
        return Err(RequestError::Invalid);
    }
    let catalog = handle.sealed_catalog().map_err(map_error)?;
    let enabled = enabled_skills(&handle).await;
    Ok((
        200,
        json!({
            "skills": catalog.entries().iter().map(|entry| project_entry(entry, &enabled)).collect::<Vec<_>>(),
            "ready": true,
        }),
    ))
}

fn export(body: &[u8], handle: SkillsHandle) -> Result<(u16, Value), RequestError> {
    let request = decode_skill_key(body)?;
    let skill_key = SkillKey::parse(request.skill_key).map_err(|_| RequestError::Invalid)?;
    match handle.export_sealed_skill_package(skill_key) {
        Ok(entry) => Ok((
            200,
            json!({ "outcome": "accepted", "skillKey": entry.skill_key().as_str() }),
        )),
        Err(SealedResourceError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(error) => Err(map_error(error)),
    }
}

fn install(body: &[u8], handle: SkillsHandle) -> Result<(u16, Value), RequestError> {
    let request =
        serde_json::from_slice::<InstallRequest>(body).map_err(|_| RequestError::Invalid)?;
    if !valid_package_path(&request.package_path) {
        return Err(RequestError::Invalid);
    }
    match handle.install_sealed_skill(PathBuf::from(request.package_path)) {
        Ok(entry) => Ok((
            200,
            json!({ "outcome": "accepted", "skillKey": entry.skill_key().as_str() }),
        )),
        Err(SealedResourceError::AlreadyExists) => Ok((409, json!({ "outcome": "rejected" }))),
        Err(SealedResourceError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(error) => Err(map_error(error)),
    }
}

fn uninstall(body: &[u8], handle: SkillsHandle) -> Result<(u16, Value), RequestError> {
    let request = decode_skill_key(body)?;
    let skill_key = request.skill_key;
    let parsed = SkillKey::parse(skill_key.clone()).map_err(|_| RequestError::Invalid)?;
    match handle.remove_sealed_skill(parsed) {
        Ok(true) => Ok((200, json!({ "outcome": "removed", "skillKey": skill_key }))),
        Ok(false) => Ok((404, json!({ "outcome": "notFound", "skillKey": skill_key }))),
        Err(error) => Err(map_error(error)),
    }
}

fn read_skill(
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
    handle: SkillsHandle,
) -> Result<(u16, Value), RequestError> {
    if !body.is_empty() {
        return Err(RequestError::Invalid);
    }
    let runtime = header_value(headers, SEALED_RUNTIME_HEADER).ok_or(RequestError::Unauthorized)?;
    if runtime != OPENCLAW_RUNTIME {
        return Err(RequestError::Unauthorized);
    }
    let token = header_value(headers, SEALED_RUNTIME_AUTHORIZATION_HEADER)
        .ok_or(RequestError::Unauthorized)?;
    let (skill_key, path) = decode_skill_read_path(endpoint)?;
    match handle.read_sealed_skill_file(token, skill_key, path) {
        Ok(read) => Ok((200, project_read(read))),
        Err(SealedResourceError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(error) => Err(map_error(error)),
    }
}

fn read_agent(
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
    handle: AgentsHandle,
) -> Result<(u16, Value), RequestError> {
    if !body.is_empty() {
        return Err(RequestError::Invalid);
    }
    let runtime = header_value(headers, SEALED_RUNTIME_HEADER).ok_or(RequestError::Unauthorized)?;
    if runtime != OPENCLAW_RUNTIME {
        return Err(RequestError::Unauthorized);
    }
    let token = header_value(headers, SEALED_RUNTIME_AUTHORIZATION_HEADER)
        .ok_or(RequestError::Unauthorized)?;
    let (agent_key, path) = decode_agent_read_path(endpoint)?;
    match handle.read_sealed_agent_file(token, agent_key, path) {
        Ok(read) => Ok((200, project_read(read))),
        Err(SealedResourceError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(error) => Err(map_error(error)),
    }
}

async fn authorize(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    now: u64,
    endpoint: &str,
    scope: &str,
    capability: &str,
    subject: &str,
) -> Result<(), RequestError> {
    let authorization = header_value(headers, AUTHORIZATION_HEADER)
        .and_then(|value| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    verifier
        .lock()
        .await
        .verify(authorization, now, endpoint, scope, capability, subject)
        .map(|_| ())
        .map_err(|_| RequestError::Unauthorized)
}

fn decode_skill_key(body: &[u8]) -> Result<SkillKeyRequest, RequestError> {
    let request =
        serde_json::from_slice::<SkillKeyRequest>(body).map_err(|_| RequestError::Invalid)?;
    if !valid_openclaw_skill_key(&request.skill_key) {
        return Err(RequestError::Invalid);
    }
    Ok(SkillKeyRequest {
        skill_key: request.skill_key.trim().to_owned(),
    })
}

fn decode_skill_read_path(endpoint: &str) -> Result<(SkillKey, PackageRelativePath), RequestError> {
    let value = endpoint
        .strip_prefix(READ_ENDPOINT_PREFIX)
        .ok_or(RequestError::Invalid)?;
    let (skill_key, path) = value.split_once('/').ok_or(RequestError::Invalid)?;
    let skill_key =
        SkillKey::parse(percent_decode(skill_key)?).map_err(|_| RequestError::Invalid)?;
    let path =
        PackageRelativePath::parse(percent_decode(path)?).map_err(|_| RequestError::Invalid)?;
    Ok((skill_key, path))
}

fn decode_agent_read_path(endpoint: &str) -> Result<(AgentKey, PackageRelativePath), RequestError> {
    let value = endpoint
        .strip_prefix(AGENT_READ_ENDPOINT_PREFIX)
        .ok_or(RequestError::Invalid)?;
    let (agent_key, path) = value.split_once('/').ok_or(RequestError::Invalid)?;
    let agent_key =
        AgentKey::parse(percent_decode(agent_key)?).map_err(|_| RequestError::Invalid)?;
    let path =
        PackageRelativePath::parse(percent_decode(path)?).map_err(|_| RequestError::Invalid)?;
    Ok((agent_key, path))
}

fn project_entry(entry: &SealedSkillCatalogEntry, enabled: &HashMap<String, bool>) -> Value {
    json!({
        "skillKey": entry.skill_key().as_str(),
        "name": entry.descriptor().name(),
        "description": entry.descriptor().description(),
        "installed": true,
        "enabled": enabled.get(entry.skill_key().as_str()).copied().unwrap_or(true),
        "runtimes": [entry.runtime_target().as_str()],
        "source": "sealed",
    })
}

fn project_read(read: crate::sealed_resource::SealedResourceRead) -> Value {
    let mut value = json!({
        "contentBase64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, read.content()),
    });
    if let Some(binding) = read.metering_binding() {
        value["meteringBinding"] = json!(binding.as_str());
    }
    value
}

async fn enabled_skills(handle: &SkillsHandle) -> HashMap<String, bool> {
    match handle.skill_status().await {
        Ok(crate::skills::status::Outcome::Available(catalog)) => catalog
            .entries
            .into_iter()
            .map(|entry| (entry.key, entry.enabled))
            .collect(),
        Ok(crate::skills::status::Outcome::Unavailable) | Err(()) => HashMap::new(),
    }
}

fn map_error(error: SealedResourceError) -> RequestError {
    match error {
        SealedResourceError::Unknown => RequestError::Unavailable,
        SealedResourceError::AlreadyExists
        | SealedResourceError::NotFound
        | SealedResourceError::Rejected => RequestError::Invalid,
    }
}

fn valid_openclaw_skill_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.len() <= MAX_OPENCLAW_SKILL_KEY_BYTES && !value.contains('\0')
}

fn valid_package_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PACKAGE_PATH_BYTES
        && !value.contains('\0')
        && value.ends_with(".matcha-skillpkg")
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header, _)| header == name)
        .map(|(_, value)| value.as_str())
}

fn percent_decode(value: &str) -> Result<String, RequestError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(RequestError::Invalid);
            }
            let high = hex(bytes[index + 1]).ok_or(RequestError::Invalid)?;
            let low = hex(bytes[index + 2]).ok_or(RequestError::Invalid)?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| RequestError::Invalid)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
