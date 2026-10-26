use std::{path::PathBuf, sync::{Arc, OnceLock}};

use crate::{
    content::Content,
    extensions::{bindings::Bindings, lifecycle::{LiveExtensions, PreparationPorts}, package::{Inventory, PackageReadLimits}},
    materials::WorldWiki,
    store::WorldStore,
};
use world_protocol::ids::WorldRef;
use super::Error;

/// Private composition inputs; none are accepted from a World request body.
pub struct WorldResources {
    pub content_root: PathBuf,
    pub maximum_blob_bytes: u64,
    pub package_root: PathBuf,
    pub package_limits: PackageReadLimits,
    pub wiki: Arc<dyn WorldWiki>,
    pub preparation: PreparationPorts,
    pub generation: Arc<dyn crate::generation::WorldGeneration>,
    pub investigation: Arc<dyn crate::learning::investigation::WorldInvestigation>,
}

#[derive(Default)]
pub(crate) struct WorldAuthorities {
    pub evaluation: OnceLock<crate::authorization::EvaluationAuthority>,
    pub maintenance: OnceLock<crate::authorization::MaintenanceAuthority>,
}

pub(crate) struct Resources {
    pub content: Arc<Content>,
    pub inventory: Arc<Inventory>,
    pub bindings: Bindings,
    pub wiki: Arc<dyn WorldWiki>,
    pub generation: Arc<dyn crate::generation::WorldGeneration>,
    pub investigation: Arc<dyn crate::learning::investigation::WorldInvestigation>,
    pub model_calls: Arc<crate::generation::GenerationRecovery>,
    pub live: Arc<LiveExtensions>,
    pub preparation: PreparationPorts,
    pub tasks: Arc<super::tasks::Tasks>,
    pub releases: Arc<super::workflows::releases::ReleaseWorkflows>,
    pub sync: Arc<crate::sources::sync::SyncOwner>,
    pub actions: Arc<super::workflows::actions::ActionWorkflows>,
    pub archive: Arc<super::workflows::archive::ArchiveWorkflows>,
    pub authorities: Arc<WorldAuthorities>,
    pub transfer: tokio::sync::Mutex<Option<Arc<super::runtime::transfer::PendingTransfer>>>,
    pub maintenance: Arc<tokio::sync::Mutex<super::runtime::MaintenanceState>>,
}

impl WorldResources {
    pub(crate) fn open(&self, store: &WorldStore, world: &WorldRef, live: Arc<LiveExtensions>, tasks: Arc<super::tasks::Tasks>, authorities: Arc<WorldAuthorities>) -> Result<Arc<Resources>, Error> {
        let storage = crate::definitions::canonical_digest(&store.identity_receipt().storage_id()).map_err(Error::from)?;
        let content_root = self.content_root.join(&storage.as_str()[7..]);
        let package_root = self.package_root.join(&storage.as_str()[7..]);
        let content = Arc::new(Content::open(&content_root, world.clone(), self.maximum_blob_bytes)?);
        let digest = crate::definitions::canonical_digest(world).map_err(Error::from)?;
        let limits = PackageReadLimits {
            transport_bytes: self.package_limits.transport_bytes, entries: self.package_limits.entries,
            file_bytes: self.package_limits.file_bytes, expanded_bytes: self.package_limits.expanded_bytes,
            manifest_bytes: self.package_limits.manifest_bytes, signature_bytes: self.package_limits.signature_bytes,
            signatures: self.package_limits.signatures,
        };
        let inventory = Arc::new(Inventory::open(store.clone(), world.clone(), &package_root.join(&digest.as_str()[7..]), limits)?);
        Ok(Arc::new(Resources { content, inventory, bindings: Bindings::new(store.clone(), live.clone()), wiki: self.wiki.clone(), generation: self.generation.clone(), investigation: self.investigation.clone(), model_calls: Arc::new(crate::generation::GenerationRecovery::default()), live, preparation: self.preparation.clone(), tasks, releases: Arc::new(super::workflows::releases::ReleaseWorkflows::default()), sync: Arc::new(crate::sources::sync::SyncOwner::default()), actions: Arc::new(super::workflows::actions::ActionWorkflows::default()), transfer: tokio::sync::Mutex::new(None), maintenance: Arc::default(), archive: Arc::new(super::workflows::archive::ArchiveWorkflows::default()), authorities }))
    }
}
