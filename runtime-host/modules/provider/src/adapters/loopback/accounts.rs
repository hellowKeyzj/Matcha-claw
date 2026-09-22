use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback::Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    ProviderAccountDraft, ProviderAccountId, ProviderAccountRevision, ProviderAccountsDelivery,
    ProviderHandle, projection,
};

pub(super) const ENDPOINT: &str = "/api/provider-accounts";
pub(super) const ACCOUNT_PREFIX: &str = "/api/provider-accounts/";
const CAPABILITY_ID: &str = "provider.accounts";
const AUTHORIZATION_SCOPE: &str = "providers:accounts";
const AUTHORIZATION_SUBJECT: &str = "provider-accounts";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderAccountsRequest {
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
    List {},
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

enum ProviderAccountsCommand {
    List,
    Get(ProviderAccountId),
    Replace(ProviderAccountDraft),
    Delete(ProviderAccountId, ProviderAccountRevision),
}

impl ProviderAccountsRequest {
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
                ENDPOINT,
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
            (operation, Input::List {}) => operation == "providerAccounts.list",
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

    fn into_command(self) -> Result<ProviderAccountsCommand, RequestError> {
        match self.input {
            Input::List {} => Ok(ProviderAccountsCommand::List),
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

pub(super) async fn handle(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> Response {
    let response = handle_request(request, verifier, provider).await;
    Response::json(response.status, response.body)
}

async fn handle_request(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    let path = request.path().to_owned();
    if request.method() == "GET" {
        let (target_path, query) = path
            .split_once('?')
            .map_or((path.as_str(), None), |(path, query)| (path, Some(query)));
        if query.is_some() {
            return TransportResponse::bad_request();
        }
        return match target_path {
            ENDPOINT => handle_get_list(&request, verifier, provider).await,
            path if path.starts_with(ACCOUNT_PREFIX) => {
                handle_get_account(path, &request, verifier, provider).await
            }
            _ => TransportResponse::not_found(),
        };
    }
    if request.method() != "POST" || path != ENDPOINT {
        return TransportResponse::not_found();
    }
    let Some(authorization) = request.bearer_authorization() else {
        return TransportResponse::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return TransportResponse::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let command = match ProviderAccountsRequest::decode(
        value,
        authorization,
        &mut verifier,
        super::now_millis(),
    )
    .and_then(ProviderAccountsRequest::into_command)
    {
        Ok(command) => command,
        Err(RequestError::Invalid) => return TransportResponse::bad_request(),
        Err(RequestError::Unauthorized) => return TransportResponse::unauthorized(),
    };
    drop(verifier);
    let is_query = matches!(
        command,
        ProviderAccountsCommand::List | ProviderAccountsCommand::Get(_)
    );
    let dispatch = async {
        match command {
            ProviderAccountsCommand::List => provider.list_provider_accounts().await,
            ProviderAccountsCommand::Get(id) => provider.get_provider_account(id).await,
            ProviderAccountsCommand::Replace(draft) => {
                provider.replace_provider_account(draft).await
            }
            ProviderAccountsCommand::Delete(id, revision) => {
                provider.delete_provider_account(id, revision).await
            }
        }
    };
    let delivery = if is_query {
        match tokio::time::timeout(super::SHORT_DEADLINE, dispatch).await {
            Ok(delivery) => delivery,
            Err(_) => return TransportResponse::fixed(503, super::TIMEOUT_ERROR),
        }
    } else {
        dispatch.await
    };
    TransportResponse::from_delivery(delivery.unwrap_or(ProviderAccountsDelivery::Unavailable))
}

async fn handle_get_list(
    request: &platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    if !request.body.is_empty() {
        return TransportResponse::bad_request();
    }
    if !verify_get_authorization(request, &verifier, ENDPOINT, "providerAccounts.list").await {
        return TransportResponse::unauthorized();
    }
    let delivery = provider
        .list_provider_accounts()
        .await
        .unwrap_or(ProviderAccountsDelivery::Unavailable);
    TransportResponse::from_delivery(delivery)
}

async fn handle_get_account(
    path: &str,
    request: &platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    provider: ProviderHandle,
) -> TransportResponse {
    if !request.body.is_empty() {
        return TransportResponse::bad_request();
    }
    let Some(id) = path.strip_prefix(ACCOUNT_PREFIX) else {
        return TransportResponse::not_found();
    };
    if id.is_empty() || id.contains('/') {
        return TransportResponse::not_found();
    }
    let Ok(id) = ProviderAccountId::try_new(id.to_owned()) else {
        return TransportResponse::bad_request();
    };
    if !verify_get_authorization(request, &verifier, path, "providerAccounts.get").await {
        return TransportResponse::unauthorized();
    }
    let delivery = provider
        .get_provider_account(id)
        .await
        .unwrap_or(ProviderAccountsDelivery::Unavailable);
    TransportResponse::from_delivery(delivery)
}

async fn verify_get_authorization(
    request: &platform::loopback::Request,
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &str,
    capability: &str,
) -> bool {
    let Some(token) = request.bearer_authorization() else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            token,
            super::now_millis(),
            endpoint,
            AUTHORIZATION_SCOPE,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .is_ok()
}

struct TransportResponse {
    status: u16,
    body: Value,
}

impl TransportResponse {
    fn bad_request() -> Self {
        Self::fixed(400, "Provider account request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Provider account authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Provider account route is not available")
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ProviderAccountsDelivery) -> Self {
        Self {
            status: projection::accounts::status_code(&delivery),
            body: projection::accounts::body(&delivery),
        }
    }
}
