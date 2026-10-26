use std::collections::{BTreeMap, BTreeSet, VecDeque};

use world_protocol::{
    compiler::{CompileDependency, CompileFailure, CompileRequest, DefinitionIr, DependencyGraph, DependencyTarget, DependencyUse, ExternalContractKind},
    definitions::{Definition, DefinitionBody},
    ids::{DefinitionId, DefinitionRef},
    failure::FieldPath,
};

pub(super) fn graph(request: &CompileRequest, definitions: &[DefinitionIr]) -> DependencyGraph {
    let mut edges = Vec::new();
    let models: BTreeMap<_, _> = request.definitions.iter().map(|model| (&model.reference, model)).collect();
    for definition in definitions {
        let model = models.get(&definition.reference).copied();
        if let Some(model) = model {
            // The explicit manifest includes exact revisions for otherwise bare stable type IDs.
            let mut references = crate::definitions::definition_references(&model.body);
            references.extend(model.dependencies.iter().cloned());
            references.sort();
            references.dedup();
            for reference in references {
                edges.push(edge(request, &definition.reference, DependencyTarget::Definition(reference), DependencyUse::Body, "body"));
            }
        }
        edges.push(edge(request, &definition.reference, DependencyTarget::Config(request.config_digest.clone()), DependencyUse::Config, "config"));
        for policy in &definition.policy_refs {
            edges.push(edge(request, &definition.reference, DependencyTarget::Policy(policy.clone()), DependencyUse::Policy, "policies"));
        }
        for external in &request.external_contracts {
            let used = match &external.kind {
                ExternalContractKind::Source { binding, .. } => definition.source_requirements.iter().any(|requirement| &requirement.binding == binding),
                ExternalContractKind::Policy { policy } => definition.policy_refs.contains(policy),
                ExternalContractKind::Function { reference } => model.is_some_and(|model| model.dependencies.contains(reference)),
                ExternalContractKind::CompilerPass { .. } => true,
                ExternalContractKind::DefinitionKind { .. } => false,
            };
            if used {
                edges.push(edge(request, &definition.reference, DependencyTarget::Contract(external.contract.clone()), DependencyUse::Provider, "externalContracts"));
                edges.push(edge(request, &definition.reference, DependencyTarget::Implementation(external.implementation.clone()), DependencyUse::Provider, "externalContracts"));
            }
        }
        if let DefinitionBody::SourceBinding(binding) = &definition.body {
            edges.push(edge(request, &definition.reference, DependencyTarget::Schema(binding.schema.clone()), DependencyUse::Schema, "schema"));
        }
        for annotation in &definition.annotations {
            if let world_protocol::value::ValueType::Quantity { unit } = &annotation.result_type {
                edges.push(edge(request, &definition.reference, DependencyTarget::Unit(unit.clone()), DependencyUse::Unit, "annotations"));
            }
        }
    }
    DependencyGraph { edges }
}

fn edge(request: &CompileRequest, dependent: &DefinitionRef, target: DependencyTarget, usage: DependencyUse, selector: &str) -> CompileDependency {
    CompileDependency { dependent: dependent.clone(), target, usage, selector: FieldPath(vec![selector.into()]), invalidates: request.targets.clone() }
}

pub(super) fn evaluation_cycles(definitions: &[Definition<DefinitionBody>]) -> Result<(), CompileFailure> {
    let kinds: BTreeMap<_, _> = definitions.iter().map(|definition| (&definition.reference, definition.body.kind())).collect();
    let mut graph = BTreeMap::new();
    for definition in definitions {
        let active = matches!(definition.body, DefinitionBody::Function(_) | DefinitionBody::Rule(_) | DefinitionBody::Metric(_) | DefinitionBody::ConceptView(_) | DefinitionBody::Strategy(_));
        if !active { continue; }
        let mut edges = Vec::new();
        for reference in crate::definitions::definition_references(&definition.body) {
            if kinds.get(&reference) == Some(&world_protocol::definitions::DefinitionKind::Function) { edges.push(reference); }
        }
        if let DefinitionBody::Strategy(strategy) = &definition.body {
            if let Some(fallback) = &strategy.fallback { edges.push(fallback.clone()); }
        }
        graph.insert(definition.reference.clone(), edges);
    }
    let mut complete = BTreeSet::new();
    for root in graph.keys() {
        if complete.contains(root) { continue; }
        let mut stack = vec![(root.clone(), 0)];
        let mut active = BTreeMap::from([(root.clone(), 0)]);
        while let Some((node, cursor)) = stack.last_mut() {
            let next = graph.get(node).and_then(|edges| edges.get(*cursor)).cloned();
            if let Some(next) = next {
                *cursor += 1;
                if let Some(start) = active.get(&next) {
                    let mut path: Vec<_> = stack[*start..].iter().map(|(node, _)| node.clone()).collect();
                    path.push(next);
                    return Err(CompileFailure::DependencyCycle { path });
                }
                if !complete.contains(&next) {
                    active.insert(next.clone(), stack.len());
                    stack.push((next, 0));
                }
            } else {
                let (node, _) = stack.pop().ok_or(CompileFailure::InternalFault)?;
                active.remove(&node);
                complete.insert(node);
            }
        }
    }
    Ok(())
}

pub(crate) fn affected_definitions(graph: &DependencyGraph, changed: &[DefinitionRef]) -> Vec<DefinitionRef> {
    let mut reverse: BTreeMap<DefinitionId, Vec<DefinitionRef>> = BTreeMap::new();
    for edge in &graph.edges {
        if let DependencyTarget::Definition(reference) = &edge.target {
            reverse.entry(reference.id.clone()).or_default().push(edge.dependent.clone());
        }
    }
    let mut queue: VecDeque<_> = changed.iter().cloned().collect();
    let mut visited = BTreeSet::new();
    while let Some(reference) = queue.pop_front() {
        if !visited.insert(reference.clone()) { continue; }
        if let Some(callers) = reverse.get(&reference.id) { queue.extend(callers.iter().cloned()); }
    }
    visited.into_iter().collect()
}
