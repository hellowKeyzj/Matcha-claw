use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use clawhub::ClawHubRegistryClient;
use environment::{ProviderCascade, migrate_provider_legacy_stores};
use openclaw::lifecycle::state_dir::CanonicalStateDir;
use organization::package::TeamSkillSelectionResolver;
use toolchain::NativeToolchain;

use crate::diagnostics::{
    DiagnosticsArchiveProducer, DiagnosticsArchiveRoot, MatchaStartupDiagnostics,
    OpenClawStartupDiagnostics, RuntimeFlightRecorder,
};

use super::ConstructionError;

#[cfg(test)]
#[path = "provisioning_tests.rs"]
mod tests;

pub(super) struct PrepareHostInput {
    pub(super) matcha: crate::runtime::adapters::matcha_agent::MatchaAgentInput,
    pub(super) matcha_secret: matcha_agent::lifecycle::secret::Secret,
    pub(super) open_claw: crate::runtime::adapters::openclaw::OpenClawInput,
    pub(super) open_claw_secret: openclaw::gateway::auth::GatewaySecret,
    pub(super) organization_store: organization::OrganizationStore,
    pub(super) runtime_state_dir: PathBuf,
    pub(super) app_log_dir: PathBuf,
    pub(super) runtime_observation: crate::diagnostics::RuntimeObservationConfig,
}

pub(super) struct PreparedHost {
    matcha_input: crate::runtime::adapters::matcha_agent::MatchaAgentInput,
    matcha_secret: matcha_agent::lifecycle::secret::Secret,
    openclaw_input: crate::runtime::adapters::openclaw::OpenClawInput,
    openclaw_secret: openclaw::gateway::auth::GatewaySecret,
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: MatchaStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    pub(super) clawhub_registry: ClawHubRegistryClient,
    pub(super) toolchain: Arc<NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_runtime_token: Option<Arc<str>>,
}

impl PreparedHost {
    pub(super) fn openclaw_input_mut(
        &mut self,
    ) -> &mut crate::runtime::adapters::openclaw::OpenClawInput {
        &mut self.openclaw_input
    }

    pub(super) fn into_openclaw_parts(
        self,
    ) -> (
        crate::runtime::adapters::openclaw::OpenClawInput,
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
    matcha_input: crate::runtime::adapters::matcha_agent::MatchaAgentInput,
    matcha_secret: matcha_agent::lifecycle::secret::Secret,
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    diagnostics_state_root: CanonicalStateDir,
    runtime_observation: RuntimeFlightRecorder,
    matcha_startup_diagnostics: MatchaStartupDiagnostics,
    openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    clawhub_registry: ClawHubRegistryClient,
    pub(super) toolchain: Arc<NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_runtime_token: Option<Arc<str>>,
}

pub(super) struct SealedHost {
    matcha_input: crate::runtime::adapters::matcha_agent::MatchaAgentInput,
    matcha_secret: matcha_agent::lifecycle::secret::Secret,
    organization_store: organization::OrganizationStore,
    runtime_state_dir: PathBuf,
    app_log_dir: PathBuf,
    diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: MatchaStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    pub(super) clawhub_registry: ClawHubRegistryClient,
    pub(super) toolchain: Arc<NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_runtime_token: Option<Arc<str>>,
    sealed_skill_store: Arc<crate::sealed_resource::SealedSkillStore>,
    sealed_agent_store: Arc<crate::sealed_resource::SealedAgentStore>,
    fleet_private_root_path: PathBuf,
}

impl SealedHost {
    pub(super) fn into_matcha_parts(
        self,
    ) -> (
        crate::runtime::adapters::matcha_agent::MatchaAgentInput,
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
            sealed_runtime_token,
            sealed_skill_store,
            sealed_agent_store,
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
                sealed_runtime_token,
                sealed_skill_store,
                sealed_agent_store,
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
    runtime_observation: RuntimeFlightRecorder,
    matcha_startup_diagnostics: MatchaStartupDiagnostics,
    openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    clawhub_registry: ClawHubRegistryClient,
    pub(super) toolchain: Arc<NativeToolchain>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
    sealed_runtime_token: Option<Arc<str>>,
    sealed_skill_store: Arc<crate::sealed_resource::SealedSkillStore>,
    sealed_agent_store: Arc<crate::sealed_resource::SealedAgentStore>,
    fleet_private_root_path: PathBuf,
}

pub(super) struct ProvisionedHost {
    pub(super) organization_store: organization::OrganizationStore,
    pub(super) runtime_state_dir: PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_observation: RuntimeFlightRecorder,
    pub(super) matcha_startup_diagnostics: MatchaStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    pub(super) clawhub_registry: ClawHubRegistryClient,
    pub(super) toolchain: Arc<NativeToolchain>,
    pub(super) runtime_host_mcp_executable: PathBuf,
    pub(super) team_run_mcp_state_dir: PathBuf,
    pub(super) sealed_runtime_token: Option<Arc<str>>,
    pub(super) sealed_skill_store: Arc<crate::sealed_resource::SealedSkillStore>,
    pub(super) sealed_agent_store: Arc<crate::sealed_resource::SealedAgentStore>,
    pub(super) provider_cascade: ProviderCascade,
    pub(super) fleet_private_root: PathBuf,
    pub(super) diagnostics: DiagnosticsArchiveProducer,
    pub(super) team_skill_selections: TeamSkillSelectionResolver,
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
    let matcha_startup_diagnostics = MatchaStartupDiagnostics::new();
    let openclaw_startup_diagnostics = OpenClawStartupDiagnostics::new();
    let diagnostics_state_root = open_claw.state_dir.clone();
    let clawhub_registry = ClawHubRegistryClient::new(diagnostics_state_root.as_path().to_owned());
    let runtime_observation = RuntimeFlightRecorder::new(runtime_observation);
    #[cfg(windows)]
    let toolchain = NativeToolchain::local(open_claw.working_directory.clone());
    #[cfg(unix)]
    let toolchain = NativeToolchain::local(
        open_claw.working_directory.clone(),
        open_claw.guardian_executable.clone(),
    );
    let runtime_host_mcp_executable = open_claw.team_run_mcp_executable.clone();
    let team_run_mcp_state_dir = open_claw.team_run_mcp_state_dir.clone();
    let sealed_runtime_token = open_claw.sealed_token.clone().map(Arc::<str>::from);

    PreparedHost {
        matcha_input: matcha,
        matcha_secret,
        openclaw_input: open_claw,
        openclaw_secret: open_claw_secret,
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
    fs::create_dir_all(&runtime_state_dir).map_err(|_| ConstructionError::RuntimeState)?;
    let sealed_skill_private_root = runtime_state_dir
        .parent()
        .map(|root| root.join("runtime-local").join("sealed-skills"))
        .ok_or(ConstructionError::SealedSkills)?;
    let sealed_skill_store = Arc::new(
        crate::sealed_resource::SealedSkillStore::openclaw(
            diagnostics_state_root.clone(),
            sealed_skill_private_root,
        )
        .map_err(|_| ConstructionError::SealedSkills)?,
    );
    let sealed_agent_private_root = runtime_state_dir
        .parent()
        .map(|root| root.join("runtime-local").join("sealed-agents"))
        .ok_or(ConstructionError::SealedAgents)?;
    let sealed_agent_store = Arc::new(
        crate::sealed_resource::SealedAgentStore::openclaw(
            diagnostics_state_root.clone(),
            sealed_agent_private_root,
        )
        .map_err(|_| ConstructionError::SealedAgents)?,
    );
    let fleet_private_root_path = runtime_state_dir.join("fleet-private");

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
        sealed_runtime_token,
        sealed_skill_store,
        sealed_agent_store,
        fleet_private_root_path,
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
        sealed_runtime_token,
        sealed_skill_store,
        sealed_agent_store,
        fleet_private_root_path,
    } = prepared;
    provision_private_directory(&fleet_private_root_path).map_err(|_| ConstructionError::Fleet)?;
    let fleet_private_root = fleet_private_root_path;
    let provider_store_root = diagnostics_state_root.as_path();
    let accounts_path = provider_store_root.join("matchaclaw-provider-accounts.json");
    let models_path = provider_store_root.join("matchaclaw-provider-models.json");
    let routing_path = provider_store_root.join("matchaclaw-capability-routing.json");
    let legacy_candidates =
        crate::provider::migration_locator::locate_provider_legacy_store_candidates(
            provider_store_root,
        );
    migrate_provider_legacy_stores(
        &accounts_path,
        &models_path,
        &routing_path,
        (
            legacy_candidates.accounts,
            legacy_candidates.models,
            legacy_candidates.routing,
        ),
    )
    .map_err(|_| ConstructionError::ProviderMigration)?;
    let provider_cascade = ProviderCascade::open(
        accounts_path.clone(),
        models_path.clone(),
        routing_path.clone(),
        diagnostics_state_root
            .as_path()
            .join("provider-cascade.v1.json"),
    )
    .map_err(|_| ConstructionError::ProviderAccounts)?;
    let diagnostics_root =
        DiagnosticsArchiveRoot::provision(diagnostics_state_root.as_path(), app_log_dir)
            .map_err(ConstructionError::Diagnostics)?;
    let diagnostics = DiagnosticsArchiveProducer::new_with_recorder(
        diagnostics_root,
        runtime_observation.clone(),
    )
    .map_err(ConstructionError::Diagnostics)?;
    let team_skill_selections = TeamSkillSelectionResolver::open(team_skill_selection_registry(
        diagnostics_state_root.as_path(),
    ))
    .map_err(|_| ConstructionError::TeamSkillSelection)?;

    Ok(ProvisionedHost {
        organization_store,
        runtime_state_dir,
        diagnostics_state_root,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
        sealed_runtime_token,
        sealed_skill_store,
        sealed_agent_store,
        provider_cascade,
        fleet_private_root,
        diagnostics,
        team_skill_selections,
    })
}

fn provision_private_directory(
    path: &Path,
) -> Result<(), foundation::storage::PrivateStorageError> {
    foundation::storage::provision_private_directory(path)
}

fn team_skill_selection_registry(state_dir: &Path) -> PathBuf {
    state_dir.join("team-skill-selections.v1.json")
}
