use tokio_postgres::{Row, types::ToSql};
use world_protocol::{
    authorization::AuthorizationFailure,
    bindings::{BindingFailure, BindingNode},
    ids::{NodeId, WorldRef},
};

use super::InvocationLease;
use crate::{
    authorization::{self, Admission, AuthError},
    store::{StoreError, WorldSnapshot, WorldStore, WorldTransaction},
};

#[derive(Debug)]
pub(crate) enum CurrentFailure {
    Authorization(AuthError),
    Binding(BindingFailure),
    Store(StoreError),
    Package(crate::extensions::package::PackageError),
}
impl CurrentFailure {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{operation::OperationFailure, process::HostFailure};
        match self {
            Self::Authorization(AuthError::Denied(reason)) => {
                HostFailure::Authorization(reason.clone())
            }
            Self::Binding(reason) => HostFailure::Binding(reason.clone()),
            Self::Store(error) | Self::Authorization(AuthError::Store(error)) => {
                HostFailure::Operation(OperationFailure::Commit(error.reason.clone()))
            }
            Self::Package(error) => {
                HostFailure::Operation(OperationFailure::Package(error.reason.clone()))
            }
            Self::Authorization(AuthError::Codec(_)) => HostFailure::InternalFault,
        }
    }
}
impl std::fmt::Display for CurrentFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Authorization(error) => std::fmt::Display::fmt(error, formatter),
            Self::Binding(_) => formatter.write_str("world binding is not current"),
            Self::Store(error) => std::fmt::Display::fmt(error, formatter),
            Self::Package(error) => std::fmt::Display::fmt(error, formatter),
        }
    }
}
impl std::error::Error for CurrentFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Authorization(error) => Some(error),
            Self::Binding(_) => None,
            Self::Store(error) => Some(error),
            Self::Package(error) => Some(error),
        }
    }
}
impl From<crate::extensions::package::PackageError> for CurrentFailure {
    fn from(error: crate::extensions::package::PackageError) -> Self {
        Self::Package(error)
    }
}
impl From<StoreError> for CurrentFailure {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<AuthError> for CurrentFailure {
    fn from(error: AuthError) -> Self {
        Self::Authorization(error)
    }
}

/// Fresh authority and trust immediately around real I/O. An exact lease pins
/// implementation/resource custody, never a grant. No transaction crosses I/O.
pub(crate) async fn check_current(
    store: &WorldStore,
    admission: &Admission,
    lease: &InvocationLease,
    node: &NodeId,
) -> Result<(), CurrentFailure> {
    let node = leased_node(admission, lease, node)?.clone();
    let admission = admission.clone();
    store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(
                async move { recheck(CurrentRead::Snapshot(snapshot), &admission, &node).await },
            )
        })
        .await
}

/// Holds mutable authority rows through the caller's existing commit; never spans I/O.
pub(crate) async fn check_current_in_transaction(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    lease: &InvocationLease,
    node: &NodeId,
) -> Result<(), CurrentFailure> {
    let node = leased_node(admission, lease, node)?;
    if tx.world() != &admission.invocation().world {
        return Err(AuthError::Denied(AuthorizationFailure::InsufficientScope).into());
    }
    recheck(CurrentRead::Transaction(tx), admission, node).await
}

/// Rechecks an already selected node in the owner's existing transaction; not an invocation grant.
pub(crate) async fn check_node_in_transaction(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    node: &BindingNode,
) -> Result<(), CurrentFailure> {
    if tx.world() != &admission.invocation().world {
        return Err(AuthError::Denied(AuthorizationFailure::InsufficientScope).into());
    }
    recheck(CurrentRead::Transaction(tx), admission, node).await
}

fn leased_node<'a>(
    admission: &Admission,
    lease: &'a InvocationLease,
    node: &NodeId,
) -> Result<&'a BindingNode, CurrentFailure> {
    if admission.invocation().id != *lease.invocation()
        || admission.invocation().world != lease.graph().lock().world
        || lease.ledger(node).is_none()
    {
        return Err(AuthError::Denied(AuthorizationFailure::InsufficientScope).into());
    }
    lease.graph().node(node).map_err(CurrentFailure::Binding)
}

enum CurrentRead<'a, 'b> {
    Snapshot(&'a WorldSnapshot<'b>),
    Transaction(&'a WorldTransaction<'b>),
}

impl CurrentRead<'_, '_> {
    fn world(&self) -> &WorldRef {
        match self {
            Self::Snapshot(snapshot) => snapshot.world(),
            Self::Transaction(tx) => tx.world(),
        }
    }

    async fn query_opt(
        &self,
        sql: &'static str,
        locked: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, StoreError> {
        match self {
            Self::Snapshot(snapshot) => snapshot.query_opt(sql, parameters).await,
            Self::Transaction(tx) => tx.query_opt(locked, parameters).await,
        }
    }
}

async fn recheck(
    reader: CurrentRead<'_, '_>,
    admission: &Admission,
    node: &BindingNode,
) -> Result<(), CurrentFailure> {
    match &reader {
        CurrentRead::Snapshot(snapshot) => {
            authorization::recheck_read(snapshot, admission, &snapshot.now().await?).await?;
        }
        CurrentRead::Transaction(tx) => {
            authorization::recheck(tx, admission, &tx.now().await?).await?;
        }
    }
    let implementation = &node.implementation;
    let world = reader.world();
    let unavailable = || {
        CurrentFailure::Binding(BindingFailure::PackageUnavailable {
            node_id: node.id.clone(),
            install_id: implementation.install_id.clone(),
        })
    };
    let row = reader.query_opt(
        "SELECT phase,desired_enabled,pending_removal,package_digest FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
        "SELECT phase,desired_enabled,pending_removal,package_digest FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &implementation.install_id.as_str()],
    ).await?.ok_or_else(unavailable)?;
    if row.get::<_, String>("phase") != "installed"
        || !row.get::<_, bool>("desired_enabled")
        || row.get::<_, bool>("pending_removal")
        || row.get::<_, Option<String>>("package_digest").as_deref()
            != Some(implementation.package_digest.as_str())
    {
        return Err(unavailable());
    }
    let trust = reader.query_opt(
        "SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
        "SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &implementation.package_digest.as_str()],
    ).await?;
    if trust
        .as_ref()
        .is_some_and(|row| row.get::<_, bool>("quarantined"))
    {
        return Err(CurrentFailure::Binding(BindingFailure::Quarantined {
            node_id: node.id.clone(),
        }));
    }
    if !trust
        .as_ref()
        .is_some_and(|row| row.get::<_, bool>("trusted"))
    {
        return Err(CurrentFailure::Binding(BindingFailure::TrustBoundary {
            node_id: node.id.clone(),
        }));
    }
    match &reader {
        CurrentRead::Snapshot(snapshot) => {
            crate::extensions::package::read_package_grants(snapshot, implementation).await?;
        }
        CurrentRead::Transaction(tx) => {
            crate::extensions::package::read_package_grants_in_transaction(tx, implementation)
                .await?;
        }
    }
    if let Some(state) = &node.state {
        let row = reader.query_opt(
            "SELECT n.writer_epoch,n.writer_domain,n.schema_digest,g.mode,g.writer_epoch AS current_writer_epoch FROM world_state_namespace n JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3",
            "SELECT n.writer_epoch,n.writer_domain,n.schema_digest,g.mode,g.writer_epoch AS current_writer_epoch FROM world_state_namespace n JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3 FOR SHARE OF n,g",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &state.namespace.as_str()],
        ).await?.ok_or_else(|| CurrentFailure::Binding(BindingFailure::StateConflict { node_id: node.id.clone() }))?;
        if row.get::<_, String>("writer_domain") != state.writer_domain.as_str()
            || row.get::<_, String>("schema_digest") != state.schema.as_str()
            || row.get::<_, String>("mode") != "active"
            || i64::try_from(state.writer_epoch.0).ok() != Some(row.get::<_, i64>("writer_epoch"))
            || i64::try_from(state.writer_epoch.0).ok()
                != Some(row.get::<_, i64>("current_writer_epoch"))
        {
            return Err(CurrentFailure::Binding(BindingFailure::StateConflict {
                node_id: node.id.clone(),
            }));
        }
    }
    Ok(())
}
