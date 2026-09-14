use std::time::{SystemTime, UNIX_EPOCH};

use crate::transport::authorization::CapabilityDecisionVerifier;
use environment::{
    CredentialReference, ProviderAccount, ProviderAccountAuthMode, ProviderAccountConfiguration,
    ProviderAccountConfigurationInput, ProviderAccountId, ProviderAccountKind,
    ProviderAccountRevision, ProviderApiProtocol, ProviderEndpoint, ProviderMediaApiProtocol,
    ProviderReference,
};
use serde::Deserialize;
use serde_json::{Value, json};

use openclaw::port::{
    AppliedStatus, ObservedStatus, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEffect,
};

use crate::provider::accounts::{
    ProviderAccountMutationKind, ProviderCommitOutcome, ProviderPersistedOutcome,
};

pub mod private_auth;
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
    Replace { account: AccountDraft },
    Delete { account_id: String, revision: u64 },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountDraft {
    id: String,
    provider: String,
    label: String,
    enabled: bool,
    #[serde(default = "default_account_kind")]
    kind: String,
    endpoint: Option<String>,
    protocol: Option<String>,
    media_protocol: Option<String>,
    auth_mode: String,
    revision: u64,
}

impl AccountDraft {
    pub(crate) const fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn trace_provider(&self) -> &str {
        &self.provider
    }

    pub(crate) fn trace_auth_mode(&self) -> &str {
        &self.auth_mode
    }

    pub(crate) fn trace_kind(&self) -> &str {
        &self.kind
    }

    pub(crate) const fn trace_enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn trace_endpoint_present(&self) -> bool {
        self.endpoint
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    }

    pub(crate) fn trace_protocol(&self) -> Option<&str> {
        self.protocol.as_deref()
    }

    pub(crate) fn trace_media_protocol(&self) -> Option<&str> {
        self.media_protocol.as_deref()
    }
}

pub(crate) enum ProviderAccountsCommand {
    List,
    Get(ProviderAccountId),
    Replace(AccountDraft),
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
                validate_draft(&account).map(ProviderAccountsCommand::Replace)
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

fn validate_draft(draft: &AccountDraft) -> Result<AccountDraft, RequestError> {
    ProviderAccountId::try_new(draft.id.clone()).map_err(|_| RequestError::Invalid)?;
    ProviderReference::try_new(provider_reference(&draft.provider)?)
        .map_err(|_| RequestError::Invalid)?;
    ProviderAccountRevision::try_new(draft.revision).map_err(|_| RequestError::Invalid)?;
    let auth_mode = auth_mode(&draft.auth_mode)?;
    let provider = provider_reference(&draft.provider)?;
    match auth_mode {
        ProviderAccountAuthMode::CliReuse
            if provider != "provider:anthropic" || draft.kind != "chat" =>
        {
            return Err(RequestError::Invalid);
        }
        ProviderAccountAuthMode::Token
            if !matches!(
                provider.as_str(),
                "provider:anthropic" | "provider:github-copilot"
            ) || draft.kind != "chat" =>
        {
            return Err(RequestError::Invalid);
        }
        _ => {}
    }
    let credential = credential_for_draft(draft)?;
    ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
        label: draft.label.clone(),
        enabled: draft.enabled,
        kind: account_kind(&draft.kind)?,
        endpoint: draft
            .endpoint
            .clone()
            .map(ProviderEndpoint::try_new)
            .transpose()
            .map_err(|_| RequestError::Invalid)?,
        protocol: draft.protocol.as_deref().map(api_protocol).transpose()?,
        media_protocol: draft
            .media_protocol
            .as_deref()
            .map(media_protocol)
            .transpose()?,
        auth_mode,
        credential,
        created_at: "1970-01-01T00:00:00Z".to_owned(),
        updated_at: "1970-01-01T00:00:00Z".to_owned(),
    })
    .map_err(|_| RequestError::Invalid)?;
    Ok(draft.clone())
}

fn credential_for_draft(draft: &AccountDraft) -> Result<Option<CredentialReference>, RequestError> {
    if matches!(draft.auth_mode.as_str(), "local" | "cliReuse") {
        return Ok(None);
    }
    CredentialReference::try_new(format!("credential:v1:{}", draft.id))
        .map(Some)
        .map_err(|_| RequestError::Invalid)
}

pub(crate) fn materialize_for_owner(
    draft: &AccountDraft,
    existing: Option<&ProviderAccount>,
) -> Option<ProviderAccount> {
    let now = current_timestamp();
    let created_at = existing
        .map(|account| account.configuration().created_at().to_owned())
        .unwrap_or_else(|| now.clone());
    materialize(draft.clone(), created_at, now).ok()
}

pub(crate) fn account_id_for_owner(draft: &AccountDraft) -> Result<ProviderAccountId, ()> {
    ProviderAccountId::try_new(draft.id.clone()).map_err(|_| ())
}

pub(crate) fn account_json_for_owner(account: &ProviderAccount) -> Value {
    account_json(account)
}

pub(crate) fn same_public_facts_for_owner(account: &ProviderAccount, draft: &AccountDraft) -> bool {
    same_public_facts(account, draft)
}

fn materialize(
    draft: AccountDraft,
    created_at: String,
    updated_at: String,
) -> Result<ProviderAccount, ()> {
    let credential = credential_for_draft(&draft).map_err(|_| ())?;
    let id = ProviderAccountId::try_new(draft.id).map_err(|_| ())?;
    let provider = ProviderReference::try_new(provider_reference(&draft.provider).map_err(|_| ())?)
        .map_err(|_| ())?;
    let revision = ProviderAccountRevision::try_new(draft.revision).map_err(|_| ())?;
    let configuration = ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
        label: draft.label,
        enabled: draft.enabled,
        kind: account_kind(&draft.kind).map_err(|_| ())?,
        endpoint: draft
            .endpoint
            .map(ProviderEndpoint::try_new)
            .transpose()
            .map_err(|_| ())?,
        protocol: draft
            .protocol
            .as_deref()
            .map(api_protocol)
            .transpose()
            .map_err(|_| ())?,
        media_protocol: draft
            .media_protocol
            .as_deref()
            .map(media_protocol)
            .transpose()
            .map_err(|_| ())?,
        auth_mode: auth_mode(&draft.auth_mode).map_err(|_| ())?,
        credential,
        created_at,
        updated_at,
    })
    .map_err(|_| ())?;
    Ok(ProviderAccount::new(id, provider, revision, configuration))
}

fn same_public_facts(account: &ProviderAccount, draft: &AccountDraft) -> bool {
    let configuration = account.configuration();
    provider_reference(&draft.provider)
        .ok()
        .is_some_and(|provider| account.provider().as_str() == provider)
        && configuration.label() == draft.label
        && configuration.enabled() == draft.enabled
        && account_kind_name(configuration.kind()) == draft.kind
        && configuration.endpoint().map(ProviderEndpoint::as_str) == draft.endpoint.as_deref()
        && configuration.protocol().map(api_protocol_name) == draft.protocol.as_deref()
        && configuration.media_protocol().map(media_protocol_name)
            == draft.media_protocol.as_deref()
        && auth_mode_name(configuration.auth_mode()) == draft.auth_mode
        && configuration.credential().map(CredentialReference::as_str)
            == credential_for_draft(draft)
                .ok()
                .flatten()
                .as_ref()
                .map(CredentialReference::as_str)
}

pub(crate) enum ProviderAccountsDelivery {
    List(Vec<Value>),
    Account(Value),
    Stored {
        account: Value,
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationEffect,
        commit: ProviderCommitOutcome,
    },
    Deleted {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationEffect,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Missing,
    Unknown {
        desired: ProviderAccountMutationKind,
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationEffect,
        commit: ProviderCommitOutcome,
    },
    Unavailable,
}

impl ProviderAccountsDelivery {
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
            Self::List(accounts) => json!({ "accounts": accounts }),
            Self::Account(account) => json!({ "account": account }),
            Self::Stored {
                account,
                persisted,
                native,
                commit,
            } => mutation_body(
                Some(account),
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
    native: ProviderNativeConfigurationEffect,
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

fn account_json(account: &ProviderAccount) -> Value {
    let configuration = account.configuration();
    let mut value = json!({
        "id": account.id().as_str(),
        "provider": account.provider().as_str().strip_prefix("provider:").expect("ProviderAccount provider references are canonical"),
        "label": configuration.label(),
        "enabled": configuration.enabled(),
        "kind": account_kind_name(configuration.kind()),
        "authMode": auth_mode_name(configuration.auth_mode()),
        "revision": account.revision().get(),
    });
    let object = value
        .as_object_mut()
        .expect("provider account JSON is an object");
    if let Some(endpoint) = configuration.endpoint() {
        object.insert(
            "endpoint".into(),
            Value::String(endpoint.as_str().to_owned()),
        );
    }
    if let Some(protocol) = configuration.protocol() {
        object.insert(
            "protocol".into(),
            Value::String(api_protocol_name(protocol).to_owned()),
        );
    }
    if let Some(protocol) = configuration.media_protocol() {
        object.insert(
            "mediaProtocol".into(),
            Value::String(media_protocol_name(protocol).to_owned()),
        );
    }
    value
}

fn provider_reference(provider: &str) -> Result<String, RequestError> {
    let provider = provider.strip_prefix("provider:").unwrap_or(provider);
    (!provider.is_empty()
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
    .then(|| format!("provider:{provider}"))
    .ok_or(RequestError::Invalid)
}

fn default_account_kind() -> String {
    "chat".to_owned()
}

fn account_kind(value: &str) -> Result<ProviderAccountKind, RequestError> {
    match value {
        "chat" => Ok(ProviderAccountKind::Chat),
        "media" => Ok(ProviderAccountKind::Media),
        _ => Err(RequestError::Invalid),
    }
}

fn account_kind_name(value: ProviderAccountKind) -> &'static str {
    match value {
        ProviderAccountKind::Chat => "chat",
        ProviderAccountKind::Media => "media",
    }
}

fn api_protocol(value: &str) -> Result<ProviderApiProtocol, RequestError> {
    match value {
        "anthropicMessages" => Ok(ProviderApiProtocol::AnthropicMessages),
        "googleGenerativeAi" => Ok(ProviderApiProtocol::GoogleGenerativeAi),
        "openAiCompletions" => Ok(ProviderApiProtocol::OpenAiCompletions),
        "openAiResponses" => Ok(ProviderApiProtocol::OpenAiResponses),
        _ => Err(RequestError::Invalid),
    }
}

fn api_protocol_name(value: ProviderApiProtocol) -> &'static str {
    match value {
        ProviderApiProtocol::AnthropicMessages => "anthropicMessages",
        ProviderApiProtocol::GoogleGenerativeAi => "googleGenerativeAi",
        ProviderApiProtocol::OpenAiCompletions => "openAiCompletions",
        ProviderApiProtocol::OpenAiResponses => "openAiResponses",
    }
}

fn media_protocol(value: &str) -> Result<ProviderMediaApiProtocol, RequestError> {
    match value {
        "google" => Ok(ProviderMediaApiProtocol::Google),
        "openAi" => Ok(ProviderMediaApiProtocol::OpenAi),
        "openRouter" => Ok(ProviderMediaApiProtocol::OpenRouter),
        _ => Err(RequestError::Invalid),
    }
}

fn media_protocol_name(value: ProviderMediaApiProtocol) -> &'static str {
    match value {
        ProviderMediaApiProtocol::Google => "google",
        ProviderMediaApiProtocol::OpenAi => "openAi",
        ProviderMediaApiProtocol::OpenRouter => "openRouter",
    }
}

fn auth_mode(value: &str) -> Result<ProviderAccountAuthMode, RequestError> {
    match value {
        "apiKey" => Ok(ProviderAccountAuthMode::ApiKey),
        "token" => Ok(ProviderAccountAuthMode::Token),
        "cliReuse" => Ok(ProviderAccountAuthMode::CliReuse),
        "oauthBrowser" => Ok(ProviderAccountAuthMode::OAuthBrowser),
        "oauthDevice" => Ok(ProviderAccountAuthMode::OAuthDevice),
        "local" => Ok(ProviderAccountAuthMode::Local),
        _ => Err(RequestError::Invalid),
    }
}

fn auth_mode_name(value: ProviderAccountAuthMode) -> &'static str {
    match value {
        ProviderAccountAuthMode::ApiKey => "apiKey",
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cliReuse",
        ProviderAccountAuthMode::OAuthBrowser => "oauthBrowser",
        ProviderAccountAuthMode::OAuthDevice => "oauthDevice",
        ProviderAccountAuthMode::Local => "local",
    }
}

fn current_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix:{millis}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

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
    fn public_account_json_has_no_private_configuration_or_secret_fields() {
        let account = materialize(
            AccountDraft {
                id: "openai-main".into(),
                provider: "openai".into(),
                label: "Main".into(),
                enabled: true,
                kind: "chat".into(),
                endpoint: None,
                protocol: None,
                media_protocol: None,
                auth_mode: "apiKey".into(),
                revision: 1,
            },
            "created".into(),
            "updated".into(),
        )
        .unwrap();
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
