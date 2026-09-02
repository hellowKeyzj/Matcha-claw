use serde::Deserialize;
use serde_json::{Value, json};

use openclaw::port::{
    AppliedStatus, ObservedStatus, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEffect,
};

use crate::{
    provider::accounts::{ProviderCommitOutcome, ProviderPersistedOutcome},
    provider::models::{
        ProviderModelDraft, ProviderModelListOutcome, ProviderModelReplaceOutcome,
        ProviderModelSelectableOutcome, ProviderModelView, SelectableProviderModelView,
    },
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "provider.models";
const AUTHORIZATION_ENDPOINT: &str = "/api/provider-models";
const AUTHORIZATION_SCOPE: &str = "providers:models";
const AUTHORIZATION_SUBJECT: &str = "provider-models";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
    Unavailable,
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
    Replace(ProviderModelReplaceOutcome),
    Unavailable,
}

impl ProviderModelsDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::List(ProviderModelListOutcome::Available(_))
            | Self::Selectable(ProviderModelSelectableOutcome::Available(_)) => 200,
            Self::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted, commit, ..
            }) if !mutation_unknown(*persisted, *commit) => 200,
            Self::Replace(ProviderModelReplaceOutcome::DesiredStored { .. }) => 409,
            Self::Replace(ProviderModelReplaceOutcome::Rejected) => 422,
            Self::List(ProviderModelListOutcome::Unavailable)
            | Self::Selectable(ProviderModelSelectableOutcome::Unavailable)
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
            Self::Replace(ProviderModelReplaceOutcome::Unavailable) => {
                fixed_error("Provider models are unavailable")
            }
            Self::Replace(ProviderModelReplaceOutcome::Rejected) => {
                fixed_error("Provider model request was rejected")
            }
            Self::List(ProviderModelListOutcome::Unavailable)
            | Self::Selectable(ProviderModelSelectableOutcome::Unavailable)
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

fn native_json(effect: ProviderNativeConfigurationEffect) -> Value {
    match effect {
        ProviderNativeConfigurationEffect::Evidence(evidence) => {
            let mut value = json!({
                "changed": evidence.changed(),
                "applied": { "status": applied_status(evidence.applied()) },
                "observed": { "status": observed_status(evidence.observed()) },
            });
            if let Some(diagnostic) = evidence.diagnostic() {
                value
                    .as_object_mut()
                    .expect("provider native JSON is an object")
                    .insert("diagnostic".into(), native_diagnostic_json(diagnostic));
            }
            value
        }
        ProviderNativeConfigurationEffect::Unavailable => json!({
            "changed": false,
            "applied": { "status": "unknown" },
            "observed": { "status": "unavailable" },
        }),
    }
}

fn native_diagnostic_json(diagnostic: &ProviderNativeConfigurationDiagnostic) -> Value {
    let mut value = json!({
        "phase": diagnostic.phase(),
        "reason": diagnostic.reason(),
        "configPath": diagnostic.config_path(),
    });
    let object = value
        .as_object_mut()
        .expect("provider native diagnostic JSON is an object");
    if let Some(method) = diagnostic.method() {
        object.insert("method".into(), Value::String(method.to_owned()));
    }
    if let Some(expected_path) = diagnostic.expected_path() {
        object.insert(
            "expectedPath".into(),
            Value::String(expected_path.to_owned()),
        );
    }
    if let Some(detail) = diagnostic.detail() {
        object.insert("detail".into(), Value::String(detail.to_owned()));
    }
    value
}

const fn applied_status(status: AppliedStatus) -> &'static str {
    match status {
        AppliedStatus::Confirmed => "confirmed",
        AppliedStatus::Unknown => "unknown",
    }
}

const fn observed_status(status: ObservedStatus) -> &'static str {
    match status {
        ObservedStatus::Matches => "matches",
        ObservedStatus::Mismatch => "mismatch",
        ObservedStatus::Unavailable => "unavailable",
    }
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
        "capabilities": model.capabilities.iter().map(capability_name).collect::<Vec<_>>(),
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

fn capability_for(value: &str) -> Option<environment::ProviderModelCapability> {
    match value {
        "chat" => Some(environment::ProviderModelCapability::Chat),
        "imageUnderstand" => Some(environment::ProviderModelCapability::ImageUnderstand),
        "imageGenerate" => Some(environment::ProviderModelCapability::ImageGenerate),
        "videoGenerate" => Some(environment::ProviderModelCapability::VideoGenerate),
        "musicGenerate" => Some(environment::ProviderModelCapability::MusicGenerate),
        "tts" => Some(environment::ProviderModelCapability::TextToSpeech),
        "transcribe" => Some(environment::ProviderModelCapability::Transcribe),
        _ => None,
    }
}

fn capability_name(capability: &environment::ProviderModelCapability) -> &'static str {
    match capability {
        environment::ProviderModelCapability::Chat => "chat",
        environment::ProviderModelCapability::ImageUnderstand => "imageUnderstand",
        environment::ProviderModelCapability::ImageGenerate => "imageGenerate",
        environment::ProviderModelCapability::VideoGenerate => "videoGenerate",
        environment::ProviderModelCapability::MusicGenerate => "musicGenerate",
        environment::ProviderModelCapability::TextToSpeech => "tts",
        environment::ProviderModelCapability::Transcribe => "transcribe",
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
    fn replacement_response_separates_durable_native_and_commit_planes() {
        let response =
            ProviderModelsDelivery::Replace(ProviderModelReplaceOutcome::DesiredStored {
                persisted: ProviderPersistedOutcome::Confirmed,
                native: ProviderNativeConfigurationEffect::Unavailable,
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
                native: ProviderNativeConfigurationEffect::Unavailable,
                commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            });
        assert_eq!(response.status_code(), 409);
        assert_eq!(response.body()["code"], "commit-outcome-unknown");
        assert_eq!(response.body()["receipt"]["persisted"]["status"], "unknown");
    }

    #[test]
    fn public_model_json_excludes_private_projection_fields() {
        let model = ProviderModelView {
            account_id: "account-main".into(),
            label: "Main provider".into(),
            model_id: "gpt-test".into(),
            capabilities: vec![environment::ProviderModelCapability::Chat],
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
                        capabilities: vec![environment::ProviderModelCapability::Chat],
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
