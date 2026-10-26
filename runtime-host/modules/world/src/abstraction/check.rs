use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, BindingTarget, SlotRole},
    compiler::{DefinitionIr, ExpressionAnnotation}, definitions::{Definition, DefinitionBody, Scope},
    expression::{Effect, ExpressionIr}, failure::FieldPath, ids::{DefinitionRef, ParameterId}, value::ValueType,
};
use super::Error;

type Model = Definition<DefinitionBody>;
pub(crate) struct Checked {
    pub annotations: Vec<ExpressionAnnotation>, pub functions: BTreeMap<DefinitionRef, DefinitionIr>,
    pub parameter_order: Vec<ParameterId>, pub owner: DefinitionRef,
}

pub(crate) fn contract(contract: &AbstractionContract, definitions: &[Model], scopes: &[Scope]) -> Result<Checked, Error> {
    let mut slots = BTreeSet::new();
    for slot in &contract.slots {
        crate::definitions::validate_value_type(&slot.value_type).map_err(|failure| Error::Compile(world_protocol::compiler::CompileFailure::Definition { failure }))?;
        if !slots.insert(&slot.id) || slot.cardinality.maximum.is_some_and(|maximum| maximum < slot.cardinality.minimum) {
            return Err(AbstractionFailure::TypeMismatch { slot_id: slot.id.clone() }.into());
        }
        let bindings: Vec<_> = contract.binding_map.bindings.iter().filter(|binding| binding.slot_id == slot.id).collect();
        if bindings.len() < slot.cardinality.minimum as usize || slot.cardinality.maximum.is_some_and(|maximum| bindings.len() > maximum as usize) {
            return Err(AbstractionFailure::SlotUnbound { slot_id: slot.id.clone() }.into());
        }
        for (index, binding) in bindings.iter().enumerate() {
            if bindings[..index].iter().any(|previous| previous.target == binding.target) {
                return Err(AbstractionFailure::DuplicateBinding { slot_id: slot.id.clone() }.into());
            }
        }
    }
    let mut mapped_parameters = BTreeMap::<ParameterId, &world_protocol::ids::AbstractionSlotId>::new();
    for binding in &contract.binding_map.bindings {
        let slot = contract.slots.iter().find(|slot| slot.id == binding.slot_id).ok_or_else(|| AbstractionFailure::SlotUnbound { slot_id: binding.slot_id.clone() })?;
        let mismatch = || AbstractionFailure::TypeMismatch { slot_id: slot.id.clone() };
        match &binding.target {
            BindingTarget::Object { .. } if slot.role == SlotRole::Object && matches!(slot.value_type, ValueType::Object { .. }) => {},
            BindingTarget::Relation { .. } if slot.role == SlotRole::Relation && matches!(slot.value_type, ValueType::Relation { .. }) => {},
            BindingTarget::Expression { .. } if matches!(slot.role, SlotRole::Input | SlotRole::Output) => {},
            BindingTarget::Property { definition } => {
                let target = definitions.iter().find(|target| target.reference == *definition).ok_or_else(mismatch)?;
                if !matches!(&target.body, DefinitionBody::Property(property) if property.value_type == slot.value_type) { return Err(mismatch().into()); }
            },
            BindingTarget::Action { definition } if slot.role == SlotRole::Action => {
                if !definitions.iter().any(|target| target.reference == *definition && matches!(target.body, DefinitionBody::ActionContract(_))) { return Err(mismatch().into()); }
            },
            BindingTarget::State { .. } if slot.role == SlotRole::State => {},
            _ => return Err(mismatch().into()),
        }
        if let Some(id) = &binding.parameter_id {
            if matches!(binding.target, BindingTarget::Action { .. } | BindingTarget::State { .. } | BindingTarget::Property { .. }) { return Err(mismatch().into()); }
            let parameter = contract.parameters.iter().find(|parameter| &parameter.id == id).ok_or_else(mismatch)?;
            let expected = if slot.cardinality.maximum == Some(1) { slot.value_type.clone() }
                else { ValueType::List { element: Box::new(slot.value_type.clone()), max_items: slot.cardinality.maximum.unwrap_or(65_536) } };
            if parameter.value_type != expected || mapped_parameters.insert(id.clone(), &slot.id).is_some_and(|previous| previous != &slot.id) { return Err(mismatch().into()); }
        }
        if binding.inverse_transform.is_some() && binding.transform.is_none()
            || (binding.transform.is_some() || binding.inverse_transform.is_some()) && matches!(binding.target, BindingTarget::Action { .. } | BindingTarget::State { .. } | BindingTarget::Property { .. }) { return Err(mismatch().into()); }
    }
    if contract.parameters.iter().any(|parameter| !parameter.optional && !mapped_parameters.contains_key(&parameter.id)) {
        return Err(AbstractionFailure::EvidenceMissing.into());
    }
    for reference in &contract.applicable_actions {
        if !contract.original_definitions.contains(reference) || !definitions.iter().any(|target| target.reference == *reference && matches!(target.body, DefinitionBody::ActionContract(_))) {
            return Err(AbstractionFailure::BasisChanged.into());
        }
    }
    super::resolve::concrete_strategy(contract, definitions, scopes)?;
    let owners: Vec<_> = if let Some(strategy) = &contract.strategy {
        vec![definitions.iter().find(|definition| &definition.reference == strategy && matches!(definition.body, DefinitionBody::Strategy(_))).ok_or(AbstractionFailure::BasisChanged)?]
    } else {
        definitions.iter().filter(|definition| contract.original_definitions.contains(&definition.reference) && definition.scope == contract.scope).collect()
    };
    let mut last = None;
    for owner in owners {
        match expressions(contract, owner, definitions, scopes) { Ok(checked) => return Ok(checked), Err(error) => last = Some(error) }
    }
    Err(last.unwrap_or_else(|| AbstractionFailure::BasisChanged.into()))
}

fn expressions(contract: &AbstractionContract, owner: &Model, definitions: &[Model], scopes: &[Scope]) -> Result<Checked, Error> {
    let mut annotations = crate::compiler::check_plan(&contract.forward_plan, owner, definitions, scopes, &contract.parameters)?;
    for (name, expressions) in [("guard", std::slice::from_ref(&contract.guard)), ("assumptions", contract.assumptions.as_slice()), ("preservedInvariants", contract.preserved_invariants.as_slice())] {
        for (index, expression) in expressions.iter().enumerate() {
            let path = if name == "guard" { FieldPath(vec![name.into()]) } else { FieldPath(vec![name.into(), index.to_string()]) };
            annotations.extend(crate::compiler::check_guard(expression, owner, definitions, scopes, &contract.parameters, &path)?);
        }
    }
    for (index, binding) in contract.binding_map.bindings.iter().enumerate() {
        let slot = contract.slots.iter().find(|slot| slot.id == binding.slot_id).ok_or(AbstractionFailure::BasisChanged)?;
        let root = vec!["bindingMap".into(), "bindings".into(), index.to_string()];
        if let BindingTarget::Expression { expression } = &binding.target {
            let mut path = root.clone(); path.extend(["target".into(), "expression".into()]);
            annotations.extend(crate::compiler::check_value(expression, &slot.value_type, owner, definitions, scopes, &contract.parameters, &FieldPath(path))?);
        }
        for (name, expression) in [("transform", &binding.transform), ("inverseTransform", &binding.inverse_transform)] {
            if let Some(expression) = expression {
                let mut path = root.clone(); path.push(name.into());
                annotations.extend(crate::compiler::check_value(expression, &slot.value_type, owner, definitions, scopes, &contract.parameters, &FieldPath(path))?);
            }
        }
        if let Some(guard) = &binding.guard {
            let mut path = root; path.push("guard".into());
            annotations.extend(crate::compiler::check_guard(guard, owner, definitions, scopes, &contract.parameters, &FieldPath(path))?);
        }
    }
    if annotations.iter().any(|annotation| annotation.effects.contains(&Effect::ExternalWrite) || annotation.effects.contains(&Effect::Probabilistic)) {
        return Err(AbstractionFailure::GuardUnknown.into());
    }
    let mut functions = BTreeMap::new();
    for definition in definitions {
        if let DefinitionBody::Function(function) = &definition.body {
            let annotations = crate::compiler::check_value(&function.expression, &function.result_type, definition, definitions, scopes, &function.parameters, &FieldPath(vec!["expression".into()]))?;
            functions.insert(definition.reference.clone(), DefinitionIr { reference: definition.reference.clone(), body_hash: definition.content_digest.clone(), body: definition.body.clone(), scope: definition.scope.clone(), valid_time: definition.valid_time.clone(), annotations, policy_refs: Vec::new(), source_requirements: Vec::new() });
        }
    }
    let mut pending = BTreeMap::<ParameterId, BTreeSet<ParameterId>>::new();
    for parameter in &contract.parameters {
        let mut reads = BTreeSet::new();
        for binding in contract.binding_map.bindings.iter().filter(|binding| binding.parameter_id.as_ref() == Some(&parameter.id)) {
            if let BindingTarget::Expression { expression } = &binding.target { inputs(expression, &mut reads); }
        }
        pending.insert(parameter.id.clone(), reads);
    }
    let mut parameter_order = Vec::new();
    while !pending.is_empty() {
        let ready: Vec<_> = pending.iter().filter(|(_, reads)| reads.iter().all(|id| parameter_order.contains(id))).map(|(id, _)| id.clone()).collect();
        if ready.is_empty() { return Err(AbstractionFailure::BasisChanged.into()); }
        for id in ready { pending.remove(&id); parameter_order.push(id); }
    }
    Ok(Checked { annotations, functions, parameter_order, owner: owner.reference.clone() })
}

fn inputs(expression: &ExpressionIr, reads: &mut BTreeSet<ParameterId>) {
    let mut pending = vec![expression];
    while let Some(expression) = pending.pop() {
        match expression {
            ExpressionIr::Parameter { id } => { reads.insert(id.clone()); },
            ExpressionIr::Field { subject, .. } | ExpressionIr::Role { relation: subject, .. } | ExpressionIr::Aggregate { collection: subject, .. } => {
                if let Ok(id) = ParameterId::try_new(subject.as_str()) { reads.insert(id); }
                if let ExpressionIr::Aggregate { expression, .. } = expression { pending.push(expression); }
            },
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => pending.push(operand),
            ExpressionIr::Binary { left, right, .. } => pending.extend([left.as_ref(), right.as_ref()]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => pending.extend(terms),
            ExpressionIr::If { condition, then_value, else_value } => pending.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Call { arguments, .. } => pending.extend(arguments),
            ExpressionIr::Literal { .. } => {},
        }
    }
}
