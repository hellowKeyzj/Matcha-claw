use environment::Connector;
use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use super::command::{ConnectorCommand, ConnectorQuery};
use crate::{
    external_connectors::{
        CatalogOutcome, GetOutcome, ListOutcome, MutationOutcome, OpenClawMcpServersOutcome,
        ProbeOutcome, SessionMcpServerEnabledOutcome, SessionMcpServerEnabledTarget,
        SessionStatusOutcome, SessionStatusTarget, StatusOutcome,
    },
    transport::provider_accounts::private_auth::Resolver,
};

#[derive(Clone)]
pub(crate) struct ConnectorHandle {
    owner: OwnerRuntimeHandle<ConnectorCommand, ConnectorQuery>,
}

impl ConnectorHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ConnectorCommand, ConnectorQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn list(&self) -> Result<ListOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::List { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn catalog(&self) -> Result<CatalogOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Catalog { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn status(&self) -> Result<StatusOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Status { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn get(&self, id: String) -> Result<GetOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Get { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn upsert(&self, connector: Connector) -> Result<MutationOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::Upsert {
                connector: Box::new(connector),
                reply,
            })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn remove(&self, id: String) -> Result<MutationOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::Remove { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn probe(&self, id: String) -> Result<ProbeOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Probe { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn session_status(
        &self,
        target: SessionStatusTarget,
    ) -> Result<SessionStatusOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::SessionStatus { target, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn openclaw_mcp_servers(&self) -> Result<OpenClawMcpServersOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::OpenClawMcpServers { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn set_session_mcp_server_enabled(
        &self,
        target: SessionMcpServerEnabledTarget,
    ) -> Result<SessionMcpServerEnabledOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::SetSessionMcpServerEnabled { target, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn configure_private_resolver(&self, resolver: Resolver) -> Result<(), ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::ConfigurePrivateResolver { resolver, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }
}
