use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use crate::{
    ProviderAccountId, ProviderModelReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingRevision,
};

const STORE_VERSION: u8 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;

/// Durable owner for the non-secret desired provider routing.
pub struct ProviderRoutingStore {
    path: PathBuf,
    lock_path: PathBuf,
    routing: Option<ProviderRouting>,
    requires_reopen: bool,
}

impl ProviderRoutingStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ProviderRoutingStoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        remove_stale_temporary(&path)?;
        let routing = recover(&path)?;
        Ok(Self {
            routing,
            path,
            lock_path,
            requires_reopen: false,
        })
    }

    pub fn routing(&self) -> Option<&ProviderRouting> {
        self.routing.as_ref()
    }

    /// Refreshes this read model after a related Host-owned provider mutation.
    pub fn reload(&mut self) -> Result<(), ProviderRoutingStoreFault> {
        let _lock = WriterLock::acquire(&self.lock_path)?;
        let routing = recover(&self.path)?;
        self.routing = routing;
        self.requires_reopen = false;
        Ok(())
    }

    pub fn replace(
        &mut self,
        routing: ProviderRouting,
    ) -> Result<&ProviderRouting, ProviderRoutingStoreFault> {
        if self.requires_reopen {
            return Err(ProviderRoutingStoreFault::RecoveryRequired);
        }
        let _lock = WriterLock::acquire(&self.lock_path)?;
        let current_routing = recover(&self.path)?;
        self.routing = current_routing;
        if let Some(current) = &self.routing {
            if routing.revision() < current.revision() {
                return Err(ProviderRoutingStoreFault::StaleRevision);
            }
            if routing.revision() == current.revision() {
                if &routing != current {
                    return Err(ProviderRoutingStoreFault::RevisionConflict);
                }
                return Ok(self
                    .routing()
                    .expect("existing provider routing remains addressable"));
            }
            if current.revision().get().checked_add(1) != Some(routing.revision().get()) {
                return Err(ProviderRoutingStoreFault::RevisionMustFollowCurrent);
            }
        } else if routing.revision().get() != 1 {
            return Err(ProviderRoutingStoreFault::InitialRevisionRequired);
        }
        self.persist(&routing)?;
        self.routing = Some(routing);
        Ok(self
            .routing()
            .expect("persisted provider routing remains addressable"))
    }

    fn persist(&mut self, routing: &ProviderRouting) -> Result<(), ProviderRoutingStoreFault> {
        let bytes = serde_json::to_vec(&ProviderRoutingStoreDocument::from_routing(routing))
            .map_err(|_| ProviderRoutingStoreFault::Encode)?;
        if bytes.len() > MAX_STORE_BYTES as usize {
            return Err(ProviderRoutingStoreFault::RecordTooLarge);
        }
        let temporary = temporary_path(&self.path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| ProviderRoutingStoreFault::Commit(error.kind()))?;
        use std::io::Write;
        if let Err(error) = file.write_all(&bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(ProviderRoutingStoreFault::Commit(error.kind()));
        }
        if let Err(error) = file.sync_data() {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ProviderRoutingStoreFault::CommitOutcomeUnknown(
                error.kind(),
            ));
        }
        drop(file);
        if let Err(error) = crate::persistence::replace_file(&temporary, &self.path) {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ProviderRoutingStoreFault::CommitOutcomeUnknown(
                error.kind(),
            ));
        }
        if let Err(error) = OpenOptions::new()
            .write(true)
            .open(&self.path)
            .and_then(|file| file.sync_data())
        {
            self.requires_reopen = true;
            return Err(ProviderRoutingStoreFault::CommitOutcomeUnknown(
                error.kind(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderRoutingStoreFault {
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
    Decode,
    Encode,
    InitialRevisionRequired,
    RecordTooLarge,
    RecoveryRequired,
    RevisionConflict,
    RevisionMustFollowCurrent,
    StaleRevision,
    WriterBusy,
}

impl std::fmt::Display for ProviderRoutingStoreFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Commit(_) => "provider routing facts could not be committed",
            Self::CommitOutcomeUnknown(_) => {
                "provider routing commit outcome is unknown; reopen before retrying"
            }
            Self::Decode => "provider routing facts are invalid",
            Self::Encode => "provider routing facts could not be encoded",
            Self::InitialRevisionRequired => "initial provider routing revision must be one",
            Self::RecordTooLarge => "provider routing facts exceed the durable limit",
            Self::RecoveryRequired => {
                "provider routing facts require reopening before another mutation"
            }
            Self::RevisionConflict => {
                "provider routing revision is already assigned to different facts"
            }
            Self::RevisionMustFollowCurrent => {
                "provider routing revision must immediately follow current facts"
            }
            Self::StaleRevision => "provider routing revision must advance monotonically",
            Self::WriterBusy => "provider routing facts writer is busy",
        })
    }
}

impl std::error::Error for ProviderRoutingStoreFault {}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderRoutingStoreDocument {
    version: u8,
    revision: u64,
    routes: Vec<ProviderRouteDocument>,
}

impl ProviderRoutingStoreDocument {
    fn from_routing(routing: &ProviderRouting) -> Self {
        Self {
            version: STORE_VERSION,
            revision: routing.revision().get(),
            routes: routing
                .routes()
                .iter()
                .map(|(capability, route)| ProviderRouteDocument::from_route(*capability, route))
                .collect(),
        }
    }

    fn into_routing(self) -> Result<ProviderRouting, ProviderRoutingStoreFault> {
        if self.version != STORE_VERSION {
            return Err(ProviderRoutingStoreFault::Decode);
        }
        ProviderRouting::try_new(
            ProviderRoutingRevision::try_new(self.revision)
                .map_err(|_| ProviderRoutingStoreFault::Decode)?,
            self.routes
                .into_iter()
                .map(ProviderRouteDocument::into_route)
                .collect::<Result<_, _>>()?,
        )
        .map_err(|_| ProviderRoutingStoreFault::Decode)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderRouteDocument {
    capability: ProviderRoutingCapabilityDocument,
    primary: ProviderModelReferenceDocument,
    fallbacks: Vec<ProviderModelReferenceDocument>,
    timeout_ms: Option<u64>,
}

impl ProviderRouteDocument {
    fn from_route(capability: ProviderRoutingCapability, route: &ProviderRoute) -> Self {
        Self {
            capability: capability.into(),
            primary: route.primary().into(),
            fallbacks: route.fallbacks().iter().map(Into::into).collect(),
            timeout_ms: route.timeout_ms(),
        }
    }

    fn into_route(
        self,
    ) -> Result<(ProviderRoutingCapability, ProviderRoute), ProviderRoutingStoreFault> {
        Ok((
            self.capability.into(),
            ProviderRoute::try_new(
                self.primary.into_reference()?,
                self.fallbacks
                    .into_iter()
                    .map(ProviderModelReferenceDocument::into_reference)
                    .collect::<Result<_, _>>()?,
                self.timeout_ms,
            )
            .map_err(|_| ProviderRoutingStoreFault::Decode)?,
        ))
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderModelReferenceDocument {
    account_id: String,
    model_id: String,
}

impl From<&ProviderModelReference> for ProviderModelReferenceDocument {
    fn from(reference: &ProviderModelReference) -> Self {
        Self {
            account_id: reference.account_id().as_str().to_owned(),
            model_id: reference.model_id().to_owned(),
        }
    }
}

impl ProviderModelReferenceDocument {
    fn into_reference(self) -> Result<ProviderModelReference, ProviderRoutingStoreFault> {
        ProviderModelReference::try_new(
            ProviderAccountId::try_new(self.account_id)
                .map_err(|_| ProviderRoutingStoreFault::Decode)?,
            self.model_id,
        )
        .map_err(|_| ProviderRoutingStoreFault::Decode)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderRoutingCapabilityDocument {
    Chat,
    ImageUnderstand,
    ImageGenerate,
    VideoGenerate,
    MusicGenerate,
    Tts,
}

impl From<ProviderRoutingCapability> for ProviderRoutingCapabilityDocument {
    fn from(value: ProviderRoutingCapability) -> Self {
        match value {
            ProviderRoutingCapability::Chat => Self::Chat,
            ProviderRoutingCapability::ImageUnderstand => Self::ImageUnderstand,
            ProviderRoutingCapability::ImageGenerate => Self::ImageGenerate,
            ProviderRoutingCapability::VideoGenerate => Self::VideoGenerate,
            ProviderRoutingCapability::MusicGenerate => Self::MusicGenerate,
            ProviderRoutingCapability::Tts => Self::Tts,
        }
    }
}

impl From<ProviderRoutingCapabilityDocument> for ProviderRoutingCapability {
    fn from(value: ProviderRoutingCapabilityDocument) -> Self {
        match value {
            ProviderRoutingCapabilityDocument::Chat => Self::Chat,
            ProviderRoutingCapabilityDocument::ImageUnderstand => Self::ImageUnderstand,
            ProviderRoutingCapabilityDocument::ImageGenerate => Self::ImageGenerate,
            ProviderRoutingCapabilityDocument::VideoGenerate => Self::VideoGenerate,
            ProviderRoutingCapabilityDocument::MusicGenerate => Self::MusicGenerate,
            ProviderRoutingCapabilityDocument::Tts => Self::Tts,
        }
    }
}

fn recover(path: &Path) -> Result<Option<ProviderRouting>, ProviderRoutingStoreFault> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_STORE_BYTES as usize => {
            serde_json::from_slice::<ProviderRoutingStoreDocument>(&bytes)
                .map_err(|_| ProviderRoutingStoreFault::Decode)?
                .into_routing()
                .map(Some)
        }
        Ok(_) => Err(ProviderRoutingStoreFault::RecordTooLarge),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ProviderRoutingStoreFault::Commit(error.kind())),
    }
}

pub(crate) fn migration_bytes(
    routing: &ProviderRouting,
) -> Result<Vec<u8>, ProviderRoutingStoreFault> {
    let bytes = serde_json::to_vec(&ProviderRoutingStoreDocument::from_routing(routing))
        .map_err(|_| ProviderRoutingStoreFault::Encode)?;
    if bytes.len() > MAX_STORE_BYTES as usize {
        return Err(ProviderRoutingStoreFault::RecordTooLarge);
    }
    Ok(bytes)
}

fn ensure_parent_directory(path: &Path) -> Result<(), ProviderRoutingStoreFault> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|error| ProviderRoutingStoreFault::Commit(error.kind()))?;
    }
    Ok(())
}

pub(super) fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

pub(super) fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    temporary.into()
}

fn remove_stale_temporary(path: &Path) -> Result<(), ProviderRoutingStoreFault> {
    match fs::remove_file(temporary_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ProviderRoutingStoreFault::Commit(error.kind())),
    }
}

struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, ProviderRoutingStoreFault> {
        match File::create_new(path) {
            Ok(file) => {
                drop(file);
                Ok(Self {
                    path: path.to_owned(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ProviderRoutingStoreFault::WriterBusy)
            }
            Err(error) => Err(ProviderRoutingStoreFault::Commit(error.kind())),
        }
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
