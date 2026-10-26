use std::{future::Future, pin::Pin};

use foundation::execution::OwnedTask;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{ConnectionId, Revision, WorldRef},
    sources::PostgresConnectionConfig,
};
use zeroize::Zeroizing;

use super::SourceError;

pub type SourceFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, SourceError>> + Send + 'a>>;

/// Private material from the current source credential owner. Never serialized.
pub enum SourceCredential {
    None,
    HttpBearer(Zeroizing<String>),
    Postgres {
        user: Zeroizing<String>,
        password: Zeroizing<String>,
    },
}

/// The caller must drop the client and join the actual connection driver.
pub struct PgSourceConnection {
    pub client: tokio_postgres::Client,
    pub driver: OwnedTask<Result<(), tokio_postgres::Error>>,
}

/// The exporting connection stays idle until its owner cancels and joins the driver.
pub struct PgReplicationConnection {
    pub rows: Vec<Vec<Option<String>>>,
    pub driver: OwnedTask<Result<(), SourceError>>,
}

/// Host supplies private credentials and TLS, not source SQL or world facts.
pub trait SourceAccess: Send + Sync {
    fn credentials<'a>(
        &'a self,
        world: &'a WorldRef,
        connection: &'a ConnectionId,
        revision: Revision,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> SourceFuture<'a, SourceCredential>;

    fn connect_postgres<'a>(
        &'a self,
        config: &'a PostgresConnectionConfig,
        credential: SourceCredential,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> SourceFuture<'a, PgSourceConnection>;

    fn connect_postgres_replication<'a>(
        &'a self,
        config: &'a PostgresConnectionConfig,
        credential: SourceCredential,
        command: String,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> SourceFuture<'a, PgReplicationConnection>;
}
