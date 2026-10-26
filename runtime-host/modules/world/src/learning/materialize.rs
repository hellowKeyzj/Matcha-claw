mod lineage;
pub(crate) use lineage::{materialize_current, materialize_frozen};

use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    definitions::{Definition, DefinitionBody, DefinitionFailure, DefinitionLifecycle, Scope},
    ids::{DefinitionId, DefinitionRef, Revision, WorldRef},
    learning::SemanticOperation,
};

use super::{Error, invalid};

type Model = Definition<DefinitionBody>;

/// A derived model, never an active-head write or evidence/identity admission.
pub(crate) struct Materialized {
    definitions: Vec<Model>,
    changed: Vec<Model>,
    metadata: Vec<SemanticOperation>,
    references: BTreeMap<DefinitionRef, DefinitionRef>,
}

impl Materialized {
    pub(crate) fn definitions(&self) -> &[Model] {
        &self.definitions
    }
    pub(crate) fn changed(&self) -> &[Model] {
        &self.changed
    }
    pub(crate) fn metadata(&self) -> &[SemanticOperation] {
        &self.metadata
    }
    pub(crate) fn reference(&self, reference: &DefinitionRef) -> DefinitionRef {
        self.references.get(reference).unwrap_or(reference).clone()
    }
}

pub(crate) fn materialize(
    world: &WorldRef,
    base: &[Model],
    scopes: &[Scope],
    operations: &[SemanticOperation],
) -> Result<Materialized, Error> {
    if operations.is_empty() || operations.len() > 4096 {
        return Err(invalid(0, "operations"));
    }
    let mut model = BTreeMap::new();
    for definition in base {
        if definition.reference.world != *world
            || model
                .insert(definition.reference.id.clone(), definition.clone())
                .is_some()
        {
            return Err(invalid(0, "base"));
        }
    }
    let mut touched = BTreeSet::new();
    let mut changed = Vec::new();
    let mut metadata = Vec::new();
    for (index, operation) in operations.iter().enumerate() {
        match operation {
            SemanticOperation::NoOp { reason } => {
                if reason.trim().is_empty() {
                    return Err(invalid(index, "reason"));
                }
            }
            SemanticOperation::CreateDefinition { definition } => {
                if model.contains_key(&definition.reference.id) {
                    return Err(invalid(index, "definition.reference"));
                }
                crate::definitions::validate_revision(None, definition)?;
                put(
                    world,
                    &mut model,
                    &mut touched,
                    &mut changed,
                    definition.as_ref().clone(),
                    index,
                )?;
            }
            SemanticOperation::RefineDefinition {
                previous,
                replacement,
            }
            | SemanticOperation::SupersedeRule {
                previous,
                replacement,
            } => {
                let old = exact(&model, previous, index)?;
                crate::definitions::validate_revision(Some(old), replacement)?;
                if matches!(operation, SemanticOperation::SupersedeRule { .. })
                    && (!matches!(old.body, DefinitionBody::Rule(_))
                        || !matches!(replacement.body, DefinitionBody::Rule(_)))
                {
                    return Err(invalid(index, "replacement.body"));
                }
                if old.body == replacement.body
                    && old.scope == replacement.scope
                    && old.valid_time == replacement.valid_time
                    && old.dependencies == replacement.dependencies
                    && old.lifecycle == replacement.lifecycle
                {
                    return Err(invalid(index, "replacement.unchanged"));
                }
                put(
                    world,
                    &mut model,
                    &mut touched,
                    &mut changed,
                    replacement.as_ref().clone(),
                    index,
                )?;
            }
            SemanticOperation::ScopeDefinition {
                previous,
                scope,
                valid_time,
            } => {
                let old = exact(&model, previous, index)?;
                if old.scope == *scope && old.valid_time == *valid_time {
                    return Err(invalid(index, "scope.unchanged"));
                }
                let mut next = successor(old)?;
                next.scope = scope.clone();
                next.valid_time = valid_time.clone();
                seal(&mut next)?;
                crate::definitions::validate_revision(Some(old), &next)?;
                put(world, &mut model, &mut touched, &mut changed, next, index)?;
            }
            SemanticOperation::DeprecateDefinition {
                previous,
                replacements,
                reason,
                effective_at,
            } => {
                let old = exact(&model, previous, index)?;
                let mut next = successor(old)?;
                next.lifecycle = DefinitionLifecycle::Deprecated {
                    replacements: replacements.clone(),
                    reason: reason.clone(),
                    effective_at: effective_at.clone(),
                };
                seal(&mut next)?;
                crate::definitions::validate_revision(Some(old), &next)?;
                put(world, &mut model, &mut touched, &mut changed, next, index)?;
            }
            SemanticOperation::SplitDefinition {
                previous,
                replacements,
                partition,
            } => {
                let old = exact(&model, previous, index)?.clone();
                if replacements.len() < 2 || partition.len() != replacements.len() {
                    return Err(invalid(index, "partition"));
                }
                let ids: BTreeSet<_> = replacements
                    .iter()
                    .map(|definition| &definition.reference.id)
                    .collect();
                let partitions: BTreeSet<_> =
                    partition.iter().map(|part| &part.replacement).collect();
                if ids.len() != replacements.len() || ids != partitions {
                    return Err(invalid(index, "partition"));
                }
                for part in partition {
                    crate::definitions::validate_expression(&part.predicate)?;
                }
                for replacement in replacements {
                    if model.contains_key(&replacement.reference.id)
                        || replacement.body.kind() != old.body.kind()
                        || !crate::definitions::scope_contains(
                            world,
                            &old.scope,
                            &replacement.scope,
                            scopes,
                        )?
                        || !crate::definitions::valid_time_contains(
                            &old.valid_time,
                            &replacement.valid_time,
                        )
                    {
                        return Err(invalid(index, "replacements"));
                    }
                    crate::definitions::validate_revision(None, replacement)?;
                    put(
                        world,
                        &mut model,
                        &mut touched,
                        &mut changed,
                        replacement.clone(),
                        index,
                    )?;
                }
                let mut next = successor(&old)?;
                next.lifecycle = DefinitionLifecycle::Split {
                    replacements: replacements
                        .iter()
                        .map(|definition| definition.reference.clone())
                        .collect(),
                    effective_at: old.valid_time.from.clone(),
                };
                seal(&mut next)?;
                crate::definitions::validate_revision(Some(&old), &next)?;
                put(world, &mut model, &mut touched, &mut changed, next, index)?;
            }
            SemanticOperation::AttachEvidence { evidence, .. } => {
                if evidence.is_empty()
                    || evidence
                        .iter()
                        .any(|reference| reference.world != *world || reference.revision.0 == 0)
                    || evidence.iter().collect::<BTreeSet<_>>().len() != evidence.len()
                {
                    return Err(invalid(index, "evidence"));
                }
                metadata.push(operation.clone());
            }
            SemanticOperation::EnrichAnnotation { target, annotation } => {
                exact(&model, target, index)?;
                if annotation
                    .label
                    .as_ref()
                    .is_some_and(|label| label.trim().is_empty())
                    || annotation
                        .description
                        .as_ref()
                        .is_some_and(|text| text.trim().is_empty())
                    || annotation
                        .aliases
                        .iter()
                        .any(|alias| alias.trim().is_empty())
                    || annotation.aliases.iter().collect::<BTreeSet<_>>().len()
                        != annotation.aliases.len()
                    || (annotation.label.is_none()
                        && annotation.description.is_none()
                        && annotation.aliases.is_empty())
                {
                    return Err(invalid(index, "annotation"));
                }
                metadata.push(operation.clone());
            }
            SemanticOperation::LinkExisting { source, target, .. } => {
                exact(&model, source, index)?;
                exact(&model, target, index)?;
                if source == target {
                    return Err(invalid(index, "target"));
                }
                metadata.push(operation.clone());
            }
            SemanticOperation::MergeAliases {
                sources,
                target,
                evidence,
            } => {
                let target = exact(&model, target, index)?;
                if sources.is_empty()
                    || evidence.is_empty()
                    || sources.iter().collect::<BTreeSet<_>>().len() != sources.len()
                    || evidence
                        .iter()
                        .any(|reference| reference.world != *world || reference.revision.0 == 0)
                {
                    return Err(invalid(index, "sources"));
                }
                for source in sources {
                    let source = exact(&model, source, index)?;
                    if source.reference.id == target.reference.id
                        || source.body.kind() != target.body.kind()
                    {
                        return Err(invalid(index, "sources"));
                    }
                }
                // Definition aliases do not merge stable Object/Relation identities.
                metadata.push(operation.clone());
            }
        }
    }
    let definitions: Vec<_> = model.into_values().collect();
    let mut context = base.to_vec();
    context.extend(changed.iter().cloned());
    let validator = crate::definitions::DefinitionValidator::new(&context, scopes)?;
    for definition in &changed {
        validator.validate(definition)?;
    }
    Ok(Materialized {
        definitions,
        changed,
        metadata,
        references: BTreeMap::new(),
    })
}

fn exact<'a>(
    model: &'a BTreeMap<DefinitionId, Model>,
    reference: &DefinitionRef,
    index: usize,
) -> Result<&'a Model, Error> {
    model
        .get(&reference.id)
        .filter(|definition| definition.reference == *reference)
        .ok_or_else(|| invalid(index, "previous"))
}

fn successor(old: &Model) -> Result<Model, Error> {
    let mut next = old.clone();
    next.previous_ref = Some(old.reference.clone());
    next.reference.revision = Revision(
        old.reference
            .revision
            .0
            .checked_add(1)
            .ok_or(DefinitionFailure::LifecycleConflict)?,
    );
    Ok(next)
}

fn seal(next: &mut Model) -> Result<(), Error> {
    next.content_digest = crate::definitions::content_digest(next)?;
    Ok(())
}

fn put(
    world: &WorldRef,
    model: &mut BTreeMap<DefinitionId, Model>,
    touched: &mut BTreeSet<DefinitionId>,
    changed: &mut Vec<Model>,
    next: Model,
    index: usize,
) -> Result<(), Error> {
    if next.reference.world != *world || !touched.insert(next.reference.id.clone()) {
        return Err(invalid(index, "definition.reference"));
    }
    if next.content_digest != crate::definitions::content_digest(&next)? {
        return Err(invalid(index, "definition.contentDigest"));
    }
    model.insert(next.reference.id.clone(), next.clone());
    changed.push(next);
    Ok(())
}
