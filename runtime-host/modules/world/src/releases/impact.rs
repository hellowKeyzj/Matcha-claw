use std::collections::BTreeSet;

use crate::{authorization, store::WorldTransaction};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    compiler::DependencyGraph,
    definitions::{Definition, DefinitionBody},
    ids::{DefinitionRef, ResourceRef},
    releases::Release,
};

use super::{Error, read::invalid};

/// Union both immutable dependency graphs so removed and revised references invalidate callers alike.
pub(crate) fn affected_definitions(
    base: &Release,
    definitions: &[Definition<DefinitionBody>],
    dependencies: &DependencyGraph,
) -> Vec<DefinitionRef> {
    let changed: Vec<_> = definitions
        .iter()
        .filter(|definition| !base.definitions.contains(definition))
        .chain(
            base.definitions
                .iter()
                .filter(|old| !definitions.contains(old)),
        )
        .map(|definition| definition.reference.clone())
        .collect();
    let mut dependencies = dependencies.clone();
    dependencies
        .edges
        .extend(base.artifact.dependencies.edges.iter().cloned());
    let affected = crate::compiler::affected_definitions(&dependencies, &changed);
    let ids: BTreeSet<_> = affected.iter().map(|reference| &reference.id).collect();
    definitions
        .iter()
        .filter(|definition| ids.contains(&definition.reference.id))
        .map(|definition| definition.reference.clone())
        .collect()
}

/// Validate freezes every target source; publication promotes that same captured set.
pub(crate) fn source_bindings(definitions: &[Definition<DefinitionBody>]) -> Vec<DefinitionRef> {
    definitions
        .iter()
        .filter(|definition| matches!(definition.body, DefinitionBody::SourceBinding(_)))
        .map(|definition| definition.reference.clone())
        .collect()
}

/// Metadata is resolved from exact durable evidence and its current source policy, never from a ref.
pub(crate) async fn model_impact(
    tx: &WorldTransaction<'_>,
    definitions: &[Definition<DefinitionBody>],
    mut access: Vec<AccessScope>,
    modes: &[AccessMode],
) -> Result<ActualImpact, Error> {
    let mut labels = Vec::new();
    let mut sources = Vec::new();
    let mut evidence = BTreeSet::new();
    for definition in definitions {
        access.push(AccessScope {
            resources: vec![ResourceRef::Definition {
                id: definition.reference.id.clone(),
            }],
            fields: Vec::new(),
            modes: modes.to_vec(),
            scope: definition.scope.clone(),
            valid_time: Some(definition.valid_time.clone()),
        });
        if let DefinitionBody::Property(property) = &definition.body {
            labels.extend(property.access_labels.iter().cloned());
        }
        if let DefinitionBody::SourceBinding(binding) = &definition.body {
            sources.push(binding.source_id.clone());
        }
        for reference in &definition.evidence {
            if !evidence.insert((reference.clone(), definition.scope.clone())) {
                continue;
            }
            let item = crate::facts::assertions::read_evidence(tx, reference)
                .await?
                .ok_or_else(|| invalid("evidence"))?;
            let version = crate::content::read_source_version_in_transaction(
                tx,
                &item.locator.source_version,
            )
            .await?;
            labels.extend(item.access.labels);
            let material = authorization::material_read_impact(tx, &version).await?;
            labels.extend(material.labels);
            sources.extend(material.source_ids);
            access.extend(material.access);
            access.push(AccessScope {
                resources: vec![ResourceRef::Evidence {
                    id: reference.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: definition.scope.clone(),
                valid_time: None,
            });
        }
    }
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        labels,
        Vec::new(),
        sources,
    )?)
}
