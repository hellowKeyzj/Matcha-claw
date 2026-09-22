use std::{sync::Arc, time::Instant};

use platform::{capability::CapabilityDecisionVerifier, loopback::Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    ProviderHandle, ProviderModelDraft,
    projection::{self, models::ProviderModelsDelivery},
};

pub(super) const ENDPOINT: &str = "/api/provider-models";
pub(super) const SELECTABLE_ENDPOINT: &str = "/api/provider-models/selectable";
const CAPABILITY_ID: &str = "provider.models";
const AUTHORIZATION_SCOPE: &str = "providers:models";
const AUTHORIZATION_SUBJECT: &str = "provider-models";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderModelsRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Input {
    List {},
    Selectable {
        capability: String,
    },
    Discover {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    Replace {
        #[serde(rename = "accountId")]
        account_id: String,
        models: Vec<ModelDraft>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelDraft {
    model_id: String,
    capabilities: Vec<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    timeout_ms: Option<u64>,
    aspect_ratio: Option<String>,
    resolution: Option<String>,
    quality: Option<String>,
}

enum ProviderModelsCommand {
    List,
    Selectable(crate::ProviderModelCapability),
    Discover(String),
    Replace {
        account_id: String,
        models: Vec<ProviderModelDraft>,
    },
}

impl ProviderModelsRequest {
    fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, RequestError> {
        let operation = value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|operation| {
                matches!(
                    *operation,
                    "providerModels.list"
                        | "providerModels.listSelectable"
                        | "providerModels.discover"
                        | "providerModels.replace"
                )
            })
            .ok_or(RequestError::Invalid)?;
        verifier
            .verify(
                authorization,
                now,
                ENDPOINT,
                AUTHORIZATION_SCOPE,
                operation,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| RequestError::Unauthorized)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        let valid_operation = match (&self.operation_id, &self.input) {
            (operation, Input::List {}) => operation == "providerModels.list",
            (operation, Input::Selectable { .. }) => operation == "providerModels.listSelectable",
            (operation, Input::Discover { .. }) => operation == "providerModels.discover",
            (operation, Input::Replace { .. }) => operation == "providerModels.replace",
        };
        (self.id == CAPABILITY_ID
            && self.scope.kind == "provider-model-catalog"
            && self.target.kind == "provider-models"
            && valid_operation)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    fn into_command(self) -> Result<ProviderModelsCommand, RequestError> {
        match self.input {
            Input::List {} => Ok(ProviderModelsCommand::List),
            Input::Selectable { capability } => projection::models::capability_for(&capability)
                .map(ProviderModelsCommand::Selectable)
                .ok_or(RequestError::Invalid),
            Input::Discover { account_id } => {
                if account_id.trim().is_empty() {
                    return Err(RequestError::Invalid);
                }
                Ok(ProviderModelsCommand::Discover(account_id))
            }
            Input::Replace { account_id, models } => {
                if account_id.trim().is_empty() {
                    return Err(RequestError::Invalid);
                }
                let models = models
                    .into_iter()
                    .map(ProviderModelDraft::try_from)
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(ProviderModelsCommand::Replace { account_id, models })
            }
        }
    }
}

impl TryFrom<ModelDraft> for ProviderModelDraft {
    type Error = RequestError;

    fn try_from(value: ModelDraft) -> Result<Self, Self::Error> {
        let capabilities = value
            .capabilities
            .into_iter()
            .map(|capability| {
                projection::models::capability_for(&capability).ok_or(RequestError::Invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            model_id: value.model_id,
            capabilities,
            context_window: value.context_window,
            max_tokens: value.max_tokens,
            timeout_ms: value.timeout_ms,
            aspect_ratio: value.aspect_ratio,
            resolution: value.resolution,
            quality: value.quality,
        })
    }
}

pub(super) async fn handle(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> Response {
    let response = handle_request(request, verifier, provider).await;
    Response::json(response.status, response.body)
}

async fn handle_request(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    let path = request.path().to_owned();
    if request.method() == "GET" {
        let (target_path, query) = path
            .split_once('?')
            .map_or((path.as_str(), ""), |(path, query)| (path, query));
        return match target_path {
            ENDPOINT => handle_get_list(&request, query, verifier, provider).await,
            SELECTABLE_ENDPOINT => handle_get_selectable(&request, query, verifier, provider).await,
            _ => TransportResponse::not_found(target_path),
        };
    }
    if request.method() != "POST" || path != ENDPOINT {
        return TransportResponse::not_found(path.as_str());
    }
    handle_post(request, verifier, provider).await
}

async fn handle_get_list(
    request: &platform::loopback::Request,
    query: &str,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    if !query.is_empty() || !request.body.is_empty() {
        return TransportResponse::bad_request();
    }
    if !verify_get_authorization(request, &verifier, ENDPOINT, "providerModels.list").await {
        return TransportResponse::unauthorized();
    }
    let delivery = provider
        .list_provider_models()
        .await
        .map(ProviderModelsDelivery::List)
        .unwrap_or(ProviderModelsDelivery::Unavailable);
    TransportResponse::from_models_delivery(delivery)
}

async fn handle_get_selectable(
    request: &platform::loopback::Request,
    query: &str,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    if !request.body.is_empty() {
        return TransportResponse::bad_request();
    }
    let Some(capability) = parse_capability_query(query) else {
        return TransportResponse::bad_request();
    };
    if !verify_get_authorization(
        request,
        &verifier,
        SELECTABLE_ENDPOINT,
        "providerModels.listSelectable",
    )
    .await
    {
        return TransportResponse::unauthorized();
    }
    let delivery = provider
        .selectable_provider_models(capability)
        .await
        .map(ProviderModelsDelivery::Selectable)
        .unwrap_or(ProviderModelsDelivery::Unavailable);
    TransportResponse::from_models_delivery(delivery)
}

fn parse_capability_query(query: &str) -> Option<crate::ProviderModelCapability> {
    let (key, value) = query.split_once('=')?;
    if key != "capability" || value.is_empty() || value.contains('=') || value.contains('&') {
        return None;
    }
    projection::models::capability_for(value)
}

async fn verify_get_authorization(
    request: &platform::loopback::Request,
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &str,
    capability: &str,
) -> bool {
    let Some(token) = request.bearer_authorization() else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            token,
            super::now_millis(),
            endpoint,
            AUTHORIZATION_SCOPE,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .is_ok()
}

async fn handle_post(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    let Some(authorization) = request.bearer_authorization() else {
        return TransportResponse::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return TransportResponse::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let command = match ProviderModelsRequest::decode(
        value,
        authorization,
        &mut verifier,
        super::now_millis(),
    )
    .and_then(ProviderModelsRequest::into_command)
    {
        Ok(command) => command,
        Err(RequestError::Invalid) => return TransportResponse::bad_request(),
        Err(RequestError::Unauthorized) => return TransportResponse::unauthorized(),
    };
    drop(verifier);
    let is_query = !matches!(command, ProviderModelsCommand::Replace { .. });
    let dispatch = async {
        match command {
            ProviderModelsCommand::List => provider
                .list_provider_models()
                .await
                .map(ProviderModelsDelivery::List),
            ProviderModelsCommand::Selectable(capability) => provider
                .selectable_provider_models(capability)
                .await
                .map(ProviderModelsDelivery::Selectable),
            ProviderModelsCommand::Discover(account_id) => {
                let started = Instant::now();
                eprintln!("[provider-models-transport] phase=discover-owner outcome=dispatched");
                let delivery = provider
                    .discover_provider_models(account_id)
                    .await
                    .map(ProviderModelsDelivery::Discover);
                eprintln!(
                    "[provider-models-transport] phase=discover-owner outcome=completed status={} elapsed_ms={}",
                    delivery
                        .as_ref()
                        .map_or(503, ProviderModelsDelivery::status_code),
                    started.elapsed().as_millis()
                );
                delivery
            }
            ProviderModelsCommand::Replace { account_id, models } => provider
                .replace_provider_models(account_id, models)
                .await
                .map(ProviderModelsDelivery::Replace),
        }
    };
    let delivery = if is_query {
        match tokio::time::timeout(super::SHORT_DEADLINE, dispatch).await {
            Ok(delivery) => delivery,
            Err(_) => return TransportResponse::fixed(503, super::TIMEOUT_ERROR),
        }
    } else {
        dispatch.await
    }
    .unwrap_or(ProviderModelsDelivery::Unavailable);
    TransportResponse::from_models_delivery(delivery)
}

struct TransportResponse {
    status: u16,
    body: Value,
}

impl TransportResponse {
    fn bad_request() -> Self {
        Self::fixed(400, "Provider model request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Provider model authorization is invalid")
    }

    fn not_found(_path: &str) -> Self {
        Self::fixed(404, "Provider model route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: json!({ "success": false, "error": error }),
        }
    }

    fn from_models_delivery(delivery: ProviderModelsDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}
