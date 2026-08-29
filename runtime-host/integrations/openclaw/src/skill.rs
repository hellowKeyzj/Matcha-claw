use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::{Value, json};

use crate::gateway::{
    client::GatewayClient,
    wire::{self, GatewayResponse},
};

pub mod bundle;
mod operations;
pub mod readme;

pub use operations::{
    OpenClawSkillOperations, PrivateSkillValue, SkillDetail, SkillDetailLatestVersion,
    SkillDetailMetadata, SkillDetailOwner, SkillDetailRequest, SkillDetailSkill,
    SkillInstallRequest, SkillInstallSource, SkillMutationOutcome, SkillReadError,
    SkillRequestError, SkillUpdateRequest, SkillUploadBegin, SkillUploadChunk, SkillUploadCommit,
};

const SKILLS_STATUS_METHOD: &str = "skills.status";
const SKILL_STATUS_METHODS: [&str; 1] = [SKILLS_STATUS_METHOD];

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Safe selectable-name projection for TeamSkill dependency planning.
///
/// The native status response is parsed and discarded in this Integration; no
/// status object, source, workspace, configuration, or diagnostic crosses this
/// boundary.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InstalledSkillCatalog {
    names: Vec<String>,
}

impl InstalledSkillCatalog {
    pub fn names(&self) -> &[String] {
        &self.names
    }
}

pub struct OpenClawInstalledSkillCatalog {
    gateway: Arc<GatewayClient>,
}

impl OpenClawInstalledSkillCatalog {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn read(&self) -> Option<InstalledSkillCatalog> {
        let request = wire::operations_request(
            next_request_id("skill-status"),
            SKILLS_STATUS_METHOD,
            json!({}),
        )
        .ok()?;
        let _ = SKILL_STATUS_METHODS;
        decode_installed_catalog(self.gateway.rpc_query(request).await.ok()?).ok()
    }
}

impl fmt::Debug for OpenClawInstalledSkillCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawInstalledSkillCatalog")
            .finish_non_exhaustive()
    }
}

/// Renderer-safe directory projected from the native `skills.status` response.
///
/// This is deliberately distinct from TeamSkill's selectable-name catalog and
/// agent configuration. It retains only the native facts needed to present a
/// skill, never a native source, path, configuration, version, author, or raw
/// diagnostic.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SkillStatusCatalog {
    entries: Vec<SkillStatusEntry>,
}

impl SkillStatusCatalog {
    pub fn entries(&self) -> &[SkillStatusEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillStatusEntry {
    key: String,
    display_name: String,
    description: String,
    enabled: bool,
    selectable: bool,
    installed: bool,
    eligible: bool,
    blocked_by_allowlist: bool,
    blocked_by_agent_filter: bool,
    unavailable_reason: Option<SkillStatusUnavailableReason>,
    missing_requirement_categories: Vec<MissingSkillRequirementCategory>,
}

impl SkillStatusEntry {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn selectable(&self) -> bool {
        self.selectable
    }

    pub fn installed(&self) -> bool {
        self.installed
    }

    pub fn eligible(&self) -> bool {
        self.eligible
    }

    pub fn blocked_by_allowlist(&self) -> bool {
        self.blocked_by_allowlist
    }

    pub fn blocked_by_agent_filter(&self) -> bool {
        self.blocked_by_agent_filter
    }

    pub fn unavailable_reason(&self) -> Option<SkillStatusUnavailableReason> {
        self.unavailable_reason
    }

    pub fn missing_requirement_categories(&self) -> &[MissingSkillRequirementCategory] {
        &self.missing_requirement_categories
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillStatusUnavailableReason {
    Disabled,
    Blocked,
    MissingRequirements,
    Ineligible,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MissingSkillRequirementCategory {
    Binaries,
    AnyBinaries,
    Environment,
    Configuration,
    OperatingSystem,
}

/// A status read did not produce a directory safe to render.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillStatusCatalogError {
    Unavailable,
    Rejected,
    Protocol,
}

/// Native `skills.status` owner for the renderer-safe skill directory.
pub struct OpenClawSkillStatusCatalog {
    gateway: Arc<GatewayClient>,
}

impl OpenClawSkillStatusCatalog {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn read(&self) -> Result<SkillStatusCatalog, SkillStatusCatalogError> {
        let request = wire::operations_request(
            next_request_id("skill-status-catalog"),
            SKILLS_STATUS_METHOD,
            json!({}),
        )
        .map_err(|_| SkillStatusCatalogError::Protocol)?;
        let _ = SKILL_STATUS_METHODS;
        match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(SkillStatusCatalogError::Rejected),
            Ok(response) => {
                decode_skill_status_catalog(response).map_err(|_| SkillStatusCatalogError::Protocol)
            }
            Err(_) => Err(SkillStatusCatalogError::Unavailable),
        }
    }
}

impl fmt::Debug for OpenClawSkillStatusCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawSkillStatusCatalog")
            .finish_non_exhaustive()
    }
}

fn decode_skill_status_catalog(response: GatewayResponse) -> Result<SkillStatusCatalog, ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(());
    };
    let skills = payload.get("skills").and_then(Value::as_array).ok_or(())?;
    let mut entries = skills
        .iter()
        .map(decode_skill_status_entry)
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.key.cmp(&right.key));
    if entries.windows(2).any(|pair| pair[0].key == pair[1].key) {
        return Err(());
    }
    Ok(SkillStatusCatalog { entries })
}

fn decode_skill_status_entry(value: &Value) -> Result<SkillStatusEntry, ()> {
    let skill = value.as_object().ok_or(())?;
    let key = skill
        .get("skillKey")
        .and_then(Value::as_str)
        .and_then(canonical_status_skill_key)
        .ok_or(())?;
    let display_name = required_status_text(skill.get("name"))?.unwrap_or_else(|| key.clone());
    let description = required_status_text(skill.get("description"))?.unwrap_or_default();
    let installed = optional_status_bool(skill, "installed")?.unwrap_or(true);
    let eligible = optional_status_bool(skill, "eligible")?.unwrap_or(false);
    let disabled = optional_status_bool(skill, "disabled")?.unwrap_or(false);
    let blocked_by_allowlist = optional_status_bool(skill, "blockedByAllowlist")?.unwrap_or(false);
    let blocked_by_agent_filter =
        optional_status_bool(skill, "blockedByAgentFilter")?.unwrap_or(false);
    let missing_requirement_categories =
        decode_missing_requirement_categories(skill.get("missing"))?;
    let unavailable_reason = if disabled {
        Some(SkillStatusUnavailableReason::Disabled)
    } else if blocked_by_allowlist || blocked_by_agent_filter {
        Some(SkillStatusUnavailableReason::Blocked)
    } else if !missing_requirement_categories.is_empty() {
        Some(SkillStatusUnavailableReason::MissingRequirements)
    } else if !eligible {
        Some(SkillStatusUnavailableReason::Ineligible)
    } else {
        None
    };
    Ok(SkillStatusEntry {
        key,
        display_name,
        description,
        enabled: !disabled,
        selectable: installed && eligible && unavailable_reason.is_none(),
        installed,
        eligible,
        blocked_by_allowlist,
        blocked_by_agent_filter,
        unavailable_reason,
        missing_requirement_categories,
    })
}

fn canonical_status_skill_key(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let bytes = value.as_bytes();
    if value.is_empty()
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && *byte == b'-'))
        || value.ends_with('-')
    {
        None
    } else {
        Some(value)
    }
}

fn required_status_text(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim().to_owned())),
        Some(_) => Err(()),
    }
}

fn optional_status_bool(
    skill: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<bool>, ()> {
    match skill.get(field) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(()),
    }
}

fn decode_missing_requirement_categories(
    value: Option<&Value>,
) -> Result<Vec<MissingSkillRequirementCategory>, ()> {
    let Some(Value::Object(missing)) = value else {
        return match value {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(_) => Err(()),
        };
    };
    let mut categories = Vec::new();
    for (field, category) in [
        ("bins", MissingSkillRequirementCategory::Binaries),
        ("anyBins", MissingSkillRequirementCategory::AnyBinaries),
        ("env", MissingSkillRequirementCategory::Environment),
        ("config", MissingSkillRequirementCategory::Configuration),
        ("os", MissingSkillRequirementCategory::OperatingSystem),
    ] {
        match missing.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::Array(values)) => {
                if values.iter().any(|value| value.as_str().is_none()) {
                    return Err(());
                }
                if !values.is_empty() {
                    categories.push(category);
                }
            }
            Some(_) => return Err(()),
        }
    }
    categories.sort();
    Ok(categories)
}

fn decode_installed_catalog(response: GatewayResponse) -> Result<InstalledSkillCatalog, ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(());
    };
    let Some(Value::Array(skills)) = payload.get("skills") else {
        return Err(());
    };
    let mut names = skills
        .iter()
        .filter_map(Value::as_object)
        .filter(|skill| {
            skill.get("eligible") == Some(&Value::Bool(true))
                && skill.get("disabled") != Some(&Value::Bool(true))
                && skill.get("blockedByAllowlist") != Some(&Value::Bool(true))
                && skill.get("blockedByAgentFilter") != Some(&Value::Bool(true))
                && !missing_requirements(skill.get("missing"))
        })
        .filter_map(|skill| skill.get("name").and_then(Value::as_str))
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(InstalledSkillCatalog { names })
}

fn missing_requirements(value: Option<&Value>) -> bool {
    let Some(Value::Object(missing)) = value else {
        return false;
    };
    ["bins", "anyBins", "env", "config", "os"].iter().any(
        |field| matches!(missing.get(*field), Some(Value::Array(values)) if !values.is_empty()),
    )
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("skill-{operation}-{sequence}")
}

#[cfg(test)]
mod tests;
