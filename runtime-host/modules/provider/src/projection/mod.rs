pub(crate) mod accounts;
pub(crate) mod models;
pub(crate) mod routing;

use serde_json::{Value, json};

use crate::{
    ProviderCommitOutcome, ProviderNativeConfigurationDiagnosticView,
    ProviderNativeConfigurationView, ProviderPersistedOutcome,
};

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
