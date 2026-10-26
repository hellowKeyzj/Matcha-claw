use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    definitions::{
        Definition, DefinitionBody, DefinitionFailure, DefinitionFieldReason as Reason,
        DefinitionKind, DefinitionLifecycle, Scope,
    },
    facts::RoleBinding,
    failure::FieldPath,
    ids::{DefinitionId, DefinitionRef, ObjectId, ScopeId},
    time::ValidTime,
    value::Value,
};

use super::{
    content_digest, definition_references, invalid, references::stable_type_references,
    scope_contains, valid_time_contains, validate_value,
};

type Model = Definition<DefinitionBody>;

pub(crate) struct DefinitionValidator<'a> {
    index: BTreeMap<DefinitionRef, &'a Model>,
    scopes: &'a [Scope],
}

impl<'a> DefinitionValidator<'a> {
    pub(crate) fn new(
        candidates: &'a [Model],
        scopes: &'a [Scope],
    ) -> Result<Self, DefinitionFailure> {
        let mut index = BTreeMap::new();
        for candidate in candidates {
            if index
                .insert(candidate.reference.clone(), candidate)
                .is_some()
            {
                return Err(DefinitionFailure::ImmutableRevision {
                    reference: candidate.reference.clone(),
                });
            }
        }
        Ok(Self { index, scopes })
    }

    pub(crate) fn validate(&self, definition: &Model) -> Result<(), DefinitionFailure> {
        match self.index.get(&definition.reference) {
            Some(existing) if *existing == definition => {
                validate_indexed(definition, &self.index, self.scopes, true)
            }
            Some(_) => Err(DefinitionFailure::ImmutableRevision {
                reference: definition.reference.clone(),
            }),
            None => Err(DefinitionFailure::MissingReference {
                reference: definition.reference.clone(),
            }),
        }
    }
}

pub(crate) fn validate_definition<'a>(
    definition: &'a Model,
    candidates: &'a [Model],
    scopes: &'a [Scope],
) -> Result<(), DefinitionFailure> {
    let mut validator = DefinitionValidator::new(candidates, scopes)?;
    if let Some(existing) = validator
        .index
        .insert(definition.reference.clone(), definition)
    {
        if existing != definition {
            return Err(DefinitionFailure::ImmutableRevision {
                reference: definition.reference.clone(),
            });
        }
    }
    validator.validate(definition)
}

/// Canonical model integrity only; this cannot mint typed IR or execution authority.
pub(crate) fn validate_structure(definitions: &[Model], scopes: &[Scope]) -> Result<(), DefinitionFailure> {
    let validator = DefinitionValidator::new(definitions, scopes)?;
    for definition in definitions {
        validate_indexed(definition, &validator.index, scopes, false)?;
    }
    Ok(())
}

fn validate_indexed(
    definition: &Model,
    index: &BTreeMap<DefinitionRef, &Model>,
    scopes: &[Scope],
    typed: bool,
) -> Result<(), DefinitionFailure> {
    if definition.reference.revision.0 == 0 || definition.reference.revision.0 > i64::MAX as u64 {
        return Err(invalid(
            &["reference".into(), "revision".into()],
            Reason::IncompleteContract,
        ));
    }
    if definition
        .valid_time
        .to
        .as_ref()
        .is_some_and(|to| to <= &definition.valid_time.from)
    {
        return Err(invalid(&["validTime".into()], Reason::InvalidInterval));
    }
    if !scope_contains(
        &definition.reference.world,
        &definition.scope,
        &definition.scope,
        scopes,
    )? {
        return Err(DefinitionFailure::ScopeConflict {
            definitions: vec![definition.reference.clone()],
        });
    }
    super::shape::validate_body(&definition.body)?;
    let dependencies: BTreeSet<_> = definition.dependencies.iter().collect();
    if dependencies.len() != definition.dependencies.len() {
        return Err(invalid(&["dependencies".into()], Reason::Duplicate));
    }
    for reference in &definition.dependencies {
        check_reference(definition, reference, &index, scopes)?;
    }
    let scope = scopes
        .iter()
        .find(|scope| scope.world == definition.reference.world && scope.id == definition.scope)
        .ok_or_else(|| DefinitionFailure::ScopeConflict {
            definitions: vec![definition.reference.clone()],
        })?;
    let mut used_references = definition_references(&definition.body);
    super::references::visit_expression(&scope.predicate, &mut |reference| {
        used_references.push(reference.clone())
    });
    for reference in used_references {
        if reference != definition.reference && !dependencies.contains(&reference) {
            return Err(invalid(
                &["dependencies".into(), reference.id.to_string()],
                Reason::IncompleteContract,
            ));
        }
    }
    for (id, expected) in stable_type_references(&definition.body) {
        let matching: Vec<_> = dependencies
            .iter()
            .filter(|reference| reference.id == id)
            .collect();
        if matching.len() != 1 {
            return Err(invalid(
                &["dependencies".into(), id.to_string()],
                Reason::IncompleteContract,
            ));
        }
        let reference = *matching[0];
        let target = index
            .get(reference)
            .ok_or_else(|| DefinitionFailure::MissingReference {
                reference: reference.clone(),
            })?;
        if typed {
            if let Some(expected) = expected {
                require_kind(target, expected)?;
            }
        }
    }
    if typed {
        check_body_kinds(definition, &index)?;
    }
    match &definition.body {
        DefinitionBody::SourceBinding(body) => {
            if body.scope != definition.scope
                || body.schema.world != definition.reference.world
                || body.mapping.world != definition.reference.world
                || body.identity_rule.world != definition.reference.world
            {
                return Err(invalid(
                    &["sourceBinding".into()],
                    Reason::IncompleteContract,
                ));
            }
        }
        DefinitionBody::PolicyBinding(body) if body.scope != definition.scope => {
            return Err(DefinitionFailure::ScopeConflict {
                definitions: vec![definition.reference.clone()],
            });
        }
        DefinitionBody::ActionContract(body) => {
            for target in &body.targets {
                if !scope_contains(
                    &definition.reference.world,
                    &target.scope,
                    &definition.scope,
                    scopes,
                )? {
                    return Err(DefinitionFailure::ScopeConflict {
                        definitions: vec![definition.reference.clone(), target.type_ref.clone()],
                    });
                }
            }
        }
        _ => {}
    }
    let mut evidence = BTreeSet::new();
    for reference in &definition.evidence {
        if reference.world != definition.reference.world || reference.revision.0 == 0 {
            return Err(invalid(
                &["evidence".into(), reference.id.to_string()],
                Reason::IncompleteContract,
            ));
        }
        if !evidence.insert(reference) {
            return Err(invalid(&["evidence".into()], Reason::Duplicate));
        }
    }
    if let Some(previous) = &definition.previous_ref {
        if previous.world != definition.reference.world
            || previous.id != definition.reference.id
            || previous.revision >= definition.reference.revision
        {
            return Err(DefinitionFailure::LifecycleConflict);
        }
        if let Some(old) = index.get(previous) {
            super::lifecycle::validate_revision(Some(old), definition)?;
        }
    } else {
        super::lifecycle::validate_revision(None, definition)?;
    }
    super::lifecycle::validate_lifecycle(definition)?;
    match &definition.lifecycle {
        DefinitionLifecycle::Available => {}
        DefinitionLifecycle::Deprecated { replacements, .. }
        | DefinitionLifecycle::Split { replacements, .. } => {
            for replacement in replacements {
                if replacement.world != definition.reference.world {
                    return Err(DefinitionFailure::CrossWorldReference {
                        reference: replacement.clone(),
                    });
                }
                let target =
                    index
                        .get(replacement)
                        .ok_or_else(|| DefinitionFailure::MissingReference {
                            reference: replacement.clone(),
                        })?;
                if replacement.id == definition.reference.id
                    || target.body.kind() != definition.body.kind()
                    || matches!((&target.body, &definition.body),
                        (DefinitionBody::Extension(target), DefinitionBody::Extension(next))
                            if target.name != next.name || target.contract != next.contract)
                    || !matches!(target.lifecycle, DefinitionLifecycle::Available)
                {
                    return Err(DefinitionFailure::LifecycleConflict);
                }
            }
        }
    }
    if content_digest(definition)? != definition.content_digest {
        return Err(invalid(
            &["contentDigest".into()],
            Reason::IncompleteContract,
        ));
    }
    Ok(())
}

fn check_reference(
    definition: &Model,
    reference: &DefinitionRef,
    index: &BTreeMap<DefinitionRef, &Model>,
    scopes: &[Scope],
) -> Result<(), DefinitionFailure> {
    if reference.world != definition.reference.world {
        return Err(DefinitionFailure::CrossWorldReference {
            reference: reference.clone(),
        });
    }
    let target = index
        .get(reference)
        .ok_or_else(|| DefinitionFailure::MissingReference {
            reference: reference.clone(),
        })?;
    if !valid_time_contains(&target.valid_time, &definition.valid_time) {
        return Err(DefinitionFailure::ValidTimeConflict {
            definitions: vec![definition.reference.clone(), reference.clone()],
        });
    }
    if !scope_contains(&reference.world, &target.scope, &definition.scope, scopes)? {
        return Err(DefinitionFailure::ScopeConflict {
            definitions: vec![definition.reference.clone(), reference.clone()],
        });
    }
    if let DefinitionLifecycle::Deprecated { effective_at, .. }
    | DefinitionLifecycle::Split { effective_at, .. } = &target.lifecycle
    {
        if definition
            .valid_time
            .to
            .as_ref()
            .is_none_or(|to| to > effective_at)
        {
            return Err(DefinitionFailure::DeprecatedReference {
                reference: reference.clone(),
            });
        }
    }
    Ok(())
}

fn require_kind(definition: &Model, expected: DefinitionKind) -> Result<(), DefinitionFailure> {
    let actual = definition.body.kind();
    if actual == expected {
        Ok(())
    } else {
        Err(DefinitionFailure::WrongKind {
            reference: definition.reference.clone(),
            expected,
            actual,
        })
    }
}

fn check_body_kinds(
    definition: &Model,
    index: &BTreeMap<DefinitionRef, &Model>,
) -> Result<(), DefinitionFailure> {
    let require = |reference: &DefinitionRef, expected| {
        let target = index
            .get(reference)
            .ok_or_else(|| DefinitionFailure::MissingReference {
                reference: reference.clone(),
            })?;
        require_kind(target, expected)
    };
    use DefinitionKind::*;
    match &definition.body {
        DefinitionBody::ObjectType(body) => {
            for reference in &body.properties {
                require(reference, Property)?;
            }
            for reference in &body.interfaces {
                require(reference, Facet)?;
            }
            for reference in &body.source_bindings {
                require(reference, SourceBinding)?;
            }
            if let Some(reference) = &body.state_model {
                require(reference, StateModel)?;
            }
            if let Some(reference) = &body.identity_rule {
                require(reference, Function)?;
            }
        }
        DefinitionBody::Property(body) => {
            for id in &body.domain {
                let target = definition
                    .dependencies
                    .iter()
                    .find(|reference| &reference.id == id)
                    .and_then(|reference| index.get(reference));
                if let Some(target) = target {
                    if !matches!(
                        target.body,
                        DefinitionBody::ObjectType(_) | DefinitionBody::RelationType(_)
                    ) {
                        return Err(DefinitionFailure::TypeMismatch {
                            field: FieldPath(vec!["domain".into(), id.to_string()]),
                        });
                    }
                }
            }
        }
        DefinitionBody::RelationType(body) => {
            for role in &body.roles {
                require(&role.target_type, ObjectType)?;
            }
            for reference in &body.properties {
                require(reference, Property)?;
            }
        }
        DefinitionBody::Rule(body) => match &body.conclusion {
            world_protocol::definitions::RuleConclusion::Attribute { property, .. } => {
                require(property, Property)?
            }
            world_protocol::definitions::RuleConclusion::Relation {
                relation_type,
                roles,
                ..
            } => {
                require(relation_type, RelationType)?;
                let target = index.get(relation_type).ok_or_else(|| {
                    DefinitionFailure::MissingReference {
                        reference: relation_type.clone(),
                    }
                })?;
                let DefinitionBody::RelationType(relation) = &target.body else {
                    unreachable!("kind checked");
                };
                if roles.len() != relation.roles.len()
                    || roles.iter().any(|role| {
                        !relation
                            .roles
                            .iter()
                            .any(|declared| declared.id == role.role)
                    })
                {
                    return Err(DefinitionFailure::TypeMismatch {
                        field: FieldPath(vec!["conclusion".into(), "roles".into()]),
                    });
                }
            }
        },
        DefinitionBody::StateModel(body) => {
            require(&body.property, Property)?;
            for transition in &body.transitions {
                if let Some(action) = &transition.action {
                    require(action, ActionContract)?;
                }
            }
        }
        DefinitionBody::ActionContract(body) => {
            require(&body.source_operation.binding, SourceBinding)?;
            if let Some(binding) = index.get(&body.source_operation.binding) {
                if let DefinitionBody::SourceBinding(binding) = &binding.body {
                    if binding.resource != body.source_operation.resource {
                        return Err(invalid(
                            &["sourceOperation".into(), "resource".into()],
                            Reason::IncompleteContract,
                        ));
                    }
                }
            }
            for reference in body.reads.iter().chain(body.writes.iter()) {
                require(reference, Property)?;
            }
            if let Some(compensation) = &body.compensation {
                require(&compensation.action, ActionContract)?;
            }
            for target in &body.targets {
                let target = index.get(&target.type_ref).ok_or_else(|| {
                    DefinitionFailure::MissingReference {
                        reference: target.type_ref.clone(),
                    }
                })?;
                if !matches!(
                    target.body,
                    DefinitionBody::ObjectType(_) | DefinitionBody::RelationType(_)
                ) {
                    return Err(DefinitionFailure::TypeMismatch {
                        field: FieldPath(vec!["targets".into()]),
                    });
                }
            }
        }
        DefinitionBody::Strategy(body) => {
            if let Some(fallback) = &body.fallback {
                require(fallback, Strategy)?;
            }
            for step in &body.steps {
                match &step.operation {
                    world_protocol::learning::StrategyOperation::Action { action, .. } => {
                        require(action, ActionContract)?
                    }
                    world_protocol::learning::StrategyOperation::Function { function, .. } => {
                        require(function, Function)?
                    }
                    _ => {}
                }
            }
        }
        DefinitionBody::SourceBinding(body) => {
            for mapping in &body.field_mapping {
                require(&mapping.property, Property)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_attribute(
    definition: &Model,
    subject_type: &DefinitionId,
    scope: &ScopeId,
    valid_time: &ValidTime,
    value: &Value,
    scopes: &[Scope],
) -> Result<(), DefinitionFailure> {
    require_kind(definition, DefinitionKind::Property)?;
    let DefinitionBody::Property(property) = &definition.body else {
        unreachable!()
    };
    if !property.domain.contains(subject_type) {
        return Err(DefinitionFailure::TypeMismatch {
            field: FieldPath(vec!["subject".into(), "typeId".into()]),
        });
    }
    validate_applicability(definition, scope, valid_time, scopes)?;
    validate_value(&property.value_type, property.nullable, value)
}

pub(crate) fn validate_relation(
    definition: &Model,
    scope: &ScopeId,
    valid_time: &ValidTime,
    roles: &[RoleBinding],
    object_types: &[(ObjectId, DefinitionId)],
    scopes: &[Scope],
) -> Result<(), DefinitionFailure> {
    require_kind(definition, DefinitionKind::RelationType)?;
    validate_applicability(definition, scope, valid_time, scopes)?;
    let DefinitionBody::RelationType(relation) = &definition.body else {
        unreachable!()
    };
    let mut pairs = BTreeSet::new();
    for binding in roles {
        let role = relation
            .roles
            .iter()
            .find(|role| role.id == binding.role)
            .ok_or_else(|| {
                invalid(
                    &["roles".into(), binding.role.to_string()],
                    Reason::InvalidRole,
                )
            })?;
        if !pairs.insert((&binding.role, &binding.object_id)) {
            return Err(invalid(&["roles".into()], Reason::Duplicate));
        }
        let types: Vec<_> = object_types
            .iter()
            .filter(|(id, _)| id == &binding.object_id)
            .map(|(_, type_id)| type_id)
            .collect();
        if types.len() != 1 || types[0] != &role.target_type.id {
            return Err(DefinitionFailure::TypeMismatch {
                field: FieldPath(vec![
                    "roles".into(),
                    binding.role.to_string(),
                    binding.object_id.to_string(),
                ]),
            });
        }
    }
    for role in &relation.roles {
        let count = roles
            .iter()
            .filter(|binding| binding.role == role.id)
            .count() as u64;
        if count < role.cardinality.minimum as u64
            || role
                .cardinality
                .maximum
                .is_some_and(|maximum| count > maximum as u64)
        {
            return Err(DefinitionFailure::InvalidCardinality {
                field: FieldPath(vec!["roles".into(), role.id.to_string()]),
            });
        }
    }
    Ok(())
}

pub(crate) fn validate_applicability(
    definition: &Model,
    scope: &ScopeId,
    valid_time: &ValidTime,
    scopes: &[Scope],
) -> Result<(), DefinitionFailure> {
    if !valid_time_contains(&definition.valid_time, valid_time) {
        return Err(DefinitionFailure::ValidTimeConflict {
            definitions: vec![definition.reference.clone()],
        });
    }
    if !scope_contains(
        &definition.reference.world,
        &definition.scope,
        scope,
        scopes,
    )? {
        return Err(DefinitionFailure::ScopeConflict {
            definitions: vec![definition.reference.clone()],
        });
    }
    if let DefinitionLifecycle::Deprecated { effective_at, .. }
    | DefinitionLifecycle::Split { effective_at, .. } = &definition.lifecycle
    {
        if valid_time.to.as_ref().is_none_or(|to| to > effective_at) {
            return Err(DefinitionFailure::DeprecatedReference {
                reference: definition.reference.clone(),
            });
        }
    }
    Ok(())
}
