use std::collections::BTreeSet;

use crate::sealed_resource::{SealedAgentCatalogEntry, SealedAgentPackageExport};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
}

impl NativeEndpoint {
    pub(crate) fn runtime_endpoint(self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        match self {
            Self::OpenClawLocal => {
                crate::runtime::driver::RuntimeDriverIdentity::open_claw().endpoint()
            }
            Self::MatchaAgentLocal => {
                crate::runtime::driver::RuntimeDriverIdentity::matcha_agent().endpoint()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceInitialization {
    MainAgentTemplate,
    EmptyWorkspace,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    List {
        endpoint: NativeEndpoint,
    },
    Wait {
        endpoint: NativeEndpoint,
        input: AgentWait,
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
    InstallPackage {
        endpoint: NativeEndpoint,
        package_path: String,
    },
}

impl Command {
    pub(crate) const fn endpoint(&self) -> NativeEndpoint {
        match self {
            Self::List { endpoint }
            | Self::Wait { endpoint, .. }
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
            | Self::InstallPackage { endpoint, .. } => *endpoint,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentWait {
    pub(crate) run_id: String,
    pub(crate) wait_slice_ms: u64,
    pub(crate) rpc_timeout_buffer_ms: u64,
}

impl AgentWait {
    pub(crate) fn try_new(
        run_id: String,
        wait_slice_ms: u64,
        rpc_timeout_buffer_ms: u64,
    ) -> Result<Self, ()> {
        if !valid_text(&run_id)
            || !(1_000..=60_000).contains(&wait_slice_ms)
            || rpc_timeout_buffer_ms > 10_000
        {
            return Err(());
        }
        Ok(Self {
            run_id,
            wait_slice_ms,
            rpc_timeout_buffer_ms,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentCreate {
    pub(crate) name: String,
    pub(crate) workspace: String,
    pub(crate) model: Option<String>,
}

impl AgentCreate {
    pub(crate) fn try_new(
        name: String,
        workspace: String,
        model: Option<String>,
    ) -> Result<Self, ()> {
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
pub(crate) struct AgentUpdate {
    pub(crate) agent_id: String,
    pub(crate) name: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) model: AgentModelUpdate,
}

impl AgentUpdate {
    pub(crate) fn try_new(
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
pub(crate) enum AgentModelUpdate {
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
pub(crate) struct AgentDelete {
    pub(crate) agent_id: String,
    pub(crate) delete_files: bool,
}

impl AgentDelete {
    pub(crate) fn try_new(agent_id: String, delete_files: bool) -> Result<Self, ()> {
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
pub(crate) enum AgentFileName {
    Agents,
    Soul,
    User,
    Memory,
}

impl AgentFileName {
    pub(crate) fn parse(value: &str) -> Result<Self, ()> {
        match value {
            "AGENTS.md" => Ok(Self::Agents),
            "SOUL.md" => Ok(Self::Soul),
            "USER.md" => Ok(Self::User),
            "MEMORY.md" => Ok(Self::Memory),
            _ => Err(()),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Soul => "SOUL.md",
            Self::User => "USER.md",
            Self::Memory => "MEMORY.md",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Agents {
        default_id: String,
        selection_required: bool,
        agents: Vec<AgentSummary>,
    },
    Waited(AgentWaitResult),
    WaitUnknown,
    Created(AgentCreated),
    Updated(AgentUpdated),
    Deleted(AgentDeleted),
    Files(AgentFiles),
    File(AgentFile),
    Configuration(ConfigurationDisplay),
    ConfigurationApplied,
    SkillConfiguration(SkillConfigurationOutcome),
    ToolConfiguration(ToolConfigurationOutcome),
    PackageExported(SealedAgentPackageExport),
    PackageInstalled(SealedAgentCatalogEntry),
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentSummary {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) kind: AgentKind,
    pub(crate) sealed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentKind {
    System,
    Agent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentCreated {
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) model: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentUpdated {
    pub(crate) agent_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentDeleted {
    pub(crate) agent_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentFiles {
    pub(crate) files: Vec<AgentFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentFile {
    pub(crate) name: AgentFileName,
    pub(crate) missing: bool,
    pub(crate) size: Option<u64>,
    pub(crate) updated_at_ms: Option<u64>,
    pub(crate) content: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentWaitResult {
    pub(crate) status: AgentWaitStatus,
    pub(crate) started_at: Option<u64>,
    pub(crate) ended_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentWaitStatus {
    Completed,
    Failed,
    Timeout,
    Pending,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigurationDisplay {
    pub(crate) defaults: ConfigurationDefaults,
    pub(crate) agents: Vec<ConfigurationAgent>,
}

impl ConfigurationDisplay {
    pub(crate) fn defaults(&self) -> &ConfigurationDefaults {
        &self.defaults
    }

    pub(crate) fn agents(&self) -> &[ConfigurationAgent] {
        &self.agents
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ConfigurationDefaults {
    pub(crate) model: Option<ConfigurationModel>,
    pub(crate) skills: Vec<String>,
}

impl ConfigurationDefaults {
    pub(crate) fn model(&self) -> Option<&ConfigurationModel> {
        self.model.as_ref()
    }

    pub(crate) fn skills(&self) -> &[String] {
        &self.skills
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigurationAgent {
    pub(crate) id: String,
    pub(crate) description: Option<String>,
    pub(crate) model: Option<ConfigurationModel>,
    pub(crate) skills: Option<Vec<String>>,
}

impl ConfigurationAgent {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub(crate) fn model(&self) -> Option<&ConfigurationModel> {
        self.model.as_ref()
    }

    pub(crate) fn skills(&self) -> Option<&[String]> {
        self.skills.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigurationModel {
    pub(crate) primary: Option<String>,
    pub(crate) fallbacks: Vec<String>,
}

impl ConfigurationModel {
    pub(crate) fn try_new(primary: Option<String>, fallbacks: Vec<String>) -> Result<Self, ()> {
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

    pub(crate) fn primary(&self) -> Option<&str> {
        self.primary.as_deref()
    }

    pub(crate) fn fallbacks(&self) -> &[String] {
        &self.fallbacks
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SkillSelection {
    InheritDefaultSkills,
    ExplicitSkillAllowlist(Vec<String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ToolSelection {
    InheritDefaultTools,
    Policy {
        profile: String,
        allow: Vec<String>,
        deny: Vec<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SkillConfigurationOutcome {
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
pub(crate) enum ToolConfigurationOutcome {
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
pub(crate) enum ConfigurationReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillConfigurationView {
    pub(crate) agent_id: String,
    pub(crate) configured: bool,
    pub(crate) has_explicit_skill_allowlist: bool,
    pub(crate) explicit_skill_keys: Vec<String>,
    pub(crate) inherited_default_skill_keys: Vec<String>,
    pub(crate) effective_skill_keys: Vec<String>,
    pub(crate) options: Vec<SkillOption>,
    pub(crate) revision: String,
}

impl SkillConfigurationView {
    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) const fn configured(&self) -> bool {
        self.configured
    }

    pub(crate) const fn has_explicit_skill_allowlist(&self) -> bool {
        self.has_explicit_skill_allowlist
    }

    pub(crate) fn explicit_skill_keys(&self) -> &[String] {
        &self.explicit_skill_keys
    }

    pub(crate) fn inherited_default_skill_keys(&self) -> &[String] {
        &self.inherited_default_skill_keys
    }

    pub(crate) fn effective_skill_keys(&self) -> &[String] {
        &self.effective_skill_keys
    }

    pub(crate) fn options(&self) -> &[SkillOption] {
        &self.options
    }

    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillOption {
    pub(crate) key: String,
    pub(crate) display_name: String,
    pub(crate) description: String,
    pub(crate) selectable: bool,
    pub(crate) unavailable_reason: Option<SkillUnavailableReason>,
    pub(crate) missing_requirements: Option<MissingSkillRequirements>,
}

impl SkillOption {
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn description(&self) -> &str {
        &self.description
    }

    pub(crate) const fn selectable(&self) -> bool {
        self.selectable
    }

    pub(crate) const fn unavailable_reason(&self) -> Option<SkillUnavailableReason> {
        self.unavailable_reason
    }

    pub(crate) fn missing_requirements(&self) -> Option<&MissingSkillRequirements> {
        self.missing_requirements.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SkillUnavailableReason {
    GlobalSkillDisabled,
    BlockedByRuntimeAllowlist,
    MissingRequirements,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct MissingSkillRequirements {
    pub(crate) bins: Vec<String>,
    pub(crate) any_bins: Vec<String>,
    pub(crate) env: Vec<String>,
    pub(crate) config: Vec<String>,
    pub(crate) os: Vec<String>,
}

impl MissingSkillRequirements {
    pub(crate) fn bins(&self) -> &[String] {
        &self.bins
    }

    pub(crate) fn any_bins(&self) -> &[String] {
        &self.any_bins
    }

    pub(crate) fn env(&self) -> &[String] {
        &self.env
    }

    pub(crate) fn config(&self) -> &[String] {
        &self.config
    }

    pub(crate) fn os(&self) -> &[String] {
        &self.os
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolConfigurationView {
    pub(crate) agent_id: String,
    pub(crate) configured: bool,
    pub(crate) policy: Option<ToolPolicy>,
    pub(crate) catalog: ToolCatalog,
    pub(crate) revision: String,
}

impl ToolConfigurationView {
    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) const fn configured(&self) -> bool {
        self.configured
    }

    pub(crate) fn policy(&self) -> Option<&ToolPolicy> {
        self.policy.as_ref()
    }

    pub(crate) fn catalog(&self) -> &ToolCatalog {
        &self.catalog
    }

    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolPolicy {
    pub(crate) profile: String,
    pub(crate) allow: Vec<String>,
    pub(crate) deny: Vec<String>,
}

impl ToolPolicy {
    pub(crate) fn profile(&self) -> &str {
        &self.profile
    }

    pub(crate) fn allow(&self) -> &[String] {
        &self.allow
    }

    pub(crate) fn deny(&self) -> &[String] {
        &self.deny
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolCatalog {
    pub(crate) profiles: Vec<ToolProfile>,
    pub(crate) groups: Vec<ToolGroup>,
    pub(crate) options: Vec<ToolOption>,
}

impl ToolCatalog {
    pub(crate) fn profiles(&self) -> &[ToolProfile] {
        &self.profiles
    }

    pub(crate) fn groups(&self) -> &[ToolGroup] {
        &self.groups
    }

    pub(crate) fn options(&self) -> &[ToolOption] {
        &self.options
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolProfile {
    pub(crate) key: String,
    pub(crate) display_name: String,
}

impl ToolProfile {
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolGroup {
    pub(crate) key: String,
    pub(crate) display_name: String,
    pub(crate) source: String,
    pub(crate) plugin_id: Option<String>,
    pub(crate) tools: Vec<ToolOption>,
}

impl ToolGroup {
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn source(&self) -> &str {
        &self.source
    }

    pub(crate) fn plugin_id(&self) -> Option<&str> {
        self.plugin_id.as_deref()
    }

    pub(crate) fn tools(&self) -> &[ToolOption] {
        &self.tools
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolOption {
    pub(crate) key: String,
    pub(crate) display_name: String,
    pub(crate) description: Option<String>,
    pub(crate) source: String,
    pub(crate) plugin_id: Option<String>,
    pub(crate) optional: Option<bool>,
    pub(crate) risk: Option<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) default_profiles: Vec<String>,
    pub(crate) group_key: Option<String>,
    pub(crate) group_display_name: Option<String>,
}

impl ToolOption {
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub(crate) fn source(&self) -> &str {
        &self.source
    }

    pub(crate) fn plugin_id(&self) -> Option<&str> {
        self.plugin_id.as_deref()
    }

    pub(crate) const fn optional(&self) -> Option<bool> {
        self.optional
    }

    pub(crate) fn risk(&self) -> Option<&str> {
        self.risk.as_deref()
    }

    pub(crate) fn tags(&self) -> &[String] {
        &self.tags
    }

    pub(crate) fn default_profiles(&self) -> &[String] {
        &self.default_profiles
    }

    pub(crate) fn group_key(&self) -> Option<&str> {
        self.group_key.as_deref()
    }

    pub(crate) fn group_display_name(&self) -> Option<&str> {
        self.group_display_name.as_deref()
    }
}

pub(crate) fn configuration(
    result: Result<ConfigurationDisplay, ConfigurationReadFailure>,
) -> Outcome {
    match result {
        Ok(display) => Outcome::Configuration(display),
        Err(ConfigurationReadFailure::Rejected) => Outcome::Rejected,
        Err(ConfigurationReadFailure::Unavailable | ConfigurationReadFailure::Protocol) => {
            Outcome::Unavailable
        }
    }
}

pub(crate) fn configuration_mutation(result: ConfigurationMutationOutcome) -> Outcome {
    match result {
        ConfigurationMutationOutcome::Applied => Outcome::ConfigurationApplied,
        ConfigurationMutationOutcome::Rejected => Outcome::Rejected,
        ConfigurationMutationOutcome::OutcomeUnknown => Outcome::Unknown,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConfigurationMutationOutcome {
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
