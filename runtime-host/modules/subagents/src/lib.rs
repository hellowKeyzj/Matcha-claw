mod adapters;
mod api;
mod application;
pub mod capability;
mod domain;
mod owner;
pub mod ports;
mod projection;

use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::SubagentHandle;

const MODULE_ID: ModuleId = ModuleId::new("subagents");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("subagent.management"),
    CapabilityKey::new("subagent.skills"),
    CapabilityKey::new("subagent.tools"),
];
const REQUIRES: &[CapabilityKey] = &[
    CapabilityKey::new("runtime.subagents"),
    CapabilityKey::new("sealed-agent-store.read"),
];
const ROUTES: &[&str] = &["subagents.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use domain::model;
pub use domain::model::{
    AgentCreate, AgentCreated, AgentDelete, AgentDeleted, AgentFile, AgentFileName, AgentFiles,
    AgentKind, AgentModelUpdate, AgentSummary, AgentUpdate, AgentUpdated, AgentWait,
    AgentWaitResult, AgentWaitStatus, CloudPackageMetadata, Command, ConfigurationAgent,
    ConfigurationDefaults, ConfigurationDisplay, ConfigurationModel, ConfigurationMutationOutcome,
    ConfigurationReadFailure, MissingSkillRequirements, NativeEndpoint, Outcome,
    PackageExportReceipt, PackageInstallPlan, PackageInstallReceipt, SkillConfigurationOutcome,
    SkillConfigurationView, SkillOption, SkillSelection, SkillUnavailableReason, ToolCatalog,
    ToolConfigurationOutcome, ToolConfigurationView, ToolGroup, ToolOption, ToolPolicy,
    ToolProfile, ToolSelection, WorkspaceInitialization, configuration, configuration_mutation,
};
pub use owner::{SubagentOwnerInput, spawn_owner};
pub use ports::{
    SealedAgentError, SealedAgentRead, SealedAgentStorePort, SubagentFuture, SubagentOps,
    SubagentRequestAdmission, SubagentRequestAdmissionClosed, SubagentRuntimeDirectory,
};

#[derive(Clone)]
pub struct SubagentsModule {
    handle: SubagentHandle,
    sealed_agents: Arc<dyn SealedAgentStorePort>,
}

impl SubagentsModule {
    fn new(handle: SubagentHandle, sealed_agents: Arc<dyn SealedAgentStorePort>) -> Self {
        Self {
            handle,
            sealed_agents,
        }
    }

    pub async fn subagents(&self, command: Command) -> Result<Outcome, ()> {
        self.handle.subagents(command).await
    }

    pub fn read_sealed_agent_file(
        &self,
        token: &str,
        agent_id: String,
        path: String,
    ) -> Result<SealedAgentRead, SealedAgentError> {
        self.sealed_agents.read_file(token, agent_id, path)
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone(),
            self.clone(),
        ))
    }
}
