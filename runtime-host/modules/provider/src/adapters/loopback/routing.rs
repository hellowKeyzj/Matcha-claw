use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback::Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    ProviderAccountId, ProviderHandle, ProviderModelReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingRevision,
    projection::routing::ProviderRoutingDelivery,
};

pub(super) const ENDPOINT: &str = "/api/provider-routing";
const CAPABILITY_ID: &str = "provider.routing";
const AUTHORIZATION_SCOPE: &str = "providers:routing";
const AUTHORIZATION_SUBJECT: &str = "provider-routing";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestError {
    Invalid,
    Unauthorized,
    TimedOut,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRoutingRequest {
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
    Replace { routing: RoutingDraft },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoutingDraft {
    revision: u64,
    routes: Vec<RouteDraft>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RouteDraft {
    capability: String,
    primary: ModelReferenceDraft,
    fallbacks: Vec<ModelReferenceDraft>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelReferenceDraft {
    account_id: String,
    model_id: String,
}

enum ProviderRoutingCommand {
    List,
    Replace(ProviderRouting),
}

impl ProviderRoutingRequest {
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
                    "providerRouting.list" | "providerRouting.replace"
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
        Self::decode_semantics(value).map_err(|_| RequestError::Invalid)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        let valid_operation = match (&self.operation_id, &self.input) {
            (operation, Input::List {}) => operation == "providerRouting.list",
            (operation, Input::Replace { .. }) => operation == "providerRouting.replace",
        };
        (self.id == CAPABILITY_ID
            && self.scope.kind == "provider-routing"
            && self.target.kind == "provider-routing"
            && valid_operation)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    fn into_command(self) -> Result<ProviderRoutingCommand, RequestError> {
        match self.input {
            Input::List {} => Ok(ProviderRoutingCommand::List),
            Input::Replace { routing } => routing.try_into().map(ProviderRoutingCommand::Replace),
        }
    }
}

impl TryFrom<RoutingDraft> for ProviderRouting {
    type Error = RequestError;

    fn try_from(value: RoutingDraft) -> Result<Self, Self::Error> {
        let revision =
            ProviderRoutingRevision::try_new(value.revision).map_err(|_| RequestError::Invalid)?;
        if revision.get() > 9_007_199_254_740_991 {
            return Err(RequestError::Invalid);
        }
        let routes = value
            .routes
            .into_iter()
            .map(RouteDraft::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        ProviderRouting::try_new(revision, routes).map_err(|_| RequestError::Invalid)
    }
}

impl TryFrom<RouteDraft> for (ProviderRoutingCapability, ProviderRoute) {
    type Error = RequestError;

    fn try_from(value: RouteDraft) -> Result<Self, Self::Error> {
        let capability = capability_for(&value.capability).ok_or(RequestError::Invalid)?;
        let primary = value.primary.try_into()?;
        let fallbacks = value
            .fallbacks
            .into_iter()
            .map(ModelReferenceDraft::try_into)
            .collect::<Result<Vec<_>, _>>()?;
        let route = ProviderRoute::try_new(primary, fallbacks, value.timeout_ms)
            .map_err(|_| RequestError::Invalid)?;
        Ok((capability, route))
    }
}

impl TryFrom<ModelReferenceDraft> for ProviderModelReference {
    type Error = RequestError;

    fn try_from(value: ModelReferenceDraft) -> Result<Self, Self::Error> {
        let account_id =
            ProviderAccountId::try_new(value.account_id).map_err(|_| RequestError::Invalid)?;
        ProviderModelReference::try_new(account_id, value.model_id)
            .map_err(|_| RequestError::Invalid)
    }
}

pub(super) async fn handle(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> Response {
    if request.method() != "POST" || request.path() != ENDPOINT {
        let response = TransportResponse::not_found();
        return Response::json(response.status, response.body);
    }
    let response = match handle_request(request, verifier, provider).await {
        Ok(delivery) => TransportResponse::from_routing_delivery(delivery),
        Err(RequestError::Invalid) => TransportResponse::bad_request(),
        Err(RequestError::Unauthorized) => TransportResponse::unauthorized(),
        Err(RequestError::TimedOut) => TransportResponse::fixed(503, super::TIMEOUT_ERROR),
    };
    Response::json(response.status, response.body)
}

async fn handle_request(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> Result<ProviderRoutingDelivery, RequestError> {
    let authorization = request
        .bearer_authorization()
        .ok_or(RequestError::Unauthorized)?;
    let value =
        serde_json::from_slice::<Value>(&request.body).map_err(|_| RequestError::Invalid)?;
    let mut verifier = verifier.lock().await;
    let command =
        ProviderRoutingRequest::decode(value, authorization, &mut verifier, super::now_millis())
            .and_then(ProviderRoutingRequest::into_command)?;
    drop(verifier);
    let delivery = match command {
        ProviderRoutingCommand::List => {
            tokio::time::timeout(super::SHORT_DEADLINE, provider.list_provider_routing())
                .await
                .map_err(|_| RequestError::TimedOut)?
                .map(ProviderRoutingDelivery::from)
        }
        ProviderRoutingCommand::Replace(routing) => {
            let revision = routing.revision();
            provider
                .replace_provider_routing(routing)
                .await
                .map(|outcome| ProviderRoutingDelivery::Replace { revision, outcome })
        }
    }
    .unwrap_or(ProviderRoutingDelivery::Unavailable);
    Ok(delivery)
}

fn capability_for(value: &str) -> Option<ProviderRoutingCapability> {
    match value {
        "chat" => Some(ProviderRoutingCapability::Chat),
        "imageUnderstand" => Some(ProviderRoutingCapability::ImageUnderstand),
        "imageGenerate" => Some(ProviderRoutingCapability::ImageGenerate),
        "videoGenerate" => Some(ProviderRoutingCapability::VideoGenerate),
        "musicGenerate" => Some(ProviderRoutingCapability::MusicGenerate),
        "tts" => Some(ProviderRoutingCapability::Tts),
        _ => None,
    }
}

struct TransportResponse {
    status: u16,
    body: Value,
}

impl TransportResponse {
    fn bad_request() -> Self {
        Self::fixed(400, "Provider routing request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Provider routing authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Provider routing route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: json!({ "success": false, "error": error }),
        }
    }

    fn from_routing_delivery(delivery: ProviderRoutingDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}
