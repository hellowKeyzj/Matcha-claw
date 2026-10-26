use tokio_util::sync::CancellationToken;
use world_protocol::{
    facts::{Assertion, AssertionOrigin, AssertionStatus, FactFailure},
    ids::{AssertionId, Revision},
    time::ValidTime,
};

use crate::{authorization::Admission, facts::support, store::WorldTransaction};

use super::{
    Error,
    admission::{cancelled, recorded_time},
    impact::authorize,
    persist,
    read::assertion_head,
    status::revision_impact,
};

/// Copies only durable source history. Callers already hold every affected identity influence lock.
pub(super) async fn retain_outside(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    original: &Assertion,
    removed: &ValidTime,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Vec<Assertion>, Error> {
    if !matches!(original.origin, AssertionOrigin::Source { .. })
        || !matches!(
            original.status,
            AssertionStatus::Accepted | AssertionStatus::Candidate
        )
    {
        return Ok(Vec::new());
    }
    let mut retained = Vec::new();
    for valid_time in difference(&original.valid_time, removed) {
        cancelled(cancellation)?;
        let digest = crate::definitions::canonical_digest(&(
            "world.source.retained-interval.v1",
            &original.reference,
            &valid_time,
        ))?;
        let mut next = original.clone();
        next.reference.id = AssertionId::try_new(digest.as_str().replace(':', "-"))
            .map_err(|_| FactFailure::InternalFault)?;
        next.reference.revision = Revision(1);
        next.valid_time = valid_time;
        next.supersedes = None;
        next.superseded_at = None;
        next.recorded_at = recorded_time(tx).await?;
        let impact = revision_impact(tx, admission, &next, &next.recorded_at).await?;
        if let Some(head) = assertion_head(tx, &next.reference.id).await? {
            return Err(FactFailure::RevisionConflict {
                expected: Revision(0),
                actual: head.reference.revision,
            }
            .into());
        }
        let decision = authorize(tx, admission, &impact, &next.recorded_at).await?;
        persist::assertion(tx, &next, &decision).await?;
        support::invalidate(
            tx,
            &[],
            std::slice::from_ref(&next),
            &[],
            &[],
            budget,
            cancellation,
            &next.recorded_at,
        )
        .await?;
        retained.push(next);
    }
    Ok(retained)
}

fn difference(original: &ValidTime, removed: &ValidTime) -> Vec<ValidTime> {
    if original.to.as_ref().is_some_and(|end| end <= &removed.from)
        || removed.to.as_ref().is_some_and(|end| end <= &original.from)
    {
        return vec![original.clone()];
    }
    let mut result = Vec::with_capacity(2);
    if original.from < removed.from {
        result.push(ValidTime {
            from: original.from.clone(),
            to: Some(removed.from.clone()),
        });
    }
    if let Some(end) = &removed.to {
        if original
            .to
            .as_ref()
            .is_none_or(|original_end| end < original_end)
        {
            result.push(ValidTime {
                from: end.clone(),
                to: original.to.clone(),
            });
        }
    }
    result
}
