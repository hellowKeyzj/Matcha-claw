use super::{Assignment, SyncError, decode, encode, number};
use crate::{
    authorization::Admission, content::Content, facts::assertions,
    sources::mapping::MappedObservation, store::WorldTransaction,
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    facts::{Assertion, AssertionStatus, Claim},
    identity::IdentityReceipt,
    ids::*,
    materials::SourceAnchor,
    provenance::ReadDependency,
    sources::{CompiledSourcePlan, DeleteSemantics, SourceBasis},
    time::ValidTime,
};

pub(crate) struct SourceRetraction {
    binding: DefinitionRef,
    source: SourceId,
    namespace: String,
    native_key: String,
    incarnation: String,
    scope: ScopeId,
    valid_time: ValidTime,
    assertions: Vec<AssertionRef>,
    dependencies: Vec<ReadDependency>,
    receipts: Vec<IdentityReceipt>,
    semantics: DeleteSemantics,
    basis: SourceBasis,
    assignment: Assignment,
    branch: Option<BranchCaptureProof>,
}
struct BranchCaptureProof {
    capture: super::BranchCapture,
    snapshot: super::snapshot::CompleteSnapshot,
}

impl SourceRetraction {
    pub(crate) fn branch(&self) -> Option<&world_protocol::releases::BranchRef> {
        self.branch.as_ref().map(|proof| &proof.capture.dto.branch)
    }
    pub(crate) async fn recheck_branch(
        &self,
        tx: &WorldTransaction<'_>,
        admission: &Admission,
        budget: &crate::extensions::invocation::CallBudget,
        cancel: &CancellationToken,
    ) -> Result<(), SyncError> {
        if let Some(proof) = &self.branch {
            super::branch_sources::check(budget, cancel)?;
            proof
                .capture
                .recheck(tx, admission, &tx.now().await?)
                .await?;
            proof
                .snapshot
                .require_missing(tx, &self.assignment, &self.native_key, &self.incarnation)
                .await?;
            if proof
                .capture
                .raw
                .page
                .rows
                .iter()
                .any(|row| row.native_key == self.native_key && row.incarnation == self.incarnation)
            {
                return Err(SyncError::protocol());
            }
        }
        Ok(())
    }
    pub(crate) fn binding(&self) -> &DefinitionRef {
        &self.binding
    }
    pub(crate) fn source(&self) -> &SourceId {
        &self.source
    }
    pub(crate) fn namespace(&self) -> &str {
        &self.namespace
    }
    pub(crate) fn native_key(&self) -> &str {
        &self.native_key
    }
    pub(crate) fn incarnation(&self) -> &str {
        &self.incarnation
    }
    pub(crate) fn scope(&self) -> &ScopeId {
        &self.scope
    }
    pub(crate) fn valid_time(&self) -> &ValidTime {
        &self.valid_time
    }
    pub(crate) fn assertions(&self) -> &[AssertionRef] {
        &self.assertions
    }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] {
        &self.dependencies
    }
    pub(crate) fn receipts(&self) -> &[IdentityReceipt] {
        &self.receipts
    }
    pub(crate) fn semantics(&self) -> DeleteSemantics {
        self.semantics
    }
    pub(crate) fn basis(&self) -> &SourceBasis {
        &self.basis
    }

    pub(super) async fn from_delete(
        tx: &WorldTransaction<'_>, a: &Assignment,
        deletion: &super::SourceIdentityDeletion, plan: &CompiledSourcePlan,
        identities: &[IdentityReceipt],
    ) -> Result<Self, SyncError> {
        let key = deletion.key();
        if deletion.binding() != &a.binding || deletion.rule() != &a.identity_rule
            || key.source_id != a.source_id || key.namespace != plan.binding_body.namespace
            || key.world != a.world
        { return Err(SyncError::protocol()); }
        let mut dependencies = deletion.dependencies().to_vec();
        for receipt in identities {
            for dependency in &receipt.dependencies {
                if !dependencies.contains(dependency) { dependencies.push(dependency.clone()); }
            }
        }
        Self::load(tx, a, &key.namespace, &key.native_key, &key.incarnation,
            &key.valid_time, dependencies, identities, plan.mapping.delete, deletion.basis().clone()).await
    }
    pub(super) async fn from_snapshot(
        tx: &WorldTransaction<'_>,
        a: &Assignment,
        proof: &super::snapshot::CompleteSnapshot,
        native_key: &str,
        incarnation: &str,
        plan: &CompiledSourcePlan,
        identities: &[IdentityReceipt],
    ) -> Result<Self, SyncError> {
        proof
            .require_missing(tx, a, native_key, incarnation)
            .await?;
        Self::load(
            tx,
            a,
            &plan.binding_body.namespace,
            native_key,
            incarnation,
            proof.valid_time(),
            vec![ReadDependency::SourceMapping {
                mapping: a.mapping.clone(),
                identity_rule: a.identity_rule.clone(),
                authority: plan.authority.authority.clone(),
                binding: a.binding.clone(),
            }],
            identities,
            plan.mapping.delete,
            proof.basis(plan),
        )
        .await
    }
    pub(super) async fn from_branch_snapshot(
        tx: &WorldTransaction<'_>,
        a: &Assignment,
        capture: &super::BranchCapture,
        proof: super::snapshot::CompleteSnapshot,
        native_key: &str,
        incarnation: &str,
        identities: &[IdentityReceipt],
    ) -> Result<Self, SyncError> {
        if !capture.dto.complete
            || !capture.dto.consistent
            || !capture.dto.failures.is_empty()
            || capture.dto.basis.gap.is_some()
            || proof.valid_time() != &capture.raw.valid_time
            || !crate::definitions::valid_time_contains(
                &capture.plan.authority.valid_time,
                &capture.raw.valid_time,
            )
            || capture.plan.binding != a.binding
            || capture.plan.binding_body.scope != a.scope
        {
            return Err(SyncError::protocol());
        }
        proof
            .require_missing(tx, a, native_key, incarnation)
            .await?;
        let mut result = Self::load(
            tx,
            a,
            &capture.plan.binding_body.namespace,
            native_key,
            incarnation,
            &capture.raw.valid_time,
            vec![ReadDependency::SourceMapping {
                mapping: a.mapping.clone(),
                identity_rule: a.identity_rule.clone(),
                authority: capture.plan.authority.authority.clone(),
                binding: a.binding.clone(),
            }],
            identities,
            capture.plan.mapping.delete,
            capture.dto.basis.clone(),
        )
        .await?;
        result.branch = Some(BranchCaptureProof {
            capture: capture.clone(),
            snapshot: proof,
        });
        Ok(result)
    }
    async fn load(
        tx: &WorldTransaction<'_>,
        a: &Assignment,
        namespace: &str,
        native_key: &str,
        incarnation: &str,
        valid_time: &ValidTime,
        dependencies: Vec<ReadDependency>,
        identities: &[IdentityReceipt],
        semantics: DeleteSemantics,
        basis: SourceBasis,
    ) -> Result<Self, SyncError> {
        let rows = tx.query("SELECT body FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND namespace=$5 AND native_key=$6 AND record_incarnation=$7 AND binding_id=$8", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &namespace, &native_key, &incarnation, &a.binding.id.as_str()]).await?;
        let mut assertions = Vec::with_capacity(rows.len());
        for row in rows {
            let assertion: Assertion = decode(row.get("body"))?;
            if matches!(
                assertion.status,
                AssertionStatus::Accepted | AssertionStatus::Candidate
            ) && overlaps(&assertion.valid_time, valid_time)
            {
                assertions.push(assertion.reference);
            }
        }
        Ok(Self {
            binding: a.binding.clone(),
            source: a.source_id.clone(),
            namespace: namespace.into(),
            native_key: native_key.into(),
            incarnation: incarnation.into(),
            scope: a.scope.clone(),
            valid_time: valid_time.clone(),
            assertions,
            dependencies,
            receipts: identities.to_vec(),
            semantics,
            basis,
            assignment: a.clone(),
            branch: None,
        })
    }
}

pub(crate) fn assertion_id(
    a: &Assignment,
    observation: &MappedObservation<'_>,
) -> Result<AssertionId, SyncError> {
    claim_id(
        &a.world,
        &a.source_id,
        &a.partition,
        &a.binding.id,
        record_key(observation)?,
        &observation.draft().claim,
    )
}
pub(super) fn claim_id(
    world: &WorldRef,
    source: &SourceId,
    partition: &str,
    binding: &DefinitionId,
    key: (&str, &str, &str),
    claim: &Claim,
) -> Result<AssertionId, SyncError> {
    let claim = match claim {
        Claim::Attribute(claim) => encode(&("attribute", &claim.subject, &claim.property.id))?,
        Claim::Relation(claim) => {
            encode(&("relation", &claim.relation_id, &claim.relation_type.id))?
        }
    };
    let digest = crate::definitions::canonical_digest(&(
        "world.source.claim.v1",
        world,
        source,
        partition,
        binding,
        key,
        claim,
    ))
    .map_err(|_| SyncError::protocol())?;
    AssertionId::try_new(digest.as_str().replace(':', "-")).map_err(|_| SyncError::protocol())
}
fn record_key<'a>(
    observation: &'a MappedObservation<'_>,
) -> Result<(&'a str, &'a str, &'a str), SyncError> {
    for reference in &observation.draft().evidence {
        if let Some(evidence) = observation
            .evidence()
            .iter()
            .find(|e| &e.reference == reference)
        {
            if let SourceAnchor::Record {
                namespace,
                native_key,
                ..
            } = &evidence.locator.anchor
            {
                let row = observation
                    .request()
                    .batch
                    .rows
                    .iter()
                    .find(|r| &r.native_key == native_key)
                    .ok_or_else(SyncError::protocol)?;
                return Ok((namespace, native_key, &row.incarnation));
            }
        }
    }
    Err(SyncError::protocol())
}
pub(super) async fn record(
    tx: &WorldTransaction<'_>,
    a: &Assignment,
    observation: &MappedObservation<'_>,
    assertion: &Assertion,
) -> Result<(), SyncError> {
    let (namespace, key, incarnation) = record_key(observation)?;
    save(tx, a, namespace, key, incarnation, assertion).await
}
pub(super) async fn record_branch(
    tx: &WorldTransaction<'_>,
    a: &Assignment,
    observation: &super::BranchObservation<'_>,
    assertion: &Assertion,
) -> Result<(), SyncError> {
    let key = observation.key();
    if key.world != a.world
        || key.source_id != a.source_id
        || observation.capture().dto.binding != a.binding
    {
        return Err(SyncError::protocol());
    }
    save(
        tx,
        a,
        &key.namespace,
        &key.native_key,
        &key.incarnation,
        assertion,
    )
    .await
}

async fn save(
    tx: &WorldTransaction<'_>,
    a: &Assignment,
    namespace: &str,
    key: &str,
    incarnation: &str,
    assertion: &Assertion,
) -> Result<(), SyncError> {
    let changed = tx.execute("INSERT INTO world_source_claim(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,binding_id,assertion_id,assertion_revision,valid_from,valid_to,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::timestamptz,$12::text::timestamptz,$13,$14::text::numeric,$15::text::numeric) ON CONFLICT(tenant_id,world_id,source_id,partition_key,assertion_id) DO UPDATE SET assertion_revision=excluded.assertion_revision,valid_from=excluded.valid_from,valid_to=excluded.valid_to,valid_from_ns=excluded.valid_from_ns,valid_to_ns=excluded.valid_to_ns,body=excluded.body WHERE world_source_claim.binding_id=excluded.binding_id AND world_source_claim.namespace=excluded.namespace AND world_source_claim.native_key=excluded.native_key AND world_source_claim.record_incarnation=excluded.record_incarnation", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &namespace, &key, &incarnation, &a.binding.id.as_str(), &assertion.reference.id.as_str(), &number(assertion.reference.revision.0)?, &assertion.valid_time.from.as_str(), &assertion.valid_time.to.as_ref().map(|t| t.as_str()), &encode(assertion)?, &assertion.valid_time.from.unix_nanos().to_string(), &assertion.valid_time.to.as_ref().map(|at| at.unix_nanos().to_string())]).await?;
    super::changed(changed, a)
}
pub(super) async fn retract(
    tx: &mut WorldTransaction<'_>,
    content: &Content,
    admission: &Admission,
    proof: &SourceRetraction,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &CancellationToken,
) -> Result<(), SyncError> {
    super::record_state::deleted(tx, admission, &proof.assignment, proof).await?;
    if proof.semantics != DeleteSemantics::WithdrawSourceClaims {
        return Ok(());
    }
    let changed =
        assertions::retract_source_claims(tx, content, admission, proof, budget, cancel).await?;
    for assertion in changed {
        // The trusted source index follows exactly the owner's returned temporal revisions.
        save(
            tx,
            &proof.assignment,
            &proof.namespace,
            &proof.native_key,
            &proof.incarnation,
            &assertion,
        )
        .await?;
    }
    Ok(())
}
fn overlaps(a: &ValidTime, b: &ValidTime) -> bool {
    a.to.as_ref().is_none_or(|to| &b.from < to) && b.to.as_ref().is_none_or(|to| &a.from < to)
}
