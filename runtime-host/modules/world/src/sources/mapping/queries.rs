use super::{MappingError, read_binding};
use crate::{
    authorization::{self, Admission, AuthError, VerifiedInvocation},
    sources::sync::SyncError,
    store::WorldTransaction,
};
use world_protocol::{
    api::{ListQuery, SetMapping},
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure},
    definitions::{Definition, DefinitionBody},
    ids::*,
    query::Page,
    sources::{MappingFailure, SchemaMapping, SourceBinding},
    time::Timestamp,
};

pub(crate) async fn binding_impact(
    tx: &WorldTransaction<'_>,
    binding: &Definition<SourceBinding>,
    modes: Vec<AccessMode>,
) -> Result<ActualImpact, SyncError> {
    let release = crate::releases::read_active_model(tx)
        .await
        .map_err(MappingError::from)?
        .ok_or_else(SyncError::protocol)?;
    let mut labels = Vec::new();
    let fields = binding
        .body
        .field_mapping
        .iter()
        .map(|f| f.property.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    for reference in &fields {
        let d = release
            .definitions
            .iter()
            .find(|d| d.reference == *reference)
            .ok_or_else(SyncError::protocol)?;
        if let DefinitionBody::Property(property) = &d.body {
            labels.extend(property.access_labels.iter().cloned());
        }
    }
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources: vec![
                ResourceRef::Source {
                    id: binding.body.source_id.clone(),
                },
                ResourceRef::Definition {
                    id: binding.reference.id.clone(),
                },
            ],
            fields,
            modes,
            scope: binding.scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        labels,
        Vec::new(),
        vec![binding.body.source_id.clone()],
    )?)
}

pub(crate) async fn set_mapping_impact(
    tx: &WorldTransaction<'_>,
    request: &SetMapping,
    _now: &Timestamp,
) -> Result<ActualImpact, SyncError> {
    let binding = read_binding(tx, &request.binding)
        .await?
        .ok_or_else(SyncError::protocol)?;
    if binding.body.mapping != request.mapping.reference {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    binding_impact(tx, &binding, vec![AccessMode::Manage]).await
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    world: WorldRef,
    mapping: MappingId,
    revision: Revision,
}

async fn page(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &ListQuery,
    now: &Timestamp,
) -> Result<(Page<SchemaMapping>, ActualImpact), SyncError> {
    if query.page.limit == 0 || query.page.limit > world_protocol::api::MAX_PAGE_ITEMS {
        return Err(SyncError::protocol());
    }
    let (id, revision) = match &query.page.cursor {
        None => (String::new(), 0),
        Some(cursor) => {
            if cursor.len() > 4096 {
                return Err(SyncError::protocol());
            }
            let cursor: Cursor = serde_json::from_str(cursor).map_err(|cause| {
                SyncError::codec(world_protocol::failure::FailureStage::Decode, cause)
            })?;
            if &cursor.world != tx.world() {
                return Err(SyncError::protocol());
            }
            (
                cursor.mapping.to_string(),
                super::persistence::revision(cursor.revision)?,
            )
        }
    };
    let directory = authorization::source_directory_impact(tx, verified, now).await?;
    let w = tx.world();
    let rows = tx.query("SELECT mapping_id,revision,source_id,scope_id,content_digest,body FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND (mapping_id,revision)>($3,$4) ORDER BY mapping_id,revision LIMIT 4097", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &id, &revision]).await?;
    let truncated = rows.len() > 4096;
    let mut items = Vec::new();
    let mut access = Vec::new();
    let mut sources = Vec::new();
    for row in rows.iter().take(4096) {
        let scope = ScopeId::try_new(row.get::<_, String>("scope_id"))
            .map_err(|_| SyncError::protocol())?;
        let source = SourceId::try_new(row.get::<_, String>("source_id"))
            .map_err(|_| SyncError::protocol())?;
        let resource = ResourceRef::Source { id: source.clone() };
        if !directory.access.iter().any(|allowed| {
            allowed.scope == scope
                && allowed.modes.contains(&AccessMode::Read)
                && (allowed.resources.is_empty() || allowed.resources.contains(&resource))
        }) {
            continue;
        }
        let mapping: SchemaMapping = serde_json::from_value(row.get("body")).map_err(|cause| {
            SyncError::codec(world_protocol::failure::FailureStage::Decode, cause)
        })?;
        if mapping.reference.world != *w
            || mapping.reference.id.as_str() != row.get::<_, String>("mapping_id")
            || super::persistence::revision(mapping.reference.revision)?
                != row.get::<_, i64>("revision")
            || crate::definitions::canonical_digest(&mapping)
                .map_err(MappingError::from)?
                .as_str()
                != row.get::<_, String>("content_digest")
        {
            return Err(SyncError::protocol());
        }
        let fields = mapping
            .fields
            .iter()
            .map(|f| f.property.clone())
            .chain(mapping.relations.iter().map(|r| r.relation_type.clone()))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let impact = authorization::actual_impact(
            vec![AccessScope {
                resources: vec![resource],
                fields,
                modes: vec![AccessMode::Read],
                scope,
                valid_time: None,
            }],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![source.clone()],
        )?;
        match authorization::check_impact_read(tx, verified, &impact, now).await {
            Ok(()) => {}
            Err(AuthError::Denied(AuthorizationFailure::InsufficientScope)) => continue,
            Err(error) => return Err(error.into()),
        }
        access.extend(impact.access);
        sources.push(source);
        items.push(mapping);
        if items.len() == query.page.limit as usize {
            break;
        }
    }
    let full = items.len() == query.page.limit as usize;
    if truncated && !full {
        return Err(MappingFailure::BudgetExceeded {
            dimension: world_protocol::budget::BudgetDimension::Steps,
        }
        .into());
    }
    let next_cursor = if full {
        let last = items.last().expect("nonzero page limit");
        Some(
            serde_json::to_string(&Cursor {
                world: w.clone(),
                mapping: last.reference.id.clone(),
                revision: last.reference.revision,
            })
            .map_err(|cause| {
                SyncError::codec(world_protocol::failure::FailureStage::Read, cause)
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
    Ok((Page { items, next_cursor }, impact))
}

pub(crate) async fn mappings_impact(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &ListQuery,
    now: &Timestamp,
) -> Result<ActualImpact, SyncError> {
    Ok(page(tx, verified, query, now).await?.1)
}

pub(crate) async fn mappings(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    query: &ListQuery,
    now: &Timestamp,
) -> Result<Page<SchemaMapping>, SyncError> {
    let (page, impact) = page(tx, admission.verified(), query, now).await?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, page.items.len() as u64, now)
        .await?;
    Ok(page)
}
