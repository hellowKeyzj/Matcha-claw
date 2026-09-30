use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudPackageMetadata {
    package_version_id: String,
    package_type: String,
    package_sha256: Option<String>,
    file_name: Option<String>,
}

impl CloudPackageMetadata {
    pub fn new(
        package_version_id: String,
        package_type: String,
        package_sha256: Option<String>,
        file_name: Option<String>,
    ) -> Self {
        Self {
            package_version_id,
            package_type,
            package_sha256,
            file_name,
        }
    }

    pub fn package_version_id(&self) -> &str {
        &self.package_version_id
    }

    pub fn package_type(&self) -> &str {
        &self.package_type
    }

    pub fn package_sha256(&self) -> Option<&str> {
        self.package_sha256.as_deref()
    }

    pub fn file_name(&self) -> Option<&str> {
        self.file_name.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceInitialization {
    MainAgentTemplate,
    EmptyWorkspace,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    List {
        endpoint: NativeEndpoint,
    },
    Create {
        endpoint: NativeEndpoint,
        input: AgentCreate,
        workspace_initialization: WorkspaceInitialization,
    },
    Update {
        endpoint: NativeEndpoint,
        input: AgentUpdate,
    },
    Delete {
        endpoint: NativeEndpoint,
        input: AgentDelete,
    },
    ListFiles {
        endpoint: NativeEndpoint,
        agent_id: String,
    },
    GetFile {
        endpoint: NativeEndpoint,
        agent_id: String,
        name: AgentFileName,
    },
    SetFile {
        endpoint: NativeEndpoint,
        agent_id: String,
        name: AgentFileName,
        content: String,
    },
    DisplayConfiguration {
        endpoint: NativeEndpoint,
    },
    SetDescription {
        endpoint: NativeEndpoint,
        agent_id: String,
        description: Option<String>,
    },
    SetConfigurationModel {
        endpoint: NativeEndpoint,
        agent_id: String,
        model: Option<ConfigurationModel>,
    },
    SetSkills {
        endpoint: NativeEndpoint,
        agent_id: String,
        skills: Vec<String>,
    },
    SkillConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
        trace_id: Option<String>,
    },
    SetSkillConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
        revision: String,
        selection: SkillSelection,
        trace_id: Option<String>,
    },
    ToolConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
        trace_id: Option<String>,
    },
    SetToolConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
        revision: String,
        selection: ToolSelection,
        trace_id: Option<String>,
    },
    ExportPackage {
        endpoint: NativeEndpoint,
        agent_id: String,
    },
    ExportCloudPackage {
        endpoint: NativeEndpoint,
        agent_id: String,
        cloud_public_key: String,
        cloud_key_id: String,
    },
    InstallPackage {
        endpoint: NativeEndpoint,
        package_path: String,
        cloud_metadata: Option<CloudPackageMetadata>,
    },
}

impl Command {
    pub const fn endpoint(&self) -> NativeEndpoint {
        match self {
            Self::List { endpoint }
            | Self::Create { endpoint, .. }
            | Self::Update { endpoint, .. }
            | Self::Delete { endpoint, .. }
            | Self::ListFiles { endpoint, .. }
            | Self::GetFile { endpoint, .. }
            | Self::SetFile { endpoint, .. }
            | Self::DisplayConfiguration { endpoint, .. }
            | Self::SetDescription { endpoint, .. }
            | Self::SetConfigurationModel { endpoint, .. }
            | Self::SetSkills { endpoint, .. }
            | Self::SkillConfiguration { endpoint, .. }
            | Self::SetSkillConfiguration { endpoint, .. }
            | Self::ToolConfiguration { endpoint, .. }
            | Self::SetToolConfiguration { endpoint, .. }
            | Self::ExportPackage { endpoint, .. }
            | Self::ExportCloudPackage { endpoint, .. }
            | Self::InstallPackage { endpoint, .. } => *endpoint,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCreate {
    pub name: String,
    pub workspace: String,
    pub model: Option<String>,
}

impl AgentCreate {
    pub fn try_new(name: String, workspace: String, model: Option<String>) -> Result<Self, ()> {
        if !valid_text(&name) || !valid_text(&workspace) || !valid_optional_text(&model) {
            return Err(());
        }
        Ok(Self {
            name,
            workspace,
            model,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentUpdate {
    pub agent_id: String,
    pub name: Option<String>,
    pub workspace: Option<String>,
    pub model: AgentModelUpdate,
}

impl AgentUpdate {
    pub fn try_new(
        agent_id: String,
        name: Option<String>,
        workspace: Option<String>,
        model: AgentModelUpdate,
    ) -> Result<Self, ()> {
        if !valid_text(&agent_id)
            || !valid_optional_text(&name)
            || !valid_optional_text(&workspace)
            || !model.is_valid()
            || (name.is_none() && workspace.is_none() && model == AgentModelUpdate::Unchanged)
        {
            return Err(());
        }
        Ok(Self {
            agent_id,
            name,
            workspace,
            model,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentModelUpdate {
    Unchanged,
    Set(Option<String>),
}

impl AgentModelUpdate {
    fn is_valid(&self) -> bool {
        match self {
            Self::Unchanged => true,
            Self::Set(model) => valid_optional_text(model),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDelete {
    pub agent_id: String,
    pub delete_files: bool,
}

impl AgentDelete {
    pub fn try_new(agent_id: String, delete_files: bool) -> Result<Self, ()> {
        if !valid_text(&agent_id) {
            return Err(());
        }
        Ok(Self {
            agent_id,
            delete_files,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentFileName {
    Agents,
    Soul,
    User,
    Memory,
}

impl AgentFileName {
    pub fn parse(value: &str) -> Result<Self, ()> {
        match value {
            "AGENTS.md" => Ok(Self::Agents),
            "SOUL.md" => Ok(Self::Soul),
            "USER.md" => Ok(Self::User),
            "MEMORY.md" => Ok(Self::Memory),
            _ => Err(()),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Soul => "SOUL.md",
            Self::User => "USER.md",
            Self::Memory => "MEMORY.md",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Outcome {
    Agents {
        default_id: String,
        selection_required: bool,
        agents: Vec<AgentSummary>,
    },
    Created(AgentCreated),
    WorkspaceInitializationFailed(AgentCreated),
    Updated(AgentUpdated),
    Deleted(AgentDeleted),
    Files(AgentFiles),
    File(AgentFile),
    Configuration(ConfigurationDisplay),
    ConfigurationApplied,
    SkillConfiguration(SkillConfigurationOutcome),
    ToolConfiguration(ToolConfigurationOutcome),
    PackageExported(PackageExportReceipt),
    PackageInstalled(PackageInstallReceipt),
    PackageInstallFailed {
        agent_id: String,
        failure: PackageInstallFailure,
        compensation: InstallCompensation,
    },
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Eq, PartialEq)]
pub struct PackageExportReceipt {
    agent_id: String,
    file_name: String,
    package_sha256: String,
    package_bytes: std::sync::Arc<[u8]>,
    exported_at_ms: u64,
}

impl PackageExportReceipt {
    pub fn new(
        agent_id: String,
        file_name: String,
        package_sha256: String,
        package_bytes: std::sync::Arc<[u8]>,
        exported_at_ms: u64,
    ) -> Self {
        Self {
            agent_id,
            file_name,
            package_sha256,
            package_bytes,
            exported_at_ms,
        }
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn package_sha256(&self) -> &str {
        &self.package_sha256
    }

    pub fn package_bytes(&self) -> &[u8] {
        &self.package_bytes
    }

    pub fn size(&self) -> u64 {
        self.package_bytes.len() as u64
    }

    pub fn exported_at_ms(&self) -> u64 {
        self.exported_at_ms
    }
}

impl std::fmt::Debug for PackageExportReceipt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PackageExportReceipt")
            .field("agent_id", &self.agent_id)
            .field("file_name", &self.file_name)
            .field("package_sha256", &self.package_sha256)
            .field(
                "package_bytes",
                &format_args!("[REDACTED:{} bytes]", self.package_bytes.len()),
            )
            .field("exported_at_ms", &self.exported_at_ms)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageInstallReceipt {
    agent_id: String,
}

impl PackageInstallReceipt {
    pub fn new(agent_id: String) -> Self {
        Self { agent_id }
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageInstallPlan {
    agent_id: String,
    workspace: String,
    workspace_preexisted: bool,
}

impl PackageInstallPlan {
    pub fn new(agent_id: String, workspace: String, workspace_preexisted: bool) -> Self {
        Self {
            agent_id,
            workspace,
            workspace_preexisted,
        }
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    pub fn workspace_preexisted(&self) -> bool {
        self.workspace_preexisted
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSummary {
    pub id: String,
    pub name: Option<String>,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub kind: AgentKind,
    pub sealed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentKind {
    System,
    Agent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCreated {
    pub agent_id: String,
    pub name: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentUpdated {
    pub agent_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDeleted {
    pub agent_id: String,
    pub native_ok: bool,
    pub removed_bindings: u64,
    pub failed_count: usize,
    pub purge_failed_count: usize,
    pub sealed_purge: SealedPurge,
}

impl AgentDeleted {
    pub fn native_succeeded(&self) -> bool {
        self.native_ok && self.failed_count == 0 && self.purge_failed_count == 0
    }

    pub fn succeeded(&self) -> bool {
        self.native_succeeded() && self.sealed_purge == SealedPurge::Completed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SealedPurge {
    Completed,
    Failed,
    NotAttempted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageInstallFailure {
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCompensation {
    pub outcome: CompensationOutcome,
    pub failed_count: usize,
    pub purge_failed_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompensationOutcome {
    Deleted,
    Rejected,
    OutcomeUnknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentFiles {
    pub files: Vec<AgentFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentFile {
    pub name: AgentFileName,
    pub missing: bool,
    pub size: Option<u64>,
    pub updated_at_ms: Option<u64>,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigurationDisplay {
    pub defaults: ConfigurationDefaults,
    pub agents: Vec<ConfigurationAgent>,
}

impl ConfigurationDisplay {
    pub fn defaults(&self) -> &ConfigurationDefaults {
        &self.defaults
    }

    pub fn agents(&self) -> &[ConfigurationAgent] {
        &self.agents
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConfigurationDefaults {
    pub model: Option<ConfigurationModel>,
    pub skills: Vec<String>,
}

impl ConfigurationDefaults {
    pub fn model(&self) -> Option<&ConfigurationModel> {
        self.model.as_ref()
    }

    pub fn skills(&self) -> &[String] {
        &self.skills
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigurationAgent {
    pub id: String,
    pub description: Option<String>,
    pub model: Option<ConfigurationModel>,
    pub skills: Option<Vec<String>>,
}

impl ConfigurationAgent {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn model(&self) -> Option<&ConfigurationModel> {
        self.model.as_ref()
    }

    pub fn skills(&self) -> Option<&[String]> {
        self.skills.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigurationModel {
    pub primary: Option<String>,
    pub fallbacks: Vec<String>,
}

impl ConfigurationModel {
    pub fn try_new(primary: Option<String>, fallbacks: Vec<String>) -> Result<Self, ()> {
        let primary = primary.and_then(|value| normalize_text(&value));
        let mut normalized = BTreeSet::new();
        for fallback in fallbacks {
            let fallback = normalize_text(&fallback).ok_or(())?;
            if primary.as_deref() != Some(&fallback) {
                normalized.insert(fallback);
            }
        }
        if primary.is_none() && normalized.is_empty() {
            return Err(());
        }
        Ok(Self {
            primary,
            fallbacks: normalized.into_iter().collect(),
        })
    }

    pub fn primary(&self) -> Option<&str> {
        self.primary.as_deref()
    }

    pub fn fallbacks(&self) -> &[String] {
        &self.fallbacks
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillSelection {
    InheritDefaultSkills,
    ExplicitSkillAllowlist(Vec<String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolSelection {
    InheritDefaultTools,
    Policy {
        profile: String,
        allow: Vec<String>,
        deny: Vec<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillConfigurationOutcome {
    View(SkillConfigurationView),
    Updated(SkillConfigurationView),
    Stale(SkillConfigurationView),
    InvalidSkillKeys {
        unknown_skill_keys: Vec<String>,
        non_canonical_skill_keys: Vec<String>,
    },
    Unsupported,
    Rejected,
    OutcomeUnknown,
    Unavailable(ConfigurationReadFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolConfigurationOutcome {
    View(ToolConfigurationView),
    Updated(ToolConfigurationView),
    Stale(ToolConfigurationView),
    InvalidToolKeys(Vec<String>),
    Unsupported,
    Rejected,
    OutcomeUnknown,
    Unavailable(ConfigurationReadFailure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigurationReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillConfigurationView {
    pub agent_id: String,
    pub configured: bool,
    pub has_explicit_skill_allowlist: bool,
    pub explicit_skill_keys: Vec<String>,
    pub inherited_default_skill_keys: Vec<String>,
    pub effective_skill_keys: Vec<String>,
    pub options: Vec<SkillOption>,
    pub revision: String,
}

impl SkillConfigurationView {
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub const fn configured(&self) -> bool {
        self.configured
    }

    pub const fn has_explicit_skill_allowlist(&self) -> bool {
        self.has_explicit_skill_allowlist
    }

    pub fn explicit_skill_keys(&self) -> &[String] {
        &self.explicit_skill_keys
    }

    pub fn inherited_default_skill_keys(&self) -> &[String] {
        &self.inherited_default_skill_keys
    }

    pub fn effective_skill_keys(&self) -> &[String] {
        &self.effective_skill_keys
    }

    pub fn options(&self) -> &[SkillOption] {
        &self.options
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillOption {
    pub key: String,
    pub display_name: String,
    pub description: String,
    pub selectable: bool,
    pub unavailable_reason: Option<SkillUnavailableReason>,
    pub missing_requirements: Option<MissingSkillRequirements>,
}

impl SkillOption {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub const fn selectable(&self) -> bool {
        self.selectable
    }

    pub const fn unavailable_reason(&self) -> Option<SkillUnavailableReason> {
        self.unavailable_reason
    }

    pub fn missing_requirements(&self) -> Option<&MissingSkillRequirements> {
        self.missing_requirements.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillUnavailableReason {
    GlobalSkillDisabled,
    BlockedByRuntimeAllowlist,
    MissingRequirements,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MissingSkillRequirements {
    pub bins: Vec<String>,
    pub any_bins: Vec<String>,
    pub env: Vec<String>,
    pub config: Vec<String>,
    pub os: Vec<String>,
}

impl MissingSkillRequirements {
    pub fn bins(&self) -> &[String] {
        &self.bins
    }

    pub fn any_bins(&self) -> &[String] {
        &self.any_bins
    }

    pub fn env(&self) -> &[String] {
        &self.env
    }

    pub fn config(&self) -> &[String] {
        &self.config
    }

    pub fn os(&self) -> &[String] {
        &self.os
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolConfigurationView {
    pub agent_id: String,
    pub configured: bool,
    pub policy: Option<ToolPolicy>,
    pub catalog: ToolCatalog,
    pub revision: String,
}

impl ToolConfigurationView {
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub const fn configured(&self) -> bool {
        self.configured
    }

    pub fn policy(&self) -> Option<&ToolPolicy> {
        self.policy.as_ref()
    }

    pub fn catalog(&self) -> &ToolCatalog {
        &self.catalog
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolPolicy {
    pub profile: String,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

impl ToolPolicy {
    pub fn profile(&self) -> &str {
        &self.profile
    }

    pub fn allow(&self) -> &[String] {
        &self.allow
    }

    pub fn deny(&self) -> &[String] {
        &self.deny
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCatalog {
    pub profiles: Vec<ToolProfile>,
    pub groups: Vec<ToolGroup>,
    pub options: Vec<ToolOption>,
}

impl ToolCatalog {
    pub fn profiles(&self) -> &[ToolProfile] {
        &self.profiles
    }

    pub fn groups(&self) -> &[ToolGroup] {
        &self.groups
    }

    pub fn options(&self) -> &[ToolOption] {
        &self.options
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolProfile {
    pub key: String,
    pub display_name: String,
}

impl ToolProfile {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolGroup {
    pub key: String,
    pub display_name: String,
    pub source: String,
    pub plugin_id: Option<String>,
    pub tools: Vec<ToolOption>,
}

impl ToolGroup {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn plugin_id(&self) -> Option<&str> {
        self.plugin_id.as_deref()
    }

    pub fn tools(&self) -> &[ToolOption] {
        &self.tools
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolOption {
    pub key: String,
    pub display_name: String,
    pub description: Option<String>,
    pub source: String,
    pub plugin_id: Option<String>,
    pub optional: Option<bool>,
    pub risk: Option<String>,
    pub tags: Vec<String>,
    pub default_profiles: Vec<String>,
    pub denied_by_global_policy: bool,
    pub group_key: Option<String>,
    pub group_display_name: Option<String>,
}

impl ToolOption {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn plugin_id(&self) -> Option<&str> {
        self.plugin_id.as_deref()
    }

    pub const fn optional(&self) -> Option<bool> {
        self.optional
    }

    pub fn risk(&self) -> Option<&str> {
        self.risk.as_deref()
    }

    pub fn tags(&self) -> &[String] {
        &self.tags
    }

    pub fn default_profiles(&self) -> &[String] {
        &self.default_profiles
    }

    pub const fn denied_by_global_policy(&self) -> bool {
        self.denied_by_global_policy
    }

    pub fn group_key(&self) -> Option<&str> {
        self.group_key.as_deref()
    }

    pub fn group_display_name(&self) -> Option<&str> {
        self.group_display_name.as_deref()
    }
}

pub fn configuration(result: Result<ConfigurationDisplay, ConfigurationReadFailure>) -> Outcome {
    match result {
        Ok(display) => Outcome::Configuration(display),
        Err(ConfigurationReadFailure::Rejected) => Outcome::Rejected,
        Err(ConfigurationReadFailure::Unavailable | ConfigurationReadFailure::Protocol) => {
            Outcome::Unavailable
        }
    }
}

pub fn configuration_mutation(result: ConfigurationMutationOutcome) -> Outcome {
    match result {
        ConfigurationMutationOutcome::Applied => Outcome::ConfigurationApplied,
        ConfigurationMutationOutcome::Rejected => Outcome::Rejected,
        ConfigurationMutationOutcome::OutcomeUnknown => Outcome::Unknown,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigurationMutationOutcome {
    Applied,
    Rejected,
    OutcomeUnknown,
}

fn normalize_text(value: &str) -> Option<String> {
    let value = value.trim();
    valid_text(value).then(|| value.to_owned())
}

fn valid_optional_text(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(valid_text)
}

fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}
