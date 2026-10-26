use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope}, budget::Budget,
    ids::*, materials::SourceVersion, releases::{BranchRef, WorldBranch},
    sources::{BranchSourceCapture, CompiledSourcePlan, MapRecordsRequest, RecordBatch, SourcePage},
    time::{Timestamp, ValidTime},
};
use crate::{authorization::{self, Admission}, sources::mapping, store::{WorldSnapshot, WorldTransaction}};
use super::{SyncError, decode, encode, number};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawBranchCapture {
    pub branch: BranchRef,
    pub compile_digest: Digest,
    pub model_digest: Digest,
    pub plan_digest: Digest,
    pub page: SourcePage,
    pub valid_time: ValidTime,
    pub budget: Budget,
    pub assignment: super::Assignment,
}

/// Minted only by the strict persisted-material reader, never from the public capture DTO.
#[derive(Clone, Debug)]
pub(crate) struct BranchCapture {
    pub(super) dto: BranchSourceCapture,
    pub(super) raw: RawBranchCapture,
    pub(super) version: SourceVersion,
    pub(super) plan: CompiledSourcePlan,
}
impl BranchCapture {
    pub(crate) fn capture(&self) -> &BranchSourceCapture { &self.dto }
    pub(crate) fn source_version(&self) -> &SourceVersion { &self.version }
    pub(crate) fn valid_time(&self) -> &ValidTime { &self.raw.valid_time }
    pub(crate) async fn recheck_preflight(
        &self, tx: &WorldTransaction<'_>, verified: &authorization::VerifiedInvocation, now: &Timestamp,
    ) -> Result<(), SyncError> {
        self.recheck_current(tx).await?;
        let impact = self.read_impact(tx).await?;
        authorization::check_impact_read(tx, verified, &impact, now).await?;
        authorization::check_impact_read_output(tx, verified, &impact, self.dto.proposals.len() as u64, now).await?;
        Ok(())
    }
    pub(crate) async fn require_evidence_preflight(
        &self, tx: &WorldTransaction<'_>, verified: &authorization::VerifiedInvocation, references: &[EvidenceRef],
        scope: &ScopeId, valid_time: Option<&ValidTime>, now: &Timestamp,
    ) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        self.recheck_preflight(tx, verified, now).await?;
        let impact = self.evidence_impact(self.read_impact(tx).await?, references, scope, valid_time)?;
        authorization::check_impact_read(tx, verified, &impact, now).await?;
        let w = tx.world();
        for reference in references {
            if tx.query_opt("SELECT 1 FROM world_evidence_head WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str()]).await?.is_some() {
                crate::facts::assertions::require_evidence_preflight(tx, verified, std::slice::from_ref(reference), scope, valid_time, now).await?;
            }
        }
        authorization::check_impact_read_output(tx, verified, &impact, references.len() as u64, now).await?;
        Ok(impact)
    }
    pub(crate) async fn require_evidence(
        &self, tx: &WorldTransaction<'_>, admission: &Admission, references: &[EvidenceRef],
        scope: &ScopeId, valid_time: Option<&ValidTime>, now: &Timestamp,
    ) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        self.recheck(tx, admission, now).await?;
        let impact = self.evidence_impact(self.read_impact(tx).await?, references, scope, valid_time)?;
        admission.require_access(&impact)?;
        let w = tx.world();
        for reference in references {
            if tx.query_opt("SELECT 1 FROM world_evidence_head WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str()]).await?.is_some() {
                crate::facts::assertions::require_evidence_custody_transaction(tx, admission, std::slice::from_ref(reference), scope, valid_time, now).await?;
            }
        }
        authorization::check_admitted_output(tx, admission, &impact, references.len() as u64, now).await?;
        Ok(impact)
    }
    pub(crate) async fn require_evidence_snapshot(
        &self, snapshot: &WorldSnapshot<'_>, admission: &Admission, references: &[EvidenceRef],
        scope: &ScopeId, valid_time: Option<&ValidTime>, now: &Timestamp,
    ) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        self.recheck_snapshot(snapshot, admission, now).await?;
        let impact = self.evidence_impact(self.read_impact_snapshot(snapshot).await?, references, scope, valid_time)?;
        admission.require_access(&impact)?;
        let w = snapshot.world();
        for reference in references {
            if snapshot.query_opt("SELECT 1 FROM world_evidence_head WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str()]).await?.is_some() {
                crate::facts::assertions::require_evidence_snapshot(snapshot, admission, std::slice::from_ref(reference), scope, valid_time, now).await?;
            }
        }
        authorization::check_admitted_output_read(snapshot, admission, &impact, references.len() as u64, now).await?;
        Ok(impact)
    }
    fn evidence_impact(
        &self, mut impact: world_protocol::authorization::ActualImpact, references: &[EvidenceRef],
        scope: &ScopeId, valid_time: Option<&ValidTime>,
    ) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        let unique: std::collections::BTreeSet<_> = references.iter().collect();
        if unique.len() != references.len() { return Err(SyncError::protocol()); }
        for reference in unique {
            let evidence = self.dto.evidence.iter().find(|evidence| evidence.reference == *reference).ok_or_else(SyncError::protocol)?;
            crate::facts::assertions::validate_evidence(evidence, &self.version, None, None)
                .map_err(crate::facts::assertions::Error::from)?;
            if evidence.status != world_protocol::facts::EvidenceStatus::Active
                || evidence.availability == world_protocol::facts::EvidenceAvailability::Unavailable
            { return Err(SyncError::protocol()); }
            impact.access.push(AccessScope { resources: vec![ResourceRef::Evidence { id: reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: valid_time.cloned() });
            impact.labels.extend(evidence.access.labels.clone());
        }
        Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
    }
    pub(crate) async fn read_impact(&self, tx: &WorldTransaction<'_>) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        self.with_material_impact(authorization::material_read_impact(tx, &self.version).await?)
    }
    pub(crate) async fn read_impact_snapshot(&self, snapshot: &WorldSnapshot<'_>) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        self.with_material_impact(authorization::material_read_impact_snapshot(snapshot, &self.version).await?)
    }
    fn with_material_impact(&self, mut material: world_protocol::authorization::ActualImpact) -> Result<world_protocol::authorization::ActualImpact, SyncError> {
        material.access.push(AccessScope { resources: vec![ResourceRef::Source { id: self.plan.binding_body.source_id.clone() }, ResourceRef::Branch { id: self.dto.branch.id.clone() }], fields: self.plan.field_definitions.iter().map(|d| d.reference.clone()).chain(self.plan.relation_definitions.iter().map(|d| d.reference.clone())).collect(), modes: vec![AccessMode::Read], scope: self.plan.binding_body.scope.clone(), valid_time: Some(self.raw.valid_time.clone()) });
        Ok(authorization::actual_impact(material.access, material.effects, material.labels, material.state, material.source_ids)?)
    }
    pub(crate) async fn recheck_snapshot(&self, snapshot: &WorldSnapshot<'_>, admission: &Admission, now: &Timestamp) -> Result<(), SyncError> {
        let current = read_branch_capture_snapshot(snapshot, &self.dto.branch, &self.dto.binding).await?.ok_or_else(SyncError::protocol)?;
        if current.dto != self.dto { return Err(SyncError::protocol()); }
        let b = &current.plan.binding_body;
        let w = snapshot.world();
        let connection = snapshot.query_opt("SELECT revision FROM world_source_connection_head WHERE tenant_id=$1 AND world_id=$2 AND connection_id=$3", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &b.connection_id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
        let schema = snapshot.query_opt("SELECT schema_id,revision FROM world_source_schema_head WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &b.source_id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
        if connection.get::<_, i64>("revision") != number(b.connection_revision.0)? || schema.get::<_, String>("schema_id") != b.schema.id.as_str() || schema.get::<_, i64>("revision") != number(b.schema.revision.0)? { return Err(SyncError::protocol()); }
        let impact = self.read_impact_snapshot(snapshot).await?;
        admission.require_access(&impact)?;
        authorization::check_admitted_output_read(snapshot, admission, &impact, self.dto.proposals.len() as u64, now).await?;
        Ok(())
    }
    pub(crate) async fn recheck(&self, tx: &WorldTransaction<'_>, admission: &Admission, now: &Timestamp) -> Result<(), SyncError> {
        self.recheck_current(tx).await?;
        let impact = self.read_impact(tx).await?;
        admission.require_access(&impact)?;
        authorization::check_admitted_output(tx, admission, &impact, self.dto.proposals.len() as u64, now).await?;
        Ok(())
    }
    async fn recheck_current(&self, tx: &WorldTransaction<'_>) -> Result<(), SyncError> {
        let current = read_branch_capture(tx, &self.dto.branch, &self.dto.binding).await?.ok_or_else(SyncError::protocol)?;
        if current.dto != self.dto { return Err(SyncError::protocol()); }
        let b = &current.plan.binding_body;
        let w = tx.world();
        let connection = tx.query_opt("SELECT revision FROM world_source_connection_head WHERE tenant_id=$1 AND world_id=$2 AND connection_id=$3 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &b.connection_id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
        let schema = tx.query_opt("SELECT schema_id,revision FROM world_source_schema_head WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &b.source_id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
        if connection.get::<_, i64>("revision") != number(b.connection_revision.0)? || schema.get::<_, String>("schema_id") != b.schema.id.as_str() || schema.get::<_, i64>("revision") != number(b.schema.revision.0)? { return Err(SyncError::protocol()); }
        Ok(())
    }
}

pub(super) const READ: &str = "SELECT capture_digest,compile_digest,model_digest,plan_digest,source_id,source_version_id,body,raw FROM world_source_branch_capture WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision=$4 AND binding_id=$5 AND binding_revision=$6 AND compile_digest=$7 AND model_digest=$8 AND plan_digest=$9";

pub(crate) async fn read_branch_capture(tx: &WorldTransaction<'_>, branch: &BranchRef, binding: &DefinitionRef) -> Result<Option<BranchCapture>, SyncError> {
    if tx.world() != &branch.world || binding.world != branch.world { return Err(SyncError::protocol()); }
    let model = crate::releases::read_branch_revision(tx, branch).await.map_err(mapping::MappingError::from)?.ok_or_else(SyncError::protocol)?;
    let plan = mapping::compile_branch_binding(tx, branch, binding).await?;
    let (compile, model_digest) = model_digests(&model)?;
    let mut rows = tx.query(READ, &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &binding.id.as_str(), &number(binding.revision.0)?, &compile.as_str(), &model_digest.as_str(), &plan.digest.as_str()]).await?;
    if rows.len() > 1 { return Err(SyncError::protocol()); }
    let Some(row) = rows.pop() else { return Ok(None); };
    let (dto, raw) = decode_row(row)?;
    let version = crate::content::read_source_version_in_transaction(tx, &dto.source_version).await?;
    let capture = checked(branch, binding, dto, raw, &model, plan, version)?;
    for proposal in &capture.dto.proposals {
        let identity = crate::identity::read_branch_identity_transaction(tx, branch, &proposal.type_ref, &proposal.key, &capture.plan.binding_body.scope).await?.ok_or_else(SyncError::protocol)?;
        if proposal.identity.as_ref() != Some(&identity) { return Err(SyncError::protocol()); }
    }
    Ok(Some(capture))
}

pub(crate) async fn read_branch_capture_snapshot(snapshot: &WorldSnapshot<'_>, branch: &BranchRef, binding: &DefinitionRef) -> Result<Option<BranchCapture>, SyncError> {
    if snapshot.world() != &branch.world || binding.world != branch.world { return Err(SyncError::protocol()); }
    let model = crate::releases::read_branch_revision_snapshot(snapshot, branch).await.map_err(mapping::MappingError::from)?.ok_or_else(SyncError::protocol)?;
    let plan = mapping::compile_branch_binding_snapshot(snapshot, branch, binding).await?;
    let (compile, model_digest) = model_digests(&model)?;
    let mut rows = snapshot.query(READ, &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &binding.id.as_str(), &number(binding.revision.0)?, &compile.as_str(), &model_digest.as_str(), &plan.digest.as_str()]).await?;
    if rows.len() > 1 { return Err(SyncError::protocol()); }
    let Some(row) = rows.pop() else { return Ok(None); };
    let (dto, raw) = decode_row(row)?;
    let version = crate::content::read_source_version_snapshot(snapshot, &dto.source_version).await?;
    let capture = checked(branch, binding, dto, raw, &model, plan, version)?;
    for proposal in &capture.dto.proposals {
        let identity = crate::identity::read_branch_identity(snapshot, branch, &proposal.type_ref, &proposal.key, &capture.plan.binding_body.scope).await?.ok_or_else(SyncError::protocol)?;
        if proposal.identity.as_ref() != Some(&identity) { return Err(SyncError::protocol()); }
    }
    Ok(Some(capture))
}

fn decode_row(row: tokio_postgres::Row) -> Result<(BranchSourceCapture, RawBranchCapture), SyncError> {
    let dto: BranchSourceCapture = decode(row.get("body"))?;
    let raw: RawBranchCapture = decode(row.get("raw"))?;
    if row.get::<_, String>("capture_digest") != dto.digest.as_str() || row.get::<_, String>("compile_digest") != dto.compile_digest.as_str() || row.get::<_, String>("model_digest") != dto.model_digest.as_str() || row.get::<_, String>("plan_digest") != dto.plan_digest.as_str() || row.get::<_, String>("source_id") != dto.source_version.source_id.as_str() || row.get::<_, String>("source_version_id") != dto.source_version.version_id.as_str() { return Err(SyncError::protocol()); }
    Ok((dto, raw))
}

pub(super) fn raw_bytes(raw: &RawBranchCapture) -> Result<Vec<u8>, SyncError> {
    serde_json::to_vec(&encode(raw)?).map_err(|cause| SyncError::codec(world_protocol::failure::FailureStage::Decode, cause))
}
pub(super) fn digest(dto: &BranchSourceCapture) -> Result<Digest, SyncError> {
    crate::definitions::canonical_digest(&("world.source.branch.capture.v1", &dto.branch, &dto.compile_digest, &dto.model_digest, &dto.binding, &dto.plan_digest, &dto.source_version, &dto.basis, &dto.proposals, &dto.evidence, &dto.failures, dto.complete, dto.consistent)).map_err(|error| SyncError::Mapping(error.into()))
}
pub(super) fn request(raw: &RawBranchCapture, plan: &CompiledSourcePlan, version: &SourceVersion) -> MapRecordsRequest {
    MapRecordsRequest { observed_schema: plan.schema.clone(), source_version: version.clone(), batch: RecordBatch { source_id: plan.binding_body.source_id.clone(), incarnation: plan.binding_body.incarnation.clone(), schema: raw.page.basis.schema.clone(), rows: raw.page.rows.clone(), deleted_keys: Vec::new(), source_version: version.reference.clone(), valid_time: raw.valid_time.clone(), complete: raw.page.complete }, plan: plan.clone(), identities: Vec::new(), basis: raw.page.basis.clone(), budget: raw.budget.clone() }
}
pub(super) fn model_digests(model: &WorldBranch) -> Result<(Digest, Digest), SyncError> {
    let compile = crate::definitions::canonical_digest(&model.compile).map_err(|error| SyncError::Mapping(error.into()))?;
    let model = crate::compiler::model_digest(&model.compile).map_err(|error| SyncError::Mapping(mapping::MappingError::Definition(crate::definitions::DefinitionError::Compile(error))))?;
    Ok((compile, model))
}
fn checked(branch: &BranchRef, binding: &DefinitionRef, dto: BranchSourceCapture, raw: RawBranchCapture, model: &WorldBranch, plan: CompiledSourcePlan, version: SourceVersion) -> Result<BranchCapture, SyncError> {
    let (compile_digest, model_digest) = model_digests(model)?;
    let bytes = raw_bytes(&raw)?;
    let hash = world_protocol::schema::hash(&bytes).map_err(|_| SyncError::protocol())?;
    if dto.branch != *branch || dto.binding != *binding || raw.branch != *branch || dto.compile_digest != compile_digest || raw.compile_digest != compile_digest || dto.model_digest != model_digest || raw.model_digest != model_digest || dto.plan_digest != plan.digest || raw.plan_digest != plan.digest || dto.source_version != version.reference || version.blob.digest != hash || version.blob.byte_size != bytes.len() as u64 || dto.basis != raw.page.basis || dto.complete != raw.page.complete || dto.consistent != consistent(&plan, &raw.page) || dto.digest != digest(&dto)? { return Err(SyncError::protocol()); }
    let a = &raw.assignment;
    let b = &plan.binding_body;
    let contract = world_protocol::sources::read_contract().map_err(|cause| {
        SyncError::caused(
            world_protocol::sources::SourceFailure::ProtocolViolation,
            world_protocol::failure::FailureStage::Validate,
            cause,
        )
    })?;
    let mut providers = model.compile.activation_lock.nodes.iter().filter(|node| {
        node.slot == world_protocol::bindings::SlotKind::Connector
            && node.provider_id == b.connector
            && node.implementation.contracts.contains(&contract)
    });
    let provider = providers.next().ok_or_else(SyncError::protocol)?;
    if providers.next().is_some() || provider.implementation != a.implementation {
        return Err(SyncError::protocol());
    }
    let definition = model.compile.definitions.iter().find(|definition| definition.reference == *binding).ok_or_else(SyncError::protocol)?;
    if a.world != branch.world || a.binding != *binding || a.source_id != b.source_id || a.incarnation != b.incarnation
        || a.partition != b.resource || a.epoch != PartitionEpoch(1) || a.connection_id != b.connection_id
        || a.connection_revision != b.connection_revision || a.mapping != b.mapping || a.schema != b.schema
        || a.identity_rule != b.identity_rule || a.scope != b.scope
        || !crate::definitions::valid_time_contains(&definition.valid_time, &raw.valid_time)
        || !crate::definitions::valid_time_contains(&plan.authority.valid_time, &raw.valid_time)
    { return Err(SyncError::protocol()); }
    let (mut proposals, evidence, failures) = mapping::replay_branch_records(&request(&raw, &plan, &version))?;
    if proposals.len() != dto.proposals.len() || evidence != dto.evidence || failures != dto.failures { return Err(SyncError::protocol()); }
    for (expected, actual) in proposals.iter_mut().zip(&dto.proposals) {
        if actual.identity.is_none() { return Err(SyncError::protocol()); }
        expected.identity = actual.identity.clone();
        if expected != actual { return Err(SyncError::protocol()); }
    }
    Ok(BranchCapture { dto, raw, version, plan })
}
pub(super) fn consistent(plan: &CompiledSourcePlan, page: &SourcePage) -> bool {
    page.complete && page.continuation.is_none() && page.basis.gap.is_none() && page.basis.snapshot.is_some() && matches!(plan.binding_body.capabilities.snapshot, world_protocol::sources::SnapshotCapability::Transactional | world_protocol::sources::SnapshotCapability::StableKeyEnumeration)
}

pub(super) async fn insert(tx: &WorldTransaction<'_>, dto: &BranchSourceCapture, raw: &RawBranchCapture) -> Result<(), SyncError> {
    super::require_writer(tx)?;
    let b = &dto.branch;
    tx.execute("INSERT INTO world_source_branch_capture(tenant_id,world_id,branch_id,branch_revision,binding_id,binding_revision,capture_digest,compile_digest,model_digest,plan_digest,source_id,source_version_id,body,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING", &[&b.world.tenant_id.as_str(), &b.world.world_id.as_str(), &b.id.as_str(), &number(b.revision.0)?, &dto.binding.id.as_str(), &number(dto.binding.revision.0)?, &dto.digest.as_str(), &dto.compile_digest.as_str(), &dto.model_digest.as_str(), &dto.plan_digest.as_str(), &dto.source_version.source_id.as_str(), &dto.source_version.version_id.as_str(), &encode(dto)?, &encode(raw)?]).await?;
    Ok(())
}
