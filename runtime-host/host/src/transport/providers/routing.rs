use std::sync::Arc;

use environment::{
    ProviderAccountId, ProviderModelReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingRevision,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    provider::accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
    provider::native::{
        ProviderNativeConfigurationDiagnosticView, ProviderNativeConfigurationView,
    },
    provider::routing::{
        ProviderModelReferenceView, ProviderRoutingListOutcome, ProviderRoutingReplaceOutcome,
        ProviderRoutingView,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

const CAPABILITY_ID: &str = "provider.routing";
const AUTHORIZATION_ENDPOINT: &str = "/api/provider-routing";
const AUTHORIZATION_SCOPE: &str = "providers:routing";
const AUTHORIZATION_SUBJECT: &str = "provider-routing";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderRoutingRequest {
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
    List,
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

pub(crate) enum ProviderRoutingCommand {
    List,
    Replace(ProviderRouting),
}

impl ProviderRoutingRequest {
    pub(crate) fn decode(
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
                AUTHORIZATION_ENDPOINT,
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
            (operation, Input::List) => operation == "providerRouting.list",
            (operation, Input::Replace { .. }) => operation == "providerRouting.replace",
        };
        (self.id == CAPABILITY_ID
            && self.scope.kind == "provider-routing"
            && self.target.kind == "provider-routing"
            && valid_operation)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<ProviderRoutingCommand, RequestError> {
        match self.input {
            Input::List => Ok(ProviderRoutingCommand::List),
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

pub(crate) enum ProviderRoutingDelivery {
    List(Option<ProviderRoutingView>),
    Replace {
        revision: ProviderRoutingRevision,
        outcome: ProviderRoutingReplaceOutcome,
    },
    Unavailable,
}

impl ProviderRoutingDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::List(_) => 200,
            Self::Replace { outcome, .. }
                if matches!(
                    outcome,
                    ProviderRoutingReplaceOutcome::DesiredStored {
                        persisted: ProviderPersistedOutcome::Confirmed,
                        commit: ProviderCommitOutcome::Committed,
                        ..
                    }
                ) =>
            {
                200
            }
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::DesiredStored { .. },
                ..
            } => 409,
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::Rejected,
                ..
            } => 422,
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::Unavailable,
                ..
            }
            | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::List(routing) => json!({ "routing": routing.as_ref().map(routing_json) }),
            Self::Replace {
                revision,
                outcome:
                    ProviderRoutingReplaceOutcome::DesiredStored {
                        persisted,
                        native,
                        commit,
                    },
            } => {
                let receipt = json!({
                    "desired": { "status": "stored", "revision": revision.get() },
                    "persisted": persisted_json(*persisted),
                    "native": native_json(native.clone()),
                    "commit": commit_name(*commit),
                });
                if mutation_unknown(*persisted, *commit) {
                    json!({
                        "success": false,
                        "code": "commit-outcome-unknown",
                        "error": "Provider mutation commit outcome is unknown; reopen before retrying",
                        "receipt": receipt,
                    })
                } else {
                    json!({
                        "success": true,
                        "desired": receipt["desired"],
                        "persisted": receipt["persisted"],
                        "native": receipt["native"],
                        "commit": receipt["commit"],
                    })
                }
            }
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::Unavailable,
                ..
            }
            | Self::Unavailable => fixed_error("Provider routing is unavailable"),
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::Rejected,
                ..
            } => fixed_error("Provider routing request was rejected"),
        }
    }
}

fn fixed_error(error: &'static str) -> Value {
    json!({ "success": false, "error": error })
}

fn mutation_unknown(persisted: ProviderPersistedOutcome, commit: ProviderCommitOutcome) -> bool {
    matches!(
        (persisted, commit),
        (ProviderPersistedOutcome::Unknown, _) | (_, ProviderCommitOutcome::CommitOutcomeUnknown)
    )
}

fn persisted_json(outcome: ProviderPersistedOutcome) -> Value {
    json!({
        "status": match outcome {
            ProviderPersistedOutcome::Confirmed => "confirmed",
            ProviderPersistedOutcome::Unknown => "unknown",
        }
    })
}

fn native_json(effect: ProviderNativeConfigurationView) -> Value {
    let mut value = json!({
        "changed": effect.changed,
        "applied": { "status": effect.applied },
        "observed": { "status": effect.observed },
    });
    if let Some(diagnostic) = &effect.diagnostic {
        value
            .as_object_mut()
            .expect("provider native JSON is an object")
            .insert("diagnostic".into(), native_diagnostic_json(diagnostic));
    }
    value
}

fn native_diagnostic_json(diagnostic: &ProviderNativeConfigurationDiagnosticView) -> Value {
    let mut value = json!({
        "phase": diagnostic.phase,
        "reason": diagnostic.reason,
        "configPath": diagnostic.config_path,
    });
    let object = value
        .as_object_mut()
        .expect("provider native diagnostic JSON is an object");
    if let Some(method) = &diagnostic.method {
        object.insert("method".into(), Value::String(method.clone()));
    }
    if let Some(expected_path) = &diagnostic.expected_path {
        object.insert("expectedPath".into(), Value::String(expected_path.clone()));
    }
    if let Some(detail) = &diagnostic.detail {
        object.insert("detail".into(), Value::String(detail.clone()));
    }
    value
}

fn commit_name(outcome: ProviderCommitOutcome) -> &'static str {
    match outcome {
        ProviderCommitOutcome::Committed => "committed",
        ProviderCommitOutcome::CommitOutcomeUnknown => "commit-outcome-unknown",
    }
}

fn routing_json(routing: &ProviderRoutingView) -> Value {
    let routes = routing
        .routes
        .iter()
        .map(|route| {
            let mut value = json!({
                "capability": route.capability,
                "primary": model_reference_json(&route.primary),
                "fallbacks": route.fallbacks.iter().map(model_reference_json).collect::<Vec<_>>(),
            });
            if let Some(timeout_ms) = route.timeout_ms {
                value
                    .as_object_mut()
                    .expect("provider routing route JSON is an object")
                    .insert("timeoutMs".into(), Value::Number(timeout_ms.into()));
            }
            value
        })
        .collect::<Vec<_>>();
    json!({
        "revision": routing.revision,
        "routes": routes,
    })
}

fn model_reference_json(reference: &ProviderModelReferenceView) -> Value {
    json!({
        "accountId": reference.account_id,
        "modelId": reference.model_id,
    })
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

pub(crate) async fn handle(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
    now: u64,
) -> Result<ProviderRoutingDelivery, RequestError> {
    let authorization = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    let value = serde_json::from_slice::<Value>(body).map_err(|_| RequestError::Invalid)?;
    let mut verifier = verifier.lock().await;
    let command = ProviderRoutingRequest::decode(value, authorization, &mut verifier, now)
        .and_then(ProviderRoutingRequest::into_command)?;
    drop(verifier);
    let delivery = match command {
        ProviderRoutingCommand::List => {
            owner
                .list_provider_routing()
                .await
                .map(|outcome| match outcome {
                    ProviderRoutingListOutcome::Desired(routing) => {
                        ProviderRoutingDelivery::List(routing)
                    }
                    ProviderRoutingListOutcome::Unavailable => ProviderRoutingDelivery::Unavailable,
                })
        }
        ProviderRoutingCommand::Replace(routing) => {
            let revision = routing.revision();
            owner
                .replace_provider_routing(routing)
                .await
                .map(|outcome| ProviderRoutingDelivery::Replace { revision, outcome })
        }
    }
    .unwrap_or(ProviderRoutingDelivery::Unavailable);
    Ok(delivery)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(operation_id: &str, input: Value) -> Value {
        json!({
            "id": "provider.routing",
            "operationId": operation_id,
            "scope": { "kind": "provider-routing" },
            "target": { "kind": "provider-routing" },
            "input": input,
        })
    }

    #[test]
    fn request_accepts_only_the_fixed_operations_and_capabilities() {
        let list = ProviderRoutingRequest::decode_semantics(request(
            "providerRouting.list",
            json!({ "kind": "list" }),
        ))
        .expect("valid list")
        .into_command()
        .expect("list command");
        assert!(matches!(list, ProviderRoutingCommand::List));

        for capability in [
            "chat",
            "imageUnderstand",
            "imageGenerate",
            "videoGenerate",
            "musicGenerate",
            "tts",
        ] {
            let command = ProviderRoutingRequest::decode_semantics(request(
                "providerRouting.replace",
                json!({
                    "kind": "replace",
                    "routing": {
                        "revision": 1,
                        "routes": [{
                            "capability": capability,
                            "primary": { "accountId": "test", "modelId": "model" },
                            "fallbacks": [],
                        }],
                    },
                }),
            ))
            .expect("valid replacement")
            .into_command();
            assert!(command.is_ok(), "{capability}");
        }
    }

    #[test]
    fn request_rejects_unknown_fields_and_capabilities() {
        for value in [
            request(
                "providerRouting.replace",
                json!({
                    "kind": "replace",
                    "routing": {
                        "revision": 1,
                        "routes": [{
                            "capability": "transcribe",
                            "primary": { "accountId": "test", "modelId": "model" },
                            "fallbacks": [],
                        }],
                    },
                }),
            ),
            request(
                "providerRouting.replace",
                json!({
                    "kind": "replace",
                    "routing": {
                        "revision": 1,
                        "routes": [{
                            "capability": "chat",
                            "primary": {
                                "accountId": "test",
                                "modelId": "model",
                                "credential": "credential:v1:private",
                            },
                            "fallbacks": [],
                        }],
                    },
                }),
            ),
        ] {
            assert!(matches!(
                ProviderRoutingRequest::decode_semantics(value)
                    .and_then(ProviderRoutingRequest::into_command),
                Err(RequestError::Invalid)
            ));
        }
    }

    #[test]
    fn list_delivery_preserves_nullable_routing_shape_without_private_fields() {
        let routing = ProviderRouting::try_new(
            ProviderRoutingRevision::try_new(3).expect("revision"),
            vec![],
        )
        .expect("routing");
        assert_eq!(
            ProviderRoutingDelivery::List(None).body(),
            json!({ "routing": null })
        );
        let body =
            ProviderRoutingDelivery::List(Some(ProviderRoutingView::from_routing(&routing))).body();
        assert_eq!(body, json!({ "routing": { "revision": 3, "routes": [] } }));
        assert!(!body.to_string().contains("providerKey"));
        assert!(!body.to_string().contains("apiKey"));
    }

    #[test]
    fn list_delivery_serializes_model_references_by_account_id_only() {
        let routing = ProviderRouting::try_new(
            ProviderRoutingRevision::try_new(3).expect("revision"),
            vec![(
                ProviderRoutingCapability::Chat,
                environment::ProviderRoute::try_new(
                    ProviderModelReference::try_new(
                        ProviderAccountId::try_new("local-ollama").expect("account"),
                        "llama-3.3",
                    )
                    .expect("primary"),
                    Vec::new(),
                    None,
                )
                .expect("route"),
            )],
        )
        .expect("routing");

        let body =
            ProviderRoutingDelivery::List(Some(ProviderRoutingView::from_routing(&routing))).body();
        assert_eq!(
            body.pointer("/routing/routes/0/primary"),
            Some(&json!({ "accountId": "local-ollama", "modelId": "llama-3.3" }))
        );
        assert!(!body.to_string().contains("credential"));
    }

    #[test]
    fn replacement_delivery_separates_desired_native_and_commit_planes() {
        let delivery = ProviderRoutingDelivery::Replace {
            revision: ProviderRoutingRevision::try_new(4).expect("revision"),
            outcome: ProviderRoutingReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Confirmed,
                native: ProviderNativeConfigurationView::unavailable(),
                commit: ProviderCommitOutcome::Committed,
            },
        };
        assert_eq!(delivery.status_code(), 200);
        assert_eq!(
            delivery.body(),
            json!({
                "success": true,
                "desired": { "status": "stored", "revision": 4 },
                "persisted": { "status": "confirmed" },
                "native": {
                    "changed": false,
                    "applied": { "status": "unknown" },
                    "observed": { "status": "unavailable" },
                },
                "commit": "committed",
            })
        );
        assert_eq!(
            ProviderRoutingDelivery::Replace {
                revision: ProviderRoutingRevision::try_new(4).expect("revision"),
                outcome: ProviderRoutingReplaceOutcome::Rejected,
            }
            .status_code(),
            422
        );
    }

    #[test]
    fn replacement_unknown_commit_is_conflict_and_redacted() {
        let delivery = ProviderRoutingDelivery::Replace {
            revision: ProviderRoutingRevision::try_new(4).expect("revision"),
            outcome: ProviderRoutingReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Unknown,
                native: ProviderNativeConfigurationView::unavailable(),
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            },
        };
        assert_eq!(delivery.status_code(), 409);
        assert_eq!(delivery.body()["code"], "commit-outcome-unknown");
        assert_eq!(delivery.body()["receipt"]["persisted"]["status"], "unknown");
    }

    #[test]
    fn native_diagnostic_public_response_preserves_head_fields() {
        let delivery = ProviderRoutingDelivery::Replace {
            revision: ProviderRoutingRevision::try_new(4).expect("revision"),
            outcome: ProviderRoutingReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Unknown,
                native: provider_native_view_with_private_diagnostic(),
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            },
        };
        assert_eq!(
            delivery.body()["receipt"]["native"]["diagnostic"],
            json!({
                "phase": "write",
                "reason": "gatewayRejected",
                "configPath": "C:/private/openclaw.json",
                "method": "config.set",
                "expectedPath": "models.providers",
                "detail": "native raw detail",
            })
        );
    }

    fn provider_native_view_with_private_diagnostic() -> ProviderNativeConfigurationView {
        ProviderNativeConfigurationView {
            changed: true,
            applied: "unknown",
            observed: "mismatch",
            diagnostic: Some(ProviderNativeConfigurationDiagnosticView {
                phase: "write".into(),
                reason: "gatewayRejected".into(),
                config_path: "C:/private/openclaw.json".into(),
                method: Some("config.set".into()),
                expected_path: Some("models.providers".into()),
                detail: Some("native raw detail".into()),
            }),
        }
    }
}
