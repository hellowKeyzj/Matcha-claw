use super::{changed, decode};
use crate::{
    owner::{Error, StepRecord},
    store::{RetentionRoots, WorldTransaction},
};
use world_protocol::{api::ResolveTaskRequest, ids::ResourceRef};

pub(crate) async fn operation_retention_roots(
    tx: &WorldTransaction<'_>,
    request: &ResolveTaskRequest,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    let task = crate::evaluation::read_task(tx, &request.task.id, request.task.revision).await?;
    crate::evaluation::retain_task(roots, &task);
    roots.resources.push(ResourceRef::TestCase {
        id: request.test.id.clone(),
    });
    crate::definitions::value_resources(&request.input, &mut roots.resources);
    roots
        .definitions
        .extend(crate::definitions::query_references(&request.query.query));
    roots
        .resources
        .extend(crate::definitions::query_resources(&request.query.query));
    roots
        .releases
        .extend(request.query.release_id.iter().cloned());
    roots.resources.extend(
        request
            .query
            .branch_id
            .iter()
            .cloned()
            .map(|id| ResourceRef::Branch { id }),
    );
    for argument in &request.query.arguments {
        crate::definitions::value_resources(&argument.value, &mut roots.resources);
    }
    let contract =
        crate::abstraction::read(tx, &request.abstraction_id, request.abstraction_revision)
            .await?
            .ok_or_else(changed)?;
    roots.definitions.extend(contract.original_definitions);
    roots.definitions.extend(contract.strategy);
    roots.definitions.extend(contract.applicable_actions);
    if let world_protocol::abstraction::Fallback::ExpandConcrete { concrete_strategy } =
        contract.fallback
    {
        roots.definitions.push(concrete_strategy);
    }
    roots.dependencies.extend(contract.read_dependencies);
    let (_, candidate) = crate::releases::read_candidate(tx, &contract.candidate_id)
        .await?
        .ok_or_else(changed)?;
    roots.resources.push(ResourceRef::ChangeSet {
        id: candidate.change_set.id,
    });
    roots.releases.push(contract.base_release);
    roots.branches.extend(contract.branch);
    Ok(())
}

pub(crate) async fn step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &StepRecord,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    if step.kind == "world.evaluation.online_oracle" {
        return crate::evaluation::online_oracle_retention_roots(tx, step, roots).await;
    }
    if step.kind == "learning.strategy" {
        return crate::abstraction::strategy_step_retention_roots(tx, step, roots).await;
    }
    if step.kind != "learning.resolve" {
        return Ok(());
    }
    let state = decode(step)?;
    if state.binding.task.world != *tx.world()
        || state.binding.step_id != step.id
        || state.binding.run_id != step.run_id
    {
        return Err(changed());
    }
    crate::evaluation::retain_task(roots, &state.task);
    roots.resources.push(ResourceRef::TestCase {
        id: state.binding.test.id.clone(),
    });
    if crate::evaluation::read_case(tx, &state.binding.case_id)
        .await?
        .is_some()
    {
        roots.resources.push(ResourceRef::Case {
            id: state.binding.case_id.clone(),
        });
    }
    roots.releases.push(state.binding.release_id.clone());
    if let Some(context) = &state.context {
        if let Some(invocation) = &context.invocation {
            super::context::retain_roots(invocation, roots);
        }
        if let Some(view) = &context.view {
            roots.definitions.extend(view.definitions.iter().cloned());
        }
        if let Some(page) = &context.page {
            crate::query::retain_page(roots, page);
        }
        if let Some(contract) = &context.contract {
            roots
                .definitions
                .extend(contract.original_definitions.clone());
            roots
                .dependencies
                .extend(contract.read_dependencies.clone());
            roots.releases.push(contract.base_release.clone());
            if let Some(branch) = &contract.branch {
                roots.branches.push(branch.clone());
            }
        }
    }
    if let Some(execution) = &state.execution {
        roots.resources.extend(execution.query_closure.bindings.iter().cloned().map(|id| ResourceRef::Binding { id }));
    }
    if let Some(page) = &state.observed {
        crate::query::retain_page(roots, page);
    }
    Ok(())
}
