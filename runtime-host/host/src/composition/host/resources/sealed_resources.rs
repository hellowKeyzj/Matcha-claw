use std::{fs, path::Path, path::PathBuf, sync::Arc};

use openclaw::lifecycle::state_dir::CanonicalStateDir;

use super::runtime_roots;
use crate::composition::host::ConstructionError;

pub(in crate::composition::host) struct SealedResources {
    pub(in crate::composition::host) sealed_resource: sealed_resource::SealedResourceModule,
    pub(in crate::composition::host) fleet_private_root_path: PathBuf,
}

pub(in crate::composition::host) fn provision_sealed_resources(
    runtime_state_dir: &Path,
    diagnostics_state_root: &CanonicalStateDir,
    sealed_runtime_token: Option<Arc<str>>,
) -> Result<SealedResources, ConstructionError> {
    fs::create_dir_all(runtime_state_dir).map_err(|_| ConstructionError::RuntimeState)?;
    let runtime_local_root = runtime_roots::runtime_local_root(runtime_state_dir)?;
    let sealed_resource = sealed_resource::SealedResourceModule::openclaw(
        diagnostics_state_root.clone(),
        runtime_local_root
            .join("runtime-local")
            .join("sealed-skills"),
        runtime_local_root
            .join("runtime-local")
            .join("sealed-agents"),
        sealed_runtime_token,
    )
    .map_err(|error| match error {
        sealed_resource::SealedResourceProvisionError::Skills => ConstructionError::SealedSkills,
        sealed_resource::SealedResourceProvisionError::Agents => ConstructionError::SealedAgents,
    })?;
    let fleet_private_root_path = runtime_roots::fleet_private_root_path(runtime_state_dir);

    Ok(SealedResources {
        sealed_resource,
        fleet_private_root_path,
    })
}
