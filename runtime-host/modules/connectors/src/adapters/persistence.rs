use std::{fs, fs::File, io, path::Path};

pub(crate) trait ConnectorStorePersistence: Send + Sync {
    fn sync_data(&self, file: &File) -> io::Result<()>;
    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()>;
}

#[derive(Default)]
pub(crate) struct StdConnectorStorePersistence;

impl ConnectorStorePersistence for StdConnectorStorePersistence {
    fn sync_data(&self, file: &File) -> io::Result<()> {
        file.sync_data()
    }

    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()> {
        fs::rename(source, destination)
    }
}
