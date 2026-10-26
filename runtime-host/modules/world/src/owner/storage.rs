use std::{collections::BTreeMap, sync::{Arc, Mutex}};

use tokio::time::Instant;
use world_protocol::{api::ApiFailure, commit::CommitFailure, failure::{FailureStage, Recovery}};

use crate::store::{DriverCustody, StorageIdentity, WorldStore};
use super::{Error, runtime::{StoreConfiguration, WorldStorage}};

struct Connection {
    pool: Option<deadpool_postgres::Pool>,
    drivers: Option<DriverCustody>,
    store: Option<WorldStore>,
}

/// Physical connections are retained before I/O, including failed marker/catalog acceptance.
pub(super) struct Stores {
    provider: Result<Arc<dyn WorldStorage>, Error>,
    opening: tokio::sync::Mutex<()>,
    stores: Mutex<BTreeMap<String, Result<WorldStore, Error>>>,
    connections: Mutex<Vec<Connection>>,
}

impl Stores {
    pub(super) fn new(provider: Result<Arc<dyn WorldStorage>, Error>) -> Self {
        Self { provider, opening: tokio::sync::Mutex::new(()), stores: Mutex::new(BTreeMap::new()), connections: Mutex::new(Vec::new()) }
    }

    pub(super) async fn initialize(&self, configuration: StoreConfiguration) -> Result<WorldStore, Error> {
        let _opening = self.opening.lock().await;
        self.connect(configuration, None, None).await
    }

    pub(super) async fn open(&self, id: &str) -> Result<WorldStore, Error> {
        let _opening = self.opening.lock().await;
        if let Some(store) = self.stores.lock().expect("world stores poisoned").get(id).cloned() { return store; }
        let provider = self.provider.as_ref().map_err(Clone::clone)?;
        let result = match provider.configuration(id) {
            Ok(configuration) => self.connect(configuration, Some(id), None).await,
            Err(error) => Err(error.into()),
        };
        self.stores.lock().expect("world stores poisoned").insert(id.into(), result.clone());
        result
    }

    pub(super) async fn inspect(&self, configuration: StoreConfiguration) -> Result<Option<String>, Error> {
        let _opening = self.opening.lock().await;
        let StoreConfiguration::Postgres { pool, drivers, limits, .. } = configuration else {
            return Err(Error::internal(FailureStage::Prepare));
        };
        let index = {
            let mut connections = self.connections.lock().expect("world connections poisoned");
            let index = connections.len();
            connections.push(Connection { pool: Some(pool.clone()), drivers: Some(drivers.clone()), store: None });
            index
        };
        let result = WorldStore::inspect(&pool, limits).await.map_err(Error::from);
        pool.close();
        match drivers.checked_close(limits.close_timeout).await {
            Ok(()) => {
                self.connections.lock().expect("world connections poisoned").remove(index);
                result
            }
            Err(cleanup) => Err(match result { Ok(_) => cleanup.into(), Err(error) => error.with_cleanup(cleanup) }),
        }
    }

    /// Explicit configuration acceptance/retry, never a second live business store.
    pub(super) async fn reopen(&self, id: &str) -> Result<WorldStore, Error> {
        let _opening = self.opening.lock().await;
        let provider = self.provider.as_ref().map_err(Clone::clone)?;
        let configuration = provider.configuration(id)?;
        let current = self.stores.lock().expect("world stores poisoned").get(id).and_then(|store| store.as_ref().ok()).cloned();
        if let (Some(store), StoreConfiguration::Postgres { identity, pool, .. }) = (&current, &configuration) {
            let token = match identity { StorageIdentity::Initialize { configuration_token, .. } | StorageIdentity::Existing { configuration_token, .. } => configuration_token };
            if store.identity_receipt().configuration_token() == token {
                pool.close();
                return Ok(store.clone());
            }
        }
        let result = self.connect(configuration, Some(id), current.as_ref()).await;
        match (current, result) {
            (Some(current), Ok(candidate)) => {
                self.stores.lock().expect("world stores poisoned").insert(id.into(), Ok(current.clone()));
                candidate.checked_close().await?;
                self.connections.lock().expect("world connections poisoned").retain(|connection| {
                    !connection.store.as_ref().is_some_and(WorldStore::mechanisms_closed)
                });
                Ok(current)
            }
            (Some(current), Err(error)) => {
                self.stores.lock().expect("world stores poisoned").insert(id.into(), Ok(current));
                Err(error)
            }
            (None, result) => result,
        }
    }

    async fn connect(&self, configuration: StoreConfiguration, expected: Option<&str>, retain: Option<&WorldStore>) -> Result<WorldStore, Error> {
        let (id, store) = match configuration {
            StoreConfiguration::NotConfigured => return Err(Error::new("world.not_configured", FailureStage::Prepare,
                "世界数据库尚未配置。", ApiFailure::NotConfigured, Recovery::None)),
            StoreConfiguration::Unavailable(error) => return Err(error.into()),
            StoreConfiguration::Ready(store) => {
                let id = store.identity_receipt().storage_id().to_owned();
                self.connections.lock().expect("world connections poisoned").push(Connection { pool: None, drivers: None, store: Some(store.clone()) });
                (id, store)
            }
            StoreConfiguration::Postgres { pool, drivers, limits, identity } => {
                let id = match &identity { StorageIdentity::Initialize { storage_id, .. } | StorageIdentity::Existing { storage_id, .. } => storage_id.clone() };
                let index = {
                    let mut connections = self.connections.lock().expect("world connections poisoned");
                    let index = connections.len();
                    connections.push(Connection { pool: Some(pool.clone()), drivers: Some(drivers.clone()), store: None });
                    index
                };
                let result = WorldStore::connect(pool, &drivers, limits, identity).await.map_err(Error::from);
                if let Ok(store) = &result { self.connections.lock().expect("world connections poisoned")[index].store = Some(store.clone()); }
                match result {
                    Ok(store) => (id, store),
                    Err(error) => {
                        self.stores.lock().expect("world stores poisoned").insert(id, retain.map(|store| Ok(store.clone())).unwrap_or_else(|| Err(error.clone())));
                        return Err(error);
                    }
                }
            }
        };
        let result = if expected.is_some_and(|expected| expected != id) {
            Err(crate::store::StoreError::new(CommitFailure::Installation {
                reason: world_protocol::commit::InstallationFailure::StorageIdentityMismatch,
            }, FailureStage::Prepare).into())
        } else {
            self.provider.as_ref().map_err(Clone::clone)
                .and_then(|provider| provider.accept(store.identity_receipt()).map_err(Error::from))
                .map(|()| store)
        };
        self.stores.lock().expect("world stores poisoned").insert(id, retain.map(|store| Ok(store.clone())).unwrap_or_else(|| result.clone()));
        result
    }

    pub(super) fn connected(&self) -> Vec<WorldStore> {
        self.connections.lock().expect("world connections poisoned").iter().filter_map(|connection| connection.store.clone()).collect()
    }

    pub(super) async fn checked_close(&self, deadline: Instant, diagnostics: &mut Vec<Error>) -> bool {
        let connections: Vec<_> = self.connections.lock().expect("world connections poisoned").iter()
            .map(|connection| (connection.pool.clone(), connection.drivers.clone(), connection.store.clone())).collect();
        let mut closed = true;
        for (pool, drivers, store) in connections {
            if let Some(pool) = pool { pool.close(); }
            if let Some(store) = store {
                store.close_admission();
                if !store.mechanisms_closed() {
                    match tokio::time::timeout_at(deadline, store.checked_close()).await {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => diagnostics.push(error.into()),
                        Err(error) => diagnostics.push(Error::internal(FailureStage::Stop).caused(error)),
                    }
                }
                closed &= store.mechanisms_closed();
            }
            if let Some(drivers) = drivers {
                if !drivers.mechanisms_closed().await {
                    if let Err(error) = drivers.checked_close(deadline.saturating_duration_since(Instant::now())).await { diagnostics.push(error.into()); }
                }
                closed &= drivers.mechanisms_closed().await;
            }
        }
        closed
    }
}
