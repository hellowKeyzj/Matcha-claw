use std::{fs, path::Path, path::PathBuf, sync::Arc};

use platform::state_dir::CanonicalStateDir;

use super::runtime_roots;
use crate::composition::host::ConstructionError;

pub(in crate::composition::host) struct SealedResources {
    pub(in crate::composition::host) sealed_resource: sealed_resource::SealedResourceModule,
    pub(in crate::composition::host) fleet_private_root_path: PathBuf,
}

struct OpenClawSealedAgentRuntimeProjection {
    state_dir: CanonicalStateDir,
}

impl OpenClawSealedAgentRuntimeProjection {
    fn new(state_dir: CanonicalStateDir) -> Self {
        Self { state_dir }
    }
}

impl sealed_resource::SealedAgentRuntimeProjection for OpenClawSealedAgentRuntimeProjection {
    fn workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<PathBuf, sealed_resource::SealedResourceError> {
        let directory = openclaw::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone())
            .trusted_workspace_directory(session_key)
            .map_err(|_| sealed_resource::SealedResourceError::Unknown)?;
        let path = PathBuf::from(directory.as_str());
        path.is_absolute()
            .then_some(path)
            .ok_or(sealed_resource::SealedResourceError::Rejected)
    }

    fn maintenance_workspace_directories(
        &self,
    ) -> Result<Vec<PathBuf>, sealed_resource::SealedResourceError> {
        openclaw::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone())
            .maintenance_workspace_directories()
            .map(|directories| {
                directories
                    .into_iter()
                    .map(|directory| PathBuf::from(directory.as_str()))
                    .collect()
            })
            .map_err(|_| sealed_resource::SealedResourceError::Unknown)
    }

    fn ensure_agent_entry(
        &self,
        agent_key: &str,
        workspace: &Path,
    ) -> Result<(), sealed_resource::SealedResourceError> {
        openclaw::agents::ensure_sealed_agent_config(self.state_dir.clone(), agent_key, workspace)
            .map_err(|error| match error {
                openclaw::agents::SealedAgentConfigError::Rejected => {
                    sealed_resource::SealedResourceError::Rejected
                }
                openclaw::agents::SealedAgentConfigError::Unavailable => {
                    sealed_resource::SealedResourceError::Unknown
                }
            })
    }
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
        Arc::new(OpenClawSealedAgentRuntimeProjection::new(
            diagnostics_state_root.clone(),
        )),
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
