use super::{observations, receipts};
use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    facts::Evidence,
    materials::SourceAnchor,
    sources::{
        BranchFieldProposal, BranchRecordProposal, BranchRelationProposal, FieldMappingFailure,
        MapRecordsRequest, MappingFailure,
    },
};

type Output = (
    Vec<BranchRecordProposal>,
    Vec<Evidence>,
    Vec<FieldMappingFailure>,
);

/// Execution consumes the invocation's shared account; persisted replay uses the same pure interpreter.
pub(in crate::sources) fn map_branch_records(
    request: &MapRecordsRequest,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Output, MappingFailure> {
    let mut step = || {
        if cancellation.is_cancelled() {
            return Err(MappingFailure::Cancelled);
        }
        budget
            .charge(BudgetDimension::Steps, 1)
            .map_err(|error| MappingFailure::BudgetExceeded {
                dimension: error.dimension,
            })
    };
    budget
        .charge(BudgetDimension::Rows, request.batch.rows.len() as u64)
        .map_err(|error| MappingFailure::BudgetExceeded {
            dimension: error.dimension,
        })?;
    let output = map(request, &mut step)?;
    let bytes = serde_json::to_vec(&output).map_err(|_| MappingFailure::InternalFault)?;
    budget
        .charge(BudgetDimension::Bytes, bytes.len() as u64)
        .map_err(|error| MappingFailure::BudgetExceeded {
            dimension: error.dimension,
        })?;
    Ok(output)
}

pub(in crate::sources) fn replay_branch_records(
    request: &MapRecordsRequest,
) -> Result<Output, MappingFailure> {
    let mut steps = 0_u64;
    map(request, &mut || {
        steps = steps.checked_add(1).ok_or(MappingFailure::BudgetExceeded {
            dimension: BudgetDimension::Steps,
        })?;
        if steps > request.budget.max_steps {
            return Err(MappingFailure::BudgetExceeded {
                dimension: BudgetDimension::Steps,
            });
        }
        Ok(())
    })
}

fn map(
    request: &MapRecordsRequest,
    step: &mut impl FnMut() -> Result<(), MappingFailure>,
) -> Result<Output, MappingFailure> {
    receipts::validate_basis(request)?;
    if request.batch.rows.len() as u64 > request.budget.max_rows {
        return Err(MappingFailure::BudgetExceeded {
            dimension: BudgetDimension::Rows,
        });
    }
    if let Some(failure) = super::schema_drift(&request.plan.schema, &request.observed_schema, &[])
        .into_iter()
        .next()
    {
        return Err(failure);
    }
    let mut proposals = Vec::new();
    let mut evidence = Vec::new();
    let mut failures = if request.batch.rows.is_empty() {
        request.plan.blocked_fields.clone()
    } else {
        Vec::new()
    };
    let mut keys = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for row in &request.batch.rows {
        step()?;
        if !keys.insert((&row.native_key, &row.incarnation)) {
            duplicates.insert((&row.native_key, &row.incarnation));
        }
    }
    for (index, row) in request.batch.rows.iter().enumerate() {
        step()?;
        if let Err(failure) = receipts::validate_key(request, row).and_then(|()| {
            if duplicates.contains(&(&row.native_key, &row.incarnation)) {
                Err(MappingFailure::DuplicateKey)
            } else {
                Ok(())
            }
        }) {
            failures.push(FieldMappingFailure {
                row: index as u64,
                field: None,
                failure,
            });
            continue;
        }
        let mut fields = BTreeMap::new();
        let mut duplicate_fields = BTreeSet::new();
        for field in &row.fields {
            if fields.insert(&field.id, field).is_some() {
                duplicate_fields.insert(&field.id);
            }
        }
        let mut proposal = BranchRecordProposal {
            key: world_protocol::identity::SourceKey {
                world: request.plan.binding.world.clone(),
                source_id: request.batch.source_id.clone(),
                namespace: request.plan.binding_body.namespace.clone(),
                native_key: row.native_key.clone(),
                incarnation: row.incarnation.clone(),
                valid_time: request.batch.valid_time.clone(),
            },
            type_ref: request.plan.mapping.type_ref.clone(),
            identity: None,
            fields: Vec::new(),
            relations: Vec::new(),
        };
        for mapped in &request.plan.mapping.fields {
            step()?;
            let outcome = (|| {
                if duplicate_fields.contains(&mapped.source_field) {
                    return Err(MappingFailure::DuplicateKey);
                }
                if let Some(blocked) = request
                    .plan
                    .blocked_fields
                    .iter()
                    .find(|failure| failure.field.as_ref() == Some(&mapped.source_field))
                {
                    return Err(blocked.failure.clone());
                }
                if let Some(failure) = super::schema_drift(
                    &request.plan.schema,
                    &request.observed_schema,
                    std::slice::from_ref(&mapped.source_field),
                )
                .into_iter()
                .next()
                {
                    return Err(failure);
                }
                let definition = request
                    .plan
                    .field_definitions
                    .iter()
                    .find(|definition| definition.reference == mapped.property)
                    .ok_or(MappingFailure::RevisionMismatch)?;
                let source = fields.get(&mapped.source_field).copied();
                let Some(cell) = observations::map_field(request, mapped, definition, source)?
                else {
                    return Ok(());
                };
                let refs = if source.is_some()
                    || matches!(&cell, world_protocol::value::Cell::Known { .. })
                {
                    let proof = observations::field_evidence(request, row, mapped, source)?;
                    let refs = vec![proof.reference.clone()];
                    evidence.push(proof);
                    refs
                } else {
                    Vec::new()
                };
                proposal.fields.push(BranchFieldProposal {
                    property: mapped.property.clone(),
                    cell,
                    evidence: refs,
                });
                Ok(())
            })();
            if let Err(failure) = outcome {
                failures.push(FieldMappingFailure {
                    row: index as u64,
                    field: Some(mapped.source_field.clone()),
                    failure,
                });
            }
        }
        for mapped in &request.plan.mapping.relations {
            step()?;
            let outcome = (|| {
                if mapped.relation_type != proposal.type_ref {
                    return Err(MappingFailure::IdentityUnresolved);
                }
                let definition = request
                    .plan
                    .relation_definitions
                    .iter()
                    .find(|definition| definition.reference == mapped.relation_type)
                    .ok_or(MappingFailure::RevisionMismatch)?;
                let mut source_fields = Vec::new();
                for role in &mapped.roles {
                    step()?;
                    if duplicate_fields.contains(&role.source_field) {
                        return Err(MappingFailure::DuplicateKey);
                    }
                    if let Some(blocked) = request
                        .plan
                        .blocked_fields
                        .iter()
                        .find(|failure| failure.field.as_ref() == Some(&role.source_field))
                    {
                        return Err(blocked.failure.clone());
                    }
                    if let Some(failure) = super::schema_drift(
                        &request.plan.schema,
                        &request.observed_schema,
                        std::slice::from_ref(&role.source_field),
                    )
                    .into_iter()
                    .next()
                    {
                        return Err(failure);
                    }
                    source_fields.push(
                        (*fields
                            .get(&role.source_field)
                            .ok_or(MappingFailure::IncompleteKey)?)
                        .clone(),
                    );
                }
                let roles =
                    super::map_query_roles(&request.observed_schema, mapped, definition, row)?;
                let anchor = SourceAnchor::Record {
                    namespace: request.plan.binding_body.namespace.clone(),
                    native_key: row.native_key.clone(),
                    fields: source_fields
                        .iter()
                        .map(|field| field.name.clone())
                        .collect(),
                };
                let proof = observations::evidence(
                    request,
                    &anchor,
                    &(row.incarnation.as_str(), mapped, source_fields),
                )?;
                proposal.relations.push(BranchRelationProposal {
                    relation_type: mapped.relation_type.clone(),
                    roles,
                    evidence: vec![proof.reference.clone()],
                });
                evidence.push(proof);
                Ok(())
            })();
            if let Err(failure) = outcome {
                if matches!(
                    failure,
                    MappingFailure::Cancelled | MappingFailure::BudgetExceeded { .. }
                ) {
                    return Err(failure);
                }
                failures.push(FieldMappingFailure {
                    row: index as u64,
                    field: None,
                    failure,
                });
            }
        }
        proposals.push(proposal);
    }
    Ok((proposals, evidence, failures))
}
