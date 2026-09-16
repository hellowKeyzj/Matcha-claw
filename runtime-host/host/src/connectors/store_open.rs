use environment::{ConnectorStore, ConnectorStoreError};
use openclaw::lifecycle::state_dir::CanonicalStateDir;

pub(super) fn open(state_dir: &CanonicalStateDir) -> Result<ConnectorStore, ConnectorStoreError> {
    ConnectorStore::open(path(state_dir))
}

fn path(state_dir: &CanonicalStateDir) -> std::path::PathBuf {
    state_dir
        .as_path()
        .join("external-connectors")
        .join("connectors.json")
}
