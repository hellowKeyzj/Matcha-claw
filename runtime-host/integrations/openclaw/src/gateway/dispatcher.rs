use std::time::Duration;

use tokio::sync::mpsc;

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
        self.connection
            .request(request, deadline)
            .await
            .map_err(|failure| failure.error)
    }

    pub(crate) async fn ordered_query(
        &self,
        request: RpcRequest,
    ) -> Result<GatewayResponse, DispatcherError> {
        self.connection.ordered_request(request, REQUEST_DEADLINE).await
            .map_err(|failure| failure.error)
    }

    pub(crate) async fn mutate(&self, request: RpcRequest) -> MutationDelivery {
        self.mutate_with_deadline(request, REQUEST_DEADLINE).await
    }

    pub(crate) async fn mutate_with_deadline(
        &self,
        request: RpcRequest,
        deadline: Duration,
    ) -> MutationDelivery {
        match self.connection.request(request, deadline).await {
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
        match self
            .connection
            .encoded_request(request_id, encoded, deadline)
            .await
        {
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

    pub(crate) async fn disconnect(&self) {
        self.connection.disconnect().await;
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
