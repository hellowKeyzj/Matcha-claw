use super::Error;
use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    failure::FieldPath,
    ids::{DefinitionId, WorldRef},
    releases::{MergeConflict, ReleaseFailure},
};

type Model = Definition<DefinitionBody>;

/// Merge by stable identity; divergent revisions of one identity require an explicit semantic edit.
pub(crate) fn merge_definitions(
    world: &WorldRef,
    base: &[Model],
    ours: &[Model],
    theirs: &[Model],
) -> Result<Vec<Model>, Error> {
    let base = index(world, base)?;
    let ours = index(world, ours)?;
    let theirs = index(world, theirs)?;
    let ids: BTreeSet<_> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .copied()
        .collect();
    let mut merged = Vec::new();
    let mut conflicts = Vec::new();
    for id in ids {
        let original = base.get(id).copied();
        let left = ours.get(id).copied();
        let right = theirs.get(id).copied();
        let selected = if left == right {
            left
        } else if left == original {
            right
        } else if right == original {
            left
        } else {
            let fields = match (left, right) {
                (Some(left), Some(right)) => {
                    let left = serde_json::to_value(left)?;
                    let right = serde_json::to_value(right)?;
                    let mut fields = Vec::new();
                    differences(&left, &right, &[], &mut fields);
                    fields
                }
                _ => vec![FieldPath(vec!["definition".into()])],
            };
            conflicts.push(MergeConflict {
                definition_id: id.clone(),
                fields,
            });
            continue;
        };
        if let Some(definition) = selected {
            merged.push(definition.clone());
        }
    }
    if !conflicts.is_empty() {
        return Err(ReleaseFailure::MergeConflicts { conflicts }.into());
    }
    Ok(merged)
}

fn index<'a>(
    world: &WorldRef,
    definitions: &'a [Model],
) -> Result<BTreeMap<&'a DefinitionId, &'a Model>, Error> {
    let mut result = BTreeMap::new();
    for definition in definitions {
        if &definition.reference.world != world
            || definition.reference.revision.0 == 0
            || result
                .insert(&definition.reference.id, definition)
                .is_some()
        {
            return Err(ReleaseFailure::InvalidBranch {
                field: FieldPath(vec!["definitions".into()]),
            }
            .into());
        }
    }
    Ok(result)
}

fn differences(
    left: &serde_json::Value,
    right: &serde_json::Value,
    path: &[String],
    result: &mut Vec<FieldPath>,
) {
    if left == right {
        return;
    }
    if let (serde_json::Value::Object(left), serde_json::Value::Object(right)) = (left, right) {
        let keys: BTreeSet<_> = left.keys().chain(right.keys()).collect();
        for key in keys {
            let mut field = path.to_vec();
            field.push(key.clone());
            match (left.get(key), right.get(key)) {
                (Some(left), Some(right)) => differences(left, right, &field, result),
                _ => result.push(FieldPath(field)),
            }
        }
    } else {
        result.push(FieldPath(path.to_vec()));
    }
}
