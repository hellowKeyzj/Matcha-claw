use crate::{
    provider::{account_draft::ProviderAccountDraft, accounts::ProviderAccountView},
    transport::common::authorization::CapabilityDecisionVerifier,
};
use environment::{ProviderAccountId, ProviderAccountRevision};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::provider::{
    accounts::{ProviderAccountMutationKind, ProviderCommitOutcome, ProviderPersistedOutcome},
    native::{ProviderNativeConfigurationDiagnosticView, ProviderNativeConfigurationView},
};

pub(crate) mod server;

const CAPABILITY_ID: &str = "provider.accounts";
const AUTHORIZATION_ENDPOINT: &str = "/api/provider-accounts";
const AUTHORIZATION_SCOPE: &str = "providers:accounts";
const AUTHORIZATION_SUBJECT: &str = "provider-accounts";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderAccountsRequest {
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    List,
    Get { account_id: String },
    Replace { account: ProviderAccountWireDraft },
    Delete { account_id: String, revision: u64 },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderAccountWireDraft {
    id: String,
    provider: String,
    label: String,
    enabled: bool,
    #[serde(default = "default_provider_account_kind")]
    kind: String,
    endpoint: Option<String>,
    protocol: Option<String>,
    media_protocol: Option<String>,
    auth_mode: String,
    revision: u64,
}

impl ProviderAccountWireDraft {
    fn into_draft(self) -> ProviderAccountDraft {
        ProviderAccountDraft::new(
            self.id,
            self.provider,
            self.label,
            self.enabled,
            self.kind,
            self.endpoint,
            self.protocol,
            self.media_protocol,
            self.auth_mode,
            self.revision,
        )
    }
}

fn default_provider_account_kind() -> String {
    "chat".to_owned()
}

pub(crate) enum ProviderAccountsCommand {
    List,
    Get(ProviderAccountId),
    Replace(ProviderAccountDraft),
    Delete(ProviderAccountId, ProviderAccountRevision),
}

impl ProviderAccountsRequest {
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
                    "providerAccounts.list"
                        | "providerAccounts.get"
                        | "providerAccounts.replace"
                        | "providerAccounts.delete"
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
            (operation, Input::List) => operation == "providerAccounts.list",
            (operation, Input::Get { .. }) => operation == "providerAccounts.get",
            (operation, Input::Replace { .. }) => operation == "providerAccounts.replace",
            (operation, Input::Delete { .. }) => operation == "providerAccounts.delete",
        };
        (self.id == CAPABILITY_ID
            && self.scope.kind == "provider-account-catalog"
            && self.target.kind == "provider-accounts"
            && valid_operation)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<ProviderAccountsCommand, RequestError> {
        match self.input {
            Input::List => Ok(ProviderAccountsCommand::List),
            Input::Get { account_id } => ProviderAccountId::try_new(account_id)
                .map(ProviderAccountsCommand::Get)
                .map_err(|_| RequestError::Invalid),
            Input::Replace { account } => {
                let account = account.into_draft();
                account
                    .validate()
                    .map(|()| ProviderAccountsCommand::Replace(account))
                    .map_err(|_| RequestError::Invalid)
            }
            Input::Delete {
                account_id,
                revision,
            } => {
                let id =
                    ProviderAccountId::try_new(account_id).map_err(|_| RequestError::Invalid)?;
                let revision = ProviderAccountRevision::try_new(revision)
                    .map_err(|_| RequestError::Invalid)?;
                Ok(ProviderAccountsCommand::Delete(id, revision))
            }
        }
    }
}

impl crate::provider::accounts::ProviderAccountsDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::List(_) | Self::Account(_) => 200,
            Self::Stored {
                persisted, commit, ..
            }
            | Self::Deleted {
                persisted, commit, ..
            } if !mutation_unknown(*persisted, *commit) => 200,
            Self::Stored { .. } | Self::Deleted { .. } | Self::Unknown { .. } => 409,
            Self::Rejected => 422,
            Self::Missing => 404,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::List(accounts) => {
                json!({ "accounts": accounts.iter().map(account_json).collect::<Vec<_>>() })
            }
            Self::Account(account) => json!({ "account": account_json(account) }),
            Self::Stored {
                account,
                persisted,
                native,
                commit,
            } => mutation_body(
                Some(&account_json(account)),
                "stored",
                *persisted,
                native.clone(),
                *commit,
                "Provider mutation commit outcome is unknown; reopen before retrying",
            ),
            Self::Deleted {
                persisted,
                native,
                commit,
            } => mutation_body(
                None,
                "deleted",
                *persisted,
                native.clone(),
                *commit,
                "Provider mutation commit outcome is unknown; reopen before retrying",
            ),
            Self::Rejected => fixed_error("Provider account request was rejected"),
            Self::Missing => fixed_error("Provider account is unknown"),
            Self::Unknown {
                desired,
                persisted,
                native,
                commit,
            } => mutation_body(
                None,
                desired_status(*desired),
                *persisted,
                native.clone(),
                *commit,
                "Provider mutation commit outcome is unknown; reopen before retrying",
            ),
            Self::Unavailable => fixed_error("Provider accounts are unavailable"),
        }
    }
}

fn fixed_error(error: &'static str) -> Value {
    json!({ "success": false, "error": error })
}

fn mutation_body(
    account: Option<&Value>,
    desired_status: &str,
    persisted: ProviderPersistedOutcome,
    native: ProviderNativeConfigurationView,
    commit: ProviderCommitOutcome,
    unknown_error: &'static str,
) -> Value {
    let desired = json!({ "status": desired_status });
    let unknown = mutation_unknown(persisted, commit);
    let persisted_json = persisted_json(persisted);
    let native_json = native_json(native);
    let commit_name = commit_name(commit);
    if unknown {
        return unknown_body_parts(
            unknown_error,
            desired,
            persisted_json,
            native_json,
            commit_name,
        );
    }
    let mut body = json!({
        "success": true,
        "desired": desired,
        "persisted": persisted_json,
        "native": native_json,
        "commit": commit_name,
    });
    if let Some(account) = account {
        body.as_object_mut()
            .expect("account mutation body is an object")
            .insert("account".into(), account.clone());
    }
    body
}

const fn desired_status(kind: ProviderAccountMutationKind) -> &'static str {
    match kind {
        ProviderAccountMutationKind::Stored => "stored",
        ProviderAccountMutationKind::Deleted => "deleted",
    }
}

fn unknown_body_parts(
    error: &'static str,
    desired: Value,
    persisted: Value,
    native: Value,
    commit: &'static str,
) -> Value {
    json!({
        "success": false,
        "code": "commit-outcome-unknown",
        "error": error,
        "receipt": {
            "desired": desired,
            "persisted": persisted,
            "native": native,
            "commit": commit,
        },
    })
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

fn account_json(account: &ProviderAccountView) -> Value {
    let mut value = json!({
        "id": account.id,
        "provider": account.provider,
        "label": account.label,
        "enabled": account.enabled,
        "kind": account.kind,
        "authMode": account.auth_mode,
        "revision": account.revision,
    });
    let object = value
        .as_object_mut()
        .expect("provider account JSON is an object");
    if let Some(endpoint) = &account.endpoint {
        object.insert("endpoint".into(), Value::String(endpoint.clone()));
    }
    if let Some(protocol) = account.protocol {
        object.insert("protocol".into(), Value::String(protocol.to_owned()));
    }
    if let Some(protocol) = account.media_protocol {
        object.insert("mediaProtocol".into(), Value::String(protocol.to_owned()));
    }
    value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::provider::accounts::ProviderAccountsDelivery;

    #[test]
    fn strict_request_decoding_rejects_secrets_and_unknown_fields() {
        let invalid = json!({
            "id": "provider.accounts",
            "operationId": "providerAccounts.replace",
            "scope": { "kind": "provider-account-catalog" },
            "target": { "kind": "provider-accounts" },
            "input": {
                "kind": "replace",
                "account": {
                    "id": "openai-main", "provider": "openai", "label": "Main",
                    "enabled": true, "kind": "chat", "authMode": "apiKey", "revision": 1,
                    "apiKey": "secret-canary"
                }
            }
        });
        assert!(serde_json::from_value::<ProviderAccountsRequest>(invalid).is_err());
    }

    #[test]
    fn camel_case_account_identity_fields_decode_for_get_and_delete() {
        for (operation_id, input) in [
            (
                "providerAccounts.get",
                json!({ "kind": "get", "accountId": "ollama-local" }),
            ),
            (
                "providerAccounts.delete",
                json!({ "kind": "delete", "accountId": "ollama-local", "revision": 1 }),
            ),
        ] {
            let request = json!({
                "id": "provider.accounts",
                "operationId": operation_id,
                "scope": { "kind": "provider-account-catalog" },
                "target": { "kind": "provider-accounts" },
                "input": input,
            });
            assert!(serde_json::from_value::<ProviderAccountsRequest>(request).is_ok());
        }
    }

    #[test]
    fn public_request_rejects_private_credential_references() {
        let invalid = json!({
            "id": "provider.accounts",
            "operationId": "providerAccounts.replace",
            "scope": { "kind": "provider-account-catalog" },
            "target": { "kind": "provider-accounts" },
            "input": {
                "kind": "replace",
                "account": {
                    "id": "openai-main", "provider": "openai", "label": "Main",
                    "enabled": true, "authMode": "apiKey",
                    "credentialReference": "credential:v1:openai-main", "revision": 1
                }
            }
        });
        assert!(serde_json::from_value::<ProviderAccountsRequest>(invalid).is_err());
    }

    #[test]
    fn native_diagnostic_public_response_preserves_contract_fields() {
        let account = ProviderAccountDraft::new(
            "openai-main",
            "openai",
            "Main",
            true,
            "chat",
            None,
            None,
            None,
            "apiKey",
            1,
        )
        .materialize(None, "updated")
        .unwrap();
        let account = ProviderAccountView::from_account(&account);
        let body = ProviderAccountsDelivery::Stored {
            account,
            persisted: ProviderPersistedOutcome::Unknown,
            native: provider_native_view_with_private_diagnostic(),
            commit: ProviderCommitOutcome::CommitOutcomeUnknown,
        }
        .body();
        assert_eq!(
            body["receipt"]["native"]["diagnostic"],
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
    fn public_account_json_has_no_private_configuration_or_secret_fields() {
        let account = ProviderAccountDraft::new(
            "openai-main",
            "openai",
            "Main",
            true,
            "chat",
            None,
            None,
            None,
            "apiKey",
            1,
        )
        .materialize(None, "updated")
        .unwrap();
        let account = ProviderAccountView::from_account(&account);
        let encoded = account_json(&account).to_string();
        for private in [
            "access",
            "refresh",
            "header",
            "credential",
            "createdAt",
            "updatedAt",
        ] {
            assert!(
                !encoded.contains(private),
                "{private} must not enter public account JSON"
            );
        }
    }
}
