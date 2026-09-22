use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use openclaw::lifecycle::state_dir::CanonicalStateDir;

use crate::composition::host::ConstructionError;

#[cfg(test)]
#[path = "runtime_roots_tests.rs"]
mod tests;

pub(in crate::composition::host) struct OpenClawRuntimeRoots {
    pub(in crate::composition::host) diagnostics_state_root: CanonicalStateDir,
    pub(in crate::composition::host) runtime_host_mcp_executable: PathBuf,
    pub(in crate::composition::host) team_run_mcp_state_dir: PathBuf,
    pub(in crate::composition::host) sealed_runtime_token: Option<Arc<str>>,
}

pub(in crate::composition::host) fn openclaw_runtime_roots(
    open_claw: &openclaw::driver::OpenClawInput,
) -> OpenClawRuntimeRoots {
    OpenClawRuntimeRoots {
        diagnostics_state_root: open_claw.state_dir.clone(),
        runtime_host_mcp_executable: open_claw.team_run_mcp_executable.clone(),
        team_run_mcp_state_dir: open_claw.team_run_mcp_state_dir.clone(),
        sealed_runtime_token: open_claw.sealed_token.clone().map(Arc::<str>::from),
    }
}

pub(in crate::composition::host) fn runtime_local_root(
    runtime_state_dir: &Path,
) -> Result<PathBuf, ConstructionError> {
    runtime_state_dir
        .parent()
        .map(Path::to_path_buf)
        .ok_or(ConstructionError::SealedSkills)
}

pub(in crate::composition::host) fn fleet_private_root_path(runtime_state_dir: &Path) -> PathBuf {
    runtime_state_dir.join("fleet-private")
}

pub(in crate::composition::host) fn provision_fleet_private_root(
    path: PathBuf,
) -> Result<PathBuf, ConstructionError> {
    provision_private_directory(&path).map_err(|_| ConstructionError::Fleet)?;
    Ok(path)
}

pub(in crate::composition::host) fn provision_private_directory(
    path: &Path,
) -> Result<(), foundation::storage::PrivateStorageError> {
    foundation::storage::provision_private_directory(path)
}
