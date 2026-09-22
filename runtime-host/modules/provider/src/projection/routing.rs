use serde_json::{Value, json};

use crate::{
    ProviderCommitOutcome, ProviderModelReferenceView, ProviderNativeConfigurationView,
    ProviderPersistedOutcome, ProviderRoutingListOutcome, ProviderRoutingReplaceOutcome,
    ProviderRoutingRevision, ProviderRoutingView,
};

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
            } => replace_body(*revision, *persisted, native.clone(), *commit),
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::Unavailable,
                ..
            }
            | Self::Unavailable => super::fixed_error("Provider routing is unavailable"),
            Self::Replace {
                outcome: ProviderRoutingReplaceOutcome::Rejected,
                ..
            } => super::fixed_error("Provider routing request was rejected"),
        }
    }
}

impl From<ProviderRoutingListOutcome> for ProviderRoutingDelivery {
    fn from(outcome: ProviderRoutingListOutcome) -> Self {
        match outcome {
            ProviderRoutingListOutcome::Desired(routing) => Self::List(routing),
            ProviderRoutingListOutcome::Unavailable => Self::Unavailable,
        }
    }
}

fn replace_body(
    revision: ProviderRoutingRevision,
    persisted: ProviderPersistedOutcome,
    native: ProviderNativeConfigurationView,
    commit: ProviderCommitOutcome,
) -> Value {
    let receipt = json!({
        "desired": { "status": "stored", "revision": revision.get() },
        "persisted": super::persisted_json(persisted),
        "native": super::native_json(native),
        "commit": super::commit_name(commit),
    });
    if super::mutation_unknown(persisted, commit) {
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
