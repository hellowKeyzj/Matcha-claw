use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    commit::CommitFailure,
    definitions::{Definition, DefinitionBody},
    facts::{AuthorityOwnership, SourceAuthority},
    failure::FailureStage,
    ids::*,
    sources::{CompiledSourcePlan, MappingFailure, SchemaDiscovery, SchemaMapping, SourceBinding},
    time::Timestamp,
};

use super::error::MappingError;
use crate::{
    authorization::{self, Admission},
    store::{StoreError, WorldTransaction},
};

pub(crate) async fn read_schema(
    tx: &WorldTransaction<'_>,
    reference: &SchemaRef,
) -> Result<Option<SchemaDiscovery>, MappingError> {
    world(tx, &reference.world)?;
    let revision = revision(reference.revision)?;
    let row = tx.query_opt("SELECT schema_id,revision,source_id,schema_digest,body FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4", &[&reference.world.tenant_id.as_str(), &reference.world.world_id.as_str(), &reference.id.as_str(), &revision]).await?;
    row.map(|row| {
        let schema: SchemaDiscovery = decode(row.get("body"))?;
        if schema.reference != *reference
            || schema.reference.id.as_str() != row.get::<_, String>("schema_id")
            || self::revision(schema.reference.revision)? != row.get::<_, i64>("revision")
            || schema.source_id.as_str() != row.get::<_, String>("source_id")
            || crate::definitions::canonical_digest(&schema)?.as_str() != row.get::<_, String>("schema_digest")
        {
            return Err(MappingFailure::RevisionMismatch.into());
        }
        Ok(schema)
    }).transpose()
}

pub(crate) async fn read_mapping(
    tx: &WorldTransaction<'_>,
    reference: &MappingRef,
) -> Result<Option<SchemaMapping>, MappingError> {
    world(tx, &reference.world)?;
    let revision = revision(reference.revision)?;
    let row = tx.query_opt("SELECT mapping_id,revision,source_id,source_schema_revision,scope_id,content_digest,body FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND mapping_id=$3 AND revision=$4", &[&reference.world.tenant_id.as_str(), &reference.world.world_id.as_str(), &reference.id.as_str(), &revision]).await?;
    row.map(|row| checked_mapping(&row, reference)).transpose()
}

fn checked_mapping(row: &tokio_postgres::Row, reference: &MappingRef) -> Result<SchemaMapping, MappingError> {
    let mapping: SchemaMapping = decode(row.get("body"))?;
    if mapping.reference != *reference || mapping.schema.world != reference.world
        || mapping.reference.id.as_str() != row.get::<_, String>("mapping_id")
        || revision(mapping.reference.revision)? != row.get::<_, i64>("revision")
        || revision(mapping.schema.revision)? != row.get::<_, i64>("source_schema_revision")
        || crate::definitions::canonical_digest(&mapping)?.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    Ok(mapping)
}

pub(super) async fn read_authoring_mapping(
    tx: &WorldTransaction<'_>,
    binding: &Definition<SourceBinding>,
) -> Result<Option<SchemaMapping>, MappingError> {
    let reference = &binding.body.mapping;
    world(tx, &reference.world)?;
    let row = tx.query_opt("SELECT mapping_id,revision,source_id,source_schema_revision,scope_id,content_digest,body FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND mapping_id=$3 AND revision=$4", &[&reference.world.tenant_id.as_str(), &reference.world.world_id.as_str(), &reference.id.as_str(), &revision(reference.revision)?]).await?;
    row.map(|row| {
        let mapping = checked_mapping(&row, reference)?;
        if row.get::<_, String>("source_id") != binding.body.source_id.as_str()
            || row.get::<_, String>("scope_id") != binding.scope.as_str()
        {
            return Err(MappingFailure::RevisionMismatch.into());
        }
        Ok(mapping)
    }).transpose()
}

pub(crate) async fn read_binding(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<Option<Definition<SourceBinding>>, MappingError> {
    world(tx, &reference.world)?;
    let Some(definition) = super::published_definition(tx, reference).await? else {
        return Ok(None);
    };
    let DefinitionBody::SourceBinding(body) = definition.body else {
        return Err(MappingFailure::RevisionMismatch.into());
    };
    Ok(Some(Definition {
        reference: definition.reference,
        scope: definition.scope,
        valid_time: definition.valid_time,
        body,
        content_digest: definition.content_digest,
        dependencies: definition.dependencies,
        evidence: definition.evidence,
        previous_ref: definition.previous_ref,
        lifecycle: definition.lifecycle,
    }))
}

/// Historical retention reads exact immutable bodies, never current published authority.
pub(crate) async fn binding_retention_roots(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), MappingError> {
    world(tx, &reference.world)?;
    let definition = crate::releases::read_definition_exact(tx, reference)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let DefinitionBody::SourceBinding(binding) = &definition.body else {
        return Err(MappingFailure::RevisionMismatch.into());
    };
    let mapping = read_mapping(tx, &binding.mapping)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let schema = read_schema(tx, &binding.schema)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    if mapping.schema != binding.schema
        || schema.source_id != binding.source_id
        || mapping.identity_rule != binding.identity_rule
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    roots.definitions.push(reference.clone());
    roots.definitions.extend(definition.dependencies);
    roots.evidence.extend(definition.evidence);
    roots
        .scopes
        .extend([definition.scope, binding.scope.clone()]);
    roots.schemas.push(binding.schema.clone());
    roots.mappings.push(binding.mapping.clone());
    roots.definitions.push(mapping.type_ref);
    roots
        .definitions
        .extend(mapping.fields.into_iter().map(|field| field.property));
    roots.definitions.extend(
        mapping
            .relations
            .into_iter()
            .map(|relation| relation.relation_type),
    );
    Ok(())
}

pub(crate) async fn read_authority(
    tx: &WorldTransaction<'_>,
    binding: &DefinitionRef,
    authority: &world_protocol::sources::AuthorityRef,
) -> Result<Option<SourceAuthority>, MappingError> {
    world(tx, &binding.world)?;
    let revision = revision(authority.revision)?;
    let row = tx.query_opt("SELECT r.body FROM world_source_authority_revision r JOIN world_source_authority_head h USING(tenant_id,world_id,policy_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.policy_id=$3 AND r.revision=$4 AND r.binding_id=$5 AND r.binding_revision=$6 AND r.status='approved' FOR SHARE OF r,h", &[&binding.world.tenant_id.as_str(), &binding.world.world_id.as_str(), &authority.policy_id.as_str(), &revision, &binding.id.as_str(), &self::revision(binding.revision)?]).await?;
    row.map(|row| decode(row.get("body"))).transpose()
}

/// Discovery is persisted as discovery, never as field selection or source authority.
pub(crate) async fn save_schema(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    schema: &SchemaDiscovery,
    scope: &ScopeId,
    now: &Timestamp,
) -> Result<(), MappingError> {
    world(tx, &schema.reference.world)?;
    require_writer(tx)?;
    authorize(
        tx,
        admission,
        &schema.source_id,
        scope,
        None,
        Vec::new(),
        AccessMode::Manage,
        None,
        now,
    )
    .await?;
    lock_schema_source(tx, &schema.source_id).await?;
    let revision = revision(schema.reference.revision)?;
    let body = encode(schema)?;
    let digest =
        crate::definitions::canonical_digest(schema).map_err(|_| MappingFailure::InternalFault)?;
    tx.execute("INSERT INTO world_source_schema_revision(tenant_id,world_id,source_id,revision,schema_id,schema_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,world_id,schema_id,revision) DO NOTHING", &[&schema.reference.world.tenant_id.as_str(), &schema.reference.world.world_id.as_str(), &schema.source_id.as_str(), &revision, &schema.reference.id.as_str(), &digest.as_str(), &body]).await?;
    immutable(tx, "SELECT body FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4", schema.reference.id.as_str(), revision, &body).await?;
    tx.execute("INSERT INTO world_source_schema_head(tenant_id,world_id,source_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,world_id,source_id) DO UPDATE SET revision=GREATEST(world_source_schema_head.revision,excluded.revision)", &[&schema.reference.world.tenant_id.as_str(), &schema.reference.world.world_id.as_str(), &schema.source_id.as_str(), &revision]).await?;
    Ok(())
}

/// A native discovery witness may advance only the exact source-wide schema head it read.
pub(crate) async fn save_discovered_schema(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    discovered: &crate::sources::connectors::discovery::DiscoveredSchema,
    expected: Option<&SchemaRef>,
    now: &Timestamp,
) -> Result<(), MappingError> {
    let schema = discovered.schema();
    let connection = discovered.connection();
    world(tx, &connection.world)?;
    world(tx, &schema.reference.world)?;
    require_writer(tx)?;
    if schema.source_id != connection.source_id
        || expected.is_some_and(|reference| reference.world != connection.world)
    {
        return Err(MappingFailure::CrossWorld.into());
    }
    let resource_exists = match &connection.config {
        world_protocol::sources::SourceConnectionConfig::Postgres(config) => config
            .resources
            .iter()
            .any(|resource| resource.id == discovered.resource()),
        world_protocol::sources::SourceConnectionConfig::HttpJson(config) => config
            .resources
            .iter()
            .any(|resource| resource.id == discovered.resource()),
        world_protocol::sources::SourceConnectionConfig::Plugin(config) => config
            .resources
            .iter()
            .any(|resource| resource.id == discovered.resource()),
    };
    if !resource_exists {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    authorize(
        tx,
        admission,
        &connection.source_id,
        &connection.scope,
        None,
        Vec::new(),
        AccessMode::Manage,
        None,
        now,
    )
    .await?;
    let w = tx.world();
    let row = tx.query_opt("SELECT r.body,h.revision AS current_revision FROM world_source_connection_revision r JOIN world_source_connection_head h USING(tenant_id,world_id,connection_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.connection_id=$3 AND r.revision=$4 FOR SHARE OF r,h", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &connection.id.as_str(), &revision(connection.revision)?]).await?.ok_or(MappingFailure::RevisionMismatch)?;
    let actual: world_protocol::sources::ConnectionRevision = decode(row.get("body"))?;
    if actual != *connection
        || row.get::<_, i64>("current_revision") != revision(connection.revision)?
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    lock_schema_source(tx, &connection.source_id).await?;
    let row = tx.query_opt("SELECT r.schema_id,r.revision,r.schema_digest,r.body FROM world_source_schema_head h JOIN world_source_schema_revision r USING(tenant_id,world_id,source_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.source_id=$3 FOR UPDATE OF h", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &connection.source_id.as_str()]).await?;
    let current = match row {
        None => None,
        Some(row) => {
            let stored: SchemaDiscovery = decode(row.get("body"))?;
            if stored.reference.world != *w
                || stored.source_id != connection.source_id
                || stored.reference.id.as_str() != row.get::<_, String>("schema_id")
                || revision(stored.reference.revision)? != row.get::<_, i64>("revision")
                || crate::definitions::canonical_digest(&stored)?.as_str()
                    != row.get::<_, String>("schema_digest")
            {
                return Err(MappingFailure::RevisionMismatch.into());
            }
            Some(stored.reference)
        }
    };
    if current.as_ref() != expected
        || schema.reference.revision.0
            != current
                .as_ref()
                .map_or(0, |reference| reference.revision.0)
                .checked_add(1)
                .ok_or(MappingFailure::RevisionMismatch)?
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    save_schema(tx, admission, schema, &connection.scope, now).await
}

async fn lock_schema_source(
    tx: &WorldTransaction<'_>,
    source: &SourceId,
) -> Result<(), MappingError> {
    let key = encode(&("world.source.schema.head.v1", tx.world(), source))?.to_string();
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&key],
    )
    .await?;
    Ok(())
}

pub(crate) async fn save_mapping(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    mapping: &SchemaMapping,
    source_id: &SourceId,
    scope: &ScopeId,
    now: &Timestamp,
) -> Result<(), MappingError> {
    world(tx, &mapping.reference.world)?;
    require_writer(tx)?;
    authorize(
        tx,
        admission,
        source_id,
        scope,
        None,
        mapping
            .fields
            .iter()
            .map(|field| field.property.clone())
            .collect(),
        AccessMode::Manage,
        None,
        now,
    )
    .await?;
    persist_mapping(tx, mapping, source_id, scope).await
}

pub(super) async fn persist_mapping(
    tx: &WorldTransaction<'_>,
    mapping: &SchemaMapping,
    source_id: &SourceId,
    scope: &ScopeId,
) -> Result<(), MappingError> {
    world(tx, &mapping.reference.world)?;
    require_writer(tx)?;
    let schema =
        read_schema(tx, &mapping.schema)
            .await?
            .ok_or_else(|| MappingFailure::SchemaMissing {
                reference: mapping.schema.clone(),
            })?;
    if &schema.source_id != source_id
        || mapping.identity_rule.world != mapping.reference.world
        || mapping.type_ref.world != mapping.reference.world
    {
        return Err(MappingFailure::CrossWorld.into());
    }
    let revision = revision(mapping.reference.revision)?;
    let schema_revision = self::revision(mapping.schema.revision)?;
    let body = encode(mapping)?;
    let digest =
        crate::definitions::canonical_digest(mapping).map_err(|_| MappingFailure::InternalFault)?;
    tx.execute("INSERT INTO world_schema_mapping_revision(tenant_id,world_id,mapping_id,revision,source_id,source_schema_revision,content_digest,body,scope_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,world_id,mapping_id,revision) DO NOTHING", &[&mapping.reference.world.tenant_id.as_str(), &mapping.reference.world.world_id.as_str(), &mapping.reference.id.as_str(), &revision, &source_id.as_str(), &schema_revision, &digest.as_str(), &body, &scope.as_str()]).await?;
    immutable(tx, "SELECT body FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND mapping_id=$3 AND revision=$4", mapping.reference.id.as_str(), revision, &body).await?;
    let stored = tx.query_opt("SELECT source_id,scope_id FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND mapping_id=$3 AND revision=$4", &[&mapping.reference.world.tenant_id.as_str(), &mapping.reference.world.world_id.as_str(), &mapping.reference.id.as_str(), &revision]).await?.ok_or(MappingFailure::RevisionMismatch)?;
    if stored.get::<_, String>("source_id") != source_id.as_str()
        || stored.get::<_, String>("scope_id") != scope.as_str()
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    Ok(())
}

pub(crate) async fn compile_binding(
    tx: &WorldTransaction<'_>,
    binding: Definition<SourceBinding>,
) -> Result<CompiledSourcePlan, MappingError> {
    let schema = read_schema(tx, &binding.body.schema)
        .await?
        .ok_or_else(|| MappingFailure::SchemaMissing {
            reference: binding.body.schema.clone(),
        })?;
    let mapping = read_mapping(tx, &binding.body.mapping)
        .await?
        .ok_or_else(|| MappingFailure::MappingChanged {
            reference: binding.body.mapping.clone(),
        })?;
    let authority = read_authority(tx, &binding.reference, &binding.body.authority)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    let mut field_definitions = Vec::new();
    let mut relation_definitions = Vec::new();
    for field in &mapping.fields {
        if field_definitions
            .iter()
            .any(|d: &Definition<world_protocol::definitions::Property>| {
                d.reference == field.property
            })
        {
            continue;
        }
        let d = super::published_definition(tx, &field.property)
            .await?
            .ok_or(MappingFailure::RevisionMismatch)?;
        let DefinitionBody::Property(body) = d.body else {
            return Err(MappingFailure::RevisionMismatch.into());
        };
        field_definitions.push(Definition {
            reference: d.reference,
            scope: d.scope,
            valid_time: d.valid_time,
            body,
            content_digest: d.content_digest,
            dependencies: d.dependencies,
            evidence: d.evidence,
            previous_ref: d.previous_ref,
            lifecycle: d.lifecycle,
        });
    }
    for relation in &mapping.relations {
        if relation_definitions.iter().any(
            |d: &Definition<world_protocol::definitions::RelationType>| {
                d.reference == relation.relation_type
            },
        ) {
            continue;
        }
        let d = super::published_definition(tx, &relation.relation_type)
            .await?
            .ok_or(MappingFailure::RevisionMismatch)?;
        let DefinitionBody::RelationType(body) = d.body else {
            return Err(MappingFailure::RevisionMismatch.into());
        };
        relation_definitions.push(Definition {
            reference: d.reference,
            scope: d.scope,
            valid_time: d.valid_time,
            body,
            content_digest: d.content_digest,
            dependencies: d.dependencies,
            evidence: d.evidence,
            previous_ref: d.previous_ref,
            lifecycle: d.lifecycle,
        });
    }
    Ok(super::compile_plan(
        world_protocol::sources::CompileSourceRequest {
            binding,
            schema,
            mapping,
            authority,
            field_definitions,
            relation_definitions,
        },
    )?)
}

pub(crate) async fn set_mapping(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    request: &world_protocol::api::SetMapping,
    now: &Timestamp,
) -> Result<CompiledSourcePlan, MappingError> {
    let binding = read_binding(tx, &request.binding)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    if binding.body.mapping != request.mapping.reference {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    // Independent authority approval must already name this exact canonical binding.
    read_authority(tx, &binding.reference, &binding.body.authority)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    save_mapping(
        tx,
        admission,
        &request.mapping,
        &binding.body.source_id,
        &binding.scope,
        now,
    )
    .await?;
    let plan = compile_binding(tx, binding.clone()).await?;
    activate_binding(
        tx,
        admission,
        &binding,
        &plan,
        request.expected_revision,
        now,
    )
    .await?;
    Ok(plan)
}

pub(crate) async fn activate_binding(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    binding: &Definition<SourceBinding>,
    plan: &CompiledSourcePlan,
    expected: Revision,
    now: &Timestamp,
) -> Result<(), MappingError> {
    world(tx, &binding.reference.world)?;
    require_writer(tx)?;
    if plan.binding != binding.reference
        || plan.binding_body != binding.body
        || plan.mapping.reference != binding.body.mapping
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    authorize(
        tx,
        admission,
        &binding.body.source_id,
        &binding.body.scope,
        Some(&binding.reference),
        plan.mapping
            .fields
            .iter()
            .map(|field| field.property.clone())
            .collect(),
        AccessMode::Manage,
        None,
        now,
    )
    .await?;
    if binding.reference.revision.0 <= expected.0 {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let mapping = read_mapping(tx, &binding.body.mapping)
        .await?
        .ok_or_else(|| MappingFailure::MappingChanged {
            reference: binding.body.mapping.clone(),
        })?;
    if mapping != plan.mapping {
        return Err(MappingFailure::MappingChanged {
            reference: binding.body.mapping.clone(),
        }
        .into());
    }
    let schema = read_schema(tx, &binding.body.schema)
        .await?
        .ok_or_else(|| MappingFailure::SchemaMissing {
            reference: binding.body.schema.clone(),
        })?;
    if schema != plan.schema {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let compiled = super::compile_plan(world_protocol::sources::CompileSourceRequest {
        binding: binding.clone(),
        schema,
        mapping,
        authority: plan.authority.clone(),
        field_definitions: plan.field_definitions.clone(),
        relation_definitions: plan.relation_definitions.clone(),
    })?;
    if compiled != *plan {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let canonical = Definition {
        reference: binding.reference.clone(),
        scope: binding.scope.clone(),
        valid_time: binding.valid_time.clone(),
        body: DefinitionBody::SourceBinding(binding.body.clone()),
        content_digest: binding.content_digest.clone(),
        dependencies: binding.dependencies.clone(),
        evidence: binding.evidence.clone(),
        previous_ref: binding.previous_ref.clone(),
        lifecycle: binding.lifecycle.clone(),
    };
    if super::published_definition(tx, &binding.reference)
        .await?
        .as_ref()
        != Some(&canonical)
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let approved = read_authority(tx, &binding.reference, &binding.body.authority)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    if approved != plan.authority {
        return Err(MappingFailure::AuthorityMismatch.into());
    }
    let release = crate::releases::read_active_model(tx)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let references = std::iter::once(&binding.reference)
        .chain(std::iter::once(&plan.mapping.type_ref))
        .chain(plan.field_definitions.iter().map(|d| &d.reference))
        .chain(plan.relation_definitions.iter().map(|d| &d.reference));
    for reference in references {
        let d = release
            .definitions
            .iter()
            .find(|d| d.reference == *reference)
            .ok_or(MappingFailure::RevisionMismatch)?;
        if !crate::definitions::valid_time_contains(&d.valid_time, &plan.authority.valid_time) {
            return Err(MappingFailure::RevisionMismatch.into());
        }
    }
    for definition in &plan.field_definitions {
        if release
            .definitions
            .iter()
            .find(|d| d.reference == definition.reference)
            .is_none_or(
                |d| !matches!(&d.body, DefinitionBody::Property(body) if body == &definition.body),
            )
        {
            return Err(MappingFailure::RevisionMismatch.into());
        }
    }
    for definition in &plan.relation_definitions {
        if release.definitions.iter().find(|d| d.reference == definition.reference).is_none_or(|d| {
            !matches!(&d.body, DefinitionBody::RelationType(body) if body == &definition.body)
        }) { return Err(MappingFailure::RevisionMismatch.into()); }
    }
    persist_binding(tx, binding, expected).await
}

pub(super) async fn persist_binding(
    tx: &WorldTransaction<'_>,
    binding: &Definition<SourceBinding>,
    expected: Revision,
) -> Result<(), MappingError> {
    require_writer(tx)?;
    let revision = revision(binding.reference.revision)?;
    // The source table is an activation projection; definitions owns the canonical body.
    let body = encode(&binding.reference)?;
    let world = &binding.reference.world;
    tx.execute("INSERT INTO world_source_binding_revision(tenant_id,world_id,binding_id,revision,source_id,source_incarnation,connection_id,connection_revision,mapping_id,mapping_revision,authority_policy_id,authority_revision,scope_id,content_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(tenant_id,world_id,binding_id,revision) DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.reference.id.as_str(), &revision, &binding.body.source_id.as_str(), &binding.body.incarnation, &binding.body.connection_id.as_str(), &self::revision(binding.body.connection_revision)?, &binding.body.mapping.id.as_str(), &self::revision(binding.body.mapping.revision)?, &binding.body.authority.policy_id.as_str(), &self::revision(binding.body.authority.revision)?, &binding.body.scope.as_str(), &binding.content_digest.as_str(), &body]).await?;
    immutable(tx, "SELECT body FROM world_source_binding_revision WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND revision=$4", binding.reference.id.as_str(), revision, &body).await?;
    let changed = if expected.0 == 0 {
        tx.execute("INSERT INTO world_source_binding_head(tenant_id,world_id,binding_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.reference.id.as_str(), &revision]).await?
    } else {
        tx.execute("UPDATE world_source_binding_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND revision=$5", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.reference.id.as_str(), &revision, &self::revision(expected)?]).await?
    };
    tx.require_changed(
        changed,
        ResourceRef::Definition {
            id: binding.reference.id.clone(),
        },
    )?;
    Ok(())
}

pub(crate) async fn approve_authority(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    authority: &SourceAuthority,
    expected: Revision,
    now: &Timestamp,
) -> Result<(), MappingError> {
    world(tx, &authority.world)?;
    require_writer(tx)?;
    let fields = match &authority.ownership {
        AuthorityOwnership::Properties { properties } => properties.clone(),
        AuthorityOwnership::RelationRoles { relation_type, .. } => vec![relation_type.clone()],
    };
    authorize(
        tx,
        admission,
        &authority.source_id,
        &authority.scope,
        Some(&authority.binding),
        fields,
        AccessMode::Approve,
        Some(&authority.valid_time),
        now,
    )
    .await?;
    if authority.authority.revision.0
        != expected
            .0
            .checked_add(1)
            .ok_or(MappingFailure::RevisionMismatch)?
    {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    let binding = read_binding(tx, &authority.binding)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    if binding.body.source_id != authority.source_id
        || binding.body.incarnation != authority.incarnation
        || binding.body.scope != authority.scope
        || binding.body.authority != authority.authority
        || !crate::definitions::valid_time_contains(&binding.valid_time, &authority.valid_time)
        || !valid_ownership(authority)
    {
        return Err(MappingFailure::AuthorityMismatch.into());
    }
    persist_authority(tx, authority, expected).await
}

pub(super) async fn persist_authority(
    tx: &WorldTransaction<'_>,
    authority: &SourceAuthority,
    expected: Revision,
) -> Result<(), MappingError> {
    require_writer(tx)?;
    let world = &authority.world;
    let revision = revision(authority.authority.revision)?;
    let from = chrono::DateTime::parse_from_rfc3339(authority.valid_time.from.as_str())
        .map_err(|_| MappingFailure::AuthorityMismatch)?
        .with_timezone(&chrono::Utc);
    let to = authority
        .valid_time
        .to
        .as_ref()
        .map(|at| {
            chrono::DateTime::parse_from_rfc3339(at.as_str())
                .map(|at| at.with_timezone(&chrono::Utc))
        })
        .transpose()
        .map_err(|_| MappingFailure::AuthorityMismatch)?;
    let body = encode(authority)?;
    tx.execute("INSERT INTO world_source_authority_revision(tenant_id,world_id,policy_id,revision,source_id,binding_id,binding_revision,scope_id,valid_from,valid_to,status,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11,$12::text::numeric,$13::text::numeric) ON CONFLICT DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &authority.authority.policy_id.as_str(), &revision, &authority.source_id.as_str(), &authority.binding.id.as_str(), &self::revision(authority.binding.revision)?, &authority.scope.as_str(), &from, &to, &body, &authority.valid_time.from.unix_nanos().to_string(), &authority.valid_time.to.as_ref().map(|at| at.unix_nanos().to_string())]).await?;
    immutable(tx, "SELECT body FROM world_source_authority_revision WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 AND revision=$4", authority.authority.policy_id.as_str(), revision, &body).await?;
    match &authority.ownership {
        AuthorityOwnership::Properties { properties } => {
            for property in properties {
                if property.world != *world || !authority.authority.fields.contains(&property.id) {
                    return Err(MappingFailure::AuthorityMismatch.into());
                }
                tx.execute("INSERT INTO world_source_authority_field(tenant_id,world_id,policy_id,revision,property_id,property_revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &authority.authority.policy_id.as_str(), &revision, &property.id.as_str(), &self::revision(property.revision)?]).await?;
            }
        }
        AuthorityOwnership::RelationRoles {
            relation_type,
            roles,
        } => {
            for role in roles {
                if relation_type.world != *world || !authority.authority.roles.contains(role) {
                    return Err(MappingFailure::AuthorityMismatch.into());
                }
                tx.execute("INSERT INTO world_source_authority_role(tenant_id,world_id,policy_id,revision,relation_type_id,relation_type_revision,role_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &authority.authority.policy_id.as_str(), &revision, &relation_type.id.as_str(), &self::revision(relation_type.revision)?, &role.as_str()]).await?;
            }
        }
    }
    let changed = if expected.0 == 0 {
        tx.execute("INSERT INTO world_source_authority_head(tenant_id,world_id,policy_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &authority.authority.policy_id.as_str(), &revision]).await?
    } else {
        tx.execute("UPDATE world_source_authority_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND policy_id=$3 AND revision=$5", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &authority.authority.policy_id.as_str(), &revision, &self::revision(expected)?]).await?
    };
    tx.require_changed(
        changed,
        ResourceRef::Source {
            id: authority.source_id.clone(),
        },
    )?;
    Ok(())
}

pub(super) fn valid_ownership(authority: &SourceAuthority) -> bool {
    use std::collections::BTreeSet;
    match &authority.ownership {
        AuthorityOwnership::Properties { properties } => {
            let actual: BTreeSet<_> = properties.iter().map(|property| &property.id).collect();
            !properties.is_empty()
                && actual.len() == properties.len()
                && authority.authority.roles.is_empty()
                && authority.authority.fields.len() == actual.len()
                && authority
                    .authority
                    .fields
                    .iter()
                    .all(|field| actual.contains(field))
                && properties
                    .iter()
                    .all(|property| property.world == authority.world && property.revision.0 > 0)
        }
        AuthorityOwnership::RelationRoles {
            relation_type,
            roles,
        } => {
            let actual: BTreeSet<_> = roles.iter().collect();
            !roles.is_empty()
                && actual.len() == roles.len()
                && authority.authority.fields.is_empty()
                && authority.authority.roles.len() == actual.len()
                && authority
                    .authority
                    .roles
                    .iter()
                    .all(|role| actual.contains(role))
                && relation_type.world == authority.world
                && relation_type.revision.0 > 0
        }
    }
}

async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    source: &SourceId,
    scope: &ScopeId,
    binding: Option<&DefinitionRef>,
    fields: Vec<DefinitionRef>,
    mode: AccessMode,
    valid_time: Option<&world_protocol::time::ValidTime>,
    now: &Timestamp,
) -> Result<(), MappingError> {
    let mut resources = vec![ResourceRef::Source { id: source.clone() }];
    if let Some(binding) = binding {
        resources.push(ResourceRef::Definition {
            id: binding.id.clone(),
        });
    }
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources,
            fields,
            modes: vec![mode],
            scope: scope.clone(),
            valid_time: valid_time.cloned(),
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![source.clone()],
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, now).await?;
    Ok(())
}

async fn immutable(
    tx: &WorldTransaction<'_>,
    statement: &'static str,
    id: &str,
    revision: i64,
    body: &serde_json::Value,
) -> Result<(), MappingError> {
    let world = tx.world();
    let row = tx
        .query_opt(
            statement,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &id,
                &revision,
            ],
        )
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    if row.get::<_, serde_json::Value>("body") != *body {
        return Err(MappingFailure::RevisionMismatch.into());
    }
    Ok(())
}

fn require_writer(tx: &WorldTransaction<'_>) -> Result<(), MappingError> {
    tx.require_domain(
        &WriterDomain::try_new("sources").map_err(|_| MappingFailure::InternalFault)?,
    )?;
    Ok(())
}

pub(super) fn revision(revision: Revision) -> Result<i64, MappingError> {
    i64::try_from(revision.0)
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or_else(|| MappingFailure::RevisionMismatch.into())
}
fn world(tx: &WorldTransaction<'_>, world: &WorldRef) -> Result<(), MappingError> {
    if tx.world() == world {
        Ok(())
    } else {
        Err(MappingFailure::CrossWorld.into())
    }
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, MappingError> {
    serde_json::to_value(value).map_err(|cause| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, cause).into()
    })
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, MappingError> {
    serde_json::from_value(value).map_err(|cause| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, cause).into()
    })
}
