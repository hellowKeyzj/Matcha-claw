use std::{collections::{BTreeMap, BTreeSet}, path::PathBuf, sync::Arc};

use environment::{ProviderAccount, ProviderModelCatalog, ProviderRouting};
use serde_json::{Map, Value};
use zeroize::Zeroize;

use crate::{
    gateway::{
        client::GatewayClient,
        delivery::MutationDelivery,
        wire::{self, GatewayResponse},
    },
    lifecycle::state_dir::CanonicalStateDir,
    projection::{
        config_store::OpenClawConfigDocument,
        provider_models::{ProviderModelProjection, canonical_provider_keys},
        routing::ProviderRoutingProjection,
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppliedStatus {
    Confirmed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservedStatus {
    Matches,
    Mismatch,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderNativeConfigurationEvidence {
    changed: bool,
    applied: AppliedStatus,
    observed: ObservedStatus,
    diagnostic: Option<ProviderNativeConfigurationDiagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderNativeConfigurationDiagnostic {
    phase: &'static str,
    reason: &'static str,
    config_path: String,
    method: Option<&'static str>,
    expected_path: Option<&'static str>,
    detail: Option<String>,
}

impl ProviderNativeConfigurationEvidence {
    pub const fn new(changed: bool, applied: AppliedStatus, observed: ObservedStatus) -> Self {
        Self {
            changed,
            applied,
            observed,
            diagnostic: None,
        }
    }

    pub fn with_diagnostic(
        changed: bool,
        applied: AppliedStatus,
        observed: ObservedStatus,
        diagnostic: ProviderNativeConfigurationDiagnostic,
    ) -> Self {
        Self {
            changed,
            applied,
            observed,
            diagnostic: Some(diagnostic),
        }
    }

    pub const fn changed(&self) -> bool {
        self.changed
    }

    pub const fn applied(&self) -> AppliedStatus {
        self.applied
    }

    pub const fn observed(&self) -> ObservedStatus {
        self.observed
    }

    pub const fn diagnostic(&self) -> Option<&ProviderNativeConfigurationDiagnostic> {
        self.diagnostic.as_ref()
    }
}

impl ProviderNativeConfigurationDiagnostic {
    pub fn new(
        phase: &'static str,
        reason: &'static str,
        config_path: String,
        method: Option<&'static str>,
        expected_path: Option<&'static str>,
        detail: Option<String>,
    ) -> Self {
        Self {
            phase,
            reason,
            config_path,
            method,
            expected_path,
            detail,
        }
    }

    pub const fn phase(&self) -> &'static str {
        self.phase
    }

    pub const fn reason(&self) -> &'static str {
        self.reason
    }

    pub fn config_path(&self) -> &str {
        &self.config_path
    }

    pub const fn method(&self) -> Option<&'static str> {
        self.method
    }

    pub const fn expected_path(&self) -> Option<&'static str> {
        self.expected_path
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

pub struct ProviderNativeConfigurationOperation {
    gateway: Arc<GatewayClient>,
    state_dir: CanonicalStateDir,
}

impl ProviderNativeConfigurationOperation {
    pub fn new(gateway: Arc<GatewayClient>, state_dir: CanonicalStateDir) -> Self {
        Self { gateway, state_dir }
    }

    pub async fn reconcile(
        &self,
        accounts: &[ProviderAccount],
        models: &ProviderModelCatalog,
        routing: Option<&ProviderRouting>,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> ProviderNativeConfigurationEvidence {
        eprintln!(
            "[startup-trace] source=openclaw-provider-config phase=start detail=reconcile-provider-config config_path={} accounts={} retired={} routing={}",
            self.config_path(),
            accounts.len(),
            retired.len(),
            routing.is_some()
        );
        let provider_keys = match canonical_provider_keys(accounts, retired) {
            Ok(keys) => keys,
            Err(_) => return self.unavailable_evidence(false, "provider-keys", "invalid-provider-key", None),
        };
        let (mut document, base_hash) = match self
            .read_snapshot("config-get", "config-snapshot-unavailable")
            .await
        {
            Ok(snapshot) => (snapshot.document, snapshot.base_hash),
            Err(diagnostic) => {
                return ProviderNativeConfigurationEvidence::with_diagnostic(
                    false,
                    AppliedStatus::Unknown,
                    ObservedStatus::Unavailable,
                    diagnostic,
                );
            }
        };
        let mut expected = match OpenClawConfigDocument::from_value(document.clone()) {
            Ok(document) => document,
            Err(_) => {
                zeroize_value(&mut document);
                return self.unavailable_evidence(false, "config-decode", "invalid-config-document", None);
            }
        };
        if let Err(error) = apply_provider_projection(
            &self.state_dir,
            &mut expected,
            accounts,
            models,
            routing,
            retired,
            required_auth_accounts,
            now_millis,
        ) {
            zeroize_value(&mut document);
            return self.unavailable_evidence(
                false,
                "build-projection",
                "projection-build-failed",
                Some(error),
            );
        }
        let mut expected_document = expected.as_value();
        let expected_view = canonical_provider_configuration(&expected_document, &provider_keys);
        let mut patch = merge_patch(&document, &expected_document);
        let changed = !empty_object(&patch);
        let apply_required = changed && changes_id_keyed_array(&document, &expected_document);
        zeroize_value(&mut document);

        let mut applied = AppliedStatus::Confirmed;
        let mut write_outcome = WriteOutcome::Confirmed;
        let mut method = "none";
        if changed {
            let serialized = if apply_required {
                serde_json::to_string(&expected_document)
            } else {
                serde_json::to_string(&patch)
            };
            zeroize_value(&mut expected_document);
            zeroize_value(&mut patch);
            let raw = match serialized {
                Ok(raw) if !raw.is_empty() => raw,
                _ => return self.unavailable_evidence(true, "serialize", "projection-serialize-failed", None),
            };
            let document = match wire::team::ConfigDocument::new(raw) {
                Ok(document) => document,
                Err(_) => return self.unavailable_evidence(true, "encode-document", "config-document-invalid", None),
            };
            let (selected_method, status, outcome) = if apply_required {
                let request = match wire::team::config_apply_request(
                    next_request_id("provider-config-apply"),
                    document,
                    base_hash,
                ) {
                    Ok(request) => request,
                    Err(_) => return self.unavailable_evidence(true, "config.apply", "request-build-failed", None),
                };
                eprintln!(
                    "[startup-trace] source=openclaw-provider-config phase=config.apply detail=write-request config_path={}",
                    self.config_path()
                );
                let (status, outcome) = self.write_apply(request).await;
                ("config.apply", status, outcome)
            } else {
                let request = match wire::team::config_patch_request(
                    next_request_id("provider-config-patch"),
                    document,
                    base_hash,
                ) {
                    Ok(request) => request,
                    Err(_) => return self.unavailable_evidence(true, "config.patch", "request-build-failed", None),
                };
                eprintln!(
                    "[startup-trace] source=openclaw-provider-config phase=config.patch detail=write-request config_path={}",
                    self.config_path()
                );
                let (status, outcome) = self.write_patch(request).await;
                ("config.patch", status, outcome)
            };
            eprintln!(
                "[startup-trace] source=openclaw-provider-config phase={} detail=write-outcome applied={:?} outcome={:?}",
                selected_method, status, outcome
            );
            applied = status;
            write_outcome = outcome;
            method = selected_method;
        } else {
            zeroize_value(&mut expected_document);
            zeroize_value(&mut patch);
        }

        let mut diagnostic = write_outcome.diagnostic(self.config_path(), method);

        let observed = match (changed, write_outcome) {
            (false, WriteOutcome::Confirmed) => ObservedStatus::Matches,
            (true, WriteOutcome::Confirmed) => match self
                .read_snapshot("readback", "config-readback-unavailable")
                .await
            {
                Ok(readback) => {
                    let mut view = canonical_provider_configuration(&readback.document, &provider_keys);
                    remove_unowned_model_metadata(&mut view, &expected_view);
                    let status = if view == expected_view {
                        eprintln!(
                            "[startup-trace] source=openclaw-provider-config phase=readback detail=config-readback-matches config_path={} method={}",
                            self.config_path(), method
                        );
                        ObservedStatus::Matches
                    } else {
                        eprintln!(
                            "[startup-trace] source=openclaw-provider-config phase=readback detail=config-readback-mismatch config_path={} method={}",
                            self.config_path(), method
                        );
                        diagnostic = Some(ProviderNativeConfigurationDiagnostic::new(
                            "readback",
                            "config-readback-mismatch",
                            self.config_path(),
                            Some(method),
                            Some(PROVIDER_CONFIGURATION_PATH),
                            None,
                        ));
                        ObservedStatus::Mismatch
                    };
                    let mut document = readback.document;
                    zeroize_value(&mut document);
                    status
                }
                Err(readback_diagnostic) => {
                    eprintln!(
                        "[startup-trace] source=openclaw-provider-config phase=readback detail=config-readback-unavailable config_path={} method={}",
                        self.config_path(), method
                    );
                    diagnostic = Some(readback_diagnostic);
                    ObservedStatus::Unavailable
                }
            },
            (_, WriteOutcome::Rejected(_) | WriteOutcome::Unknown(_)) => {
                if let Ok(mut readback) = self
                    .read_snapshot("readback", "config-readback-unavailable")
                    .await
                {
                    zeroize_value(&mut readback.document);
                }
                ObservedStatus::Unavailable
            }
        };
        ProviderNativeConfigurationEvidence {
            changed,
            applied,
            observed,
            diagnostic,
        }
    }

    fn config_path(&self) -> String {
        let mut path = PathBuf::from(self.state_dir.as_path());
        path.push("openclaw.json");
        path.display().to_string()
    }

    fn unavailable_evidence(
        &self,
        changed: bool,
        phase: &'static str,
        reason: &'static str,
        detail: Option<String>,
    ) -> ProviderNativeConfigurationEvidence {
        ProviderNativeConfigurationEvidence::with_diagnostic(
            changed,
            AppliedStatus::Unknown,
            ObservedStatus::Unavailable,
            ProviderNativeConfigurationDiagnostic::new(
                phase,
                reason,
                self.config_path(),
                None,
                Some(PROVIDER_CONFIGURATION_PATH),
                detail,
            ),
        )
    }

    async fn read_snapshot(
        &self,
        phase: &'static str,
        reason: &'static str,
    ) -> Result<NativeConfigSnapshot, ProviderNativeConfigurationDiagnostic> {
        eprintln!(
            "[startup-trace] source=openclaw-provider-config phase={} detail=config-get-request config_path={}",
            phase,
            self.config_path()
        );
        let request = wire::team::config_get_request(next_request_id("provider-config-get"))
            .map_err(|_| self.config_get_diagnostic(phase, reason, Some("request-build-failed".to_owned())))?;
        let response = self.gateway.rpc_query(request).await.map_err(|error| {
            self.config_get_diagnostic(phase, reason, Some(error.to_string()))
        })?;
        let snapshot = wire::team::decode_config_get(response).map_err(|_| {
            self.config_get_diagnostic(phase, reason, Some("invalid config.get response".to_owned()))
        })?;
        let (document, base_hash) = snapshot.into_config_parts();
        if !document.is_object() {
            let mut document = document;
            zeroize_value(&mut document);
            return Err(self.config_get_diagnostic(
                phase,
                "invalid-config-document",
                Some("config.get returned a non-object document".to_owned()),
            ));
        }
        eprintln!(
            "[startup-trace] source=openclaw-provider-config phase={} detail=config-get-success config_path={} base_hash_present={}",
            phase,
            self.config_path(),
            base_hash.is_some()
        );
        Ok(NativeConfigSnapshot {
            document,
            base_hash,
        })
    }

    fn config_get_diagnostic(
        &self,
        phase: &'static str,
        reason: &'static str,
        detail: Option<String>,
    ) -> ProviderNativeConfigurationDiagnostic {
        eprintln!(
            "[startup-trace] source=openclaw-provider-config phase={} detail={} config_path={} error={}",
            phase,
            reason,
            self.config_path(),
            detail.as_deref().unwrap_or("none")
        );
        ProviderNativeConfigurationDiagnostic::new(
            phase,
            reason,
            self.config_path(),
            Some("config.get"),
            Some(PROVIDER_CONFIGURATION_PATH),
            detail,
        )
    }

    async fn write_patch(
        &self,
        request: wire::team::ConfigPatchRequest,
    ) -> (AppliedStatus, WriteOutcome) {
        match self
            .gateway
            .rpc_encoded_mutation(
                request.request_id().to_owned(),
                match request.encode() {
                    Ok(encoded) => encoded,
                    Err(_) => return (AppliedStatus::Unknown, WriteOutcome::Rejected(Some("request-encode-failed".to_owned()))),
                },
            )
            .await
        {
            MutationDelivery::Response(response) => match response {
                GatewayResponse::Failure { error, .. } => (
                    AppliedStatus::Unknown,
                    WriteOutcome::Rejected(Some(format!("{}: {}", error.code(), error.message()))),
                ),
                response => match wire::team::decode_config_patch(response) {
                    Ok(_) => (AppliedStatus::Confirmed, WriteOutcome::Confirmed),
                    Err(_) => (AppliedStatus::Unknown, WriteOutcome::Unknown(Some("invalid config.patch response".to_owned()))),
                },
            },
            MutationDelivery::NotWritten(error) => (AppliedStatus::Unknown, WriteOutcome::Rejected(Some(error.to_string()))),
            MutationDelivery::MayHaveReached(error) => (AppliedStatus::Unknown, WriteOutcome::Unknown(Some(error.to_string()))),
        }
    }

    async fn write_apply(
        &self,
        request: wire::team::ConfigApplyRequest,
    ) -> (AppliedStatus, WriteOutcome) {
        match self
            .gateway
            .rpc_encoded_mutation(
                request.request_id().to_owned(),
                match request.encode() {
                    Ok(encoded) => encoded,
                    Err(_) => return (AppliedStatus::Unknown, WriteOutcome::Rejected(Some("request-encode-failed".to_owned()))),
                },
            )
            .await
        {
            MutationDelivery::Response(response) => match response {
                GatewayResponse::Failure { error, .. } => (
                    AppliedStatus::Unknown,
                    WriteOutcome::Rejected(Some(format!("{}: {}", error.code(), error.message()))),
                ),
                response => match wire::team::decode_config_apply(response) {
                    Ok(_) => (AppliedStatus::Confirmed, WriteOutcome::Confirmed),
                    Err(_) => (AppliedStatus::Unknown, WriteOutcome::Unknown(Some("invalid config.apply response".to_owned()))),
                },
            },
            MutationDelivery::NotWritten(error) => (AppliedStatus::Unknown, WriteOutcome::Rejected(Some(error.to_string()))),
            MutationDelivery::MayHaveReached(error) => (AppliedStatus::Unknown, WriteOutcome::Unknown(Some(error.to_string()))),
        }
    }
}

struct NativeConfigSnapshot {
    document: Value,
    base_hash: Option<wire::team::ConfigBaseHash>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum WriteOutcome {
    Confirmed,
    Rejected(Option<String>),
    Unknown(Option<String>),
}

impl WriteOutcome {
    fn diagnostic(
        &self,
        config_path: String,
        method: &'static str,
    ) -> Option<ProviderNativeConfigurationDiagnostic> {
        match self {
            Self::Confirmed => None,
            Self::Rejected(detail) => Some(ProviderNativeConfigurationDiagnostic::new(
                method,
                "gateway-write-rejected",
                config_path,
                Some(method),
                Some(PROVIDER_CONFIGURATION_PATH),
                detail.clone(),
            )),
            Self::Unknown(detail) => Some(ProviderNativeConfigurationDiagnostic::new(
                method,
                "gateway-write-unknown",
                config_path,
                Some(method),
                Some(PROVIDER_CONFIGURATION_PATH),
                detail.clone(),
            )),
        }
    }
}

const PROVIDER_CONFIGURATION_PATH: &str = "models.providers";

fn apply_provider_projection(
    state_dir: &CanonicalStateDir,
    document: &mut OpenClawConfigDocument,
    accounts: &[ProviderAccount],
    models: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    retired: &[ProviderAccount],
    required_auth_accounts: &BTreeSet<environment::ProviderAccountId>,
    now_millis: u64,
) -> Result<bool, String> {
    let models_changed = ProviderModelProjection::apply_to_document(
        state_dir, document, accounts, models, retired, required_auth_accounts, now_millis,
    )
    .map_err(|error| error.to_string())?;
    let routing_changed = routing
        .map(|routing| {
            ProviderRoutingProjection::apply_to_document(
                state_dir, document, accounts, models, routing, now_millis,
            )
            .map_err(|error| error.to_string())
        })
        .transpose()?
        .unwrap_or(false);
    Ok(models_changed || routing_changed)
}

fn merge_patch(current: &Value, target: &Value) -> Value {
    let (Some(current), Some(target)) = (current.as_object(), target.as_object()) else {
        return if current == target {
            Value::Object(Map::new())
        } else {
            target.clone()
        };
    };
    let mut patch = Map::new();
    for (key, target_value) in target {
        match current.get(key) {
            Some(current_value) if current_value == target_value => {}
            Some(current_value) if current_value.is_object() && target_value.is_object() => {
                let value = merge_patch(current_value, target_value);
                if !empty_object(&value) {
                    patch.insert(key.clone(), value);
                }
            }
            _ => {
                patch.insert(key.clone(), target_value.clone());
            }
        }
    }
    for key in current.keys() {
        if !target.contains_key(key) {
            patch.insert(key.clone(), Value::Null);
        }
    }
    Value::Object(patch)
}

fn empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(|object| object.is_empty())
}

fn changes_id_keyed_array(current: &Value, target: &Value) -> bool {
    match (current, target) {
        (Value::Array(current), Value::Array(target)) => {
            !current.is_empty() && current != target && current.iter().all(object_with_string_id)
        }
        (Value::Object(current), Value::Object(target)) => target.iter().any(|(key, target)| {
            current
                .get(key)
                .is_some_and(|current| changes_id_keyed_array(current, target))
        }),
        _ => false,
    }
}

fn object_with_string_id(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .is_some()
}

fn canonical_provider_configuration(document: &Value, provider_keys: &BTreeSet<String>) -> Value {
    let mut result = Map::new();
    if let Some(models) = document.get("models").and_then(Value::as_object) {
        let providers = models
            .get("providers")
            .and_then(Value::as_object)
            .map(|providers| {
                providers
                    .iter()
                    .filter(|(key, _)| provider_keys.iter().any(|candidate| candidate == *key))
                    .map(|(key, value)| (key.clone(), canonical_provider_entry(value)))
                    .collect::<Map<_, _>>()
            })
            .unwrap_or_default();
        result.insert("providers".into(), Value::Object(providers));
    }
    if let Some(agents) = document.get("agents").and_then(Value::as_object) {
        let defaults = selected_fields(
            agents.get("defaults"),
            &[
                "model",
                "models",
                "imageModel",
                "imageGenerationModel",
                "videoGenerationModel",
                "musicGenerationModel",
                "mediaGenerationAutoProviderFallback",
            ],
        );
        let list = agents
            .get("list")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_object)
                    .map(|agent| {
                        selected_fields(Some(&Value::Object(agent.clone())), &["id", "model"])
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        result.insert("agentDefaults".into(), defaults);
        result.insert("agentModels".into(), Value::Array(list));
    }
    if let Some(messages) = document.get("messages").and_then(Value::as_object) {
        result.insert(
            "ttsProvider".into(),
            messages
                .get("tts")
                .and_then(Value::as_object)
                .and_then(|tts| tts.get("provider"))
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    if let Some(plugins) = document.get("plugins").and_then(Value::as_object) {
        result.insert(
            "mediaPluginAllow".into(),
            plugins.get("allow").cloned().unwrap_or(Value::Null),
        );
        if let Some(plugin) = plugins
            .get("entries")
            .and_then(Value::as_object)
            .and_then(|entries| entries.get("matchaclaw-media"))
        {
            result.insert("mediaPlugin".into(), redact_value(plugin.clone()));
        }
    }
    redact_value(Value::Object(result))
}

fn canonical_provider_entry(value: &Value) -> Value {
    let Value::Object(entry) = redact_value(value.clone()) else {
        return Value::Null;
    };
    let mut entry = entry;
    if let Some(Value::Array(models)) = entry.get_mut("models") {
        for model in models.iter_mut().filter_map(Value::as_object_mut) {
            model.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "id" | "name" | "input" | "contextWindow" | "maxTokens"
                )
            });
        }
    }
    Value::Object(entry)
}

fn remove_unowned_model_metadata(observed: &mut Value, expected: &Value) {
    let Some(observed_providers) = observed
        .get_mut("providers")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(expected_providers) = expected.get("providers").and_then(Value::as_object) else {
        return;
    };
    for (provider_key, observed_provider) in observed_providers {
        let Some(expected_provider) = expected_providers.get(provider_key) else {
            continue;
        };
        let Some(observed_models) = observed_provider
            .get_mut("models")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let expected_models_by_id = expected_provider
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        Some((model.get("id")?.as_str()?.to_owned(), model.as_object()?))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        for observed_model in observed_models.iter_mut().filter_map(Value::as_object_mut) {
            let expected_model = observed_model
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| expected_models_by_id.get(id));
            observed_model.retain(|key, _| {
                expected_model.is_some_and(|model| model.contains_key(key))
            });
        }
    }
}

fn selected_fields(value: Option<&Value>, fields: &[&str]) -> Value {
    let mut selected = Map::new();
    if let Some(object) = value.and_then(Value::as_object) {
        for field in fields {
            if let Some(value) = object.get(*field)
                && !value.is_null()
            {
                selected.insert((*field).to_owned(), redact_value(value.clone()));
            }
        }
    }
    Value::Object(selected)
}

fn redact_value(mut value: Value) -> Value {
    redact_in_place(&mut value);
    value
}

fn redact_in_place(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, value| {
                if is_sensitive_key(key) {
                    zeroize_value(value);
                    false
                } else {
                    true
                }
            });
            object.values_mut().for_each(redact_in_place);
        }
        Value::Array(values) => values.iter_mut().for_each(redact_in_place),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "access"
            | "access_token"
            | "access-token"
            | "api_key"
            | "apikey"
            | "api-key"
            | "authorization"
            | "client_secret"
            | "client-secret"
            | "clientsecret"
            | "credential"
            | "key"
            | "password"
            | "proxy-authorization"
            | "refresh"
            | "refresh_token"
            | "refresh-token"
            | "secret"
            | "token"
            | "x-api-key"
    ) || key.eq_ignore_ascii_case("headers")
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn unavailable_evidence(changed: bool) -> ProviderNativeConfigurationEvidence {
    ProviderNativeConfigurationEvidence::new(changed, AppliedStatus::Unknown, ObservedStatus::Unavailable)
}

fn next_request_id(operation: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    format!(
        "matcha-{operation}-{}",
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use environment::{
        ProviderAccountAuthMode, ProviderAccountConfiguration, ProviderAccountConfigurationInput,
        ProviderAccountId, ProviderAccountKind, ProviderAccountRevision, ProviderApiProtocol,
        ProviderEndpoint, ProviderModel, ProviderModelCapability, ProviderReference,
    };
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use crate::gateway::{
        auth::GatewaySecret,
        client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
        wire,
    };

    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn stale_readback_reports_mismatch_without_exposing_secret_material() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let state_dir = test_state_dir();
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let first_read = read_json(&mut socket).await;
            assert_eq!(first_read["method"], "config.get");
            let first_read_id = first_read["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": first_read_id, "ok": true,
                    "payload": config_snapshot(
                        "{\"models\":{\"providers\":{\"ollama-local-ollama\":{\"baseUrl\":\"http://127.0.0.1:11434/v1\",\"apiKey\":\"secret-canary\"}}}}",
                        "hash-1"
                    )
                }),
            )
            .await;
            let write = read_json(&mut socket).await;
            assert_eq!(write["method"], "config.patch");
            assert_eq!(write["params"]["baseHash"], json!("hash-1"));
            let raw = write["params"]["raw"].as_str().unwrap();
            assert!(!raw.contains("secret-canary"));
            let patch: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(
                patch["models"]["providers"]["ollama-local-ollama"]["apiKey"],
                Value::Null
            );
            let write_id = write["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": write_id, "ok": true,
                    "payload": {"ok": true, "path": "openclaw.json", "config": {}}
                }),
            )
            .await;
            let readback = read_json(&mut socket).await;
            assert_eq!(readback["method"], "config.get");
            let readback_id = readback["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": readback_id, "ok": true,
                    "payload": config_snapshot(
                        "{\"models\":{\"providers\":{\"ollama-local-ollama\":{\"baseUrl\":\"http://stale.local/v1\",\"apiKey\":\"secret-canary\"}}}}",
                        "hash-2"
                    )
                }),
            )
            .await;
        });
        let account = account();
        let catalog = ProviderModelCatalog::try_new(vec![model(&account)]).unwrap();

        let evidence = ProviderNativeConfigurationOperation::new(Arc::new(client), state_dir)
            .reconcile(
                std::slice::from_ref(&account),
                &catalog,
                None,
                &[],
                &BTreeSet::from([account.id().clone()]),
                1_800_000_000_000,
            )
            .await;
        server.await.unwrap();

        assert_eq!(evidence.changed(), true);
        assert_eq!(evidence.applied(), AppliedStatus::Confirmed);
        assert_eq!(evidence.observed(), ObservedStatus::Mismatch);
        assert!(!format!("{evidence:?}").contains("secret-canary"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn snapshot_decode_failure_reports_config_get_diagnostic() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let state_dir = test_state_dir();
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let first_read = read_json(&mut socket).await;
            assert_eq!(first_read["method"], "config.get");
            let first_read_id = first_read["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": first_read_id, "ok": true,
                    "payload": {"unexpected": true}
                }),
            )
            .await;
        });
        let account = account();
        let catalog = ProviderModelCatalog::try_new(vec![model(&account)]).unwrap();

        let evidence = ProviderNativeConfigurationOperation::new(Arc::new(client), state_dir)
            .reconcile(
                std::slice::from_ref(&account),
                &catalog,
                None,
                &[],
                &BTreeSet::from([account.id().clone()]),
                1_800_000_000_000,
            )
            .await;
        server.await.unwrap();

        assert_eq!(evidence.changed(), false);
        assert_eq!(evidence.applied(), AppliedStatus::Unknown);
        assert_eq!(evidence.observed(), ObservedStatus::Unavailable);
        assert_eq!(evidence.diagnostic().unwrap().phase(), "config-get");
        assert_eq!(evidence.diagnostic().unwrap().method(), Some("config.get"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn existing_id_keyed_model_array_uses_config_apply_for_exact_replace() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let state_dir = test_state_dir();
        let acceptor = identity.acceptor();
        let current = json!({
            "models": {
                "providers": {
                    "ollama-local-ollama": {
                        "baseUrl": "http://127.0.0.1:11434/v1",
                        "api": "openai-responses",
                        "models": [{"id": "old-model", "name": "old-model", "input": ["text"]}]
                    }
                }
            }
        })
        .to_string();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let first_read = read_json(&mut socket).await;
            assert_eq!(first_read["method"], "config.get");
            let first_read_id = first_read["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": first_read_id, "ok": true,
                    "payload": config_snapshot(&current, "hash-1")
                }),
            )
            .await;
            let write = read_json(&mut socket).await;
            assert_eq!(write["method"], "config.apply");
            assert_eq!(write["params"]["baseHash"], json!("hash-1"));
            let raw = write["params"]["raw"].as_str().unwrap().to_owned();
            assert!(!raw.contains("old-model"));
            let applied: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                applied["models"]["providers"]["ollama-local-ollama"]["models"],
                json!([{
                    "id": "llama-3.3",
                    "name": "llama-3.3",
                    "input": ["text"],
                    "contextWindow": 128000,
                    "maxTokens": 16000
                }])
            );
            let write_id = write["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": write_id, "ok": true,
                    "payload": {"ok": true, "path": "openclaw.json", "config": {}}
                }),
            )
            .await;
            let readback = read_json(&mut socket).await;
            assert_eq!(readback["method"], "config.get");
            let readback_id = readback["id"].as_str().unwrap();
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": readback_id, "ok": true,
                    "payload": config_snapshot(&raw, "hash-2")
                }),
            )
            .await;
        });
        let account = account();
        let catalog = ProviderModelCatalog::try_new(vec![model(&account)]).unwrap();

        let evidence = ProviderNativeConfigurationOperation::new(Arc::new(client), state_dir)
            .reconcile(
                std::slice::from_ref(&account),
                &catalog,
                None,
                &[],
                &BTreeSet::from([account.id().clone()]),
                1_800_000_000_000,
            )
            .await;
        server.await.unwrap();

        assert_eq!(evidence.changed(), true);
        assert_eq!(evidence.applied(), AppliedStatus::Confirmed);
        assert_eq!(evidence.observed(), ObservedStatus::Matches);
    }

    #[test]
    fn readback_mismatch_is_distinct() {
        let expected = canonical_provider_configuration(
            &serde_json::json!({"models":{"providers":{"ollama":{"baseUrl":"https://one.test"}}}}),
            &BTreeSet::from(["ollama".to_owned()]),
        );
        let observed = canonical_provider_configuration(
            &serde_json::json!({"models":{"providers":{"ollama":{"baseUrl":"https://two.test"}}}}),
            &BTreeSet::from(["ollama".to_owned()]),
        );
        assert_ne!(expected, observed);
    }

    #[test]
    fn readback_ignores_openclaw_enriched_model_metadata() {
        let expected = canonical_provider_configuration(
            &serde_json::json!({
                "models": {"providers": {"custom-d9c61292": {
                    "baseUrl": "https://opencode.ai/zen/go/v1",
                    "api": "openai-completions",
                    "models": [{
                        "id": "glm-5.2",
                        "name": "glm-5.2",
                        "input": ["text"],
                        "contextWindow": 256000
                    }]
                }}},
                "agents": {"defaults": {"models": {"custom-d9c61292/glm-5.2": {}}}}
            }),
            &BTreeSet::from(["custom-d9c61292".to_owned()]),
        );
        let mut observed = canonical_provider_configuration(
            &serde_json::json!({
                "models": {"providers": {"custom-d9c61292": {
                    "baseUrl": "https://opencode.ai/zen/go/v1",
                    "api": "openai-completions",
                    "models": [{
                        "id": "glm-5.2",
                        "name": "glm-5.2",
                        "input": ["text"],
                        "contextWindow": 256000,
                        "maxTokens": 8192,
                        "reasoning": false,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                        "api": "openai-completions"
                    }]
                }}},
                "agents": {"defaults": {"models": {"custom-d9c61292/glm-5.2": {}}}}
            }),
            &BTreeSet::from(["custom-d9c61292".to_owned()]),
        );
        remove_unowned_model_metadata(&mut observed, &expected);

        assert_eq!(expected, observed);
    }

    #[test]
    fn readback_preserves_explicit_max_tokens_in_comparison() {
        let expected = canonical_provider_configuration(
            &serde_json::json!({
                "models": {"providers": {"custom-d9c61292": {
                    "baseUrl": "https://opencode.ai/zen/go/v1",
                    "api": "openai-completions",
                    "models": [{
                        "id": "glm-5.2",
                        "name": "glm-5.2",
                        "input": ["text"],
                        "contextWindow": 256000,
                        "maxTokens": 16000
                    }]
                }}}
            }),
            &BTreeSet::from(["custom-d9c61292".to_owned()]),
        );
        let mut observed = canonical_provider_configuration(
            &serde_json::json!({
                "models": {"providers": {"custom-d9c61292": {
                    "baseUrl": "https://opencode.ai/zen/go/v1",
                    "api": "openai-completions",
                    "models": [{
                        "id": "glm-5.2",
                        "name": "glm-5.2",
                        "input": ["text"],
                        "contextWindow": 256000,
                        "maxTokens": 8192
                    }]
                }}}
            }),
            &BTreeSet::from(["custom-d9c61292".to_owned()]),
        );
        remove_unowned_model_metadata(&mut observed, &expected);

        assert_ne!(expected, observed);
    }

    #[test]
    fn secret_fields_are_redacted_before_comparison() {
        let value = redact_value(serde_json::json!({
            "apiKey": "secret-canary",
            "headers": {"authorization": "secret-canary"},
            "baseUrl": "https://example.test"
        }));
        assert_eq!(value, serde_json::json!({"baseUrl":"https://example.test"}));
        assert!(!value.to_string().contains("secret-canary"));
    }

    #[test]
    fn unavailable_evidence_keeps_unknown_applied_separate() {
        let evidence = unavailable_evidence(true);
        assert_eq!(evidence.applied(), AppliedStatus::Unknown);
        assert_eq!(evidence.observed(), ObservedStatus::Unavailable);
    }

    fn account() -> ProviderAccount {
        ProviderAccount::new(
            ProviderAccountId::try_new("local-ollama").unwrap(),
            ProviderReference::try_new("provider:ollama").unwrap(),
            ProviderAccountRevision::try_new(1).unwrap(),
            ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
                label: "Local Ollama".into(),
                enabled: true,
                kind: ProviderAccountKind::Chat,
                endpoint: Some(ProviderEndpoint::try_new("http://127.0.0.1:11434/v1").unwrap()),
                protocol: Some(ProviderApiProtocol::OpenAiResponses),
                media_protocol: None,
                auth_mode: ProviderAccountAuthMode::Local,
                credential: None,
                created_at: "2026-08-16T00:00:00Z".into(),
                updated_at: "2026-08-16T00:00:00Z".into(),
            })
            .unwrap(),
        )
    }

    fn model(account: &ProviderAccount) -> ProviderModel {
        ProviderModel::try_new(
            account.id().clone(),
            "llama-3.3",
            vec![ProviderModelCapability::Chat],
            Some(128_000),
            Some(16_000),
            None,
            None,
            None,
            None,
        )
        .unwrap()
    }

    fn config_snapshot(raw: &str, hash: &str) -> Value {
        json!({
            "path": "openclaw.json",
            "exists": true,
            "raw": raw,
            "parsed": {},
            "sourceConfig": {},
            "resolved": {},
            "valid": true,
            "runtimeConfig": {},
            "config": serde_json::from_str::<Value>(raw).unwrap(),
            "hash": hash,
            "issues": [],
            "warnings": [],
            "legacyIssues": []
        })
    }

    fn test_state_dir() -> CanonicalStateDir {
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        CanonicalStateDir::provision(std::env::temp_dir().join(format!(
            "openclaw-provider-native-config-{}-{nanos}-{sequence}",
            std::process::id()
        )))
        .unwrap()
    }

    fn test_client(
        listener: &TcpListener,
        certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
    ) -> GatewayClient {
        GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            certificate_fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        )
    }

    async fn serve_hello(socket: &mut TestSocket) {
        send_json(
            socket,
            json!({
                "type": "event", "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(socket).await;
        assert_eq!(connect["method"], "connect");
        let request_id = connect["id"].as_str().unwrap();
        send_json(
            socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {
                    "type": "hello-ok", "protocol": 4,
                    "server": {"version": wire::OPENCLAW_GATEWAY_VERSION, "connId": "fixture"},
                    "features": {
                        "methods": [
                            "status",
                            "config.get",
                            "config.patch",
                            "config.apply",
                            "agents.list",
                            "skills.status",
                            wire::SYSTEM_PRESENCE_METHOD
                        ],
                        "events": ["tick"]
                    },
                    "snapshot": {
                        "presence": [], "health": {"ok": true},
                        "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                    },
                    "auth": {
                        "role": "operator",
                        "scopes": [
                            "operator.read",
                            "operator.write",
                            "operator.admin",
                            "operator.approvals"
                        ]
                    },
                    "policy": {
                        "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                        "tickIntervalMs": 15000
                    }
                }
            }),
        )
        .await;
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }
}
