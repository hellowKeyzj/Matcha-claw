use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use crate::{
    ProviderAccountId, ProviderModel, ProviderModelCapability, ProviderModelCatalog,
    ProviderModelCatalogFault,
};

const STORE_VERSION: u8 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;

/// Durable owner for the non-secret ProviderModel desired catalog.
pub struct ProviderModelStore {
    path: PathBuf,
    lock_path: PathBuf,
    catalog: ProviderModelCatalog,
    requires_reopen: bool,
}

impl ProviderModelStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ProviderModelStoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        remove_stale_temporary(&path)?;
        let catalog = recover(&path)?;
        Ok(Self {
            catalog,
            path,
            lock_path,
            requires_reopen: false,
        })
    }

    pub fn catalog(&self) -> &ProviderModelCatalog {
        &self.catalog
    }

    /// Refreshes this read model after a related Host-owned provider mutation.
    pub fn reload(&mut self) -> Result<(), ProviderModelStoreFault> {
        let _lock = WriterLock::acquire(&self.lock_path)?;
        self.catalog = recover(&self.path)?;
        self.requires_reopen = false;
        Ok(())
    }

    pub fn replace(
        &mut self,
        account_id: &ProviderAccountId,
        models: Vec<ProviderModel>,
    ) -> Result<&ProviderModelCatalog, ProviderModelStoreFault> {
        if self.requires_reopen {
            return Err(ProviderModelStoreFault::RecoveryRequired);
        }
        let _lock = WriterLock::acquire(&self.lock_path)?;
        self.catalog = recover(&self.path)?;
        let mut next = self.catalog.clone();
        next.replace(account_id, models)?;
        self.persist(&next)?;
        self.catalog = next;
        Ok(&self.catalog)
    }

    fn persist(&mut self, catalog: &ProviderModelCatalog) -> Result<(), ProviderModelStoreFault> {
        let bytes = serde_json::to_vec(&ProviderModelStoreDocument::from_catalog(catalog))
            .map_err(|_| ProviderModelStoreFault::Encode)?;
        if bytes.len() > MAX_STORE_BYTES as usize {
            return Err(ProviderModelStoreFault::RecordTooLarge);
        }
        let temporary = temporary_path(&self.path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| ProviderModelStoreFault::Commit(error.kind()))?;
        use std::io::Write;
        if let Err(error) = file.write_all(&bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(ProviderModelStoreFault::Commit(error.kind()));
        }
        if let Err(error) = file.sync_data() {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ProviderModelStoreFault::CommitOutcomeUnknown(error.kind()));
        }
        drop(file);
        if let Err(error) = crate::persistence::replace_file(&temporary, &self.path) {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ProviderModelStoreFault::CommitOutcomeUnknown(error.kind()));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderModelStoreFault {
    Catalog(ProviderModelCatalogFault),
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
    Decode,
    Encode,
    RecordTooLarge,
    RecoveryRequired,
    WriterBusy,
}

impl From<ProviderModelCatalogFault> for ProviderModelStoreFault {
    fn from(value: ProviderModelCatalogFault) -> Self {
        Self::Catalog(value)
    }
}

impl std::fmt::Display for ProviderModelStoreFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Catalog(error) => return error.fmt(formatter),
            Self::Commit(_) => "provider model facts could not be committed",
            Self::CommitOutcomeUnknown(_) => {
                "provider model commit outcome is unknown; reopen before retrying"
            }
            Self::Decode => "provider model facts are invalid",
            Self::Encode => "provider model facts could not be encoded",
            Self::RecordTooLarge => "provider model facts exceed the durable limit",
            Self::RecoveryRequired => {
                "provider model facts require reopening before another mutation"
            }
            Self::WriterBusy => "provider model facts writer is busy",
        })
    }
}

impl std::error::Error for ProviderModelStoreFault {}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderModelStoreDocument {
    version: u8,
    models: Vec<ProviderModelDocument>,
}

impl ProviderModelStoreDocument {
    fn from_catalog(catalog: &ProviderModelCatalog) -> Self {
        Self {
            version: STORE_VERSION,
            models: catalog
                .models()
                .iter()
                .map(ProviderModelDocument::from)
                .collect(),
        }
    }

    fn into_catalog(self) -> Result<ProviderModelCatalog, ProviderModelStoreFault> {
        if self.version != STORE_VERSION {
            return Err(ProviderModelStoreFault::Decode);
        }
        ProviderModelCatalog::try_new(
            self.models
                .into_iter()
                .map(ProviderModelDocument::into_model)
                .collect::<Result<_, _>>()?,
        )
        .map_err(Into::into)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderModelDocument {
    account_id: String,
    model_id: String,
    capabilities: Vec<ProviderModelCapabilityDocument>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    timeout_ms: Option<u64>,
    aspect_ratio: Option<String>,
    resolution: Option<String>,
    quality: Option<String>,
}

impl From<&ProviderModel> for ProviderModelDocument {
    fn from(model: &ProviderModel) -> Self {
        Self {
            account_id: model.account_id().as_str().to_owned(),
            model_id: model.model_id().to_owned(),
            capabilities: model
                .capabilities()
                .iter()
                .copied()
                .map(Into::into)
                .collect(),
            context_window: model.context_window(),
            max_tokens: model.max_tokens(),
            timeout_ms: model.timeout_ms(),
            aspect_ratio: model.aspect_ratio().map(str::to_owned),
            resolution: model.resolution().map(str::to_owned),
            quality: model.quality().map(str::to_owned),
        }
    }
}

impl ProviderModelDocument {
    fn into_model(self) -> Result<ProviderModel, ProviderModelStoreFault> {
        ProviderModel::try_new(
            ProviderAccountId::try_new(self.account_id)
                .map_err(|_| ProviderModelStoreFault::Decode)?,
            self.model_id,
            self.capabilities.into_iter().map(Into::into).collect(),
            self.context_window,
            self.max_tokens,
            self.timeout_ms,
            self.aspect_ratio,
            self.resolution,
            self.quality,
        )
        .map_err(|_| ProviderModelStoreFault::Decode)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderModelCapabilityDocument {
    Chat,
    ImageUnderstand,
    ImageGenerate,
    VideoGenerate,
    MusicGenerate,
    TextToSpeech,
    Transcribe,
}

impl From<ProviderModelCapability> for ProviderModelCapabilityDocument {
    fn from(value: ProviderModelCapability) -> Self {
        match value {
            ProviderModelCapability::Chat => Self::Chat,
            ProviderModelCapability::ImageUnderstand => Self::ImageUnderstand,
            ProviderModelCapability::ImageGenerate => Self::ImageGenerate,
            ProviderModelCapability::VideoGenerate => Self::VideoGenerate,
            ProviderModelCapability::MusicGenerate => Self::MusicGenerate,
            ProviderModelCapability::TextToSpeech => Self::TextToSpeech,
            ProviderModelCapability::Transcribe => Self::Transcribe,
        }
    }
}

impl From<ProviderModelCapabilityDocument> for ProviderModelCapability {
    fn from(value: ProviderModelCapabilityDocument) -> Self {
        match value {
            ProviderModelCapabilityDocument::Chat => Self::Chat,
            ProviderModelCapabilityDocument::ImageUnderstand => Self::ImageUnderstand,
            ProviderModelCapabilityDocument::ImageGenerate => Self::ImageGenerate,
            ProviderModelCapabilityDocument::VideoGenerate => Self::VideoGenerate,
            ProviderModelCapabilityDocument::MusicGenerate => Self::MusicGenerate,
            ProviderModelCapabilityDocument::TextToSpeech => Self::TextToSpeech,
            ProviderModelCapabilityDocument::Transcribe => Self::Transcribe,
        }
    }
}

fn recover(path: &Path) -> Result<ProviderModelCatalog, ProviderModelStoreFault> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_STORE_BYTES as usize => {
            serde_json::from_slice::<ProviderModelStoreDocument>(&bytes)
                .map_err(|_| ProviderModelStoreFault::Decode)?
                .into_catalog()
        }
        Ok(_) => Err(ProviderModelStoreFault::RecordTooLarge),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(ProviderModelCatalog::default())
        }
        Err(error) => Err(ProviderModelStoreFault::Commit(error.kind())),
    }
}

pub(crate) fn migration_bytes(
    catalog: &ProviderModelCatalog,
) -> Result<Vec<u8>, ProviderModelStoreFault> {
    let bytes = serde_json::to_vec(&ProviderModelStoreDocument::from_catalog(catalog))
        .map_err(|_| ProviderModelStoreFault::Encode)?;
    if bytes.len() > MAX_STORE_BYTES as usize {
        return Err(ProviderModelStoreFault::RecordTooLarge);
    }
    Ok(bytes)
}

fn ensure_parent_directory(path: &Path) -> Result<(), ProviderModelStoreFault> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|error| ProviderModelStoreFault::Commit(error.kind()))?;
    }
    Ok(())
}

fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    temporary.into()
}

fn remove_stale_temporary(path: &Path) -> Result<(), ProviderModelStoreFault> {
    match fs::remove_file(temporary_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ProviderModelStoreFault::Commit(error.kind())),
    }
}

struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, ProviderModelStoreFault> {
        match File::create_new(path) {
            Ok(file) => {
                drop(file);
                Ok(Self {
                    path: path.to_owned(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ProviderModelStoreFault::WriterBusy)
            }
            Err(error) => Err(ProviderModelStoreFault::Commit(error.kind())),
        }
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
#[path = "model_store_tests.rs"]
mod tests;
