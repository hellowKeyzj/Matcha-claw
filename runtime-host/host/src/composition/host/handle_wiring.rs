use std::sync::Arc;

use super::{HostHandles, owners::RuntimeOwners};

pub(super) struct HostHandleInput {
    pub(super) admission: Arc<super::super::admission::HostAdmission>,
    pub(super) open_claw: Arc<openclaw::driver::OpenClawDriver>,
    pub(super) sealed_resource: sealed_resource::SealedResourceModule,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) session_delta_source: sessions_module::SessionDeltaSource,
    pub(super) start_gate_registry: Arc<organization::StartGateRegistry>,
}

pub(super) fn build_handles(input: HostHandleInput, owners: &RuntimeOwners) -> HostHandles {
    let HostHandleInput {
        admission,
        open_claw,
        sealed_resource,
        clawhub_registry,
        runtime_observation,
        session_delta_source,
        start_gate_registry,
    } = input;
    let runtime_directory = Arc::clone(&owners.runtime_directory);
    let toolchain_handle = owners.toolchain.clone();
    let platform_tools_handle = owners.platform_tools.clone();
    let plugins_adapter = Arc::new(openclaw::plugins::OpenClawPluginsPort::new(
        admission.clone(),
        open_claw.clone(),
        Arc::new(owners.peer_handle.clone()),
    ));
    let plugins_handle = plugins_module::PluginsModule::new(plugins_adapter);
    let skills_adapter = Arc::new(openclaw::skill::OpenClawSkillsPort::new(
        admission.clone(),
        open_claw.clone(),
        clawhub_registry,
    ));
    let skills_handle = skills_module::SkillsModule::new(
        skills_adapter.clone(),
        skills_adapter,
        sealed_resource.skills_port(),
    );
    let cron_handle = owners.cron.clone();
    let agents_handle = owners.subagents.clone();
    let task_manager_handle = owners.task_manager.clone();
    let workspace_handle = owners.workspace.clone();
    let wiki_handle = owners.wiki.clone();
    let usage_handle = owners.usage.clone();
    let diagnostics_handle = owners.diagnostics.clone();

    HostHandles {
        admission,
        peer: owners.peer_handle.clone(),
        open_claw,
        session_module: owners.session_module.clone(),
        session: owners.session_handle.clone(),
        provider: owners.provider_module.clone(),
        settings: owners.settings.clone(),
        connector: owners.connector.clone(),
        security: owners.security.clone(),
        channel: owners.channel.clone(),
        fleet: owners.fleet_handle.clone(),
        fleet_module: owners.fleet_module.clone(),
        organization_module: owners.organization_module.clone(),
        organization: owners.organization_handle.clone(),
        toolchain: toolchain_handle,
        platform_tools: platform_tools_handle,
        plugins: plugins_handle,
        sealed_resource,
        skills: skills_handle,
        cron: cron_handle,
        agents: agents_handle,
        task_manager: task_manager_handle,
        workspace: workspace_handle,
        wiki: wiki_handle,
        usage: usage_handle,
        diagnostics: diagnostics_handle,
        observation: runtime_observation.sink(),
        session_delta_source,
        start_gate_registry,
        runtime_directory,
    }
}
