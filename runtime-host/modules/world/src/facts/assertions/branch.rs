mod read;
mod impact;
mod restore;
pub(crate) use impact::{branch_derivation_impact, branch_derivation_impact_snapshot};
pub(crate) use read::{read_branch_derivations, read_branch_derivations_snapshot, recheck_branch_derivations, recheck_branch_derivations_preflight, recheck_branch_derivations_snapshot};
pub(crate) use restore::{branch_derivation_retention_roots, validate_branch_restore};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, ActualImpact}, facts::{Assertion, AssertionStatus, FactFailure}, ids::*,
    provenance::{PremiseRef, ReadDependency, SupportSet, SupportStatus}, releases::{BranchRef, Release},
    time::ValidTime, value::DirtyState,
};
use crate::{authorization::{self, Admission, VerifiedInvocation}, definitions, extensions::invocation::CallBudget,
    query::RuleDerivation, store::WorldTransaction};
use super::{Error, derived::{ConclusionPlan, DerivedPreflight, checkpoint, merge, normalized_claim}, impact::observation_impact};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchDerivationRecord {
    pub(crate) branch: BranchRef,
    pub(crate) revision: Revision,
    pub(crate) assertion: Assertion,
    pub(crate) supports: Vec<SupportSet>,
    pub(crate) witnesses: Vec<BranchSupportWitness>,
    pub(crate) release_id: ReleaseId,
    pub(crate) model_digest: Digest,
    pub(crate) derivation_digest: Digest,
    pub(crate) run_id: RunId,
    pub(crate) step_id: StepId,
    #[serde(skip)]
    pub(crate) observed_digest: Option<Digest>,
    #[serde(skip)]
    pub(crate) current_impact: Option<ActualImpact>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchSupportWitness {
    pub(crate) support: SupportRef,
    pub(crate) derivation: crate::query::RuleDerivationBasis,
    pub(crate) derivation_digest: Digest,
    pub(crate) branch_assertions: Vec<AssertionRef>,
    pub(crate) captured_evidence: Vec<EvidenceRef>,
    pub(crate) branch_identities: Vec<ReadDependency>,
    pub(crate) source_versions: Vec<world_protocol::materials::SourceVersionRef>,
    pub(crate) parse_artifacts: Vec<ParseArtifactId>,
}
impl BranchDerivationRecord {
    pub(crate) fn durable_digest(&self) -> Result<Digest, Error> {
        Ok(match &self.observed_digest { Some(digest) => digest.clone(), None => definitions::canonical_digest(self)? })
    }
    pub(crate) fn read_impact(&self) -> Result<ActualImpact, Error> {
        let mut impact = read::assertion_impact(&self.assertion)?;
        for witness in &self.witnesses { merge(&mut impact, witness.derivation.read_impact.clone()); }
        if let Some(current) = &self.current_impact { merge(&mut impact, current.clone()); }
        for support in &self.supports {
            impact.access.push(world_protocol::authorization::AccessScope {
                resources: vec![ResourceRef::Support { id: support.reference.id.clone() }], fields: Vec::new(),
                modes: vec![AccessMode::Read], scope: support.scope.clone(), valid_time: Some(support.valid_time.clone()),
            });
        }
        super::derived::normalize_impact(impact)
    }
}

pub(super) async fn preflight(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, actual: &RuleDerivation, execution: ActualImpact,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<DerivedPreflight, Error> {
    checkpoint(budget, cancel)?;
    let model = actual.branch_model().ok_or(FactFailure::AccessDenied)?;
    let branch = model.source_branch.as_ref().ok_or(FactFailure::AccessDenied)?;
    if &branch.world != tx.world() || actual.world() != tx.world()
        || verified.invocation().world != *tx.world() || verified.invocation().branch_id.as_ref() != Some(&branch.id)
        || actual.active_head().is_some() || &definitions::canonical_digest(model)? != actual.model_digest() {
        return Err(FactFailure::AccessDenied.into());
    }
    let mut impact = actual.read_impact().clone();
    merge(&mut impact, execution);
    let conclusion = if actual.status() == SupportStatus::Valid {
        let (claim, polarity) = actual.conclusion().ok_or(FactFailure::InternalFault)?;
        let claim = normalized_claim(claim);
        let digest = definitions::canonical_digest(&("world.branch.derived-assertion.v1", branch, actual.release_id(), actual.scope(), actual.valid_time(), &claim, polarity))?;
        let id = AssertionId::try_new(format!("derived-{}", &digest.as_str()[7..])).map_err(|_| FactFailure::InternalFault)?;
        let now = tx.now().await?;
        let draft = world_protocol::facts::ObservationDraft { claim, polarity: *polarity, scope: actual.scope().clone(),
            valid_time: actual.valid_time().clone(), observed_at: now.clone(), origin: world_protocol::facts::AssertionOrigin::Derived {}, evidence: Vec::new(), supersedes: None };
        let mut claim_impact = observation_impact(&id, &draft)?;
        let predicate = match &draft.claim { world_protocol::facts::Claim::Attribute(claim) => &claim.property, world_protocol::facts::Claim::Relation(claim) => &claim.relation_type };
        let definition = model.definitions.iter().find(|definition| definition.reference == *predicate).ok_or(FactFailure::AccessDenied)?;
        definitions::validate_applicability(definition, actual.scope(), actual.valid_time(), &model.scopes)?;
        if let world_protocol::definitions::DefinitionBody::Property(property) = &definition.body { claim_impact.labels.extend(property.access_labels.clone()); }
        let mut read_impact = claim_impact.clone();
        for scope in &mut read_impact.access { scope.modes = vec![AccessMode::Read]; }
        authorization::check_impact_read(tx, verified, &read_impact, &now).await?;
        merge(&mut impact, claim_impact); merge(&mut impact, read_impact);
        let previous = read::head(tx, branch, &id).await?;
        let existing = match &previous { Some(previous) => Some(previous.assertion.clone()), None => read::historical_assertion(tx, branch, &id).await? };
        if let Some(assertion) = &existing { super::derived::require_conclusion(actual, assertion)?; }
        let mut identities = Vec::new();
        let branch_body = crate::releases::read_branch_revision(tx, branch).await.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
        for (binding, digest) in actual.capture_witness() {
            checkpoint(budget, cancel)?;
            let capture = crate::sources::sync::selected_branch_capture(tx, &branch_body, binding).await.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
            capture.recheck_preflight(tx, verified, &now).await.map_err(crate::query::QueryError::from)?;
            if definitions::canonical_digest(&(capture.capture(), capture.valid_time(), capture.source_version()))? != *digest { return Err(invalid()); }
            identities.extend(capture.capture().proposals.iter().filter(|proposal| definitions::valid_time_contains(&proposal.key.valid_time, actual.valid_time())).filter_map(|proposal| proposal.identity.clone()));
        }
        super::claim::validate_claim(&super::claim::ClaimRead::Derived(tx, model, &identities), &draft.claim, actual.scope(), actual.valid_time()).await?;
        let reference = existing.as_ref().map_or_else(|| AssertionRef { world: tx.world().clone(), id: id.clone(), revision: Revision(1) }, |old| old.reference.clone());
        let mut supports = Vec::new();
        for segment in actual.segments() {
            checkpoint(budget, cancel)?;
            let digest = definitions::canonical_digest(&("world.branch.derived-support.v1", branch, &reference, actual.rule(), actual.arguments(), actual.scope(), segment.valid_time()))?;
            let support_id = SupportId::try_new(format!("derived-{}", &digest.as_str()[7..])).map_err(|_| FactFailure::InternalFault)?;
            let row = tx.query_opt("SELECT COALESCE(MAX((s->'reference'->>'revision')::bigint),0)+1 AS revision FROM world_branch_derivation_revision r CROSS JOIN LATERAL jsonb_array_elements(r.body->'supports') s WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.branch_id=$3 AND r.branch_revision=$4 AND r.assertion_id=$5 AND s->'reference'->>'id'=$6",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &reference.id.as_str(), &support_id.as_str()]).await?.ok_or(FactFailure::InternalFault)?;
            let revision = u64::try_from(row.get::<_, i64>("revision")).map_err(|_| FactFailure::InternalFault)?;
            let mut premises = Vec::new();
            for dependency in segment.dependencies() { let premise = match dependency {
                ReadDependency::Assertion { reference } => PremiseRef::Assertion(reference.clone()),
                ReadDependency::Evidence { reference } => PremiseRef::Evidence(reference.clone()), other => PremiseRef::Read(other.clone()),
            }; if !premises.contains(&premise) { premises.push(premise); } }
            if premises.is_empty() { return Err(FactFailure::AccessDenied.into()); }
            let support = SupportSet { reference: SupportRef { world: tx.world().clone(), id: support_id, revision: Revision(revision) },
                conclusion: reference.clone(), rule: actual.rule().clone(), arguments: actual.arguments().to_vec(), scope: actual.scope().clone(),
                valid_time: segment.valid_time().clone(), release_id: actual.release_id().clone(), branch_id: Some(branch.id.clone()),
                premises, status: SupportStatus::Pending, dirty: DirtyState::Clean };
            let access = super::impact::resource_read_impact(ResourceRef::Support { id: support.reference.id.clone() }, Vec::new(), actual.scope(), Some(segment.valid_time()), Vec::new(), None)?;
            authorization::check_impact_read(tx, verified, &access, &now).await?; merge(&mut impact, access);
            supports.push(support);
        }
        if supports.is_empty() || supports.len() > 4096 { return Err(FactFailure::AccessDenied.into()); }
        let closure = definitions::canonical_digest(&previous)?;
        Some(ConclusionPlan { id, draft, existing, supports, closure })
    } else { if actual.conclusion().is_some() { return Err(FactFailure::InternalFault.into()); } None };
    let impact = super::derived::normalize_impact(impact)?;
    let plan = conclusion.as_ref().map(|value| (&value.id, &value.draft.claim, value.draft.polarity, &value.existing, &value.supports, &value.closure));
    let fingerprint = definitions::canonical_digest(&("world.branch.derived-admission.v1", branch, actual.fingerprint()?, plan, &impact))?;
    Ok(DerivedPreflight { impact, fingerprint, conclusion })
}

pub(crate) async fn lock_branch_derivations(tx: &WorldTransaction<'_>, branch: &BranchRef, scope: &ScopeId) -> Result<(), Error> {
    if tx.world() != &branch.world { return Err(invalid()); }
    let key = definitions::canonical_digest(&("world.branch.derived-scope-lock.v1", branch, scope))?;
    tx.query_opt("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", &[&key.as_str()]).await?;
    Ok(())
}

pub(super) async fn admit(
    tx: &mut WorldTransaction<'_>, admission: &Admission, actual: &RuleDerivation, conclusion: ConclusionPlan,
    run: &crate::owner::RunRecord, step: &crate::owner::StepRecord, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<AssertionRef, Error> {
    tx.require_domain(&WriterDomain::try_new("facts").expect("facts domain"))?;
    checkpoint(budget, cancel)?;
    let branch = actual.branch_model().and_then(|model| model.source_branch.as_ref()).ok_or(FactFailure::AccessDenied)?;
    if run.branch_id.as_ref() != Some(&branch.id) || run.branch_revision != Some(branch.revision)
        || run.release_id.as_ref() != Some(actual.release_id()) || step.run_id != run.id
        || run.activation_lock_id.as_ref() != Some(actual.activation_lock_id()) { return Err(FactFailure::AccessDenied.into()); }
    lock_branch_derivations(tx, branch, actual.scope()).await?;
    let lock = definitions::canonical_digest(&("world.branch.derived-lock.v1", branch, &conclusion.id))?;
    tx.query_opt("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", &[&lock.as_str()]).await?;
    let old = read::head(tx, branch, &conclusion.id).await?;
    if definitions::canonical_digest(&old)? != conclusion.closure { return Err(crate::query::QueryError::from(world_protocol::query::QueryFailure::BasisChanged).into()); }
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    let assertion = if let Some(assertion) = conclusion.existing { assertion } else {
        let mut assertion = super::candidate(AssertionRef { world: tx.world().clone(), id: conclusion.id, revision: Revision(1) }, conclusion.draft, now, None)?;
        assertion.status = AssertionStatus::Accepted; assertion
    };
    let revision = tx.query_opt("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM world_branch_derivation_revision WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision=$4 AND assertion_id=$5",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &assertion.reference.id.as_str()]).await?.ok_or(FactFailure::InternalFault)?;
    let mut record = BranchDerivationRecord {
        branch: branch.clone(), revision: Revision(u64::try_from(revision.get::<_, i64>("revision")).map_err(|_| FactFailure::InternalFault)?), assertion,
        supports: old.as_ref().map_or_else(Vec::new, |old| old.supports.clone()), witnesses: old.as_ref().map_or_else(Vec::new, |old| old.witnesses.clone()),
        release_id: actual.release_id().clone(), model_digest: actual.model_digest().clone(), derivation_digest: actual.fingerprint()?, run_id: run.id.clone(), step_id: step.id.clone(), observed_digest: None, current_impact: None,
    };
    let basis = actual.retained_fingerprint_basis()?;
    for mut support in conclusion.supports {
        support.status = SupportStatus::Valid;
        record.supports.retain(|old| old.reference.id != support.reference.id);
        record.witnesses.retain(|old| old.support.id != support.reference.id);
        record.witnesses.push(read::retained_inputs(tx, branch, basis.clone(), &support, &record.derivation_digest).await?);
        record.supports.push(support);
    }
    validate(&record)?;
    read::validate_write(tx, admission, &record, actual.branch_model().expect("branch model"), budget, cancel).await?;
    let w = tx.world();
    tx.execute("INSERT INTO world_branch_derivation_revision(tenant_id,world_id,branch_id,branch_revision,assertion_id,revision,release_id,model_digest,derivation_digest,run_id,step_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        &[&w.tenant_id.as_str(), &w.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &record.assertion.reference.id.as_str(), &number(record.revision.0)?, &record.release_id.as_str(), &record.model_digest.as_str(), &record.derivation_digest.as_str(), &record.run_id.as_str(), &record.step_id.as_str(), &encode(&record)?]).await?;
    tx.execute("INSERT INTO world_branch_derivation_head(tenant_id,world_id,branch_id,branch_revision,assertion_id,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,world_id,branch_id,branch_revision,assertion_id) DO UPDATE SET revision=EXCLUDED.revision WHERE world_branch_derivation_head.revision=$7",
        &[&w.tenant_id.as_str(), &w.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &record.assertion.reference.id.as_str(), &number(record.revision.0)?, &old.as_ref().map_or(Ok(0), |old| number(old.revision.0))?]).await.and_then(|changed| if changed == 1 { Ok(()) } else { Err(crate::store::StoreError::new(world_protocol::commit::CommitFailure::InvalidBatch, world_protocol::failure::FailureStage::Commit)) })?;
    Ok(record.assertion.reference)
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> { serde_json::to_value(value).map_err(|error| Error::caused_by(FactFailure::InternalFault, error)) }
fn number(value: u64) -> Result<i64, Error> { i64::try_from(value).map_err(|error| Error::caused_by(FactFailure::InternalFault, error)) }
fn invalid() -> Error { FactFailure::AccessDenied.into() }
pub(super) fn validate(record: &BranchDerivationRecord) -> Result<(), Error> { restore::validate_record(record) }
