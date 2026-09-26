use platform::module::{CapabilityKey, ModuleDescriptor};

use super::{CapabilityVerifier, capability_catalog::CapabilityCatalog, private_control};

const INSTALL_PLAN_HOST_CAPABILITIES: &[CapabilityKey] = &[
    CapabilityKey::new("runtime.channels"),
    CapabilityKey::new("runtime.security"),
    CapabilityKey::new("runtime.settings"),
    CapabilityKey::new("runtime.connectors"),
    CapabilityKey::new("runtime.provider"),
    CapabilityKey::new("runtime.sessions"),
    CapabilityKey::new("runtime.fleet"),
    CapabilityKey::new("runtime.plugins"),
    CapabilityKey::new("runtime.skills"),
    CapabilityKey::new("external.clawhub"),
    CapabilityKey::new("runtime.cron"),
    CapabilityKey::new("runtime.usage"),
    CapabilityKey::new("runtime.diagnostics"),
    CapabilityKey::new("runtime.task-manager"),
    CapabilityKey::new("runtime.subagents"),
    CapabilityKey::new("runtime.workspace"),
    CapabilityKey::new("runtime.wiki"),
    CapabilityKey::new("runtime.platform-tools"),
    CapabilityKey::new("external.toolchain.native"),
    CapabilityKey::new("host.observation"),
];

pub(crate) fn install_plan_capabilities() -> &'static [CapabilityKey] {
    INSTALL_PLAN_HOST_CAPABILITIES
}

pub(crate) fn system_module_install_plan(
    verifier: CapabilityVerifier,
    capability_catalog: CapabilityCatalog,
) -> (ModuleDescriptor, ModuleDescriptor) {
    (
        capability_catalog.descriptor(verifier),
        private_control::descriptor(),
    )
}
