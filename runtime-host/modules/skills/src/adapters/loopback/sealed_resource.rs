use platform::capability::CapabilityDecisionVerifier;

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{SkillsModule, ports::SealedSkillError};

pub(super) const STATUS_ENDPOINT: &str = "/api/sealed-skills/status";
pub(super) const EXPORT_ENDPOINT: &str = "/api/sealed-skills/export";
pub(super) const INSTALL_ENDPOINT: &str = "/api/sealed-skills/install";
pub(super) const UNINSTALL_ENDPOINT: &str = "/api/sealed-skills/uninstall";
pub(super) const READ_ENDPOINT_PREFIX: &str = "/api/sealed-skills/read/";

const AUTHORIZATION_HEADER: &str = "authorization";
const SEALED_RUNTIME_AUTHORIZATION_HEADER: &str = "x-matcha-sealed-token";
const SEALED_RUNTIME_HEADER: &str = "x-matcha-sealed-runtime";
const BEARER_PREFIX: &str = "Bearer ";
const OPENCLAW_RUNTIME: &str = "openclaw";
const MAX_OPENCLAW_SKILL_KEY_BYTES: usize = 4 * 1024;
const MAX_PACKAGE_PATH_BYTES: usize = 4 * 1024;
const MAX_PACKAGE_RELATIVE_PATH_BYTES: usize = 240;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RequestError {
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
}

impl Route {
    fn from_request(method: &str, endpoint: &str) -> Result<Self, RequestError> {
        match (method, endpoint) {
            ("GET", STATUS_ENDPOINT) => Ok(Self::Status),
            ("POST", EXPORT_ENDPOINT) => Ok(Self::Export),
            ("POST", INSTALL_ENDPOINT) => Ok(Self::Install),
            ("POST", UNINSTALL_ENDPOINT) => Ok(Self::Uninstall),
            ("GET", value) if value.starts_with(READ_ENDPOINT_PREFIX) => Ok(Self::SkillRead),
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
            Self::SkillRead => None,
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

pub(super) async fn handle(
    endpoint: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
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
    }
}

async fn status(body: &[u8], handle: SkillsModule) -> Result<(u16, Value), RequestError> {
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

fn export(body: &[u8], handle: SkillsModule) -> Result<(u16, Value), RequestError> {
    let request = decode_skill_key(body)?;
    match handle.export_sealed_skill_package(request.skill_key) {
        Ok(entry) => Ok((
            200,
            json!({ "outcome": "accepted", "skillKey": entry.skill_key() }),
        )),
        Err(SealedSkillError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(error) => Err(map_error(error)),
    }
}

fn install(body: &[u8], handle: SkillsModule) -> Result<(u16, Value), RequestError> {
    let request =
        serde_json::from_slice::<InstallRequest>(body).map_err(|_| RequestError::Invalid)?;
    if !valid_package_path(&request.package_path) {
        return Err(RequestError::Invalid);
    }
    match handle.install_sealed_skill(PathBuf::from(request.package_path)) {
        Ok(entry) => Ok((
            200,
            json!({ "outcome": "accepted", "skillKey": entry.skill_key() }),
        )),
        Err(SealedSkillError::AlreadyExists) => Ok((409, json!({ "outcome": "rejected" }))),
        Err(SealedSkillError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(error) => Err(map_error(error)),
    }
}

fn uninstall(body: &[u8], handle: SkillsModule) -> Result<(u16, Value), RequestError> {
    let request = decode_skill_key(body)?;
    let skill_key = request.skill_key;
    match handle.remove_sealed_skill(skill_key.clone()) {
        Ok(true) => Ok((200, json!({ "outcome": "removed", "skillKey": skill_key }))),
        Ok(false) => Ok((404, json!({ "outcome": "notFound", "skillKey": skill_key }))),
        Err(error) => Err(map_error(error)),
    }
}

fn read_skill(
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
    handle: SkillsModule,
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
        Err(SealedSkillError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
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

fn decode_skill_read_path(endpoint: &str) -> Result<(String, String), RequestError> {
    let value = endpoint
        .strip_prefix(READ_ENDPOINT_PREFIX)
        .ok_or(RequestError::Invalid)?;
    let (skill_key, path) = value.split_once('/').ok_or(RequestError::Invalid)?;
    let skill_key = percent_decode(skill_key)?;
    if !valid_openclaw_skill_key(&skill_key) {
        return Err(RequestError::Invalid);
    }
    let path = percent_decode(path)?;
    validate_package_relative_path(&path)?;
    Ok((skill_key.trim().to_owned(), path))
}

fn project_entry(
    entry: &crate::ports::SealedSkillCatalogEntry,
    enabled: &HashMap<String, bool>,
) -> Value {
    json!({
        "skillKey": entry.skill_key(),
        "name": entry.name(),
        "description": entry.description(),
        "installed": true,
        "enabled": enabled.get(entry.skill_key()).copied().unwrap_or(true),
        "runtimes": [entry.runtime_target()],
        "source": "sealed",
    })
}

fn project_read(read: crate::ports::SealedResourceRead) -> Value {
    let mut value = json!({
        "contentBase64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, read.content()),
    });
    if let Some(binding) = read.metering_binding() {
        value["meteringBinding"] = json!(binding);
    }
    value
}

async fn enabled_skills(handle: &SkillsModule) -> HashMap<String, bool> {
    match handle.skill_status().await {
        Ok(crate::status::Outcome::Available(catalog)) => catalog
            .entries
            .into_iter()
            .map(|entry| (entry.key, entry.enabled))
            .collect(),
        Ok(crate::status::Outcome::Unavailable) | Err(()) => HashMap::new(),
    }
}

fn map_error(error: SealedSkillError) -> RequestError {
    match error {
        SealedSkillError::Unknown => RequestError::Unavailable,
        SealedSkillError::AlreadyExists
        | SealedSkillError::NotFound
        | SealedSkillError::Rejected => RequestError::Invalid,
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

fn validate_package_relative_path(value: &str) -> Result<(), RequestError> {
    if value.is_empty()
        || value.len() > MAX_PACKAGE_RELATIVE_PATH_BYTES
        || value.contains('\\')
        || value.contains('\0')
        || value.starts_with('/')
        || std::path::Path::new(value).is_absolute()
        || value.split('/').any(|component| {
            component.is_empty()
                || component == "."
                || component == ".."
                || is_windows_drive(component)
        })
        || std::path::Path::new(value)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(RequestError::Invalid);
    }
    Ok(())
}

fn is_windows_drive(component: &str) -> bool {
    let bytes = component.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
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
