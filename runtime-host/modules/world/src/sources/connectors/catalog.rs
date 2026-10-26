use super::{SourceError, configure};
use crate::{
    authorization::{self, Admission, AuthError, VerifiedInvocation},
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    api::{ConnectionQuery, ConnectionView, ListQuery, MAX_PAGE_ITEMS},
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure},
    budget::BudgetDimension,
    failure::FailureStage,
    ids::*,
    query::Page,
    sources::{
        ConnectionRevision, SourceCapabilities, SourceConnectionConfig, SourceFailure,
        SourcePlanReason,
    },
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    world: WorldRef,
    connection: ConnectionId,
}

pub(crate) async fn connections_impact(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    request: &ListQuery,
) -> Result<ActualImpact, SourceError> {
    Ok(page(tx, verified, request).await?.1)
}

pub(crate) async fn connections(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &ListQuery,
) -> Result<Page<ConnectionView>, SourceError> {
    let (page, impact) = page(tx, admission.verified(), request).await?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(
        tx,
        admission,
        &impact,
        page.items.len() as u64,
        &tx.now().await?,
    )
    .await?;
    Ok(page)
}

pub(crate) async fn capabilities_impact(
    tx: &WorldTransaction<'_>,
    request: &ConnectionQuery,
) -> Result<ActualImpact, SourceError> {
    let connection = configure::current(tx, &request.id)
        .await?
        .ok_or_else(|| missing(&request.id))?;
    connection_impact(&connection)
}

pub(crate) async fn capabilities(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &ConnectionQuery,
) -> Result<SourceCapabilities, SourceError> {
    let connection = configure::current(tx, &request.id)
        .await?
        .ok_or_else(|| missing(&request.id))?;
    let impact = connection_impact(&connection)?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, 1, &tx.now().await?).await?;
    Ok(declared(&connection).clone())
}

async fn page(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    request: &ListQuery,
) -> Result<(Page<ConnectionView>, ActualImpact), SourceError> {
    if request.page.limit == 0 || request.page.limit > MAX_PAGE_ITEMS {
        return Err(invalid("page.limit"));
    }
    let after = match &request.page.cursor {
        None => String::new(),
        Some(cursor) => {
            if cursor.len() > 4096 {
                return Err(invalid("page.cursor"));
            }
            let cursor: Cursor =
                serde_json::from_str(cursor).map_err(|_| invalid("page.cursor"))?;
            if &cursor.world != tx.world() {
                return Err(invalid("page.cursor"));
            }
            cursor.connection.to_string()
        }
    };
    let now = tx.now().await?;
    let directory = authorization::source_directory_impact(tx, verified, &now).await?;
    // A bounded scan never exposes denied identifiers in a continuation cursor.
    let rows = tx.query("SELECT connection_id FROM world_source_connection_head WHERE tenant_id=$1 AND world_id=$2 AND connection_id>$3 ORDER BY connection_id LIMIT 4097",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
    let scan_truncated = rows.len() > 4096;
    let mut visible = Vec::new();
    let mut access = Vec::new();
    let mut sources = Vec::new();
    for row in rows.iter().take(4096) {
        let id = ConnectionId::try_new(row.get::<_, String>("connection_id")).map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Read, cause)
        })?;
        let connection = configure::current(tx, &id)
            .await?
            .ok_or_else(|| missing(&id))?;
        let Some(item) = directory_item(&directory, &connection)? else {
            continue;
        };
        match authorization::check_impact_read(tx, verified, &item, &now).await {
            Ok(()) => {}
            Err(AuthError::Denied(AuthorizationFailure::InsufficientScope)) => continue,
            Err(error) => return Err(error.into()),
        }
        if visible.len() == request.page.limit as usize {
            break;
        }
        access.extend(item.access);
        sources.push(connection.source_id.clone());
        visible.push(ConnectionView {
            id,
            revision: connection.revision,
            source_id: connection.source_id.clone(),
            name: connection.name.clone(),
            connector: connection.connector.clone(),
            configured: true,
            capabilities: Some(declared(&connection).clone()),
        });
    }
    let full = visible.len() == request.page.limit as usize;
    if scan_truncated && !full {
        return Err(SourceError::new(
            SourceFailure::BudgetExceeded {
                dimension: BudgetDimension::Steps,
            },
            FailureStage::Read,
        ));
    }
    let next_cursor = if full {
        let last = visible.last().expect("nonzero page limit");
        Some(
            serde_json::to_string(&Cursor {
                world: tx.world().clone(),
                connection: last.id.clone(),
            })
            .map_err(|cause| {
                SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Read, cause)
            })?,
        )
    } else {
        None
    };
    let impact = if access.is_empty() {
        directory
    } else {
        authorization::actual_impact(access, Vec::new(), Vec::new(), Vec::new(), sources)?
    };
    Ok((
        Page {
            items: visible,
            next_cursor,
        },
        impact,
    ))
}

fn directory_item(
    directory: &ActualImpact,
    connection: &ConnectionRevision,
) -> Result<Option<ActualImpact>, SourceError> {
    let resource = ResourceRef::Source {
        id: connection.source_id.clone(),
    };
    let access: Vec<_> = directory
        .access
        .iter()
        .filter(|allowed| {
            allowed.scope == connection.scope
                && allowed.modes.contains(&AccessMode::Read)
                && (allowed.resources.is_empty() || allowed.resources.contains(&resource))
        })
        .map(|allowed| AccessScope {
            resources: vec![resource.clone()],
            fields: allowed.fields.clone(),
            modes: vec![AccessMode::Read],
            scope: connection.scope.clone(),
            valid_time: allowed.valid_time.clone(),
        })
        .collect();
    if access.is_empty() {
        return Ok(None);
    }
    Ok(Some(authorization::actual_impact(
        access,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![connection.source_id.clone()],
    )?))
}
fn connection_impact(connection: &ConnectionRevision) -> Result<ActualImpact, SourceError> {
    Ok(authorization::actual_impact(
        vec![configure::source_access(connection, AccessMode::Read)],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![connection.source_id.clone()],
    )?)
}
fn declared(connection: &ConnectionRevision) -> &SourceCapabilities {
    match &connection.config {
        SourceConnectionConfig::Postgres(config) => &config.declared_capabilities,
        SourceConnectionConfig::HttpJson(config) => &config.declared_capabilities,
        SourceConnectionConfig::Plugin(config) => &config.declared_capabilities,
    }
}
fn invalid(field: &str) -> SourceError {
    SourceError::invalid(field, SourcePlanReason::InvalidValue)
}
fn missing(id: &ConnectionId) -> SourceError {
    SourceError::new(
        SourceFailure::ConnectionMissing {
            connection_id: id.clone(),
        },
        FailureStage::Read,
    )
}
