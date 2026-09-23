use std::{path::PathBuf, sync::Arc};

use platform::module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId};
use platform::state_dir::CanonicalStateDir;
use skills_module::projection::sealed as skill_projection;

use crate::{
    api::{SealedResourceError, SealedResourceRead},
    domain::{AgentKey, PackageRelativePath, SkillKey},
    store::{
        SealedAgentPackageExport, SealedAgentRuntimeProjection, SealedAgentStore,
        SealedSkillCatalog, SealedSkillCatalogEntry, SealedSkillStore,
    },
};

const MODULE_ID: ModuleId = ModuleId::new("sealed-resource");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("sealed-skill-store.read"),
    CapabilityKey::new("sealed-agent-store.read"),
];
const REQUIRES: &[CapabilityKey] = &[];
const ROUTES: &[&str] = &[];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::FilesystemRead, EffectKind::FilesystemWrite];

#[derive(Clone)]
pub struct SealedResourceModule {
    skills: Arc<dyn skills_module::SealedSkillStorePort>,
    agents: Arc<dyn subagents::SealedAgentStorePort>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedResourceProvisionError {
    Skills,
    Agents,
}

impl SealedResourceModule {
    pub fn new(
        skill_store: Arc<SealedSkillStore>,
        agent_store: Arc<SealedAgentStore>,
        runtime_token: Option<Arc<str>>,
    ) -> Self {
        Self {
            skills: Arc::new(SealedSkillStoreAdapter::new(
                skill_store,
                runtime_token.clone(),
            )),
            agents: Arc::new(SealedAgentStoreAdapter::new(agent_store, runtime_token)),
        }
    }

    pub fn openclaw(
        state_dir: CanonicalStateDir,
        agent_runtime: Arc<dyn SealedAgentRuntimeProjection>,
        skill_private_root: PathBuf,
        agent_private_root: PathBuf,
        runtime_token: Option<Arc<str>>,
    ) -> Result<Self, SealedResourceProvisionError> {
        let skill_store = Arc::new(
            SealedSkillStore::openclaw(state_dir, skill_private_root)
                .map_err(|_| SealedResourceProvisionError::Skills)?,
        );
        let agent_store = Arc::new(
            SealedAgentStore::openclaw(agent_runtime, agent_private_root)
                .map_err(|_| SealedResourceProvisionError::Agents)?,
        );
        Ok(Self::new(skill_store, agent_store, runtime_token))
    }

    pub fn skills_port(&self) -> Arc<dyn skills_module::SealedSkillStorePort> {
        self.skills.clone()
    }

    pub fn agents_port(&self) -> Arc<dyn subagents::SealedAgentStorePort> {
        self.agents.clone()
    }

    pub fn descriptor(&self) -> ModuleDescriptor {
        ModuleDescriptor::new(MODULE_ID, PROVIDES, REQUIRES, EFFECTS, ROUTES, EVENTS, None)
    }
}

struct SealedSkillStoreAdapter {
    store: Arc<SealedSkillStore>,
    runtime_token: Option<Arc<str>>,
}

impl SealedSkillStoreAdapter {
    fn new(store: Arc<SealedSkillStore>, runtime_token: Option<Arc<str>>) -> Self {
        Self {
            store,
            runtime_token,
        }
    }
}

impl skills_module::SealedSkillStorePort for SealedSkillStoreAdapter {
    fn sealed_catalog(
        &self,
    ) -> Result<skills_module::SealedSkillCatalog, skills_module::SealedSkillError> {
        self.store
            .catalog()
            .map(SealedSkillCatalogProjectionInput::from_catalog)
            .map(skill_projection::project_catalog)
            .map_err(project_skill_error)
    }

    fn export_sealed_skill_package(
        &self,
        skill_key: String,
    ) -> Result<skills_module::SealedSkillCatalogEntry, skills_module::SealedSkillError> {
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        self.store
            .export_plain_directory_package(skill_key)
            .map(SealedSkillCatalogEntryProjectionInput)
            .map(skill_projection::project_entry)
            .map_err(project_skill_error)
    }

    fn install_sealed_skill(
        &self,
        package_path: PathBuf,
    ) -> Result<skills_module::SealedSkillCatalogEntry, skills_module::SealedSkillError> {
        self.store
            .install_package_path(package_path)
            .map(SealedSkillCatalogEntryProjectionInput)
            .map(skill_projection::project_entry)
            .map_err(project_skill_error)
    }

    fn read_sealed_skill_file(
        &self,
        token: &str,
        skill_key: String,
        path: String,
    ) -> Result<skills_module::SealedResourceRead, skills_module::SealedSkillError> {
        if !self
            .runtime_token
            .as_deref()
            .is_some_and(|expected| expected == token)
        {
            return Err(skill_projection::rejected_error());
        }
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        let path =
            PackageRelativePath::parse(path).map_err(|_| skill_projection::rejected_error())?;
        self.store
            .read_file(skill_key, path)
            .map(SealedResourceReadProjectionInput)
            .map(skill_projection::project_read)
            .map_err(project_skill_error)
    }

    fn remove_sealed_skill(
        &self,
        skill_key: String,
    ) -> Result<bool, skills_module::SealedSkillError> {
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        self.store
            .remove_package(skill_key)
            .map_err(project_skill_error)
    }
}

struct SealedAgentStoreAdapter {
    store: Arc<SealedAgentStore>,
    runtime_token: Option<Arc<str>>,
}

impl SealedAgentStoreAdapter {
    fn new(store: Arc<SealedAgentStore>, runtime_token: Option<Arc<str>>) -> Self {
        Self {
            store,
            runtime_token,
        }
    }
}

impl subagents::SealedAgentStorePort for SealedAgentStoreAdapter {
    fn export_package(
        &self,
        agent_id: String,
    ) -> Result<subagents::PackageExportReceipt, subagents::SealedAgentError> {
        let agent_key =
            AgentKey::parse(agent_id).map_err(|_| subagents::SealedAgentError::Rejected)?;
        self.store
            .export_plain_workspace_package(agent_key)
            .map(project_agent_export)
            .map_err(project_agent_error)
    }

    fn install_package(
        &self,
        package_path: String,
    ) -> Result<subagents::PackageInstallReceipt, subagents::SealedAgentError> {
        self.store
            .install_package_path(PathBuf::from(package_path))
            .map(|entry| {
                subagents::PackageInstallReceipt::new(entry.agent_key().as_str().to_owned())
            })
            .map_err(project_agent_error)
    }

    fn contains_agents(
        &self,
        agent_ids: &[String],
    ) -> Result<Vec<String>, subagents::SealedAgentError> {
        let agent_keys = agent_ids
            .iter()
            .filter_map(|agent_id| AgentKey::parse(agent_id.clone()).ok())
            .collect::<Vec<_>>();
        self.store
            .contains_agents(&agent_keys)
            .map(|sealed| {
                sealed
                    .into_iter()
                    .map(|agent_key| agent_key.as_str().to_owned())
                    .collect()
            })
            .map_err(project_agent_error)
    }

    fn read_file(
        &self,
        token: &str,
        agent_id: String,
        path: String,
    ) -> Result<subagents::SealedAgentRead, subagents::SealedAgentError> {
        if !self
            .runtime_token
            .as_deref()
            .is_some_and(|expected| expected == token)
        {
            return Err(subagents::SealedAgentError::Rejected);
        }
        let agent_key =
            AgentKey::parse(agent_id).map_err(|_| subagents::SealedAgentError::Rejected)?;
        let path =
            PackageRelativePath::parse(path).map_err(|_| subagents::SealedAgentError::Rejected)?;
        self.store
            .read_file(agent_key, path)
            .map(|read| {
                subagents::SealedAgentRead::new(
                    read.content().to_vec(),
                    read.metering_binding()
                        .map(|binding| binding.as_str().to_owned()),
                )
            })
            .map_err(project_agent_error)
    }
}

struct SealedSkillCatalogProjectionInput {
    entries: Vec<SealedSkillCatalogEntryProjectionInput>,
}

impl SealedSkillCatalogProjectionInput {
    fn from_catalog(catalog: SealedSkillCatalog) -> Self {
        Self {
            entries: catalog
                .entries()
                .iter()
                .cloned()
                .map(SealedSkillCatalogEntryProjectionInput)
                .collect(),
        }
    }
}

impl skill_projection::SealedCatalogProjection for SealedSkillCatalogProjectionInput {
    type Entry = SealedSkillCatalogEntryProjectionInput;

    fn entries(&self) -> &[Self::Entry] {
        &self.entries
    }
}

struct SealedSkillCatalogEntryProjectionInput(SealedSkillCatalogEntry);

impl skill_projection::SealedEntryProjection for SealedSkillCatalogEntryProjectionInput {
    fn skill_key(&self) -> &str {
        self.0.skill_key().as_str()
    }

    fn name(&self) -> &str {
        self.0.descriptor().name()
    }

    fn description(&self) -> &str {
        self.0.descriptor().description()
    }

    fn runtime_target(&self) -> &'static str {
        self.0.runtime_target().as_str()
    }
}

struct SealedResourceReadProjectionInput(SealedResourceRead);

impl skill_projection::SealedReadProjection for SealedResourceReadProjectionInput {
    fn content(&self) -> &[u8] {
        self.0.content()
    }

    fn metering_binding(&self) -> Option<&str> {
        self.0.metering_binding().map(|binding| binding.as_str())
    }
}

struct SealedResourceErrorProjectionInput(SealedResourceError);

impl skill_projection::SealedErrorProjection for SealedResourceErrorProjectionInput {
    fn sealed_error_kind(&self) -> skill_projection::SealedErrorKind {
        match self.0 {
            SealedResourceError::AlreadyExists => skill_projection::SealedErrorKind::AlreadyExists,
            SealedResourceError::NotFound => skill_projection::SealedErrorKind::NotFound,
            SealedResourceError::Rejected => skill_projection::SealedErrorKind::Rejected,
            SealedResourceError::Unknown => skill_projection::SealedErrorKind::Unknown,
        }
    }
}

fn project_skill_error(error: SealedResourceError) -> skills_module::SealedSkillError {
    skill_projection::project_error(SealedResourceErrorProjectionInput(error))
}

fn project_agent_export(receipt: SealedAgentPackageExport) -> subagents::PackageExportReceipt {
    subagents::PackageExportReceipt::new(
        receipt.agent_key().as_str().to_owned(),
        receipt.file_name().to_owned(),
        receipt.package_path().to_string_lossy().into_owned(),
        receipt.size(),
        receipt.exported_at_ms(),
    )
}

fn project_agent_error(error: SealedResourceError) -> subagents::SealedAgentError {
    match error {
        SealedResourceError::AlreadyExists => subagents::SealedAgentError::AlreadyExists,
        SealedResourceError::NotFound => subagents::SealedAgentError::NotFound,
        SealedResourceError::Rejected => subagents::SealedAgentError::Rejected,
        SealedResourceError::Unknown => subagents::SealedAgentError::Unknown,
    }
}
