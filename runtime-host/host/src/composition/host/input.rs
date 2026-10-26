use matcha_agent::{driver::MatchaAgentInput, lifecycle::secret::Secret};
use openclaw::{driver::OpenClawInput, gateway::auth::GatewaySecret};
use organization::OrganizationStore;

/// Private bootstrap input; never part of Host state, events, or public serialization.
pub struct WorldPostgresConfig {
    storage_id: String,
    connection_string: zeroize::Zeroizing<String>,
}

impl WorldPostgresConfig {
    pub fn new(storage_id: String, connection_string: String) -> Self {
        Self {
            storage_id,
            connection_string: zeroize::Zeroizing::new(connection_string),
        }
    }

    pub(super) fn storage_id(&self) -> &str {
        &self.storage_id
    }

    pub(super) fn connection_string(&self) -> &str {
        &self.connection_string
    }
}

pub use super::ports::world_sources::WorldSourceAccessConfig;

pub struct HostInput {
    pub matcha: MatchaAgentInput,
    pub matcha_secret: Secret,
    pub open_claw: OpenClawInput,
    pub open_claw_secret: GatewaySecret,
    pub organization_store: OrganizationStore,
    pub runtime_state_dir: std::path::PathBuf,
    pub world_postgres: Option<WorldPostgresConfig>,
    pub world_storage_targets: Vec<WorldPostgresConfig>,
    pub world_source_access: Option<WorldSourceAccessConfig>,
    /// Explicit trusted provisioning input; never accepted from a World request.
    pub initial_world: Option<world::Provision>,
    /// Trusted bootstrap peer route, never accepted from a World request.
    pub world_peer_endpoint: Option<String>,
    pub searxng_resources_dir: std::path::PathBuf,
    /// The desktop shell's own log directory, collected by the diagnostics archive.
    pub app_log_dir: std::path::PathBuf,
    pub parent_callback_base_url: String,
    pub parent_callback_dispatch_token: String,
    pub runtime_observation: ::diagnostics::RuntimeObservationConfig,
}
