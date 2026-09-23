use matcha_agent::{driver::MatchaAgentInput, lifecycle::secret::Secret};
use openclaw::{driver::OpenClawInput, gateway::auth::GatewaySecret};
use organization::OrganizationStore;

pub struct HostInput {
    pub matcha: MatchaAgentInput,
    pub matcha_secret: Secret,
    pub open_claw: OpenClawInput,
    pub open_claw_secret: GatewaySecret,
    pub organization_store: OrganizationStore,
    pub runtime_state_dir: std::path::PathBuf,
    /// The desktop shell's own log directory, collected by the diagnostics archive.
    pub app_log_dir: std::path::PathBuf,
    pub parent_callback_base_url: String,
    pub parent_callback_dispatch_token: String,
    pub runtime_observation: ::diagnostics::RuntimeObservationConfig,
}
