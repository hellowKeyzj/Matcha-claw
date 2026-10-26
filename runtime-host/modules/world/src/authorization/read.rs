use super::{AuthError, active, actor_id, cap_expiry};
use crate::store::{WorldSnapshot, WorldTransaction};
use tokio_postgres::{Row, types::ToSql};
use world_protocol::{
    authorization::{Actor, AuthorizationFailure},
    ids::ActorId,
    time::Timestamp,
};

/// Only two existing store contexts. Snapshot never executes SELECT FOR SHARE:
/// its authority observation ends with that fresh read, not an external I/O lease.
#[derive(Clone, Copy)]
pub(super) enum AuthorityRead<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>),
    Snapshot(&'a WorldSnapshot<'b>),
}
impl AuthorityRead<'_, '_> {
    pub(super) fn world(&self) -> &world_protocol::ids::WorldRef {
        match self {
            Self::Transaction(tx) => tx.world(),
            Self::Snapshot(snapshot) => snapshot.world(),
        }
    }
    pub(super) async fn query(
        &self,
        locked: &'static str,
        read: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, AuthError> {
        match self {
            Self::Transaction(tx) => Ok(tx.query(locked, parameters).await?),
            Self::Snapshot(snapshot) => Ok(snapshot.query(read, parameters).await?),
        }
    }
    pub(super) async fn query_opt(
        &self,
        locked: &'static str,
        read: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, AuthError> {
        match self {
            Self::Transaction(tx) => Ok(tx.query_opt(locked, parameters).await?),
            Self::Snapshot(snapshot) => Ok(snapshot.query_opt(read, parameters).await?),
        }
    }
    pub(super) async fn principal(
        &self,
        issuer: &str,
        subject: &str,
        now: &Timestamp,
        until: &mut Timestamp,
    ) -> Result<Actor, AuthError> {
        let world = self.world();
        let row = self.query_opt(
            "SELECT actor_id,actor_kind,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND issuer=$3 AND subject=$4 FOR SHARE",
            "SELECT actor_id,actor_kind,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND issuer=$3 AND subject=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &issuer, &subject],
        ).await?.ok_or(AuthorizationFailure::InvalidPrincipal)?;
        cap_expiry(until, active(&row, now, AuthorizationFailure::Revoked)?);
        actor(&row)
    }
    pub(super) async fn represented(
        &self,
        expected: &Actor,
        now: &Timestamp,
        until: &mut Timestamp,
    ) -> Result<(), AuthError> {
        let world = self.world();
        let rows = self.query(
            "SELECT actor_id,actor_kind,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY issuer,subject FOR SHARE",
            "SELECT actor_id,actor_kind,active,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM world_auth_principal WHERE tenant_id=$1 AND world_id=$2 AND actor_id=$3 ORDER BY issuer,subject",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &actor_id(expected).as_str()],
        ).await?;
        for row in rows {
            match active(&row, now, AuthorizationFailure::Revoked) {
                Ok(expires) if &actor(&row)? == expected => {
                    cap_expiry(until, expires);
                    return Ok(());
                }
                Ok(_) | Err(AuthError::Denied(AuthorizationFailure::Revoked)) => {}
                Err(error) => return Err(error),
            }
        }
        Err(AuthorizationFailure::Revoked.into())
    }
}
fn actor(row: &Row) -> Result<Actor, AuthError> {
    let id = ActorId::try_new(row.get::<_, String>("actor_id"))
        .map_err(|_| AuthorizationFailure::InternalFault)?;
    match row.get::<_, String>("actor_kind").as_str() {
        "human" => Ok(Actor::Human { id }),
        "service" => Ok(Actor::Service { id }),
        _ => Err(AuthorizationFailure::InternalFault.into()),
    }
}
