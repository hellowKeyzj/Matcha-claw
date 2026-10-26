use std::{future::Future, pin::Pin, sync::Arc};

use world_protocol::ids::WorldRef;
use crate::{content::Content, extensions::package::Inventory, store::WorldStore};
use super::StateError;

pub(crate) type TargetFuture<'a> = Pin<Box<dyn Future<Output = Result<OpenedTarget, StateError>> + Send + 'a>>;

/// Trusted private configuration resolves an exact registered storage id, never a guest DSN/path.
pub(crate) trait StorageTarget: Send + Sync {
    fn open<'a>(&'a self, world: &'a WorldRef, storage_id: &'a str) -> TargetFuture<'a>;
}

/// The owning adapter retains failed-connect driver custody and every opened target through recovery.
/// Cloning these handles does not create another store or transfer runner.
pub(crate) struct OpenedTarget {
    pub store: WorldStore,
    pub content: Arc<Content>,
    pub inventory: Arc<Inventory>,
}
