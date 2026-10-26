use std::{path::Path, sync::Arc};

use platform::state_dir::{CanonicalStateDir, StateDirHandle};
use sha2::{Digest as _, Sha256};
use world::{LocatorFuture, LocatorRecord, StoreError, WorldLocator};
use world_protocol::ids::WorldRef;

const RECORD_LIMIT: usize = 16 * 1024;

pub(crate) struct DurableWorldLocator {
    directory: CanonicalStateDir,
    storage: Arc<super::world_storage::DurableWorldStorage>,
    access: tokio::sync::Mutex<()>,
}

impl DurableWorldLocator {
    pub(crate) fn open(
        runtime_state_dir: &Path,
        storage: Arc<super::world_storage::DurableWorldStorage>,
    ) -> Result<Arc<dyn WorldLocator>, StoreError> {
        let directory =
            CanonicalStateDir::provision_private(runtime_state_dir.join("world-locators"))
                .map_err(StoreError::locator_failed)?;
        Ok(Arc::new(Self { directory, storage, access: tokio::sync::Mutex::new(()) }))
    }

    fn name(world: &WorldRef) -> Result<String, StoreError> {
        let identity = serde_json::to_vec(world).map_err(StoreError::locator_failed)?;
        Ok(format!("{:x}", Sha256::digest(identity)))
    }

    fn read_record(
        handle: &StateDirHandle,
        name: &str,
        world: &WorldRef,
    ) -> Result<Option<LocatorRecord>, StoreError> {
        let bytes = handle
            .read_regular_file_bounded(name, RECORD_LIMIT)
            .map_err(StoreError::locator_failed)?;
        bytes
            .map(|bytes| {
                let record: LocatorRecord =
                    serde_json::from_slice(&bytes).map_err(StoreError::locator_failed)?;
                if &record.world != world {
                    return Err(StoreError::locator_conflict());
                }
                Ok(record)
            })
            .transpose()
    }
}

impl WorldLocator for DurableWorldLocator {
    fn read<'a>(&'a self, world: &'a WorldRef) -> LocatorFuture<'a, Option<LocatorRecord>> {
        Box::pin(async move {
            let _access = self.access.lock().await;
            let name = Self::name(world)?;
            let handle = self.directory.open().map_err(StoreError::locator_failed)?;
            let _lock = handle
                .lock_regular_file(&format!("{name}.lock"))
                .map_err(StoreError::locator_failed)?;
            Self::read_record(&handle, &format!("{name}.json"), world)
        })
    }

    fn compare_and_set<'a>(
        &'a self,
        expected: Option<&'a LocatorRecord>,
        replacement: &'a LocatorRecord,
    ) -> LocatorFuture<'a, LocatorRecord> {
        Box::pin(async move {
            let _access = self.access.lock().await;
            if expected.is_some_and(|record| record.world != replacement.world) {
                return Err(StoreError::locator_conflict());
            }
            self.storage.registered(&replacement.storage_id)?;
            let name = Self::name(&replacement.world)?;
            let handle = self.directory.open().map_err(StoreError::locator_failed)?;
            let _lock = handle
                .lock_regular_file(&format!("{name}.lock"))
                .map_err(StoreError::locator_failed)?;
            let filename = format!("{name}.json");
            let current = Self::read_record(&handle, &filename, &replacement.world)?;
            if current.as_ref() != expected {
                return Err(StoreError::locator_conflict());
            }
            let bytes = serde_json::to_vec(replacement).map_err(StoreError::locator_failed)?;
            // Equal records are written too: readback alone cannot settle an earlier unknown flush.
            handle
                .replace_regular_file_bounded_detailed(&filename, &bytes, RECORD_LIMIT)
                .map_err(
                    |cause| match (&replacement.transfer_id, cause.commit_unknown()) {
                        (Some(transfer), true) => {
                            StoreError::locator_indeterminate(transfer.clone(), cause)
                        }
                        _ => StoreError::locator_failed(cause),
                    },
                )?;
            let persisted = Self::read_record(&handle, &filename, &replacement.world)?;
            if persisted.as_ref() != Some(replacement) {
                return Err(StoreError::locator_conflict());
            }
            Ok(replacement.clone())
        })
    }
}
