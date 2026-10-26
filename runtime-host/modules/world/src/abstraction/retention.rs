use world_protocol::{
    abstraction::{
        AbstractionContract, AbstractionDraft, AbstractionSlot, BindingMap, BindingTarget, Fallback,
    },
    expression::{ExpressionIr, Parameter},
    ids::{DefinitionRef, EvaluationId, ResourceRef, WorldRef},
    learning::StrategyStep,
    provenance::ReadDependency,
};

use crate::{learning::retain_expression, store::RetentionRoots};

pub(crate) fn retain_contract(
    world: &WorldRef,
    contract: &AbstractionContract,
    roots: &mut RetentionRoots,
) {
    if contract.world != *world {
        return;
    }
    roots.scopes.push(contract.scope.clone());
    roots.releases.push(contract.base_release.clone());
    roots.branches.extend(contract.branch.iter().cloned());
    roots.resources.push(ResourceRef::Task {
        id: contract.task_id.clone(),
    });
    retain(
        world,
        References {
            strategy: contract.strategy.as_ref(),
            applicable_actions: &contract.applicable_actions,
            original_definitions: &contract.original_definitions,
            forward_plan: &contract.forward_plan,
            preserved_invariants: &contract.preserved_invariants,
            parameters: &contract.parameters,
            slots: &contract.slots,
            binding_map: &contract.binding_map,
            guard: &contract.guard,
            assumptions: &contract.assumptions,
            evaluation_ids: &contract.evaluation_ids,
            fallback: &contract.fallback,
            read_dependencies: &contract.read_dependencies,
        },
        roots,
    );
}

pub(crate) fn retain_draft(world: &WorldRef, draft: &AbstractionDraft, roots: &mut RetentionRoots) {
    retain(
        world,
        References {
            strategy: draft.strategy.as_ref(),
            applicable_actions: &draft.applicable_actions,
            original_definitions: &draft.original_definitions,
            forward_plan: &draft.forward_plan,
            preserved_invariants: &draft.preserved_invariants,
            parameters: &draft.parameters,
            slots: &draft.slots,
            binding_map: &draft.binding_map,
            guard: &draft.guard,
            assumptions: &draft.assumptions,
            evaluation_ids: &draft.evaluation_ids,
            fallback: &draft.fallback,
            read_dependencies: &draft.read_dependencies,
        },
        roots,
    );
}

struct References<'a> {
    strategy: Option<&'a DefinitionRef>,
    applicable_actions: &'a [DefinitionRef],
    original_definitions: &'a [DefinitionRef],
    forward_plan: &'a [StrategyStep],
    preserved_invariants: &'a [ExpressionIr],
    parameters: &'a [Parameter],
    slots: &'a [AbstractionSlot],
    binding_map: &'a BindingMap,
    guard: &'a ExpressionIr,
    assumptions: &'a [ExpressionIr],
    evaluation_ids: &'a [EvaluationId],
    fallback: &'a Fallback,
    read_dependencies: &'a [ReadDependency],
}

fn retain(world: &WorldRef, references: References<'_>, roots: &mut RetentionRoots) {
    use world_protocol::learning::StrategyOperation;

    roots.resources.extend(
        references
            .evaluation_ids
            .iter()
            .cloned()
            .map(|id| ResourceRef::Evaluation { id }),
    );
    roots.definitions.extend(
        references
            .strategy
            .into_iter()
            .chain(references.applicable_actions)
            .chain(references.original_definitions)
            .cloned(),
    );
    for step in references.forward_plan {
        retain_expression(roots, &step.guard);
        match &step.operation {
            StrategyOperation::Query { query } => {
                roots
                    .definitions
                    .extend(crate::definitions::query_references(query));
                roots
                    .resources
                    .extend(crate::definitions::query_resources(query));
            }
            StrategyOperation::Action { action, arguments } => {
                roots.definitions.push(action.clone());
                for argument in arguments {
                    crate::definitions::value_resources(&argument.value, &mut roots.resources);
                }
            }
            StrategyOperation::Function {
                function,
                arguments,
            } => {
                roots.definitions.push(function.clone());
                for argument in arguments {
                    retain_expression(roots, argument);
                }
            }
            StrategyOperation::Stop { .. } => {}
        }
    }
    for expression in references
        .preserved_invariants
        .iter()
        .chain(references.assumptions)
        .chain(std::iter::once(references.guard))
    {
        retain_expression(roots, expression);
    }
    for value_type in references
        .parameters
        .iter()
        .map(|parameter| &parameter.value_type)
        .chain(references.slots.iter().map(|slot| &slot.value_type))
    {
        roots
            .resources
            .extend(crate::definitions::value_type_resources(value_type));
    }
    for binding in &references.binding_map.bindings {
        roots.scopes.push(binding.inverse_scope.clone());
        roots.dependencies.extend(binding.dependencies.iter().cloned());
        roots.evidence.extend(binding.evidence.iter().cloned());
        for expression in binding
            .transform
            .iter()
            .chain(&binding.inverse_transform)
            .chain(&binding.guard)
        {
            retain_expression(roots, expression);
        }
        match &binding.target {
            BindingTarget::Object { id } => {
                roots.resources.push(ResourceRef::Object { id: id.clone() })
            }
            BindingTarget::Relation { id } => roots
                .resources
                .push(ResourceRef::Relation { id: id.clone() }),
            BindingTarget::Property { definition } | BindingTarget::Action { definition } => {
                roots.definitions.push(definition.clone())
            }
            BindingTarget::State { reference } if reference.world == *world => {
                roots.resources.push(ResourceRef::State {
                    id: reference.id.clone(),
                })
            }
            BindingTarget::State { .. } => {}
            BindingTarget::Expression { expression } => retain_expression(roots, expression),
        }
    }
    match references.fallback {
        Fallback::ExpandConcrete { concrete_strategy } => {
            roots.definitions.push(concrete_strategy.clone());
        }
        Fallback::RequestEvidence { evidence } => roots.evidence.extend(evidence.iter().cloned()),
        Fallback::Stop => {}
    }
    roots.dependencies.extend(references.read_dependencies.iter().cloned());
}
