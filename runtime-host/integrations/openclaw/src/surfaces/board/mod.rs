mod error;
mod events;
mod identity;
mod resources;

use std::sync::atomic::{AtomicU64, Ordering};

use ::board::{BoardFailure, BoardIdentity, BoardMethod, BoardOperation, BoardResult};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde_json::Value;

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

pub(crate) use events::decode_event;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) async fn execute(
    client: &GatewayClient,
    endpoint: &RuntimeEndpoint,
    identity: BoardIdentity,
    operation: BoardOperation,
) -> Result<BoardResult, BoardFailure> {
    identity::validate_identity(endpoint, &identity)?;
    operation.validate()?;
    let method = operation.method();
    let params = request_params(&identity, &operation)?;
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let request =
        wire::operations_request(format!("matcha-board-{sequence}"), method.as_str(), params)
            .map_err(|_| BoardFailure::Invalid)?;
    let response = if matches!(
        method,
        BoardMethod::Get | BoardMethod::PromptAuthorize | BoardMethod::DataRead
    ) {
        client
            .rpc_query(request)
            .await
            .map_err(error::connection_failure)?
    } else {
        match client.rpc_mutation(request).await {
            MutationDelivery::Response(response) => response,
            MutationDelivery::NotWritten(_) => return Err(BoardFailure::Unavailable),
            MutationDelivery::MayHaveReached(_) => return Err(BoardFailure::Unknown),
        }
    };
    let payload = match response {
        GatewayResponse::Success {
            payload: Some(payload),
            ..
        } => payload,
        GatewayResponse::Success { payload: None, .. } => return Err(BoardFailure::Unknown),
        GatewayResponse::Failure { error, .. } => return Err(error::native_failure(&error)),
    };
    let mut result = BoardResult::decode(method, payload)?;
    resources::project_result(&client.http_origin(), &identity, &mut result)?;
    Ok(result)
}

fn request_params(
    identity: &BoardIdentity,
    operation: &BoardOperation,
) -> Result<Value, BoardFailure> {
    let mut params = serde_json::to_value(operation).map_err(|_| BoardFailure::Invalid)?;
    let object = params.as_object_mut().ok_or(BoardFailure::Invalid)?;
    // The public operation discriminant selects the fixed RPC, not a native parameter.
    object.remove("method");
    let ticket = match operation {
        BoardOperation::Event { ticket, .. } => ticket.as_deref(),
        BoardOperation::PromptAuthorize { ticket }
        | BoardOperation::DataRead { ticket, .. }
        | BoardOperation::Action { ticket, .. } => Some(ticket.as_str()),
        _ => None,
    };
    if let Some(ticket) = ticket {
        identity::ticket_claims(identity, ticket)?;
    } else {
        object.insert(
            "sessionKey".into(),
            Value::String(identity.session_key().into()),
        );
        object.insert("agentId".into(), Value::String(identity.agent_id().into()));
    }
    Ok(params)
}
