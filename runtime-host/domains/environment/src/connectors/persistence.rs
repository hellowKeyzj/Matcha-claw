use std::{fs::File, io, path::Path};

use crate::persistence;

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
        persistence::replace_file(source, destination)
    }
}
