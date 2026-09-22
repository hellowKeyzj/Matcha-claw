use std::{
    collections::BTreeMap,
    fmt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use runtime_directory::LifecycleOps as _;
use serde_json::Value;
use skills_module::{SkillRuntimeOps as _, projection::clawhub as clawhub_projection};

use crate::{
    driver::OpenClawDriver,
    gateway::{
        client::GatewayClient,
        wire::{self, GatewayResponse},
    },
};

pub mod bundle;
mod operations;
mod provider;
pub mod readme;

pub use operations::{
    OpenClawSkillOperations, PrivateSkillValue, SkillConfigRemoveOutcome, SkillDetail,
    SkillDetailLatestVersion, SkillDetailMetadata, SkillDetailOwner, SkillDetailRequest,
    SkillDetailSkill, SkillInstallRequest, SkillInstallSource, SkillMutationOutcome,
    SkillReadError, SkillRequestContext, SkillRequestError, SkillUpdateRequest, SkillUploadBegin,
    SkillUploadChunk, SkillUploadCommit,
};
pub use provider::OpenClawSkillProvider;

pub trait OpenClawSkillsAdmissionPort: Send + Sync {
    fn admit_openclaw_skills_request(&self) -> bool;
}

#[derive(Clone)]
pub struct OpenClawSkillsPort {
    admission: Arc<dyn OpenClawSkillsAdmissionPort>,
    driver: Arc<OpenClawDriver>,
    clawhub_registry: clawhub::ClawHubRegistryClient,
}

impl OpenClawSkillsPort {
    pub fn new(
        admission: Arc<dyn OpenClawSkillsAdmissionPort>,
        driver: Arc<OpenClawDriver>,
        clawhub_registry: clawhub::ClawHubRegistryClient,
    ) -> Self {
        Self {
            admission,
            driver,
            clawhub_registry,
        }
    }

    fn open_claw_is_running(&self) -> bool {
        self.driver.as_ref().readiness()
    }
}

impl skills_module::ports::SkillsPort for OpenClawSkillsPort {
    fn install_clawhub_skill<'a>(
        &'a self,
        command: skills_module::install::Command,
    ) -> skills_module::ports::SkillsFuture<'a, Result<skills_module::install::Outcome, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_skills_request() || !self.open_claw_is_running() {
                return Ok(skills_module::install::Outcome::Unknown);
            }
            Ok(self.driver.install_clawhub_skill(command).await)
        })
    }

    fn skill_status<'a>(
        &'a self,
    ) -> skills_module::ports::SkillsFuture<'a, Result<skills_module::status::Outcome, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_skills_request() || !self.open_claw_is_running() {
                return Ok(skills_module::status::Outcome::Unavailable);
            }
            Ok(self.driver.skill_status().await)
        })
    }

    fn manage_skills<'a>(
        &'a self,
        command: skills_module::management::Command,
    ) -> skills_module::ports::SkillsFuture<'a, Result<skills_module::management::Outcome, ()>>
    {
        Box::pin(async move {
            if !self.admission.admit_openclaw_skills_request() || !self.open_claw_is_running() {
                return Ok(skills_module::management::Outcome::Unavailable);
            }
            Ok(self.driver.manage_skills(command).await)
        })
    }

    fn skill_bundles<'a>(
        &'a self,
        command: skills_module::bundle::Command,
    ) -> skills_module::ports::SkillsFuture<'a, Result<skills_module::bundle::Outcome, ()>> {
        Box::pin(async move {
            if !self.admission.admit_openclaw_skills_request() {
                return Ok(skills_module::bundle::Outcome::Unknown);
            }
            Ok(self.driver.skill_bundles(command).await)
        })
    }
}

impl skills_module::ports::ClawHubSearchPort for OpenClawSkillsPort {
    fn search<'a>(
        &'a self,
        query: Option<String>,
        limit: u16,
    ) -> skills_module::ports::SkillsFuture<'a, Result<Vec<skills_module::ClawHubSearchResult>, ()>>
    {
        Box::pin(async move {
            self.clawhub_registry
                .search(query.as_deref(), limit)
                .await
                .map(|results| {
                    results
                        .into_iter()
                        .map(|result| {
                            clawhub_projection::project_search_result(
                                result.slug(),
                                result.name(),
                                result.description(),
                                result.version(),
                                result.author(),
                                result.downloads(),
                                result.stars(),
                            )
                        })
                        .collect()
                })
        })
    }
}

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

#[derive(Clone, Eq, PartialEq)]
pub struct SkillStatusRequest {
    agent_id: Option<String>,
}

impl SkillStatusRequest {
    pub fn ambient() -> Self {
        Self { agent_id: None }
    }

    pub fn for_agent(agent_id: String) -> Result<Self, SkillStatusRequestError> {
        let agent_id =
            clean_status_identity(agent_id).ok_or(SkillStatusRequestError::InvalidAgentId)?;
        Ok(Self {
            agent_id: Some(agent_id),
        })
    }

    fn params(&self) -> Value {
        let mut params = serde_json::Map::new();
        if let Some(agent_id) = &self.agent_id {
            params.insert("agentId".to_owned(), Value::String(agent_id.clone()));
        }
        Value::Object(params)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillStatusRequestError {
    InvalidAgentId,
}

impl fmt::Debug for SkillStatusRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SkillStatusRequest")
            .field("agent_id", &self.agent_id.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

pub struct OpenClawInstalledSkillCatalog {
    gateway: Arc<GatewayClient>,
    request: SkillStatusRequest,
}

impl OpenClawInstalledSkillCatalog {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self {
            gateway,
            request: SkillStatusRequest::ambient(),
        }
    }

    pub fn for_agent(
        gateway: Arc<GatewayClient>,
        agent_id: String,
    ) -> Result<Self, SkillStatusRequestError> {
        Ok(Self {
            gateway,
            request: SkillStatusRequest::for_agent(agent_id)?,
        })
    }

    pub async fn read(&self) -> Option<InstalledSkillCatalog> {
        let request = wire::operations_request(
            next_request_id("skill-status"),
            SKILLS_STATUS_METHOD,
            self.request.params(),
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
/// skill, never a raw source, configuration, version, author, or diagnostic.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct SkillStatusCatalog {
    entries: Vec<SkillStatusEntry>,
    locators: BTreeMap<String, SkillStatusLocator>,
}

impl SkillStatusCatalog {
    pub fn entries(&self) -> &[SkillStatusEntry] {
        &self.entries
    }

    pub fn locator(&self, skill_key: &str) -> Option<&SkillStatusLocator> {
        self.locators.get(skill_key)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SkillStatusLocator {
    base_dir: Option<String>,
    file_path: Option<String>,
}

impl SkillStatusLocator {
    pub fn base_dir(&self) -> Option<&str> {
        self.base_dir.as_deref()
    }

    pub fn file_path(&self) -> Option<&str> {
        self.file_path.as_deref()
    }
}

impl fmt::Debug for SkillStatusCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SkillStatusCatalog")
            .field("entries", &self.entries)
            .field("locator_count", &self.locators.len())
            .finish()
    }
}

impl fmt::Debug for SkillStatusLocator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SkillStatusLocator([REDACTED])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillStatusEntry {
    key: String,
    slug: Option<String>,
    display_name: String,
    description: String,
    enabled: bool,
    selectable: bool,
    eligible: bool,
    blocked_by_allowlist: bool,
    bundled: Option<bool>,
    always: Option<bool>,
    emoji: Option<String>,
    source: Option<SkillStatusSource>,
    unavailable_reason: Option<SkillStatusUnavailableReason>,
    missing_requirement_categories: Vec<MissingSkillRequirementCategory>,
}

impl SkillStatusEntry {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn slug(&self) -> Option<&str> {
        self.slug.as_deref()
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

    pub fn eligible(&self) -> bool {
        self.eligible
    }

    pub fn blocked_by_allowlist(&self) -> bool {
        self.blocked_by_allowlist
    }

    pub fn bundled(&self) -> Option<bool> {
        self.bundled
    }

    pub fn always(&self) -> Option<bool> {
        self.always
    }

    pub fn emoji(&self) -> Option<&str> {
        self.emoji.as_deref()
    }

    pub fn source(&self) -> Option<SkillStatusSource> {
        self.source
    }

    pub fn unavailable_reason(&self) -> Option<SkillStatusUnavailableReason> {
        self.unavailable_reason
    }

    pub fn missing_requirement_categories(&self) -> &[MissingSkillRequirementCategory] {
        &self.missing_requirement_categories
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillStatusSource {
    Bundled,
    OpenClawBundled,
    Managed,
    OpenClawManaged,
    OpenClawWorkspace,
    OpenClawExtra,
    AgentsSkillsPersonal,
    AgentsSkillsProject,
}

impl SkillStatusSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::OpenClawBundled => "openclaw-bundled",
            Self::Managed => "managed",
            Self::OpenClawManaged => "openclaw-managed",
            Self::OpenClawWorkspace => "openclaw-workspace",
            Self::OpenClawExtra => "openclaw-extra",
            Self::AgentsSkillsPersonal => "agents-skills-personal",
            Self::AgentsSkillsProject => "agents-skills-project",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillStatusUnavailableReason {
    Disabled,
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
            SkillStatusRequest::ambient().params(),
        )
        .map_err(|_| SkillStatusCatalogError::Protocol)?;
        let _ = SKILL_STATUS_METHODS;
        eprintln!("[startup-trace] source=skills-status phase=rpc detail=request");
        match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => {
                eprintln!("[startup-trace] source=skills-status phase=rpc detail=gateway-rejected");
                Err(SkillStatusCatalogError::Rejected)
            }
            Ok(response) => decode_skill_status_catalog(response).map_err(|_| {
                eprintln!("[startup-trace] source=skills-status phase=decode detail=wire-rejected");
                SkillStatusCatalogError::Protocol
            }),
            Err(_) => {
                eprintln!(
                    "[startup-trace] source=skills-status phase=rpc detail=gateway-unavailable"
                );
                Err(SkillStatusCatalogError::Unavailable)
            }
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
        trace_status_decode("wire-shape", 0, 0, 0);
        return Err(());
    };
    let skills = payload
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            trace_status_decode("skills-shape", 0, 0, 0);
        })?;
    let total = skills.len();
    let mut items = Vec::with_capacity(total);
    let mut rejected = 0usize;
    let mut last_reject_reason = None;
    for skill in skills {
        match decode_skill_status_item(skill) {
            Ok(item) => items.push(item),
            Err(reason) => {
                rejected += 1;
                last_reject_reason = Some(reason);
            }
        }
    }
    items.sort_by(|left, right| left.entry.key.cmp(&right.entry.key));
    let before_dedup = items.len();
    items.dedup_by(|left, right| left.entry.key == right.entry.key);
    rejected += before_dedup - items.len();
    if before_dedup != items.len() {
        last_reject_reason = Some(StatusEntryRejectReason::DuplicateKey);
    }
    let mut entries = Vec::with_capacity(items.len());
    let mut locators = BTreeMap::new();
    for item in items {
        locators.insert(item.entry.key.clone(), item.locator);
        entries.push(item.entry);
    }
    trace_status_decode(
        last_reject_reason.map_or("ok", StatusEntryRejectReason::as_str),
        total,
        entries.len(),
        rejected,
    );
    Ok(SkillStatusCatalog { entries, locators })
}

struct SkillStatusItem {
    entry: SkillStatusEntry,
    locator: SkillStatusLocator,
}

fn decode_skill_status_item(value: &Value) -> Result<SkillStatusItem, StatusEntryRejectReason> {
    let skill = value
        .as_object()
        .ok_or(StatusEntryRejectReason::EntryShape)?;
    let key_value = skill
        .get("skillKey")
        .ok_or(StatusEntryRejectReason::MissingKey)?;
    let key = key_value
        .as_str()
        .ok_or(StatusEntryRejectReason::KeyType)
        .and_then(clean_status_key)?;
    let slug = skill
        .get("clawhub")
        .and_then(|value| value.get("slug"))
        .and_then(Value::as_str)
        .and_then(canonical_status_slug)
        .or_else(|| canonical_status_slug(&key));
    let display_name = optional_status_text(skill.get("name"), 256)?.unwrap_or_else(|| key.clone());
    let description = optional_status_text(skill.get("description"), 8_192)?.unwrap_or_default();
    let eligible = optional_status_bool(skill, "eligible")?.unwrap_or(false);
    let disabled = optional_status_bool(skill, "disabled")?.unwrap_or(false);
    let blocked_by_allowlist = optional_status_bool(skill, "blockedByAllowlist")?.unwrap_or(false);
    let bundled = optional_status_bool(skill, "bundled")?;
    if blocked_by_allowlist || (bundled == Some(true) && !eligible) {
        return Err(StatusEntryRejectReason::Filtered);
    }
    let always = optional_status_bool(skill, "always")?;
    let emoji = optional_status_text(skill.get("emoji"), 32)?;
    let source = optional_status_source(skill.get("source"))?;
    let locator = SkillStatusLocator {
        base_dir: optional_status_path(skill.get("baseDir"), false),
        file_path: optional_status_path(skill.get("filePath"), true),
    };
    let missing_requirement_categories =
        decode_missing_requirement_categories(skill.get("missing"))?;
    let unavailable_reason = if disabled {
        Some(SkillStatusUnavailableReason::Disabled)
    } else if !missing_requirement_categories.is_empty() {
        Some(SkillStatusUnavailableReason::MissingRequirements)
    } else if !eligible {
        Some(SkillStatusUnavailableReason::Ineligible)
    } else {
        None
    };
    Ok(SkillStatusItem {
        locator,
        entry: SkillStatusEntry {
            key,
            slug,
            display_name,
            description,
            enabled: !disabled,
            selectable: eligible && unavailable_reason.is_none(),
            eligible,
            blocked_by_allowlist,
            bundled,
            always,
            emoji,
            source,
            unavailable_reason,
            missing_requirement_categories,
        },
    })
}

fn clean_status_key(value: &str) -> Result<String, StatusEntryRejectReason> {
    let value = value.trim();
    if value.is_empty() {
        return Err(StatusEntryRejectReason::EmptyKey);
    }
    if value.len() > 4096 {
        return Err(StatusEntryRejectReason::LongKey);
    }
    if value.contains('\0') {
        return Err(StatusEntryRejectReason::NulKey);
    }
    Ok(value.to_owned())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StatusEntryRejectReason {
    EntryShape,
    MissingKey,
    KeyType,
    EmptyKey,
    LongKey,
    NulKey,
    FieldType,
    DuplicateKey,
    Filtered,
}

impl StatusEntryRejectReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::EntryShape => "entry-shape",
            Self::MissingKey => "missing-key",
            Self::KeyType => "key-type",
            Self::EmptyKey => "empty-key",
            Self::LongKey => "long-key",
            Self::NulKey => "nul-key",
            Self::FieldType => "field-type",
            Self::DuplicateKey => "duplicate-key",
            Self::Filtered => "filtered",
        }
    }
}

fn trace_status_decode(reason: &str, total: usize, accepted: usize, rejected: usize) {
    eprintln!(
        "[startup-trace] source=skills-status phase=decode detail={} total={} accepted={} rejected={}",
        reason, total, accepted, rejected
    );
}

fn canonical_status_slug(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let mut slug = String::with_capacity(value.len());
    let mut last_was_dash = false;
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() {
            slug.push(byte as char);
            last_was_dash = false;
        } else if (byte == b'-' || byte == b'_' || byte == b'/' || byte.is_ascii_whitespace())
            && !slug.is_empty()
            && !last_was_dash
        {
            slug.push('-');
            last_was_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    (!slug.is_empty() && slug.len() <= 128).then_some(slug)
}

fn clean_status_identity(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty() && value.len() <= 4096 && !value.contains('\0')).then_some(value)
}

fn optional_status_text(
    value: Option<&Value>,
    limit: usize,
) -> Result<Option<String>, StatusEntryRejectReason> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Ok(None);
            }
            if value.len() > limit || value.contains('\0') {
                return Err(StatusEntryRejectReason::FieldType);
            }
            Ok(Some(value.to_owned()))
        }
        Some(_) => Err(StatusEntryRejectReason::FieldType),
    }
}

fn optional_status_path(value: Option<&Value>, manifest_only: bool) -> Option<String> {
    let value = value.and_then(Value::as_str)?.trim();
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || !Path::new(value).is_absolute()
    {
        return None;
    }
    if manifest_only
        && !Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
    {
        return None;
    }
    Some(value.to_owned())
}

fn optional_status_bool(
    skill: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<bool>, StatusEntryRejectReason> {
    match skill.get(field) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(StatusEntryRejectReason::FieldType),
    }
}

fn optional_status_source(
    value: Option<&Value>,
) -> Result<Option<SkillStatusSource>, StatusEntryRejectReason> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(match value.trim() {
            "bundled" => Some(SkillStatusSource::Bundled),
            "openclaw-bundled" => Some(SkillStatusSource::OpenClawBundled),
            "managed" => Some(SkillStatusSource::Managed),
            "openclaw-managed" => Some(SkillStatusSource::OpenClawManaged),
            "openclaw-workspace" => Some(SkillStatusSource::OpenClawWorkspace),
            "openclaw-extra" => Some(SkillStatusSource::OpenClawExtra),
            "agents-skills-personal" => Some(SkillStatusSource::AgentsSkillsPersonal),
            "agents-skills-project" => Some(SkillStatusSource::AgentsSkillsProject),
            _ => None,
        }),
        Some(_) => Err(StatusEntryRejectReason::FieldType),
    }
}

fn decode_missing_requirement_categories(
    value: Option<&Value>,
) -> Result<Vec<MissingSkillRequirementCategory>, StatusEntryRejectReason> {
    let Some(Value::Object(missing)) = value else {
        return match value {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(_) => Err(StatusEntryRejectReason::FieldType),
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
                    return Err(StatusEntryRejectReason::FieldType);
                }
                if !values.is_empty() {
                    categories.push(category);
                }
            }
            Some(_) => return Err(StatusEntryRejectReason::FieldType),
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
