use std::{sync::Arc, time::Instant};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::{
    common::authorization::CapabilityDecisionVerifier,
    providers::{
        models::{
            ProviderModelsCommand, ProviderModelsDelivery, ProviderModelsRequest, RequestError,
            projection::capability_for,
        },
        routing as provider_routing,
    },
};

use super::server::{
    AUTHORIZATION_HEADER, AUTHORIZATION_SCOPE, AUTHORIZATION_SUBJECT, BEARER_PREFIX, ENDPOINT,
    Request, Response, SELECTABLE_ENDPOINT, now_millis,
};

pub(super) async fn handle_models_get_list(
    request: Request,
    query: &str,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !query.is_empty() || !request.body.is_empty() {
        return Response::bad_request();
    }
    if !verify_get_authorization(&request.headers, &verifier, ENDPOINT, "providerModels.list").await
    {
        return Response::unauthorized();
    }
    let delivery = owner
        .list_provider_models()
        .await
        .map(ProviderModelsDelivery::List)
        .unwrap_or(ProviderModelsDelivery::Unavailable);
    Response::from_provider_models_delivery(delivery)
}

pub(super) async fn handle_models_get_selectable(
    request: Request,
    query: &str,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !request.body.is_empty() {
        return Response::bad_request();
    }
    let Some(capability) = parse_capability_query(query) else {
        return Response::bad_request();
    };
    if !verify_get_authorization(
        &request.headers,
        &verifier,
        SELECTABLE_ENDPOINT,
        "providerModels.listSelectable",
    )
    .await
    {
        return Response::unauthorized();
    }
    let delivery = owner
        .selectable_provider_models(capability)
        .await
        .map(ProviderModelsDelivery::Selectable)
        .unwrap_or(ProviderModelsDelivery::Unavailable);
    Response::from_provider_models_delivery(delivery)
}

fn parse_capability_query(query: &str) -> Option<environment::ProviderModelCapability> {
    let (key, value) = query.split_once('=')?;
    if key != "capability" || value.is_empty() || value.contains('=') || value.contains('&') {
        return None;
    }
    capability_for(value)
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

pub(super) async fn handle_models_post(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let command =
        match ProviderModelsRequest::decode(value, authorization, &mut verifier, now_millis())
            .and_then(ProviderModelsRequest::into_command)
        {
            Ok(command) => command,
            Err(RequestError::Invalid) => return Response::bad_request(),
            Err(RequestError::Unauthorized) => return Response::unauthorized(),
        };
    drop(verifier);
    let delivery = match command {
        ProviderModelsCommand::List => owner
            .list_provider_models()
            .await
            .map(ProviderModelsDelivery::List),
        ProviderModelsCommand::Selectable(capability) => owner
            .selectable_provider_models(capability)
            .await
            .map(ProviderModelsDelivery::Selectable),
        ProviderModelsCommand::Discover(account_id) => {
            let started = Instant::now();
            eprintln!("[provider-models-transport] phase=discover-owner outcome=dispatched");
            let delivery = owner
                .discover_provider_models(account_id)
                .await
                .map(ProviderModelsDelivery::Discover);
            eprintln!(
                "[provider-models-transport] phase=discover-owner outcome=completed status={} elapsed_ms={}",
                delivery.as_ref().map_or(503, ProviderModelsDelivery::status_code),
                started.elapsed().as_millis()
            );
            delivery
        }
        ProviderModelsCommand::Replace { account_id, models } => owner
            .replace_provider_models(account_id, models)
            .await
            .map(ProviderModelsDelivery::Replace),
    }
    .unwrap_or(ProviderModelsDelivery::Unavailable);
    Response::from_provider_models_delivery(delivery)
}

pub(super) async fn handle_routing(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    match provider_routing::handle(
        &request.headers,
        &request.body,
        verifier,
        owner,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::from_provider_routing_delivery(delivery),
        Err(provider_routing::RequestError::Invalid) => Response::provider_routing_bad_request(),
        Err(provider_routing::RequestError::Unauthorized) => {
            Response::provider_routing_unauthorized()
        }
    }
}
