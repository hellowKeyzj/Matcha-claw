use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    delivery::{DispatcherError, MutationDelivery},
    wire::{self, GatewayResponse},
};

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn debug_cron_provider(stage: &'static str, error_class: &'static str) {
    if std::env::var_os("MATCHACLAW_DEBUG_CRON_PROVIDER").is_some() {
        eprintln!("[DEBUG-cron-provider] {stage}={error_class}");
    }
}

fn gateway_error_class(error: GatewayClientError) -> &'static str {
    match error {
        GatewayClientError::InvalidEndpoint => "invalid_endpoint",
        GatewayClientError::InvalidClientMetadata => "invalid_client_metadata",
        GatewayClientError::Authentication => "authentication",
        GatewayClientError::UpgradeDeadline => "upgrade_deadline",
        GatewayClientError::UpgradeFailed => "upgrade_failed",
        GatewayClientError::ChallengeDeadline => "challenge_deadline",
        GatewayClientError::ChallengeFailed => "challenge_failed",
        GatewayClientError::ConnectDeadline => "connect_deadline",
        GatewayClientError::Starting => "starting",
        GatewayClientError::ConnectFailed => "connect_failed",
        GatewayClientError::RpcDeadline => "rpc_deadline",
        GatewayClientError::RpcFailed => "rpc_failed",
        GatewayClientError::ConnectionClosed => "connection_closed",
        GatewayClientError::Transport => "transport",
        GatewayClientError::Protocol => "protocol",
        GatewayClientError::SecretCleanupFailed => "secret_cleanup_failed",
    }
}

fn dispatcher_error_class(error: DispatcherError) -> &'static str {
    match error {
        DispatcherError::Deadline => "rpc_deadline",
        DispatcherError::ConnectionClosed => "connection_closed",
        DispatcherError::Transport => "transport",
        DispatcherError::Protocol => "protocol",
        DispatcherError::EventBackpressure => "event_backpressure",
        DispatcherError::Saturated => "saturated",
    }
}

pub(crate) struct CronProvider {
    gateway: Arc<GatewayClient>,
}

impl CronProvider {
    pub(crate) fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub(crate) async fn list(&self) -> Result<wire::cron::CronJobs, CronReadFailure> {
        let mut offset = 0;
        let mut jobs = Vec::new();
        loop {
            let request = wire::cron::list_request(next_request_id("list"), offset)
                .map_err(|_| CronReadFailure::Protocol)?;
            let page = self.read(request, wire::cron::decode_list).await?;
            jobs.extend(page.jobs);
            let Some(next_offset) = page.next_offset else {
                return Ok(wire::cron::CronJobs {
                    total: jobs.len() as u64,
                    offset: 0,
                    limit: jobs.len().max(1) as u64,
                    has_more: false,
                    jobs,
                    next_offset: None,
                });
            };
            if next_offset <= offset {
                return Err(CronReadFailure::Protocol);
            }
            offset = next_offset;
        }
    }

    pub(crate) async fn run_history(
        &self,
        job_id: String,
        limit: u64,
    ) -> Result<Vec<wire::cron::CronRunHistoryEntry>, CronHistoryReadFailure> {
        let mut offset = 0;
        let mut entries = Vec::new();
        loop {
            let request = wire::cron::runs_page_request(
                next_request_id("runs"),
                job_id.clone(),
                limit,
                offset,
            )
            .map_err(|_| CronHistoryReadFailure::Protocol)?;
            let page = self
                .read_history(request, wire::cron::decode_runs_page)
                .await?;
            entries.extend(page.entries);
            let Some(next_offset) = page.next_offset else {
                return Ok(entries);
            };
            if next_offset <= offset {
                return Err(CronHistoryReadFailure::Protocol);
            }
            offset = next_offset;
        }
    }

    pub(crate) async fn run_status(
        &self,
        job_id: String,
        run_id: String,
    ) -> Result<Option<wire::cron::CronRunStatus>, CronHistoryReadFailure> {
        let entries = self.run_history(job_id.clone(), 200).await?;
        Ok(entries.into_iter().find_map(|entry| {
            (entry.job_id == job_id && entry.run_id.as_deref() == Some(run_id.as_str()))
                .then_some(entry.status)
                .flatten()
        }))
    }

    pub(crate) async fn add(
        &self,
        job: wire::cron::CronJobCreate,
    ) -> CronMutationOutcome<wire::cron::CronJob> {
        let request = match wire::cron::add_request(next_request_id("add"), job) {
            Ok(request) => request,
            Err(_) => return CronMutationOutcome::Rejected,
        };
        self.mutate(request, wire::cron::decode_add).await
    }

    pub(crate) async fn update(
        &self,
        job_id: String,
        patch: wire::cron::CronJobPatch,
        expected_config_revision: Option<String>,
    ) -> CronMutationOutcome<wire::cron::CronJob> {
        let request = match wire::cron::update_request(
            next_request_id("update"),
            job_id,
            patch,
            expected_config_revision,
        ) {
            Ok(request) => request,
            Err(_) => return CronMutationOutcome::Rejected,
        };
        self.mutate(request, wire::cron::decode_update).await
    }

    pub(crate) async fn remove(
        &self,
        job_id: String,
    ) -> CronMutationOutcome<wire::cron::CronRemoved> {
        let request = match wire::cron::remove_request(next_request_id("remove"), job_id) {
            Ok(request) => request,
            Err(_) => return CronMutationOutcome::Rejected,
        };
        self.mutate(request, wire::cron::decode_remove).await
    }

    async fn read_history<T>(
        &self,
        request: wire::RpcRequest,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, CronHistoryReadFailure> {
        let response = self.gateway.rpc_query(request).await;
        match response {
            Ok(GatewayResponse::Failure { .. }) => {
                debug_cron_provider("history_rpc", "rejected");
                Err(CronHistoryReadFailure::Rejected)
            }
            Ok(response) => decode(response).map_err(|_| {
                debug_cron_provider("history_decode", "invalid_response");
                CronHistoryReadFailure::Protocol
            }),
            Err(error) => {
                debug_cron_provider("history_rpc", gateway_error_class(error));
                Err(map_history_connection_failure(error))
            }
        }
    }

    async fn read<T>(
        &self,
        request: wire::RpcRequest,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> Result<T, CronReadFailure> {
        let response = self.gateway.rpc_query(request).await;
        match response {
            Ok(GatewayResponse::Failure { .. }) => {
                debug_cron_provider("rpc", "rejected");
                Err(CronReadFailure::Rejected)
            }
            Ok(response) => decode(response).map_err(|_| {
                debug_cron_provider("decode", "invalid_response");
                CronReadFailure::Protocol
            }),
            Err(error) => {
                debug_cron_provider("rpc", gateway_error_class(error));
                Err(map_read_connection_failure(error))
            }
        }
    }

    async fn mutate<T>(
        &self,
        request: wire::RpcRequest,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> CronMutationOutcome<T> {
        map_mutation_response(self.gateway.rpc_mutation(request).await, decode)
    }
}

impl fmt::Debug for CronProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CronProvider")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronHistoryReadFailure {
    Unavailable,
    Rejected,
    Protocol,
    Deadline,
}

#[derive(Debug, Eq, PartialEq)]
pub enum CronMutationOutcome<T> {
    Applied(T),
    Rejected,
    OutcomeUnknown,
}

fn map_mutation_response<T>(
    response: MutationDelivery,
    decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
) -> CronMutationOutcome<T> {
    match response {
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
            debug_cron_provider("admin_rpc", "rejected");
            CronMutationOutcome::Rejected
        }
        MutationDelivery::Response(response) => match decode(response) {
            Ok(value) => CronMutationOutcome::Applied(value),
            Err(_) => {
                debug_cron_provider("admin_decode", "invalid_response");
                CronMutationOutcome::OutcomeUnknown
            }
        },
        MutationDelivery::NotWritten(error) => {
            debug_cron_provider("admin_rpc", dispatcher_error_class(error));
            CronMutationOutcome::Rejected
        }
        MutationDelivery::MayHaveReached(error) => {
            debug_cron_provider("admin_rpc", dispatcher_error_class(error));
            CronMutationOutcome::OutcomeUnknown
        }
    }
}

fn map_read_connection_failure(error: GatewayClientError) -> CronReadFailure {
    match error {
        GatewayClientError::Protocol | GatewayClientError::RpcFailed => CronReadFailure::Protocol,
        _ => CronReadFailure::Unavailable,
    }
}

fn map_history_connection_failure(error: GatewayClientError) -> CronHistoryReadFailure {
    match error {
        GatewayClientError::Protocol | GatewayClientError::RpcFailed => {
            CronHistoryReadFailure::Protocol
        }
        GatewayClientError::UpgradeDeadline
        | GatewayClientError::ChallengeDeadline
        | GatewayClientError::ConnectDeadline
        | GatewayClientError::RpcDeadline => CronHistoryReadFailure::Deadline,
        GatewayClientError::InvalidEndpoint
        | GatewayClientError::InvalidClientMetadata
        | GatewayClientError::Authentication
        | GatewayClientError::UpgradeFailed
        | GatewayClientError::ChallengeFailed
        | GatewayClientError::Starting
        | GatewayClientError::ConnectFailed
        | GatewayClientError::ConnectionClosed
        | GatewayClientError::Transport
        | GatewayClientError::SecretCleanupFailed => CronHistoryReadFailure::Unavailable,
    }
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("cron-{operation}-{sequence}")
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::{
        net::TcpListener,
        time::{sleep, timeout},
    };
    use tokio_tungstenite::tungstenite::Message;

    use crate::gateway::{
        auth::GatewaySecret,
        client::{
            GatewayClientMetadata, GatewayEndpoint,
            test_support::{TestSocket, TestTlsIdentity, accept_websocket},
        },
    };

    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn delayed_valid_list_response_outlives_the_former_transport_cutoff() {
        let delay = Duration::from_secs(6);
        let old_cutoff = timeout(Duration::from_secs(5), delayed_valid_list(delay)).await;
        assert!(
            old_cutoff.is_err(),
            "the former five-second transport cutoff rejects a valid CronProvider response"
        );

        let jobs = timeout(Duration::from_secs(30), delayed_valid_list(delay))
            .await
            .expect("the renderer public budget accepts a valid delayed CronProvider response")
            .expect("the valid delayed CronProvider response decodes");
        assert!(jobs.jobs.is_empty());
    }

    async fn delayed_valid_list(delay: Duration) -> Result<wire::cron::CronJobs, CronReadFailure> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let gateway = Arc::new(GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("delayed-cron-provider-test-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
        ));
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type": "event", "event": "connect.challenge",
                    "payload": {"nonce": "delayed-cron-provider-nonce", "ts": 42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            assert_eq!(
                connect["params"]["scopes"],
                json!([
                    "operator.read",
                    "operator.write",
                    "operator.admin",
                    "operator.approvals"
                ])
            );
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;

            let request = read_json(&mut socket).await;
            assert_eq!(request["method"], wire::cron::CRON_LIST_METHOD);
            sleep(delay).await;
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": request["id"], "ok": true,
                    "payload": {
                        "jobs": [], "total": 0, "offset": 0, "limit": 1,
                        "hasMore": false, "nextOffset": null, "deliveryPreviews": {}
                    }
                }),
            )
            .await;
            let _ = socket.next().await;
        });

        let result = CronProvider::new(gateway).list().await;
        peer.await.unwrap();
        result
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

    fn hello(id: &str) -> Value {
        json!({
            "type": "res", "id": id, "ok": true,
            "payload": {
                "type": "hello-ok", "protocol": 4,
                "server": {"version": wire::OPENCLAW_GATEWAY_VERSION, "connId": "delayed-cron-provider"},
                "features": {"methods": [
                    "status", "config.get", "config.patch", "config.apply", "plugins.refresh", "agents.list", "skills.status",
                    wire::SYSTEM_PRESENCE_METHOD,
                    wire::cron::CRON_LIST_METHOD,
                    "cron.status", wire::cron::CRON_RUNS_METHOD
                ], "events": ["tick"]},
                "snapshot": {
                    "presence": [], "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                },
                "auth": {"role": "operator", "scopes": [
                    "operator.read", "operator.write", "operator.admin", "operator.approvals"
                ]},
                "policy": {
                    "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                    "tickIntervalMs": 15000
                }
            }
        })
    }

    #[test]
    fn mutation_decode_ambiguity_is_outcome_unknown() {
        let response = crate::gateway::wire::decode_response(
            &json!({"type": "res", "id": "test", "ok": true, "payload": {}}).to_string(),
            "test",
        )
        .unwrap()
        .unwrap();

        assert!(matches!(
            map_mutation_response(MutationDelivery::Response(response), wire::cron::decode_run,),
            CronMutationOutcome::OutcomeUnknown
        ));
    }

    #[test]
    fn may_have_reached_mutation_is_outcome_unknown() {
        assert!(matches!(
            map_mutation_response(
                MutationDelivery::MayHaveReached(DispatcherError::Protocol),
                wire::cron::decode_run,
            ),
            CronMutationOutcome::OutcomeUnknown
        ));
    }

    #[test]
    fn not_written_mutation_is_rejected() {
        assert!(matches!(
            map_mutation_response(
                MutationDelivery::NotWritten(DispatcherError::Protocol),
                wire::cron::decode_run,
            ),
            CronMutationOutcome::Rejected
        ));
    }

    #[test]
    fn history_deadlines_remain_distinct_from_unavailability() {
        for error in [
            GatewayClientError::UpgradeDeadline,
            GatewayClientError::ChallengeDeadline,
            GatewayClientError::ConnectDeadline,
            GatewayClientError::RpcDeadline,
        ] {
            assert_eq!(
                map_history_connection_failure(error),
                CronHistoryReadFailure::Deadline
            );
        }
        assert_eq!(
            map_history_connection_failure(GatewayClientError::ConnectFailed),
            CronHistoryReadFailure::Unavailable
        );
    }

    #[test]
    fn history_protocol_failures_remain_distinct_from_deadlines() {
        assert_eq!(
            map_history_connection_failure(GatewayClientError::Protocol),
            CronHistoryReadFailure::Protocol
        );
        assert_eq!(
            map_history_connection_failure(GatewayClientError::RpcFailed),
            CronHistoryReadFailure::Protocol
        );
    }

    #[test]
    fn history_unavailable_failures_are_explicitly_classified() {
        for error in [
            GatewayClientError::InvalidEndpoint,
            GatewayClientError::InvalidClientMetadata,
            GatewayClientError::Authentication,
            GatewayClientError::UpgradeFailed,
            GatewayClientError::ChallengeFailed,
            GatewayClientError::Starting,
            GatewayClientError::ConnectFailed,
            GatewayClientError::ConnectionClosed,
            GatewayClientError::Transport,
            GatewayClientError::SecretCleanupFailed,
        ] {
            assert_eq!(
                map_history_connection_failure(error),
                CronHistoryReadFailure::Unavailable
            );
        }
    }
}
