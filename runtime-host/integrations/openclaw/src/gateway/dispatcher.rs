use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    connection::{ExchangeFailure, GatewayConnection, GatewayFrame},
    delivery::{DispatcherError, MutationDelivery},
    wire::{GatewayResponse, RpcRequest},
};

pub(crate) const REQUEST_DEADLINE: Duration = Duration::from_secs(30);

/// Narrow façade over the socket actor. It deliberately exposes no transport
/// trait and never retries a request.
pub(crate) struct Dispatcher {
    connection: GatewayConnection,
}

impl Dispatcher {
    pub(crate) fn new(
        socket: super::client::GatewaySocket,
    ) -> (Self, mpsc::Receiver<GatewayFrame>) {
        let (events, receiver) = mpsc::channel(256);
        (
            Self {
                connection: GatewayConnection::spawn(socket, events),
            },
            receiver,
        )
    }

    pub(crate) async fn query(
        &self,
        request: RpcRequest,
    ) -> Result<GatewayResponse, DispatcherError> {
        self.query_with_deadline(request, REQUEST_DEADLINE).await
    }

    pub(crate) async fn query_with_deadline(
        &self,
        request: RpcRequest,
        deadline: Duration,
    ) -> Result<GatewayResponse, DispatcherError> {
        self.query_with_deadline_cancellable(request, deadline, &CancellationToken::new()).await
    }

    pub(crate) async fn query_with_deadline_cancellable(
        &self,
        request: RpcRequest,
        deadline: Duration,
        cancellation: &CancellationToken,
    ) -> Result<GatewayResponse, DispatcherError> {
        self.connection.request_cancellable(request, deadline, cancellation).await
            .map_err(|failure| failure.error)
    }

    pub(crate) async fn ordered_query(
        &self,
        request: RpcRequest,
    ) -> Result<GatewayResponse, DispatcherError> {
        self.ordered_query_cancellable(request, &CancellationToken::new()).await
    }

    pub(crate) async fn ordered_query_cancellable(
        &self,
        request: RpcRequest,
        cancellation: &CancellationToken,
    ) -> Result<GatewayResponse, DispatcherError> {
        self.connection.ordered_request_cancellable(request, REQUEST_DEADLINE, cancellation).await
            .map_err(|failure| failure.error)
    }

    pub(crate) async fn mutate(&self, request: RpcRequest) -> MutationDelivery {
        self.mutate_with_deadline(request, REQUEST_DEADLINE).await
    }

    pub(crate) async fn mutate_cancellable(
        &self,
        request: RpcRequest,
        cancellation: &CancellationToken,
    ) -> MutationDelivery {
        self.mutate_with_deadline_cancellable(request, REQUEST_DEADLINE, cancellation).await
    }

    pub(crate) async fn mutate_with_deadline(
        &self,
        request: RpcRequest,
        deadline: Duration,
    ) -> MutationDelivery {
        self.mutate_with_deadline_cancellable(request, deadline, &CancellationToken::new()).await
    }

    async fn mutate_with_deadline_cancellable(
        &self,
        request: RpcRequest,
        deadline: Duration,
        cancellation: &CancellationToken,
    ) -> MutationDelivery {
        match self.connection.request_cancellable(request, deadline, cancellation).await {
            Ok(response) => MutationDelivery::Response(response),
            Err(failure) => mutation_failure(failure),
        }
    }

    pub(crate) async fn mutate_encoded(
        &self,
        request_id: String,
        encoded: String,
        deadline: Duration,
    ) -> MutationDelivery {
        self.mutate_encoded_cancellable(request_id, encoded, deadline, &CancellationToken::new()).await
    }

    pub(crate) async fn mutate_encoded_cancellable(
        &self,
        request_id: String,
        encoded: String,
        deadline: Duration,
        cancellation: &CancellationToken,
    ) -> MutationDelivery {
        match self.connection.encoded_request_cancellable(request_id, encoded, deadline, cancellation).await {
            Ok(response) => MutationDelivery::Response(response),
            Err(failure) => mutation_failure(failure),
        }
    }

    pub(crate) fn failure(&self) -> tokio::sync::watch::Receiver<Option<DispatcherError>> {
        self.connection.failure()
    }

    pub(crate) async fn closed(&self) {
        self.connection.closed().await;
    }

    pub(crate) async fn disconnect(&self, expires_at: tokio::time::Instant) {
        self.connection.disconnect(expires_at).await;
    }

    pub(crate) async fn close(self) {
        self.connection.close().await;
    }
}

fn mutation_failure(failure: ExchangeFailure) -> MutationDelivery {
    if failure.sent {
        MutationDelivery::MayHaveReached(failure.error)
    } else {
        MutationDelivery::NotWritten(failure.error)
    }
}
