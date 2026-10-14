use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, Mutex as StdMutex, Weak, atomic::{AtomicU64, Ordering}},
};

use tokio::sync::{Mutex, OwnedMutexGuard};

#[derive(Default)]
pub(crate) struct NativeTransactions<K> {
    locks: StdMutex<HashMap<K, Weak<Mutex<()>>>>,
}

impl<K: Eq + Hash> NativeTransactions<K> {
    pub(crate) async fn lock(&self, key: K) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().expect("native transaction registry lock poisoned");
            locks.retain(|_, lock| lock.strong_count() != 0);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }
}

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    wire::{self, GatewayResponse},
};

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
pub(crate) enum ReadError {
    Unavailable,
    Rejected,
    Protocol,
}

pub(crate) async fn read(
    gateway: &GatewayClient,
    request: wire::RpcRequest,
) -> Result<GatewayResponse, ReadError> {
    gateway.rpc_query(request).await.map_err(map_read_error)
}

pub(crate) fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("matcha-{operation}-{sequence}")
}

fn map_read_error(error: GatewayClientError) -> ReadError {
    match error {
        GatewayClientError::RpcFailed => ReadError::Rejected,
        GatewayClientError::Protocol => ReadError::Protocol,
        _ => ReadError::Unavailable,
    }
}
