use std::sync::Arc;

use super::HostHandles;
use super::owner_runtime::RuntimeOwners;

pub(super) struct HostHandleInput {
    pub(super) admission: Arc<super::super::admission::HostAdmission>,
    pub(super) open_claw: Arc<crate::runtime::adapters::openclaw::OpenClawInstance>,
    pub(super) toolchain: Arc<toolchain::NativeToolchain>,
    pub(super) runtime_directory: Arc<crate::runtime::directory::RuntimeDriverDirectory>,
    pub(super) sealed_skill_store: Arc<crate::sealed_resource::SealedSkillStore>,
    pub(super) sealed_agent_store: Arc<crate::sealed_resource::SealedAgentStore>,
    pub(super) sealed_runtime_token: Option<Arc<str>>,
    pub(super) diagnostics: crate::diagnostics::DiagnosticsArchiveProducer,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) runtime_observation: crate::diagnostics::RuntimeFlightRecorder,
}

pub(super) fn build_handles(
    input: HostHandleInput,
    owners: &RuntimeOwners,
    event_sinks: &super::super::events::EventSinks,
) -> HostHandles {
    let HostHandleInput {
        admission,
        open_claw,
        toolchain,
        runtime_directory,
        sealed_skill_store,
        sealed_agent_store,
        sealed_runtime_token,
        diagnostics,
        clawhub_registry,
        runtime_observation,
    } = input;
    let platform_runtime_handle =
        crate::facade::PlatformRuntimeHandle::new(Arc::clone(&admission), Arc::clone(&open_claw));
    let toolchain_handle =
        crate::facade::ToolchainHandle::new(Arc::clone(&admission), Arc::clone(&toolchain));
    let platform_tools_handle =
        crate::facade::PlatformToolsHandle::new(Arc::clone(&admission), Arc::clone(&open_claw));
    let plugins_handle = crate::facade::PluginsHandle::new(
        Arc::clone(&admission),
        Arc::clone(&open_claw),
        owners.peer_handle.clone(),
    );
    let skills_handle = crate::facade::SkillsHandle::new(
        Arc::clone(&admission),
        Arc::clone(&runtime_directory),
        sealed_skill_store,
        sealed_runtime_token.clone(),
    );
    let cron_handle = crate::facade::CronHandle::new(
        Arc::clone(&admission),
        Arc::clone(&runtime_directory),
        owners.session_handle.clone(),
        event_sinks.open_claw_cron(),
        runtime_observation.sink(),
    );
    let agents_handle = crate::facade::AgentsHandle::new(
        Arc::clone(&admission),
        Arc::clone(&runtime_directory),
        sealed_agent_store,
        sealed_runtime_token,
    );
    let task_manager_handle = crate::facade::TaskManagerHandle::new(
        Arc::clone(&admission),
        Arc::clone(&runtime_directory),
    );
    let workspace_handle =
        crate::facade::WorkspaceHandle::new(Arc::clone(&admission), Arc::clone(&runtime_directory));
    let usage_handle =
        crate::facade::UsageHandle::new(Arc::clone(&admission), Arc::clone(&open_claw));
    let diagnostics_handle = crate::facade::DiagnosticsHandle::new(
        Arc::clone(&admission),
        diagnostics.clone(),
        owners.peer_handle.clone(),
    );

    HostHandles {
        peer: owners.peer_handle.clone(),
        session: owners.session_handle.clone(),
        provider: owners.provider_handle.clone(),
        settings: owners.settings_handle.clone(),
        connector: owners.connector_handle.clone(),
        security: owners.security_handle.clone(),
        channel: owners.channel_handle.clone(),
        fleet: owners.fleet_handle.clone(),
        organization: owners.organization_handle.clone(),
        platform_runtime: platform_runtime_handle,
        toolchain: toolchain_handle,
        platform_tools: platform_tools_handle,
        plugins: plugins_handle,
        skills: skills_handle,
        clawhub_registry,
        cron: cron_handle,
        agents: agents_handle,
        task_manager: task_manager_handle,
        workspace: workspace_handle,
        usage: usage_handle,
        diagnostics: diagnostics_handle,
        observation: runtime_observation.sink(),
        channel_endpoint: owners.channel_endpoint.clone(),
    }
}
