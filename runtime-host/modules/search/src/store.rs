use std::path::Path;

use platform::state_dir::CanonicalStateDir;
use serde::{Deserialize, Serialize};

use crate::{SearchConfig, SearchError};

const STATE_FILE: &str = "config.v1.json";
const MAX_STATE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedConfig {
    pub revision: u64,
    pub applied_revision: Option<u64>,
    pub config: SearchConfig,
}

pub(crate) struct Store {
    directory: CanonicalStateDir,
    saved: SavedConfig,
    persisted: bool,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, SearchError> {
        let directory = CanonicalStateDir::provision(path).map_err(|_| SearchError::storage())?;
        let bytes = directory
            .read_regular_file_bounded(STATE_FILE, MAX_STATE_BYTES)
            .map_err(|_| SearchError::storage())?;
        let persisted = bytes.is_some();
        let saved = match bytes {
            Some(bytes) => {
                serde_json::from_slice::<SavedConfig>(&bytes).map_err(|_| SearchError::storage())?
            }
            None => SavedConfig::default(),
        };
        saved
            .config
            .validate()
            .map_err(|_| SearchError::storage())?;
        if saved.revision > 9_007_199_254_740_991
            || saved
                .applied_revision
                .is_some_and(|revision| revision > saved.revision)
        {
            return Err(SearchError::storage());
        }
        Ok(Self {
            directory,
            saved,
            persisted,
        })
    }

    pub fn saved(&self) -> &SavedConfig {
        &self.saved
    }

    pub fn is_persisted(&self) -> bool {
        self.persisted
    }

    pub fn replace(
        &mut self,
        expected_revision: u64,
        config: SearchConfig,
    ) -> Result<(), SearchError> {
        if expected_revision != self.saved.revision {
            return Err(SearchError::conflict());
        }
        let revision = self
            .saved
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= 9_007_199_254_740_991)
            .ok_or_else(SearchError::storage)?;
        self.commit(SavedConfig {
            revision,
            applied_revision: self.saved.applied_revision,
            config,
        })
    }

    pub fn applied(&mut self) -> Result<(), SearchError> {
        let mut candidate = self.saved.clone();
        candidate.applied_revision = Some(candidate.revision);
        if !self.persisted {
            // Lifecycle observation must not persist unexpanded defaults before the first save.
            self.saved = candidate;
            return Ok(());
        }
        self.commit(candidate)
    }

    fn commit(&mut self, candidate: SavedConfig) -> Result<(), SearchError> {
        let bytes = serde_json::to_vec(&candidate).map_err(|_| SearchError::storage())?;
        self.directory
            .replace_regular_file_bounded(STATE_FILE, &bytes, MAX_STATE_BYTES)
            .map_err(|_| SearchError::storage())?;
        self.saved = candidate;
        self.persisted = true;
        Ok(())
    }
}
