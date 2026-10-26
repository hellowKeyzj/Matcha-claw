use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use world_protocol::{authorization::ActualImpact, definitions::DefinitionBody,
    facts::{Assertion, Claim, FactFailure}, identity::{IdentityRecord, SubjectRef}, ids::*,
    provenance::{ConclusionSupport, ReadDependency, SupportSnapshot, SupportStatus}, releases::{BranchRef, Release, WorldBranch},
    time::{Timestamp, ValidTime}, value::DirtyState};
use crate::{authorization::{self, Admission, VerifiedInvocation}, definitions, extensions::invocation::CallBudget,
    facts::support::{self, DependencyReader, DependencyValidity}, sources::sync::{self, BranchCapture}, store::{WorldSnapshot, WorldTransaction}};
use super::{BranchDerivationRecord, BranchSupportWitness, Error, invalid, number, validate};
use super::super::{derived::{checkpoint, merge}, impact::resource_read_impact};

#[derive(Clone, Copy)]
enum Reader<'a, 's> { Transaction(&'a WorldTransaction<'s>, &'a VerifiedInvocation), Snapshot(&'a WorldSnapshot<'s>, &'a Admission) }
impl<'a, 's> Reader<'a, 's> {
    fn world(self) -> &'a WorldRef { match self { Self::Transaction(tx, _) => tx.world(), Self::Snapshot(snapshot, _) => snapshot.world() } }
    async fn now(self) -> Result<Timestamp, Error> { Ok(match self { Self::Transaction(tx, _) => tx.now().await?, Self::Snapshot(snapshot, _) => snapshot.now().await? }) }
    async fn query(self, sql: &'static str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> Result<Vec<tokio_postgres::Row>, Error> {
        Ok(match self { Self::Transaction(tx, _) => tx.query(sql, params).await?, Self::Snapshot(snapshot, _) => snapshot.query(sql, params).await? })
    }
    async fn check(self, impact: &ActualImpact, now: &Timestamp) -> Result<(), Error> {
        match self { Self::Transaction(tx, verified) => { authorization::check_impact_read(tx, verified, impact, now).await?; },
            Self::Snapshot(snapshot, admission) => { authorization::recheck_read(snapshot, admission, now).await?; admission.require_access(impact)?; } }
        Ok(())
    }
    async fn branch(self, branch: &BranchRef) -> Result<WorldBranch, Error> {
        let value = match self { Self::Transaction(tx, _) => crate::releases::read_branch_revision(tx, branch).await,
            Self::Snapshot(snapshot, _) => crate::releases::read_branch_revision_snapshot(snapshot, branch).await }.map_err(crate::query::QueryError::from)?;
        value.ok_or_else(invalid)
    }
    async fn capture(self, branch: &WorldBranch, binding: &DefinitionRef, now: &Timestamp) -> Result<BranchCapture, Error> {
        let capture = match self { Self::Transaction(tx, _) => sync::selected_branch_capture(tx, branch, binding).await,
            Self::Snapshot(snapshot, _) => sync::selected_branch_capture_snapshot(snapshot, branch, binding).await }.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
        match self { Self::Transaction(tx, verified) => capture.recheck_preflight(tx, verified, now).await,
            Self::Snapshot(snapshot, admission) => capture.recheck_snapshot(snapshot, admission, now).await }.map_err(crate::query::QueryError::from)?;
        Ok(capture)
    }
    async fn canonical(self, deps: &[ReadDependency], model: &Release, scope: &ScopeId, interval: &ValidTime, now: &Timestamp,
        limits: Option<(&CallBudget, &CancellationToken)>,
    ) -> Result<(bool, Option<ActualImpact>), Error> {
        if deps.is_empty() { return Ok((true, None)); }
        let mut canonical_model = model.clone(); canonical_model.source_branch = None;
        let authority = match self { Self::Transaction(tx, verified) => support::DependencyAuthority::Transaction(tx, verified),
            Self::Snapshot(snapshot, admission) => support::DependencyAuthority::Snapshot(snapshot, admission) };
        let (mut valid, impact) = support::recheck_authorized_dependencies(authority, deps, &canonical_model, scope, interval, now, limits).await?;
        for dependency in deps {
            let read = match self { Self::Transaction(tx, _) => DependencyReader::Transaction(tx), Self::Snapshot(snapshot, _) => DependencyReader::Snapshot(snapshot) };
            match support::check_dependency(read, dependency, Some((model, scope, interval)), now).await {
                Ok(DependencyValidity::Valid) => {}, Ok(_) => valid = false,
                Err(error) if matches!(support::provenance_failure(&error), world_protocol::provenance::ProvenanceFailure::BasisChanged { .. } | world_protocol::provenance::ProvenanceFailure::UnclosedRange { .. }) => valid = false,
                Err(error) => return Err(error.into()),
            }
            if let ReadDependency::Evidence { reference } = dependency {
                match self { Self::Transaction(tx, verified) => { super::super::require_evidence_preflight(tx, verified, std::slice::from_ref(reference), scope, Some(interval), now).await?; },
                    Self::Snapshot(snapshot, admission) => { super::super::require_evidence_snapshot(snapshot, admission, std::slice::from_ref(reference), scope, Some(interval), now).await?; } }
            }
        }
        Ok((valid, Some(impact)))
    }
}

pub(crate) async fn read_branch_derivations(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, branch: &BranchRef, model: &Release, scope: &ScopeId,
    interval: &ValidTime, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Vec<BranchDerivationRecord>, Error> {
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.as_ref() != Some(&branch.id) { return Err(invalid()); }
    read(Reader::Transaction(tx, verified), branch, model, scope, interval, None, Some((budget, cancel))).await
}
pub(crate) async fn read_branch_derivations_snapshot(
    snapshot: &WorldSnapshot<'_>, admission: &Admission, branch: &BranchRef, model: &Release, scope: &ScopeId,
    interval: &ValidTime, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Vec<BranchDerivationRecord>, Error> {
    if admission.invocation().world != *snapshot.world() || admission.invocation().branch_id.as_ref() != Some(&branch.id) { return Err(invalid()); }
    read(Reader::Snapshot(snapshot, admission), branch, model, scope, interval, None, Some((budget, cancel))).await
}
pub(super) const HEADS: &str = "SELECT r.* FROM world_branch_derivation_head h JOIN world_branch_derivation_revision r USING(tenant_id,world_id,branch_id,branch_revision,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.branch_id=$3 AND h.branch_revision=$4 AND h.assertion_id>$5 AND r.body->'assertion'->>'scope'=$6 ORDER BY h.assertion_id LIMIT 256";
pub(super) async fn historical_assertion(tx: &WorldTransaction<'_>, branch: &BranchRef, id: &AssertionId) -> Result<Option<Assertion>, Error> {
    let rows = tx.query("SELECT r.* FROM world_branch_derivation_revision r WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision=$4 AND assertion_id=$5 ORDER BY revision LIMIT 1",
        &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &id.as_str()]).await?;
    rows.into_iter().next().map(decode_row).transpose().map(|record| record.map(|record| record.assertion))
}
pub(super) async fn head(tx: &WorldTransaction<'_>, branch: &BranchRef, id: &AssertionId) -> Result<Option<BranchDerivationRecord>, Error> {
    tx.query_opt("SELECT r.* FROM world_branch_derivation_head h JOIN world_branch_derivation_revision r USING(tenant_id,world_id,branch_id,branch_revision,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.branch_id=$3 AND h.branch_revision=$4 AND h.assertion_id=$5 FOR SHARE OF h",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &id.as_str()]).await?.map(decode_row).transpose()
}
pub(super) fn decode_row(row: tokio_postgres::Row) -> Result<BranchDerivationRecord, Error> {
    let body: serde_json::Value = row.get("body");
    let mut record: BranchDerivationRecord = serde_json::from_value(body).map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?;
    validate(&record)?;
    for (column, expected) in [("tenant_id", record.branch.world.tenant_id.as_str()), ("world_id", record.branch.world.world_id.as_str()), ("branch_id", record.branch.id.as_str()),
        ("assertion_id", record.assertion.reference.id.as_str()), ("release_id", record.release_id.as_str()), ("model_digest", record.model_digest.as_str()),
        ("derivation_digest", record.derivation_digest.as_str()), ("run_id", record.run_id.as_str()), ("step_id", record.step_id.as_str())] {
        if row.get::<_, String>(column) != expected { return Err(invalid()); }
    }
    if row.get::<_, i64>("branch_revision") != number(record.branch.revision.0)? || row.get::<_, i64>("revision") != number(record.revision.0)? { return Err(invalid()); }
    record.observed_digest = Some(definitions::canonical_digest(&record)?);
    Ok(record)
}
pub(super) fn assertion_impact(assertion: &Assertion) -> Result<ActualImpact, Error> {
    let predicate = match &assertion.claim { Claim::Attribute(claim) => &claim.property, Claim::Relation(claim) => &claim.relation_type };
    let mut impact = resource_read_impact(ResourceRef::Assertion { id: assertion.reference.id.clone() }, vec![predicate.clone()], &assertion.scope, Some(&assertion.valid_time), Vec::new(), None)?;
    for subject in super::super::claim_subjects(&assertion.claim) { merge(&mut impact, resource_read_impact(match subject { SubjectRef::Object { id } => ResourceRef::Object { id }, SubjectRef::Relation { id } => ResourceRef::Relation { id } }, vec![predicate.clone()], &assertion.scope, Some(&assertion.valid_time), Vec::new(), None)?); }
    Ok(impact)
}

async fn read(
    reader: Reader<'_, '_>, branch: &BranchRef, model: &Release, scope: &ScopeId, interval: &ValidTime,
    proposed: Option<&BranchDerivationRecord>, limits: Option<(&CallBudget, &CancellationToken)>,
) -> Result<Vec<BranchDerivationRecord>, Error> {
    check_limits(limits)?;
    if reader.world() != &branch.world || model.source_branch.as_ref() != Some(branch) { return Err(invalid()); }
    super::super::revision::validate_interval(interval)?;
    let now = reader.now().await?;
    let mut impact = resource_read_impact(ResourceRef::Branch { id: branch.id.clone() }, Vec::new(), scope, Some(interval), Vec::new(), None)?;
    reader.check(&impact, &now).await?;
    let branch_body = reader.branch(branch).await?;
    let model_digest = definitions::canonical_digest(model)?;
    let mut records = BTreeMap::new(); let mut after = String::new();
    loop {
        check_limits(limits)?;
        let rows = reader.query(HEADS, &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &after, &scope.as_str()]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            check_limits(limits)?; after = row.get("assertion_id");
            // Authorize the identifier before decoding private material from its immutable record.
            reader.check(&resource_read_impact(ResourceRef::Assertion { id: AssertionId::try_new(after.clone()).map_err(|_| invalid())? }, Vec::new(), scope, Some(interval), Vec::new(), None)?, &now).await?;
            let record = decode_row(row)?;
            if record.branch != *branch || record.release_id != model.id || record.model_digest != model_digest { return Err(invalid()); }
            if record.assertion.scope != *scope { continue; }
            if records.len() == 4096 { return Err(invalid()); }
            let required = record.read_impact()?;
            reader.check(&required, &now).await?;
            merge(&mut impact, required);
            records.insert(record.assertion.reference.clone(), record);
        }
    }
    if let Some(record) = proposed { records.insert(record.assertion.reference.clone(), record.clone()); }
    let mut ready = BTreeMap::<AssertionRef, BranchDerivationRecord>::new();
    let mut pending: BTreeSet<_> = records.keys().cloned().collect();
    while !pending.is_empty() {
        check_limits(limits)?;
        let mut progress = false;
        for reference in pending.clone() {
            let record = &records[&reference];
            let children: BTreeSet<_> = record.supports.iter().flat_map(support::dependencies).filter_map(|dep| match dep { ReadDependency::Assertion { reference } if records.contains_key(&reference) => Some(reference), _ => None }).collect();
            if children.iter().any(|child| pending.contains(child)) { continue; }
            let mut current = record.clone();
            for support in &mut current.supports {
                check_limits(limits)?;
                if support.status != SupportStatus::Valid || support.dirty != DirtyState::Clean { continue; }
                let witness = current.witnesses.iter().find(|witness| witness.support == support.reference).ok_or_else(invalid)?;
                let inputs: BTreeMap<_, _> = records.values().filter(|input| input.assertion.reference.id != support.conclusion.id
                    && overlaps(&input.assertion.valid_time, &witness.derivation.valid_time))
                    .map(|input| Ok((input.assertion.reference.clone(), input.durable_digest()?))).collect::<Result<_, Error>>()?;
                let expected: BTreeMap<_, _> = witness.derivation.branch_inputs.iter().filter(|(reference, _)| reference.id != support.conclusion.id).cloned().collect();
                if expected.len() != witness.derivation.branch_inputs.iter().filter(|(reference, _)| reference.id != support.conclusion.id).count() { return Err(invalid()); }
                let mut valid = expected.iter().all(|(reference, digest)| inputs.get(reference) == Some(digest));
                for reference in inputs.keys().filter(|reference| !expected.contains_key(*reference)) {
                    let predicate = match &records[reference].assertion.claim { Claim::Attribute(claim) => &claim.property, Claim::Relation(claim) => &claim.relation_type };
                    if witness.derivation.dependencies.iter().any(|dependency| matches!(dependency, ReadDependency::Definition { reference } if reference == predicate)) {
                        valid = false; break;
                    }
                }
                let (canonical, captured, capture_impact) = split(reader, &branch_body, model, witness, support, &ready, &now, limits).await?;
                merge(&mut impact, capture_impact);
                let (canonical_valid, canonical_impact) = reader.canonical(&canonical, model, scope, &support.valid_time, &now, limits).await?;
                if let Some(canonical_impact) = canonical_impact { merge(&mut impact, canonical_impact); }
                if !canonical_valid { valid = false; }
                if !captured { valid = false; }
                for dependency in support::dependencies(support) {
                    if let ReadDependency::Assertion { reference: child } = dependency {
                        if let Some(child) = ready.get(&child) {
                            let snapshot = SupportSnapshot { assertions: vec![child.assertion.reference.clone()], evidence: Vec::new(), supports: child.supports.clone(), watches: Vec::new() };
                            if !matches!(support::resolve_interval(&snapshot, &child.assertion.reference, scope, &model.id, Some(&branch.id), &support.valid_time), ConclusionSupport::Supported { .. }) { valid = false; }
                        }
                    }
                }
                if !valid { support.status = SupportStatus::Pending; }
            }
            ready.insert(reference.clone(), current); pending.remove(&reference); progress = true;
        }
        if !progress { return Err(FactFailure::Provenance { failure: world_protocol::provenance::ProvenanceFailure::CyclicSupport { assertions: pending.into_iter().collect() } }.into()); }
    }
    let impact = super::super::derived::normalize_impact(impact)?;
    reader.check(&impact, &now).await?;
    let mut records: Vec<_> = ready.into_values().filter(|record| record.assertion.valid_time.to.as_ref().is_none_or(|to| &interval.from < to)
        && interval.to.as_ref().is_none_or(|to| &record.assertion.valid_time.from < to)).collect();
    if let Some(record) = records.first_mut() { record.current_impact = Some(impact); }
    Ok(records)
}

async fn split(
    reader: Reader<'_, '_>, branch: &WorldBranch, model: &Release, witness: &BranchSupportWitness,
    support: &world_protocol::provenance::SupportSet, ready: &BTreeMap<AssertionRef, BranchDerivationRecord>, now: &Timestamp,
    limits: Option<(&CallBudget, &CancellationToken)>,
) -> Result<(Vec<ReadDependency>, bool, ActualImpact), Error> {
    let mut captures = Vec::new(); let mut valid = true;
    let mut impact = resource_read_impact(ResourceRef::Branch { id: branch.id.clone() }, Vec::new(), &support.scope, Some(&support.valid_time), Vec::new(), None)?;
    for (binding, digest) in &witness.derivation.capture_witness {
        check_limits(limits)?;
        let capture = reader.capture(branch, binding, now).await?;
        let current = match reader { Reader::Transaction(tx, _) => capture.read_impact(tx).await,
            Reader::Snapshot(snapshot, _) => capture.read_impact_snapshot(snapshot).await }.map_err(crate::query::QueryError::from)?;
        merge(&mut impact, current);
        if definitions::canonical_digest(&(capture.capture(), capture.valid_time(), capture.source_version()))? != *digest { valid = false; }
        if !capture.capture().complete || !capture.capture().consistent || !capture.capture().failures.is_empty() || capture.capture().basis.gap.is_some() { valid = false; }
        captures.push(capture);
    }
    let mut canonical = Vec::new();
    for dep in support::dependencies(support) {
        check_limits(limits)?;
        let captured = match &dep {
            ReadDependency::Assertion { reference } if ready.contains_key(reference) => true,
            ReadDependency::Source { position, binding } => { if !captures.iter().any(|capture| capture.capture().binding == *binding && capture.capture().basis.position.as_ref() == Some(position)) { valid = false; } true },
            ReadDependency::SourceMapping { binding, mapping, identity_rule, authority } => { if !captures.iter().any(|capture| capture.capture().binding == *binding && model.definitions.iter().any(|definition| definition.reference == *binding && matches!(&definition.body, DefinitionBody::SourceBinding(body) if body.mapping == *mapping && body.identity_rule == *identity_rule && body.authority == *authority))) { valid = false; } true },
            ReadDependency::Identity { subject, revision } => {
                let identities: Vec<_> = captures.iter().flat_map(|capture| &capture.capture().proposals).filter(|record| definitions::valid_time_contains(&record.key.valid_time, &support.valid_time)).filter_map(|record| record.identity.as_ref()).filter(|identity| match &identity.record { IdentityRecord::Object(record) => *subject == SubjectRef::Object { id: record.id.clone() }, IdentityRecord::Relation(record) => *subject == SubjectRef::Relation { id: record.id.clone() } }).collect();
                if identities.is_empty() { false } else { if identities.iter().any(|identity| identity.revision != *revision) { valid = false; } true }
            },
            ReadDependency::Evidence { reference } => {
                if let Some(capture) = captures.iter().find(|capture| capture.capture().evidence.iter().any(|evidence| evidence.reference == *reference)) {
                    let evidence_impact = match reader { Reader::Transaction(tx, verified) => capture.require_evidence_preflight(tx, verified, std::slice::from_ref(reference), &support.scope, Some(&support.valid_time), now).await,
                        Reader::Snapshot(snapshot, admission) => capture.require_evidence_snapshot(snapshot, admission, std::slice::from_ref(reference), &support.scope, Some(&support.valid_time), now).await }.map_err(crate::query::QueryError::from)?;
                    reader.check(&evidence_impact, now).await?; merge(&mut impact, evidence_impact); true
                } else { false }
            },
            _ => false,
        };
        if !captured { canonical.push(dep); }
    }
    Ok((canonical, valid, super::super::derived::normalize_impact(impact)?))
}

pub(super) async fn retained_inputs(tx: &WorldTransaction<'_>, branch: &BranchRef, basis: crate::query::RuleDerivationBasis, support: &world_protocol::provenance::SupportSet, digest: &Digest) -> Result<BranchSupportWitness, Error> {
    let mut witness = BranchSupportWitness { support: support.reference.clone(), derivation: basis, derivation_digest: digest.clone(), branch_assertions: Vec::new(), captured_evidence: Vec::new(), branch_identities: Vec::new(), source_versions: Vec::new(), parse_artifacts: Vec::new() };
    let branch_body = crate::releases::read_branch_revision(tx, branch).await.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
    let mut captures = Vec::new();
    for (binding, digest) in &witness.derivation.capture_witness {
        let capture = sync::selected_branch_capture(tx, &branch_body, binding).await.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
        if definitions::canonical_digest(&(capture.capture(), capture.valid_time(), capture.source_version()))? != *digest { return Err(invalid()); }
        witness.source_versions.push(capture.source_version().reference.clone());
        for evidence in &capture.capture().evidence {
            witness.source_versions.push(evidence.locator.source_version.clone());
            witness.parse_artifacts.extend(evidence.locator.parse_artifact_id.iter().cloned());
        }
        captures.push(capture);
    }
    for dependency in support::dependencies(support) {
        match &dependency {
            ReadDependency::Assertion { reference } => { if head(tx, branch, &reference.id).await?.is_some_and(|record| record.assertion.reference == *reference) { witness.branch_assertions.push(reference.clone()); } },
            ReadDependency::Evidence { reference } => { if captures.iter().any(|capture| capture.capture().evidence.iter().any(|value| value.reference == *reference)) { witness.captured_evidence.push(reference.clone()); } },
            ReadDependency::Identity { subject, revision } => {
                if captures.iter().flat_map(|capture| &capture.capture().proposals).any(|proposal| definitions::valid_time_contains(&proposal.key.valid_time, &support.valid_time) && proposal.identity.as_ref().is_some_and(|identity| identity.revision == *revision && match &identity.record { IdentityRecord::Object(record) => *subject == SubjectRef::Object { id: record.id.clone() }, IdentityRecord::Relation(record) => *subject == SubjectRef::Relation { id: record.id.clone() } })) { witness.branch_identities.push(dependency); }
            }, _ => {},
        }
    }
    witness.source_versions.sort_by_key(|reference| (reference.source_id.clone(), reference.version_id.clone())); witness.source_versions.dedup();
    witness.parse_artifacts.sort(); witness.parse_artifacts.dedup();
    Ok(witness)
}

fn overlaps(left: &ValidTime, right: &ValidTime) -> bool {
    left.to.as_ref().is_none_or(|to| &right.from < to) && right.to.as_ref().is_none_or(|to| &left.from < to)
}
fn check_limits(limits: Option<(&CallBudget, &CancellationToken)>) -> Result<(), Error> {
    if let Some((budget, cancel)) = limits { checkpoint(budget, cancel)?; }
    Ok(())
}

pub(crate) async fn recheck_branch_derivations_preflight(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, branch: &BranchRef, model: &Release, scope: &ScopeId,
    interval: &ValidTime, expected: &[(AssertionRef, Digest)], now: &Timestamp,
) -> Result<ActualImpact, Error> {
    let impact = recheck(Reader::Transaction(tx, verified), branch, model, scope, interval, expected).await?;
    authorization::check_impact_read(tx, verified, &impact, now).await?;
    Ok(impact)
}

pub(crate) async fn recheck_branch_derivations(
    tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, model: &Release, scope: &ScopeId,
    interval: &ValidTime, expected: &[(AssertionRef, Digest)], now: &Timestamp,
) -> Result<ActualImpact, Error> {
    authorization::recheck(tx, admission, now).await?;
    recheck(Reader::Transaction(tx, admission.verified()), branch, model, scope, interval, expected).await
}
pub(crate) async fn recheck_branch_derivations_snapshot(
    snapshot: &WorldSnapshot<'_>, admission: &Admission, branch: &BranchRef, model: &Release, scope: &ScopeId,
    interval: &ValidTime, expected: &[(AssertionRef, Digest)], now: &Timestamp,
) -> Result<ActualImpact, Error> {
    authorization::recheck_read(snapshot, admission, now).await?;
    recheck(Reader::Snapshot(snapshot, admission), branch, model, scope, interval, expected).await
}
async fn recheck(reader: Reader<'_, '_>, branch: &BranchRef, model: &Release, scope: &ScopeId, interval: &ValidTime, expected: &[(AssertionRef, Digest)]) -> Result<ActualImpact, Error> {
    let records = read(reader, branch, model, scope, interval, None, None).await?;
    let mut observed = BTreeMap::new();
    let mut impact = resource_read_impact(ResourceRef::Branch { id: branch.id.clone() }, Vec::new(), scope, Some(interval), Vec::new(), None)?;
    for record in records {
        observed.insert(record.assertion.reference.clone(), definitions::canonical_digest(&record)?);
        merge(&mut impact, record.read_impact()?);
    }
    let expected_map: BTreeMap<_, _> = expected.iter().cloned().collect();
    if expected_map.len() != expected.len() || expected_map != observed { return Err(crate::query::QueryError::from(world_protocol::query::QueryFailure::BasisChanged).into()); }
    Ok(super::super::derived::normalize_impact(impact)?)
}

pub(super) async fn validate_write(tx: &WorldTransaction<'_>, admission: &Admission, record: &BranchDerivationRecord, model: &Release, budget: &CallBudget, cancel: &CancellationToken) -> Result<(), Error> {
    let records = read(Reader::Transaction(tx, admission.verified()), &record.branch, model, &record.assertion.scope, &record.assertion.valid_time, Some(record), Some((budget, cancel))).await?;
    let current = records.iter().find(|current| current.assertion.reference == record.assertion.reference).ok_or_else(invalid)?;
    // Only the newly produced supports must be current; a different OR witness may already be dirty.
    if current.supports.iter().any(|support| record.witnesses.iter().any(|witness| witness.support == support.reference && witness.derivation_digest == record.derivation_digest) && support.status != SupportStatus::Valid) { return Err(invalid()); }
    Ok(())
}
