use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    definitions::{Definition, DefinitionBody},
    ids::{DefinitionId, DefinitionRef, Digest},
    learning::SemanticOperation,
    releases::Release,
};

use super::{Error, invalid, references::{self, Visitor}};

type Model = Definition<DefinitionBody>;

#[derive(Clone)]
enum Edge { Exact(DefinitionRef), Stable(DefinitionId) }
struct Node { shape: Digest, edges: Vec<Edge> }

/// Only new draft identities may be aligned; persisted identities and exact external refs stay fixed.
#[derive(Default)]
pub(super) struct Alignment {
    exact: BTreeMap<DefinitionRef, DefinitionRef>,
    stable: BTreeMap<DefinitionId, DefinitionId>,
}
impl Visitor for Alignment {
    fn exact(&mut self, reference: &mut DefinitionRef) {
        if let Some(target) = self.exact.get(reference) { *reference = target.clone(); }
    }
    fn stable(&mut self, id: &mut DefinitionId) {
        if let Some(target) = self.stable.get(id) { *id = target.clone(); }
    }
}
impl Alignment {
    pub(super) fn target(&self, reference: &DefinitionRef) -> Option<&DefinitionRef> {
        self.exact.get(reference)
    }
}

pub(super) fn align(base: &Release, operations: &[SemanticOperation]) -> Result<Alignment, Error> {
    if operations.is_empty() || operations.len() > 4096 {
        return Err(invalid(0, "operations"));
    }
    let mut drafts = BTreeMap::new();
    let mut ordered = Vec::new();
    for (index, operation) in operations.iter().enumerate() {
        if let SemanticOperation::CreateDefinition { definition } = operation {
            crate::definitions::validate_revision(None, definition)?;
            if definition.reference.world != base.world
                || definition.content_digest != crate::definitions::content_digest(definition)?
                || drafts.insert(definition.reference.id.clone(), definition.as_ref()).is_some()
            { return Err(invalid(index, "definition.alignment.conflict")); }
            ordered.push(definition.reference.clone());
        }
    }
    let mut nodes = BTreeMap::new();
    let mut ids = BTreeMap::new();
    let mut targets: BTreeMap<Digest, Vec<DefinitionRef>> = BTreeMap::new();
    let mut aligned = Alignment::default();
    for definition in &base.definitions {
        let node = node(definition)?;
        targets.entry(node.shape.clone()).or_default().push(definition.reference.clone());
        ids.insert(definition.reference.id.clone(), definition.reference.clone());
        nodes.insert(definition.reference.clone(), node);
    }
    for definition in drafts.values() {
        if let Some(old) = base.definitions.iter().find(|old| old.reference.id == definition.reference.id) {
            if old.reference != definition.reference || old.content_digest != definition.content_digest {
                return Err(invalid(0, "definition.alignment.conflict"));
            }
            aligned.exact.insert(definition.reference.clone(), old.reference.clone());
            continue;
        }
        ids.insert(definition.reference.id.clone(), definition.reference.clone());
        nodes.insert(definition.reference.clone(), node(definition)?);
    }
    let base_ids: BTreeSet<_> = base.definitions.iter().map(|item| item.reference.id.clone()).collect();
    loop {
        let before = aligned.exact.len();
        for reference in &ordered {
            if aligned.exact.contains_key(reference) { continue; }
            let node = &nodes[reference];
            if let Some(candidates) = targets.get(&node.shape) {
                for target in candidates {
                    let target = aligned.exact.get(target).unwrap_or(target);
                    if target == reference { continue; }
                    let mut pairs = BTreeMap::new();
                    if matches(reference, target, &nodes, &ids, &drafts, &base_ids, &aligned, &mut pairs)
                        && !pairs.values().any(|target| pairs.contains_key(target))
                    {
                        // Keep prior aliases flat when a draft representative later matches the base.
                        for target in aligned.exact.values_mut() {
                            if let Some(canonical) = pairs.get(target) { *target = canonical.clone(); }
                        }
                        for (source, target) in pairs {
                            aligned.exact.insert(source, target);
                        }
                        break;
                    }
                }
            }
            if !aligned.exact.contains_key(reference) {
                if base_ids.contains(&reference.id) { return Err(invalid(0, "definition.alignment.conflict")); }
                let candidates = targets.entry(node.shape.clone()).or_default();
                if !candidates.contains(reference) { candidates.push(reference.clone()); }
            }
        }
        if aligned.exact.len() == before { break; }
    }
    aligned.stable = aligned.exact.iter().map(|(source, target)| (source.id.clone(), target.id.clone())).collect();
    // Mutations of a newly aligned draft retain their successor relation to the canonical identity.
    for operation in operations {
        let previous = match operation {
            SemanticOperation::RefineDefinition { previous, .. }
            | SemanticOperation::ScopeDefinition { previous, .. }
            | SemanticOperation::SupersedeRule { previous, .. }
            | SemanticOperation::DeprecateDefinition { previous, .. }
            | SemanticOperation::SplitDefinition { previous, .. } => previous,
            _ => continue,
        };
        if let Some(target) = aligned.exact.get(previous).cloned() {
            let mut source_next = previous.clone();
            let mut target_next = target;
            source_next.revision.0 = source_next.revision.0.checked_add(1).ok_or_else(|| invalid(0, "revision"))?;
            target_next.revision.0 = target_next.revision.0.checked_add(1).ok_or_else(|| invalid(0, "revision"))?;
            aligned.exact.insert(source_next, target_next);
        }
    }
    Ok(aligned)
}

fn matches(
    source: &DefinitionRef, target: &DefinitionRef,
    nodes: &BTreeMap<DefinitionRef, Node>, ids: &BTreeMap<DefinitionId, DefinitionRef>,
    drafts: &BTreeMap<DefinitionId, &Model>, base: &BTreeSet<DefinitionId>,
    aligned: &Alignment, pairs: &mut BTreeMap<DefinitionRef, DefinitionRef>,
) -> bool {
    let mut pending = vec![(source.clone(), target.clone())];
    let mut reverse = BTreeMap::new();
    while let Some((source, target)) = pending.pop() {
        let target = aligned.exact.get(&target).unwrap_or(&target);
        if let Some(canonical) = aligned.exact.get(&source) {
            if canonical != target { return false; }
            continue;
        }
        if source == *target { continue; }
        if !drafts.get(&source.id).is_some_and(|definition| definition.reference == source)
            || base.contains(&source.id) && source.id != target.id
        { return false; }
        if let Some(previous) = pairs.get(&source) {
            if previous != target { return false; }
            continue;
        }
        if reverse.insert(target.clone(), source.clone()).is_some() { return false; }
        let (Some(left), Some(right)) = (nodes.get(&source), nodes.get(target)) else { return false; };
        if left.shape != right.shape || left.edges.len() != right.edges.len() { return false; }
        pairs.insert(source, target.clone());
        for (left, right) in left.edges.iter().zip(&right.edges) {
            match (left, right) {
                (Edge::Exact(left), Edge::Exact(right)) => pending.push((left.clone(), right.clone())),
                (Edge::Stable(left), Edge::Stable(right)) if left == right => {}
                (Edge::Stable(left), Edge::Stable(right)) => {
                    let (Some(left), Some(right)) = (ids.get(left), ids.get(right)) else { return false; };
                    pending.push((left.clone(), right.clone()));
                }
                _ => return false,
            }
        }
    }
    true
}

fn node(definition: &Model) -> Result<Node, Error> {
    struct Shape { placeholder: DefinitionRef, edges: Vec<Edge> }
    impl Visitor for Shape {
        fn exact(&mut self, reference: &mut DefinitionRef) {
            self.edges.push(Edge::Exact(reference.clone()));
            *reference = self.placeholder.clone();
        }
        fn stable(&mut self, id: &mut DefinitionId) {
            self.edges.push(Edge::Stable(id.clone()));
            *id = self.placeholder.id.clone();
        }
    }
    let mut model = definition.clone();
    model.previous_ref = None;
    let mut shape = Shape {
        placeholder: DefinitionRef {
            world: definition.reference.world.clone(),
            id: DefinitionId::try_new("alignment").expect("static identifier"),
            revision: world_protocol::ids::Revision(1),
        },
        edges: Vec::new(),
    };
    references::model(&mut model, &mut shape);
    Ok(Node {
        shape: crate::definitions::canonical_digest(&(
            model.scope, model.valid_time, model.body, model.dependencies, model.lifecycle,
        ))?,
        edges: shape.edges,
    })
}
