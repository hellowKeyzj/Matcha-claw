use std::{path::Path, sync::Arc};

use platform::state_dir::{CanonicalStateDir, StateDirHandle};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest as _, Sha256};
use world::{
    AuthorityRoot, StorageIdentity, StorageIdentityReceipt, StoreConfiguration, StoreError,
    WorldStorage,
};
use zeroize::Zeroizing;

use super::super::WorldPostgresConfig;

const RECORD_LIMIT: usize = 64 * 1024;

/// Private durable connection configuration, not a world fact or public registry.
pub(crate) struct DurableWorldStorage {
    directory: CanonicalStateDir,
    authority: Arc<AuthorityRoot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    storage_id: String,
    configuration_token: String,
    initialize: bool,
    #[serde(deserialize_with = "secret")]
    connection_string: Zeroizing<String>,
}

fn secret<'de, D: Deserializer<'de>>(decoder: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(decoder).map(Zeroizing::new)
}

impl DurableWorldStorage {
    pub(crate) fn open(
        root: &Path,
        authority: Arc<AuthorityRoot>,
    ) -> Result<Arc<Self>, StoreError> {
        let directory = CanonicalStateDir::provision_private(root.join("world-storage"))
            .map_err(StoreError::locator_failed)?;
        Ok(Arc::new(Self {
            directory,
            authority,
        }))
    }

    pub(crate) fn validate_storage_id(storage_id: &str) -> Result<(), StoreError> {
        if storage_id.is_empty()
            || storage_id.len() > 256
            || !storage_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(StoreError::locator_conflict());
        }
        Ok(())
    }

    fn name(storage_id: &str) -> Result<String, StoreError> {
        Self::validate_storage_id(storage_id)?;
        Ok(format!("{:x}", Sha256::digest(storage_id.as_bytes())))
    }

    fn read(
        handle: &StateDirHandle,
        name: &str,
        storage_id: &str,
    ) -> Result<Option<Record>, StoreError> {
        let bytes = handle
            .read_regular_file_bounded(name, RECORD_LIMIT)
            .map_err(StoreError::locator_failed)?
            .map(Zeroizing::new);
        bytes
            .map(|bytes| {
                let record: Record =
                    serde_json::from_slice(&bytes).map_err(StoreError::locator_failed)?;
                if record.storage_id != storage_id || record.configuration_token.is_empty() {
                    return Err(StoreError::locator_conflict());
                }
                Ok(record)
            })
            .transpose()
    }

    fn synchronize(handle: &StateDirHandle, name: &str, record: &Record) -> Result<(), StoreError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            storage_id: &'a str,
            configuration_token: &'a str,
            initialize: bool,
            connection_string: &'a str,
        }
        let bytes = Zeroizing::new(
            serde_json::to_vec(&Wire {
                storage_id: &record.storage_id,
                configuration_token: &record.configuration_token,
                initialize: record.initialize,
                connection_string: &record.connection_string,
            })
            .map_err(StoreError::locator_failed)?,
        );
        handle
            .replace_regular_file_bounded_detailed(name, &bytes, RECORD_LIMIT)
            .map_err(StoreError::locator_failed)?;
        let persisted = Self::read(handle, name, &record.storage_id)?
            .ok_or_else(StoreError::locator_conflict)?;
        if persisted.configuration_token != record.configuration_token
            || persisted.initialize != record.initialize
            || persisted.connection_string.as_str() != record.connection_string.as_str()
        {
            return Err(StoreError::locator_conflict());
        }
        Ok(())
    }

    /// Persist initialization intent before connecting. Only a verified receipt can accept it.
    pub(crate) fn stage(
        &self,
        root: &Arc<AuthorityRoot>,
        input: WorldPostgresConfig,
    ) -> Result<(), StoreError> {
        self.stage_intent(root, input, true)
    }

    pub(crate) fn stage_existing(&self, root: &Arc<AuthorityRoot>, input: WorldPostgresConfig) -> Result<(), StoreError> {
        self.stage_intent(root, input, false)
    }

    fn stage_intent(&self, root: &Arc<AuthorityRoot>, input: WorldPostgresConfig, initialize: bool) -> Result<(), StoreError> {
        if !Arc::ptr_eq(root, &self.authority) {
            return Err(StoreError::locator_conflict());
        }
        let name = Self::name(input.storage_id())?;
        input
            .connection_string()
            .parse::<tokio_postgres::Config>()
            .map_err(StoreError::connection_failed)?;
        let handle = self.directory.open().map_err(StoreError::locator_failed)?;
        let _lock = handle
            .lock_regular_file(&format!("{name}.lock"))
            .map_err(StoreError::locator_failed)?;
        let accepted = Self::read(&handle, &format!("{name}.json"), input.storage_id())?;
        let pending_name = format!("{name}.pending.json");
        if let Some(record) = &accepted {
            if record.connection_string.as_str() == input.connection_string() {
                Self::synchronize(&handle, &pending_name, record)?;
                return Ok(());
            }
        }
        if accepted.is_none() {
            if let Some(mut pending) = Self::read(&handle, &pending_name, input.storage_id())? {
                // This compares the frozen attempt, never determines database identity.
                if pending.connection_string.as_str() != input.connection_string() {
                    return Err(StoreError::locator_conflict());
                }
                pending.initialize = initialize;
                Self::synchronize(&handle, &pending_name, &pending)?;
                return Ok(());
            }
        }
        let record = Record {
            storage_id: input.storage_id().to_owned(),
            configuration_token: uuid::Uuid::new_v4().to_string(),
            initialize: initialize && accepted.is_none(),
            connection_string: Zeroizing::new(input.connection_string().to_owned()),
        };
        Self::synchronize(&handle, &pending_name, &record)?;
        Ok(())
    }

    /// CAS only consumes accepted, flushed configuration, never a pending credential update.
    pub(crate) fn registered(&self, storage_id: &str) -> Result<(), StoreError> {
        let name = Self::name(storage_id)?;
        let handle = self.directory.open().map_err(StoreError::locator_failed)?;
        let _lock = handle
            .lock_regular_file(&format!("{name}.lock"))
            .map_err(StoreError::locator_failed)?;
        let filename = format!("{name}.json");
        let record =
            Self::read(&handle, &filename, storage_id)?.ok_or_else(StoreError::locator_conflict)?;
        Self::synchronize(&handle, &filename, &record)
    }
}

impl WorldStorage for DurableWorldStorage {
    fn configuration(&self, storage_id: &str) -> Result<StoreConfiguration, StoreError> {
        let name = Self::name(storage_id)?;
        let handle = self.directory.open().map_err(StoreError::locator_failed)?;
        let _lock = handle
            .lock_regular_file(&format!("{name}.lock"))
            .map_err(StoreError::locator_failed)?;
        let pending_name = format!("{name}.pending.json");
        let (filename, record) = match Self::read(&handle, &pending_name, storage_id)? {
            Some(record) => (pending_name, record),
            None => {
                let filename = format!("{name}.json");
                let record = Self::read(&handle, &filename, storage_id)?
                    .ok_or_else(StoreError::locator_conflict)?;
                (filename, record)
            }
        };
        Self::synchronize(&handle, &filename, &record)?;
        let accepted = Self::read(&handle, &format!("{name}.json"), storage_id)?;
        let identity = if record.initialize && accepted.is_none() {
            StorageIdentity::Initialize {
                storage_id: record.storage_id.clone(),
                configuration_token: record.configuration_token.clone(),
            }
        } else {
            StorageIdentity::Existing {
                storage_id: record.storage_id.clone(),
                configuration_token: record.configuration_token.clone(),
            }
        };
        super::postgres::configuration(
            WorldPostgresConfig::new(
                record.storage_id,
                record.connection_string.as_str().to_owned(),
            ),
            identity,
        )
    }

    fn accept(&self, receipt: StorageIdentityReceipt) -> Result<(), StoreError> {
        let name = Self::name(receipt.storage_id())?;
        let handle = self.directory.open().map_err(StoreError::locator_failed)?;
        let _lock = handle
            .lock_regular_file(&format!("{name}.lock"))
            .map_err(StoreError::locator_failed)?;
        let pending = Self::read(
            &handle,
            &format!("{name}.pending.json"),
            receipt.storage_id(),
        )?;
        let record = match pending {
            Some(record) if record.configuration_token == receipt.configuration_token() => record,
            Some(_) => return Err(StoreError::locator_conflict()),
            None => Self::read(&handle, &format!("{name}.json"), receipt.storage_id())?
                .filter(|record| record.configuration_token == receipt.configuration_token())
                .ok_or_else(StoreError::locator_conflict)?,
        };
        Self::synchronize(
            &handle,
            &format!("{name}.json"),
            &Record {
                initialize: false,
                ..record
            },
        )
    }
}
