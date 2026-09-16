use std::{collections::BTreeMap, sync::Arc};

use foundation::execution::{OwnedTask, OwnerRuntimeSystem};
use openclaw::lifecycle::state_dir::CanonicalStateDir;

use crate::{
    channel::{ChannelHandle, ChannelOwner, ChannelOwnerInput},
    connectors::{ConnectorHandle, ConnectorOwner, ConnectorOwnerInput},
    fleet::{handle::FleetHandle, owner::FleetOwner},
    provider::handle::ProviderHandle,
    runtime::driver::{RuntimeDriver, RuntimeDriverIdentity},
    sessions::handle::SessionHandle,
};

use super::ConstructionError;

pub(super) struct OwnerRuntimeTasks {
    pub(super) system: OwnerRuntimeSystem,
    pub(super) peer: OwnedTask<()>,
    pub(super) security: OwnedTask<()>,
    pub(super) channel: OwnedTask<()>,
    pub(super) fleet: OwnedTask<()>,
    pub(super) connector: OwnedTask<()>,
    pub(super) settings: OwnedTask<()>,
    pub(super) provider: OwnedTask<()>,
    pub(super) session: OwnedTask<()>,
    pub(super) organization: OrganizationRuntime,
}

pub(super) struct OrganizationRuntime {
    pub(super) owner: OwnedTask<()>,
    pub(super) coordinator: crate::organization::TeamRunCoordinator,
}

impl OrganizationRuntime {
    async fn cancel_and_join(&mut self) {
        self.coordinator.cancel();
        let _ = self.coordinator.join().await;
        self.owner.cancel();
        let _ = self.owner.join().await;
    }
}

impl OwnerRuntimeTasks {
    pub(super) async fn cancel_and_join(&mut self) {
        self.peer.cancel();
        self.security.cancel();
        self.channel.cancel();
        self.fleet.cancel();
        self.connector.cancel();
        self.settings.cancel();
        self.provider.cancel();
        self.session.cancel();
        self.organization.coordinator.cancel();
        let _ = self.peer.join().await;
        let _ = self.security.join().await;
        let _ = self.channel.join().await;
        let _ = self.fleet.join().await;
        let _ = self.connector.join().await;
        let _ = self.settings.join().await;
        let _ = self.provider.join().await;
        let _ = self.session.join().await;
        self.organization.cancel_and_join().await;
        let _ = self.system.cancel_and_join().await;
    }
}

pub(super) struct RuntimeOwners {
    pub(super) tasks: OwnerRuntimeTasks,
    pub(super) runtime_directory: Arc<crate::runtime::directory::RuntimeDriverDirectory>,
    pub(super) peer_startup: super::super::peer::PeerStartupState,
    pub(super) peer_handle: super::super::peer::PeerHandle,
    pub(super) session_handle: SessionHandle,
    pub(super) provider_handle: ProviderHandle,
    pub(super) settings_handle: crate::settings::SettingsHandle,
    pub(super) connector_handle: ConnectorHandle,
    pub(super) security_handle: crate::security::SecurityHandle,
    pub(super) channel_handle: ChannelHandle,
    pub(super) fleet_handle: FleetHandle,
    pub(super) fleet_startup_dispatches: Vec<crate::fleet::owner::PendingDispatch>,
    pub(super) organization_handle: crate::organization::OrganizationHandle,
    pub(super) channel_endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
}

pub(super) struct RuntimeOwnerInput {
    pub(super) organization_store: organization::OrganizationStore,
    pub(super) runtime_state_dir: std::path::PathBuf,
    pub(super) diagnostics_state_root: CanonicalStateDir,
    pub(super) runtime_host_mcp_executable: std::path::PathBuf,
    pub(super) team_run_mcp_state_dir: std::path::PathBuf,
    pub(super) provider_cascade: environment::ProviderCascade,
    pub(super) fleet_private_root: std::path::PathBuf,
    pub(super) team_skill_selections: organization::package::TeamSkillSelectionResolver,
    pub(super) matcha_startup_diagnostics: crate::diagnostics::MatchaStartupDiagnostics,
    pub(super) openclaw_startup_diagnostics: crate::diagnostics::OpenClawStartupDiagnostics,
    pub(super) runtime_observation: crate::diagnostics::RuntimeFlightRecorder,
    pub(super) open_claw: Arc<crate::runtime::adapters::openclaw::OpenClawInstance>,
    pub(super) matcha_driver: Arc<dyn RuntimeDriver>,
    pub(super) admission: Arc<super::super::admission::HostAdmission>,
    pub(super) session_delta:
        Option<tokio::sync::mpsc::Sender<crate::sessions::state::SessionDelta>>,
    pub(super) open_claw_runtime: Option<tokio::sync::mpsc::Sender<()>>,
}

pub(super) fn spawn_runtime_owners(
    owner_input: RuntimeOwnerInput,
) -> Result<RuntimeOwners, ConstructionError> {
    let RuntimeOwnerInput {
        organization_store,
        runtime_state_dir,
        diagnostics_state_root,
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
        provider_cascade,
        fleet_private_root,
        team_skill_selections,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        runtime_observation,
        open_claw,
        matcha_driver,
        admission,
        session_delta,
        open_claw_runtime,
    } = owner_input;
    let fleet = FleetOwner::open(
        runtime_state_dir.join("fleet-facts.log"),
        &fleet_private_root,
        BTreeMap::from([(
            "com.matchaclaw.remote-fleet.managed".to_owned(),
            "true".to_owned(),
        )]),
        BTreeMap::new(),
    )
    .map_err(|_| ConstructionError::Fleet)?;
    let fleet_startup_dispatches = fleet.pending_dispatches();
    let runtime_directory = Arc::new(
        crate::runtime::directory::RuntimeDriverDirectory::fixed_peers(
            Arc::clone(&open_claw),
            matcha_driver,
        ),
    );
    let owner_runtime_system = OwnerRuntimeSystem::spawn_observed(
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            foundation::execution::LaneRetention::MediumFrequency,
        ),
        runtime_observation.sink(),
    );
    let (fleet_owner_handle, fleet_task) = owner_runtime_system.spawn_owner(
        fleet,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            foundation::execution::LaneRetention::LowFrequency,
        ),
    );
    let fleet_handle = FleetHandle::new(fleet_owner_handle);
    let security_owner = crate::security::SecurityOwner::new(crate::security::SecurityOwnerInput {
        state_dir: diagnostics_state_root.as_path().to_path_buf(),
        runtime_directory: Arc::clone(&runtime_directory),
    })
    .map_err(|_| ConstructionError::Security)?;
    let (security_owner_handle, security_task) = owner_runtime_system.spawn_owner(
        security_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            crate::security::SecurityOwner::lane_retention(),
        ),
    );
    let security_handle = crate::security::SecurityHandle::new(security_owner_handle);
    let channel_owner = ChannelOwner::new(ChannelOwnerInput {
        runtime_directory: Arc::clone(&runtime_directory),
    });
    let (channel_owner_handle, channel_task) = owner_runtime_system.spawn_owner(
        channel_owner,
        foundation::execution::OwnerRuntimeConfig::new(64, ChannelOwner::lane_retention()),
    );
    let channel_handle = ChannelHandle::new(channel_owner_handle);
    let channel_endpoint = RuntimeDriverIdentity::open_claw().endpoint();

    let connector_owner = ConnectorOwner::new(ConnectorOwnerInput {
        state_dir: diagnostics_state_root.clone(),
        runtime_directory: Arc::clone(&runtime_directory),
        runtime_host_mcp_executable,
        team_run_mcp_state_dir,
    })
    .map_err(|_| ConstructionError::ExternalConnectors)?;
    let (connector_owner_handle, connector_task) = owner_runtime_system.spawn_owner(
        connector_owner,
        foundation::execution::OwnerRuntimeConfig::new(64, ConnectorOwner::lane_retention()),
    );
    let connector_handle = ConnectorHandle::new(connector_owner_handle);

    let settings_state =
        environment::settings::DesiredState::open(diagnostics_state_root.as_path())
            .map_err(|_| ConstructionError::Settings)?;
    let settings_owner =
        crate::settings::actor::SettingsOwner::new(settings_state, Arc::clone(&runtime_directory));
    let (settings_owner_handle, settings_task) = owner_runtime_system.spawn_owner(
        settings_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            crate::settings::actor::SettingsOwner::lane_retention(),
        ),
    );
    let settings_handle = crate::settings::SettingsHandle::new(settings_owner_handle);

    let provider_owner = crate::provider::actor::ProviderOwner::new(
        provider_cascade,
        crate::provider::accounts::ProviderAccountsOwner::new(
            crate::provider::auth::Resolver::disabled(),
        ),
        crate::provider::models::ProviderModelOwner::with_openclaw(Arc::clone(&open_claw)),
        crate::provider::routing::ProviderRoutingOwner::new(),
        Arc::clone(&runtime_directory),
    );
    let (provider_owner_handle, provider_task) = owner_runtime_system.spawn_owner(
        provider_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            crate::provider::actor::ProviderOwner::lane_retention(),
        ),
    );
    let provider_handle = ProviderHandle::new(provider_owner_handle);

    let (session_owner, _session_snapshot) = crate::sessions::actor::SessionOwner::new(
        Arc::clone(&runtime_directory),
        provider_handle.clone(),
        session_delta,
    );
    let (session_owner_handle, session_task) = owner_runtime_system.spawn_owner(
        session_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            crate::sessions::actor::SessionOwner::lane_retention(),
        ),
    );
    let session_handle = SessionHandle::new(session_owner_handle, Arc::clone(&runtime_directory));

    let organization_owner =
        crate::organization::OrganizationOwner::new(crate::organization::OrganizationOwnerInput {
            store: organization_store,
            runtime_directory: Arc::clone(&runtime_directory),
            team_skill_selections,
        });
    let (organization_owner_handle, organization_task) = owner_runtime_system.spawn_owner(
        organization_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            256,
            crate::organization::OrganizationOwner::lane_retention(),
        ),
    );
    let organization_handle =
        crate::organization::OrganizationHandle::new(organization_owner_handle);
    let (team_run_coordinator, team_run_coordinator_handle) =
        crate::organization::TeamRunCoordinator::spawn(
            crate::organization::TeamRunCoordinatorInput {
                admission: Arc::clone(&admission),
                organization: organization_handle.clone(),
                runtime_directory: Arc::clone(&runtime_directory),
                admission_changes: admission.subscribe(),
                observation: runtime_observation.sink(),
            },
        );

    let peer_startup = super::super::peer::PeerStartupState::new();
    let peer_owner = super::super::peer::PeerOwner::new(
        Arc::clone(&admission),
        matcha_startup_diagnostics.clone(),
        Arc::clone(&open_claw),
        openclaw_startup_diagnostics.clone(),
        provider_handle.clone(),
        settings_handle.clone(),
        security_handle.clone(),
        team_run_coordinator_handle.clone(),
        Arc::clone(&runtime_directory),
        open_claw_runtime,
        peer_startup.clone(),
    );
    let (peer_owner_handle, peer_task) = owner_runtime_system.spawn_owner(
        peer_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            super::super::peer::PeerOwner::lane_retention(),
        ),
    );
    let peer_handle = super::super::peer::PeerHandle::new(peer_owner_handle);

    Ok(RuntimeOwners {
        tasks: OwnerRuntimeTasks {
            system: owner_runtime_system,
            peer: peer_task,
            security: security_task,
            channel: channel_task,
            fleet: fleet_task,
            connector: connector_task,
            settings: settings_task,
            provider: provider_task,
            session: session_task,
            organization: OrganizationRuntime {
                owner: organization_task,
                coordinator: team_run_coordinator,
            },
        },
        runtime_directory,
        peer_startup,
        peer_handle,
        session_handle,
        provider_handle,
        settings_handle,
        connector_handle,
        security_handle,
        channel_handle,
        fleet_handle,
        fleet_startup_dispatches,
        organization_handle,
        channel_endpoint,
    })
}
