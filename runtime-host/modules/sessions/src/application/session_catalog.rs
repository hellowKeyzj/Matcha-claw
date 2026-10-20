use platform::endpoint::runtime_address::RuntimeEndpoint;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCatalogCommand {
    endpoint: RuntimeEndpoint,
}

impl SessionCatalogCommand {
    pub fn new(endpoint: RuntimeEndpoint) -> Self {
        Self { endpoint }
    }

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCatalog {
    pub sessions: Vec<SessionCatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCatalogEntry {
    pub endpoint: RuntimeEndpoint,
    pub key: String,
    pub agent_id: String,
    pub endpoint_session_id: String,
    pub ownership: Option<crate::state::SessionSourceBinding>,
    pub label: Option<String>,
    pub display_name: Option<String>,
    pub model_state: Option<crate::state::SessionModelState>,
    pub updated_at: Option<u64>,
    pub preferred: Option<bool>,
    pub protocol_id: Option<String>,
    pub runtime_endpoint_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionCatalogOutcome {
    Listed(SessionCatalog),
    Unavailable,
}
