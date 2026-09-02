pub mod local;

use std::fmt;

use crate::{
    lifecycle::secret::Secret,
    session::{
        catalog::SessionCatalogFacts,
        client::{
            AppServerClient, AppServerClientError, AppServerEndpoint, EventRecovery,
            EventRecoveryCursor,
        },
        hydration::{
            self, HydrationIncomplete, HydrationResult, HydrationSnapshot, HydrationWindowRequest,
        },
        model::{SessionId, SessionListResult, SessionRecord},
        protocol_event::ReplayLimit,
        request::SessionLoadParams,
    },
};

/// The safe result of one native session-history read.
///
/// The native app-server remains the owner of session, transcript, and event
/// facts. This result only exposes bounded projections and the reason a read
/// did not produce one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryResult<T> {
    Complete(T),
    NotFound,
    Unavailable,
    Unknown,
    Incomplete(HydrationIncomplete),
}

pub type HistoryListResult = HistoryResult<HistoryCatalog>;
pub type HistoryLoadResult = HistoryResult<HydrationSnapshot>;
pub type HistoryContentResult = HistoryResult<HistoryContentChunk>;
pub type HistoryRecoveryResult = HistoryResult<EventRecovery>;

/// One bounded chunk of native transcript content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryContentChunk {
    content_ref: String,
    offset: u64,
    text: String,
    next_offset: u64,
    total_bytes: u64,
    complete: bool,
}

impl HistoryContentChunk {
    pub(crate) fn new(
        content_ref: String,
        offset: u64,
        text: String,
        next_offset: u64,
        total_bytes: u64,
    ) -> Self {
        Self {
            content_ref,
            offset,
            text,
            next_offset,
            total_bytes,
            complete: next_offset >= total_bytes,
        }
    }

    pub fn content_ref(&self) -> &str {
        &self.content_ref
    }

    pub const fn offset(&self) -> u64 {
        self.offset
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn next_offset(&self) -> u64 {
        self.next_offset
    }

    pub const fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    pub const fn complete(&self) -> bool {
        self.complete
    }
}

/// A bounded catalog projection containing native session records.
#[derive(Clone, Eq, PartialEq)]
pub struct HistoryCatalog {
    sessions: Vec<HistorySession>,
}

impl HistoryCatalog {
    pub fn sessions(&self) -> &[HistorySession] {
        &self.sessions
    }

    /// Reconstructs borrowed catalog facts from the native records in this
    /// list result. No catalog shadow or second fact owner is retained.
    pub fn session_facts(&self) -> impl Iterator<Item = SessionCatalogFacts<'_>> + '_ {
        self.sessions.iter().map(HistorySession::session_facts)
    }
}

impl fmt::Debug for HistoryCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HistoryCatalog")
            .field("session_count", &self.sessions.len())
            .finish()
    }
}

/// One native catalog entry. It retains the peer-owned record for this list
/// result and never derives an agent, workspace, or run crosswalk.
#[derive(Clone, Eq, PartialEq)]
pub struct HistorySession {
    record: SessionRecord,
}

impl HistorySession {
    pub fn session_id(&self) -> &SessionId {
        &self.record.session_id
    }

    pub fn session_facts(&self) -> SessionCatalogFacts<'_> {
        SessionCatalogFacts::from_native(&self.record)
    }
}

impl fmt::Debug for HistorySession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HistorySession")
            .field("has_session_id", &true)
            .field("has_created_at", &true)
            .field("has_updated_at", &true)
            .field("has_title", &self.record.title.is_some())
            .field("runtime", &self.record.runtime)
            .field("has_model", &self.record.model.is_some())
            .finish()
    }
}

/// Lists native sessions through the typed app-server seam.
///
/// No native metadata is retained beyond the session handle and no local
/// catalog is persisted.
pub async fn list(endpoint: AppServerEndpoint, secret: &Secret) -> HistoryListResult {
    let (client, _) = match AppServerClient::connect_and_initialize_raw_only(endpoint, secret).await
    {
        Ok(connection) => connection,
        Err(error) => return HistoryResult::from_connect_error(error),
    };

    let result = match client.list_sessions().await {
        Ok(sessions) => HistoryResult::Complete(HistoryCatalog::from_native(sessions)),
        Err(error) => HistoryResult::from_read_error(error),
    };
    client.finish_with_cleanup(result).await
}

/// Loads a bounded, renderer-safe native transcript window.
///
/// Bounded decoding and native replay alignment are delegated to the existing
/// hydration owner. This wrapper adds history-level unavailable/unknown
/// projection without creating a transcript or event-store shadow.
pub async fn load(
    endpoint: AppServerEndpoint,
    secret: &Secret,
    session_id: SessionId,
    request: HydrationWindowRequest,
) -> HistoryLoadResult {
    let (client, _) = match AppServerClient::connect_and_initialize_raw_only(endpoint, secret).await
    {
        Ok(connection) => connection,
        Err(error) => return HistoryResult::from_connect_error(error),
    };

    let result = match client
        .load_session(SessionLoadParams::new(session_id.clone()))
        .await
    {
        Ok(session) if session.session_id == session_id => {
            let hydration =
                hydration::hydrate_connected_for_history(&client, session, request).await;
            match hydration {
                HydrationResult::Complete(snapshot) => HistoryResult::Complete(snapshot),
                HydrationResult::Incomplete(reason) => match reason {
                    HydrationIncomplete::ConnectionInterrupted => HistoryResult::Unknown,
                    HydrationIncomplete::SourceUnavailable => HistoryResult::Unavailable,
                    reason => HistoryResult::Incomplete(reason),
                },
            }
        }
        Ok(_) => HistoryResult::Incomplete(HydrationIncomplete::ProtocolRejected),
        Err(AppServerClientError::SessionNotFound) => HistoryResult::NotFound,
        Err(error) => HistoryResult::from_read_error(error),
    };
    client.finish_with_cleanup(result).await
}

/// Recovers the native event cursor for one session without exposing event
/// payloads or treating the cursor as a run/message/transcript identity.
pub async fn recover(
    endpoint: AppServerEndpoint,
    secret: &Secret,
    cursor: EventRecoveryCursor,
    limit: Option<ReplayLimit>,
) -> HistoryRecoveryResult {
    let (client, _) = match AppServerClient::connect_and_initialize_raw_only(endpoint, secret).await
    {
        Ok(connection) => connection,
        Err(error) => return HistoryResult::from_connect_error(error),
    };

    let result = match client.recover_events(cursor, limit).await {
        Ok(recovery) => HistoryResult::Complete(recovery),
        Err(error) => HistoryResult::from_read_error(error),
    };
    client.finish_with_cleanup(result).await
}

impl<T> HistoryResult<T> {
    fn from_connect_error(error: AppServerClientError) -> Self {
        match error {
            AppServerClientError::PeerRejected
            | AppServerClientError::Protocol
            | AppServerClientError::InitializeFailed => {
                Self::Incomplete(HydrationIncomplete::ProtocolRejected)
            }
            AppServerClientError::SessionNotFound => Self::NotFound,
            _ => Self::Unavailable,
        }
    }

    fn from_read_error(error: AppServerClientError) -> Self {
        match error {
            AppServerClientError::SessionNotFound => Self::NotFound,
            AppServerClientError::EventRecoveryRequired => {
                Self::Incomplete(HydrationIncomplete::ReplayRecoveryRequired)
            }
            AppServerClientError::PeerRejected => {
                Self::Incomplete(HydrationIncomplete::SourceRejected)
            }
            AppServerClientError::Protocol
            | AppServerClientError::InitializeFailed
            | AppServerClientError::InvalidEndpoint
            | AppServerClientError::HealthFailed
            | AppServerClientError::UpgradeFailed
            | AppServerClientError::HealthDeadline
            | AppServerClientError::UpgradeDeadline => {
                Self::Incomplete(HydrationIncomplete::ProtocolRejected)
            }
            AppServerClientError::ConnectionClosed
            | AppServerClientError::RequestDeadline
            | AppServerClientError::UnknownResponse
            | AppServerClientError::Transport => Self::Unknown,
            AppServerClientError::CloseFailed => {
                Self::Incomplete(HydrationIncomplete::ConnectionCloseFailed)
            }
        }
    }
}

impl HistoryCatalog {
    fn from_native(result: SessionListResult) -> Self {
        Self {
            sessions: result
                .sessions
                .into_iter()
                .map(|session| HistorySession { record: session })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

    use super::*;
    use crate::{
        lifecycle::secret::Secret,
        session::{
            client::{AppServerEndpoint, EventRecoveryCursor},
            hydration::{HydratedMessageRole, HydrationWindowMode},
            model::Sequence,
            protocol_event::ReplayLimit,
        },
    };

    type TestSocket = WebSocketStream<TcpStream>;

    #[test]
    fn catalog_keeps_only_native_session_handles() {
        let catalog = HistoryCatalog::from_native(SessionListResult { sessions: vec![] });
        assert!(catalog.sessions().is_empty());
        assert!(catalog.session_facts().next().is_none());
        assert!(!format!("{catalog:?}").contains("transcript"));
    }

    #[test]
    fn result_keeps_not_found_unknown_and_unavailable_distinct() {
        assert_eq!(HistoryResult::<()>::NotFound, HistoryResult::NotFound);
        assert_eq!(HistoryResult::<()>::Unknown, HistoryResult::Unknown);
        assert_eq!(HistoryResult::<()>::Unavailable, HistoryResult::Unavailable);
    }

    #[test]
    fn client_failures_preserve_read_uncertainty() {
        assert_eq!(
            HistoryResult::<()>::from_read_error(AppServerClientError::SessionNotFound),
            HistoryResult::NotFound
        );
        assert_eq!(
            HistoryResult::<()>::from_read_error(AppServerClientError::RequestDeadline),
            HistoryResult::Unknown
        );
        assert_eq!(
            HistoryResult::<()>::from_read_error(AppServerClientError::EventRecoveryRequired),
            HistoryResult::Incomplete(HydrationIncomplete::ReplayRecoveryRequired)
        );
        assert_eq!(
            HistoryResult::<()>::from_connect_error(AppServerClientError::HealthFailed),
            HistoryResult::Unavailable
        );
        assert_eq!(
            crate::session::client::outcome_after_cleanup(
                HistoryResult::Complete(()),
                Err(AppServerClientError::CloseFailed)
            ),
            HistoryResult::Complete(())
        );
    }

    #[test]
    fn history_debug_does_not_expose_native_identity_or_payload() {
        let session = HistorySession {
            record: serde_json::from_value(session_record("session-secret", "private-model"))
                .unwrap(),
        };
        let catalog = HistoryCatalog {
            sessions: vec![session],
        };
        let debug = format!("{catalog:?}");
        assert!(!debug.contains("session-secret"));
        assert!(!debug.contains("workspace"));
        assert!(!debug.contains("transcript"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_reads_only_the_native_session_catalog_without_creating_or_retaining_metadata() {
        let (endpoint, server) = test_server(TestServerScript::List).await;
        let result = list(endpoint, &Secret::new("history-list-token".into()).unwrap()).await;

        let HistoryResult::Complete(catalog) = result else {
            panic!("native list should complete: {result:?}");
        };
        assert_eq!(catalog.sessions().len(), 1);
        assert_eq!(
            catalog.sessions()[0].session_id().as_str(),
            "history-session"
        );
        let facts = catalog.session_facts().next().expect("catalog fact");
        assert_eq!(facts.session_id().as_str(), "history-session");
        assert_eq!(facts.model(), Some("private-model"));
        assert!(matches!(
            facts.endpoint_session_id(),
            crate::session::catalog::SessionCatalogFact::Available(session_id)
                if session_id.as_str() == "history-session"
        ));
        assert!(!format!("{catalog:?}").contains("private-model"));
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn load_reads_the_bounded_native_history_seam_without_create_or_crosswalk() {
        let (endpoint, server) = test_server(TestServerScript::Load).await;
        let result = load(
            endpoint,
            &Secret::new("history-load-token".into()).unwrap(),
            SessionId::try_new("history-session").unwrap(),
            HydrationWindowRequest::new(HydrationWindowMode::Latest, 20, None),
        )
        .await;

        let HistoryResult::Complete(snapshot) = result else {
            panic!("native history should complete: {result:?}");
        };
        assert_eq!(snapshot.messages().len(), 1);
        assert_eq!(snapshot.messages()[0].role(), HydratedMessageRole::User);
        assert_eq!(snapshot.messages()[0].text(), "visible-history");
        assert!(!format!("{snapshot:?}").contains("visible-history"));
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn load_pages_replay_until_the_snapshot_cursor() {
        let (endpoint, server) = test_server(TestServerScript::LoadPaged).await;
        let result = load(
            endpoint,
            &Secret::new("history-load-token".into()).unwrap(),
            SessionId::try_new("history-session").unwrap(),
            HydrationWindowRequest::new(HydrationWindowMode::Latest, 20, None),
        )
        .await;

        assert!(matches!(result, HistoryResult::Complete(_)));
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn load_preserves_native_session_not_found_without_retry_or_create() {
        let (endpoint, server) = test_server(TestServerScript::LoadNotFound).await;
        let result = load(
            endpoint,
            &Secret::new("history-not-found-token".into()).unwrap(),
            SessionId::try_new("missing-history-session").unwrap(),
            HydrationWindowRequest::latest(),
        )
        .await;

        assert_eq!(result, HistoryResult::NotFound);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recover_uses_the_session_bound_cursor_and_projects_no_event_payload() {
        let (endpoint, server) = test_server(TestServerScript::Recover).await;
        let result = recover(
            endpoint,
            &Secret::new("history-recovery-token".into()).unwrap(),
            EventRecoveryCursor::resume_after(
                SessionId::try_new("history-session").unwrap(),
                Sequence::try_new(4).unwrap(),
            ),
            Some(ReplayLimit::try_new(8.0).unwrap()),
        )
        .await;

        let HistoryResult::Complete(recovery) = result else {
            panic!("native recovery should complete: {result:?}");
        };
        assert_eq!(recovery.cursor().session_id().as_str(), "history-session");
        assert_eq!(recovery.cursor().sequence().get(), 6);
        assert_eq!(recovery.event_count(), 2);
        let debug = format!("{recovery:?}");
        assert!(!debug.contains("private-event"));
        server.await.unwrap();
    }

    #[derive(Clone, Copy)]
    enum TestServerScript {
        List,
        Load,
        LoadPaged,
        LoadNotFound,
        Recover,
    }

    async fn test_server(
        script: TestServerScript,
    ) -> (AppServerEndpoint, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = AppServerEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let server = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap().0;
            let mut socket = accept_async(stream).await.unwrap();
            let initialize = read_json(&mut socket).await;
            assert_eq!(initialize["method"], "initialize");
            send_json(
                &mut socket,
                json!({
                    "jsonrpc": "2.0",
                    "id": initialize["id"],
                    "result": {
                        "protocolVersion": "matcha-agent-app-server-v1",
                        "serverVersion": "2.2.1",
                        "capabilities": {
                            "eventReplay": true,
                            "snapshots": true,
                            "approvals": true,
                            "sdkMessageEnvelope": true,
                            "blobStore": true,
                            "sessionTranscript": true
                        }
                    }
                }),
            )
            .await;
            match script {
                TestServerScript::List => serve_list(&mut socket).await,
                TestServerScript::Load => serve_load(&mut socket).await,
                TestServerScript::LoadPaged => serve_load_paged(&mut socket).await,
                TestServerScript::LoadNotFound => serve_load_not_found(&mut socket).await,
                TestServerScript::Recover => serve_recover(&mut socket).await,
            }
            let _ = socket.next().await;
        });
        (endpoint, server)
    }

    async fn serve_list(socket: &mut TestSocket) {
        let request = read_json(socket).await;
        assert_eq!(request["method"], "session.list");
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"sessions": [session_record("history-session", "private-model")]}
            }),
        )
        .await;
    }

    async fn serve_load(socket: &mut TestSocket) {
        let load = read_json(socket).await;
        assert_eq!(load["method"], "session.load");
        assert_eq!(load["params"], json!({"sessionId": "history-session"}));
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": load["id"],
                "result": session_record_at("history-session", "private-model", 1)
            }),
        )
        .await;

        let transcript = read_json(socket).await;
        assert_eq!(transcript["method"], "session.transcript");
        assert_eq!(
            transcript["params"],
            json!({"sessionId": "history-session"})
        );
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": transcript["id"],
                "result": {"lines": [r#"{"message":{"role":"user","content":"visible-history"}}"#]}
            }),
        )
        .await;

        let snapshot = read_json(socket).await;
        assert_eq!(snapshot["method"], "session.snapshot");
        assert_eq!(snapshot["params"], json!({"sessionId": "history-session"}));
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": snapshot["id"],
                "result": {
                    "session": session_record_at("history-session", "private-model", 1),
                    "version": 1,
                    "updatedAt": "now",
                    "runs": [],
                    "messages": [],
                    "pendingApprovals": []
                }
            }),
        )
        .await;

        let replay = read_json(socket).await;
        assert_eq!(replay["method"], "events.replay");
        assert_eq!(
            replay["params"],
            json!({"sessionId": "history-session", "afterSeq": 0, "limit": 128.0})
        );
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": replay["id"],
                "result": {"events": [event_envelope(1, "history-event")]}
            }),
        )
        .await;
    }

    async fn serve_load_paged(socket: &mut TestSocket) {
        let load = read_json(socket).await;
        assert_eq!(load["method"], "session.load");
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": load["id"],
                "result": session_record_at("history-session", "private-model", 257)
            }),
        )
        .await;

        let transcript = read_json(socket).await;
        assert_eq!(transcript["method"], "session.transcript");
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": transcript["id"],
                "result": {"lines": [r#"{"message":{"role":"user","content":"visible-history"}}"#]}
            }),
        )
        .await;

        let snapshot = read_json(socket).await;
        assert_eq!(snapshot["method"], "session.snapshot");
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": snapshot["id"],
                "result": {
                    "session": session_record_at("history-session", "private-model", 257),
                    "version": 257,
                    "updatedAt": "now",
                    "runs": [],
                    "messages": [],
                    "pendingApprovals": []
                }
            }),
        )
        .await;

        serve_replay_page(socket, 0, 128.0, 1, 128).await;
        serve_replay_page(socket, 128, 128.0, 129, 256).await;
        serve_replay_page(socket, 256, 128.0, 257, 257).await;
    }

    async fn serve_load_not_found(socket: &mut TestSocket) {
        let load = read_json(socket).await;
        assert_eq!(load["method"], "session.load");
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": load["id"],
                "error": {"code": -32001, "message": "Session not found: missing-history-session"}
            }),
        )
        .await;
    }

    async fn serve_replay_page(
        socket: &mut TestSocket,
        after_seq: u64,
        limit: f64,
        first_seq: u64,
        last_seq: u64,
    ) {
        let replay = read_json(socket).await;
        assert_eq!(replay["method"], "events.replay");
        assert_eq!(
            replay["params"],
            json!({"sessionId": "history-session", "afterSeq": after_seq, "limit": limit})
        );
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": replay["id"],
                "result": {"events": (first_seq..=last_seq).map(|sequence| event_envelope(sequence, "history-event")).collect::<Vec<_>>()}
            }),
        )
        .await;
    }

    async fn serve_recover(socket: &mut TestSocket) {
        let replay = read_json(socket).await;
        assert_eq!(replay["method"], "events.replay");
        assert_eq!(
            replay["params"],
            json!({"sessionId": "history-session", "afterSeq": 4, "limit": 8.0})
        );
        send_json(
            socket,
            json!({
                "jsonrpc": "2.0",
                "id": replay["id"],
                "result": {
                    "events": [event_envelope(5, "private-event"), event_envelope(6, "private-event-2")]
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

    fn session_record(session_id: &str, model: &str) -> Value {
        session_record_at(session_id, model, 0)
    }

    fn session_record_at(session_id: &str, model: &str, last_seq: u64) -> Value {
        json!({
            "sessionId": session_id,
            "createdAt": "created-at",
            "updatedAt": "updated-at",
            "runtime": "matcha-agent",
            "lastSeq": last_seq,
            "lastSnapshotVersion": 1,
            "model": model,
            "permissionMode": "private-mode",
            "workerState": {"state": "unloaded", "reason": "notStarted"}
        })
    }

    fn event_envelope(sequence: u64, event_id: &str) -> Value {
        json!({
            "eventId": event_id,
            "sessionId": "history-session",
            "seq": sequence,
            "runId": "private-run",
            "createdAt": "now",
            "event": {
                "type": "message.delta",
                "messageId": format!("private-message-{sequence}"),
                "delta": "private-payload"
            }
        })
    }
}
