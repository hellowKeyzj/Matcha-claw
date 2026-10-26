use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{
        AbstractionContract, AbstractionFailure, BindingTarget, ConcreteBinding, Fallback,
    },
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::DefinitionBody,
    evaluation::EvaluationArm,
    expression::{Effect, ExpressionIr, TruthValue},
    identity::SubjectRef,
    ids::*,
    provenance::ReadDependency,
    query::{QueryIr, QueryNode, ReadReceipt},
    releases::BranchRef,
    time::Timestamp,
    value::{Cell, UnknownReason, Value, ValueType},
};

use crate::{
    authorization::{self, Admission},
    extensions::invocation::CallBudget,
    sources::sync::BranchCapture,
    store::{StoreFuture, WorldTransaction},
};

use super::{Error, check};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindingObservation {
    binding: ConcreteBinding,
    original: Option<Cell>,
    mapped: Option<Cell>,
    guard: Option<TruthValue>,
    inverse: Option<Cell>,
    inverse_matches: Option<bool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindingExecution {
    pub concrete_parameters: BTreeMap<ParameterId, Cell>,
    pub parameters: BTreeMap<ParameterId, Cell>,
    pub observations: Vec<BindingObservation>,
    pub reason: TruthValue,
    pub fallback: Option<Fallback>,
    pub read_receipts: Vec<ReadReceipt>,
}

pub(crate) fn expressions(contract: &AbstractionContract) -> Vec<&ExpressionIr> {
    let mut expressions = Vec::new();
    for binding in &contract.binding_map.bindings {
        if let BindingTarget::Expression { expression } = &binding.target {
            expressions.push(expression);
        }
        expressions.extend(binding.guard.iter());
        expressions.extend(binding.transform.iter());
        expressions.extend(binding.inverse_transform.iter());
    }
    expressions
}

fn dependencies(binding: &ConcreteBinding) -> Vec<ReadDependency> {
    let mut result = binding.dependencies.clone();
    if let BindingTarget::Property { definition } | BindingTarget::Action { definition } =
        &binding.target
    {
        result.push(ReadDependency::Definition {
            reference: definition.clone(),
        });
    }
    result.extend(
        binding
            .evidence
            .iter()
            .cloned()
            .map(|reference| ReadDependency::Evidence { reference }),
    );
    result
}

fn subject_query(
    contract: &AbstractionContract,
    binding: &ConcreteBinding,
    model: &world_protocol::releases::Release,
) -> Result<Option<(SubjectRef, DefinitionRef, QueryIr)>, Error> {
    let slot = contract
        .slots
        .iter()
        .find(|slot| slot.id == binding.slot_id)
        .ok_or(AbstractionFailure::BasisChanged)?;
    let (subject, type_id) = match (&binding.target, &slot.value_type) {
        (BindingTarget::Object { id }, ValueType::Object { type_id }) => {
            (SubjectRef::Object { id: id.clone() }, type_id)
        }
        (BindingTarget::Relation { id }, ValueType::Relation { type_id }) => {
            (SubjectRef::Relation { id: id.clone() }, type_id)
        }
        (BindingTarget::Object { .. } | BindingTarget::Relation { .. }, _) => {
            return Err(AbstractionFailure::TypeMismatch {
                slot_id: slot.id.clone(),
            }
            .into());
        }
        _ => return Ok(None),
    };
    let definition = model
        .definitions
        .iter()
        .find(|definition| &definition.reference.id == type_id)
        .ok_or(AbstractionFailure::BasisChanged)?;
    let symbol =
        SymbolId::try_new("abstraction_subject").map_err(|_| AbstractionFailure::InternalFault)?;
    let root = match (&subject, &definition.body) {
        (SubjectRef::Object { .. }, DefinitionBody::ObjectType(_)) => QueryNode::Objects {
            type_ref: definition.reference.clone(),
            symbol,
        },
        (SubjectRef::Relation { .. }, DefinitionBody::RelationType(_)) => QueryNode::Relations {
            type_ref: definition.reference.clone(),
            symbol,
        },
        _ => {
            return Err(AbstractionFailure::TypeMismatch {
                slot_id: slot.id.clone(),
            }
            .into());
        }
    };
    Ok(Some((
        subject,
        definition.reference.clone(),
        QueryIr {
            parameters: Vec::new(),
            root,
            output: Vec::new(),
            limit: 1,
        },
    )))
}

fn typed_queries(
    value_type: &ValueType,
    model: &world_protocol::releases::Release,
) -> Result<Vec<QueryIr>, Error> {
    let mut pending = vec![value_type];
    let mut queries = Vec::new();
    while let Some(value_type) = pending.pop() {
        let (type_id, relation) = match value_type {
            ValueType::Object { type_id } => (type_id, false),
            ValueType::Relation { type_id } => (type_id, true),
            ValueType::List { element, .. } => {
                pending.push(element);
                continue;
            }
            ValueType::Record { fields } => {
                pending.extend(fields.iter().map(|field| &field.value_type));
                continue;
            }
            _ => continue,
        };
        let definition = model
            .definitions
            .iter()
            .find(|definition| &definition.reference.id == type_id)
            .ok_or(AbstractionFailure::BasisChanged)?;
        let symbol = SymbolId::try_new("abstraction_value")
            .map_err(|_| AbstractionFailure::InternalFault)?;
        let root = match (&definition.body, relation) {
            (DefinitionBody::ObjectType(_), false) => QueryNode::Objects {
                type_ref: definition.reference.clone(),
                symbol,
            },
            (DefinitionBody::RelationType(_), true) => QueryNode::Relations {
                type_ref: definition.reference.clone(),
                symbol,
            },
            _ => return Err(AbstractionFailure::BasisChanged.into()),
        };
        let query = QueryIr {
            parameters: Vec::new(),
            root,
            output: Vec::new(),
            limit: 1,
        };
        if !queries.contains(&query) {
            queries.push(query);
        }
    }
    Ok(queries)
}

async fn check_cell(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &BranchRef,
    arm: &EvaluationArm,
    slot: &world_protocol::abstraction::AbstractionSlot,
    binding: &ConcreteBinding,
    cell: &mut Cell,
    model: &world_protocol::releases::Release,
    at: &Timestamp,
    budget: &CallBudget,
    cancel: &CancellationToken,
    read_mode: &world_protocol::query::ReadMode,
    known_at: Option<&Timestamp>,
) -> Result<(), Error> {
    let Cell::Known { value } = cell else {
        return Ok(());
    };
    crate::definitions::validate_value(&slot.value_type, true, value).map_err(|_| {
        AbstractionFailure::TypeMismatch {
            slot_id: slot.id.clone(),
        }
    })?;
    let mut pending = vec![(&slot.value_type, &*value)];
    let mut complete = true;
    while let Some((value_type, value)) = pending.pop() {
        let (subject, type_id) = match (value_type, value) {
            (ValueType::Object { type_id }, Value::Object { id }) => {
                (SubjectRef::Object { id: id.clone() }, type_id)
            }
            (ValueType::Relation { type_id }, Value::Relation { id }) => {
                (SubjectRef::Relation { id: id.clone() }, type_id)
            }
            (ValueType::List { element, .. }, Value::List { items }) => {
                pending.extend(items.iter().map(|item| (element.as_ref(), item)));
                continue;
            }
            (ValueType::Record { fields }, Value::Record { fields: values }) => {
                pending.extend(fields.iter().filter_map(|field| {
                    values
                        .get(&field.name)
                        .map(|value| (&field.value_type, value))
                }));
                continue;
            }
            _ => continue,
        };
        let definition = model
            .definitions
            .iter()
            .find(|definition| &definition.reference.id == type_id)
            .ok_or(AbstractionFailure::BasisChanged)?;
        complete &= crate::query::branch_subject_in_transaction(
            tx,
            admission,
            branch,
            arm,
            &subject,
            &definition.reference,
            &binding.inverse_scope,
            at,
            budget,
            cancel,
            read_mode,
            known_at,
        )
        .await?;
    }
    if !complete {
        *cell = Cell::Unknown {
            reason: UnknownReason::NotObserved,
        };
    }
    Ok(())
}

/// The caller admits this exact current impact; the returned captures still need physical verification.
pub(crate) fn impact<'a>(
    tx: &'a WorldTransaction<'_>,
    branch: &'a BranchRef,
    arm: &'a EvaluationArm,
    contract: &'a AbstractionContract,
    at: &'a Timestamp,
) -> StoreFuture<'a, (ActualImpact, Vec<BranchCapture>), Error> {
    Box::pin(async move {
        let (selected, model) = crate::query::branch_model(tx, branch, arm).await?;
        super::basis::require_branch(tx, contract, &selected).await?;
        check::contract(contract, &model.definitions, &model.scopes)?;
        let interval = crate::query::point_interval(at)?;
        let mut impacts = Vec::new();
        impacts.extend(
            crate::facts::support::dependency_impact(
                tx,
                &contract.read_dependencies,
                &model,
                &contract.scope,
                &interval,
            )
            .await?,
        );
        let mut captures = Vec::new();
        for binding in &contract.binding_map.bindings {
            if !crate::definitions::scope_contains(
                &contract.world,
                &contract.scope,
                &binding.inverse_scope,
                &model.scopes,
            )
            .map_err(crate::definitions::DefinitionError::from)?
            {
                return Err(AbstractionFailure::BasisChanged.into());
            }
            impacts.extend(
                crate::facts::support::dependency_impact(
                    tx,
                    &dependencies(binding),
                    &model,
                    &binding.inverse_scope,
                    &interval,
                )
                .await?,
            );
            let mut state = Vec::new();
            let resource = match &binding.target {
                BindingTarget::Object { id } => Some(ResourceRef::Object { id: id.clone() }),
                BindingTarget::Relation { id } => Some(ResourceRef::Relation { id: id.clone() }),
                BindingTarget::Property { definition } | BindingTarget::Action { definition } => {
                    Some(ResourceRef::Definition {
                        id: definition.id.clone(),
                    })
                }
                BindingTarget::State { reference } => {
                    if reference.world != contract.world {
                        return Err(AbstractionFailure::BasisChanged.into());
                    }
                    state.push(reference.clone());
                    Some(ResourceRef::State {
                        id: reference.id.clone(),
                    })
                }
                BindingTarget::Expression { .. } => None,
            };
            if let Some(resource) = resource {
                impacts.push(authorization::actual_impact(
                    vec![AccessScope {
                        resources: vec![resource],
                        fields: Vec::new(),
                        modes: vec![AccessMode::Read],
                        scope: binding.inverse_scope.clone(),
                        valid_time: None,
                    }],
                    vec![Effect::Pure],
                    Vec::new(),
                    state,
                    Vec::new(),
                )?);
            }
        }
        for slot in &contract.slots {
            let queries = typed_queries(&slot.value_type, &model)?;
            for binding in contract
                .binding_map
                .bindings
                .iter()
                .filter(|binding| binding.slot_id == slot.id)
            {
                for query in &queries {
                    impacts.push(
                        crate::query::branch_impact_in_transaction(
                            tx,
                            branch,
                            arm,
                            query,
                            &[],
                            &binding.inverse_scope,
                        )
                        .await?,
                    );
                    captures.extend(crate::query::branch_query_captures(tx, branch, arm, query).await?);
                }
            }
        }
        let expressions = expressions(contract);
        impacts.push(
            crate::query::branch_expression_impact(
                tx,
                branch,
                arm,
                &contract.parameters,
                &expressions,
                &contract.scope,
            )
            .await?,
        );
        captures.extend(
            crate::query::branch_expression_captures(
                tx,
                branch,
                arm,
                &contract.parameters,
                &expressions,
            )
            .await?,
        );
        Ok((
            authorization::actual_impact(
                impacts
                    .iter()
                    .flat_map(|impact| impact.access.clone())
                    .collect(),
                impacts
                    .iter()
                    .flat_map(|impact| impact.effects.clone())
                    .collect(),
                impacts
                    .iter()
                    .flat_map(|impact| impact.labels.clone())
                    .collect(),
                impacts
                    .iter()
                    .flat_map(|impact| impact.state.clone())
                    .collect(),
                impacts
                    .iter()
                    .flat_map(|impact| impact.source_ids.clone())
                    .collect(),
            )?,
            captures,
        ))
    })
}

fn value<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    branch: &'a BranchRef,
    arm: &'a EvaluationArm,
    contract: &'a AbstractionContract,
    checked: &'a check::Checked,
    parameters: &'a BTreeMap<ParameterId, Cell>,
    expression: &'a ExpressionIr,
    path: Vec<String>,
    budget: &'a CallBudget,
    cancel: &'a CancellationToken,
    at: &'a Timestamp,
    receipts: &'a mut Vec<ReadReceipt>,
    read_mode: &'a world_protocol::query::ReadMode,
    known_at: Option<&'a Timestamp>,
) -> StoreFuture<'a, Cell, Error> {
    Box::pin(async move {
        let mut context = crate::query::branch_expression_context_cells(
            tx,
            admission,
            branch,
            arm,
            &contract.parameters,
            parameters,
            &expressions(contract),
            &contract.scope,
            budget,
            cancel,
            at,
            read_mode,
            known_at,
        )
        .await?;
        context.annotations = checked.annotations.clone();
        let value = context.value(expression, &path, at)?;
        receipts.extend(context.read_receipt);
        Ok(value)
    })
}

fn unavailable(cell: &Cell) -> TruthValue {
    match cell {
        Cell::Known { .. } => TruthValue::True,
        Cell::Unknown { .. } => TruthValue::Unknown,
        Cell::Conflicted { .. } => TruthValue::Conflicted,
        Cell::SourceUnavailable { .. } => TruthValue::SourceUnavailable,
    }
}

fn parameters(
    contract: &AbstractionContract,
    cells: &[Option<Cell>],
    parameters: &mut BTreeMap<ParameterId, Cell>,
    id: &ParameterId,
) -> Result<(), Error> {
    let bindings: Vec<_> = contract
        .binding_map
        .bindings
        .iter()
        .enumerate()
        .filter(|(_, binding)| binding.parameter_id.as_ref() == Some(id))
        .collect();
    if bindings.is_empty() {
        return Ok(());
    }
    let slot = contract
        .slots
        .iter()
        .find(|slot| slot.id == bindings[0].1.slot_id)
        .ok_or(AbstractionFailure::BasisChanged)?;
    let values = bindings
        .iter()
        .map(|(index, _)| {
            cells[*index]
                .clone()
                .ok_or(AbstractionFailure::BasisChanged)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cell = if slot.cardinality.maximum == Some(1) {
        values
            .into_iter()
            .next()
            .ok_or(AbstractionFailure::BasisChanged)?
    } else {
        super::resolve::list(values)
    };
    let parameter = contract
        .parameters
        .iter()
        .find(|parameter| &parameter.id == id)
        .ok_or(AbstractionFailure::BasisChanged)?;
    if let Cell::Known { value } = &cell {
        crate::definitions::validate_value(&parameter.value_type, parameter.nullable, value)
            .map_err(|_| AbstractionFailure::TypeMismatch {
                slot_id: slot.id.clone(),
            })?;
    }
    parameters.insert(id.clone(), cell);
    Ok(())
}

/// Executes the declared mapping against the current exact branch, never a cached abstract value.
pub(crate) fn execute_branch<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    branch: &'a BranchRef,
    arm: &'a EvaluationArm,
    contract: &'a AbstractionContract,
    fixture: &'a BTreeMap<ParameterId, Cell>,
    budget: &'a CallBudget,
    cancel: &'a CancellationToken,
    at: &'a Timestamp,
    read_mode: &'a world_protocol::query::ReadMode,
    known_at: Option<&'a Timestamp>,
) -> StoreFuture<'a, BindingExecution, Error> {
    Box::pin(async move {
        if cancel.is_cancelled() {
            return Err(AbstractionFailure::Cancelled.into());
        }
        let (_, model) = crate::query::branch_model(tx, branch, arm).await?;
        let checked = check::contract(contract, &model.definitions, &model.scopes)?;
        let interval = crate::query::point_interval(at)?;
        let (impact, _) = impact(tx, branch, arm, contract, at).await?;
        admission.require_access(&impact)?;
        authorization::recheck(tx, admission, &tx.now().await?).await?;
        let mut dependencies_current = true;
        for (dependencies, scope) in
            std::iter::once((contract.read_dependencies.clone(), &contract.scope)).chain(
                contract
                    .binding_map
                    .bindings
                    .iter()
                    .map(|binding| (dependencies(binding), &binding.inverse_scope)),
            )
        {
            if let Err(error) = crate::facts::support::recheck_dependencies_in_model(
                tx,
                &dependencies,
                &model,
                scope,
                &interval,
                at,
            )
            .await
            {
                if matches!(
                    crate::facts::support::provenance_failure(&error),
                    world_protocol::provenance::ProvenanceFailure::Commit { .. }
                ) {
                    return Err(error.into());
                }
                dependencies_current = false;
            }
        }
        let mut cells = Vec::with_capacity(contract.binding_map.bindings.len());
        let mut observations = Vec::with_capacity(contract.binding_map.bindings.len());
        let mut receipts = Vec::new();
        for binding in &contract.binding_map.bindings {
            budget
                .charge(world_protocol::budget::BudgetDimension::Steps, 1)
                .map_err(|_| AbstractionFailure::BudgetExceeded)?;
            if cancel.is_cancelled() {
                return Err(AbstractionFailure::Cancelled.into());
            }
            let mut evidence = binding.evidence.clone();
            evidence.sort();
            evidence.dedup();
            if !evidence.is_empty() {
                crate::facts::assertions::require_evidence(
                    tx,
                    admission,
                    &evidence,
                    &binding.inverse_scope,
                    Some(&interval),
                    at,
                )
                .await?;
            }
            let cell = if let Some((subject, type_ref, _)) = subject_query(contract, binding, &model)? {
                let observed = crate::query::branch_subject_in_transaction(
                    tx,
                    admission,
                    branch,
                    arm,
                    &subject,
                    &type_ref,
                    &binding.inverse_scope,
                    at,
                    budget,
                    cancel,
                    read_mode,
                    known_at,
                )
                .await?;
                Some(if observed {
                    Cell::Known {
                        value: match subject {
                            SubjectRef::Object { id } => Value::Object { id },
                            SubjectRef::Relation { id } => Value::Relation { id },
                        },
                    }
                } else {
                    Cell::Unknown {
                        reason: UnknownReason::NotObserved,
                    }
                })
            } else {
                if let BindingTarget::State { reference } = &binding.target {
                    if !crate::extensions::migration::read_exact_state_in_transaction(tx, reference)
                        .await?
                    {
                        return Err(AbstractionFailure::BasisChanged.into());
                    }
                }
                None
            };
            cells.push(cell);
            observations.push(BindingObservation {
                binding: binding.clone(),
                original: None,
                mapped: None,
                guard: None,
                inverse: None,
                inverse_matches: None,
            });
        }
        let mut concrete: BTreeMap<_, _> = contract
            .parameters
            .iter()
            .map(|parameter| {
                (
                    parameter.id.clone(),
                    Cell::Unknown {
                        reason: UnknownReason::NotObserved,
                    },
                )
            })
            .collect();
        for id in &checked.parameter_order {
            for (index, binding) in contract
                .binding_map
                .bindings
                .iter()
                .enumerate()
                .filter(|(_, binding)| binding.parameter_id.as_ref() == Some(id))
            {
                if let BindingTarget::Expression { expression } = &binding.target {
                    cells[index] = Some(
                        value(
                            tx,
                            admission,
                            branch,
                            arm,
                            contract,
                            &checked,
                            &concrete,
                            expression,
                            vec![
                                "bindingMap".into(),
                                "bindings".into(),
                                index.to_string(),
                                "target".into(),
                                "expression".into(),
                            ],
                            budget,
                            cancel,
                            at,
                            &mut receipts,
                            read_mode,
                            known_at,
                        )
                        .await?,
                    );
                }
                let slot = contract
                    .slots
                    .iter()
                    .find(|slot| slot.id == binding.slot_id)
                    .ok_or(AbstractionFailure::BasisChanged)?;
                if let Some(cell) = &mut cells[index] {
                    check_cell(
                        tx, admission, branch, arm, slot, binding, cell, &model, at, budget, cancel,
                        read_mode, known_at,
                    )
                    .await?;
                }
            }
            parameters(contract, &cells, &mut concrete, id)?;
        }
        for (index, binding) in contract
            .binding_map
            .bindings
            .iter()
            .enumerate()
            .filter(|(_, binding)| binding.parameter_id.is_none())
        {
            if let BindingTarget::Expression { expression } = &binding.target {
                cells[index] = Some(
                    value(
                        tx,
                        admission,
                        branch,
                        arm,
                        contract,
                        &checked,
                        &concrete,
                        expression,
                        vec![
                            "bindingMap".into(),
                            "bindings".into(),
                            index.to_string(),
                            "target".into(),
                            "expression".into(),
                        ],
                        budget,
                        cancel,
                        at,
                        &mut receipts,
                        read_mode,
                        known_at,
                    )
                    .await?,
                );
            }
        }
        for (index, binding) in contract
            .binding_map
            .bindings
            .iter()
            .enumerate()
            .filter(|(_, binding)| binding.parameter_id.is_none())
        {
            let slot = contract
                .slots
                .iter()
                .find(|slot| slot.id == binding.slot_id)
                .ok_or(AbstractionFailure::BasisChanged)?;
            if let Some(cell) = &mut cells[index] {
                check_cell(
                    tx, admission, branch, arm, slot, binding, cell, &model, at, budget, cancel,
                    read_mode, known_at,
                )
                .await?;
            }
        }
        // A declared fixture parameter is an assertion about concrete input, not a replacement for the mapping.
        if fixture
            .iter()
            .any(|(id, expected)| concrete.get(id) != Some(expected))
        {
            return Err(crate::query::QueryError::from(
                world_protocol::query::QueryFailure::InvalidQuery {
                    field: world_protocol::failure::FieldPath(vec![
                        "fixture".into(),
                        "concreteParameters".into(),
                    ]),
                },
            )
            .into());
        }
        let originals = cells.clone();
        let mut reason = if dependencies_current {
            TruthValue::True
        } else {
            TruthValue::Unknown
        };
        for cell in cells.iter().flatten() {
            if reason == TruthValue::True {
                reason = unavailable(cell);
            }
        }
        for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
            observations[index].original = originals[index].clone();
            if let Some(guard) = &binding.guard {
                let truth = crate::query::truth_value(
                    &value(
                        tx,
                        admission,
                        branch,
                        arm,
                        contract,
                        &checked,
                        &concrete,
                        guard,
                        vec![
                            "bindingMap".into(),
                            "bindings".into(),
                            index.to_string(),
                            "guard".into(),
                        ],
                        budget,
                        cancel,
                        at,
                        &mut receipts,
                        read_mode,
                        known_at,
                    )
                    .await?,
                )?;
                observations[index].guard = Some(truth);
                if reason == TruthValue::True {
                    reason = truth;
                }
            }
        }
        if reason == TruthValue::True {
            for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
                if let Some(transform) = &binding.transform {
                    let mut cell = value(
                        tx,
                        admission,
                        branch,
                        arm,
                        contract,
                        &checked,
                        &concrete,
                        transform,
                        vec![
                            "bindingMap".into(),
                            "bindings".into(),
                            index.to_string(),
                            "transform".into(),
                        ],
                        budget,
                        cancel,
                        at,
                        &mut receipts,
                        read_mode,
                        known_at,
                    )
                    .await?;
                    let slot = contract
                        .slots
                        .iter()
                        .find(|slot| slot.id == binding.slot_id)
                        .ok_or(AbstractionFailure::BasisChanged)?;
                    check_cell(
                        tx, admission, branch, arm, slot, binding, &mut cell, &model, at, budget,
                        cancel, read_mode, known_at,
                    )
                    .await?;
                    if reason == TruthValue::True {
                        reason = unavailable(&cell);
                    }
                    cells[index] = Some(cell);
                }
            }
        }
        let mut mapped = concrete.clone();
        for parameter in &contract.parameters {
            parameters(contract, &cells, &mut mapped, &parameter.id)?;
        }
        for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
            observations[index].mapped = cells[index].clone();
            if reason == TruthValue::True {
                if let Some(inverse) = &binding.inverse_transform {
                    let mut inverted = value(
                        tx,
                        admission,
                        branch,
                        arm,
                        contract,
                        &checked,
                        &mapped,
                        inverse,
                        vec![
                            "bindingMap".into(),
                            "bindings".into(),
                            index.to_string(),
                            "inverseTransform".into(),
                        ],
                        budget,
                        cancel,
                        at,
                        &mut receipts,
                        read_mode,
                        known_at,
                    )
                    .await?;
                    let slot = contract
                        .slots
                        .iter()
                        .find(|slot| slot.id == binding.slot_id)
                        .ok_or(AbstractionFailure::BasisChanged)?;
                    check_cell(
                        tx,
                        admission,
                        branch,
                        arm,
                        slot,
                        binding,
                        &mut inverted,
                        &model,
                        at,
                        budget,
                        cancel,
                        read_mode,
                        known_at,
                    )
                    .await?;
                    let matches = originals[index].as_ref() == Some(&inverted);
                    observations[index].inverse_matches = Some(matches);
                    if !matches {
                        reason = match unavailable(&inverted) {
                            TruthValue::True => TruthValue::False,
                            truth => truth,
                        };
                    }
                    observations[index].inverse = Some(inverted);
                }
            }
        }
        authorization::check_admitted_output(
            tx,
            admission,
            &impact,
            observations.len() as u64,
            &tx.now().await?,
        )
        .await?;
        Ok(BindingExecution {
            concrete_parameters: concrete,
            parameters: mapped,
            observations,
            reason,
            fallback: (reason != TruthValue::True).then(|| contract.fallback.clone()),
            read_receipts: receipts,
        })
    })
}
