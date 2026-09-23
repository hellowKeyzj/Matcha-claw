use std::path::{Path, PathBuf};

use crate::composition::host::ConstructionError;

#[cfg(test)]
#[path = "runtime_roots_tests.rs"]
mod tests;

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
