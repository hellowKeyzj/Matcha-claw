use std::collections::BTreeSet;

use world_protocol::{
    definitions::{Definition, Property},
    facts::{AuthorityOwnership, SourceAuthority},
    ids::SourceFieldId,
    sources::{
        CompileSourceRequest, CompiledSourcePlan, FieldMappingFailure, MappingFailure,
        SchemaDiscovery, SchemaMapping, SourceBinding, SourceCapability, SyncPolicy,
    },
};

use super::{capabilities::require_change_stream, transform};

pub(crate) fn compile_plan(
    mut request: CompileSourceRequest,
) -> Result<CompiledSourcePlan, MappingFailure> {
    validate_binding(&request)?;
    request
        .field_definitions
        .sort_by(|a, b| a.reference.cmp(&b.reference));
    request
        .relation_definitions
        .sort_by(|a, b| a.reference.cmp(&b.reference));
    if request
        .field_definitions
        .windows(2)
        .any(|pair| pair[0].reference == pair[1].reference)
        || request
            .relation_definitions
            .windows(2)
            .any(|pair| pair[0].reference == pair[1].reference)
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    let mut properties = BTreeSet::new();
    if request
        .mapping
        .fields
        .iter()
        .any(|field| !properties.insert(&field.property))
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    let mut blocked_fields = Vec::new();
    for mapped in &request.mapping.fields {
        let outcome = request
            .field_definitions
            .iter()
            .find(|definition| definition.reference == mapped.property)
            .ok_or_else(|| MappingFailure::TypeMismatch {
                property: mapped.property.clone(),
            })
            .and_then(|definition| {
                validate_field(
                    &request.binding.body,
                    &request.schema,
                    &request.mapping,
                    mapped,
                    definition,
                    &request.authority,
                )
            });
        if let Err(failure) = outcome {
            blocked_fields.push(FieldMappingFailure {
                row: 0,
                field: Some(mapped.source_field.clone()),
                failure,
            });
        }
    }
    let mut relations = BTreeSet::new();
    for mapped in &request.mapping.relations {
        if !relations.insert(&mapped.relation_type) {
            return Err(MappingFailure::RevisionMismatch);
        }
        let outcome = validate_relation(&request, mapped);
        if let Err(failure) = outcome {
            for role in &mapped.roles {
                blocked_fields.push(FieldMappingFailure {
                    row: 0,
                    field: Some(role.source_field.clone()),
                    failure: failure.clone(),
                });
            }
            if mapped.roles.is_empty() {
                return Err(failure);
            }
        }
    }
    let digest = crate::definitions::canonical_digest(&(
        "world.records.map.plan.v1",
        &request.binding.reference,
        &request.binding.body,
        &request.schema,
        &request.mapping,
        &request.authority,
        &request.field_definitions,
        &request.relation_definitions,
        &blocked_fields,
    ))
    .map_err(|_| MappingFailure::InternalFault)?;
    Ok(CompiledSourcePlan {
        binding: request.binding.reference,
        binding_body: request.binding.body,
        schema: request.schema,
        mapping: request.mapping,
        authority: request.authority,
        field_definitions: request.field_definitions,
        relation_definitions: request.relation_definitions,
        blocked_fields,
        digest,
    })
}

fn validate_relation(
    request: &CompileSourceRequest,
    mapped: &world_protocol::sources::MappedRelation,
) -> Result<(), MappingFailure> {
    let definition = request
        .relation_definitions
        .iter()
        .find(|definition| definition.reference == mapped.relation_type)
        .ok_or(MappingFailure::RevisionMismatch)?;
    if definition.reference.world != request.binding.reference.world {
        return Err(MappingFailure::CrossWorld);
    }
    if definition.scope != request.binding.body.scope
        || !crate::definitions::valid_time_contains(
            &definition.valid_time,
            &request.authority.valid_time,
        )
        || request.mapping.type_ref != mapped.relation_type
    {
        return Err(MappingFailure::AuthorityMismatch);
    }
    let AuthorityOwnership::RelationRoles {
        relation_type,
        roles,
    } = &request.authority.ownership
    else {
        return Err(MappingFailure::AuthorityMismatch);
    };
    if relation_type != &mapped.relation_type {
        return Err(MappingFailure::AuthorityMismatch);
    }
    let mut seen = BTreeSet::new();
    for role in &mapped.roles {
        approved_field(&request.binding.body, &request.schema, &role.source_field)?;
        let target = definition
            .body
            .roles
            .iter()
            .find(|entry| entry.id == role.role)
            .ok_or(MappingFailure::AuthorityMismatch)?;
        if !seen.insert(&role.role)
            || !roles.contains(&role.role)
            || !request.authority.authority.roles.contains(&role.role)
            || role.target_namespace.is_empty()
            || target.target_type.world != request.binding.reference.world
            || target.cardinality.minimum > 1
            || target
                .cardinality
                .maximum
                .is_some_and(|maximum| maximum < 1)
        {
            return Err(MappingFailure::AuthorityMismatch);
        }
    }
    if definition
        .body
        .roles
        .iter()
        .any(|role| !seen.contains(&role.id) && role.cardinality.minimum > 0)
        || roles.iter().any(|role| !seen.contains(role))
    {
        return Err(MappingFailure::AuthorityMismatch);
    }
    Ok(())
}

fn validate_binding(request: &CompileSourceRequest) -> Result<(), MappingFailure> {
    let world = &request.binding.reference.world;
    if &request.authority.world != world
        || request
            .field_definitions
            .iter()
            .any(|definition| &definition.reference.world != world)
        || request
            .relation_definitions
            .iter()
            .any(|definition| &definition.reference.world != world)
    {
        return Err(MappingFailure::CrossWorld);
    }
    validate_mapping(&request.binding, &request.schema, &request.mapping)?;
    validate_authority(&request.binding.body, &request.binding, &request.authority)
}

pub(super) fn validate_mapping(
    definition: &Definition<SourceBinding>,
    schema: &SchemaDiscovery,
    mapping: &SchemaMapping,
) -> Result<(), MappingFailure> {
    let binding = &definition.body;
    let world = &definition.reference.world;
    if definition.scope != binding.scope
        || &binding.schema.world != world
        || &binding.mapping.world != world
        || &binding.identity_rule.world != world
        || &mapping.type_ref.world != world
        || &schema.reference.world != world
    {
        return Err(MappingFailure::CrossWorld);
    }
    if binding.source_id != schema.source_id
        || binding.incarnation != schema.incarnation
        || binding.namespace != schema.namespace
        || binding.schema != schema.reference
        || binding.mapping != mapping.reference
        || binding.schema != mapping.schema
        || binding.identity_rule != mapping.identity_rule
        || binding.identity_mapping.type_id != mapping.type_ref.id
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    if binding.resource.is_empty()
        || binding.namespace.is_empty()
        || binding.incarnation.is_empty()
        || definition.reference.revision.0 == 0
        || binding.connection_revision.0 == 0
        || binding.schema.revision.0 == 0
        || binding.mapping.revision.0 == 0
        || binding.identity_rule.revision.0 == 0
        || mapping.type_ref.revision.0 == 0
        || binding.authority.revision.0 == 0
        || binding.retention.revision.0 == 0
        || mapping.key_fields.is_empty()
    {
        return Err(MappingFailure::IncompleteKey);
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    if schema
        .fields
        .iter()
        .any(|field| !ids.insert(&field.id) || field.name.is_empty() || !names.insert(&field.name))
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    let mut selected = BTreeSet::new();
    if binding
        .selected_fields
        .iter()
        .any(|field| !selected.insert(field))
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    let mut keys = BTreeSet::new();
    for id in &mapping.key_fields {
        if !keys.insert(id) {
            return Err(MappingFailure::DuplicateKey);
        }
        approved_field(binding, &schema, id)?;
    }
    let key_names: Vec<_> = mapping
        .key_fields
        .iter()
        .filter_map(|id| {
            schema
                .fields
                .iter()
                .find(|field| &field.id == id)
                .map(|field| &field.name)
        })
        .collect();
    if key_names
        != binding
            .identity_mapping
            .key_fields
            .iter()
            .collect::<Vec<_>>()
    {
        return Err(MappingFailure::IncompleteKey);
    }
    let mut modes = BTreeSet::new();
    if binding
        .field_modes
        .iter()
        .any(|mode| !selected.contains(&mode.field_id) || !modes.insert(&mode.field_id))
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    if binding.field_mapping.len() != mapping.fields.len()
        || binding.role_mapping.len()
            != mapping
                .relations
                .iter()
                .map(|relation| relation.roles.len())
                .sum::<usize>()
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    for mapped in &mapping.fields {
        let field = schema
            .fields
            .iter()
            .find(|field| field.id == mapped.source_field);
        if !binding.field_mapping.iter().any(|entry| {
            field.is_some_and(|field| {
                entry.source_field == field.name
                    && entry.source_type == field.value_type
                    && entry.property == mapped.property
                    && entry
                        .transform
                        .as_ref()
                        .unwrap_or(&world_protocol::sources::SourceTransform::Identity)
                        == &mapped.transform
            })
        }) {
            return Err(MappingFailure::RevisionMismatch);
        }
    }
    for role in mapping
        .relations
        .iter()
        .flat_map(|relation| &relation.roles)
    {
        if !binding.role_mapping.iter().any(|entry| {
            entry.role == role.role
                && entry.target_source_id == role.target_source
                && entry.target_namespace == role.target_namespace
                && schema
                    .fields
                    .iter()
                    .any(|field| field.id == role.source_field && field.name == entry.source_field)
        }) {
            return Err(MappingFailure::RevisionMismatch);
        }
    }
    if matches!(binding.sync, SyncPolicy::ChangeStream) {
        require_change_stream(&binding.capabilities).map_err(|_| {
            MappingFailure::CapabilityMissing {
                capability: SourceCapability::ChangeStream,
            }
        })?;
    }
    if matches!(binding.sync, SyncPolicy::Poll { interval } if interval.0 == 0) {
        return Err(MappingFailure::CapabilityMissing {
            capability: SourceCapability::Snapshot,
        });
    }
    Ok(())
}

fn validate_authority(
    binding: &SourceBinding,
    definition: &Definition<SourceBinding>,
    authority: &SourceAuthority,
) -> Result<(), MappingFailure> {
    if authority.binding != definition.reference
        || authority.source_id != binding.source_id
        || authority.incarnation != binding.incarnation
        || authority.authority != binding.authority
        || authority.scope != binding.scope
        || !crate::definitions::valid_time_contains(&definition.valid_time, &authority.valid_time)
    {
        return Err(MappingFailure::AuthorityMismatch);
    }
    Ok(())
}

fn approved_field<'a>(
    binding: &SourceBinding,
    schema: &'a SchemaDiscovery,
    id: &SourceFieldId,
) -> Result<&'a world_protocol::sources::DiscoveredField, MappingFailure> {
    if !binding.selected_fields.contains(id) {
        return Err(MappingFailure::PermissionDenied {
            field: Some(id.clone()),
        });
    }
    let field = schema
        .fields
        .iter()
        .find(|field| &field.id == id)
        .ok_or_else(|| {
            if schema.complete {
                MappingFailure::FieldRemoved { field: id.clone() }
            } else {
                MappingFailure::SchemaMissing {
                    reference: schema.reference.clone(),
                }
            }
        })?;
    if !field.readable {
        return Err(MappingFailure::PermissionDenied {
            field: Some(id.clone()),
        });
    }
    Ok(field)
}

fn validate_field(
    binding: &SourceBinding,
    schema: &SchemaDiscovery,
    mapping: &SchemaMapping,
    mapped: &world_protocol::sources::MappedField,
    definition: &Definition<Property>,
    authority: &SourceAuthority,
) -> Result<(), MappingFailure> {
    let field = approved_field(binding, schema, &mapped.source_field)?;
    if mapped.property != definition.reference {
        return Err(MappingFailure::RevisionMismatch);
    }
    if definition.scope != binding.scope
        || !definition.body.domain.contains(&mapping.type_ref.id)
        || !crate::definitions::valid_time_contains(&definition.valid_time, &authority.valid_time)
    {
        return Err(MappingFailure::TypeMismatch {
            property: mapped.property.clone(),
        });
    }
    if !matches!(&authority.ownership, AuthorityOwnership::Properties { properties } if properties.contains(&mapped.property))
        || !authority.authority.fields.contains(&mapped.property.id)
    {
        return Err(MappingFailure::AuthorityMismatch);
    }
    crate::definitions::validate_value_type(&field.value_type)
        .and_then(|_| crate::definitions::validate_value_type(&definition.body.value_type))
        .map_err(|failure| transform::value_failure(failure, &field.id, &mapped.property))?;
    if !transform::compatible(
        &mapped.transform,
        &field.value_type,
        &definition.body.value_type,
    ) {
        return Err(match (&field.value_type, &definition.body.value_type) {
            (
                world_protocol::value::ValueType::Money { .. },
                world_protocol::value::ValueType::Money { .. },
            )
            | (
                world_protocol::value::ValueType::Quantity { .. },
                world_protocol::value::ValueType::Quantity { .. },
            ) => MappingFailure::UnitMismatch {
                property: mapped.property.clone(),
            },
            _ => MappingFailure::TypeMismatch {
                property: mapped.property.clone(),
            },
        });
    }
    Ok(())
}
