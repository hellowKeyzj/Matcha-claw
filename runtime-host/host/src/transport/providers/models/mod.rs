use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    provider::accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
    provider::models::{
        ProviderModelDiscoverOutcome, ProviderModelDiscoveryView, ProviderModelDraft,
        ProviderModelListOutcome, ProviderModelReplaceOutcome, ProviderModelSelectableOutcome,
        ProviderModelView, SelectableProviderModelView,
    },
    provider::native::{
        ProviderNativeConfigurationDiagnosticView, ProviderNativeConfigurationView,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod projection;

use projection::capability_for;

const CAPABILITY_ID: &str = "provider.models";
const AUTHORIZATION_ENDPOINT: &str = "/api/provider-models";
const AUTHORIZATION_SCOPE: &str = "providers:models";
const AUTHORIZATION_SUBJECT: &str = "provider-models";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderModelsRequest {
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

pub(crate) enum ProviderModelsCommand {
    List,
    Selectable(environment::ProviderModelCapability),
    Discover(String),
    Replace {
        account_id: String,
        models: Vec<ProviderModelDraft>,
    },
}

impl ProviderModelsRequest {
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
                AUTHORIZATION_ENDPOINT,
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
            (operation, Input::List) => operation == "providerModels.list",
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

    pub(crate) fn into_command(self) -> Result<ProviderModelsCommand, RequestError> {
        match self.input {
            Input::List => Ok(ProviderModelsCommand::List),
            Input::Selectable { capability } => capability_for(&capability)
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
            .map(|capability| capability_for(&capability).ok_or(RequestError::Invalid))
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

pub(crate) enum ProviderModelsDelivery {
    List(ProviderModelListOutcome),
    Selectable(ProviderModelSelectableOutcome),
    Discover(ProviderModelDiscoverOutcome),
    Replace(ProviderModelReplaceOutcome),
    Unavailable,
}

impl ProviderModelsDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::List(ProviderModelListOutcome::Available(_))
            | Self::Selectable(ProviderModelSelectableOutcome::Available(_))
            | Self::Discover(ProviderModelDiscoverOutcome::Discovered(_)) => 200,
            Self::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted, commit, ..
            }) if !mutation_unknown(*persisted, *commit) => 200,
            Self::Replace(ProviderModelReplaceOutcome::DesiredStored { .. }) => 409,
            Self::Discover(ProviderModelDiscoverOutcome::Rejected)
            | Self::Replace(ProviderModelReplaceOutcome::Rejected) => 422,
            Self::List(ProviderModelListOutcome::Unavailable)
            | Self::Selectable(ProviderModelSelectableOutcome::Unavailable)
            | Self::Discover(ProviderModelDiscoverOutcome::Unavailable)
            | Self::Replace(ProviderModelReplaceOutcome::Unavailable)
            | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::List(ProviderModelListOutcome::Available(models)) => json!({
                "models": models.iter().map(model_json).collect::<Vec<_>>(),
            }),
            Self::Selectable(ProviderModelSelectableOutcome::Available(models)) => json!({
                "models": models.iter().map(selectable_model_json).collect::<Vec<_>>(),
            }),
            Self::Discover(ProviderModelDiscoverOutcome::Discovered(models)) => json!({
                "models": models.iter().map(draft_json).collect::<Vec<_>>(),
            }),
            Self::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted,
                native,
                commit,
            }) => {
                let receipt = json!({
                    "desired": { "status": "stored" },
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
            Self::Discover(ProviderModelDiscoverOutcome::Rejected)
            | Self::Replace(ProviderModelReplaceOutcome::Rejected) => {
                fixed_error("Provider model request was rejected")
            }
            Self::Replace(ProviderModelReplaceOutcome::Unavailable) => {
                fixed_error("Provider models are unavailable")
            }
            Self::List(ProviderModelListOutcome::Unavailable)
            | Self::Selectable(ProviderModelSelectableOutcome::Unavailable)
            | Self::Discover(ProviderModelDiscoverOutcome::Unavailable)
            | Self::Unavailable => fixed_error("Provider models are unavailable"),
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

fn model_json(model: &ProviderModelView) -> Value {
    let mut value = json!({
        "accountId": model.account_id,
        "label": model.label,
        "modelId": model.model_id,
        "capabilities": model.capabilities,
    });
    let object = value.as_object_mut().expect("model JSON is an object");
    insert_optional_number(object, "contextWindow", model.context_window);
    insert_optional_number(object, "maxTokens", model.max_tokens);
    insert_optional_number(object, "timeoutMs", model.timeout_ms);
    insert_optional_text(object, "aspectRatio", model.aspect_ratio.as_deref());
    insert_optional_text(object, "resolution", model.resolution.as_deref());
    insert_optional_text(object, "quality", model.quality.as_deref());
    value
}

fn draft_json(model: &ProviderModelDiscoveryView) -> Value {
    let mut value = json!({
        "modelId": model.model_id,
        "capabilities": model.capabilities,
    });
    let object = value
        .as_object_mut()
        .expect("model draft JSON is an object");
    insert_optional_number(object, "contextWindow", model.context_window);
    insert_optional_number(object, "maxTokens", model.max_tokens);
    insert_optional_number(object, "timeoutMs", model.timeout_ms);
    insert_optional_text(object, "aspectRatio", model.aspect_ratio.as_deref());
    insert_optional_text(object, "resolution", model.resolution.as_deref());
    insert_optional_text(object, "quality", model.quality.as_deref());
    value
}

fn selectable_model_json(model: &SelectableProviderModelView) -> Value {
    let mut value = model_json(&model.model);
    value
        .as_object_mut()
        .expect("model JSON is an object")
        .insert(
            "selectionId".into(),
            Value::String(model.selection_id.clone()),
        );
    value
        .as_object_mut()
        .expect("model JSON is an object")
        .insert(
            "modelReferences".into(),
            Value::Array(
                model
                    .model_references
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    value
}

fn insert_optional_number(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<u64>,
) {
    if let Some(value) = value {
        object.insert(key.into(), Value::Number(value.into()));
    }
}

fn insert_optional_text(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&str>,
) {
    if let Some(value) = value {
        object.insert(key.into(), Value::String(value.to_owned()));
    }
}

#[cfg(test)]
impl ProviderModelsRequest {
    fn decode_semantics_for_test(value: Value) -> Result<Self, RequestError> {
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn strict_request_decoding_accepts_public_replace_payload() {
        let request = json!({
            "id": "provider.models",
            "operationId": "providerModels.replace",
            "scope": { "kind": "provider-model-catalog" },
            "target": { "kind": "provider-models" },
            "input": {
                "kind": "replace",
                "accountId": "custom-00000000-0000-4000-8000-000000000000",
                "models": [{
                    "modelId": "glm-5.2",
                    "capabilities": ["chat", "imageUnderstand"],
                    "contextWindow": 102400,
                    "maxTokens": 65536
                }]
            },
        });
        assert!(ProviderModelsRequest::decode_semantics_for_test(request).is_ok());
    }

    #[test]
    fn strict_request_decoding_accepts_public_discover_payload() {
        let request = json!({
            "id": "provider.models",
            "operationId": "providerModels.discover",
            "scope": { "kind": "provider-model-catalog" },
            "target": { "kind": "provider-models" },
            "input": { "kind": "discover", "accountId": "account-main" },
        });
        assert!(ProviderModelsRequest::decode_semantics_for_test(request).is_ok());
    }

    #[test]
    fn strict_discover_request_decoding_rejects_secret_and_unknown_fields() {
        let invalid = json!({
            "id": "provider.models",
            "operationId": "providerModels.discover",
            "scope": { "kind": "provider-model-catalog" },
            "target": { "kind": "provider-models" },
            "input": { "kind": "discover", "accountId": "account-main", "apiKey": "sk-private" },
        });
        assert!(matches!(
            ProviderModelsRequest::decode_semantics_for_test(invalid),
            Err(RequestError::Invalid)
        ));
    }

    #[test]
    fn strict_request_decoding_rejects_secret_and_unknown_fields() {
        let invalid = json!({
            "id": "provider.models",
            "operationId": "providerModels.replace",
            "scope": { "kind": "provider-model-catalog" },
            "target": { "kind": "provider-models" },
            "input": {
                "kind": "replace",
                "accountId": "account-main",
                "models": [{ "modelId": "gpt", "capabilities": ["chat"], "baseUrl": "https://secret.example" }]
            },
        });
        assert!(matches!(
            ProviderModelsRequest::decode_semantics_for_test(invalid),
            Err(RequestError::Invalid)
        ));
    }

    #[test]
    fn discovery_response_is_draft_only_and_redacted() {
        let response =
            ProviderModelsDelivery::Discover(ProviderModelDiscoverOutcome::Discovered(vec![
                ProviderModelDiscoveryView {
                    model_id: "gpt-test".into(),
                    capabilities: vec!["chat"],
                    context_window: Some(128000),
                    max_tokens: Some(4096),
                    timeout_ms: None,
                    aspect_ratio: None,
                    resolution: None,
                    quality: None,
                },
            ]));

        assert_eq!(response.status_code(), 200);
        assert_eq!(
            response.body(),
            json!({
                "models": [{
                    "modelId": "gpt-test",
                    "capabilities": ["chat"],
                    "contextWindow": 128000,
                    "maxTokens": 4096,
                }],
            })
        );
        let encoded = response.body().to_string();
        assert!(!encoded.contains("accountId"));
        assert!(!encoded.contains("label"));
        assert!(!encoded.contains("baseUrl"));
        assert!(!encoded.contains("header"));
        assert!(!encoded.contains("apiKey"));
    }

    #[test]
    fn discovery_rejection_uses_public_error_only() {
        let response = ProviderModelsDelivery::Discover(ProviderModelDiscoverOutcome::Rejected);

        assert_eq!(response.status_code(), 422);
        assert_eq!(
            response.body(),
            json!({ "success": false, "error": "Provider model request was rejected" })
        );
    }

    #[test]
    fn replacement_response_separates_durable_native_and_commit_planes() {
        let response =
            ProviderModelsDelivery::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Confirmed,
                native: ProviderNativeConfigurationView::unavailable(),
                commit: ProviderCommitOutcome::Committed,
            });
        assert_eq!(response.status_code(), 200);
        assert_eq!(
            response.body(),
            json!({
                "success": true,
                "desired": { "status": "stored" },
                "persisted": { "status": "confirmed" },
                "native": {
                    "changed": false,
                    "applied": { "status": "unknown" },
                    "observed": { "status": "unavailable" },
                },
                "commit": "committed",
            })
        );
    }

    #[test]
    fn replacement_unknown_commit_is_conflict_and_redacted() {
        let response =
            ProviderModelsDelivery::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Unknown,
                native: ProviderNativeConfigurationView::unavailable(),
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            });
        assert_eq!(response.status_code(), 409);
        assert_eq!(response.body()["code"], "commit-outcome-unknown");
        assert_eq!(response.body()["receipt"]["persisted"]["status"], "unknown");
    }

    #[test]
    fn native_diagnostic_public_response_preserves_head_fields() {
        let response =
            ProviderModelsDelivery::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Unknown,
                native: provider_native_view_with_private_diagnostic(),
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            });
        assert_eq!(
            response.body()["receipt"]["native"]["diagnostic"],
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

    #[test]
    fn public_model_json_excludes_private_projection_fields() {
        let model = ProviderModelView {
            account_id: "account-main".into(),
            label: "Main provider".into(),
            model_id: "gpt-test".into(),
            capabilities: vec!["chat"],
            context_window: None,
            max_tokens: None,
            timeout_ms: None,
            aspect_ratio: None,
            resolution: None,
            quality: None,
        };
        let encoded = model_json(&model).to_string();
        assert!(!encoded.contains("credential"));
        assert!(!encoded.contains("baseUrl"));
        assert!(!encoded.contains("header"));
        assert!(!encoded.contains("apiKey"));
    }

    #[test]
    fn post_selectable_keeps_selection_id_separate_from_runtime_reference() {
        let post =
            ProviderModelsDelivery::Selectable(ProviderModelSelectableOutcome::Available(vec![
                SelectableProviderModelView {
                    model: ProviderModelView {
                        account_id: "account-main".into(),
                        label: "Main provider".into(),
                        model_id: "gpt-test".into(),
                        capabilities: vec!["chat"],
                        context_window: None,
                        max_tokens: None,
                        timeout_ms: None,
                        aspect_ratio: None,
                        resolution: None,
                        quality: None,
                    },
                    selection_id:
                        "model-selection:v1:6666666666666666666666666666666666666666666666666666666666666666".into(),
                    model_references: vec!["openai/gpt-test".into()],
                },
            ]));

        assert_eq!(
            post.body(),
            json!({
                "models": [{
                    "accountId": "account-main",
                    "label": "Main provider",
                    "modelId": "gpt-test",
                    "capabilities": ["chat"],
                    "selectionId": "model-selection:v1:6666666666666666666666666666666666666666666666666666666666666666",
                    "modelReferences": ["openai/gpt-test"],
                }],
            })
        );
        assert!(!post.body().to_string().contains("runtimeModelRef"));
    }
}
