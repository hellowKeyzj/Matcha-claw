use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::AccessMode,
    facts::{Assertion, AssertionStatus, FactFailure, ObservationDraft},
    failure::FieldPath,
    ids::{AssertionRef, ResourceRef, Revision},
};

use crate::{
    authorization::{self, Admission},
    facts::support,
    identity,
    store::WorldTransaction,
};

use super::{
    Error,
    admission::{cancelled, recorded_time},
    impact::{authorize, observation_impact},
    persist,
    read::{assertion_head, claim_subjects, read_assertion, same_world},
};

/// Withdraws the entire valid interval. Partial remapping must preserve the remaining intervals explicitly.
pub(crate) async fn withdraw_assertion(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    expected: &AssertionRef,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    append_status(
        tx,
        admission,
        expected,
        AssertionStatus::Withdrawn,
        budget,
        cancellation,
    )
    .await
}

pub(crate) async fn reject_assertion(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    expected: &AssertionRef,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    append_status(
        tx,
        admission,
        expected,
        AssertionStatus::Rejected,
        budget,
        cancellation,
    )
    .await
}

async fn append_status(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    expected: &AssertionRef,
    status: AssertionStatus,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    cancelled(cancellation)?;
    tx.require_domain(
        &world_protocol::ids::WriterDomain::try_new("facts").expect("facts writer domain"),
    )?;
    same_world(tx, &expected.world)?;
    let resource = ResourceRef::Assertion {
        id: expected.id.clone(),
    };
    let access: Vec<_> = admission
        .impact()
        .access
        .iter()
        .filter(|access| {
            (access.resources.is_empty() || access.resources.contains(&resource))
                && access.modes.contains(&AccessMode::Write)
        })
        .cloned()
        .collect();
    if access.is_empty() {
        return Err(FactFailure::AccessDenied.into());
    }
    let now = recorded_time(tx).await?;
    authorize(
        tx,
        admission,
        &authorization::actual_impact(
            access,
            vec![world_protocol::expression::Effect::Pure],
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?,
        &now,
    )
    .await?;
    let old = read_assertion(tx, expected)
        .await?
        .ok_or_else(|| FactFailure::Structural {
            field: FieldPath(vec!["assertion".into()]),
        })?;
    let impact = revision_impact(tx, admission, &old, &now).await?;
    let _ranges = support::lock_assertion_ranges(tx, &[(&old.claim, &old.origin)]).await?;
    identity::touch_influence(
        tx,
        &claim_subjects(&old.claim).into_iter().collect::<Vec<_>>(),
    )
    .await?;
    let head = assertion_head(tx, &expected.id)
        .await?
        .ok_or_else(|| FactFailure::Structural {
            field: FieldPath(vec!["assertion".into()]),
        })?;
    if head.reference != *expected {
        return Err(FactFailure::RevisionConflict {
            expected: expected.revision,
            actual: head.reference.revision,
        }
        .into());
    }
    if old.status == status {
        return Ok(old);
    }
    if !matches!(
        old.status,
        AssertionStatus::Accepted | AssertionStatus::Candidate
    ) || (status == AssertionStatus::Rejected && old.status != AssertionStatus::Candidate)
    {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["status".into()]),
        }
        .into());
    }
    let mut next = old.clone();
    next.reference.revision = Revision(
        expected
            .revision
            .0
            .checked_add(1)
            .ok_or(FactFailure::InternalFault)?,
    );
    next.supersedes = Some(expected.clone());
    next.superseded_at = None;
    next.status = status;
    next.recorded_at = recorded_time(tx).await?;
    let decision = authorize(tx, admission, &impact, &next.recorded_at).await?;
    cancelled(cancellation)?;
    persist::assertion(tx, &next, &decision).await?;
    support::invalidate(
        tx,
        std::slice::from_ref(&old),
        std::slice::from_ref(&next),
        &[],
        &[],
        budget,
        cancellation,
        &next.recorded_at,
    )
    .await?;
    cancelled(cancellation)?;
    Ok(next)
}

pub(super) async fn revision_impact(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    old: &Assertion,
    now: &world_protocol::time::Timestamp,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let draft = ObservationDraft {
        claim: old.claim.clone(),
        polarity: old.polarity,
        scope: old.scope.clone(),
        valid_time: old.valid_time.clone(),
        observed_at: now.clone(),
        origin: old.origin.clone(),
        evidence: old.evidence.clone(),
        supersedes: Some(old.reference.clone()),
    };
    let mut impact = observation_impact(&old.reference.id, &draft)?;
    authorize(tx, admission, &impact, &now).await?;
    let predicate = match &old.claim {
        world_protocol::facts::Claim::Attribute(claim) => &claim.property,
        world_protocol::facts::Claim::Relation(claim) => &claim.relation_type,
    };
    let definition = crate::releases::read_definition_exact(tx, predicate)
        .await
        .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
        .ok_or_else(|| FactFailure::MissingDefinition {
            reference: predicate.clone(),
        })?;
    let mut labels = match definition.body {
        world_protocol::definitions::DefinitionBody::Property(property) => property.access_labels,
        _ => Vec::new(),
    };
    let current = match crate::releases::read_active_model(tx)
        .await
        .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
    {
        Some(model) => model
            .definitions
            .into_iter()
            .find(|definition| definition.reference.id == predicate.id),
        None => crate::definitions::read_definition_head(tx, &predicate.id).await?,
    };
    if let Some(definition) = current {
        if let world_protocol::definitions::DefinitionBody::Property(property) = definition.body {
            labels.extend(property.access_labels);
        }
    }
    for reference in &old.evidence {
        let evidence = super::read::read_evidence(tx, reference)
            .await?
            .ok_or_else(|| FactFailure::EvidenceMissing {
                reference: reference.clone(),
            })?;
        labels.extend(evidence.access.labels);
        impact
            .source_ids
            .push(evidence.locator.source_version.source_id);
    }
    impact = authorization::actual_impact(
        impact.access,
        impact.effects,
        labels,
        impact.state,
        impact.source_ids,
    )?;
    authorize(tx, admission, &impact, now).await?;
    Ok(impact)
}
