use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    compiler::{CompileFailure, ExpressionAnnotation},
    definitions::{Definition, DefinitionBody, Scope},
    expression::ExpressionIr,
    failure::FieldPath,
    ids::{DefinitionId, SymbolId},
};

use super::{expression::Context, invalid};

/// Scope predicates inspect the supplied typed row; this path cannot fetch a source or grant authority.
pub(crate) fn check_scope(
    scope: &Scope, owner: &Definition<DefinitionBody>, definitions: &[Definition<DefinitionBody>], scopes: &[Scope],
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    if scope.world != owner.reference.world { return Err(CompileFailure::ScopeMismatch { definition: owner.reference.clone(), field: FieldPath(vec!["scope".into()]) }); }
    let index: BTreeMap<_, _> = definitions.iter().map(|definition| (definition.reference.clone(), definition)).collect();
    let mut context = Context::new(owner, &index, scopes);
    context.snapshot_fields = true;
    let mut symbols: BTreeMap<SymbolId, BTreeSet<DefinitionId>> = BTreeMap::new();
    let mut pending = vec![&scope.predicate];
    while let Some(expression) = pending.pop() {
        match expression {
            ExpressionIr::Field { subject, property } => {
                let property = context.resolve(property, &["predicate".into()])?;
                let DefinitionBody::Property(property) = &property.body else { return Err(invalid(&owner.reference, &["predicate".into()])); };
                let domain: BTreeSet<_> = property.domain.iter().cloned().collect();
                symbols.entry(subject.clone()).and_modify(|existing| existing.retain(|id| domain.contains(id))).or_insert(domain);
            }
            ExpressionIr::Role { relation, role } => {
                let domain: BTreeSet<_> = definitions.iter().filter(|definition| (definition.reference == owner.reference || owner.dependencies.contains(&definition.reference)) && match &definition.body {
                    DefinitionBody::RelationType(body) => body.roles.iter().any(|entry| &entry.id == role), _ => false,
                }).map(|definition| definition.reference.id.clone()).collect();
                symbols.entry(relation.clone()).and_modify(|existing| existing.retain(|id| domain.contains(id))).or_insert(domain);
            }
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => pending.push(operand),
            ExpressionIr::Binary { left, right, .. } => pending.extend([left.as_ref(), right.as_ref()]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => pending.extend(terms),
            ExpressionIr::If { condition, then_value, else_value } => pending.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Call { arguments, .. } => pending.extend(arguments),
            ExpressionIr::Aggregate { expression, .. } => pending.push(expression),
            _ => {}
        }
    }
    for (symbol, candidates) in symbols {
        if candidates.len() != 1 { return Err(invalid(&owner.reference, &["predicate".into(), symbol.to_string()])); }
        let id = candidates.first().ok_or(CompileFailure::InternalFault)?;
        let target = if &owner.reference.id == id { owner } else { context.stable(id, &["predicate".into()])? };
        context.bind(&symbol, &target.reference, false, &["predicate".into()])?;
    }
    let inferred = context.guard(&scope.predicate, &["predicate".into()], true)?;
    if let Some(effect) = inferred.effects.first() { return Err(CompileFailure::EffectViolation {
        definition: owner.reference.clone(), field: FieldPath(vec!["predicate".into()]), effect: *effect,
    }); }
    Ok(context.annotations)
}
