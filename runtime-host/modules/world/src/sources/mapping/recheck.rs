use super::{MappingError, schema_drift};
use crate::store::{StoreError, WorldSnapshot, WorldTransaction};
use tokio_postgres::{Row, types::ToSql};
use world_protocol::{
    commit::CommitFailure,
    definitions::{Definition, DefinitionBody},
    failure::FailureStage,
    ids::*,
    provenance::ReadDependency,
    sources::{AuthorityRef, MappingFailure, SchemaDiscovery, SourceBinding},
};

enum Reader<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>),
    Snapshot(&'a WorldSnapshot<'b>),
}
impl Reader<'_, '_> {
    fn world(&self) -> &WorldRef {
        match self {
            Self::Transaction(tx) => tx.world(),
            Self::Snapshot(snapshot) => snapshot.world(),
        }
    }
    async fn query_opt(
        &self,
        transaction: &'static str,
        snapshot: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, MappingError> {
        Ok(match self {
            Self::Transaction(tx) => tx.query_opt(transaction, parameters).await?,
            Self::Snapshot(reader) => reader.query_opt(snapshot, parameters).await?,
        })
    }
    async fn binding(
        &self,
        reference: &DefinitionRef,
    ) -> Result<Definition<SourceBinding>, MappingError> {
        match self {
            Self::Transaction(tx) => super::read_binding(tx, reference).await?,
            Self::Snapshot(snapshot) => super::read_binding_snapshot(snapshot, reference).await?,
        }
        .ok_or_else(|| MappingFailure::RevisionMismatch.into())
    }
    async fn expected_binding(
        &self,
        reference: &DefinitionRef,
    ) -> Result<Definition<SourceBinding>, MappingError> {
        let w = self.world();
        // Historical activation is evidence for comparison, never current execution authority.
        let sql = "SELECT d.release_id,a.content_digest FROM world_source_binding_revision a JOIN world_release_definition d ON d.tenant_id=a.tenant_id AND d.world_id=a.world_id AND d.definition_id=a.binding_id AND d.revision=a.revision AND d.content_digest=a.content_digest WHERE a.tenant_id=$1 AND a.world_id=$2 AND a.binding_id=$3 AND a.revision=$4 ORDER BY d.release_id LIMIT 1";
        let row = self
            .query_opt(
                sql,
                sql,
                &[
                    &w.tenant_id.as_str(),
                    &w.world_id.as_str(),
                    &reference.id.as_str(),
                    &super::persistence::revision(reference.revision)?,
                ],
            )
            .await?
            .ok_or(MappingFailure::RevisionMismatch)?;
        let id = ReleaseId::try_new(row.get::<_, String>("release_id"))
            .map_err(|_| MappingFailure::RevisionMismatch)?;
        let release = match self {
            Self::Transaction(tx) => crate::releases::read_release(tx, &id).await?,
            Self::Snapshot(snapshot) => {
                crate::releases::read_release_snapshot(snapshot, &id).await?
            }
        }
        .ok_or(MappingFailure::RevisionMismatch)?;
        let d = release
            .definitions
            .into_iter()
            .find(|d| {
                d.reference == *reference
                    && d.content_digest.as_str() == row.get::<_, String>("content_digest")
            })
            .ok_or(MappingFailure::RevisionMismatch)?;
        let DefinitionBody::SourceBinding(body) = d.body else {
            return Err(MappingFailure::RevisionMismatch.into());
        };
        Ok(Definition {
            reference: d.reference,
            scope: d.scope,
            valid_time: d.valid_time,
            body,
            content_digest: d.content_digest,
            dependencies: d.dependencies,
            evidence: d.evidence,
            previous_ref: d.previous_ref,
            lifecycle: d.lifecycle,
        })
    }
    async fn schema(&self, reference: &SchemaRef) -> Result<SchemaDiscovery, MappingError> {
        match self {
            Self::Transaction(tx) => super::read_schema(tx, reference).await?,
            Self::Snapshot(snapshot) => super::read_schema_snapshot(snapshot, reference).await?,
        }
        .ok_or_else(|| {
            MappingFailure::SchemaMissing {
                reference: reference.clone(),
            }
            .into()
        })
    }
    async fn authority(
        &self,
        binding: &DefinitionRef,
        authority: &AuthorityRef,
    ) -> Result<world_protocol::facts::SourceAuthority, MappingError> {
        match self {
            Self::Transaction(tx) => super::read_authority(tx, binding, authority).await?,
            Self::Snapshot(snapshot) => {
                super::read_authority_snapshot(snapshot, binding, authority).await?
            }
        }
        .ok_or_else(|| MappingFailure::AuthorityMismatch.into())
    }
}

pub(crate) async fn recheck_dependencies(
    tx: &WorldTransaction<'_>,
    dependencies: &[ReadDependency],
) -> Result<(), MappingError> {
    recheck(&Reader::Transaction(tx), dependencies).await
}
pub(crate) async fn recheck_dependencies_snapshot(
    snapshot: &WorldSnapshot<'_>,
    dependencies: &[ReadDependency],
) -> Result<(), MappingError> {
    recheck(&Reader::Snapshot(snapshot), dependencies).await
}

async fn recheck(
    reader: &Reader<'_, '_>,
    dependencies: &[ReadDependency],
) -> Result<(), MappingError> {
    let w = reader.world();
    let mut sources = std::collections::BTreeSet::new();
    for dependency in dependencies {
        if let ReadDependency::SourceField { schema, .. } = dependency {
            sources.insert(reader.schema(schema).await?.source_id);
        }
    }
    for source in sources {
        reader.query_opt(
            "SELECT revision FROM world_source_schema_head WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 FOR SHARE",
            "SELECT revision FROM world_source_schema_head WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3",
            &[&w.tenant_id.as_str(), &w.world_id.as_str(), &source.as_str()],
        ).await?.ok_or(MappingFailure::RevisionMismatch)?;
    }
    for dependency in dependencies {
        match dependency {
            ReadDependency::SourceMapping {
                mapping,
                identity_rule,
                authority,
                binding,
            } => {
                if &binding.world != w || &mapping.world != w || &identity_rule.world != w {
                    return Err(MappingFailure::CrossWorld.into());
                }
                let row = reader.query_opt(
                    "SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE",
                    "SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3",
                    &[&w.tenant_id.as_str(), &w.world_id.as_str(), &binding.id.as_str()],
                ).await?.ok_or(MappingFailure::RevisionMismatch)?;
                let revision = u64::try_from(row.get::<_, i64>("revision"))
                    .map_err(|_| MappingFailure::RevisionMismatch)?;
                let current_ref = DefinitionRef {
                    revision: Revision(revision),
                    ..binding.clone()
                };
                let current = reader.binding(&current_ref).await?;
                let expected = if current_ref == *binding {
                    current.clone()
                } else {
                    reader.expected_binding(binding).await?
                };
                // Credential rotation alone does not change identity, mapping or source authority.
                if current.body.mapping != *mapping
                    || current.body.identity_rule != *identity_rule
                    || current.body.authority != *authority
                    || current.body.source_id != expected.body.source_id
                    || current.body.incarnation != expected.body.incarnation
                    || current.body.namespace != expected.body.namespace
                    || current.body.scope != expected.body.scope
                    || current.body.identity_mapping != expected.body.identity_mapping
                {
                    return Err(MappingFailure::MappingChanged {
                        reference: mapping.clone(),
                    }
                    .into());
                }
                for dependency in dependencies {
                    if let ReadDependency::SourceField { schema, field, .. } = dependency {
                        if reader.schema(schema).await?.source_id != current.body.source_id {
                            continue;
                        }
                        let mode = |body: &SourceBinding| {
                            body.field_modes
                                .iter()
                                .find(|entry| &entry.field_id == field)
                                .map_or(body.mode, |entry| entry.mode)
                        };
                        if !current.body.selected_fields.contains(field)
                            || mode(&current.body) != mode(&expected.body)
                        {
                            return Err(MappingFailure::PermissionDenied {
                                field: Some(field.clone()),
                            }
                            .into());
                        }
                    }
                }
                let approved = reader.authority(binding, authority).await?;
                if approved.authority != *authority
                    || approved.binding != *binding
                    || approved.incarnation != current.body.incarnation
                    || approved.source_id != current.body.source_id
                    || approved.scope != current.body.scope
                {
                    return Err(MappingFailure::AuthorityMismatch.into());
                }
            }
            ReadDependency::SourceField {
                schema,
                field,
                value_type,
                nullable,
                optional,
                name,
            } => {
                if &schema.world != w {
                    return Err(MappingFailure::CrossWorld.into());
                }
                let row = reader.query_opt(
                    "SELECT expected.body AS expected_body, latest.body AS latest_body FROM world_source_schema_revision expected JOIN world_source_schema_head h USING(tenant_id,world_id,source_id) JOIN world_source_schema_revision latest ON latest.tenant_id=h.tenant_id AND latest.world_id=h.world_id AND latest.source_id=h.source_id AND latest.revision=h.revision WHERE expected.tenant_id=$1 AND expected.world_id=$2 AND expected.schema_id=$3 AND expected.revision=$4 FOR SHARE OF h",
                    "SELECT expected.body AS expected_body, latest.body AS latest_body FROM world_source_schema_revision expected JOIN world_source_schema_head h USING(tenant_id,world_id,source_id) JOIN world_source_schema_revision latest ON latest.tenant_id=h.tenant_id AND latest.world_id=h.world_id AND latest.source_id=h.source_id AND latest.revision=h.revision WHERE expected.tenant_id=$1 AND expected.world_id=$2 AND expected.schema_id=$3 AND expected.revision=$4",
                    &[&w.tenant_id.as_str(), &w.world_id.as_str(), &schema.id.as_str(), &super::persistence::revision(schema.revision)?],
                ).await?.ok_or_else(|| MappingFailure::SchemaMissing { reference:schema.clone() })?;
                let decode = |name| {
                    serde_json::from_value::<SchemaDiscovery>(row.get(name)).map_err(|cause| {
                        StoreError::caused_by(
                            CommitFailure::InternalFault,
                            FailureStage::Decode,
                            cause,
                        )
                    })
                };
                let expected = decode("expected_body")?;
                let actual = decode("latest_body")?;
                if expected.reference != *schema || expected.source_id != actual.source_id {
                    return Err(MappingFailure::RevisionMismatch.into());
                }
                let recorded = expected
                    .fields
                    .iter()
                    .find(|entry| &entry.id == field)
                    .ok_or_else(|| MappingFailure::SchemaMissing {
                        reference: schema.clone(),
                    })?;
                if &recorded.name != name
                    || &recorded.value_type != value_type
                    || &recorded.nullable != nullable
                    || &recorded.optional != optional
                {
                    return Err(MappingFailure::RevisionMismatch.into());
                }
                if let Some(failure) = schema_drift(&expected, &actual, std::slice::from_ref(field))
                    .into_iter()
                    .next()
                {
                    return Err(failure.into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}
