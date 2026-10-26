use std::{collections::{BTreeMap, BTreeSet}, future::Future};

use crate::{
    budget::BudgetDimension,
    identity::SubjectRef,
    ids::{DefinitionRef, StepId},
    query::FieldCell,
    slots::{OracleExpected, OracleFailure, OracleRequest, OracleResult},
    value::{Cell, DirtyState},
    wire,
};

fn charge(
    steps: &mut u64,
    amount: usize,
    limit: u64,
    meter: &mut impl FnMut(BudgetDimension, u64) -> Result<(), OracleFailure>,
) -> Result<(), OracleFailure> {
    *steps = steps.checked_add(amount as u64)
        .filter(|total| *total <= limit).ok_or(OracleFailure::BudgetExceeded)?;
    meter(BudgetDimension::Steps, amount as u64)
}

/// Compare protected expected material with actual typed Query pages, without granting authority.
pub async fn evaluate<C, Fut>(
    request: &OracleRequest,
    mut check: C,
    mut meter: impl FnMut(BudgetDimension, u64) -> Result<(), OracleFailure>,
) -> Result<OracleResult, OracleFailure>
where
    C: FnMut() -> Fut,
    Fut: Future<Output = Result<(), OracleFailure>>,
{
    check().await?;
    let maximum = usize::try_from(request.budget.max_bytes).unwrap_or(usize::MAX);
    let bytes = wire::encode(request, maximum).map_err(|_| OracleFailure::BudgetExceeded)?;
    meter(BudgetDimension::Bytes, bytes.len() as u64)?;
    let expected: OracleExpected = wire::decode(&request.expected, maximum)
        .map_err(|_| OracleFailure::BadFixture)?;
    if expected.fields.is_empty() {
        return Err(OracleFailure::BadFixture);
    }
    let mut steps = 0;
    let mut keys = BTreeSet::new();
    let mut required_steps = BTreeSet::new();
    for field in &expected.fields {
        check().await?;
        charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
        if field.property.world != request.world || field.property.revision.0 == 0
            || !keys.insert((&field.step_id, &field.subject, &field.property))
        {
            return Err(OracleFailure::BadFixture);
        }
        required_steps.insert(&field.step_id);
        let mut evidence = BTreeSet::new();
        for reference in &field.evidence {
            check().await?;
            charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
            if reference.world != request.world || reference.revision.0 == 0
                || !evidence.insert(reference)
            {
                return Err(OracleFailure::BadFixture);
            }
        }
        if let Cell::Conflicted { assertions } = &field.cell {
            let mut unique = BTreeSet::new();
            for reference in assertions {
                check().await?;
                charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
                if reference.world != request.world || reference.revision.0 == 0
                    || !unique.insert(reference)
                {
                    return Err(OracleFailure::BadFixture);
                }
            }
        }
    }
    let mut observed_steps = BTreeSet::new();
    let mut fields: BTreeMap<(&StepId, SubjectRef, &DefinitionRef), &FieldCell> = BTreeMap::new();
    let mut rows = 0_u64;
    for observation in &request.queries {
        check().await?;
        charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
        if !observed_steps.insert(&observation.step_id) {
            return Err(OracleFailure::SchemaMismatch);
        }
        if !required_steps.contains(&observation.step_id) {
            continue;
        }
        let page = &observation.page;
        let receipt = &page.receipt;
        if receipt.world != request.world {
            return Err(OracleFailure::SchemaMismatch);
        }
        if !receipt.coverage.complete || !receipt.coverage.missing_sources.is_empty()
            || !receipt.coverage.missing_fields.is_empty() || !receipt.coverage.gap_sources.is_empty()
            || !receipt.dirty.is_empty() || receipt.truncation.is_some()
            || page.rows.next_cursor.is_some()
        {
            return Err(OracleFailure::Unavailable);
        }
        for basis in &receipt.basis {
            check().await?;
            charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
            if basis.gap.is_some() {
                return Err(OracleFailure::Unavailable);
            }
        }
        for count in [page.rows.items.len(), page.objects.len(), page.relations.len()] {
            check().await?;
            rows = rows.checked_add(count as u64)
                .filter(|total| *total <= request.budget.max_rows).ok_or(OracleFailure::BudgetExceeded)?;
            meter(BudgetDimension::Rows, count as u64)?;
        }
        for (world, subject, cells) in page.objects.iter().map(|view| {
            (&view.object.world, SubjectRef::Object { id: view.object.id.clone() }, &view.fields)
        }).chain(page.relations.iter().map(|view| {
            (&view.relation.world, SubjectRef::Relation { id: view.relation.id.clone() }, &view.fields)
        })) {
            check().await?;
            if world != &request.world {
                return Err(OracleFailure::SchemaMismatch);
            }
            for cell in cells {
                check().await?;
                charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
                if cell.property.world != request.world || cell.property.revision.0 == 0
                    || fields.insert((&observation.step_id, subject.clone(), &cell.property), cell).is_some()
                {
                    return Err(OracleFailure::SchemaMismatch);
                }
            }
        }
    }
    let mut result = OracleResult {
        passed: true, evidence: Vec::new(), diagnostics: Vec::new(),
        evidence_satisfied: Some(0), evidence_required: Some(0),
        conflicts_detected: Some(0), conflicts_present: Some(0),
    };
    let mut satisfied = 0_u64;
    let mut required = 0_u64;
    let mut detected = 0_u64;
    let mut present = 0_u64;
    let mut verified = BTreeSet::new();
    for field in &expected.fields {
        check().await?;
        let actual = fields.get(&(&field.step_id, field.subject.clone(), &field.property))
            .ok_or(OracleFailure::Unavailable)?;
        if actual.dirty != DirtyState::Clean {
            return Err(OracleFailure::Unavailable);
        }
        let mut actual_evidence = BTreeSet::new();
        for reference in &actual.evidence {
            check().await?;
            charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
            if reference.world != request.world || reference.revision.0 == 0 {
                return Err(OracleFailure::SchemaMismatch);
            }
            actual_evidence.insert(reference);
        }
        let matches = actual.cell == field.cell;
        result.passed &= matches;
        required = required.checked_add(field.evidence.len() as u64).ok_or(OracleFailure::BudgetExceeded)?;
        for reference in &field.evidence {
            check().await?;
            charge(&mut steps, 1, request.budget.max_steps, &mut meter)?;
            if matches && actual_evidence.contains(reference) {
                satisfied = satisfied.checked_add(1).ok_or(OracleFailure::BudgetExceeded)?;
                verified.insert(reference.clone());
            } else {
                result.passed = false;
            }
        }
        if matches!(field.cell, Cell::Conflicted { .. }) {
            present = present.checked_add(1).ok_or(OracleFailure::BudgetExceeded)?;
            if matches {
                detected = detected.checked_add(1).ok_or(OracleFailure::BudgetExceeded)?;
            }
        }
    }
    check().await?;
    result.evidence = verified.into_iter().collect();
    result.evidence_satisfied = Some(satisfied);
    result.evidence_required = Some(required);
    result.conflicts_detected = Some(detected);
    result.conflicts_present = Some(present);
    Ok(result)
}
