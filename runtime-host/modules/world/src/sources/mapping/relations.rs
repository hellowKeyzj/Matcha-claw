use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    facts::{AssertionOrigin, Claim, ObservationDraft, Polarity, RelationClaim, RoleBinding},
    identity::SubjectRef,
    ids::SourceFieldId,
    materials::SourceAnchor,
    sources::{
        FieldMappingFailure, MapRecordsRequest, MapRecordsResult, MappingFailure, SourceField,
        SourceRow,
    },
};

use super::{observations, receipts};

pub(crate) fn map_query_roles(
    schema: &world_protocol::sources::SchemaDiscovery,
    mapped: &world_protocol::sources::MappedRelation,
    definition: &world_protocol::definitions::Definition<world_protocol::definitions::RelationType>,
    row: &SourceRow,
) -> Result<Vec<world_protocol::sources::BranchRoleProposal>, MappingFailure> {
    if mapped.relation_type != definition.reference
        || schema.reference.world != definition.reference.world
    {
        return Err(MappingFailure::RevisionMismatch);
    }
    let mut seen = BTreeSet::new();
    let mut roles = Vec::new();
    for role in &mapped.roles {
        let declared = definition
            .body
            .roles
            .iter()
            .find(|entry| entry.id == role.role)
            .ok_or(MappingFailure::AuthorityMismatch)?;
        if !seen.insert(&role.role)
            || declared.cardinality.minimum > 1
            || declared
                .cardinality
                .maximum
                .is_some_and(|maximum| maximum < 1)
        {
            return Err(MappingFailure::AuthorityMismatch);
        }
        let mut fields = row
            .fields
            .iter()
            .filter(|field| field.id == role.source_field);
        let field = fields.next().ok_or(MappingFailure::IncompleteKey)?;
        if fields.next().is_some() {
            return Err(MappingFailure::DuplicateKey);
        }
        observations::validate_observed_field(schema, field)?;
        let declared = schema
            .fields
            .iter()
            .find(|entry| entry.id == field.id)
            .ok_or(MappingFailure::IncompleteKey)?;
        let native_key = receipts::role_key(field)?;
        let world_protocol::sources::RecordCell::Known { value } = &field.value else {
            return Err(MappingFailure::IncompleteKey);
        };
        crate::definitions::validate_value(&declared.value_type, false, value)
            .map_err(|_| MappingFailure::IncompleteKey)?;
        roles.push(world_protocol::sources::BranchRoleProposal {
            role: role.role.clone(),
            target_source: role.target_source.clone(),
            target_namespace: role.target_namespace.clone(),
            native_key,
        });
    }
    if definition
        .body
        .roles
        .iter()
        .any(|role| role.cardinality.minimum > 0 && !seen.contains(&role.id))
    {
        return Err(MappingFailure::AuthorityMismatch);
    }
    Ok(roles)
}

pub(super) fn map_relations(
    request: &MapRecordsRequest,
    row: &SourceRow,
    identity: &SubjectRef,
    fields: &BTreeMap<&SourceFieldId, &SourceField>,
    blocked: &BTreeSet<SourceFieldId>,
    duplicate_fields: &BTreeSet<&SourceFieldId>,
    row_number: u64,
    result: &mut MapRecordsResult,
    row_dependencies: &[world_protocol::provenance::ReadDependency],
    observation_dependencies: &mut Vec<Vec<world_protocol::provenance::ReadDependency>>,
    step: &mut impl FnMut() -> Result<(), MappingFailure>,
) -> Result<(), MappingFailure> {
    for mapped in &request.plan.mapping.relations {
        step()?;
        let outcome = (|| {
            let SubjectRef::Relation { id } = identity else {
                return Err(MappingFailure::IdentityUnresolved);
            };
            let definition = request
                .plan
                .relation_definitions
                .iter()
                .find(|definition| definition.reference == mapped.relation_type)
                .ok_or(MappingFailure::RevisionMismatch)?;
            if !request
                .basis
                .field_definitions
                .contains(&mapped.relation_type)
            {
                return Err(MappingFailure::RevisionMismatch);
            }
            receipts::push(
                &mut result.dependencies,
                world_protocol::provenance::ReadDependency::Definition {
                    reference: mapped.relation_type.clone(),
                },
            );
            let mut dependencies = row_dependencies.to_vec();
            receipts::push(
                &mut dependencies,
                world_protocol::provenance::ReadDependency::Definition {
                    reference: mapped.relation_type.clone(),
                },
            );
            let mut roles = Vec::new();
            let mut source_fields = Vec::new();
            for role in &mapped.roles {
                step()?;
                if duplicate_fields.contains(&role.source_field) {
                    return Err(MappingFailure::DuplicateKey);
                }
                if blocked.contains(&role.source_field) {
                    return Err(MappingFailure::FieldTypeChanged {
                        field: role.source_field.clone(),
                    });
                }
                let field = fields
                    .get(&role.source_field)
                    .ok_or(MappingFailure::IncompleteKey)?;
                observations::validate_field(request, field)?;
                receipts::field_dependency(request, &field.id, &mut dependencies)?;
                if field.formula.is_some() {
                    return Err(MappingFailure::FormulaUnavailable {
                        field: field.id.clone(),
                    });
                }
                let native_key = super::receipts::role_key(field)?;
                let role_definition = definition
                    .body
                    .roles
                    .iter()
                    .find(|entry| entry.id == role.role)
                    .ok_or(MappingFailure::AuthorityMismatch)?;
                let mut targets = request.identities.iter().filter(|receipt| {
                    receipt.key.world == request.plan.binding.world
                        && receipt.key.source_id == role.target_source
                        && receipt.key.namespace == role.target_namespace
                        && receipt.key.native_key == native_key
                        && receipt.scope == request.plan.authority.scope
                        && crate::definitions::valid_time_contains(
                            &receipt.key.valid_time,
                            &request.batch.valid_time,
                        )
                });
                let target = targets.next().ok_or(MappingFailure::IdentityUnresolved)?;
                if targets.next().is_some() {
                    return Err(MappingFailure::IdentityAmbiguous);
                }
                let object = receipts::receipt_subject(
                    target,
                    &role_definition.target_type,
                    &mut dependencies,
                )?;
                let SubjectRef::Object { id: object_id } = object else {
                    return Err(MappingFailure::IdentityUnresolved);
                };
                roles.push(RoleBinding {
                    role: role.role.clone(),
                    object_id,
                });
                source_fields.push((*field).clone());
            }
            // The complete role group is one claim; a failed endpoint never yields a partial relation.
            let anchor = SourceAnchor::Record {
                namespace: request.plan.binding_body.namespace.clone(),
                native_key: row.native_key.clone(),
                fields: source_fields
                    .iter()
                    .map(|field| field.name.clone())
                    .collect(),
            };
            let evidence = observations::evidence(
                request,
                &anchor,
                &(row.incarnation.as_str(), mapped, source_fields),
            )?;
            for dependency in &dependencies {
                receipts::push(&mut result.dependencies, dependency.clone());
            }
            if mapped.roles.iter().all(|role| {
                receipts::field_mode(request, &role.source_field)
                    != world_protocol::sources::BindingMode::Virtual
            }) {
                observation_dependencies.push(dependencies);
                result.observations.push(ObservationDraft {
                    claim: Claim::Relation(RelationClaim {
                        relation_id: id.clone(),
                        relation_type: mapped.relation_type.clone(),
                        roles,
                    }),
                    polarity: Polarity::Positive,
                    scope: request.plan.authority.scope.clone(),
                    valid_time: request.batch.valid_time.clone(),
                    observed_at: request.basis.observed_at.clone(),
                    origin: AssertionOrigin::Source {
                        binding: request.plan.binding.clone(),
                        authority: request.plan.authority.authority.clone(),
                        position: request.basis.position.clone(),
                    },
                    evidence: vec![evidence.reference.clone()],
                    supersedes: None,
                });
            }
            result.evidence.push(evidence);
            Ok(())
        })();
        if let Err(failure) = outcome {
            if matches!(
                failure,
                MappingFailure::Cancelled | MappingFailure::BudgetExceeded { .. }
            ) {
                return Err(failure);
            }
            result.failures.push(FieldMappingFailure {
                row: row_number,
                field: None,
                failure,
            });
        }
    }
    Ok(())
}
