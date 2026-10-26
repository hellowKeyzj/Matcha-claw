use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;

use world_protocol::{
    commit::CommittedRevision,
    facts::{Assertion, Claim},
    identity::{IdentityChangeKind, IdentityChangeProposal, IdentityFailure, IdentitySnapshot, SourceAlias, SubjectRef},
    ids::{Generation, OperationId, Revision},
    provenance::ReadDependency,
    time::Timestamp,
};

use crate::{authorization::Admission, facts::assertions, store::{OutboxEvent, WorldTransaction}};
use super::{IdentityError, aliases, check_snapshot, decode, encode, get_in_transaction, overlaps, parts, records, resource, revision, subject, type_id, world};

/// Only this module constructs a prepared complete impact set. Preparation is not a commit.
pub(crate) struct PreparedIdentityChange {
    proposal: IdentityChangeProposal,
    influence: Vec<(SubjectRef, Generation)>,
    assertions: Vec<Assertion>,
}

pub(crate) async fn prepare_change(
    transaction: &WorldTransaction<'_>, proposal: IdentityChangeProposal, admission: &Admission, now: &Timestamp,
) -> Result<PreparedIdentityChange, IdentityError> {
    validate(&proposal)?;
    if &proposal.world != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
    let subjects = all_subjects(&proposal);
    let resources: Vec<_> = proposal.identities.iter().map(|identity| resource(&subject(&identity.record))).collect();
    let sources: Vec<_> = proposal.aliases.iter().map(|alias| alias.key.source_id.clone()).collect();
    super::authorize(transaction, admission, &proposal.scope, &proposal.valid_time, &resources, &sources, now).await?;
    if proposal.admission_id != admission.decision().id { return Err(IdentityFailure::PermissionDenied.into()); }
    lock_change_ranges(transaction, &proposal).await?;
    // Dataset guards precede natural-key and identity locks in every reducer.
    lock_aliases(transaction, &proposal.aliases).await?;
    let influence = records::lock_influence(transaction, &subjects).await?;
    for identity in &proposal.identities {
        check_snapshot(identity, get_in_transaction(transaction, &subject(&identity.record)).await?.as_ref())?;
    }
    check_aliases(transaction, &proposal).await?;
    let assertions = affected_assertions(transaction, &proposal).await?;
    Ok(PreparedIdentityChange { proposal, influence, assertions })
}

pub(crate) async fn apply_change(
    transaction: &mut WorldTransaction<'_>, prepared: PreparedIdentityChange, operation_id: &OperationId,
    admission: &Admission, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &CancellationToken,
) -> Result<Vec<IdentitySnapshot>, IdentityError> {
    if cancellation.is_cancelled() { return Err(IdentityFailure::Cancelled.into()); }
    let proposal = &prepared.proposal;
    if &proposal.world != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
    let subjects = all_subjects(&proposal);
    let resources: Vec<_> = proposal.identities.iter().map(|identity| resource(&subject(&identity.record))).collect();
    let sources: Vec<_> = proposal.aliases.iter().map(|alias| alias.key.source_id.clone()).collect();
    let decision = super::authorize(transaction, admission, &proposal.scope, &proposal.valid_time, &resources, &sources, now).await?;
    if proposal.admission_id != admission.decision().id { return Err(IdentityFailure::PermissionDenied.into()); }
    lock_change_ranges(transaction, proposal).await?;
    lock_aliases(transaction, &proposal.aliases).await?;
    let actual = records::lock_influence(transaction, &subjects).await?;
    if actual != prepared.influence { return Err(IdentityFailure::ImpactSetChanged.into()); }
    for identity in &proposal.identities {
        check_snapshot(identity, get_in_transaction(transaction, &subject(&identity.record)).await?.as_ref())?;
    }
    check_aliases(transaction, proposal).await?;
    let assertions = affected_assertions(transaction, proposal).await?;
    if assertions != prepared.assertions { return Err(IdentityFailure::ImpactSetChanged.into()); }
    check_cycles(transaction, proposal).await?;
    assertions::require_evidence(transaction, admission, &proposal.evidence,
        &proposal.scope, Some(&proposal.valid_time), now).await.map_err(IdentityError::Fact)?;
    let kind = match proposal.operation { IdentityChangeKind::Merge => "merge", IdentityChangeKind::Split => "split" };
    transaction.execute(
        "INSERT INTO world_identity_resolution(tenant_id,world_id,operation_id,revision,kind,scope_id,valid_from,valid_to,actor_id,commit_id,admission,evidence,expected_refs,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,1,$4,$5,$6::text::timestamptz,$7::text::timestamptz,$8,$9,$10,$11,$12,$13,$14::text::numeric,$15::text::numeric)",
        &[&proposal.world.tenant_id.as_str(), &proposal.world.world_id.as_str(), &operation_id.as_str(), &kind,
          &proposal.scope.as_str(), &proposal.valid_time.from.as_str(), &proposal.valid_time.to.as_ref().map(Timestamp::as_str),
          &super::actor_id(admission).as_str(), &transaction.commit_id().as_str(), &encode(&decision)?, &encode(&proposal.evidence)?,
          &encode(&(&proposal.identities, &proposal.aliases, &proposal.affected_assertions, &prepared.influence))?, &encode(proposal)?,
          &aliases::nanoseconds(&proposal.valid_time.from)?, &proposal.valid_time.to.as_ref().map(aliases::nanoseconds).transpose()?],
    ).await?;
    for remap in &proposal.remapping {
        for target in &remap.replacements {
            member(transaction, operation_id, &remap.original, target, "identity", parts(&remap.original).1, &encode(remap)?).await?;
            for alias in &proposal.aliases {
                if alias.target == remap.original {
                    let id = aliases::range_digest(&alias.key)?;
                    member(transaction, operation_id, &remap.original, target, "alias", id.as_str(), &encode(&proposal.aliases.iter().filter(|alias| alias.target == remap.original).collect::<Vec<_>>())?).await?;
                    // One member represents the complete key history basis, not individual roles.
                    break;
                }
            }
            for assertion in &assertions {
                member(transaction, operation_id, &remap.original, target, "assertion", assertion.reference.id.as_str(), &encode(assertion)?).await?;
            }
        }
    }
    let replacements = apply_assertion_remaps(transaction, proposal, &assertions, admission, budget, cancellation).await?;
    for mapping in &proposal.remapping {
        for target in &mapping.replacements {
            for (original, replacements) in &replacements {
                member(transaction, operation_id, &mapping.original, target, "assertion_replacement", original.id.as_str(),
                    &encode(&(original, replacements))?).await?;
            }
        }
    }
    let mut revised = Vec::with_capacity(proposal.identities.len());
    for expected in &proposal.identities {
        let reference = subject(&expected.record);
        let (subject_kind, id) = parts(&reference);
        let next = IdentitySnapshot { record: expected.record.clone(), revision: Revision(expected.revision.0.checked_add(1).ok_or(IdentityFailure::InternalFault)?) };
        let sql = match reference {
            SubjectRef::Object { .. } => "UPDATE world_object_identity SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND object_id=$3 AND revision=$5",
            SubjectRef::Relation { .. } => "UPDATE world_relation_identity SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$3 AND revision=$5",
        };
        let changed = transaction.execute(sql,
            &[&proposal.world.tenant_id.as_str(), &proposal.world.world_id.as_str(), &id, &revision(next.revision.0)?, &revision(expected.revision.0)?]).await?;
        transaction.require_changed(changed, resource(&reference))?;
        records::persist_revision(transaction, &next, admission, &decision).await?;
        transaction.record_revision(CommittedRevision { resource: resource(&reference), revision: next.revision })?;
        transaction.execute(
            "UPDATE world_identity_influence SET generation=generation+1 WHERE tenant_id=$1 AND world_id=$2 AND subject_kind=$3 AND subject_id=$4",
            &[&proposal.world.tenant_id.as_str(), &proposal.world.world_id.as_str(), &subject_kind, &id],
        ).await?;
        revised.push(next);
    }
    let mut dependencies: Vec<_> = proposal.identities.iter().map(|identity| ReadDependency::Identity {
        subject: subject(&identity.record), revision: identity.revision,
    }).collect();
    let mut ranges = BTreeSet::new();
    for alias in &proposal.aliases {
        let digest = aliases::range_digest(&alias.key)?;
        if ranges.insert(digest.clone()) {
            let generation = aliases::lock_range(transaction, &alias.key, None).await?;
            aliases::bump_range(transaction, &alias.key).await?;
            dependencies.push(ReadDependency::AliasRange { digest, generation });
        }
    }
    crate::facts::support::invalidate_dependencies(transaction, &dependencies, false, budget, cancellation, now).await?;
    validate_replacement_support(transaction, proposal, &replacements, budget, cancellation).await?;
    let event_id = world_protocol::ids::EventId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| IdentityFailure::InternalFault)?;
    transaction.emit(OutboxEvent {
        event_id, aggregate_kind: "identity_resolution".into(), aggregate_id: operation_id.to_string(), aggregate_revision: 1,
        event_kind: format!("identity.{kind}"), payload: encode(proposal)?, causation_id: None, origin: "world.identity".into(),
    }).await?;
    if cancellation.is_cancelled() { return Err(IdentityFailure::Cancelled.into()); }
    Ok(revised)
}

fn validate(proposal: &IdentityChangeProposal) -> Result<(), IdentityError> {
    super::validate_interval(&proposal.valid_time)?;
    let invalid = || match proposal.operation { IdentityChangeKind::Merge => IdentityFailure::InvalidMerge, IdentityChangeKind::Split => IdentityFailure::InvalidSplit };
    if proposal.identities.len() < 2 || proposal.identities.len() > 4096 || proposal.remapping.is_empty()
        || proposal.reason.is_empty() || proposal.reason.len() > 8192 { return Err(invalid().into()); }
    let mut identities = BTreeMap::new();
    for identity in &proposal.identities {
        if world(&identity.record) != &proposal.world || identity.revision.0 == 0 { return Err(IdentityFailure::CrossWorld.into()); }
        if identities.insert(subject(&identity.record), identity).is_some() { return Err(invalid().into()); }
    }
    let mut originals = BTreeSet::new();
    let mut targets = BTreeSet::new();
    for mapping in &proposal.remapping {
        if !originals.insert(mapping.original.clone()) || mapping.replacements.is_empty() { return Err(invalid().into()); }
        let source = identities.get(&mapping.original).ok_or_else(invalid)?;
        let mut replacements = BTreeSet::new();
        for replacement in &mapping.replacements {
            let target = identities.get(replacement).ok_or_else(invalid)?;
            if parts(replacement).0 != parts(&mapping.original).0 || type_id(&source.record) != type_id(&target.record)
                || !replacements.insert(replacement) || replacement == &mapping.original { return Err(invalid().into()); }
            targets.insert(replacement.clone());
        }
    }
    if !originals.is_disjoint(&targets) || identities.keys().any(|subject| !originals.contains(subject) && !targets.contains(subject)) { return Err(invalid().into()); }
    match proposal.operation {
        IdentityChangeKind::Merge if targets.len() != 1 || proposal.remapping.iter().any(|mapping| mapping.replacements.len() != 1) => return Err(invalid().into()),
        IdentityChangeKind::Split if originals.len() != 1 || targets.len() < 2 => return Err(invalid().into()),
        _ => {}
    }
    if proposal.aliases.iter().any(|alias| alias.key.world != proposal.world || !originals.contains(&alias.target))
        || proposal.evidence.iter().any(|reference| reference.world != proposal.world)
        || proposal.affected_assertions.iter().any(|reference| reference.world != proposal.world) { return Err(IdentityFailure::CrossWorld.into()); }
    Ok(())
}

fn all_subjects(proposal: &IdentityChangeProposal) -> Vec<SubjectRef> {
    let mut subjects: BTreeSet<_> = proposal.identities.iter().map(|identity| subject(&identity.record)).collect();
    for mapping in &proposal.assertion_remapping {
        for replacement in &mapping.replacements { subjects.extend(assertions::claim_subjects(&replacement.draft.claim)); }
    }
    // Original untouched endpoints must also share the lock order with S07 withdrawals.
    for claim in &proposal.relation_claims {
        subjects.insert(SubjectRef::Relation { id: claim.relation_id.clone() });
        subjects.extend(claim.roles.iter().map(|role| SubjectRef::Object { id: role.object_id.clone() }));
    }
    subjects.into_iter().collect()
}

async fn apply_assertion_remaps(
    transaction: &mut WorldTransaction<'_>, proposal: &IdentityChangeProposal,
    originals: &[Assertion], admission: &Admission, budget: &crate::extensions::invocation::CallBudget, cancellation: &CancellationToken,
) -> Result<Vec<(world_protocol::ids::AssertionRef, Vec<world_protocol::ids::AssertionRef>)>, IdentityError> {
    let mut result = Vec::with_capacity(originals.len());
    for original in originals {
        let mapping = proposal.assertion_remapping.iter().find(|mapping| mapping.original == original.reference)
            .ok_or(IdentityFailure::CandidateScopeIncomplete)?;
        let drafts: Vec<_> = mapping.replacements.iter().map(|replacement| &replacement.draft).collect();
        let validated = super::remap::validated(proposal, original, &drafts)?;
        let mut replacements = Vec::with_capacity(validated.len());
        for (witness, proposed) in validated.iter().zip(&mapping.replacements) {
            let id = world_protocol::ids::AssertionId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| IdentityFailure::InternalFault)?;
            let mut supports = proposed.supports.clone();
            if let Some(supports) = &mut supports {
                for support in &mut supports.upserts {
                    support.conclusion = world_protocol::ids::AssertionRef { world: transaction.world().clone(), id: id.clone(), revision: Revision(1) };
                }
            }
            let assertion = assertions::admit_remapped_observation(transaction, admission, id, witness,
                supports.as_ref(), budget, cancellation).await.map_err(IdentityError::Fact)?;
            if assertion.status != original.status { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
            replacements.push(assertion.reference);
        }
        result.push((original.reference.clone(), replacements));
    }
    for original in originals {
        assertions::withdraw_assertion(transaction, admission, &original.reference, budget, cancellation).await.map_err(IdentityError::Fact)?;
    }
    Ok(result)
}

async fn validate_replacement_support(
    transaction: &WorldTransaction<'_>, proposal: &IdentityChangeProposal,
    result: &[(world_protocol::ids::AssertionRef, Vec<world_protocol::ids::AssertionRef>)], budget: &crate::extensions::invocation::CallBudget, cancellation: &CancellationToken,
) -> Result<(), IdentityError> {
    // Check only after all withdrawals, identity revisions and alias invalidations have run.
    for (original, replacements) in result {
        let mapping = proposal.assertion_remapping.iter().find(|mapping| &mapping.original == original)
            .ok_or(IdentityFailure::CandidateScopeIncomplete)?;
        for (proposed, reference) in mapping.replacements.iter().zip(replacements) {
            if let Some(supports) = &proposed.supports {
                for support in &supports.upserts {
                    let state = crate::facts::support::resolve_transaction_interval(transaction, reference, &proposed.draft.scope,
                        &support.release_id, support.branch_id.as_ref(), budget, cancellation, &proposed.draft.valid_time).await?;
                    if !matches!(state, world_protocol::provenance::ConclusionSupport::Supported { .. }) {
                        return Err(IdentityFailure::CandidateScopeIncomplete.into());
                    }
                }
            }
        }
    }
    Ok(())
}

async fn lock_change_ranges(transaction: &WorldTransaction<'_>, proposal: &IdentityChangeProposal) -> Result<(), IdentityError> {
    let mut originals = Vec::new();
    for reference in &proposal.affected_assertions {
        originals.push(assertions::read_assertion(transaction, reference).await.map_err(IdentityError::Fact)?
            .ok_or(IdentityFailure::ImpactSetChanged)?);
    }
    let mut claims: Vec<_> = originals.iter().map(|assertion| (&assertion.claim, &assertion.origin)).collect();
    claims.extend(proposal.assertion_remapping.iter().flat_map(|mapping| mapping.replacements.iter()
        .map(|replacement| (&replacement.draft.claim, &replacement.draft.origin))));
    let (mut datasets, partitions) = crate::facts::support::assertion_ranges(transaction, &claims).await?;
    datasets.extend(proposal.identities.iter().map(|identity| type_id(&identity.record).clone()));
    let supports: Vec<_> = proposal.assertion_remapping.iter().flat_map(|mapping| &mapping.replacements).filter_map(|replacement| replacement.supports.as_ref()).flat_map(|delta| delta.upserts.iter().cloned()).collect();
    datasets.extend(crate::query::rule_ranges(transaction, &supports).await.map_err(|error| IdentityError::Fact(error.into()))?);
    datasets.sort(); datasets.dedup();
    crate::facts::support::lock_ranges(transaction, &datasets, &partitions).await?;
    Ok(())
}

async fn lock_aliases(transaction: &WorldTransaction<'_>, aliases: &[SourceAlias]) -> Result<(), IdentityError> {
    let mut keys: Vec<_> = aliases.iter().map(|alias| &alias.key).collect();
    keys.sort_unstable_by(|left, right| (&left.source_id, &left.namespace, &left.native_key).cmp(&(&right.source_id, &right.namespace, &right.native_key)));
    keys.dedup_by(|left, right| left.source_id == right.source_id && left.namespace == right.namespace && left.native_key == right.native_key);
    for key in keys { aliases::lock_range(transaction, key, None).await?; }
    Ok(())
}

async fn check_aliases(transaction: &WorldTransaction<'_>, proposal: &IdentityChangeProposal) -> Result<(), IdentityError> {
    let mut actual = Vec::new();
    for mapping in &proposal.remapping {
        let (kind, id) = parts(&mapping.original);
        let rows = transaction.query(
            "SELECT r.body FROM world_source_alias_current c JOIN world_source_alias_revision r USING(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.target_kind=$3 AND c.target_id=$4 ORDER BY c.source_id,c.namespace,c.native_key,c.incarnation,c.valid_from_ns",
            &[&proposal.world.tenant_id.as_str(), &proposal.world.world_id.as_str(), &kind, &id],
        ).await?;
        for row in rows { actual.push(decode::<SourceAlias>(row.get("body"))?); }
    }
    let actual: BTreeSet<_> = actual.iter().map(serde_json::to_string).collect::<Result<_, _>>().map_err(|_| IdentityFailure::InternalFault)?;
    let expected: BTreeSet<_> = proposal.aliases.iter().map(serde_json::to_string).collect::<Result<_, _>>().map_err(|_| IdentityFailure::InternalFault)?;
    if actual != expected { return Err(IdentityFailure::ImpactSetChanged.into()); }
    if expected.len() != proposal.aliases.len() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    Ok(())
}

async fn affected_assertions(transaction: &WorldTransaction<'_>, proposal: &IdentityChangeProposal) -> Result<Vec<Assertion>, IdentityError> {
    let originals: Vec<_> = proposal.remapping.iter().map(|mapping| mapping.original.clone()).collect();
    let assertions = assertions::read_identity_influence(transaction, &originals).await.map_err(|error| {
        let failure = match &error.reason {
            world_protocol::facts::FactFailure::Commit { failure } => failure.clone(),
            _ => world_protocol::commit::CommitFailure::InternalFault,
        };
        IdentityError::Store(crate::store::StoreError::caused_by(failure, world_protocol::failure::FailureStage::Read, error))
    })?;
    let assertions: Vec<_> = assertions.into_iter().filter(|assertion| overlaps(&assertion.valid_time, &proposal.valid_time)
        && matches!(assertion.status, world_protocol::facts::AssertionStatus::Accepted | world_protocol::facts::AssertionStatus::Candidate)).collect();
    let actual: BTreeSet<_> = assertions.iter().map(|assertion| assertion.reference.clone()).collect();
    let expected: BTreeSet<_> = proposal.affected_assertions.iter().cloned().collect();
    if actual != expected { return Err(IdentityFailure::ImpactSetChanged.into()); }
    if expected.len() != proposal.affected_assertions.len() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    let mapped: BTreeSet<_> = proposal.assertion_remapping.iter().map(|mapping| mapping.original.clone()).collect();
    if mapped != actual || mapped.len() != proposal.assertion_remapping.len() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    for original in &assertions {
        let mapping = proposal.assertion_remapping.iter().find(|mapping| mapping.original == original.reference)
            .ok_or(IdentityFailure::CandidateScopeIncomplete)?;
        let drafts: Vec<_> = mapping.replacements.iter().map(|replacement| &replacement.draft).collect();
        super::remap::validated(proposal, original, &drafts)?;
        for replacement in &mapping.replacements {
            if replacement.supports.as_ref().is_some_and(|supports| supports.upserts.iter().any(|support| support.premises.iter().any(|premise| match premise {
                world_protocol::provenance::PremiseRef::Assertion(reference)
                | world_protocol::provenance::PremiseRef::Read(ReadDependency::Assertion { reference }) => actual.contains(reference),
                _ => false,
            }))) { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
        }
    }
    let claims: Vec<_> = assertions.iter().filter_map(|assertion| match &assertion.claim { Claim::Relation(claim) => Some(claim), _ => None }).collect();
    if claims.len() != proposal.relation_claims.len() || claims.iter().any(|claim| !proposal.relation_claims.contains(claim)) {
        return Err(IdentityFailure::CandidateScopeIncomplete.into());
    }
    // Cross-scope facts are preserved but cannot silently receive this scope's mapping.
    if assertions.iter().any(|assertion| assertion.scope != proposal.scope) { return Err(IdentityFailure::ScopeConflict.into()); }
    Ok(assertions)
}

async fn check_cycles(transaction: &WorldTransaction<'_>, proposal: &IdentityChangeProposal) -> Result<(), IdentityError> {
    let rows = transaction.query(
        "SELECT body FROM world_identity_resolution WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 AND numrange(valid_from_ns,valid_to_ns,'[)') && numrange($4::text::numeric,$5::text::numeric,'[)')",
        &[&proposal.world.tenant_id.as_str(), &proposal.world.world_id.as_str(), &proposal.scope.as_str(), &aliases::nanoseconds(&proposal.valid_time.from)?, &proposal.valid_time.to.as_ref().map(aliases::nanoseconds).transpose()?],
    ).await?;
    let mut edges: BTreeMap<SubjectRef, BTreeSet<SubjectRef>> = BTreeMap::new();
    for row in rows {
        let previous: IdentityChangeProposal = decode(row.get("body"))?;
        for mapping in previous.remapping { edges.entry(mapping.original).or_default().extend(mapping.replacements); }
    }
    for mapping in &proposal.remapping {
        for target in &mapping.replacements {
            let mut pending = vec![target];
            let mut visited = BTreeSet::new();
            while let Some(current) = pending.pop() {
                if current == &mapping.original { return Err(IdentityFailure::InvalidMerge.into()); }
                if visited.insert(current) { if let Some(targets) = edges.get(current) { pending.extend(targets); } }
            }
        }
        edges.entry(mapping.original.clone()).or_default().extend(mapping.replacements.iter().cloned());
    }
    Ok(())
}

async fn member(
    transaction: &WorldTransaction<'_>, operation: &OperationId, original: &SubjectRef, target: &SubjectRef,
    impact_kind: &str, impact_id: &str, body: &serde_json::Value,
) -> Result<(), IdentityError> {
    let (source_kind, source_id) = parts(original);
    let (target_kind, target_id) = parts(target);
    transaction.execute(
        "INSERT INTO world_identity_resolution_member(tenant_id,world_id,operation_id,revision,source_kind,source_id,target_kind,target_id,impact_kind,impact_id,body) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)",
        &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &operation.as_str(),
          &source_kind, &source_id, &target_kind, &target_id, &impact_kind, &impact_id, body],
    ).await?;
    Ok(())
}
