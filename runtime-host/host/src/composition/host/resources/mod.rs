mod clawhub_registry;
mod diagnostics;
mod native_toolchain;
mod organization;
mod provider_migration;
mod runtime_roots;
mod sealed_resources;

pub(in crate::composition::host) use clawhub_registry::provision_clawhub_registry;
pub(in crate::composition::host) use diagnostics::{
    RuntimeDiagnostics, prepare_runtime_diagnostics, provision_diagnostics_archive,
};
pub(in crate::composition::host) use native_toolchain::provision_native_toolchain;
pub(in crate::composition::host) use organization::{
    OrganizationOwnerProvision, provision_organization_owner,
};
pub(in crate::composition::host) use provider_migration::provision_provider_cascade;
#[cfg(all(test, windows))]
pub(in crate::composition::host) use runtime_roots::provision_private_directory;
pub(in crate::composition::host) use runtime_roots::{
    fleet_private_root_path, openclaw_runtime_roots, provision_fleet_private_root,
    runtime_local_root,
};
pub(in crate::composition::host) use sealed_resources::{
    SealedResources, provision_sealed_resources,
};
