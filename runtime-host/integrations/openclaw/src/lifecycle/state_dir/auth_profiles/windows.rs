#[path = "windows/directory.rs"]
mod directory;
#[path = "windows/file.rs"]
mod file;

use super::super::{AgentId, StateDirError};
use crate::lifecycle::state_dir::StateDirHandle;

pub(super) fn read(
    state_dir: &StateDirHandle,
    agent: &AgentId,
) -> Result<Option<Vec<u8>>, StateDirError> {
    let Some(directory) = directory::auth_directory(state_dir, agent, false)? else {
        return Ok(None);
    };
    file::read(&directory)
}

#[cfg(test)]
pub(super) fn replace(
    state_dir: &StateDirHandle,
    agent: &AgentId,
    contents: &[u8],
) -> Result<(), StateDirError> {
    let directory = directory::auth_directory(state_dir, agent, true)?.ok_or(StateDirError)?;
    file::replace(&directory, contents)
}
