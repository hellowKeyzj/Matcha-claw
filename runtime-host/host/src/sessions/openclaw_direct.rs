use std::sync::Arc;

use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult,
    },
};
use platform::exchange::InvocationOutcome;
use tokio::sync::oneshot;

use crate::{
    RuntimeSessionError,
    runtime::{
        directory::RuntimeDriverDirectory,
        driver::{LifecycleOps, RuntimeDriver, RuntimeDriverIdentity},
    },
};

pub(crate) type SessionResult<T> = Result<T, RuntimeSessionError<OpenClawSessionError>>;
pub(crate) type InvocationResult<T> =
    Result<InvocationOutcome<T, OpenClawSessionError>, RuntimeSessionError<OpenClawSessionError>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCatalog {
    pub(crate) sessions: Vec<SessionCatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCatalogEntry {
    pub(crate) key: String,
    pub(crate) agent_id: String,
    pub(crate) endpoint_session_id: String,
    pub(crate) updated_at: Option<u64>,
}

pub(crate) struct SendCommand {
    pub(crate) params: ChatSendParams,
    pub(crate) reply: oneshot::Sender<InvocationResult<ChatSendResult>>,
}

impl SendCommand {
    pub(crate) fn send_unavailable(self) {
        let _ = self
            .reply
            .send(Err(RuntimeSessionError::RuntimeUnavailable));
    }
}

pub(crate) struct AbortCommand {
    pub(crate) params: ChatAbortParams,
    pub(crate) reply: oneshot::Sender<InvocationResult<ChatAbortResult>>,
}

impl AbortCommand {
    pub(crate) fn send_unavailable(self) {
        let _ = self
            .reply
            .send(Err(RuntimeSessionError::RuntimeUnavailable));
    }
}

pub(crate) struct Query {
    request: QueryRequest,
}

enum QueryRequest {
    ListSessions {
        reply: oneshot::Sender<SessionResult<SessionCatalog>>,
    },
    History {
        params: ChatHistoryParams,
        reply: oneshot::Sender<SessionResult<ChatHistoryResult>>,
    },
}

impl Query {
    pub(crate) fn list_sessions(reply: oneshot::Sender<SessionResult<SessionCatalog>>) -> Self {
        Self {
            request: QueryRequest::ListSessions { reply },
        }
    }

    pub(crate) fn history(
        params: ChatHistoryParams,
        reply: oneshot::Sender<SessionResult<ChatHistoryResult>>,
    ) -> Self {
        Self {
            request: QueryRequest::History { params, reply },
        }
    }

    pub(crate) fn send_unavailable(self) {
        match self.request {
            QueryRequest::ListSessions { reply } => {
                let _ = reply.send(Err(RuntimeSessionError::RuntimeUnavailable));
            }
            QueryRequest::History { reply, .. } => {
                let _ = reply.send(Err(RuntimeSessionError::RuntimeUnavailable));
            }
        }
    }
}

pub(crate) async fn reply_query(runtime_directory: &RuntimeDriverDirectory, query: Query) {
    match query.request {
        QueryRequest::ListSessions { reply } => {
            let outcome = list_sessions(runtime_directory).await;
            let _ = reply.send(outcome);
        }
        QueryRequest::History { params, reply } => {
            let outcome = history(runtime_directory, params).await;
            let _ = reply.send(outcome);
        }
    }
}

pub(crate) async fn list_sessions(
    runtime_directory: &RuntimeDriverDirectory,
) -> SessionResult<SessionCatalog> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.openclaw_session_catalog().await
}

pub(crate) async fn history(
    runtime_directory: &RuntimeDriverDirectory,
    params: ChatHistoryParams,
) -> SessionResult<ChatHistoryResult> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.history(params).await
}

pub(crate) async fn send_chat(
    runtime_directory: &RuntimeDriverDirectory,
    params: ChatSendParams,
) -> InvocationResult<ChatSendResult> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.send_open_claw_chat(params).await
}

pub(crate) async fn abort_chat(
    runtime_directory: &RuntimeDriverDirectory,
    params: ChatAbortParams,
) -> InvocationResult<ChatAbortResult> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.abort_open_claw_chat(params).await
}

fn openclaw_session_driver(
    runtime_directory: &RuntimeDriverDirectory,
) -> SessionResult<Arc<dyn RuntimeDriver>> {
    let driver = runtime_directory
        .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
        .ok_or(RuntimeSessionError::RuntimeUnavailable)?;
    if !driver.lifecycle_ops().is_some_and(LifecycleOps::readiness) {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    }
    if driver.session_ops().is_none() {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    }
    Ok(driver)
}
