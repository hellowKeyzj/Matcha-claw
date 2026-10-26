use std::collections::BTreeSet;

use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::Decision,
    definitions::DefinitionBody,
    facts::{
        Assertion, AssertionOrigin, AssertionStatus, Claim, Evidence, FactFailure,
        ObservationDraft, SourceAuthority,
    },
    failure::FieldPath,
    identity::{IdentityReceipt, SubjectRef},
    ids::{AssertionId, AssertionRef, ResourceRef, Revision},
    provenance::{ConclusionSupport, ReadDependency, SupportDeltaProposal},
    time::Timestamp,
};

use crate::{
    authorization::Admission, definitions, extensions::invocation::CallBudget, facts::support,
    identity, store::WorldTransaction,
};

use super::{
    Error,
    authority::validate_authority,
    impact::{authorize, observation_impact, resource_read_impact},
    persist,
    read::{
        assertion_head, claim_subjects, decode, encode, peek_assertion_head, read_assertion,
        revision,
    },
    require_evidence,
    revision::candidate,
};

pub(crate) async fn lock_observation_batch(
    tx: &WorldTransaction<'_>,
    drafts: &[(AssertionId, ObservationDraft)],
) -> Result<(), Error> {
    let mut previous = Vec::new();
    for (id, _) in drafts {
        if let Some(head) = peek_assertion_head(tx, id).await? {
            previous.push(head);
        }
    }
    let claims: Vec<_> = drafts
        .iter()
        .map(|(_, draft)| (&draft.claim, &draft.origin))
        .chain(
            previous
                .iter()
                .map(|assertion| (&assertion.claim, &assertion.origin)),
        )
        .collect();
    support::lock_assertion_ranges(tx, &claims).await?;
    let subjects: BTreeSet<_> = claims
        .iter()
        .flat_map(|(claim, _)| claim_subjects(claim))
        .collect();
    identity::touch_influence(tx, &subjects.into_iter().collect::<Vec<_>>()).await?;
    for old in previous {
        if peek_assertion_head(tx, &old.reference.id)
            .await?
            .as_ref()
            .map(|head| &head.reference)
            != Some(&old.reference)
        {
            return Err(FactFailure::RevisionConflict {
                expected: old.reference.revision,
                actual: peek_assertion_head(tx, &old.reference.id)
                    .await?
                    .map_or(Revision(0), |head| head.reference.revision),
            }
            .into());
        }
    }
    Ok(())
}

/// Only this reducer turns an observation into a fact. The caller owns the single S03 transaction.
pub(crate) async fn admit_observation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: AssertionId,
    draft: ObservationDraft,
    supports: Option<&SupportDeltaProposal>,
    dependencies: &[ReadDependency],
    identity_receipts: &[IdentityReceipt],
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    admit(
        tx,
        admission,
        id,
        draft,
        supports,
        dependencies,
        identity_receipts,
        None,
        None,
        None,
        None,
        None,
        budget,
        cancellation,
    )
    .await
}

pub(crate) async fn admit_extracted_observation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: AssertionId,
    proof: &crate::owner::DraftObservation,
    recorded: &crate::generation::RecordedGeneration,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    admit(
        tx, admission, id, proof.draft().clone(), None, &[], &[], None, None,
        None, None, Some((proof, recorded)), budget, cancellation,
    ).await
}

pub(crate) async fn admit_mapped_observation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: AssertionId,
    mapped: &crate::sources::mapping::MappedObservation<'_>,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Vec<Assertion>, Error> {
    let assertion = admit(
        tx,
        admission,
        id,
        mapped.draft().clone(),
        None,
        mapped.dependencies(),
        mapped.receipts(),
        None,
        Some(mapped),
        None,
        None,
        None,
        budget,
        cancellation,
    )
    .await?;
    let mut changed = Vec::new();
    if let Some(previous) = &assertion.supersedes {
        let original = read_assertion(tx, previous)
            .await?
            .ok_or(FactFailure::InternalFault)?;
        if original.valid_time != assertion.valid_time {
            changed = super::temporal::retain_outside(
                tx,
                admission,
                &original,
                &assertion.valid_time,
                budget,
                cancellation,
            )
            .await?;
        }
    }
    changed.insert(0, assertion);
    cancelled(cancellation)?;
    Ok(changed)
}

/// Publication consumes a source-owned witness; arbitrary branch drafts never enter canonical facts.
pub(crate) async fn admit_branch_observation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    observation: &crate::sources::sync::BranchObservation<'_>,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Vec<Assertion>, Error> {
    let assertion = admit(
        tx,
        admission,
        observation.id().clone(),
        observation.draft().clone(),
        None,
        observation.dependencies(),
        observation.receipts(),
        None,
        None,
        Some(observation),
        None,
        None,
        budget,
        cancellation,
    )
    .await?;
    let mut changed = Vec::new();
    if let Some(previous) = &assertion.supersedes {
        let original = read_assertion(tx, previous)
            .await?
            .ok_or(FactFailure::InternalFault)?;
        if original.valid_time != assertion.valid_time {
            changed = super::temporal::retain_outside(
                tx,
                admission,
                &original,
                &assertion.valid_time,
                budget,
                cancellation,
            )
            .await?;
        }
    }
    changed.insert(0, assertion);
    cancelled(cancellation)?;
    Ok(changed)
}

pub(crate) async fn admit_remapped_observation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: AssertionId,
    remapped: &identity::RemappedObservation<'_>,
    supports: Option<&SupportDeltaProposal>,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    admit(
        tx,
        admission,
        id,
        remapped.draft().clone(),
        supports,
        &[],
        &[],
        Some(remapped.original()),
        None,
        None,
        None,
        None,
        budget,
        cancellation,
    )
    .await
}

pub(super) async fn admit_derivation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: AssertionId,
    draft: ObservationDraft,
    supports: &SupportDeltaProposal,
    derived: &crate::query::RuleDerivation,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    admit(
        tx, admission, id, draft, Some(supports), derived.dependencies(), &[], None, None,
        None, Some(derived), None, budget, cancellation,
    ).await
}

async fn admit(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: AssertionId,
    mut draft: ObservationDraft,
    supports: Option<&SupportDeltaProposal>,
    dependencies: &[ReadDependency],
    identity_receipts: &[IdentityReceipt],
    inherited: Option<&Assertion>,
    mapped: Option<&crate::sources::mapping::MappedObservation<'_>>,
    branched: Option<&crate::sources::sync::BranchObservation<'_>>,
    derived: Option<&crate::query::RuleDerivation>,
    extracted: Option<(&crate::owner::DraftObservation, &crate::generation::RecordedGeneration)>,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Assertion, Error> {
    cancelled(cancellation)?;
    tx.require_domain(
        &world_protocol::ids::WriterDomain::try_new("facts").expect("facts writer domain"),
    )?;
    if matches!(draft.origin, AssertionOrigin::Source { .. })
        && inherited.is_none()
        && mapped.is_none()
        && branched.is_none()
    {
        return Err(FactFailure::AccessDenied.into());
    }
    if matches!(draft.origin, AssertionOrigin::Derived {})
        && (inherited.is_none() && derived.is_none()
            || derived.is_some() && (!draft.evidence.is_empty() || draft.supersedes.is_some()))
    {
        return Err(FactFailure::AccessDenied.into());
    }
    if let Some((proof, recorded)) = extracted {
        let request = recorded.request();
        let receipt = recorded.receipt();
        if proof.reference().world != *tx.world()
            || request.world != *tx.world()
            || request.run_id != proof.reference().run_id
            || request != proof.request()
            || proof.draft() != &draft
            || super::observation_id(tx.world(), &draft)? != id
            || !matches!(&draft.origin, AssertionOrigin::Extraction { run_id, model_call_id: Some(model_call_id) }
                if run_id == &request.run_id && model_call_id == proof.model_call_id())
            || receipt.id != *proof.model_call_id()
            || receipt.binding != request.binding
            || receipt.prompt_digest != request.prompt.digest
            || receipt.context_digests != request.context.iter().map(|blob| blob.digest.clone()).collect::<Vec<_>>()
            || receipt.state != world_protocol::generation::GenerationState::Completed
            || receipt.delivery_uncertain
            || receipt.completed_at.as_ref().is_none_or(|at| at < &receipt.started_at)
        {
            return Err(FactFailure::Structural {
                field: FieldPath(vec!["origin".into(), "modelCallReceipt".into()]),
            }.into());
        }
    }
    let mut now = recorded_time(tx).await?;
    authorize(tx, admission, &observation_impact(&id, &draft)?, &now).await?;
    let branch = if let Some(observation) = branched {
        let reference = observation.branch();
        if reference.world != *tx.world()
            || observation.draft() != &draft
            || observation.id() != &id
            || draft.supersedes.is_some()
            || !matches!(draft.origin, AssertionOrigin::Source { .. })
        {
            return Err(FactFailure::AccessDenied.into());
        }
        Some(
            crate::releases::read_branch_revision(tx, reference)
                .await
                .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
                .ok_or(FactFailure::AccessDenied)?,
        )
    } else {
        None
    };
    if let Some(original) = inherited {
        let impact = resource_read_impact(
            ResourceRef::Assertion {
                id: original.reference.id.clone(),
            },
            Vec::new(),
            &original.scope,
            Some(&original.valid_time),
            Vec::new(),
            None,
        )?;
        authorize(tx, admission, &impact, &now).await?;
        let exact = read_assertion(tx, &original.reference)
            .await?
            .ok_or(FactFailure::AccessDenied)?;
        if exact != *original
            || original.scope != draft.scope
            || original.polarity != draft.polarity
            || original.origin != draft.origin
            || original.evidence != draft.evidence
            || draft.supersedes.is_some()
            || !definitions::valid_time_contains(&original.valid_time, &draft.valid_time)
            || !matches!(
                original.status,
                AssertionStatus::Accepted | AssertionStatus::Candidate
            )
        {
            return Err(FactFailure::AccessDenied.into());
        }
    }
    let observed_head = peek_assertion_head(tx, &id).await?;
    let mut claims = vec![(&draft.claim, &draft.origin)];
    if let Some(previous) = &observed_head {
        claims.push((&previous.claim, &previous.origin));
    }
    let (mut datasets, partitions) = support::assertion_ranges(tx, &claims).await?;
    if let Some(proposal) = supports {
        datasets.extend(crate::query::rule_ranges(tx, &proposal.upserts).await?);
    }
    datasets.sort();
    datasets.dedup();
    let _ranges = support::lock_ranges(tx, &datasets, &partitions).await?;
    if let Some(observation) = branched {
        observation
            .recheck(tx, admission, &now, budget, cancellation)
            .await
            .map_err(branch_failure)?;
    }
    let mut subjects = claim_subjects(&draft.claim);
    if let Some(previous) = &observed_head {
        subjects.extend(claim_subjects(&previous.claim));
    }
    let subjects: Vec<_> = subjects.into_iter().collect();
    identity::recheck_receipts(tx, identity_receipts, &subjects).await?;
    identity::touch_influence(tx, &subjects).await?;
    let previous = assertion_head(tx, &id).await?;
    if previous.as_ref().map(|old| &old.reference)
        != observed_head.as_ref().map(|old| &old.reference)
    {
        return Err(FactFailure::RevisionConflict {
            expected: observed_head
                .as_ref()
                .map_or(Revision(0), |old| old.reference.revision),
            actual: previous
                .as_ref()
                .map_or(Revision(0), |old| old.reference.revision),
        }
        .into());
    }
    if inherited.is_some() && previous.is_some() {
        return Err(FactFailure::AccessDenied.into());
    }
    if let Some(mapped) = mapped {
        let AssertionOrigin::Source { binding, .. } = &draft.origin else {
            return Err(FactFailure::AccessDenied.into());
        };
        if binding != mapped.binding()
            || &draft != mapped.draft()
            || mapped
                .expected_assertion_id()
                .map_err(|failure| FactFailure::SourceMapping { failure })?
                != id
            || previous.as_ref().map(|old| &old.reference) != mapped.expected_source_head(&id)
        {
            return Err(FactFailure::AccessDenied.into());
        }
        if let Some(previous) = &previous {
            draft.supersedes = Some(previous.reference.clone());
        }
    }
    if let Some(observation) = branched {
        if previous.as_ref().map(|old| &old.reference) != observation.expected_source_head(&id) {
            return Err(FactFailure::RevisionConflict {
                expected: observation
                    .expected_source_head(&id)
                    .map_or(Revision(0), |reference| reference.revision),
                actual: previous
                    .as_ref()
                    .map_or(Revision(0), |old| old.reference.revision),
            }
            .into());
        }
        if let Some(previous) = &previous {
            draft.supersedes = Some(previous.reference.clone());
        }
    }
    let next = previous
        .as_ref()
        .map_or(Some(1), |old| old.reference.revision.0.checked_add(1))
        .ok_or_else(|| FactFailure::Structural {
            field: FieldPath(vec!["revision".into()]),
        })?;
    let reference = AssertionRef {
        world: tx.world().clone(),
        id,
        revision: Revision(next),
    };
    let mut assertion = candidate(reference, draft.clone(), now.clone(), previous.as_ref())?;
    let read = match &branch {
        Some(branch) => super::claim::ClaimRead::Branch(tx, branch),
        None => super::claim::ClaimRead::transaction(tx).await?,
    };
    let claim_definition = super::claim::validate_claim(
        &read,
        &assertion.claim,
        &assertion.scope,
        &assertion.valid_time,
    )
    .await?;
    let mut labels = match &claim_definition.body {
        DefinitionBody::Property(property) => property.access_labels.clone(),
        _ => Vec::new(),
    };
    authorize_labels(tx, admission, &assertion, &labels, &now).await?;
    let evidence = validate_supporting_evidence(tx, admission, &assertion, &now).await?;
    for item in &evidence {
        if mapped.is_some_and(|mapped| !mapped.evidence().contains(item))
            || branched.is_some_and(|observation| {
                !observation.evidence().contains(item)
                    || item.locator.source_version != observation.source_version().reference
            })
            || extracted.is_some_and(|(proof, _)| {
                !proof.evidence().contains(item)
                    || !proof.sources().contains(&item.locator.source_version)
            })
        {
            return Err(FactFailure::AccessDenied.into());
        }
        labels.extend(item.access.labels.clone());
    }
    labels.sort();
    labels.dedup();
    authorize_labels(tx, admission, &assertion, &labels, &now).await?;
    match &assertion.origin {
        AssertionOrigin::Source {
            binding, authority, ..
        } => {
            let binding_definition = read.definition(binding, &assertion.valid_time).await?;
            let authority: SourceAuthority = if let Some(observation) = branched {
                crate::sources::mapping::read_branch_authority(
                    tx,
                    observation.branch(),
                    binding,
                    authority,
                )
                .await?
                .ok_or_else(|| FactFailure::SourceAuthorityDenied {
                    binding: binding.clone(),
                })?
            } else {
                let approved_revision = revision(authority.revision.0)?;
                let row = tx.query_opt(
                    "SELECT r.body,r.status FROM world_source_authority_head h JOIN world_source_authority_revision r USING(tenant_id,world_id,policy_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.policy_id=$3 AND h.revision=$4 FOR SHARE OF h",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &authority.policy_id.as_str(), &approved_revision],
                ).await?.ok_or_else(|| FactFailure::SourceAuthorityDenied { binding: binding.clone() })?;
                if row.get::<_, String>("status") != "approved" {
                    return Err(FactFailure::SourceAuthorityDenied {
                        binding: binding.clone(),
                    }
                    .into());
                }
                decode(row.get("body"))?
            };
            let DefinitionBody::SourceBinding(source) = &binding_definition.body else {
                return Err(FactFailure::SourceAuthorityDenied {
                    binding: binding.clone(),
                }
                .into());
            };
            let scopes = read
                .scopes(&[
                    assertion.scope.clone(),
                    binding_definition.scope.clone(),
                    authority.scope.clone(),
                    source.scope.clone(),
                ])
                .await?;
            let relation = match &claim_definition.body {
                DefinitionBody::RelationType(relation) => Some(relation),
                _ => None,
            };
            validate_authority(
                &assertion,
                &binding_definition,
                &authority,
                &scopes,
                relation,
            )?;
            let impact = resource_read_impact(
                ResourceRef::Source {
                    id: source.source_id.clone(),
                },
                vec![binding.clone()],
                &assertion.scope,
                Some(&assertion.valid_time),
                Vec::new(),
                Some(source.source_id.clone()),
            )?;
            authorize(tx, admission, &impact, &now).await?;
            super::source::validate_source_evidence(&assertion, source, &evidence)?;
            if let Some(previous) = previous
                .as_ref()
                .filter(|_| mapped.is_some() || branched.is_some())
            {
                super::source::validate_source_revision(
                    tx, admission, previous, &draft, source, &evidence, &now,
                )
                .await?;
            }
            let source_version = mapped
                .map(|mapped| &mapped.request().source_version)
                .or_else(|| branched.map(|observation| observation.source_version()));
            if let Some(source_version) = source_version {
                let reference = evidence.first().ok_or_else(|| FactFailure::Structural {
                    field: FieldPath(vec!["evidence".into()]),
                })?;
                let durable = crate::content::read_source_version_in_transaction(
                    tx,
                    &source_version.reference,
                )
                .await
                .map_err(|error| {
                    super::evidence_write::material_error(error, &reference.reference)
                })?;
                if durable != *source_version {
                    return Err(FactFailure::AccessDenied.into());
                }
            }
            if inherited.is_none() {
                super::source::validate_source_basis(
                    &assertion,
                    source,
                    &evidence,
                    dependencies,
                    identity_receipts,
                )?;
                if branched.is_none() {
                    crate::sources::mapping::recheck_dependencies(tx, dependencies).await?;
                }
            }
            assertion.status = AssertionStatus::Accepted;
        }
        AssertionOrigin::HumanObservation { invocation_id } => {
            if inherited.is_none()
                && (invocation_id != &admission.invocation().id
                    || !matches!(
                        admission.invocation().actor,
                        world_protocol::authorization::Actor::Human { .. }
                    ))
            {
                return Err(FactFailure::AccessDenied.into());
            }
            assertion.status = AssertionStatus::Accepted;
        }
        AssertionOrigin::Derived {} => {
            validate_derivation_supports(&read, admission, &assertion, supports).await?;
            if let Some(derived) = derived {
                super::derived::require_conclusion(derived, &assertion)?;
            }
            // The staged revision is invisible until accept + rooted-support checks succeed below.
            assertion.status = AssertionStatus::Accepted;
        }
        AssertionOrigin::Extraction {
            run_id,
            model_call_id,
        } => {
            if inherited.is_none() && extracted.is_none() {
                crate::owner::require_run_invocation(tx, admission, run_id)
                    .await
                    .map_err(|source| {
                        let reason = match &source.safe_failure().details {
                            world_protocol::api::ApiFailure::Authorization(_) => {
                                FactFailure::AccessDenied
                            }
                            world_protocol::api::ApiFailure::Operation(
                                world_protocol::operation::OperationFailure::Commit(failure),
                            ) => FactFailure::Commit {
                                failure: failure.clone(),
                            },
                            _ => FactFailure::Structural {
                                field: FieldPath(vec!["origin".into(), "run".into()]),
                            },
                        };
                        Error::caused_by(reason, source)
                    })?;
                if model_call_id.is_some() {
                    return Err(FactFailure::Structural {
                        field: FieldPath(vec!["origin".into(), "modelCallReceipt".into()]),
                    }
                    .into());
                }
            }
            assertion.status = AssertionStatus::Candidate;
        }
    }
    if let Some(original) = inherited {
        assertion.status = original.status;
    }
    if assertion.status == AssertionStatus::Candidate
        && previous
            .as_ref()
            .is_some_and(|previous| previous.status == AssertionStatus::Accepted)
    {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["supersedes".into()]),
        }
        .into());
    }
    if supports.is_some() && !matches!(assertion.origin, AssertionOrigin::Derived { .. }) {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["supports".into()]),
        }
        .into());
    }
    cancelled(cancellation)?;
    now = recorded_time(tx).await?;
    assertion.recorded_at = now.clone();
    let decision = authorize_labels(tx, admission, &assertion, &labels, &now).await?;
    persist::assertion(tx, &assertion, &decision).await?;
    support::invalidate(
        tx,
        previous.as_slice(),
        std::slice::from_ref(&assertion),
        &[],
        &[],
        budget,
        cancellation,
        &now,
    )
    .await?;
    if let Some(proposal) = supports {
        support::accept(tx, proposal, admission, budget, cancellation, &now).await?;
        require_rooted_derivation(
            tx, &assertion, proposal, derived.is_some(), budget, cancellation,
        ).await?;
    }
    let (kind, subject_kind, subject_id) = match &assertion.claim {
        Claim::Attribute(claim) => match &claim.subject {
            SubjectRef::Object { id } => ("attribute", "object", id.as_str()),
            SubjectRef::Relation { id } => ("attribute", "relation", id.as_str()),
        },
        Claim::Relation(claim) => ("relation", "relation", claim.relation_id.as_str()),
    };
    tx.execute(
        "INSERT INTO world_observation(tenant_id,world_id,observation_id,run_id,claim_kind,subject_kind,subject_id,scope_id,status,body,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::timestamptz)",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &uuid::Uuid::new_v4().to_string(),
          &match &assertion.origin { AssertionOrigin::Extraction { run_id, .. } => Some(run_id.as_str()), _ => None },
          &kind, &subject_kind, &subject_id, &assertion.scope.as_str(),
          &if assertion.status == AssertionStatus::Candidate { "candidate" } else { "admitted" }, &encode(&draft)?, &now.as_str()],
    ).await?;
    cancelled(cancellation)?;
    Ok(assertion)
}

pub(super) async fn attach_derivation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    assertion: &Assertion,
    proposal: &SupportDeltaProposal,
    derived: &crate::query::RuleDerivation,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<AssertionRef, Error> {
    cancelled(cancellation)?;
    tx.require_domain(
        &world_protocol::ids::WriterDomain::try_new("facts").expect("facts writer domain"),
    )?;
    if assertion.status != AssertionStatus::Accepted
        || !matches!(assertion.origin, AssertionOrigin::Derived {})
        || !assertion.evidence.is_empty()
    {
        return Err(FactFailure::AccessDenied.into());
    }
    super::derived::require_conclusion(derived, assertion)?;
    let claims = [(&assertion.claim, &assertion.origin)];
    support::lock_assertion_ranges(tx, &claims).await?;
    crate::query::lock_rule_ranges(tx, &proposal.upserts).await?;
    let subjects: Vec<_> = claim_subjects(&assertion.claim).into_iter().collect();
    identity::touch_influence(tx, &subjects).await?;
    if assertion_head(tx, &assertion.reference.id).await?.as_ref() != Some(assertion) {
        return Err(FactFailure::RevisionConflict {
            expected: assertion.reference.revision,
            actual: peek_assertion_head(tx, &assertion.reference.id).await?
                .map_or(Revision(0), |head| head.reference.revision),
        }.into());
    }
    let read = super::claim::ClaimRead::transaction(tx).await?;
    let definition = super::claim::validate_claim(
        &read, &assertion.claim, &assertion.scope, &assertion.valid_time,
    ).await?;
    let labels = match definition.body {
        DefinitionBody::Property(property) => property.access_labels,
        _ => Vec::new(),
    };
    let now = recorded_time(tx).await?;
    authorize_labels(tx, admission, assertion, &labels, &now).await?;
    validate_supporting_evidence(tx, admission, assertion, &now).await?;
    validate_derivation_supports(&read, admission, assertion, Some(proposal)).await?;
    support::accept(tx, proposal, admission, budget, cancellation, &now).await?;
    require_rooted_derivation(tx, assertion, proposal, true, budget, cancellation).await?;
    cancelled(cancellation)?;
    Ok(assertion.reference.clone())
}

async fn validate_derivation_supports(
    read: &super::claim::ClaimRead<'_, '_>,
    admission: &Admission,
    assertion: &Assertion,
    supports: Option<&SupportDeltaProposal>,
) -> Result<(), Error> {
    let proposal = supports.ok_or_else(|| FactFailure::Structural {
        field: FieldPath(vec!["supports".into()]),
    })?;
    if proposal.upserts.is_empty()
        || !proposal.invalidate.is_empty()
        || !proposal.affected_watches.is_empty()
        || proposal.upserts.iter().any(|support| {
            support.conclusion != assertion.reference
                || support.scope != assertion.scope
                || support.branch_id != admission.invocation().branch_id
                || support.release_id != proposal.upserts[0].release_id
                || !definitions::valid_time_contains(&assertion.valid_time, &support.valid_time)
        })
    {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["supports".into()]),
        }.into());
    }
    for support in &proposal.upserts {
        let definition = read.definition(&support.rule, &support.valid_time).await?;
        if !matches!(definition.body, DefinitionBody::Rule(_)) {
            return Err(FactFailure::TypeMismatch {
                field: FieldPath(vec!["supports".into(), "rule".into()]),
            }.into());
        }
    }
    Ok(())
}

async fn require_rooted_derivation(
    tx: &WorldTransaction<'_>,
    assertion: &Assertion,
    proposal: &SupportDeltaProposal,
    require_upserts: bool,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let seed = &proposal.upserts[0];
    match support::resolve_transaction_interval(
        tx, &assertion.reference, &assertion.scope, &seed.release_id,
        seed.branch_id.as_ref(), budget, cancellation, &assertion.valid_time,
    ).await? {
        ConclusionSupport::Supported { supports }
            if !require_upserts || proposal.upserts.iter().all(|upsert| supports.contains(&upsert.reference)) => Ok(()),
        ConclusionSupport::Supported { .. } => Err(crate::query::QueryError::from(
            world_protocol::query::QueryFailure::BasisChanged,
        ).into()),
        ConclusionSupport::Dirty { .. } => Err(FactFailure::Provenance {
            failure: world_protocol::provenance::ProvenanceFailure::Dirty { watches: Vec::new() },
        }.into()),
        ConclusionSupport::Unsupported => Err(FactFailure::Provenance {
            failure: world_protocol::provenance::ProvenanceFailure::MissingPremise,
        }.into()),
    }
}

pub(super) fn branch_failure(source: crate::sources::sync::SyncError) -> Error {
    use world_protocol::{
        operation::OperationFailure, process::HostFailure, sources::SourceFailure,
    };
    let reason = match source.host_failure() {
        HostFailure::Authorization(_) => FactFailure::AccessDenied,
        HostFailure::Operation(OperationFailure::Commit(failure)) => {
            FactFailure::Commit { failure }
        }
        HostFailure::Operation(OperationFailure::Mapping(failure)) => {
            FactFailure::SourceMapping { failure }
        }
        HostFailure::Operation(OperationFailure::Fact(failure)) => failure,
        HostFailure::Source(SourceFailure::Cancelled) => FactFailure::Cancelled,
        _ => FactFailure::InternalFault,
    };
    Error::caused_by(reason, source)
}

async fn validate_supporting_evidence(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assertion: &Assertion,
    now: &Timestamp,
) -> Result<Vec<Evidence>, Error> {
    let references: BTreeSet<_> = assertion.evidence.iter().collect();
    if references.len() != assertion.evidence.len()
        || (references.is_empty() && !matches!(assertion.origin, AssertionOrigin::Derived { .. }))
    {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["evidence".into()]),
        }
        .into());
    }
    require_evidence(
        tx,
        admission,
        &assertion.evidence,
        &assertion.scope,
        Some(&assertion.valid_time),
        now,
    )
    .await
}

async fn authorize_labels(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assertion: &Assertion,
    labels: &[String],
    now: &Timestamp,
) -> Result<Decision, Error> {
    let draft = ObservationDraft {
        claim: assertion.claim.clone(),
        polarity: assertion.polarity,
        scope: assertion.scope.clone(),
        valid_time: assertion.valid_time.clone(),
        observed_at: assertion.recorded_at.clone(),
        origin: assertion.origin.clone(),
        evidence: assertion.evidence.clone(),
        supersedes: assertion.supersedes.clone(),
    };
    let mut impact = observation_impact(&assertion.reference.id, &draft)?;
    impact = crate::authorization::actual_impact(
        impact.access,
        impact.effects,
        labels.to_vec(),
        impact.state,
        impact.source_ids,
    )?;
    authorize(tx, admission, &impact, now).await
}

pub(super) async fn recorded_time(tx: &WorldTransaction<'_>) -> Result<Timestamp, Error> {
    Ok(tx.now().await?)
}

pub(super) fn cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        return Err(FactFailure::Cancelled.into());
    }
    Ok(())
}
