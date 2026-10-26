use std::collections::BTreeSet;

use world_protocol::{
    actions::{IdempotencyPolicy, SourceOperation},
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::{Definition, DefinitionBody},
    expression::Effect,
    failure::FailureStage,
    ids::*,
    sources::{
        ConnectionRevision, SchemaDiscovery, SourceBinding, SourceCapability,
        SourceConnectionConfig, SourceFailure, SourcePlanReason, SourceResourceField,
    },
};

use super::super::{
    PreparedSource,
    metadata::{current_definition, definition},
    prepared::Driver,
};
use super::{MutationValues, SourceError};
use crate::{
    authorization::{self, Admission},
    store::WorldSnapshot,
};

#[derive(Clone, PartialEq)]
pub(super) struct EffectMetadata {
    pub binding: Definition<SourceBinding>,
    pub connection: ConnectionRevision,
    pub schema: SchemaDiscovery,
    pub fields: Vec<SourceResourceField>,
    pub keys: Vec<SourceFieldId>,
    pub impact: ActualImpact,
}

pub(super) async fn read(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    operation: &SourceOperation,
    values: &MutationValues,
    policy: IdempotencyPolicy,
    prepared: &PreparedSource,
    inspect: bool,
) -> Result<EffectMetadata, SourceError> {
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    let canonical = definition(snapshot, &operation.binding, &now).await?;
    let DefinitionBody::SourceBinding(body) = canonical.body else {
        return Err(protocol());
    };
    if body.resource != operation.resource || body.scope != canonical.scope {
        return Err(protocol());
    }
    let mode = if inspect {
        AccessMode::Read
    } else if values.delete {
        AccessMode::Delete
    } else {
        AccessMode::Write
    };
    admission.require_access(&authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Source {
                id: body.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![mode],
            scope: canonical.scope.clone(),
            valid_time: None,
        }],
        vec![if inspect {
            Effect::SourceRead
        } else {
            Effect::ExternalWrite
        }],
        Vec::new(),
        Vec::new(),
        vec![body.source_id.clone()],
    )?)?;
    let required = if inspect {
        world_protocol::sources::inspect_contract()
    } else {
        world_protocol::sources::write_contract()
    }
    .map_err(|cause| {
        SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
    })?;
    if !prepared.implementation().contracts.contains(&required) {
        return Err(protocol());
    }
    let binding = Definition {
        reference: canonical.reference,
        scope: canonical.scope,
        valid_time: canonical.valid_time,
        body,
        content_digest: canonical.content_digest,
        dependencies: canonical.dependencies,
        evidence: canonical.evidence,
        previous_ref: canonical.previous_ref,
        lifecycle: canonical.lifecycle,
    };
    let world = snapshot.world();
    let active = snapshot.query_opt("SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.reference.id.as_str()]).await?.ok_or_else(protocol)?;
    if active.get::<_, i64>("revision") != number(binding.reference.revision)? {
        return Err(protocol());
    }
    let row = snapshot.query_opt("SELECT r.body,h.revision AS current_revision FROM world_source_connection_revision r JOIN world_source_connection_head h USING(tenant_id,world_id,connection_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.connection_id=$3 AND r.revision=$4", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.body.connection_id.as_str(), &number(binding.body.connection_revision)?]).await?.ok_or_else(|| SourceError::new(SourceFailure::ConnectionMissing { connection_id: binding.body.connection_id.clone() }, FailureStage::Prepare))?;
    let connection: ConnectionRevision = decode(row.get("body"))?;
    if row.get::<_, i64>("current_revision") != number(binding.body.connection_revision)?
        || connection.world != *world
        || connection.id != binding.body.connection_id
        || connection.revision != binding.body.connection_revision
        || connection.source_id != binding.body.source_id
        || connection.connector != binding.body.connector
        || connection.connector != prepared.provider
    {
        return Err(protocol());
    }
    let (fields, keys, capabilities) = match (&connection.config, prepared.driver) {
        (SourceConnectionConfig::Postgres(config), Driver::Postgres) => {
            let resource = config
                .resources
                .iter()
                .find(|resource| resource.id == operation.resource)
                .ok_or_else(|| {
                    SourceError::invalid("resource", SourcePlanReason::UnknownResource)
                })?;
            super::super::postgres::validate_resource(resource)?;
            (
                resource.fields.clone(),
                resource.key.clone(),
                &config.declared_capabilities,
            )
        }
        (SourceConnectionConfig::HttpJson(_), Driver::HttpJson) => {
            return Err(missing(SourceCapability::ConditionalWrite));
        }
        _ => return Err(protocol()),
    };
    if !inspect {
        if matches!(policy, IdempotencyPolicy::SourceKey) {
            // PostgreSQL constraints do not provide a source-owned operation-id ledger.
            return Err(missing(SourceCapability::Idempotency));
        }
        if matches!(policy, IdempotencyPolicy::ConditionalWrite)
            && (!capabilities.conditional_write
                || !binding.body.capabilities.conditional_write
                || values.expected.is_empty())
        {
            return Err(missing(SourceCapability::ConditionalWrite));
        }
    } else if !capabilities.inspect_effect || !binding.body.capabilities.inspect_effect {
        return Err(missing(SourceCapability::InspectEffect));
    }
    if !values.expected.is_empty()
        && (!capabilities.conditional_write || !binding.body.capabilities.conditional_write)
    {
        return Err(missing(SourceCapability::ConditionalWrite));
    }
    let schema_ref = &binding.body.schema;
    let row = snapshot.query_opt("SELECT r.body,h.revision AS current_revision FROM world_source_schema_revision r JOIN world_source_schema_head h USING(tenant_id,world_id,source_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.schema_id=$3 AND r.revision=$4", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &schema_ref.id.as_str(), &number(schema_ref.revision)?]).await?.ok_or_else(protocol)?;
    let schema: SchemaDiscovery = decode(row.get("body"))?;
    if schema.reference != *schema_ref
        || schema.reference.world != *world
        || schema.source_id != binding.body.source_id
        || schema.incarnation != binding.body.incarnation
        || schema.namespace != binding.body.namespace
        || row.get::<_, i64>("current_revision") != number(schema_ref.revision)?
    {
        return Err(protocol());
    }
    let declared_key: BTreeSet<_> = keys.iter().collect();
    let actual_key: BTreeSet<_> = values.keys.iter().map(|(field, _)| field).collect();
    if !values.insert && (declared_key.is_empty() || actual_key != declared_key) {
        return Err(SourceError::invalid("keys", SourcePlanReason::InvalidKey));
    }
    if values.insert
        && !keys.iter().all(|key| {
            values.values.iter().any(|(field, value)| {
                field == key && !matches!(value, world_protocol::value::Value::Null)
            })
        })
    {
        return Err(SourceError::invalid("keys", SourcePlanReason::InvalidKey));
    }
    let mut labels = Vec::new();
    let mut access = Vec::new();
    let read_fields: BTreeSet<_> = values
        .keys
        .iter()
        .chain(&values.expected)
        .map(|(field, _)| field)
        .collect();
    for (id, value) in values
        .keys
        .iter()
        .chain(&values.values)
        .chain(&values.expected)
    {
        let configured = fields
            .iter()
            .find(|field| &field.id == id)
            .ok_or_else(|| SourceError::invalid("fields", SourcePlanReason::UnknownField))?;
        let discovered = schema
            .fields
            .iter()
            .find(|field| &field.id == id)
            .ok_or_else(|| SourceError::invalid("fields", SourcePlanReason::UnknownField))?;
        if !binding.body.selected_fields.contains(id)
            || configured.value_type != discovered.value_type
            || configured.nullable != discovered.nullable
            || configured.optional != discovered.optional
        {
            return Err(protocol());
        }
        let write =
            !inspect && (values.values.iter().any(|(field, _)| field == id) || values.delete);
        let read = inspect || read_fields.contains(id);
        if write && (!configured.writable || !discovered.writable) {
            return Err(SourceError::invalid(
                "values",
                SourcePlanReason::FieldNotWritable,
            ));
        }
        if read && (!configured.readable || !discovered.readable) {
            return Err(SourceError::invalid(
                "expected",
                SourcePlanReason::FieldNotReadable,
            ));
        }
        crate::definitions::validate_value(&configured.value_type, configured.nullable, value)
            .map_err(|failure| {
                SourceError::new(
                    SourceFailure::Compile {
                        failure: world_protocol::compiler::CompileFailure::Definition { failure },
                    },
                    FailureStage::Validate,
                )
            })?;
        let mut modes = Vec::new();
        if read {
            modes.push(AccessMode::Read);
        }
        if !inspect {
            modes.push(if values.delete {
                AccessMode::Delete
            } else {
                AccessMode::Write
            });
        }
        for mapped in binding
            .body
            .field_mapping
            .iter()
            .filter(|mapping| mapping.source_field == id.as_str())
        {
            let exact = definition(snapshot, &mapped.property, &now).await?;
            let current = current_definition(snapshot, &mapped.property.id).await?;
            for model in [exact, current] {
                let DefinitionBody::Property(property) = model.body else {
                    return Err(protocol());
                };
                labels.extend(property.access_labels);
                access.push(AccessScope {
                    resources: vec![ResourceRef::Source {
                        id: binding.body.source_id.clone(),
                    }],
                    fields: vec![mapped.property.clone()],
                    modes: modes.clone(),
                    scope: model.scope,
                    valid_time: None,
                });
            }
        }
    }
    access.push(AccessScope {
        resources: vec![ResourceRef::Source {
            id: binding.body.source_id.clone(),
        }],
        fields: Vec::new(),
        modes: if inspect {
            vec![AccessMode::Read]
        } else {
            vec![if values.delete {
                AccessMode::Delete
            } else {
                AccessMode::Write
            }]
        },
        scope: binding.scope.clone(),
        valid_time: None,
    });
    if connection.scope != binding.scope {
        access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: binding.body.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: if inspect {
                vec![AccessMode::Read]
            } else {
                vec![if values.delete {
                    AccessMode::Delete
                } else {
                    AccessMode::Write
                }]
            },
            scope: connection.scope.clone(),
            valid_time: None,
        });
    }
    let impact = authorization::actual_impact(
        access,
        vec![if inspect {
            Effect::SourceRead
        } else {
            Effect::ExternalWrite
        }],
        labels,
        Vec::new(),
        vec![binding.body.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    let required = if inspect {
        super::super::configuration::read_access(&connection)?
    } else {
        vec![world_protocol::package::RequestedAccess::Network {
            origin: super::super::configuration::network_origin(&connection.config)?,
        }]
    };
    crate::extensions::package::require_grants_read(
        snapshot,
        prepared.implementation(),
        &required,
    )
    .await?;
    Ok(EffectMetadata {
        binding,
        connection,
        schema,
        fields,
        keys,
        impact,
    })
}

fn number(revision: Revision) -> Result<i64, SourceError> {
    i64::try_from(revision.0)
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(protocol)
}
fn decode<T: serde::de::DeserializeOwned>(body: serde_json::Value) -> Result<T, SourceError> {
    serde_json::from_value(body).map_err(|cause| {
        SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Decode, cause)
    })
}
fn missing(capability: SourceCapability) -> SourceError {
    SourceError::new(
        SourceFailure::CapabilityMissing { capability },
        FailureStage::Prepare,
    )
}
fn protocol() -> SourceError {
    SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Validate)
}
