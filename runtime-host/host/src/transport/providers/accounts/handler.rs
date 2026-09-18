use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::{common::authorization::CapabilityDecisionVerifier, localhost};

use crate::provider::accounts::ProviderAccountsDelivery;

use super::{ProviderAccountsRequest, RequestError};

const ENDPOINT: &str = "/api/provider-accounts";
const AUTHORIZATION_SCOPE: &str = "providers:accounts";
const AUTHORIZATION_SUBJECT: &str = "provider-accounts";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> localhost::Response {
    handle_request(method, path, headers, body, verifier, owner)
        .await
        .into()
}

async fn handle_request(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if method == "GET" {
        let (target_path, query) = path
            .split_once('?')
            .map_or((path, None), |(path, query)| (path, Some(query)));
        if query.is_some() {
            return Response::bad_request();
        }
        return match target_path {
            ENDPOINT => handle_get_list(headers, body, verifier, owner).await,
            path if path.starts_with("/api/provider-accounts/") => {
                handle_get_account(path, headers, body, verifier, owner).await
            }
            _ => Response::not_found(),
        };
    }
    if method != "POST" || path != ENDPOINT {
        return Response::not_found();
    }
    let Some(authorization) = authorization(headers) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let command = match ProviderAccountsRequest::decode(
        value,
        authorization,
        &mut verifier,
        now_millis(),
    )
    .and_then(ProviderAccountsRequest::into_command)
    {
        Ok(command) => command,
        Err(RequestError::Invalid) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=decode detail=invalid-request"
            );
            return Response::bad_request();
        }
        Err(RequestError::Unauthorized) => {
            eprintln!(
                "[startup-trace] source=provider-accounts-transport phase=decode detail=unauthorized"
            );
            return Response::unauthorized();
        }
    };
    log_command("decode", &command);
    drop(verifier);
    let delivery = match command {
        super::ProviderAccountsCommand::List => owner.list_provider_accounts().await,
        super::ProviderAccountsCommand::Get(id) => owner.get_provider_account(id).await,
        super::ProviderAccountsCommand::Replace(draft) => {
            owner.replace_provider_account(draft).await
        }
        super::ProviderAccountsCommand::Delete(id, revision) => {
            owner.delete_provider_account(id, revision).await
        }
    };
    Response::from_delivery(delivery.unwrap_or(ProviderAccountsDelivery::Unavailable))
}

async fn handle_get_list(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !body.is_empty() {
        return Response::bad_request();
    }
    if !verify_get_authorization(headers, &verifier, ENDPOINT, "providerAccounts.list").await {
        return Response::unauthorized();
    }
    let delivery = owner
        .list_provider_accounts()
        .await
        .unwrap_or(ProviderAccountsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

async fn handle_get_account(
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !body.is_empty() {
        return Response::bad_request();
    }
    let Some(id) = path.strip_prefix("/api/provider-accounts/") else {
        return Response::not_found();
    };
    if id.is_empty() || id.contains('/') {
        return Response::not_found();
    }
    let Ok(id) = environment::ProviderAccountId::try_new(id.to_owned()) else {
        return Response::bad_request();
    };
    if !verify_get_authorization(headers, &verifier, path, "providerAccounts.get").await {
        return Response::unauthorized();
    }
    let delivery = owner
        .get_provider_account(id)
        .await
        .unwrap_or(ProviderAccountsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

async fn verify_get_authorization(
    headers: &[(String, String)],
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &str,
    capability: &str,
) -> bool {
    let Some(token) = authorization(headers) else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            token,
            now_millis(),
            endpoint,
            AUTHORIZATION_SCOPE,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .is_ok()
}

fn authorization(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
}

fn log_command(phase: &str, command: &super::ProviderAccountsCommand) {
    match command {
        super::ProviderAccountsCommand::List => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=list"
        ),
        super::ProviderAccountsCommand::Get(id) => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=get account_id_len={}",
            id.as_str().len()
        ),
        super::ProviderAccountsCommand::Replace(draft) => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=replace provider={} auth_mode={} kind={} enabled={} revision={} endpoint_present={} protocol={} media_protocol={}",
            draft.provider(),
            draft.auth_mode(),
            draft.kind(),
            draft.enabled(),
            draft.revision_value(),
            draft.has_endpoint(),
            draft.protocol().unwrap_or("none"),
            draft.media_protocol().unwrap_or("none")
        ),
        super::ProviderAccountsCommand::Delete(id, revision) => eprintln!(
            "[startup-trace] source=provider-accounts-transport phase={phase} detail=command operation=delete account_id_len={} revision={}",
            id.as_str().len(),
            revision.get()
        ),
    }
}

struct Response {
    status: u16,
    body: Value,
}

impl From<Response> for localhost::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Provider account request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Provider account authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Provider account route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ProviderAccountsDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
