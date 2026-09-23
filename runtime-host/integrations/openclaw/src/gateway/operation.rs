use std::sync::atomic::{AtomicU64, Ordering};

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
