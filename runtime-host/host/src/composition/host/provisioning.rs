use std::{path::PathBuf, sync::Arc};

use openclaw::lifecycle::state_dir::CanonicalStateDir;

use super::{ConstructionError, resources::OrganizationOwnerProvision};

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
    matcha_input: matcha_agent::driver::MatchaAgentInput,
    matcha_secret: matcha_agent::lifecycle::secret::Secret,
    openclaw_input: openclaw::driver::OpenClawInput,
    openclaw_secret: openclaw::gateway::auth::GatewaySecret,
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_runtime_token: Option<Arc<str>>,
}

impl PreparedHost {
    pub(super) fn openclaw_input_mut(&mut self) -> &mut openclaw::driver::OpenClawInput {
        &mut self.openclaw_input
    }

    pub(super) fn into_openclaw_parts(
        self,
    ) -> (
        openclaw::driver::OpenClawInput,
        openclaw::gateway::auth::GatewaySecret,
        MatchaPreparedHost,
    ) {
        let Self {
            matcha_input,
            matcha_secret,
            openclaw_input,
            openclaw_secret,
            organization_store,
            runtime_state_dir,
            app_log_dir,
            diagnostics_state_root,
            runtime_observation,
            matcha_startup_diagnostics,
            openclaw_startup_diagnostics,
            clawhub_registry,
            toolchain,
            runtime_host_mcp_executable,
            team_run_mcp_state_dir,
            sealed_runtime_token,
        } = self;
        (
            openclaw_input,
            openclaw_secret,
            MatchaPreparedHost {
                matcha_input,
                matcha_secret,
                organization_store,
                runtime_state_dir,
                app_log_dir,
                diagnostics_state_root,
                runtime_observation,
                matcha_startup_diagnostics,
                openclaw_startup_diagnostics,
                clawhub_registry,
                toolchain,
                runtime_host_mcp_executable,
                team_run_mcp_state_dir,
                sealed_runtime_token,
            },
        )
    }
}

pub(super) struct MatchaPreparedHost {
    matcha_input: matcha_agent::driver::MatchaAgentInput,
    matcha_secret: matcha_agent::lifecycle::secret::Secret,
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    diagnostics_state_root: CanonicalStateDir,
    runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_runtime_token: Option<Arc<str>>,
}

pub(super) struct SealedHost {
    matcha_input: matcha_agent::driver::MatchaAgentInput,
    matcha_secret: matcha_agent::lifecycle::secret::Secret,
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_resource: sealed_resource::SealedResourceModule,
    fleet_private_root_path: PathBuf,
}

impl SealedHost {
    pub(super) fn into_matcha_parts(
        self,
    ) -> (
        matcha_agent::driver::MatchaAgentInput,
        matcha_agent::lifecycle::secret::Secret,
        RuntimeStorePreparedHost,
    ) {
        let Self {
            matcha_input,
            matcha_secret,
            organization_store,
            runtime_state_dir,
            app_log_dir,
            diagnostics_state_root,
            runtime_observation,
            matcha_startup_diagnostics,
            openclaw_startup_diagnostics,
            clawhub_registry,
            toolchain,
            runtime_host_mcp_executable,
            team_run_mcp_state_dir,
            sealed_resource,
            fleet_private_root_path,
        } = self;
        (
            matcha_input,
            matcha_secret,
            RuntimeStorePreparedHost {
                organization_store,
                runtime_state_dir,
                app_log_dir,
                diagnostics_state_root,
                runtime_observation,
                matcha_startup_diagnostics,
                openclaw_startup_diagnostics,
                clawhub_registry,
                toolchain,
                runtime_host_mcp_executable,
                team_run_mcp_state_dir,
                sealed_resource,
                fleet_private_root_path,
            },
        )
    }
}

pub(super) struct RuntimeStorePreparedHost {
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    diagnostics_state_root: CanonicalStateDir,
    runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_resource: sealed_resource::SealedResourceModule,
    fleet_private_root_path: PathBuf,
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
    pub(super) team_run_mcp_state_dir: PathBuf,
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
    let runtime_roots = super::resources::openclaw_runtime_roots(&open_claw);
    let clawhub_registry =
        super::resources::provision_clawhub_registry(&runtime_roots.diagnostics_state_root);
    let toolchain = super::resources::provision_native_toolchain(&open_claw);

    PreparedHost {
        matcha_input: matcha,
        matcha_secret,
        openclaw_input: open_claw,
        openclaw_secret: open_claw_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        diagnostics_state_root: runtime_roots.diagnostics_state_root,
        runtime_observation: diagnostics.observation,
        matcha_startup_diagnostics: diagnostics.matcha_startup,
        openclaw_startup_diagnostics: diagnostics.openclaw_startup,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable: runtime_roots.runtime_host_mcp_executable,
        team_run_mcp_state_dir: runtime_roots.team_run_mcp_state_dir,
        sealed_runtime_token: runtime_roots.sealed_runtime_token,
    }
}

pub(super) fn provision_sealed_resources(
    prepared: MatchaPreparedHost,
) -> Result<SealedHost, ConstructionError> {
    let MatchaPreparedHost {
        matcha_input,
        matcha_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        diagnostics_state_root,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
        sealed_runtime_token,
    } = prepared;
    let sealed = super::resources::provision_sealed_resources(
        &runtime_state_dir,
        &diagnostics_state_root,
        sealed_runtime_token,
    )?;

    Ok(SealedHost {
        matcha_input,
        matcha_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        diagnostics_state_root,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
        sealed_resource: sealed.sealed_resource,
        fleet_private_root_path: sealed.fleet_private_root_path,
    })
}

pub(super) fn provision_runtime_stores(
    prepared: RuntimeStorePreparedHost,
) -> Result<ProvisionedHost, ConstructionError> {
    let RuntimeStorePreparedHost {
        organization_store,
        runtime_state_dir,
        app_log_dir,
        diagnostics_state_root,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
        sealed_resource,
        fleet_private_root_path,
    } = prepared;
    let fleet_private_root =
        super::resources::provision_fleet_private_root(fleet_private_root_path)?;
    let provider_cascade = super::resources::provision_provider_cascade(&diagnostics_state_root)?;
    let diagnostics = super::resources::provision_diagnostics_archive(
        &diagnostics_state_root,
        app_log_dir,
        runtime_observation.clone(),
    )?;
    let organization = super::resources::provision_organization_owner(
        organization_store,
        diagnostics_state_root.as_path(),
    )?;

    Ok(ProvisionedHost {
        organization,
        runtime_state_dir,
        diagnostics_state_root,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
        sealed_resource,
        provider_cascade,
        fleet_private_root,
        diagnostics,
    })
}
