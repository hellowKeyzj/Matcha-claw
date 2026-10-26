use std::collections::BTreeMap;

use world_protocol::{
    definitions::{Definition, DefinitionBody, DefinitionFailure, Scope},
    ids::{DefinitionId, DefinitionRef, Revision},
    learning::SemanticOperation,
    releases::{ReleaseFailure, WorldBranch},
};

use crate::{definitions, store::WorldTransaction};
use crate::learning::align::references::{self, Visitor};
use super::{Error, Materialized, invalid, materialize};

type Model = Definition<DefinitionBody>;

/// Semantic edits name the sealed release; immutable successors name the canonical lineage.
pub(crate) async fn materialize_current(
    tx: &WorldTransaction<'_>,
    base: &[Model],
    scopes: &[Scope],
    operations: &[SemanticOperation],
) -> Result<Materialized, Error> {
    let semantic = materialize(tx.world(), base, scopes, operations)?;
    let mut lineage = BTreeMap::new();
    let mut targets = BTreeMap::new();
    for next in &semantic.changed {
        let previous = definitions::read_definition_head(tx, &next.reference.id).await?;
        let mut target = next.reference.clone();
        target.revision = definitions::next_definition_revision(tx, &next.reference.id).await?;
        targets.insert(next.reference.id.clone(), target);
        lineage.insert(next.reference.id.clone(), previous);
    }
    stamp(tx, base, scopes, semantic, lineage, targets)
}

/// Reproduce the frozen lineage, never allocate revisions again from the latest head.
pub(crate) async fn materialize_frozen(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
) -> Result<Materialized, Error> {
    if branch.world != *tx.world() || branch.compile.world != branch.world {
        return Err(invalid(0, "lineage.world"));
    }
    let base = crate::releases::read_release(tx, &branch.basis.release_id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: branch.basis.release_id.clone(),
        })?;
    let semantic = materialize(
        tx.world(), &base.definitions, &branch.compile.scopes, &branch.basis.overlay,
    )?;
    let mut lineage = BTreeMap::new();
    let mut targets = BTreeMap::new();
    for next in &semantic.changed {
        let mut matches = branch.compile.definitions.iter()
            .filter(|definition| definition.reference.id == next.reference.id);
        let frozen = matches.next().ok_or_else(|| invalid(0, "lineage.definition"))?;
        if matches.next().is_some() {
            return Err(invalid(0, "lineage.definition"));
        }
        let previous = match &frozen.previous_ref {
            Some(reference) => {
                let previous = definitions::read_definition(tx, reference).await?
                    .ok_or_else(|| DefinitionFailure::MissingReference { reference: reference.clone() })?;
                if previous.reference != *reference {
                    return Err(invalid(0, "lineage.previous"));
                }
                Some(previous)
            }
            None => None,
        };
        targets.insert(next.reference.id.clone(), frozen.reference.clone());
        lineage.insert(next.reference.id.clone(), previous);
    }
    stamp(tx, &base.definitions, &branch.compile.scopes, semantic, lineage, targets)
}

struct Refs<'a>(&'a BTreeMap<DefinitionRef, DefinitionRef>);
impl Visitor for Refs<'_> {
    fn exact(&mut self, reference: &mut DefinitionRef) {
        if let Some(target) = self.0.get(reference) {
            *reference = target.clone();
        }
    }
    fn stable(&mut self, _: &mut DefinitionId) {}
}

fn stamp(
    tx: &WorldTransaction<'_>,
    base: &[Model],
    scopes: &[Scope],
    mut semantic: Materialized,
    lineage: BTreeMap<DefinitionId, Option<Model>>,
    targets: BTreeMap<DefinitionId, DefinitionRef>,
) -> Result<Materialized, Error> {
    let mut mapped = BTreeMap::new();
    for next in &semantic.changed {
        let old = base.iter().find(|old| old.reference.id == next.reference.id);
        let previous = lineage.get(&next.reference.id)
            .ok_or_else(|| invalid(0, "lineage.previous"))?.as_ref();
        match (old, previous) {
            (None, Some(previous)) => return Err(DefinitionFailure::HeadConflict {
                definition_id: next.reference.id.clone(), expected: Revision(0),
                actual: previous.reference.revision, fields: Vec::new(),
            }.into()),
            (Some(_), None) => return Err(invalid(0, "lineage.previous")),
            (Some(old), Some(previous)) => {
                if previous.reference.world != *tx.world()
                    || previous.reference.id != next.reference.id
                    || previous.reference.revision < old.reference.revision
                    || previous.content_digest != definitions::content_digest(previous)?
                    || previous.reference == old.reference && previous != old
                {
                    return Err(invalid(0, "lineage.previous"));
                }
            }
            (None, None) => {}
        }
        let reference = targets.get(&next.reference.id)
            .ok_or_else(|| invalid(0, "lineage.target"))?;
        if reference.world != *tx.world() || reference.id != next.reference.id
            || reference.revision.0 == 0
            || previous.is_some_and(|previous| reference.revision <= previous.reference.revision)
        {
            return Err(invalid(0, "lineage.target"));
        }
        mapped.insert(next.reference.clone(), reference.clone());
    }
    for next in &mut semantic.changed {
        let reference = mapped[&next.reference].clone();
        references::model(next, &mut Refs(&mapped));
        next.reference = reference;
        let previous = lineage[&next.reference.id].as_ref();
        next.previous_ref = previous.map(|previous| previous.reference.clone());
        next.content_digest = definitions::content_digest(next)?;
        definitions::validate_revision(previous, next)?;
    }
    for operation in &mut semantic.metadata {
        references::operation(operation, &mut Refs(&mapped));
    }
    let changed: BTreeMap<_, _> = semantic.changed.iter()
        .map(|definition| (definition.reference.id.clone(), definition.clone())).collect();
    for definition in &mut semantic.definitions {
        if let Some(next) = changed.get(&definition.reference.id) {
            *definition = next.clone();
        }
    }
    let mut context = BTreeMap::new();
    for definition in base.iter().chain(lineage.values().filter_map(Option::as_ref))
        .chain(&semantic.changed)
    {
        if context.insert(definition.reference.clone(), definition.clone())
            .is_some_and(|old| old != *definition)
        {
            return Err(DefinitionFailure::ImmutableRevision { reference: definition.reference.clone() }.into());
        }
    }
    let context: Vec<_> = context.into_values().collect();
    let validator = definitions::DefinitionValidator::new(&context, scopes)?;
    for definition in &semantic.changed {
        validator.validate(definition)?;
    }
    semantic.references = mapped;
    Ok(semantic)
}
