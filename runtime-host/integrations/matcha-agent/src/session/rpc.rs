use crate::client::{Client, Delivery, Error};
use platform::exchange::InvocationOutcome;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub enum Failure {
    Native(Error),
    InvalidInput,
    InvalidReadback,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    Rejected,
    Unavailable,
    Unknown,
    Cancelled,
}

impl Failure {
    pub fn kind(&self) -> FailureKind {
        match self {
            Self::InvalidInput => FailureKind::Rejected,
            Self::InvalidReadback => FailureKind::Unknown,
            Self::Native(error) => {
                if error.is_cancelled() && error.delivery() == Delivery::NotSent {
                    return FailureKind::Cancelled;
                }
                match error.delivery() {
                    Delivery::NotSent => FailureKind::Unavailable,
                    Delivery::Unknown => FailureKind::Unknown,
                    Delivery::ResponseReceived => match error.code() {
                        Some(-32006) => FailureKind::Unknown,
                        Some(-32003 | -32005 | -32603) => FailureKind::Unavailable,
                        Some(_) => FailureKind::Rejected,
                        None => FailureKind::Unknown,
                    },
                }
            }
        }
    }
    pub fn code(&self) -> Option<i64> {
        match self {
            Self::Native(error) => error.code(),
            _ => None,
        }
    }
    pub fn native_kind(&self) -> Option<&str> {
        match self {
            Self::Native(error) => Some(error.kind()),
            _ => None,
        }
    }
    pub fn delivery(&self) -> Option<Delivery> {
        match self {
            Self::Native(error) => Some(error.delivery()),
            _ => None,
        }
    }
    pub fn is_not_found(&self) -> bool {
        self.code() == Some(-32001)
    }
    pub fn data(&self) -> Option<&Value> {
        match self {
            Self::Native(error) => error.data(),
            _ => None,
        }
    }
}
impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionFailure")
            .field("kind", &self.kind())
            .field("code", &self.code())
            .finish()
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Native session operation failed")
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Native(error) => Some(error),
            _ => None,
        }
    }
}

pub(crate) fn decode<T: DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|_| Failure::InvalidReadback)
}
pub(crate) async fn call(client: &Client, method: &str, params: Value) -> Result<Value, Failure> {
    client.call(method, params).await.map_err(Failure::Native)
}
pub(crate) async fn call_cancellable(
    client: &Client,
    method: &str,
    params: Value,
    cancel: &CancellationToken,
) -> Result<Value, Failure> {
    client
        .call_cancellable(method, params, cancel)
        .await
        .map_err(Failure::Native)
}
pub(crate) fn outcome<T>(result: Result<T, Failure>) -> InvocationOutcome<T, Failure> {
    match result {
        Ok(value) => InvocationOutcome::Succeeded(value),
        Err(error) => match error.kind() {
            FailureKind::Unknown => InvocationOutcome::Unknown,
            FailureKind::Cancelled => InvocationOutcome::Cancelled,
            _ => InvocationOutcome::TargetRejected(error),
        },
    }
}
pub(crate) async fn bound(
    client: &Client,
    identity: &sessions_module::state::SessionIdentity,
    id: Option<&str>,
) -> Result<super::model::SessionRecord, Failure> {
    let (agent, native) =
        super::projection::parse_session_key(&identity.session_key).ok_or(Failure::InvalidInput)?;
    if identity.validate().is_err()
        || identity.provider() != sessions_module::state::SessionProvider::MatchaAgent
        || identity.endpoint.runtime_instance_id != "local"
        || identity.endpoint.kind != "native-runtime"
        || identity.agent_id != agent
        || id.is_some_and(|id| id != native)
    {
        return Err(Failure::InvalidInput);
    }
    get(client, native, Some(agent)).await
}

pub async fn get(
    client: &Client,
    id: &str,
    agent: Option<&str>,
) -> Result<super::model::SessionRecord, Failure> {
    if !super::model::valid_uuid(id) {
        return Err(Failure::InvalidInput);
    }
    let record: super::model::SessionRecord =
        decode(call(client, "sessions.get", json!({"sessionId":id})).await?)?;
    if !record.validate(id, agent) {
        return Err(Failure::InvalidReadback);
    }
    Ok(record)
}
