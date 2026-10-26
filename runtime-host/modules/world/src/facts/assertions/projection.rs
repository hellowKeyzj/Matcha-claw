use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    definitions::{Definition, DefinitionBody, Property, Scope},
    facts::{Assertion, AssertionOrigin, AssertionStatus, Claim, FactFailure, Polarity},
    failure::FieldPath,
    identity::SubjectRef,
    ids::*,
    provenance::ReadDependency,
    slots::{
        ProjectedCell, ProjectionRequest, ProjectionResult, ProjectionSourceWitness,
        ReconcileRequest, ReconcileResult,
    },
    sources::SourceBasis,
    time::{Timestamp, ValidTime},
    value::{Cell, Value},
};

use super::{
    Error,
    claim::{ClaimRead, projected_values, validate_claim, validate_projected_cell_snapshot},
    impact::resource_read_impact,
    revision::validate_interval,
};
use crate::{
    authorization::{self, Admission},
    definitions,
    store::WorldSnapshot,
};

type Key = (SubjectRef, DefinitionRef);

struct Input<'a> {
    world: &'a WorldRef,
    release_id: &'a ReleaseId,
    definitions: &'a [Definition<DefinitionBody>],
    scopes: &'a [Scope],
    scope: &'a ScopeId,
    valid_time: &'a ValidTime,
    known_at: Option<&'a Timestamp>,
    cells: &'a [ProjectedCell],
    fixed: &'a [ProjectedCell],
    assertions: &'a [Assertion],
    sources: &'a [ProjectionSourceWitness],
    basis: &'a [SourceBasis],
    dependencies: &'a [ReadDependency],
}

/// Inputs are the native query envelope, not guest-created evidence or source authority.
pub(crate) async fn validate_projection_snapshot(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    request: &ProjectionRequest,
    result: &ProjectionResult,
) -> Result<Vec<ProjectedCell>, Error> {
    let input = Input {
        world: &request.world,
        release_id: &request.release_id,
        definitions: &request.definitions,
        scopes: &request.scopes,
        scope: &request.scope,
        valid_time: &request.valid_time,
        known_at: request.known_at.as_ref(),
        cells: &request.cells,
        fixed: &request.fixed,
        assertions: &request.assertions,
        sources: &request.sources,
        basis: &request.basis,
        dependencies: &request.dependencies,
    };
    validate(
        snapshot,
        admission,
        &input,
        &result.cells,
        &result.dependencies,
        false,
    )
    .await?;
    Ok(result.cells.clone())
}

pub(crate) async fn validate_reconciliation_snapshot(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    request: &ReconcileRequest,
    result: &ReconcileResult,
) -> Result<Vec<ProjectedCell>, Error> {
    if !result.observations.is_empty() {
        return Err(invalid("reconcile.observations"));
    }
    let selected: BTreeSet<_> = result.selected.iter().collect();
    if selected.len() != result.selected.len()
        || selected.iter().any(|reference| {
            !request.assertions.iter().any(|assertion| {
                &assertion.reference == *reference && assertion.status == AssertionStatus::Accepted
            })
        })
    {
        return Err(invalid("reconcile.selected"));
    }
    let mut cells = index(&request.cells)?;
    let conflicts = index(&result.conflicts)?;
    for (key, cell) in conflicts {
        if !matches!(cell.field.cell, Cell::Conflicted { .. }) || !cells.contains_key(&key) {
            return Err(invalid("reconcile.conflicts"));
        }
        cells.insert(key, cell);
    }
    let input = Input {
        world: &request.world,
        release_id: &request.release_id,
        definitions: &request.definitions,
        scopes: &request.scopes,
        scope: &request.scope,
        valid_time: &request.valid_time,
        known_at: request.known_at.as_ref(),
        cells: &request.cells,
        fixed: &request.fixed,
        assertions: &request.assertions,
        sources: &request.sources,
        basis: &request.basis,
        dependencies: &request.dependencies,
    };
    let cells: Vec<_> = cells.into_values().cloned().collect();
    validate(
        snapshot,
        admission,
        &input,
        &cells,
        &result.dependencies,
        true,
    )
    .await?;
    Ok(cells)
}

async fn validate(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    input: &Input<'_>,
    cells: &[ProjectedCell],
    dependencies: &[ReadDependency],
    final_result: bool,
) -> Result<(), Error> {
    if input.world != snapshot.world() || input.world != &admission.invocation().world {
        return Err(FactFailure::AccessDenied.into());
    }
    validate_interval(input.valid_time)?;
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    let release = crate::releases::read_release_snapshot(snapshot, input.release_id)
        .await
        .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
        .ok_or(FactFailure::AccessDenied)?;
    if input
        .definitions
        .iter()
        .map(|definition| &definition.reference)
        .collect::<BTreeSet<_>>()
        .len()
        != input.definitions.len()
        || input
            .definitions
            .iter()
            .any(|definition| !release.definitions.contains(definition))
        || input
            .scopes
            .iter()
            .map(|scope| &scope.id)
            .collect::<BTreeSet<_>>()
            .len()
            != input.scopes.len()
        || input
            .scopes
            .iter()
            .any(|scope| !release.scopes.contains(scope))
        || !input
            .scopes
            .iter()
            .any(|scope| &scope.id == input.scope && &scope.world == input.world)
    {
        return Err(invalid("projection.model"));
    }
    let read = ClaimRead::Projection(snapshot, input.definitions, input.scopes, input.known_at);
    let envelope = index(input.cells)?;
    let fixed = index(input.fixed)?;
    let proposed = index(cells)?;
    if envelope.keys().ne(proposed.keys())
        || fixed.iter().any(|(key, cell)| {
            envelope.get(key).is_none_or(|current| {
                current.field.cell != cell.field.cell || current.field.dirty != cell.field.dirty
            })
        })
        || dependencies
            .iter()
            .any(|dependency| !input.dependencies.contains(dependency))
    {
        return Err(invalid("projection.envelope"));
    }
    let mut assertions: BTreeMap<Key, Vec<&Assertion>> = BTreeMap::new();
    let mut references = BTreeSet::new();
    for assertion in input.assertions {
        if !references.insert(&assertion.reference) {
            return Err(invalid("projection.assertions"));
        }
        let Claim::Attribute(claim) = &assertion.claim else {
            // Whole relation roles remain in the native identity/relation envelope.
            return Err(invalid("projection.assertions.claim"));
        };
        let key = (claim.subject.clone(), claim.property.clone());
        if !envelope.contains_key(&key) || assertion.reference.world != *input.world {
            return Err(invalid("projection.assertions"));
        }
        admission.require_access(&resource_read_impact(
            ResourceRef::Assertion {
                id: assertion.reference.id.clone(),
            },
            vec![claim.property.clone()],
            input.scope,
            Some(input.valid_time),
            Vec::new(),
            None,
        )?)?;
        let row = match input.known_at {
            Some(at) => snapshot.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND recorded_at<=$4::text::timestamptz ORDER BY revision DESC LIMIT 1", &[&input.world.tenant_id.as_str(), &input.world.world_id.as_str(), &assertion.reference.id.as_str(), &at.as_str()]).await?,
            None => snapshot.query_opt("SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.assertion_id=$3", &[&input.world.tenant_id.as_str(), &input.world.world_id.as_str(), &assertion.reference.id.as_str()]).await?,
        }.ok_or(FactFailure::AccessDenied)?;
        let durable: Assertion = super::read::decode(row.get("body"))?;
        if durable != *assertion
            || assertion.status != AssertionStatus::Accepted
            || assertion.recorded_at > *input.known_at.unwrap_or(&now)
            || !definitions::valid_time_contains(&assertion.valid_time, input.valid_time)
            || !definitions::scope_contains(
                input.world,
                &assertion.scope,
                input.scope,
                input.scopes,
            )?
        {
            return Err(FactFailure::AccessDenied.into());
        }
        validate_claim(&read, &assertion.claim, input.scope, input.valid_time).await?;
        if let AssertionOrigin::Source { binding, .. } = &assertion.origin {
            let source = release
                .definitions
                .iter()
                .find_map(|definition| {
                    if definition.reference != *binding {
                        return None;
                    }
                    match &definition.body {
                        DefinitionBody::SourceBinding(body) => Some(&body.source_id),
                        _ => None,
                    }
                })
                .ok_or(FactFailure::AccessDenied)?;
            admission.require_access(&resource_read_impact(
                ResourceRef::Source { id: source.clone() },
                vec![claim.property.clone()],
                input.scope,
                Some(input.valid_time),
                Vec::new(),
                Some(source.clone()),
            )?)?;
        }
        assertions.entry(key).or_default().push(assertion);
    }
    let mut sources: BTreeMap<Key, Vec<&ProjectedCell>> = BTreeMap::new();
    let mut source_keys = BTreeSet::new();
    for witness in input.sources {
        let key = key(&witness.cell);
        if !envelope.contains_key(&key)
            || !input.basis.contains(&witness.basis)
            || !source_keys.insert((witness.basis.binding.clone(), key.clone()))
            || witness.basis.binding.world != *input.world
            || witness.basis.gap.is_some()
        {
            return Err(invalid("projection.sources"));
        }
        let binding = release
            .definitions
            .iter()
            .find(|definition| definition.reference == witness.basis.binding)
            .ok_or(FactFailure::AccessDenied)?;
        let DefinitionBody::SourceBinding(source) = &binding.body else {
            return Err(invalid("projection.sources.binding"));
        };
        if source.source_id != witness.basis.source_id
            || source.incarnation != witness.basis.incarnation
            || source.mapping.revision != witness.basis.mapping_revision
            || source.authority.revision != witness.basis.authority_revision
            || source.schema != witness.basis.schema
            || source.identity_rule != witness.basis.identity_rule
            || !witness
                .basis
                .field_definitions
                .contains(&witness.cell.field.property)
        {
            return Err(invalid("projection.sources.basis"));
        }
        definitions::validate_applicability(
            binding,
            input.scope,
            input.valid_time,
            &release.scopes,
        )?;
        admission.require_access(&resource_read_impact(
            ResourceRef::Source {
                id: source.source_id.clone(),
            },
            vec![witness.cell.field.property.clone()],
            input.scope,
            Some(input.valid_time),
            Vec::new(),
            Some(source.source_id.clone()),
        )?)?;
        match &witness.cell.field.cell {
            Cell::Known { value } => {
                validate_claim(
                    &read,
                    &Claim::Attribute(world_protocol::facts::AttributeClaim {
                        subject: witness.cell.subject.clone(),
                        property: witness.cell.field.property.clone(),
                        value: value.clone(),
                    }),
                    input.scope,
                    input.valid_time,
                )
                .await?;
            }
            Cell::Unknown { .. } | Cell::SourceUnavailable { .. } => {}
            Cell::Conflicted { .. } => return Err(invalid("projection.sources.cell")),
        }
        sources.entry(key).or_default().push(&witness.cell);
    }
    for (key, projected) in proposed {
        let original = envelope[&key];
        if projected.field.dirty != original.field.dirty {
            return Err(invalid("projection.dirty"));
        }
        let facts = assertions.get(&key).map(Vec::as_slice).unwrap_or_default();
        let source = sources.get(&key).map(Vec::as_slice).unwrap_or_default();
        let expected_evidence: BTreeSet<_> = original
            .field
            .evidence
            .iter()
            .chain(facts.iter().flat_map(|assertion| assertion.evidence.iter()))
            .chain(source.iter().flat_map(|cell| cell.field.evidence.iter()))
            .collect();
        let evidence: BTreeSet<_> = projected.field.evidence.iter().collect();
        if evidence != expected_evidence || evidence.len() != projected.field.evidence.len() {
            return Err(invalid("projection.evidence"));
        }
        let property = validate_projected_cell_snapshot(
            &read,
            admission,
            projected,
            input.scope,
            input.valid_time,
            &now,
        )
        .await?;
        if let Some(fixed) = fixed.get(&key) {
            if fixed.field.cell != projected.field.cell {
                return Err(invalid("projection.fixed"));
            }
        }
        validate_cell(
            projected,
            &property,
            facts,
            source,
            fixed.contains_key(&key),
            final_result,
        )?;
    }
    Ok(())
}

fn validate_cell(
    projected: &ProjectedCell,
    property: &Property,
    assertions: &[&Assertion],
    sources: &[&ProjectedCell],
    fixed: bool,
    final_result: bool,
) -> Result<(), Error> {
    let mut positive = Vec::new();
    let mut negative = Vec::new();
    for assertion in assertions {
        let Claim::Attribute(claim) = &assertion.claim else {
            continue;
        };
        match assertion.polarity {
            Polarity::Positive => positive.push(&claim.value),
            Polarity::Negative => negative.push(&claim.value),
        }
    }
    for source in sources {
        if let Cell::Known { value } = &source.field.cell {
            positive.extend(projected_values(property, value)?);
        }
    }
    match &projected.field.cell {
        Cell::Known { value } => {
            let values = projected_values(property, value)?;
            if values.is_empty()
                || values.iter().any(|value| !positive.contains(value))
                || ((final_result || property.cardinality.maximum != Some(1))
                    && positive.iter().any(|value| !values.contains(value)))
                || (final_result
                    && (negative.iter().any(|value| values.contains(value))
                        || values.len() < property.cardinality.minimum as usize
                        || property
                            .cardinality
                            .maximum
                            .is_some_and(|maximum| values.len() > maximum as usize)))
            {
                return Err(invalid("projection.known.witness"));
            }
        }
        Cell::Conflicted { assertions: refs } => {
            if refs.iter().any(|reference| {
                !assertions
                    .iter()
                    .any(|assertion| assertion.reference == *reference)
            }) {
                return Err(invalid("projection.conflict.assertions"));
            }
            // The guest chooses a sufficient conflict proof; all evidence and dependencies remain.
            let mut witnesses = Vec::new();
            let mut exclusions = Vec::new();
            for assertion in assertions
                .iter()
                .filter(|assertion| refs.contains(&assertion.reference))
            {
                let Claim::Attribute(claim) = &assertion.claim else {
                    continue;
                };
                match assertion.polarity {
                    Polarity::Positive => witnesses.push(&claim.value),
                    Polarity::Negative => exclusions.push(&claim.value),
                }
            }
            for source in sources {
                if let Cell::Known { value } = &source.field.cell {
                    witnesses.extend(projected_values(property, value)?);
                }
            }
            let opposing = witnesses.iter().any(|value| exclusions.contains(value));
            let over_cardinality = property.cardinality.maximum.is_some_and(|maximum| {
                let mut unique = Vec::new();
                for value in &witnesses {
                    if !unique.contains(value) {
                        unique.push(*value);
                    }
                    if unique.len() > maximum as usize {
                        return true;
                    }
                }
                false
            });
            if !opposing && !over_cardinality {
                return Err(invalid("projection.conflict.witness"));
            }
        }
        Cell::Unknown { .. } | Cell::SourceUnavailable { .. } => {
            if !positive.is_empty()
                || (!fixed
                    && !sources
                        .iter()
                        .any(|source| source.field.cell == projected.field.cell))
            {
                return Err(invalid("projection.unknown.witness"));
            }
        }
    }
    Ok(())
}

fn index(cells: &[ProjectedCell]) -> Result<BTreeMap<Key, &ProjectedCell>, Error> {
    let mut result = BTreeMap::new();
    for cell in cells {
        if result.insert(key(cell), cell).is_some() {
            return Err(invalid("projection.cells"));
        }
    }
    Ok(result)
}

fn key(cell: &ProjectedCell) -> Key {
    (cell.subject.clone(), cell.field.property.clone())
}
fn invalid(field: &str) -> Error {
    FactFailure::Structural {
        field: FieldPath(field.split('.').map(str::to_owned).collect()),
    }
    .into()
}
