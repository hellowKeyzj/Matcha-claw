use std::{path::PathBuf, sync::Arc};

use platform::state_dir::CanonicalStateDir;

use super::resources::OrganizationOwnerProvision;

pub(super) struct PrepareHostInput {
    pub(super) matcha: matcha_agent::driver::MatchaAgentInput,
    pub(super) matcha_secret: matcha_agent::lifecycle::secret::Secret,
    pub(super) open_claw: openclaw::driver::OpenClawInput,
    pub(super) open_claw_secret: openclaw::gateway::auth::GatewaySecret,
    pub(super) organization_store: organization::OrganizationStore,
    pub(super) runtime_state_dir: PathBuf,
    pub(super) app_log_dir: PathBuf,
    pub(super) runtime_observation: ::diagnostics::RuntimeObservationConfig,
}

pub(super) struct PreparedHost {
    pub(super) matcha_input: matcha_agent::driver::MatchaAgentInput,
    pub(super) matcha_secret: matcha_agent::lifecycle::secret::Secret,
    pub(super) openclaw_input: openclaw::driver::OpenClawInput,
    pub(super) openclaw_secret: openclaw::gateway::auth::GatewaySecret,
    pub(super) organization_store: organization::OrganizationStore,
    pub(super) runtime_state_dir: PathBuf,
    pub(super) app_log_dir: PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    pub(super) runtime_host_mcp_executable: PathBuf,
    pub(super) runtime_host_mcp_state_dir: PathBuf,
    pub(super) sealed_runtime_token: Option<Arc<str>>,
}

pub(super) struct ProvisionedHost {
    pub(super) organization: OrganizationOwnerProvision,
    pub(super) runtime_state_dir: PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    pub(super) runtime_host_mcp_executable: PathBuf,
    pub(super) runtime_host_mcp_state_dir: PathBuf,
    pub(super) sealed_resource: sealed_resource::SealedResourceModule,
    pub(super) provider_cascade: provider_module::ProviderCascade,
    pub(super) fleet_private_root: PathBuf,
    pub(super) diagnostics: ::diagnostics::DiagnosticsArchiveProducer,
}

pub(super) fn prepare_host(input: PrepareHostInput) -> PreparedHost {
    let PrepareHostInput {
        matcha,
        matcha_secret,
        open_claw,
        open_claw_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        runtime_observation,
    } = input;
    let diagnostics = super::resources::prepare_runtime_diagnostics(runtime_observation);
    let diagnostics_state_root = open_claw.state_dir.clone();
    let clawhub_registry =
        clawhub::ClawHubRegistryClient::new(diagnostics_state_root.as_path().to_owned());
    let runtime_host_mcp_executable = open_claw.runtime_host_mcp_executable.clone();
    let runtime_host_mcp_state_dir = open_claw.runtime_host_mcp_state_dir.clone();
    let sealed_runtime_token = open_claw.sealed_token.clone().map(Arc::<str>::from);
    let toolchain = super::resources::provision_native_toolchain(&open_claw);

    PreparedHost {
        matcha_input: matcha,
        matcha_secret,
        openclaw_input: open_claw,
        openclaw_secret: open_claw_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        diagnostics_state_root,
        runtime_observation: diagnostics.observation,
        matcha_startup_diagnostics: diagnostics.matcha_startup,
        openclaw_startup_diagnostics: diagnostics.openclaw_startup,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        runtime_host_mcp_state_dir,
        sealed_runtime_token,
    }
}
