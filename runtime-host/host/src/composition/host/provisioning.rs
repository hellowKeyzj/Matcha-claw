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
    pub(super) world_postgres: Option<super::WorldPostgresConfig>,
    pub(super) world_storage_targets: Vec<super::WorldPostgresConfig>,
    pub(super) world_source_access: Option<super::WorldSourceAccessConfig>,
    pub(super) initial_world: Option<world::Provision>,
    pub(super) world_peer_endpoint: Option<String>,
    pub(super) searxng_resources_dir: PathBuf,
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
    pub(super) world_postgres: Option<super::WorldPostgresConfig>,
    pub(super) world_storage_targets: Vec<super::WorldPostgresConfig>,
    pub(super) world_source_access: Option<super::WorldSourceAccessConfig>,
    pub(super) initial_world: Option<world::Provision>,
    pub(super) world_authority: Arc<world::AuthorityRoot>,
    pub(super) world_native: super::ports::world_native::Verifiers,
    pub(super) app_log_dir: PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    pub(super) search_service: Arc<searxng::Service>,
    pub(super) runtime_host_mcp_executable: PathBuf,
    pub(super) runtime_host_mcp_state_dir: PathBuf,
    pub(super) sealed_runtime_token: Option<Arc<str>>,
}

pub(super) struct ProvisionedHost {
    #[cfg(unix)]
    pub(super) world_guardian: PathBuf,
    pub(super) organization: OrganizationOwnerProvision,
    pub(super) runtime_state_dir: PathBuf,
    pub(super) world_postgres: Option<super::WorldPostgresConfig>,
    pub(super) world_storage_targets: Vec<super::WorldPostgresConfig>,
    pub(super) world_source_access: Option<super::WorldSourceAccessConfig>,
    pub(super) initial_world: Option<world::Provision>,
    pub(super) world_authority: Arc<world::AuthorityRoot>,
    pub(super) world_native: super::ports::world_native::Verifiers,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    pub(super) clawhub_registry: clawhub::ClawHubRegistryClient,
    pub(super) toolchain: Arc<::toolchain::NativeToolchain>,
    pub(super) search_service: Arc<searxng::Service>,
    pub(super) runtime_host_mcp_executable: PathBuf,
    pub(super) runtime_host_mcp_state_dir: PathBuf,
    pub(super) sealed_resource: sealed_resource::SealedResourceModule,
    pub(super) provider_cascade: provider_module::ProviderCascade,
    pub(super) fleet_private_root: PathBuf,
    pub(super) diagnostics: ::diagnostics::DiagnosticsArchiveProducer,
}

pub(super) fn prepare_host(input: PrepareHostInput) -> PreparedHost {
    let PrepareHostInput {
        mut matcha,
        matcha_secret,
        mut open_claw,
        open_claw_secret,
        organization_store,
        runtime_state_dir,
        world_postgres,
        world_storage_targets,
        world_source_access,
        initial_world,
        world_peer_endpoint,
        searxng_resources_dir,
        app_log_dir,
        runtime_observation,
    } = input;
    let world_authority = Arc::new(world::AuthorityRoot::new());
    let world_native = super::ports::world_native::prepare(
        &runtime_state_dir,
        world_peer_endpoint,
        &world_authority,
        &mut open_claw,
        &mut matcha,
    );
    let diagnostics = super::resources::prepare_runtime_diagnostics(runtime_observation);
    let diagnostics_state_root = open_claw.state_dir.clone();
    let clawhub_registry =
        clawhub::ClawHubRegistryClient::new(diagnostics_state_root.as_path().to_owned());
    let runtime_host_mcp_executable = open_claw.runtime_host_mcp_executable.clone();
    let runtime_host_mcp_state_dir = open_claw.runtime_host_mcp_state_dir.clone();
    let sealed_runtime_token = open_claw.sealed_token.clone().map(Arc::<str>::from);
    let toolchain = super::resources::provision_native_toolchain(&open_claw);
    let search_service = Arc::new(searxng::Service::new(searxng::ServiceInput {
        resources_dir: searxng_resources_dir,
        state_dir: runtime_state_dir.join("search"),
        python_environment: Arc::new(super::ports::search::SearchPython::new(Arc::clone(
            &toolchain,
        ))),
        #[cfg(unix)]
        guardian_executable: Some(open_claw.guardian_executable.clone()),
        #[cfg(windows)]
        guardian_executable: None,
    }));

    PreparedHost {
        matcha_input: matcha,
        matcha_secret,
        openclaw_input: open_claw,
        openclaw_secret: open_claw_secret,
        organization_store,
        runtime_state_dir,
        world_postgres,
        world_storage_targets,
        world_source_access,
        initial_world,
        world_authority,
        world_native,
        app_log_dir,
        diagnostics_state_root,
        runtime_observation: diagnostics.observation,
        matcha_startup_diagnostics: diagnostics.matcha_startup,
        openclaw_startup_diagnostics: diagnostics.openclaw_startup,
        clawhub_registry,
        toolchain,
        search_service,
        runtime_host_mcp_executable,
        runtime_host_mcp_state_dir,
        sealed_runtime_token,
    }
}
