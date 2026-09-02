use std::path::Path;

use platform::exchange::InvocationOutcome;

use crate::{
    peer::MatchaPeer,
    session::{
        client::{AppServerClient, AppServerClientError},
        model::SessionId,
        request::SessionCreateParams,
    },
};

pub(super) async fn create(
    peer: &MatchaPeer,
    session_id: SessionId,
) -> InvocationOutcome<SessionId, AppServerClientError> {
    if !peer.is_running() {
        return InvocationOutcome::TargetRejected(AppServerClientError::ConnectionClosed);
    }
    let (events, _updates) = tokio::sync::mpsc::channel(1);
    let client =
        match AppServerClient::connect_and_initialize(peer.endpoint, &peer.secret, events).await {
            Ok((client, _)) => client,
            Err(error) => return InvocationOutcome::TargetRejected(error),
        };
    let outcome = create_native(&client, &peer.working_directory, session_id).await;
    client.finish_with_cleanup(outcome).await
}

pub(super) async fn create_native(
    client: &AppServerClient,
    working_directory: &Path,
    session_id: SessionId,
) -> InvocationOutcome<SessionId, AppServerClientError> {
    let Some(cwd) = working_directory.to_str() else {
        return InvocationOutcome::TargetRejected(AppServerClientError::Protocol);
    };
    let params = match SessionCreateParams::try_new(cwd) {
        Ok(params) => params.with_session_id(session_id.clone()),
        Err(_) => return InvocationOutcome::TargetRejected(AppServerClientError::Protocol),
    };
    match client.load_or_create_session(session_id, params).await {
        InvocationOutcome::Succeeded(session) => InvocationOutcome::Succeeded(session.session_id),
        InvocationOutcome::TargetRejected(error) => InvocationOutcome::TargetRejected(error),
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => InvocationOutcome::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::request::SessionCreateParams;
    use serde_json::to_value;

    #[test]
    fn native_create_params_bind_peer_cwd_and_requested_session() {
        let session_id = SessionId::try_new("matcha-session-1").unwrap();
        let params = SessionCreateParams::try_new("E:/matcha-chat-workspace")
            .unwrap()
            .with_session_id(session_id);
        assert_eq!(
            to_value(params).unwrap(),
            serde_json::json!({
                "cwd": "E:/matcha-chat-workspace",
                "sessionId": "matcha-session-1"
            })
        );
    }

    #[test]
    fn cleanup_close_failure_preserves_confirmed_session_create() {
        let session_id = SessionId::try_new("matcha-session-1").unwrap();
        assert_eq!(
            crate::session::client::outcome_after_cleanup(
                InvocationOutcome::<SessionId, AppServerClientError>::Succeeded(session_id.clone()),
                Err(AppServerClientError::CloseFailed),
            ),
            InvocationOutcome::Succeeded(session_id)
        );
    }
}
