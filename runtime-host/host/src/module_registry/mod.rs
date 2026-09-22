pub(crate) type CapabilityVerifier =
    std::sync::Arc<tokio::sync::Mutex<platform::capability::CapabilityDecisionVerifier>>;

pub(crate) mod capability_catalog;
pub(crate) mod effects;
pub(crate) mod install;
pub(crate) mod private_control;
pub(crate) mod routes;
pub(crate) mod runtime_modules;
pub(crate) mod system_modules;
