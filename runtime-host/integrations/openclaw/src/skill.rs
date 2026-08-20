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
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

pub mod bundle;
mod operations;
pub mod readme;

pub use operations::{
    OpenClawSkillOperations, PrivateSkillValue, SkillDetail, SkillDetailLatestVersion,
    SkillDetailMetadata, SkillDetailOwner, SkillDetailRequest, SkillDetailSkill,
    SkillInstallRequest, SkillInstallSource, SkillMutationOutcome, SkillReadError,
    SkillRequestError, SkillSearchRequest, SkillSearchResult, SkillUpdateRequest, SkillUploadBegin,
    SkillUploadChunk, SkillUploadCommit,
};

const SKILLS_INSTALL_METHOD: &str = "skills.install";
const SKILLS_STATUS_METHOD: &str = "skills.status";
const SKILL_METHODS: [&str; 1] = [SKILLS_INSTALL_METHOD];
const SKILL_STATUS_METHODS: [&str; 1] = [SKILLS_STATUS_METHOD];

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// A repository-owned request for a ClawHub skill install.
///
/// The request deliberately has no workspace, target-directory, registry, or
/// raw payload fields. OpenClaw owns its configured workspace and its native
/// contained-install boundary.
#[derive(Clone, Eq, PartialEq)]
pub struct ClawHubSkillInstall {
    slug: String,
    version: Option<String>,
    force: bool,
}

impl ClawHubSkillInstall {
    pub fn try_new(
        slug: String,
        version: Option<String>,
        force: bool,
    ) -> Result<Self, SkillInputError> {
        let slug = slug.trim().to_owned();
        if !is_clawhub_slug(&slug) {
            return Err(SkillInputError::InvalidSlug);
        }
        let version = version.map(|version| version.trim().to_owned());
        if version.as_deref().is_some_and(str::is_empty) {
            return Err(SkillInputError::InvalidVersion);
        }
        Ok(Self {
            slug,
            version,
            force,
        })
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }

    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    fn into_install_params(self) -> Value {
        let mut params = serde_json::Map::new();
        params.insert("source".into(), Value::String("clawhub".into()));
        params.insert("slug".into(), Value::String(self.slug));
        if let Some(version) = self.version {
            params.insert("version".into(), Value::String(version));
        }
        if self.force {
            params.insert("force".into(), Value::Bool(true));
        }
        Value::Object(params)
    }
}

impl fmt::Debug for ClawHubSkillInstall {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClawHubSkillInstall([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillInputError {
    InvalidSlug,
    InvalidVersion,
}

impl fmt::Display for SkillInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSlug => "ClawHub skill slug is invalid",
            Self::InvalidVersion => "ClawHub skill version is invalid",
        })
    }
}

impl std::error::Error for SkillInputError {}

/// Immediate native outcome of a ClawHub install request.
///
/// `Accepted` means only that the pinned Gateway accepted this request with
/// `{ ok: true }`; it does not claim durable installation or runtime health.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClawHubSkillInstallOutcome {
    Accepted,
    Rejected,
    Unknown,
}

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

/// Dedicated owner for the native ClawHub installation edge.
///
/// It performs one `skills.install` RPC through the pinned Gateway. A native
/// `{ ok: true }` acknowledgement produces `Accepted`; it is not a durable
/// install receipt and this owner never retries or reads back status.
pub struct ClawHubSkillInstaller {
    gateway: Arc<GatewayClient>,
}

impl ClawHubSkillInstaller {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn installed_catalog(&self) -> Option<InstalledSkillCatalog> {
        let request = wire::operations_request(
            next_request_id("skill-status"),
            SKILLS_STATUS_METHOD,
            json!({}),
        )
        .ok()?;
        let _ = SKILL_STATUS_METHODS;
        decode_installed_catalog(self.gateway.rpc_query(request).await.ok()?).ok()
    }

    pub async fn install(&self, request: ClawHubSkillInstall) -> ClawHubSkillInstallOutcome {
        let install = match wire::operations_request(
            next_request_id("clawhub-install"),
            SKILLS_INSTALL_METHOD,
            request.into_install_params(),
        ) {
            Ok(request) => request,
            Err(_) => return ClawHubSkillInstallOutcome::Rejected,
        };

        match self.write(install).await {
            MutationExchange::Response(response @ GatewayResponse::Success { .. }) => {
                match decode_install_acknowledgement(response) {
                    Ok(()) => ClawHubSkillInstallOutcome::Accepted,
                    Err(()) => ClawHubSkillInstallOutcome::Unknown,
                }
            }
            MutationExchange::Response(GatewayResponse::Failure { .. }) => {
                ClawHubSkillInstallOutcome::Rejected
            }
            MutationExchange::NotWritten | MutationExchange::MayHaveReached => {
                ClawHubSkillInstallOutcome::Unknown
            }
        }
    }

    async fn write(&self, request: wire::RpcRequest) -> MutationExchange {
        let _ = SKILL_METHODS;
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(response) => MutationExchange::Response(response),
            MutationDelivery::NotWritten(_) => MutationExchange::NotWritten,
            MutationDelivery::MayHaveReached(_) => MutationExchange::MayHaveReached,
        }
    }
}

impl fmt::Debug for ClawHubSkillInstaller {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClawHubSkillInstaller")
            .finish_non_exhaustive()
    }
}

enum MutationExchange {
    Response(GatewayResponse),
    NotWritten,
    MayHaveReached,
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

fn decode_install_acknowledgement(response: GatewayResponse) -> Result<(), ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(());
    };
    matches!(payload.get("ok"), Some(Value::Bool(true)))
        .then_some(())
        .ok_or(())
}

fn is_clawhub_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let Some((&first, rest)) = bytes.split_first() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric()) {
        return false;
    }
    let Some(&last) = rest.last() else {
        return true;
    };
    if !(last.is_ascii_alphanumeric()) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("skill-{operation}-{sequence}")
}

#[cfg(test)]
mod tests;
