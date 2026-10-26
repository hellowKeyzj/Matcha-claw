use std::collections::BTreeMap;

use super::{
    Error, invalid, materialize,
    state::{advance, current, recheck_support},
};
use crate::{authorization::Admission, store::WorldTransaction};
use world_protocol::{
    compiler::CompileSelection,
    ids::{CandidateId, ReleaseId, Revision},
    learning::{Candidate, ChangeStatus, LearningFailure, SemanticOperation},
    releases::ReleaseFailure,
    time::Timestamp,
};

/// Three-way merge is owned by Releases; learning retains only operations still needed on that base.
pub(crate) async fn rebase(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    expected: Revision,
    new_base: &ReleaseId,
    selection: &CompileSelection,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let (branch, candidate) = current(tx, admission, id, expected, now).await?;
    let (branch, candidate) = preview_rebase(tx, branch, candidate, new_base, selection).await?;
    admission.require_access(
        &super::candidate_impact(
            tx,
            &candidate,
            &branch,
            world_protocol::authorization::AccessMode::Write,
        )
        .await?,
    )?;
    recheck_support(tx, admission, &candidate, &branch, now).await?;
    advance(
        tx,
        admission,
        candidate,
        branch,
        ChangeStatus::Proposed,
        budget,
        cancel,
        now,
    )
    .await
}

pub(crate) async fn preview_rebase(
    tx: &WorldTransaction<'_>,
    mut branch: world_protocol::releases::WorldBranch,
    mut candidate: Candidate,
    new_base: &ReleaseId,
    selection: &CompileSelection,
) -> Result<(world_protocol::releases::WorldBranch, Candidate), Error> {
    let (basis, base_compile) = super::base_context(tx, new_base).await?;
    if matches!(
        branch.status,
        ChangeStatus::Published | ChangeStatus::Superseded
    ) || !basis.overlay.is_empty()
        || base_compile.world != branch.world
    {
        return Err(invalid(0, "rebase"));
    }
    let original = crate::releases::read_release(tx, &branch.basis.release_id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: branch.basis.release_id.clone(),
        })?;
    let next_base = crate::releases::read_release(tx, &basis.release_id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: basis.release_id.clone(),
        })?;
    let ours = materialize(
        &branch.world,
        &original.definitions,
        &branch.compile.scopes,
        &candidate.change_set.operations,
    )?;
    let merged = crate::releases::merge_definitions(
        &branch.world,
        &original.definitions,
        ours.definitions(),
        &next_base.definitions,
    )?;
    let mut operations = Vec::new();
    for operation in &candidate.change_set.operations {
        let affected: Vec<_> = match operation {
            SemanticOperation::CreateDefinition { definition } => vec![&definition.reference.id],
            SemanticOperation::RefineDefinition { previous, .. }
            | SemanticOperation::ScopeDefinition { previous, .. }
            | SemanticOperation::SupersedeRule { previous, .. }
            | SemanticOperation::DeprecateDefinition { previous, .. } => vec![&previous.id],
            SemanticOperation::SplitDefinition {
                previous,
                replacements,
                ..
            } => {
                let mut ids = vec![&previous.id];
                ids.extend(
                    replacements
                        .iter()
                        .map(|replacement| &replacement.reference.id),
                );
                ids
            }
            SemanticOperation::NoOp { .. } => continue,
            _ => {
                operations.push(operation.clone());
                continue;
            }
        };
        if affected.iter().any(|id| {
            merged
                .iter()
                .find(|definition| &&definition.reference.id == id)
                != next_base
                    .definitions
                    .iter()
                    .find(|definition| &&definition.reference.id == id)
        }) {
            operations.push(operation.clone());
        }
    }
    if operations.is_empty() {
        operations.push(SemanticOperation::NoOp {
            reason: "新基线已包含该候选所需语义。".into(),
        });
    }
    // Compare semantic three-way results before immutable canonical lineage is allocated.
    let semantic = materialize(
        &branch.world, &next_base.definitions, &base_compile.scopes, &operations,
    )?;
    let index = |definitions: &[world_protocol::definitions::Definition<
        world_protocol::definitions::DefinitionBody,
    >]| {
        definitions
            .iter()
            .map(|definition| (definition.reference.id.clone(), definition.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    if index(semantic.definitions()) != index(&merged) {
        return Err(LearningFailure::BasisChanged.into());
    }
    let compile = super::compile_selection(tx, new_base, &operations, selection).await?;
    candidate.change_set.base_release = next_base.id;
    candidate.change_set.operations = operations;
    branch.basis = basis;
    branch.basis.overlay = candidate.change_set.operations.clone();
    branch.compile = compile;
    Ok((branch, candidate))
}
