use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::ActualImpact,
    facts::{Assertion, AssertionOrigin, AssertionStatus, Claim, FactFailure, ObservationDraft},
    ids::{AssertionId, AssertionRef, Digest, ResourceRef, Revision},
    provenance::{PremiseRef, ReadDependency, SupportDeltaProposal, SupportSet, SupportStatus},
    query::QueryFailure,
};

use crate::{
    authorization::{self, Admission, VerifiedInvocation},
    definitions,
    extensions::invocation::CallBudget,
    facts::support,
    query::{RuleDerivation, RuleDerivationProof},
    store::WorldTransaction,
};

use super::{
    Error, admission,
    impact::{admission_impact, resource_read_impact},
    read::peek_assertion_head,
};

/// Only the finite impact and its expected observations cross into the run basis.
pub(crate) struct DerivedPreflight {
    pub(super) impact: ActualImpact,
    pub(super) fingerprint: Digest,
    pub(super) conclusion: Option<ConclusionPlan>,
}

pub(super) struct ConclusionPlan {
    pub(super) id: AssertionId,
    pub(super) draft: ObservationDraft,
    pub(super) existing: Option<Assertion>,
    pub(super) supports: Vec<SupportSet>,
    pub(super) closure: Digest,
}

impl DerivedPreflight {
    pub(crate) fn impact(&self) -> &ActualImpact { &self.impact }
    pub(crate) fn fingerprint(&self) -> Digest { self.fingerprint.clone() }
    pub(crate) fn support_snapshot(&self) -> world_protocol::provenance::SupportSnapshot {
        let mut snapshot = world_protocol::provenance::SupportSnapshot {
            assertions: Vec::new(), evidence: Vec::new(), supports: Vec::new(), watches: Vec::new(),
        };
        if let Some(conclusion) = &self.conclusion {
            snapshot.supports = conclusion.supports.clone();
            for support in &snapshot.supports {
                if !snapshot.assertions.contains(&support.conclusion) { snapshot.assertions.push(support.conclusion.clone()); }
                for dependency in support::dependencies(support) {
                    match dependency {
                        ReadDependency::Assertion { reference } if !snapshot.assertions.contains(&reference) => snapshot.assertions.push(reference),
                        ReadDependency::Evidence { reference } if !snapshot.evidence.contains(&reference) => snapshot.evidence.push(reference),
                        _ => {}
                    }
                }
            }
        }
        snapshot
    }
}

pub(crate) async fn preflight_derivation(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    actual: &RuleDerivation,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<DerivedPreflight, Error> {
    checkpoint(budget, cancel)?;
    let execution = provenance_impact(tx, actual).await?;
    if actual.branch_model().is_some() { return super::branch::preflight(tx, verified, actual, execution, budget, cancel).await; }
    if actual.world() != tx.world() || &verified.invocation().world != tx.world()
        || actual.branch_id().is_some() || verified.invocation().branch_id.is_some()
        || actual.active_head().is_none_or(|head| head.release_id != *actual.release_id())
    {
        return Err(FactFailure::AccessDenied.into());
    }
    let mut impact = actual.read_impact().clone();
    merge(&mut impact, execution);
    let conclusion = if actual.status() == SupportStatus::Valid {
        let (claim, polarity) = actual.conclusion().ok_or(FactFailure::InternalFault)?;
        let claim = normalized_claim(claim);
        let digest = definitions::canonical_digest(&(
            "world.derived-assertion.v1", tx.world(), actual.release_id(), actual.scope(),
            actual.valid_time(), &claim, polarity,
        ))?;
        let id = AssertionId::try_new(format!("derived-{}", &digest.as_str()[7..]))
            .map_err(|source| Error::caused_by(FactFailure::InternalFault, source))?;
        let now = tx.now().await?;
        let draft = ObservationDraft {
            claim, polarity: *polarity, scope: actual.scope().clone(),
            valid_time: actual.valid_time().clone(), observed_at: now.clone(),
            origin: AssertionOrigin::Derived {}, evidence: Vec::new(), supersedes: None,
        };
        let read = resource_read_impact(
            ResourceRef::Assertion { id: id.clone() }, Vec::new(), actual.scope(),
            Some(actual.valid_time()), Vec::new(), None,
        )?;
        authorization::check_impact_read(tx, verified, &read, &now).await?;
        merge(&mut impact, read);
        let existing = peek_assertion_head(tx, &id).await?;
        if let Some(assertion) = &existing {
            if assertion.reference.world != *tx.world() || assertion.reference.id != id {
                return Err(FactFailure::InternalFault.into());
            }
            if assertion.status != AssertionStatus::Accepted
                || !matches!(assertion.origin, AssertionOrigin::Derived {})
                || !assertion.evidence.is_empty() || assertion.superseded_at.is_some()
            {
                return Err(FactFailure::AccessDenied.into());
            }
            require_conclusion(actual, assertion)?;
        }
        let predicate = match &draft.claim {
            Claim::Attribute(claim) => &claim.property,
            Claim::Relation(claim) => &claim.relation_type,
        };
        let read = resource_read_impact(
            ResourceRef::Definition { id: predicate.id.clone() }, vec![predicate.clone()],
            actual.scope(), Some(actual.valid_time()), Vec::new(), None,
        )?;
        authorization::check_impact_read(tx, verified, &read, &now).await?;
        for subject in super::claim_subjects(&draft.claim) {
            checkpoint(budget, cancel)?;
            let resource = match subject {
                world_protocol::identity::SubjectRef::Object { id } => ResourceRef::Object { id },
                world_protocol::identity::SubjectRef::Relation { id } => ResourceRef::Relation { id },
            };
            let read = resource_read_impact(
                resource, vec![predicate.clone()], actual.scope(), Some(actual.valid_time()),
                Vec::new(), None,
            )?;
            authorization::check_impact_read(tx, verified, &read, &now).await?;
        }
        let claim_impact = admission_impact(tx, &id, &draft).await?;
        let mut read = claim_impact.clone();
        for access in &mut read.access {
            access.modes = vec![world_protocol::authorization::AccessMode::Read];
        }
        read = authorization::actual_impact(read.access, read.effects, read.labels, read.state, read.source_ids)?;
        authorization::check_impact_read(tx, verified, &read, &now).await?;
        merge(&mut impact, claim_impact);
        merge(&mut impact, read);
        let reference = existing.as_ref().map_or_else(
            || AssertionRef { world: tx.world().clone(), id: id.clone(), revision: Revision(1) },
            |assertion| assertion.reference.clone(),
        );
        let mut supports = Vec::with_capacity(actual.segments().len());
        let mut read_plans = Vec::with_capacity(actual.segments().len());
        for segment in actual.segments() {
            checkpoint(budget, cancel)?;
            let prepared = support::prepare_derivation(
                tx, verified, &reference, actual.rule(), actual.arguments(), actual.scope(),
                segment.valid_time(), actual.release_id(), segment.dependencies(), budget, cancel,
            ).await?;
            let mut read_plan = prepared.clone();
            read_plan.premises = segment.read_dependencies().iter().map(|dependency| match dependency {
                ReadDependency::Assertion { reference } => PremiseRef::Assertion(reference.clone()),
                ReadDependency::Evidence { reference } => PremiseRef::Evidence(reference.clone()),
                dependency => PremiseRef::Read(dependency.clone()),
            }).collect();
            supports.push(prepared);
            read_plans.push(read_plan);
        }
        let new_assertion = if existing.is_none() {
            Some(super::candidate(reference, draft.clone(), now, None)?)
        } else {
            None
        };
        let (consumer_impact, closure) = support::derivation_impact(
            tx, verified, &read_plans, new_assertion.as_ref(), actual.watch_basis(), budget, cancel,
        ).await?;
        merge(&mut impact, consumer_impact);
        Some(ConclusionPlan { id, draft, existing, supports, closure })
    } else {
        if actual.conclusion().is_some() { return Err(FactFailure::InternalFault.into()); }
        None
    };
    let impact = normalize_impact(impact)?;
    let dependencies = actual.read_dependencies();
    let plan = conclusion.as_ref().map(|value| {
        (&value.id, &value.draft.claim, value.draft.polarity, &value.existing,
            &value.supports, &value.closure)
    });
    let fingerprint = definitions::canonical_digest(&(
        "world.derived-admission.v1", actual.world(), actual.release_id(), actual.rule(),
        actual.arguments(), actual.scope(), actual.valid_time(), actual.status(),
        actual.active_head(), actual.activation_lock_id(), actual.watch_fingerprint(),
        dependencies, plan, &impact,
    ))?;
    checkpoint(budget, cancel)?;
    Ok(DerivedPreflight { impact, fingerprint, conclusion })
}

async fn provenance_impact(tx: &WorldTransaction<'_>, actual: &RuleDerivation) -> Result<ActualImpact, Error> {
    use crate::extensions::bindings;
    use world_protocol::{authorization::{AccessMode, AccessScope}, bindings::SlotKind};
    let graph = bindings::read_graph_in_transaction(tx, actual.activation_lock_id()).await
        .map_err(|error| Error::caused_by(FactFailure::AccessDenied, error))?;
    let selected: std::collections::BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == SlotKind::Provenance)
        .map(|node| node.binding_id.clone()).collect();
    if selected.len() != 1 { return Err(FactFailure::AccessDenied.into()); }
    let root = graph.composition_order(selected.iter().next().expect("one provenance composition"))
        .map_err(|failure| Error::caused_by(FactFailure::AccessDenied, bindings::BindingError::from(failure)))?.into_iter()
        .find(|id| graph.node(id).is_ok_and(|node| node.slot == SlotKind::Provenance)).ok_or(FactFailure::AccessDenied)?;
    let closure = graph.closure_nodes(&root)
        .map_err(|failure| Error::caused_by(FactFailure::AccessDenied, bindings::BindingError::from(failure)))?;
    let mut resources = std::collections::BTreeSet::new();
    for node in closure {
        let node = graph.node(&node).map_err(|failure| Error::caused_by(FactFailure::AccessDenied, bindings::BindingError::from(failure)))?;
        resources.insert(ResourceRef::Binding { id: node.binding_id.clone() });
    }
    Ok(authorization::actual_impact(vec![AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(),
        modes: vec![AccessMode::Execute], scope: actual.scope().clone(), valid_time: None }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?)
}

pub(crate) async fn admit_derived(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    proof: RuleDerivationProof,
    expected: &Digest,
    proposal: &SupportDeltaProposal,
    run: &crate::owner::RunRecord,
    step: &crate::owner::StepRecord,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<(SupportStatus, Option<AssertionRef>), Error> {
    let actual = proof.consume(tx, admission).await?;
    let plan = preflight_derivation(tx, admission.verified(), &actual, budget, cancel).await?;
    if &plan.fingerprint != expected {
        return Err(crate::query::QueryError::from(QueryFailure::BasisChanged).into());
    }
    admission.require_impact(&plan.impact)?;
    support::check_proposal(&plan.support_snapshot(), proposal)
        .map_err(|failure| Error::from(FactFailure::Provenance { failure }))?;
    let Some(conclusion) = plan.conclusion else { return Ok((actual.status(), None)); };
    if actual.branch_model().is_some() {
        return Ok((SupportStatus::Valid, Some(super::branch::admit(tx, admission, &actual, conclusion, run, step, budget, cancel).await?)));
    }
    let mut proposal = proposal.clone();
    proposal.observed_dependencies = actual.read_dependencies().to_vec();
    let reference = if let Some(existing) = conclusion.existing {
        admission::attach_derivation(tx, admission, &existing, &proposal, &actual, budget, cancel).await?
    } else {
        admission::admit_derivation(
            tx, admission, conclusion.id, conclusion.draft, &proposal, &actual, budget, cancel,
        ).await?.reference
    };
    Ok((SupportStatus::Valid, Some(reference)))
}

pub(super) fn require_conclusion(actual: &RuleDerivation, assertion: &Assertion) -> Result<(), Error> {
    let Some((claim, polarity)) = actual.conclusion() else { return Err(FactFailure::AccessDenied.into()); };
    if actual.world() != &assertion.reference.world || actual.status() != SupportStatus::Valid
        || assertion.scope != *actual.scope()
        || assertion.valid_time != *actual.valid_time() || assertion.polarity != *polarity
        || normalized_claim(&assertion.claim) != normalized_claim(claim)
        || !matches!(assertion.origin, AssertionOrigin::Derived {}) || !assertion.evidence.is_empty()
    {
        return Err(FactFailure::AccessDenied.into());
    }
    Ok(())
}

pub(super) fn normalized_claim(claim: &Claim) -> Claim {
    let mut claim = claim.clone();
    if let Claim::Relation(relation) = &mut claim {
        relation.roles.sort_by(|a, b| (&a.role, &a.object_id).cmp(&(&b.role, &b.object_id)));
    }
    claim
}

pub(super) fn normalize_impact(impact: ActualImpact) -> Result<ActualImpact, Error> {
    let mut access = impact.access.into_iter().map(|access| {
        Ok((definitions::canonical_digest(&access)?, access))
    }).collect::<Result<Vec<_>, Error>>()?;
    access.sort_by(|left, right| left.0.cmp(&right.0));
    access.dedup_by(|left, right| left.0 == right.0);
    Ok(authorization::actual_impact(access.into_iter().map(|(_, access)| access).collect(), impact.effects,
        impact.labels, impact.state, impact.source_ids)?)
}

pub(super) fn merge(impact: &mut ActualImpact, next: ActualImpact) {
    impact.access.extend(next.access);
    impact.effects.extend(next.effects);
    impact.labels.extend(next.labels);
    impact.state.extend(next.state);
    impact.source_ids.extend(next.source_ids);
}

pub(super) fn checkpoint(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), Error> {
    admission::cancelled(cancel)?;
    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1)
        .map_err(|failure| Error::from(crate::query::QueryError::from(
            world_protocol::expression::ExpressionFailure::BudgetExceeded { dimension: failure.dimension },
        )))
}
