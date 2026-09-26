use std::sync::Arc;

use foundation::execution::ObservationSink;
use openclaw::driver::OpenClawDriver;

use ::cron::CronModule;
use ::diagnostics::DiagnosticsModule;
use ::fleet::{FleetHandle, FleetModule};
use channels::ChannelModule;
use connectors::ConnectorModule;
use organization::OrganizationModule;
use platform_tools::PlatformToolsModule;
use provider_module::ProviderModule;
use security::SecurityModule;
use sessions_module::{SessionHandle, SessionModule};
use settings::SettingsModule;
use subagents::SubagentsModule;
use task_manager::TaskModule;
use toolchain::ToolchainModule;
use usage::UsageModule;
use wiki::WikiModule;
use workspace::WorkspaceModule;

use super::super::{admission::HostAdmission, peer::PeerHandle};

pub(crate) struct HostHandles {
    pub admission: Arc<HostAdmission>,
    pub peer: PeerHandle,
    pub open_claw: Arc<OpenClawDriver>,
    pub session_module: SessionModule,
    pub session: SessionHandle,
    pub provider: ProviderModule,
    pub settings: SettingsModule,
    pub connector: ConnectorModule,
    pub security: SecurityModule,
    pub channel: ChannelModule,
    pub fleet: FleetHandle,
    pub fleet_module: FleetModule,
    pub organization_module: OrganizationModule,
    pub organization: organization::OrganizationHandle,
    pub toolchain: ToolchainModule,
    pub platform_tools: PlatformToolsModule,
    pub plugins: plugins_module::PluginsModule,
    pub sealed_resource: sealed_resource::SealedResourceModule,
    pub skills: skills_module::SkillsModule,
    pub cron: CronModule,
    pub agents: SubagentsModule,
    pub task_manager: TaskModule,
    pub workspace: WorkspaceModule,
    pub wiki: WikiModule,
    pub usage: UsageModule,
    pub diagnostics: DiagnosticsModule,
    pub(crate) observation: ObservationSink,
    pub session_delta_source: sessions_module::SessionDeltaSource,
    pub start_gate_registry: Arc<organization::StartGateRegistry>,
    pub runtime_directory: Arc<super::super::runtime_ports::RuntimeDriverDirectory>,
}
