use serde_json::{Value, json};

use crate::{
    ProviderModelCapability, ProviderModelDiscoverOutcome, ProviderModelDiscoveryView,
    ProviderModelListOutcome, ProviderModelReplaceOutcome, ProviderModelSelectableOutcome,
    ProviderModelView, SelectableProviderModelView,
};

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
            }) if !super::mutation_unknown(*persisted, *commit) => 200,
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
                    "persisted": super::persisted_json(*persisted),
                    "native": super::native_json(native.clone()),
                    "commit": super::commit_name(*commit),
                });
                if super::mutation_unknown(*persisted, *commit) {
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
                super::fixed_error("Provider model request was rejected")
            }
            Self::Replace(ProviderModelReplaceOutcome::Unavailable) => {
                super::fixed_error("Provider models are unavailable")
            }
            Self::List(ProviderModelListOutcome::Unavailable)
            | Self::Selectable(ProviderModelSelectableOutcome::Unavailable)
            | Self::Discover(ProviderModelDiscoverOutcome::Unavailable)
            | Self::Unavailable => super::fixed_error("Provider models are unavailable"),
        }
    }
}

pub(crate) fn capability_for(value: &str) -> Option<ProviderModelCapability> {
    match value {
        "chat" => Some(ProviderModelCapability::Chat),
        "imageUnderstand" => Some(ProviderModelCapability::ImageUnderstand),
        "imageGenerate" => Some(ProviderModelCapability::ImageGenerate),
        "videoGenerate" => Some(ProviderModelCapability::VideoGenerate),
        "musicGenerate" => Some(ProviderModelCapability::MusicGenerate),
        "tts" => Some(ProviderModelCapability::TextToSpeech),
        "transcribe" => Some(ProviderModelCapability::Transcribe),
        _ => None,
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
