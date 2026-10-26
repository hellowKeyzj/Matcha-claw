use world_protocol::{
    identity::{AliasResolution, IdentityReceipt, IdentityRecord, SourceKey, SubjectRef},
    ids::DefinitionRef,
    provenance::ReadDependency,
    sources::{MapRecordsRequest, MappingFailure, RecordCell, SourceRow},
};

pub(super) fn validate_basis(request: &MapRecordsRequest) -> Result<(), MappingFailure> {
    let plan = &request.plan;
    let basis = &request.basis;
    let binding = &plan.binding_body;
    let digest = crate::definitions::canonical_digest(&(
        "world.records.map.plan.v1",
        &plan.binding,
        &plan.binding_body,
        &plan.schema,
        &plan.mapping,
        &plan.authority,
        &plan.field_definitions,
        &plan.relation_definitions,
        &plan.blocked_fields,
    ))
    .map_err(|_| MappingFailure::InternalFault)?;
    if digest != plan.digest {
        return Err(MappingFailure::RevisionMismatch);
    }
    if request.batch.source_version.world != plan.binding.world
        || request.source_version.reference.world != plan.binding.world
        || request.observed_schema.reference.world != plan.binding.world
    {
        return Err(MappingFailure::CrossWorld);
    }
    if basis.source_id != binding.source_id
        || request.batch.source_id != binding.source_id
        || basis.incarnation != binding.incarnation
        || request.batch.incarnation != binding.incarnation
        || basis.binding != plan.binding
        || basis.mapping_revision != plan.mapping.reference.revision
        || basis.authority_revision != plan.authority.authority.revision
        || basis.identity_rule != plan.mapping.identity_rule
        || basis.schema != request.batch.schema
        || request.observed_schema.reference != request.batch.schema
        || request.source_version.reference != request.batch.source_version
        || request.source_version.reference.source_id != binding.source_id
        || plan.authority.binding != plan.binding
        || plan.authority.incarnation != binding.incarnation
        || plan.authority.source_id != binding.source_id
        || plan.authority.scope != binding.scope
        || plan.authority.authority != binding.authority
        || !crate::definitions::valid_time_contains(
            &plan.authority.valid_time,
            &request.batch.valid_time,
        )
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    if basis.position.as_ref().is_some_and(|position| {
        position.source_id != binding.source_id || position.incarnation != binding.incarnation
    }) {
        return Err(MappingFailure::RevisionMismatch);
    }
    Ok(())
}

pub(super) fn plan_dependencies(
    request: &MapRecordsRequest,
    dependencies: &mut Vec<ReadDependency>,
) {
    push(
        dependencies,
        ReadDependency::SourceMapping {
            mapping: request.plan.mapping.reference.clone(),
            identity_rule: request.plan.mapping.identity_rule.clone(),
            authority: request.plan.authority.authority.clone(),
            binding: request.plan.binding.clone(),
        },
    );
    push(
        dependencies,
        ReadDependency::Definition {
            reference: request.plan.mapping.type_ref.clone(),
        },
    );
    if let Some(position) = &request.basis.position {
        push(
            dependencies,
            ReadDependency::Source {
                position: position.clone(),
                binding: request.plan.binding.clone(),
            },
        );
    }
}

pub(super) fn field_mode(
    request: &MapRecordsRequest,
    id: &world_protocol::ids::SourceFieldId,
) -> world_protocol::sources::BindingMode {
    request
        .plan
        .binding_body
        .field_modes
        .iter()
        .find(|mode| &mode.field_id == id)
        .map_or(request.plan.binding_body.mode, |mode| mode.mode)
}

pub(super) fn field_dependency(
    request: &MapRecordsRequest,
    id: &world_protocol::ids::SourceFieldId,
    dependencies: &mut Vec<ReadDependency>,
) -> Result<(), MappingFailure> {
    let field = request
        .observed_schema
        .fields
        .iter()
        .find(|field| &field.id == id)
        .ok_or_else(|| MappingFailure::SchemaMissing {
            reference: request.observed_schema.reference.clone(),
        })?;
    push(
        dependencies,
        ReadDependency::SourceField {
            schema: request.observed_schema.reference.clone(),
            field: field.id.clone(),
            value_type: field.value_type.clone(),
            nullable: field.nullable,
            optional: field.optional,
            name: field.name.clone(),
        },
    );
    Ok(())
}

pub(super) fn validate_key(
    request: &MapRecordsRequest,
    row: &SourceRow,
) -> Result<(), MappingFailure> {
    validate_row_key(&request.plan, &request.observed_schema, row)
}

pub(in crate::sources) fn validate_row_key(
    plan: &world_protocol::sources::CompiledSourcePlan,
    observed: &world_protocol::sources::SchemaDiscovery,
    row: &SourceRow,
) -> Result<(), MappingFailure> {
    if row.native_key.is_empty() || row.incarnation.is_empty() {
        return Err(MappingFailure::IncompleteKey);
    }
    let mut cells = Vec::with_capacity(plan.mapping.key_fields.len());
    for id in &plan.mapping.key_fields {
        let mut fields = row.fields.iter().filter(|field| &field.id == id);
        let field = fields.next().ok_or(MappingFailure::IncompleteKey)?;
        if fields.next().is_some() {
            return Err(MappingFailure::DuplicateKey);
        }
        super::observations::validate_observed_field(observed, field)?;
        let value = match &field.value {
            RecordCell::Known { value } => value,
            RecordCell::Error {
                code: world_protocol::sources::RecordError::PermissionDenied,
            } => {
                return Err(MappingFailure::PermissionDenied {
                    field: Some(id.clone()),
                });
            }
            _ => return Err(MappingFailure::IncompleteKey),
        };
        if field
            .formula
            .as_ref()
            .is_some_and(|formula| !formula.cache_current || formula.cached.as_ref() != Some(value))
        {
            return Err(MappingFailure::FormulaUnavailable { field: id.clone() });
        }
        let schema = observed
            .fields
            .iter()
            .find(|field| &field.id == id)
            .ok_or(MappingFailure::IncompleteKey)?;
        crate::definitions::validate_value(&schema.value_type, false, value)
            .map_err(|_| MappingFailure::IncompleteKey)?;
        cells.push(field.value.clone());
    }
    if crate::sources::connectors::native_key(&cells).map_err(|_| MappingFailure::IncompleteKey)?
        != row.native_key
    {
        return Err(MappingFailure::IncompleteKey);
    }
    Ok(())
}

pub(super) fn role_key(
    field: &world_protocol::sources::SourceField,
) -> Result<String, MappingFailure> {
    if matches!(
        &field.value,
        RecordCell::Error {
            code: world_protocol::sources::RecordError::PermissionDenied
        }
    ) {
        return Err(MappingFailure::PermissionDenied {
            field: Some(field.id.clone()),
        });
    }
    if field.formula.is_some() {
        return Err(MappingFailure::FormulaUnavailable {
            field: field.id.clone(),
        });
    }
    crate::sources::connectors::native_key(std::slice::from_ref(&field.value))
        .map_err(|_| MappingFailure::IncompleteKey)
}

pub(super) fn row_identity(
    request: &MapRecordsRequest,
    row: &SourceRow,
    dependencies: &mut Vec<ReadDependency>,
) -> Result<SubjectRef, MappingFailure> {
    let key = SourceKey {
        world: request.plan.binding.world.clone(),
        source_id: request.batch.source_id.clone(),
        namespace: request.plan.binding_body.namespace.clone(),
        native_key: row.native_key.clone(),
        incarnation: row.incarnation.clone(),
        valid_time: request.batch.valid_time.clone(),
    };
    resolve(request, &key, &request.plan.mapping.type_ref, dependencies)
}

pub(super) fn resolve(
    request: &MapRecordsRequest,
    key: &SourceKey,
    type_ref: &DefinitionRef,
    dependencies: &mut Vec<ReadDependency>,
) -> Result<SubjectRef, MappingFailure> {
    let mut receipts = request.identities.iter().filter(|receipt| {
        receipt.key.world == key.world
            && receipt.key.source_id == key.source_id
            && receipt.key.namespace == key.namespace
            && receipt.key.native_key == key.native_key
            && receipt.key.incarnation == key.incarnation
            && receipt.scope == request.plan.authority.scope
            && crate::definitions::valid_time_contains(&receipt.key.valid_time, &key.valid_time)
    });
    let receipt = receipts.next().ok_or(MappingFailure::IdentityUnresolved)?;
    if receipts.next().is_some() {
        return Err(MappingFailure::IdentityAmbiguous);
    }
    receipt_subject(receipt, type_ref, dependencies)
}

pub(super) fn receipt_subject(
    receipt: &IdentityReceipt,
    type_ref: &DefinitionRef,
    dependencies: &mut Vec<ReadDependency>,
) -> Result<SubjectRef, MappingFailure> {
    for dependency in &receipt.dependencies {
        push(dependencies, dependency.clone());
    }
    match &receipt.resolution {
        AliasResolution::NotFound => Err(MappingFailure::IdentityUnresolved),
        AliasResolution::Ambiguous { .. } => Err(MappingFailure::IdentityAmbiguous),
        AliasResolution::Existing {
            identity,
            alias_revision,
            ..
        } => {
            let (world, type_id, subject) = match &identity.record {
                IdentityRecord::Object(object) => (
                    &object.world,
                    &object.type_id,
                    SubjectRef::Object {
                        id: object.id.clone(),
                    },
                ),
                IdentityRecord::Relation(relation) => (
                    &relation.world,
                    &relation.type_id,
                    SubjectRef::Relation {
                        id: relation.id.clone(),
                    },
                ),
            };
            if world != &type_ref.world || world != &receipt.key.world {
                return Err(MappingFailure::CrossWorld);
            }
            if type_id != &type_ref.id || identity.revision.0 == 0 || alias_revision.0 == 0 {
                return Err(MappingFailure::IdentityUnresolved);
            }
            push(
                dependencies,
                ReadDependency::Identity {
                    subject: subject.clone(),
                    revision: identity.revision,
                },
            );
            Ok(subject)
        }
    }
}

pub(super) fn push(dependencies: &mut Vec<ReadDependency>, dependency: ReadDependency) {
    if !dependencies.contains(&dependency) {
        dependencies.push(dependency);
    }
}
