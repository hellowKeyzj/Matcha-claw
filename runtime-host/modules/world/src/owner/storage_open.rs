use std::sync::{Arc, atomic::Ordering};

use world_protocol::{
    api::{ApiFailure, DiscoverQuery},
    ids::*,
};

use super::{Shared, Storage, WorldHandle, closed, initialize, locate, publish_ready};
use super::super::{Error, queries};

pub(super) async fn open(shared: &Arc<Shared>, storage_id: String, target: WorldHandle) -> Result<Vec<WorldRef>, Error> {
    if shared.closing.load(Ordering::Acquire) { return Err(closed()); }
    let store = shared.stores.reopen(&storage_id).await?;
    let worlds = store.worlds(&shared.authority).await?;
    // Reuse each retained startup report for explicit retry; never discard lifecycle custody.
    for world in &worlds {
        if shared.startup_failures.lock().expect("world startup failures poisoned").contains_key(world) {
            let current = locate(shared, &store, world).await?;
            super::initialize_world(shared, &current, world, true).await?;
        }
    }
    if let Err(error) = initialize(shared, &store, target, None).await {
        shared.storage.send_replace(Storage::Failed { error: error.clone(), store: Some(store) });
        return Err(error);
    }
    publish_ready(shared, store.clone())?;
    let mut accessible = Vec::new();
    for world in worlds {
        let current = locate(shared, &store, &world).await?;
        let ingress = shared.ingress.clone();
        let root = shared.authority.clone();
        let result = current.inspect_world(world.clone(), move |tx| Box::pin(async move {
            let now = tx.now().await?;
            let verified = ingress.desktop_directory(&root, tx, &now).await?;
            let description = queries::discover(tx, &verified, &DiscoverQuery { include_capabilities: false }, &now).await?;
            Ok::<_, Error>(description)
        })).await;
        match result {
            Ok(_) => accessible.push(world),
            Err(error) if matches!(error.safe_failure().details, ApiFailure::Authorization(_)) => {},
            Err(error) => return Err(error),
        }
    }
    Ok(accessible)
}
