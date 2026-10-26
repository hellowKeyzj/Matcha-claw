use std::collections::{BTreeMap, BTreeSet};
use futures_util::TryFutureExt;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact}, definitions::DefinitionBody,
    evaluation::EvaluationArm, expression::{Effect, ExpressionIr, Parameter},
    identity::{IdentityRecord, SubjectRef}, ids::*, provenance::ReadDependency,
    query::{FieldCell, QueryArgument, QueryFailure, QueryRequest, ReadMode, SourceFreshness},
    releases::{BranchRef, Release, WorldBranch}, sources::BranchRecordProposal,
    time::Timestamp, value::{Cell, DirtyState, UnknownReason, Value, ValueType},
};
use crate::{authorization::{self, Admission}, extensions::invocation::CallBudget, sources::sync::{self, BranchCapture}, store::{StoreFuture, WorldTransaction}};
use super::{QueryError, current::{CurrentEvaluation, ReadAuthority}, engine, error::invalid, plan::{self, CheckedPlan}, projection::{self, ProjectedRelation, ProjectedSubject, Projection}};
use crate::facts::assertions::BranchDerivationRecord;
use world_protocol::{facts::{AssertionStatus, Claim, Polarity}, identity::IdentitySnapshot, provenance::{ConclusionSupport, SupportSnapshot}, time::ValidTime};

#[derive(Clone, Copy)]
enum Reader<'a, 'b> { Transaction(&'a WorldTransaction<'b>), Snapshot(&'a crate::store::WorldSnapshot<'b>) }
impl Reader<'_, '_> {
    fn world(&self) -> &WorldRef { match self { Self::Transaction(tx) => tx.world(), Self::Snapshot(snapshot) => snapshot.world() } }
    async fn branch(&self, reference: &BranchRef) -> Result<WorldBranch, QueryError> {
        match self { Self::Transaction(tx) => crate::releases::read_branch_revision(tx, reference).await?, Self::Snapshot(snapshot) => crate::releases::read_branch_revision_snapshot(snapshot, reference).await? }.ok_or_else(|| QueryFailure::BasisChanged.into())
    }
    fn raw_capture<'a>(
        &'a self,
        branch: &'a BranchRef,
        binding: &'a DefinitionRef,
    ) -> StoreFuture<'a, Option<BranchCapture>, QueryError> {
        match self {
            Self::Transaction(tx) => Box::pin(sync::read_branch_capture(tx, branch, binding).map_err(QueryError::from)),
            Self::Snapshot(snapshot) => Box::pin(sync::read_branch_capture_snapshot(snapshot, branch, binding).map_err(QueryError::from)),
        }
    }
    async fn release(&self, id: &ReleaseId) -> Result<Release, QueryError> {
        match self { Self::Transaction(tx) => crate::releases::read_release(tx, id).await?, Self::Snapshot(snapshot) => crate::releases::read_release_snapshot(snapshot, id).await? }.ok_or_else(|| QueryFailure::BasisChanged.into())
    }
    fn capture<'a>(
        &'a self,
        branch: &'a BranchRef,
        binding: &'a DefinitionRef,
    ) -> StoreFuture<'a, Option<BranchCapture>, QueryError> {
        Box::pin(async move {
            let branch = self.branch(branch).await?;
            self.selected_capture(&branch, binding).await
        })
    }
    fn selected_capture<'a>(
        &'a self,
        branch: &'a WorldBranch,
        binding: &'a DefinitionRef,
    ) -> StoreFuture<'a, Option<BranchCapture>, QueryError> {
        match self {
            Self::Transaction(tx) => Box::pin(sync::selected_branch_capture(tx, branch, binding).map_err(QueryError::from)),
            Self::Snapshot(snapshot) => Box::pin(sync::selected_branch_capture_snapshot(snapshot, branch, binding).map_err(QueryError::from)),
        }
    }
    async fn recheck(&self, captures: &[BranchCapture], admission: &Admission, now: &Timestamp) -> Result<(), QueryError> {
        self.recheck_authority(captures, ReadAuthority::Admitted(admission), now).await
    }
    fn recheck_authority<'a>(
        &'a self,
        captures: &'a [BranchCapture],
        authority: ReadAuthority<'a>,
        now: &'a Timestamp,
    ) -> StoreFuture<'a, (), QueryError> {
        Box::pin(async move {
            for capture in captures { self.recheck_capture(capture, authority, now).await?; }
            Ok(())
        })
    }
    fn recheck_capture<'a>(
        &'a self,
        capture: &'a BranchCapture,
        authority: ReadAuthority<'a>,
        now: &'a Timestamp,
    ) -> StoreFuture<'a, (), QueryError> {
        match (self, authority) {
            (Self::Transaction(tx), ReadAuthority::Admitted(admission)) => Box::pin(capture.recheck(tx, admission, now).map_err(QueryError::from)),
            (Self::Transaction(tx), ReadAuthority::Verified(verified)) => Box::pin(capture.recheck_preflight(tx, verified, now).map_err(QueryError::from)),
            (Self::Snapshot(snapshot), ReadAuthority::Admitted(admission)) => Box::pin(capture.recheck_snapshot(snapshot, admission, now).map_err(QueryError::from)),
            (Self::Snapshot(_), ReadAuthority::Verified(_)) => Box::pin(async { Err(QueryFailure::BasisChanged.into()) }),
        }
    }
    fn recheck_derivations<'a>(
        &'a self,
        authority: ReadAuthority<'a>,
        read: &'a super::receipt::StoredRead,
        release: &'a Release,
        now: &'a Timestamp,
    ) -> StoreFuture<'a, ActualImpact, QueryError> {
        let Some((branch, _)) = read.context.branch_model.as_ref() else {
            return Box::pin(async { Err(QueryFailure::BasisChanged.into()) });
        };
        match (self, authority) {
            (Self::Transaction(tx), ReadAuthority::Admitted(admission)) => Box::pin(crate::facts::assertions::recheck_branch_derivations(
                tx, admission, branch, release, &read.context.scope, &read.context.valid_time, &read.context.derivations, now,
            ).map_err(QueryError::from)),
            (Self::Transaction(tx), ReadAuthority::Verified(verified)) => Box::pin(crate::facts::assertions::recheck_branch_derivations_preflight(
                tx, verified, branch, release, &read.context.scope, &read.context.valid_time, &read.context.derivations, now,
            ).map_err(QueryError::from)),
            (Self::Snapshot(snapshot), ReadAuthority::Admitted(admission)) => Box::pin(crate::facts::assertions::recheck_branch_derivations_snapshot(
                snapshot, admission, branch, release, &read.context.scope, &read.context.valid_time, &read.context.derivations, now,
            ).map_err(QueryError::from)),
            (Self::Snapshot(_), ReadAuthority::Verified(_)) => Box::pin(async { Err(QueryFailure::BasisChanged.into()) }),
        }
    }
    fn require_evidence<'a>(
        &'a self,
        capture: &'a BranchCapture,
        authority: ReadAuthority<'a>,
        references: &'a [EvidenceRef],
        read: &'a super::receipt::StoredRead,
        now: &'a Timestamp,
    ) -> StoreFuture<'a, ActualImpact, QueryError> {
        match (self, authority) {
            (Self::Transaction(tx), ReadAuthority::Admitted(admission)) => Box::pin(capture.require_evidence(
                tx, admission, references, &read.context.scope, Some(&read.context.valid_time), now,
            ).map_err(QueryError::from)),
            (Self::Transaction(tx), ReadAuthority::Verified(verified)) => Box::pin(capture.require_evidence_preflight(
                tx, verified, references, &read.context.scope, Some(&read.context.valid_time), now,
            ).map_err(QueryError::from)),
            (Self::Snapshot(snapshot), ReadAuthority::Admitted(admission)) => Box::pin(capture.require_evidence_snapshot(
                snapshot, admission, references, &read.context.scope, Some(&read.context.valid_time), now,
            ).map_err(QueryError::from)),
            (Self::Snapshot(_), ReadAuthority::Verified(_)) => Box::pin(async { Err(QueryFailure::BasisChanged.into()) }),
        }
    }
    async fn capture_impact(&self, capture: &BranchCapture) -> Result<ActualImpact, QueryError> {
        Ok(match self { Self::Transaction(tx) => capture.read_impact(tx).await?, Self::Snapshot(snapshot) => capture.read_impact_snapshot(snapshot).await? })
    }
    async fn receipt(&self, id: &ReadReceiptId) -> Result<super::receipt::StoredRead, QueryError> {
        match self { Self::Transaction(tx) => super::receipt::read_transaction(tx, id).await, Self::Snapshot(snapshot) => super::receipt::read_snapshot(snapshot, id).await }
    }
    async fn current(&self, id: &DefinitionId) -> Result<Option<world_protocol::definitions::Definition<DefinitionBody>>, QueryError> {
        let model = match self {
            Self::Transaction(tx) => crate::releases::read_active_model(tx).await?,
            Self::Snapshot(snapshot) => match crate::releases::read_active_release_snapshot(snapshot).await? { Some(id) => Some(self.release(&id).await?), None => None },
        }.ok_or(QueryFailure::BasisChanged)?;
        Ok(model.definitions.into_iter().find(|definition| definition.reference.id == *id))
    }
}
pub(crate) async fn model(tx: &WorldTransaction<'_>, reference: &BranchRef, arm: &EvaluationArm) -> Result<(WorldBranch, Release), QueryError> { read_model(Reader::Transaction(tx), reference, arm).await }
pub(super) async fn model_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, reference: &BranchRef, arm: &EvaluationArm) -> Result<(WorldBranch, Release), QueryError> { read_model(Reader::Snapshot(snapshot), reference, arm).await }
async fn read_model(reader: Reader<'_, '_>, reference: &BranchRef, arm: &EvaluationArm) -> Result<(WorldBranch, Release), QueryError> {
    if reader.world() != &reference.world { return Err(invalid("branch.world")); }
    let branch = reader.branch(reference).await?;
    if branch.status == world_protocol::learning::ChangeStatus::Proposed { return Err(QueryFailure::BasisChanged.into()); }
    let release = reader.release(&branch.basis.release_id).await?;
    Ok((branch.clone(), selected_model(&branch, release, arm)?))
}
pub(crate) fn selected_model(branch: &WorldBranch, mut release: Release, arm: &EvaluationArm) -> Result<Release, QueryError> {
    if release.world != branch.world || release.id != branch.basis.release_id || branch.compile.base_release != release.id || branch.compile.world != branch.world { return Err(QueryFailure::BasisChanged.into()); }
    if matches!(arm, EvaluationArm::Candidate | EvaluationArm::Ablation { .. }) {
        if branch.status != world_protocol::learning::ChangeStatus::Proposed && branch.compile.activation_lock.id != branch.basis.activation_lock_id { return Err(QueryFailure::BasisChanged.into()); }
        release.definitions = branch.compile.definitions.clone(); release.scopes = branch.compile.scopes.clone();
        release.artifact.activation_lock_id = branch.compile.activation_lock.id.clone();
    }
    if !matches!(arm, EvaluationArm::Candidate | EvaluationArm::Ablation { .. }) { return Err(QueryFailure::BasisChanged.into()); }
    if let EvaluationArm::Ablation { disabled_definitions } = arm {
        if disabled_definitions.iter().any(|reference| !release.definitions.iter().any(|definition| &definition.reference == reference)) { return Err(QueryFailure::BasisChanged.into()); }
        release.definitions.retain(|definition| !disabled_definitions.contains(&definition.reference));
    }
    release.source_branch = Some(BranchRef { world: branch.world.clone(), id: branch.id.clone(), revision: branch.revision });
    Ok(release)
}

async fn captures(reader: Reader<'_, '_>, branch: &BranchRef, release: &Release, plan: &CheckedPlan) -> Result<Vec<BranchCapture>, QueryError> {
    captures_from(reader, branch, release, plan, None).await
}
async fn captures_from(reader: Reader<'_, '_>, branch: &BranchRef, release: &Release, plan: &CheckedPlan, supplied: Option<&[BranchCapture]>) -> Result<Vec<BranchCapture>, QueryError> {
    let mut result = Vec::new();
    for definition in &release.definitions {
        let DefinitionBody::SourceBinding(binding) = &definition.body else { continue; };
        if !plan.datasets.iter().any(|dataset| dataset.id == binding.identity_mapping.type_id) && !plan.datasets.iter().any(|dataset| release.definitions.iter().any(|definition| definition.reference == *dataset && matches!(&definition.body, DefinitionBody::RelationType(relation) if relation.roles.iter().any(|role| role.target_type.id == binding.identity_mapping.type_id)))) { continue; }
        let capture = match supplied {
            Some(captures) => {
                let mut matches = captures.iter().filter(|capture| capture.capture().binding == definition.reference);
                let selected = matches.next().cloned();
                if matches.next().is_some() { return Err(QueryFailure::BasisChanged.into()); }
                selected
            },
            None => reader.capture(branch, &definition.reference).await?,
        }.ok_or_else(|| QueryFailure::GuaranteeUnsatisfied { mode: ReadMode::Authoritative, source_id: Some(binding.source_id.clone()) })?;
        let body = capture.capture();
        if !body.complete || !body.consistent || !body.failures.is_empty() || body.branch.world != branch.world || body.branch.id != branch.id || body.branch.revision > branch.revision || body.binding != definition.reference || body.basis.gap.is_some()
            || body.basis.mapping_revision != binding.mapping.revision || body.basis.authority_revision != binding.authority.revision
            || body.basis.schema != binding.schema || body.basis.identity_rule != binding.identity_rule { return Err(QueryFailure::BasisChanged.into()); }
        result.push(capture);
    }
    Ok(result)
}

async fn guarantees(reader: Reader<'_, '_>, admission: &Admission, mode: &ReadMode, known_at: Option<&Timestamp>, captures: &[BranchCapture], now: &Timestamp) -> Result<Vec<SourceFreshness>, QueryError> {
    guarantees_authority(reader, ReadAuthority::Admitted(admission), mode, known_at, captures, now).await
}
async fn guarantees_authority(reader: Reader<'_, '_>, authority: ReadAuthority<'_>, mode: &ReadMode, known_at: Option<&Timestamp>, captures: &[BranchCapture], now: &Timestamp) -> Result<Vec<SourceFreshness>, QueryError> {
    let at = known_at.unwrap_or(now);
    if at.unix_nanos() > now.unix_nanos() { return Err(invalid("knownAt")); }
    if let ReadMode::After { receipt_id } = mode {
        let previous = reader.receipt(receipt_id).await?;
        super::receipt::require_current_authority(&previous, authority, now)?;
        if let Reader::Transaction(tx) = reader { authority.check(tx, &previous.impact, now).await?; }
        for basis in &previous.receipt.basis {
            let capture = captures.iter().find(|capture| capture.capture().binding == basis.binding)
                .ok_or_else(|| QueryFailure::GuaranteeUnsatisfied { mode: mode.clone(), source_id: Some(basis.source_id.clone()) })?;
            sync::require_capture_after(capture, basis)?;
        }
    }
    let mut freshness = Vec::new();
    for capture in captures {
        let basis = &capture.capture().basis;
        let lag = at.unix_nanos() - basis.observed_at.unix_nanos();
        let satisfied = lag >= 0 && basis.captured_at.as_ref().is_none_or(|captured| captured.unix_nanos() <= at.unix_nanos())
            && capture.source_version().captured_at.unix_nanos() <= at.unix_nanos()
            && basis.gap.is_none() && match mode {
                ReadMode::Projected { max_lag } => basis.guarantee != world_protocol::sources::SourceGuarantee::Assumed && lag <= i128::from(max_lag.0) * 1_000_000,
                ReadMode::Authoritative => basis.guarantee == world_protocol::sources::SourceGuarantee::Authoritative,
                ReadMode::After { .. } => basis.guarantee != world_protocol::sources::SourceGuarantee::Assumed,
            };
        if !satisfied { return Err(QueryFailure::GuaranteeUnsatisfied { mode: mode.clone(), source_id: Some(basis.source_id.clone()) }.into()); }
        freshness.push(SourceFreshness { source_id: basis.source_id.clone(), lag: Some(world_protocol::time::DurationMs(((lag + 999_999) / 1_000_000).min(i128::from(u64::MAX)) as u64)), last_reconciled_at: basis.last_reconciled_at.clone(), satisfied });
    }
    Ok(freshness)
}

async fn impact_for(reader: Reader<'_, '_>, branch: &BranchRef, release: &Release, plan: &CheckedPlan, captures: &[BranchCapture], scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let mut access = vec![AccessScope { resources: vec![ResourceRef::Branch { id: branch.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }];
    let mut fields = plan.fields.clone();
    for capture in captures { for record in &capture.capture().proposals { fields.extend(record.fields.iter().map(|field| field.property.clone())); } }
    let mut labels = Vec::new(); let mut sources = Vec::new(); let mut effects = vec![Effect::Pure]; let mut state = Vec::new();
    for reference in &fields {
        let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        let DefinitionBody::Property(property) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
        labels.extend(property.access_labels.clone());
        access.push(AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: vec![reference.clone()], modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
        if let Some(current) = reader.current(&reference.id).await? {
            let DefinitionBody::Property(property) = current.body else { return Err(QueryFailure::BasisChanged.into()); };
            labels.extend(property.access_labels);
            access.push(AccessScope { resources: vec![ResourceRef::Definition { id: reference.id.clone() }], fields: vec![reference.clone()], modes: vec![AccessMode::Read], scope: current.scope, valid_time: None });
        }
    }
    for dataset in &plan.datasets {
        let definition = release.definitions.iter().find(|definition| definition.reference == *dataset).ok_or(QueryFailure::BasisChanged)?;
        access.push(AccessScope { resources: vec![ResourceRef::Definition { id: dataset.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
    }
    for capture in captures {
        let material = reader.capture_impact(capture).await?;
        access.extend(material.access); labels.extend(material.labels); sources.extend(material.source_ids); effects.extend(material.effects); state.extend(material.state);
        let body = capture.capture(); let binding = release.definitions.iter().find(|definition| definition.reference == body.binding).ok_or(QueryFailure::BasisChanged)?;
        sources.push(body.basis.source_id.clone());
        access.push(AccessScope { resources: vec![ResourceRef::Source { id: body.basis.source_id.clone() }], fields: fields.iter().cloned().collect(), modes: vec![AccessMode::Read], scope: binding.scope.clone(), valid_time: None });
        for record in &body.proposals {
            if let Some(identity) = &record.identity {
                access.push(AccessScope { resources: vec![projection::resource(&subject(&identity.record))], fields: record.fields.iter().map(|field| field.property.clone()).collect(), modes: vec![AccessMode::Read], scope: binding.scope.clone(), valid_time: Some(record.key.valid_time.clone()) });
            }
        }
        for evidence in &body.evidence {
            labels.extend(evidence.access.labels.clone());
            access.push(AccessScope { resources: vec![ResourceRef::Evidence { id: evidence.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: binding.scope.clone(), valid_time: None });
        }
    }
    let material = match reader {
        Reader::Transaction(tx) => crate::facts::assertions::branch_derivation_impact(tx, branch, release, scope).await?,
        Reader::Snapshot(snapshot) => crate::facts::assertions::branch_derivation_impact_snapshot(snapshot, branch, release, scope).await?,
    };
    access.extend(material.access); effects.extend(material.effects); labels.extend(material.labels); state.extend(material.state); sources.extend(material.source_ids);
    Ok(authorization::actual_impact(access, effects, labels, state, sources)?)
}

pub(crate) async fn branch_impact_in_transaction(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, query: &world_protocol::query::QueryIr, _arguments: &[QueryArgument], scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    query_impact_in_model(tx, branch, &release, query, scope).await
}
pub(super) async fn query_impact_in_model(tx: &WorldTransaction<'_>, branch: &BranchRef, release: &Release, query: &world_protocol::query::QueryIr, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let plan = plan::check(query, release)?; let captures = captures(Reader::Transaction(tx), branch, release, &plan).await?;
    impact_for(Reader::Transaction(tx), branch, release, &plan, &captures, scope).await
}

pub(super) async fn impact_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, branch: &BranchRef, request: &QueryRequest, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let (_, release) = read_model(Reader::Snapshot(snapshot), branch, &EvaluationArm::Candidate).await?;
    let plan = plan::check(&request.query, &release)?;
    let captures = captures(Reader::Snapshot(snapshot), branch, &release, &plan).await?;
    impact_for(Reader::Snapshot(snapshot), branch, &release, &plan, &captures, scope).await
}
async fn retained(reader: Reader<'_, '_>, admission: &Admission, now: &Timestamp, request: &QueryRequest, scope: &ScopeId, read: &super::receipt::StoredRead) -> Result<(Release, ActualImpact), QueryError> {
    let id = request.branch_id.as_ref().ok_or(QueryFailure::CursorInvalid)?;
    let (reference, _) = read.context.branch_model.as_ref().ok_or(QueryFailure::CursorInvalid)?;
    if &reference.id != id || reference.world != *reader.world() || &read.context.scope != scope { return Err(QueryFailure::CursorInvalid.into()); }
    let release = stored_model(reader, admission, read).await?;
    if read.receipt.branch_id.as_ref() != Some(id) || read.receipt.release_id != release.id || read.receipt.activation_lock_id != release.artifact.activation_lock_id
        || super::execution::evaluated_scope_digest(&read.context, &release, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::CursorInvalid.into()); }
    let plan = plan::check(&request.query, &release)?;
    let captures = stored_captures(reader, read).await?;
    if captures.iter().map(|capture| &capture.capture().basis).ne(read.receipt.basis.iter()) || captures.iter().map(|capture| (&capture.capture().binding, &capture.capture().digest)).ne(read.context.captures.iter().map(|(binding, digest)| (binding, digest))) { return Err(QueryFailure::BasisChanged.into()); }
    reader.recheck(&captures, admission, now).await?;
    guarantees(reader, admission, &request.read_mode, request.known_at.as_ref(), &captures, now).await?;
    let impact = impact_for(reader, &reference, &release, &plan, &captures, scope).await?;
    Ok((release, impact))
}
pub(super) async fn recheck_receipt(tx: &WorldTransaction<'_>, admission: &Admission, read: &super::receipt::StoredRead, now: &Timestamp) -> Result<Release, QueryError> {
    recheck_receipt_authority(tx, ReadAuthority::Admitted(admission), read, now).await
}
pub(super) async fn recheck_receipt_authority(tx: &WorldTransaction<'_>, authority: ReadAuthority<'_>, read: &super::receipt::StoredRead, now: &Timestamp) -> Result<Release, QueryError> {
    authority.check(tx, &read.impact, now).await?;
    recheck_stored(Reader::Transaction(tx), authority, read, now).await
}
async fn recheck_stored(reader: Reader<'_, '_>, authority: ReadAuthority<'_>, read: &super::receipt::StoredRead, now: &Timestamp) -> Result<Release, QueryError> {
    let (branch, _) = read.context.branch_model.as_ref().ok_or(QueryFailure::BasisChanged)?;
    let release = stored_model_plan(reader, read).await?;
    if read.receipt.branch_id.as_ref() != Some(&branch.id) || read.receipt.release_id != release.id || read.receipt.activation_lock_id != release.artifact.activation_lock_id
        || super::execution::evaluated_scope_digest(&read.context, &release, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::BasisChanged.into()); }
    let captures = stored_captures(reader, read).await?;
    reader.recheck_authority(&captures, authority, now).await?;
    guarantees_authority(reader, authority, &read.receipt.requested_mode, read.context.known_at.as_ref(), &captures, now).await?;
    Ok(release)
}
async fn stored_model(reader: Reader<'_, '_>, admission: &Admission, read: &super::receipt::StoredRead) -> Result<Release, QueryError> {
    match reader {
        Reader::Transaction(tx) => authorization::recheck(tx, admission, &tx.now().await?).await?,
        Reader::Snapshot(snapshot) => authorization::recheck_read(snapshot, admission, &snapshot.now().await?).await?,
    };
    stored_model_plan(reader, read).await
}
async fn stored_model_plan(reader: Reader<'_, '_>, read: &super::receipt::StoredRead) -> Result<Release, QueryError> {
    let (branch, arm) = read.context.branch_model.as_ref().ok_or(QueryFailure::BasisChanged)?;
    if let Some(seal) = &read.context.frozen_model {
        return match reader {
            Reader::Transaction(tx) => super::frozen::reload_plan(tx, branch, arm, seal).await,
            Reader::Snapshot(snapshot) => super::frozen::reload_plan_snapshot(snapshot, branch, arm, seal).await,
        };
    }
    if read.context.capture_selection == super::receipt::CaptureSelection::Target {
        let target = reader.branch(branch).await?;
        selected_model(&target, reader.release(&target.basis.release_id).await?, arm)
    } else { Ok(read_model(reader, branch, arm).await?.1) }
}
pub(super) async fn stored_model_transaction(tx: &WorldTransaction<'_>, admission: &Admission, read: &super::receipt::StoredRead) -> Result<Release, QueryError> { stored_model(Reader::Transaction(tx), admission, read).await }
pub(super) async fn stored_model_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, read: &super::receipt::StoredRead) -> Result<Release, QueryError> { stored_model(Reader::Snapshot(snapshot), admission, read).await }
pub(super) async fn stored_plan_transaction(tx: &WorldTransaction<'_>, read: &super::receipt::StoredRead) -> Result<Release, QueryError> { stored_model_plan(Reader::Transaction(tx), read).await }
pub(super) async fn stored_plan_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, read: &super::receipt::StoredRead) -> Result<Release, QueryError> { stored_model_plan(Reader::Snapshot(snapshot), read).await }
fn stored_captures<'a>(
    reader: Reader<'a, '_>,
    read: &'a super::receipt::StoredRead,
) -> StoreFuture<'a, Vec<BranchCapture>, QueryError> {
    Box::pin(async move {
        let (branch, _) = read.context.branch_model.as_ref().ok_or(QueryFailure::BasisChanged)?;
        let mut captures = Vec::new();
        for (binding, digest) in &read.context.captures {
            let capture = match read.context.capture_selection {
                super::receipt::CaptureSelection::Selected => reader.capture(branch, binding),
                super::receipt::CaptureSelection::Target => reader.raw_capture(branch, binding),
            }.await?.ok_or(QueryFailure::BasisChanged)?;
            if &capture.capture().digest != digest { return Err(QueryFailure::BasisChanged.into()); }
            captures.push(capture);
        }
        if captures.iter().map(|capture| &capture.capture().basis).ne(read.receipt.basis.iter()) { return Err(QueryFailure::BasisChanged.into()); }
        Ok(captures)
    })
}

pub(super) fn dependency_inputs<'a>(
    tx: &'a WorldTransaction<'_>,
    authority: ReadAuthority<'a>,
    read: &'a super::receipt::StoredRead,
    release: &'a Release,
    now: &'a Timestamp
) -> StoreFuture<'a, (Vec<ReadDependency>, Option<ActualImpact>), QueryError> {
    read_dependencies(Reader::Transaction(tx), authority, read, release, now)
}
pub(super) fn dependency_inputs_snapshot<'a>(
    snapshot: &'a crate::store::WorldSnapshot<'_>,
    admission: &'a Admission,
    read: &'a super::receipt::StoredRead,
    release: &'a Release,
    now: &'a Timestamp
) -> StoreFuture<'a, (Vec<ReadDependency>, Option<ActualImpact>), QueryError> {
    read_dependencies(Reader::Snapshot(snapshot), ReadAuthority::Admitted(admission), read, release, now)
}
fn read_dependencies<'a>(
    reader: Reader<'a, '_>,
    authority: ReadAuthority<'a>,
    read: &'a super::receipt::StoredRead,
    release: &'a Release,
    now: &'a Timestamp
) -> StoreFuture<'a, (Vec<ReadDependency>, Option<ActualImpact>), QueryError> {
    Box::pin(async move {
        let captures = stored_captures(reader, read).await?;
        reader.recheck_authority(&captures, authority, now).await?;
        let (dependencies, evidence) = split_dependencies(&captures, read, release)?;
        let material = reader.recheck_derivations(authority, read, release, now).await?;
        let (mut access, mut effects, mut labels, mut state, mut sources) = (material.access, material.effects, material.labels, material.state, material.source_ids);
        for (index, references) in evidence {
            let references: Vec<_> = references.into_iter().collect();
            let material = reader.require_evidence(&captures[index], authority, &references, read, now).await?;
            access.extend(material.access); effects.extend(material.effects); labels.extend(material.labels); state.extend(material.state); sources.extend(material.source_ids);
        }
        let impact = if access.is_empty() { None } else { Some(authorization::actual_impact(access, effects, labels, state, sources)?) };
        Ok((dependencies, impact))
    })
}
pub(super) async fn stored_dependency_impact(tx: &WorldTransaction<'_>, read: &super::receipt::StoredRead, release: &Release) -> Result<ActualImpact, QueryError> { stored_impact(Reader::Transaction(tx), read, release).await }
pub(super) async fn stored_dependency_impact_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, read: &super::receipt::StoredRead, release: &Release) -> Result<ActualImpact, QueryError> { stored_impact(Reader::Snapshot(snapshot), read, release).await }
async fn stored_impact(reader: Reader<'_, '_>, read: &super::receipt::StoredRead, release: &Release) -> Result<ActualImpact, QueryError> {
    let captures = stored_captures(reader, read).await?;
    let (dependencies, _) = split_dependencies(&captures, read, release)?;
    let (branch, _) = read.context.branch_model.as_ref().ok_or(QueryFailure::BasisChanged)?;
    let plan = input_plan(&read.input, release)?;
    let mut impact = impact_for(reader, branch, release, &plan, &captures, &read.context.scope).await?;
    let material = match reader {
        Reader::Transaction(tx) => crate::facts::support::dependency_impact(tx, &dependencies, release, &read.context.scope, &read.context.valid_time).await?,
        Reader::Snapshot(snapshot) => crate::facts::support::dependency_impact_snapshot(snapshot, &dependencies, release, &read.context.scope, &read.context.valid_time).await?,
    };
    if let Some(material) = material {
        impact.access.extend(material.access); impact.effects.extend(material.effects); impact.labels.extend(material.labels); impact.state.extend(material.state); impact.source_ids.extend(material.source_ids);
    }
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}
fn split_dependencies(captures: &[BranchCapture], read: &super::receipt::StoredRead, release: &Release) -> Result<(Vec<ReadDependency>, BTreeMap<usize, BTreeSet<EvidenceRef>>), QueryError> {
    let mut dependencies = Vec::new();
    let mut evidence = BTreeMap::<usize, BTreeSet<EvidenceRef>>::new();
    for dependency in &read.receipt.actual_dependencies {
        let captured = match dependency {
            ReadDependency::Assertion { reference } => read.context.derivations.iter().any(|(actual, _)| actual == reference),
            ReadDependency::Identity { subject: target, revision } => {
                let identities: Vec<_> = captures.iter().flat_map(|capture| &capture.capture().proposals).filter(|record| record.key.valid_time.contains(&read.context.valid_time.from)).filter_map(|record| record.identity.as_ref()).filter(|identity| subject(&identity.record) == *target).collect();
                if identities.is_empty() { false } else { if identities.iter().any(|identity| identity.revision != *revision) { return Err(QueryFailure::BasisChanged.into()); } true }
            },
            ReadDependency::Evidence { reference } => {
                if let Some((index, _)) = captures.iter().enumerate().find(|(_, capture)| capture.capture().evidence.iter().any(|evidence| evidence.reference == *reference)) { evidence.entry(index).or_default().insert(reference.clone()); true } else { false }
            },
            ReadDependency::Source { position, binding } => captures.iter().any(|capture| capture.capture().binding == *binding && capture.capture().basis.position.as_ref() == Some(position)),
            ReadDependency::SourceMapping { mapping, identity_rule, authority, binding } => {
                if let Some(capture) = captures.iter().find(|capture| capture.capture().binding == *binding) {
                    let definition = release.definitions.iter().find(|definition| definition.reference == *binding).ok_or(QueryFailure::BasisChanged)?;
                    if !matches!(&definition.body, DefinitionBody::SourceBinding(body) if body.mapping == *mapping && body.identity_rule == *identity_rule && body.authority == *authority && capture.capture().basis.schema == body.schema) { return Err(QueryFailure::BasisChanged.into()); }
                    true
                } else { false }
            },
            _ => false,
        };
        if !captured { dependencies.push(dependency.clone()); }
    }
    Ok((dependencies, evidence))
}

pub(super) async fn recheck_guarantees(tx: &WorldTransaction<'_>, admission: &Admission, request: &QueryRequest, captures: &[BranchCapture], now: &Timestamp) -> Result<(), QueryError> {
    guarantees(Reader::Transaction(tx), admission, &request.read_mode, request.known_at.as_ref(), captures, now).await?;
    Ok(())
}

pub(super) async fn retained_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId, read: &super::receipt::StoredRead) -> Result<(Release, ActualImpact), QueryError> { retained(Reader::Snapshot(snapshot), admission, &snapshot.now().await?, request, scope, read).await }
pub(super) async fn retained_transaction(tx: &WorldTransaction<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId, read: &super::receipt::StoredRead) -> Result<ActualImpact, QueryError> { Ok(retained(Reader::Transaction(tx), admission, &tx.now().await?, request, scope, read).await?.1) }

pub(super) async fn execute_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, branch: &BranchRef, request: &QueryRequest, scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, verified: &VerifiedBasis) -> Result<super::PreparedQuery, QueryError> {
    if request.world != branch.world || request.branch_id.as_ref() != Some(&branch.id) || request.page.cursor.is_some() || request.page.limit == 0 || request.page.limit > world_protocol::api::MAX_PAGE_ITEMS { return Err(invalid("branch.query")); }
    let now = snapshot.now().await?; authorization::recheck_read(snapshot, admission, &now).await?;
    let at = request.valid_at.clone().unwrap_or_else(|| now.clone());
    let (_, release) = read_model(Reader::Snapshot(snapshot), branch, &EvaluationArm::Candidate).await?;
    if request.release_id.as_ref().is_some_and(|id| id != &release.id) { return Err(QueryFailure::BasisChanged.into()); }
    let plan = plan::check(&request.query, &release)?;
    let captures = captures(Reader::Snapshot(snapshot), branch, &release, &plan).await?;
    verified.require_same(branch, &release, &captures)?;
    let impact = impact_for(Reader::Snapshot(snapshot), branch, &release, &plan, &captures, scope).await?; admission.require_access(&impact)?;
    Reader::Snapshot(snapshot).recheck(&captures, admission, &now).await?;
    let freshness = guarantees(Reader::Snapshot(snapshot), admission, &request.read_mode, request.known_at.as_ref(), &captures, &now).await?;
    let interval = projection::point(&at)?;
    let derivations = derivations(Reader::Snapshot(snapshot), admission, branch, &release, scope, &interval, budget, cancel).await?;
    let identities = derivation_identities(Reader::Snapshot(snapshot), &captures, &derivations).await?;
    let mut projection = project(&release, &plan, &captures, &at, budget, cancel)?;
    merge_derivations(&mut projection, &release, &plan, &derivations, &identities, &interval, &now, budget, cancel)?;
    let basis: Vec<_> = captures.iter().map(|capture| capture.capture().basis.clone()).collect();
    let mut context = super::receipt::ReadContext::branch(scope, interval, branch, &EvaluationArm::Candidate, &captures, request.known_at.as_ref());
    context.derivations = derivation_basis(&derivations)?;
    let mut prepared = super::execution::assemble(admission, request.clone(), context, release, plan, projection, impact, Vec::new(), basis, freshness, now, at, budget, cancel)?;
    prepared.branch_captures = captures; prepared.branch_model = Some((branch.clone(), EvaluationArm::Candidate));
    Ok(prepared)
}

fn subject(record: &IdentityRecord) -> SubjectRef {
    match record { IdentityRecord::Object(object) => SubjectRef::Object { id: object.id.clone() }, IdentityRecord::Relation(relation) => SubjectRef::Relation { id: relation.id.clone() } }
}
fn merge_cell(left: &mut Cell, right: &Cell) {
    if left != right { *left = Cell::Conflicted { assertions: Vec::new() }; }
}
fn role_cells(release: &Release, record: &BranchRecordProposal, all: &[&BranchRecordProposal], at: &Timestamp) -> Result<Option<ProjectedRelation>, QueryError> {
    let Some(identity) = &record.identity else { return Ok(None); };
    let IdentityRecord::Relation(identity) = &identity.record else {
        if !record.relations.is_empty() { return Err(QueryFailure::BasisChanged.into()); }
        return Ok(None);
    };
    let definition = release.definitions.iter().find(|definition| definition.reference == record.type_ref).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::RelationType(body) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
    let mut relation = ProjectedRelation { claim: None, type_ref: definition.reference.clone(), roles: Vec::new(), cells: BTreeMap::new(), valid_time: record.key.valid_time.clone() };
    let groups: Vec<_> = record.relations.iter().filter(|proposal| proposal.relation_type == record.type_ref).collect();
    for role in &body.roles {
        let mut objects = BTreeSet::new(); let mut unknown = groups.is_empty(); let mut conflicted = false;
        for group in &groups {
            for endpoint in group.roles.iter().filter(|endpoint| endpoint.role == role.id) {
                let targets: BTreeSet<_> = all.iter().filter(|candidate| candidate.key.source_id == endpoint.target_source && candidate.key.namespace == endpoint.target_namespace && candidate.key.native_key == endpoint.native_key && candidate.key.valid_time.contains(at))
                    .filter_map(|candidate| candidate.identity.as_ref()).filter_map(|identity| match &identity.record { IdentityRecord::Object(object) if object.type_id == role.target_type.id => Some(object.id.clone()), _ => None }).collect();
                if targets.is_empty() { unknown = true; } else if targets.len() != 1 { conflicted = true; } else { objects.extend(targets); }
            }
        }
        let cell = if conflicted || role.cardinality.maximum.is_some_and(|maximum| objects.len() > maximum as usize) { Cell::Conflicted { assertions: Vec::new() } }
            else if unknown || objects.len() < role.cardinality.minimum as usize { Cell::Unknown { reason: UnknownReason::IncompleteCoverage } }
            else {
                relation.roles.extend(objects.iter().cloned().map(|object_id| world_protocol::facts::RoleBinding { role: role.id.clone(), object_id }));
                let values: Vec<_> = objects.into_iter().map(|id| Value::Object { id }).collect();
                Cell::Known { value: if role.cardinality.maximum == Some(1) { values.into_iter().next().unwrap_or(Value::Null) } else { Value::List { items: values } } }
            };
        relation.cells.insert(role.id.clone(), cell);
    }
    if identity.type_id != record.type_ref.id || record.relations.iter().any(|proposal| proposal.relation_type != record.type_ref) { return Err(QueryFailure::BasisChanged.into()); }
    Ok(Some(relation))
}

pub(super) fn project(release: &Release, plan: &CheckedPlan, captures: &[BranchCapture], at: &Timestamp, budget: &CallBudget, cancel: &CancellationToken) -> Result<Projection, QueryError> {
    let mut projection = Projection { subjects: BTreeMap::new(), dependencies: Vec::new(), labels: Vec::new(), sources: BTreeSet::new(), incomplete: false };
    let records: Vec<_> = captures.iter().flat_map(|capture| &capture.capture().proposals).filter(|record| record.key.valid_time.contains(at)).collect();
    for capture in captures {
        let body = capture.capture(); projection.sources.insert(body.basis.source_id.clone());
        let definition = release.definitions.iter().find(|definition| definition.reference == body.binding).ok_or(QueryFailure::BasisChanged)?;
        let DefinitionBody::SourceBinding(binding) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
        projection.dependencies.push(ReadDependency::SourceMapping { mapping: binding.mapping.clone(), identity_rule: binding.identity_rule.clone(), authority: binding.authority.clone(), binding: body.binding.clone() });
        if let Some(position) = &body.basis.position { projection.dependencies.push(ReadDependency::Source { position: position.clone(), binding: body.binding.clone() }); }
    }
    for record in &records {
        if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
        let Some(identity) = &record.identity else { projection.incomplete = true; continue; };
        let type_id = match &identity.record { IdentityRecord::Object(object) => &object.type_id, IdentityRecord::Relation(relation) => &relation.type_id };
        if type_id != &record.type_ref.id { return Err(QueryFailure::BasisChanged.into()); }
        let subject = subject(&identity.record);
        projection.dependencies.push(ReadDependency::Identity { subject: subject.clone(), revision: identity.revision });
        projection.dependencies.extend(record.relations.iter().flat_map(|relation| relation.evidence.iter().cloned()).map(|reference| ReadDependency::Evidence { reference }));
        let mut fields = BTreeMap::new();
        for reference in &plan.fields {
            let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
            let DefinitionBody::Property(property) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
            if !property.domain.contains(type_id) { continue; }
            projection.labels.extend(property.access_labels.clone());
            let proposals: Vec<_> = record.fields.iter().filter(|field| field.property == *reference).collect();
            let Some(first) = proposals.first() else { continue; };
            let mut cell = first.cell.clone();
            for proposal in proposals.iter().skip(1) { merge_cell(&mut cell, &proposal.cell); }
            let evidence: Vec<_> = proposals.iter().flat_map(|field| field.evidence.clone()).collect();
            projection.dependencies.extend(evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference }));
            fields.insert(reference.clone(), FieldCell { property: reference.clone(), cell, evidence, dirty: DirtyState::Clean });
        }
        let relation = if record.relations.is_empty() { None } else { role_cells(release, record, &records, at)? };
        if relation.as_ref().is_some_and(|relation| relation.cells.values().any(|cell| !matches!(cell, Cell::Known { .. }))) { projection.incomplete = true; }
        match projection.subjects.entry(subject) {
            std::collections::btree_map::Entry::Vacant(entry) => { entry.insert(ProjectedSubject { identity: identity.clone(), fields, relation }); }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                let existing = entry.get_mut();
                if existing.identity != *identity { return Err(QueryFailure::BasisChanged.into()); }
                for (reference, field) in fields {
                    if let Some(previous) = existing.fields.get_mut(&reference) { merge_cell(&mut previous.cell, &field.cell); previous.evidence.extend(field.evidence); }
                    else { existing.fields.insert(reference, field); }
                }
                if let Some(relation) = relation {
                    if let Some(previous) = &mut existing.relation {
                        if (&previous.roles, &previous.cells) != (&relation.roles, &relation.cells) { projection.incomplete = true; for cell in previous.cells.values_mut() { *cell = Cell::Conflicted { assertions: Vec::new() }; } }
                    } else { existing.relation = Some(relation); }
                }
            }
        }
    }
    for projected in projection.subjects.values_mut() {
        let type_id = match &projected.identity.record { IdentityRecord::Object(object) => &object.type_id, IdentityRecord::Relation(relation) => &relation.type_id };
        for reference in &plan.fields {
            let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
            if matches!(&definition.body, DefinitionBody::Property(property) if property.domain.contains(type_id)) {
                projected.fields.entry(reference.clone()).or_insert_with(|| FieldCell { property: reference.clone(), cell: Cell::Unknown { reason: UnknownReason::Unmapped }, evidence: Vec::new(), dirty: DirtyState::Clean });
            }
        }
        if matches!(&projected.identity.record, IdentityRecord::Relation(_)) && projected.relation.is_none() {
            let definition = release.definitions.iter().find(|definition| &definition.reference.id == type_id).ok_or(QueryFailure::BasisChanged)?;
            let DefinitionBody::RelationType(body) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
            projected.relation = Some(ProjectedRelation { claim: None, type_ref: definition.reference.clone(), roles: Vec::new(), cells: body.roles.iter().map(|role| (role.id.clone(), Cell::Unknown { reason: UnknownReason::IncompleteCoverage })).collect(), valid_time: projection::point(at)? });
            projection.incomplete = true;
        }
    }
    Ok(projection)
}

fn merge_impact(target: &mut ActualImpact, material: ActualImpact) {
    target.access.extend(material.access); target.effects.extend(material.effects); target.labels.extend(material.labels);
    target.state.extend(material.state); target.source_ids.extend(material.source_ids);
}
pub(super) fn derivation_basis(records: &[BranchDerivationRecord]) -> Result<Vec<(AssertionRef, Digest)>, QueryError> {
    records.iter().map(|record| Ok((record.assertion.reference.clone(), crate::definitions::canonical_digest(record)?))).collect()
}
async fn derivations(reader: Reader<'_, '_>, admission: &Admission, branch: &BranchRef, release: &Release, scope: &ScopeId, interval: &ValidTime, budget: &CallBudget, cancel: &CancellationToken) -> Result<Vec<BranchDerivationRecord>, QueryError> {
    Ok(match reader {
        Reader::Transaction(tx) => crate::facts::assertions::read_branch_derivations(tx, admission.verified(), branch, release, scope, interval, budget, cancel).await?,
        Reader::Snapshot(snapshot) => crate::facts::assertions::read_branch_derivations_snapshot(snapshot, admission, branch, release, scope, interval, budget, cancel).await?,
    })
}
async fn derivation_identities(reader: Reader<'_, '_>, captures: &[BranchCapture], records: &[BranchDerivationRecord]) -> Result<BTreeMap<SubjectRef, IdentitySnapshot>, QueryError> {
    let mut identities = BTreeMap::new();
    for capture in captures { for record in &capture.capture().proposals { if let Some(identity) = &record.identity {
        let target = subject(&identity.record);
        if identities.get(&target).is_some_and(|old| old != identity) { return Err(QueryFailure::BasisChanged.into()); }
        identities.insert(target, identity.clone());
    } } }
    for record in records { for target in crate::facts::assertions::claim_subjects(&record.assertion.claim) {
        if identities.contains_key(&target) { continue; }
        let identity = match reader { Reader::Transaction(tx) => crate::identity::get_in_transaction(tx, &target).await?, Reader::Snapshot(snapshot) => crate::identity::get(snapshot, &target).await? }.ok_or(QueryFailure::BasisChanged)?;
        identities.insert(target, identity);
    } }
    Ok(identities)
}
pub(super) fn merge_derivations(
    projection: &mut Projection, release: &Release, plan: &CheckedPlan, records: &[BranchDerivationRecord], identities: &BTreeMap<SubjectRef, IdentitySnapshot>,
    interval: &ValidTime, now: &Timestamp, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(), QueryError> {
    let branch = release.source_branch.as_ref().ok_or(QueryFailure::BasisChanged)?;
    let mut grouped = BTreeMap::<SubjectRef, Vec<&BranchDerivationRecord>>::new();
    for record in records {
        if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
        let assertion = &record.assertion;
        if assertion.status != AssertionStatus::Accepted || assertion.recorded_at > *now || !crate::definitions::valid_time_contains(&assertion.valid_time, interval) { continue; }
        let target = match &assertion.claim { Claim::Attribute(claim) if plan.fields.contains(&claim.property) => claim.subject.clone(), Claim::Relation(claim) => SubjectRef::Relation { id: claim.relation_id.clone() }, _ => continue };
        let identity = identities.get(&target).ok_or(QueryFailure::BasisChanged)?;
        let type_id = match &identity.record { IdentityRecord::Object(object) => &object.type_id, IdentityRecord::Relation(relation) => &relation.type_id };
        if !plan.datasets.iter().any(|dataset| &dataset.id == type_id) { continue; }
        grouped.entry(target).or_default().push(record);
    }
    for (target, records) in grouped {
        let identity = identities.get(&target).ok_or(QueryFailure::BasisChanged)?;
        let type_id = match &identity.record { IdentityRecord::Object(object) => &object.type_id, IdentityRecord::Relation(relation) => &relation.type_id };
        let definition = release.definitions.iter().find(|definition| &definition.reference.id == type_id).ok_or(QueryFailure::BasisChanged)?;
        let mut active = Vec::new(); let mut dirty = Vec::new();
        for record in records {
            projection.dependencies.push(ReadDependency::Assertion { reference: record.assertion.reference.clone() });
            let snapshot = SupportSnapshot { assertions: vec![record.assertion.reference.clone()], evidence: Vec::new(), supports: record.supports.clone(), watches: Vec::new() };
            match crate::facts::support::resolve_interval(&snapshot, &record.assertion.reference, &record.assertion.scope, &release.id, Some(&branch.id), interval) {
                ConclusionSupport::Supported { .. } => active.push(&record.assertion),
                ConclusionSupport::Dirty { generation, .. } => { projection.incomplete = true; dirty.push((&record.assertion, generation)); },
                ConclusionSupport::Unsupported => {},
            }
        }
        if active.is_empty() && dirty.is_empty() { continue; }
        let projected = projection.subjects.entry(target.clone()).or_insert_with(|| ProjectedSubject { identity: identity.clone(), fields: BTreeMap::new(), relation: None });
        if projected.identity != *identity { return Err(QueryFailure::BasisChanged.into()); }
        projection.dependencies.push(ReadDependency::Identity { subject: target.clone(), revision: identity.revision });
        for reference in &plan.fields {
            let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
            let DefinitionBody::Property(property) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
            if !property.domain.contains(type_id) { continue; }
            let candidates = active.iter().copied().filter(|assertion| matches!(&assertion.claim, Claim::Attribute(claim) if claim.subject == target && claim.property == *reference)).collect::<Vec<_>>();
            let pending = dirty.iter().filter_map(|(assertion, generation)| matches!(&assertion.claim, Claim::Attribute(claim) if claim.subject == target && claim.property == *reference).then_some(*generation)).max();
            let field = projected.fields.entry(reference.clone()).or_insert_with(|| FieldCell { property: reference.clone(), cell: Cell::Unknown { reason: UnknownReason::NotObserved }, evidence: Vec::new(), dirty: DirtyState::Clean });
            if candidates.is_empty() && pending.is_none() { continue; }
            let mut values = match &field.cell { Cell::Known { value: Value::List { items } } if property.cardinality.maximum != Some(1) => items.clone(), Cell::Known { value } => vec![value.clone()], _ => Vec::new() };
            for assertion in &candidates { if let Claim::Attribute(claim) = &assertion.claim {
                if assertion.polarity == Polarity::Positive && !values.contains(&claim.value) { values.push(claim.value.clone()); }
                field.evidence.extend(assertion.evidence.iter().cloned());
            } }
            if !matches!(field.cell, Cell::Conflicted { .. }) { field.cell = projection::reconcile_cell(property, values, &candidates, pending); }
            if let Some(generation) = pending { field.dirty = DirtyState::Dirty { generation, invalidated_at: now.clone(), watches: Vec::new() }; }
            projection.labels.extend(property.access_labels.clone());
        }
        if let DefinitionBody::RelationType(body) = &definition.body {
            let claims = active.iter().copied().filter(|assertion| matches!(&assertion.claim, Claim::Relation(claim) if target == (SubjectRef::Relation { id: claim.relation_id.clone() }))).collect::<Vec<_>>();
            let positive = claims.iter().filter(|assertion| assertion.polarity == Polarity::Positive).collect::<Vec<_>>();
            if positive.len() == 1 && !claims.iter().any(|assertion| assertion.polarity == Polarity::Negative && assertion.claim == positive[0].claim) {
                let Claim::Relation(claim) = &positive[0].claim else { return Err(QueryFailure::InternalFault.into()); };
                let relation = projection::relation(release, claim, Some(positive[0].reference.clone()), interval)?;
                if projected.relation.as_ref().is_some_and(|old| old.cells.values().all(|cell| matches!(cell, Cell::Known { .. })) && old.roles != relation.roles) {
                    projected.relation = Some(ProjectedRelation { claim: None, type_ref: definition.reference.clone(), roles: Vec::new(), cells: body.roles.iter().map(|role| (role.id.clone(), Cell::Conflicted { assertions: claims.iter().map(|assertion| assertion.reference.clone()).collect() })).collect(), valid_time: interval.clone() }); projection.incomplete = true;
                } else { projected.relation = Some(relation); }
            } else if !claims.is_empty() || projected.relation.is_none() {
                let cell = if claims.is_empty() { Cell::Unknown { reason: UnknownReason::PendingRecomputation } } else { Cell::Conflicted { assertions: claims.iter().map(|assertion| assertion.reference.clone()).collect() } };
                projected.relation = Some(ProjectedRelation { claim: None, type_ref: definition.reference.clone(), roles: Vec::new(), cells: body.roles.iter().map(|role| (role.id.clone(), cell.clone())).collect(), valid_time: interval.clone() }); projection.incomplete = true;
            }
        }
    }
    Ok(())
}

pub(super) async fn rule_capture_witness(tx: &WorldTransaction<'_>, release: &Release, dependencies: &[ReadDependency], budget: &CallBudget, cancel: &CancellationToken) -> Result<Vec<(DefinitionRef, Digest)>, QueryError> {
    let Some(branch) = &release.source_branch else { return Ok(Vec::new()); };
    let branch = crate::releases::read_branch_revision(tx, branch).await?.ok_or(QueryFailure::BasisChanged)?;
    let bindings = dependencies.iter().filter_map(|dependency| match dependency {
        ReadDependency::SourceMapping { binding, .. } | ReadDependency::Source { binding, .. } => Some(binding.clone()), _ => None,
    }).collect::<BTreeSet<_>>();
    let mut result = Vec::with_capacity(bindings.len());
    for binding in bindings {
        if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
        let capture = sync::selected_branch_capture(tx, &branch, &binding).await?.ok_or(QueryFailure::BasisChanged)?;
        result.push((binding, crate::definitions::canonical_digest(&(capture.capture(), capture.valid_time(), capture.source_version()))?));
    }
    Ok(result)
}

pub(super) async fn read_rule(
    tx: &WorldTransaction<'_>, authority: super::current::ReadAuthority<'_>, datasets: &[DefinitionRef], fields: &BTreeSet<DefinitionRef>,
    release: &Release, scope: &ScopeId, interval: &world_protocol::time::ValidTime, maximum: u64, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<projection::RuleProjection, QueryError> {
    let branch = release.source_branch.as_ref().ok_or(QueryFailure::BasisChanged)?;
    if authority.verified().invocation().branch_id.as_ref() != Some(&branch.id)
        || model(tx, branch, &EvaluationArm::Candidate).await?.1 != *release { return Err(QueryFailure::BasisChanged.into()); }
    let now = tx.now().await?;
    let plan = CheckedPlan { query: world_protocol::query::QueryIr { parameters: Vec::new(), root: world_protocol::query::QueryNode::Union { inputs: Vec::new() }, output: Vec::new(), limit: world_protocol::api::MAX_PAGE_ITEMS },
        datasets: datasets.iter().cloned().collect(), fields: fields.clone(), annotations: Vec::new(), functions: BTreeMap::new() };
    let captures = captures(Reader::Transaction(tx), branch, release, &plan).await?;
    let mut impact = impact_for(Reader::Transaction(tx), branch, release, &plan, &captures, scope).await?;
    let derivations = crate::facts::assertions::read_branch_derivations(tx, authority.verified(), branch, release, scope, interval, budget, cancel).await?;
    let identities = derivation_identities(Reader::Transaction(tx), &captures, &derivations).await?;
    for record in &derivations { merge_impact(&mut impact, record.read_impact()?); }
    impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
    authority.check(tx, &impact, &now).await?;
    let mut cuts = BTreeSet::from([interval.from.clone()]);
    cuts.extend(interval.to.iter().cloned());
    let mut rows = 0u64;
    for capture in &captures {
        if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
        match authority {
            super::current::ReadAuthority::Admitted(admission) => capture.recheck(tx, admission, &now).await?,
            super::current::ReadAuthority::Verified(verified) => capture.recheck_preflight(tx, verified, &now).await?,
        }
        if !crate::definitions::valid_time_contains(capture.valid_time(), interval) {
            return Err(QueryFailure::GuaranteeUnsatisfied { mode: ReadMode::Authoritative, source_id: Some(capture.capture().basis.source_id.clone()) }.into());
        }
        for record in &capture.capture().proposals {
            if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
            budget.charge(world_protocol::budget::BudgetDimension::Rows, 1).map_err(super::execution::budget_error)?;
            rows = rows.checked_add(1).ok_or(QueryFailure::InternalFault)?;
            if rows > maximum { return Err(QueryFailure::BudgetExceeded { limit: world_protocol::query::TruncationReason::Objects }.into()); }
            for boundary in std::iter::once(&record.key.valid_time.from).chain(record.key.valid_time.to.iter()) {
                if boundary > &interval.from && interval.to.as_ref().is_none_or(|to| boundary < to) { cuts.insert(boundary.clone()); }
            }
        }
    }
    for record in &derivations {
        for valid_time in std::iter::once(&record.assertion.valid_time).chain(record.supports.iter().map(|support| &support.valid_time)) {
            for boundary in std::iter::once(&valid_time.from).chain(valid_time.to.iter()) {
                if boundary > &interval.from && interval.to.as_ref().is_none_or(|to| boundary < to) { cuts.insert(boundary.clone()); }
            }
        }
    }
    if cuts.len() > world_protocol::api::MAX_QUERY_NODES { return Err(world_protocol::provenance::ProvenanceFailure::LimitExceeded { resource: world_protocol::provenance::ProvenanceLimit::ProposalItems, limit: world_protocol::api::MAX_QUERY_NODES as u64 }.into()); }
    let basis = captures.iter().map(|capture| (capture.capture(), capture.valid_time(), capture.source_version())).collect::<Vec<_>>();
    let fingerprint = crate::definitions::canonical_digest(&(branch, release, interval, basis, &derivations, identities.iter().collect::<Vec<_>>(), &cuts))?;
    Ok(projection::RuleProjection::captures(captures, derivations, identities, cuts.into_iter().collect(), impact, fingerprint))
}

pub(crate) async fn execute_branch(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, request: &QueryRequest, scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp) -> Result<super::PreparedQuery, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    execute_in_model(tx, admission, branch, arm, release, None, request, scope, budget, cancel, at).await
}
pub(super) async fn execute_in_model(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, release: Release, frozen: Option<super::frozen::FrozenRead>, request: &QueryRequest, scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp) -> Result<super::PreparedQuery, QueryError> {
    if request.world != branch.world || request.branch_id.as_ref() != Some(&branch.id) || request.page.cursor.is_some() || request.page.limit == 0 || request.page.limit > world_protocol::api::MAX_PAGE_ITEMS { return Err(invalid("branch.query")); }
    let now = tx.now().await?; authorization::recheck(tx, admission, &now).await?;
    if request.release_id.as_ref().is_some_and(|id| id != &release.id) { return Err(QueryFailure::BasisChanged.into()); }
    let plan = plan::check(&request.query, &release)?; let captures = captures(Reader::Transaction(tx), branch, &release, &plan).await?;
    let mut impact = impact_for(Reader::Transaction(tx), branch, &release, &plan, &captures, scope).await?; admission.require_access(&impact)?;
    Reader::Transaction(tx).recheck(&captures, admission, &now).await?;
    let freshness = guarantees(Reader::Transaction(tx), admission, &request.read_mode, request.known_at.as_ref(), &captures, &now).await?;
    let interval = projection::point(at)?;
    let derivations = derivations(Reader::Transaction(tx), admission, branch, &release, scope, &interval, budget, cancel).await?;
    for record in &derivations { merge_impact(&mut impact, record.read_impact()?); }
    impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
    admission.require_access(&impact)?;
    let identities = derivation_identities(Reader::Transaction(tx), &captures, &derivations).await?;
    let mut projection = project(&release, &plan, &captures, at, budget, cancel)?;
    merge_derivations(&mut projection, &release, &plan, &derivations, &identities, &interval, &now, budget, cancel)?;
    let basis: Vec<_> = captures.iter().map(|capture| capture.capture().basis.clone()).collect();
    let mut context = super::receipt::ReadContext::branch(scope, interval, branch, arm, &captures, request.known_at.as_ref());
    context.derivations = derivation_basis(&derivations)?;
    context.frozen_model = frozen;
    let mut prepared = super::execution::assemble(admission, request.clone(), context, release, plan, projection, impact, Vec::new(), basis, freshness, now, at.clone(), budget, cancel)?;
    prepared.branch_captures = captures; prepared.branch_model = Some((branch.clone(), arm.clone()));
    Ok(prepared)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchActionPreview {
    pub action: DefinitionRef, pub operation: world_protocol::actions::SourceOperation,
    pub preconditions: Vec<world_protocol::expression::TruthValue>, pub keys: Vec<(SourceFieldId, Value)>,
    pub values: Vec<(SourceFieldId, Value)>, pub expected: Vec<(SourceFieldId, Value)>,
    pub read_receipt: Option<world_protocol::query::ReadReceipt>,
}
fn action_expressions(action: &world_protocol::actions::ActionContract) -> Vec<&ExpressionIr> {
    let mut expressions: Vec<_> = action.preconditions.iter().collect();
    match &action.source_operation.mutation {
        world_protocol::actions::SourceMutation::Insert { values } => expressions.extend(values.iter().map(|field| &field.expression)),
        world_protocol::actions::SourceMutation::Update { keys, values, expected } => expressions.extend(keys.iter().chain(values).chain(expected).map(|field| &field.expression)),
        world_protocol::actions::SourceMutation::Delete { keys, expected } => expressions.extend(keys.iter().chain(expected).map(|field| &field.expression)),
    }
    expressions
}
pub(super) fn action_inputs<'a>(release: &'a Release, contract: &DefinitionRef) -> Result<(&'a [Parameter], Vec<&'a ExpressionIr>), QueryError> {
    let definition = release.definitions.iter().find(|definition| definition.reference == *contract).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("action")); };
    crate::compiler::check_action(definition, &release.definitions, &release.scopes)?;
    Ok((&action.parameters, action_expressions(action)))
}
pub(crate) async fn branch_action_impact(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, contract: &DefinitionRef, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    let definition = release.definitions.iter().find(|definition| definition.reference == *contract).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("action")); };
    crate::compiler::check_action(definition, &release.definitions, &release.scopes)?;
    branch_expression_impact(tx, branch, arm, &action.parameters, &action_expressions(action), scope).await
}
pub(crate) async fn branch_action_dry_run(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, contract: &DefinitionRef, arguments: &[QueryArgument], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<BranchActionPreview, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    action_in_model(tx, admission, branch, arm, release, None, contract, arguments, scope, budget, cancel, at, read_mode, known_at).await
}
pub(super) async fn action_in_model(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, release: Release, frozen: Option<super::frozen::FrozenRead>, contract: &DefinitionRef, arguments: &[QueryArgument], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<BranchActionPreview, QueryError> {
    let definition = release.definitions.iter().find(|definition| definition.reference == *contract).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("action")); };
    let ir = crate::compiler::check_action(definition, &release.definitions, &release.scopes)?;
    let parameters = engine::parameters(&action.parameters, arguments)?;
    let mut context = expression_context_in_model(tx, admission, branch, arm, release.clone(), frozen, Some(contract), &action.parameters, &parameters, &action_expressions(action), scope, budget, cancel, at, read_mode, known_at).await?;
    context.annotations = ir.annotations;
    let preconditions = action.preconditions.iter().enumerate().map(|(index, expression)| Ok(super::truth_value(&context.value(expression, &["preconditions".into(), index.to_string()], at)?)?)).collect::<Result<Vec<_>, QueryError>>()?;
    let mut preview = BranchActionPreview { action: contract.clone(), operation: action.source_operation.clone(), preconditions, keys: Vec::new(), values: Vec::new(), expected: Vec::new(), read_receipt: context.read_receipt.clone() };
    let groups: Vec<(&str, &[world_protocol::actions::SourceFieldExpression])> = match &action.source_operation.mutation {
        world_protocol::actions::SourceMutation::Insert { values } => vec![("values", values)],
        world_protocol::actions::SourceMutation::Update { keys, values, expected } => vec![("keys", keys), ("values", values), ("expected", expected)],
        world_protocol::actions::SourceMutation::Delete { keys, expected } => vec![("keys", keys), ("expected", expected)],
    };
    for (name, fields) in groups {
        for (index, field) in fields.iter().enumerate() {
            let Cell::Known { value } = context.value(&field.expression, &["sourceOperation".into(), "mutation".into(), name.into(), index.to_string(), "expression".into()], at)? else { return Err(QueryFailure::BasisChanged.into()); };
            match name { "keys" => preview.keys.push((field.field.clone(), value)), "values" => preview.values.push((field.field.clone(), value)), _ => preview.expected.push((field.field.clone(), value)) }
        }
    }
    Ok(preview)
}

fn expression_plan(release: &Release, declarations: &[Parameter], expressions: &[&ExpressionIr]) -> Result<CheckedPlan, QueryError> {
    let (fields, functions) = super::current::expression_closure(expressions, release)?;
    let mut datasets = BTreeSet::new();
    for parameter in declarations { if let ValueType::Object { type_id } | ValueType::Relation { type_id } = &parameter.value_type { datasets.insert(release.definitions.iter().find(|definition| definition.reference.id == *type_id).ok_or(QueryFailure::BasisChanged)?.reference.clone()); } }
    datasets.extend(super::current::collection_ranges(declarations, expressions, release)?.into_values());
    let mut roots = Vec::new();
    for (index, reference) in datasets.iter().enumerate() {
        let symbol = SymbolId::try_new(format!("branch_{index}")).map_err(|_| QueryFailure::InternalFault)?;
        let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        roots.push(match definition.body { DefinitionBody::ObjectType(_) => world_protocol::query::QueryNode::Objects { type_ref: reference.clone(), symbol }, DefinitionBody::RelationType(_) => world_protocol::query::QueryNode::Relations { type_ref: reference.clone(), symbol }, _ => return Err(QueryFailure::BasisChanged.into()) });
    }
    Ok(CheckedPlan { query: world_protocol::query::QueryIr { parameters: declarations.to_vec(), root: world_protocol::query::QueryNode::Union { inputs: roots }, output: Vec::new(), limit: world_protocol::api::MAX_PAGE_ITEMS }, datasets, fields, annotations: Vec::new(), functions })
}

pub(crate) fn branch_subject_in_transaction<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    branch: &'a BranchRef,
    arm: &'a EvaluationArm,
    subject: &'a SubjectRef,
    type_ref: &'a DefinitionRef,
    scope: &'a ScopeId,
    at: &'a Timestamp,
    budget: &'a CallBudget,
    cancel: &'a CancellationToken,
    read_mode: &'a ReadMode,
    known_at: Option<&'a Timestamp>
) -> StoreFuture<'a, bool, QueryError> {
    Box::pin(async move {
        let now = tx.now().await?; authorization::recheck(tx, admission, &now).await?;
        let (_, release) = model(tx, branch, arm).await?;
        let definition = release.definitions.iter().find(|definition| definition.reference == *type_ref).ok_or(QueryFailure::BasisChanged)?;
        let symbol = SymbolId::try_new("branch_subject").map_err(|_| QueryFailure::InternalFault)?;
        let root = match (&definition.body, subject) {
            (DefinitionBody::ObjectType(_), SubjectRef::Object { .. }) => world_protocol::query::QueryNode::Objects { type_ref: type_ref.clone(), symbol },
            (DefinitionBody::RelationType(_), SubjectRef::Relation { .. }) => world_protocol::query::QueryNode::Relations { type_ref: type_ref.clone(), symbol },
            _ => return Ok(false),
        };
        let plan = CheckedPlan { query: world_protocol::query::QueryIr { parameters: Vec::new(), root, output: Vec::new(), limit: 1 }, datasets: BTreeSet::from([type_ref.clone()]), fields: BTreeSet::new(), annotations: Vec::new(), functions: BTreeMap::new() };
        let captures = captures(Reader::Transaction(tx), branch, &release, &plan).await?;
        let impact = impact_for(Reader::Transaction(tx), branch, &release, &plan, &captures, scope).await?; admission.require_access(&impact)?;
        Reader::Transaction(tx).recheck(&captures, admission, &now).await?;
        guarantees(Reader::Transaction(tx), admission, read_mode, known_at, &captures, &now).await?;
        let interval = projection::point(at)?;
        let derivations = derivations(Reader::Transaction(tx), admission, branch, &release, scope, &interval, budget, cancel).await?;
        let identities = derivation_identities(Reader::Transaction(tx), &captures, &derivations).await?;
        let mut projection = project(&release, &plan, &captures, at, budget, cancel)?;
        merge_derivations(&mut projection, &release, &plan, &derivations, &identities, &interval, &now, budget, cancel)?;
        let found = projection.subjects.get(subject).is_some_and(|projected| match &projected.identity.record { IdentityRecord::Object(object) => object.type_id == type_ref.id, IdentityRecord::Relation(relation) => relation.type_id == type_ref.id && projected.relation.as_ref().is_some_and(|relation| relation.type_ref == *type_ref && relation.valid_time.contains(at) && relation.cells.values().all(|cell| matches!(cell, Cell::Known { .. }))) });
        if !found && projection.incomplete { return Err(QueryFailure::GuaranteeUnsatisfied { mode: read_mode.clone(), source_id: None }.into()); }
        authorization::check_admitted_output(tx, admission, &impact, u64::from(found), &now).await?;
        Ok(found)
    })
}

#[derive(Clone)]
pub(super) struct VerifiedBasis { branch: BranchRef, release: Release, pub captures: Vec<BranchCapture> }
impl VerifiedBasis {
    fn require_same(&self, branch: &BranchRef, release: &Release, captures: &[BranchCapture]) -> Result<(), QueryError> {
        if &self.branch != branch || &self.release != release || self.captures.iter().map(|capture| (&capture.capture().binding, &capture.capture().digest)).ne(captures.iter().map(|capture| (&capture.capture().binding, &capture.capture().digest))) { return Err(QueryFailure::BasisChanged.into()); }
        Ok(())
    }
    pub(super) async fn recheck_snapshot(&self, snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId) -> Result<(), QueryError> {
        let current = query_basis_snapshot(snapshot, admission, request, scope).await?;
        self.require_same(&current.branch, &current.release, &current.captures)
    }
    pub(super) async fn recheck_retained_snapshot(&self, snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId, read: &super::receipt::StoredRead) -> Result<(Release, ActualImpact), QueryError> {
        let (current, impact) = retained_basis_snapshot(snapshot, admission, request, scope, read).await?;
        self.require_same(&current.branch, &current.release, &current.captures)?;
        Ok((current.release, impact))
    }
}
pub(super) async fn retained_basis_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId, read: &super::receipt::StoredRead) -> Result<(VerifiedBasis, ActualImpact), QueryError> {
    let now = snapshot.now().await?;
    super::receipt::require_current(read, admission, &now)?;
    let (release, impact) = retained(Reader::Snapshot(snapshot), admission, &now, request, scope, read).await?;
    admission.require_access(&impact)?;
    let branch = read.context.branch_model.as_ref().ok_or(QueryFailure::BasisChanged)?.0.clone();
    Ok((VerifiedBasis { branch, release, captures: stored_captures(Reader::Snapshot(snapshot), read).await? }, impact))
}
pub(super) async fn query_basis_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, request: &QueryRequest, scope: &ScopeId) -> Result<VerifiedBasis, QueryError> {
    let id = request.branch_id.as_ref().ok_or(QueryFailure::BasisChanged)?;
    let now = snapshot.now().await?; authorization::recheck_read(snapshot, admission, &now).await?;
    if let Some(cursor) = &request.page.cursor {
        let (id, _) = super::receipt::cursor(cursor)?;
        let read = super::receipt::read_snapshot(snapshot, &id).await?;
        return Ok(retained_basis_snapshot(snapshot, admission, request, scope, &read).await?.0);
    }
    let branch = crate::releases::read_branch_snapshot(snapshot, id).await?.ok_or(QueryFailure::BasisChanged)?;
    let branch = BranchRef { world: branch.world, id: branch.id, revision: branch.revision };
    let arm = EvaluationArm::Candidate;
    let (_, release) = read_model(Reader::Snapshot(snapshot), &branch, &arm).await?;
    let plan = plan::check(&request.query, &release)?;
    let captures = captures(Reader::Snapshot(snapshot), &branch, &release, &plan).await?;
    admission.require_access(&impact_for(Reader::Snapshot(snapshot), &branch, &release, &plan, &captures, scope).await?)?;
    Reader::Snapshot(snapshot).recheck(&captures, admission, &now).await?;
    Ok(VerifiedBasis { branch, release, captures })
}

pub(super) fn input_plan(input: &super::receipt::ReadInput, release: &Release) -> Result<CheckedPlan, QueryError> {
    match input {
        super::receipt::ReadInput::Query { request } => plan::check(&request.query, release),
        super::receipt::ReadInput::Expression { declarations, expressions, .. } => expression_plan(release, declarations, &expressions.iter().collect::<Vec<_>>()),
    }
}
pub(super) struct TargetInputs {
    pub release: Release, pub plan: CheckedPlan, pub captures: Vec<BranchCapture>, pub impact: ActualImpact,
    pub freshness: Vec<SourceFreshness>, pub now: Timestamp,
    pub derivations: Vec<BranchDerivationRecord>, pub identities: BTreeMap<SubjectRef, IdentitySnapshot>,
}
pub(super) async fn target_inputs(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, target: &WorldBranch, supplied: &[BranchCapture], input: &super::receipt::ReadInput, context: &super::receipt::ReadContext, budget: &CallBudget, cancel: &CancellationToken) -> Result<TargetInputs, QueryError> {
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    let reference = BranchRef { world: target.world.clone(), id: target.id.clone(), revision: target.revision };
    if target.status != world_protocol::learning::ChangeStatus::Proposed || Reader::Snapshot(snapshot).branch(&reference).await? != *target || supplied.iter().any(|capture| capture.capture().branch != reference) { return Err(QueryFailure::BasisChanged.into()); }
    let release = selected_model(target, Reader::Snapshot(snapshot).release(&target.basis.release_id).await?, &EvaluationArm::Candidate)?;
    if release.artifact.activation_lock_id != target.compile.activation_lock.id { return Err(QueryFailure::BasisChanged.into()); }
    let plan = input_plan(input, &release)?;
    let captures = captures_from(Reader::Snapshot(snapshot), &reference, &release, &plan, Some(supplied)).await?;
    for capture in &captures {
        if context.valid_time.from < capture.capture().basis.observed_at { return Err(QueryFailure::GuaranteeUnsatisfied { mode: input.mode().clone(), source_id: Some(capture.capture().basis.source_id.clone()) }.into()); }
    }
    let mut impact = impact_for(Reader::Snapshot(snapshot), &reference, &release, &plan, &captures, &context.scope).await?;
    admission.require_access(&impact)?;
    Reader::Snapshot(snapshot).recheck(&captures, admission, &now).await?;
    let freshness = guarantees(Reader::Snapshot(snapshot), admission, input.mode(), context.known_at.as_ref(), &captures, &now).await?;
    let derivations = derivations(Reader::Snapshot(snapshot), admission, &reference, &release, &context.scope, &context.valid_time, budget, cancel).await?;
    for record in &derivations { merge_impact(&mut impact, record.read_impact()?); }
    impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
    admission.require_access(&impact)?;
    let identities = derivation_identities(Reader::Snapshot(snapshot), &captures, &derivations).await?;
    Ok(TargetInputs { release, plan, captures, impact, freshness, now, derivations, identities })
}

pub(crate) async fn branch_query_captures(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, query: &world_protocol::query::QueryIr) -> Result<Vec<BranchCapture>, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    query_captures_in_model(tx, branch, &release, query).await
}
pub(super) async fn query_captures_in_model(tx: &WorldTransaction<'_>, branch: &BranchRef, release: &Release, query: &world_protocol::query::QueryIr) -> Result<Vec<BranchCapture>, QueryError> {
    captures(Reader::Transaction(tx), branch, release, &plan::check(query, release)?).await
}
pub(crate) async fn branch_expression_captures(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, declarations: &[Parameter], expressions: &[&ExpressionIr]) -> Result<Vec<BranchCapture>, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    expression_captures_in_model(tx, branch, &release, declarations, expressions).await
}
pub(super) async fn expression_captures_in_model(tx: &WorldTransaction<'_>, branch: &BranchRef, release: &Release, declarations: &[Parameter], expressions: &[&ExpressionIr]) -> Result<Vec<BranchCapture>, QueryError> {
    captures(Reader::Transaction(tx), branch, release, &expression_plan(release, declarations, expressions)?).await
}
pub(crate) async fn branch_action_captures(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, contract: &DefinitionRef) -> Result<Vec<BranchCapture>, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    let definition = release.definitions.iter().find(|definition| definition.reference == *contract).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::ActionContract(action) = &definition.body else { return Err(invalid("action")); };
    crate::compiler::check_action(definition, &release.definitions, &release.scopes)?;
    branch_expression_captures(tx, branch, arm, &action.parameters, &action_expressions(action)).await
}

pub(crate) async fn branch_expression_impact(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, declarations: &[Parameter], expressions: &[&ExpressionIr], scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    expression_impact_in_model(tx, branch, &release, declarations, expressions, scope).await
}
pub(super) async fn expression_impact_in_model(tx: &WorldTransaction<'_>, branch: &BranchRef, release: &Release, declarations: &[Parameter], expressions: &[&ExpressionIr], scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let plan = expression_plan(release, declarations, expressions)?;
    let captures = captures(Reader::Transaction(tx), branch, release, &plan).await?; impact_for(Reader::Transaction(tx), branch, release, &plan, &captures, scope).await
}

pub(crate) async fn branch_expression_context(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, declarations: &[Parameter], arguments: &[QueryArgument], expressions: &[&ExpressionIr], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<CurrentEvaluation, QueryError> {
    branch_expression_context_cells(tx, admission, branch, arm, declarations, &engine::parameters(declarations, arguments)?, expressions, scope, budget, cancel, at, read_mode, known_at).await
}
pub(crate) async fn branch_expression_context_cells(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>, expressions: &[&ExpressionIr], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<CurrentEvaluation, QueryError> {
    expression_context_cells(tx, admission, branch, arm, None, declarations, parameters, expressions, scope, budget, cancel, at, read_mode, known_at).await
}
pub(super) async fn expression_context_cells(tx: &WorldTransaction<'_>, admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, owner: Option<&DefinitionRef>, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>, expressions: &[&ExpressionIr], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<CurrentEvaluation, QueryError> {
    let (_, release) = model(tx, branch, arm).await?;
    expression_context_in_model(tx, admission, branch, arm, release, None, owner, declarations, parameters, expressions, scope, budget, cancel, at, read_mode, known_at).await
}
pub(super) fn expression_context_in_model<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    branch: &'a BranchRef,
    arm: &'a EvaluationArm,
    release: Release,
    frozen: Option<super::frozen::FrozenRead>,
    owner: Option<&'a DefinitionRef>,
    declarations: &'a [Parameter],
    parameters: &'a BTreeMap<ParameterId, Cell>,
    expressions: &'a [&ExpressionIr],
    scope: &'a ScopeId,
    budget: &'a CallBudget,
    cancel: &'a CancellationToken,
    at: &'a Timestamp,
    read_mode: &'a ReadMode,
    known_at: Option<&'a Timestamp>
) -> StoreFuture<'a, CurrentEvaluation, QueryError> {
    Box::pin(async move {
        if parameters.len() != declarations.len() { return Err(invalid("arguments")); }
        for declaration in declarations {
            match parameters.get(&declaration.id).ok_or_else(|| invalid("arguments"))? {
                Cell::Known { value } => crate::definitions::validate_value(&declaration.value_type, declaration.nullable, value).map_err(|_| invalid("arguments"))?,
                Cell::Unknown { .. } | Cell::Conflicted { .. } | Cell::SourceUnavailable { .. } => {},
            }
        }
        let parameters = parameters.clone();
        authorization::recheck(tx, admission, &tx.now().await?).await?;
        let plan = expression_plan(&release, declarations, expressions)?;
        let captures = captures(Reader::Transaction(tx), branch, &release, &plan).await?; let mut impact = impact_for(Reader::Transaction(tx), branch, &release, &plan, &captures, scope).await?;
        if let Some(owner) = owner {
            let definition = release.definitions.iter().find(|definition| &definition.reference == owner).ok_or(QueryFailure::BasisChanged)?;
            crate::definitions::validate_applicability(definition, scope, &projection::point(at)?, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
            impact.access.push(AccessScope { resources: vec![ResourceRef::Definition { id: owner.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None });
            impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
        }
        admission.require_access(&impact)?;
        let now = tx.now().await?;
        Reader::Transaction(tx).recheck(&captures, admission, &now).await?;
        let freshness = guarantees(Reader::Transaction(tx), admission, read_mode, known_at, &captures, &now).await?;
        let interval = projection::point(at)?;
        let derivations = derivations(Reader::Transaction(tx), admission, branch, &release, scope, &interval, budget, cancel).await?;
        for record in &derivations { merge_impact(&mut impact, record.read_impact()?); }
        impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
        admission.require_access(&impact)?;
        let identities = derivation_identities(Reader::Transaction(tx), &captures, &derivations).await?;
        let (mut context, mut stored) = prepare_expression(admission, branch, arm, release, plan, &captures, &derivations, &identities, impact.clone(), declarations, &parameters, expressions, scope, budget, cancel, at, read_mode, known_at, freshness, now, super::receipt::CaptureSelection::Selected, frozen)?;
        if let Some(owner) = owner {
            let dependency = ReadDependency::Definition { reference: owner.clone() };
            if !context.dependencies.contains(&dependency) { context.dependencies.push(dependency); }
            if let Some(stored) = &mut stored { stored.receipt.actual_dependencies = context.dependencies.clone(); context.read_receipt = Some(stored.receipt.clone()); }
        }
        if let Some(stored) = stored {
            super::receipt::recheck_output(tx, admission, &stored, &tx.now().await?).await?;
            super::receipt::persist(tx, admission, &stored).await?;
        }
        authorization::check_admitted_output(tx, admission, &impact, context.row.subjects.len() as u64, &tx.now().await?).await?;
        Ok(context)
    })
}

pub(super) fn prepare_expression(
    admission: &Admission, branch: &BranchRef, arm: &EvaluationArm, release: Release, plan: CheckedPlan,
    captures: &[BranchCapture], derivations: &[BranchDerivationRecord], identities: &BTreeMap<SubjectRef, IdentitySnapshot>, impact: ActualImpact, declarations: &[Parameter], parameters: &BTreeMap<ParameterId, Cell>,
    expressions: &[&ExpressionIr], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp,
    read_mode: &ReadMode, known_at: Option<&Timestamp>, freshness: Vec<SourceFreshness>, now: Timestamp,
    selection: super::receipt::CaptureSelection, frozen: Option<super::frozen::FrozenRead>,
) -> Result<(CurrentEvaluation, Option<super::receipt::StoredRead>), QueryError> {
    let mut projection = project(&release, &plan, captures, at, budget, cancel)?;
    let interval = projection::point(at)?;
    merge_derivations(&mut projection, &release, &plan, derivations, identities, &interval, &now, budget, cancel)?;
    let mut dependencies = projection.dependencies.clone();
    if let Some(at) = super::watch::time_boundary(&plan, &projection, at)? { dependencies.push(ReadDependency::TimeBoundary { at }); }
    for reference in plan.datasets.iter().chain(&plan.fields).chain(plan.functions.keys()) {
        let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        crate::definitions::validate_applicability(definition, scope, &interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
        dependencies.push(ReadDependency::Definition { reference: reference.clone() });
    }
    let mut row = super::EvalRow { valid_time: Some(interval.clone()), ..Default::default() };
    for parameter in declarations {
        let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| QueryFailure::InternalFault)?;
        let subject = match parameters.get(&parameter.id) { Some(Cell::Known { value: Value::Object { id } }) => Some(SubjectRef::Object { id: id.clone() }), Some(Cell::Known { value: Value::Relation { id } }) => Some(SubjectRef::Relation { id: id.clone() }), _ => None };
        if let Some(subject) = subject {
            let projected = projection.subjects.get(&subject).ok_or(QueryFailure::BasisChanged)?;
            let actual = match &projected.identity.record { IdentityRecord::Object(object) => ValueType::Object { type_id: object.type_id.clone() }, IdentityRecord::Relation(relation) => ValueType::Relation { type_id: relation.type_id.clone() } };
            if parameter.value_type != actual { return Err(invalid("arguments.type")); }
            if let ValueType::Relation { type_id } = &actual { if !projected.relation.as_ref().is_some_and(|relation| &relation.type_ref.id == type_id && relation.valid_time.contains(at) && relation.cells.values().all(|cell| matches!(cell, Cell::Known { .. }))) { return Err(QueryFailure::BasisChanged.into()); } }
            engine::bind(&mut row, &symbol, &subject, projected);
        } else { for field in &plan.fields { row.fields.insert((symbol.clone(), field.clone()), parameters.get(&parameter.id).cloned().ok_or(QueryFailure::BasisChanged)?); } }
    }
    let mut ranges = BTreeMap::new(); let mut range_incomplete = projection.incomplete;
    for reference in &plan.datasets {
        let (symbol, scan) = super::current::collection_plan(reference, &release, &plan.fields)?;
        let mut output = engine::run(&scan, &release, &projection, &[], at, budget, cancel)?;
        range_incomplete |= output.incomplete || output.truncated;
        let mut collection = output.collections.remove(&symbol).ok_or(QueryFailure::InternalFault)?;
        for item in &mut collection.rows { item.valid_time.get_or_insert_with(|| interval.clone()); }
        if output.truncated { collection.incomplete = Some(Cell::Unknown { reason: UnknownReason::IncompleteCoverage }); }
        ranges.insert(reference.id.clone(), (symbol, collection));
    }
    let mut collections = BTreeMap::new();
    for parameter in declarations {
        let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
        let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| QueryFailure::InternalFault)?;
        let (source, range) = ranges.get(type_id).ok_or(QueryFailure::BasisChanged)?;
        let mut collection = range.rebind(source, &symbol);
        for item in &mut collection.rows {
            if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
            let mut bound = row.clone(); bound.subjects.extend(item.subjects.clone()); bound.fields.extend(item.fields.clone()); bound.roles.extend(item.roles.clone()); bound.valid_time = item.valid_time.clone(); *item = bound;
        }
        collections.insert(symbol, collection);
    }
    let mut stored_read = None;
    let read_receipt = if plan.datasets.is_empty() { None } else {
        let id = ReadReceiptId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| QueryFailure::InternalFault)?;
        let mut context = super::receipt::ReadContext::branch(scope, projection::point(at)?, branch, arm, captures, known_at);
        context.capture_selection = selection;
        context.frozen_model = frozen;
        context.derivations = derivation_basis(derivations)?;
        let scope_digest = super::execution::evaluated_scope_digest(&context, &release, &impact)?;
        let receipt = world_protocol::query::ReadReceipt { world: branch.world.clone(), id, branch_id: Some(branch.id.clone()), release_id: release.id.clone(), activation_lock_id: release.artifact.activation_lock_id.clone(),
            query_digest: crate::definitions::canonical_digest(&("world.branch.expression.v1", branch, arm, declarations, &parameters, expressions, at))?, evaluated_scope_digest: scope_digest.clone(), decision_id: admission.decision().id.clone(), policy_epoch: admission.decision().policy_epoch, grant_epoch: admission.decision().grant_epoch,
            observed_at: now.clone(), expires_at: admission.decision().expires_at.clone(), requested_mode: read_mode.clone(), basis: captures.iter().map(|capture| capture.capture().basis.clone()).collect(), projection_generation: None, actual_dependencies: dependencies.clone(),
            coverage: world_protocol::query::QueryCoverage { scope_digest, complete: !range_incomplete, missing_sources: Vec::new(), missing_fields: Vec::new(), gap_sources: Vec::new() }, freshness, dirty: Vec::new(), truncation: None, consistency: world_protocol::query::ConsistencyBasis::BranchAssumptions };
        let actor = match &admission.invocation().actor { world_protocol::authorization::Actor::Human { id } | world_protocol::authorization::Actor::Service { id } => id.clone() };
        let subjects = projection.subjects.keys().cloned().collect();
        let (objects, relations, _) = super::execution::views(&projection, &subjects, &receipt.id)?;
        let columns = row.fields.iter().map(|((symbol, property), cell)| world_protocol::query::NamedCell { name: format!("field.{}.{}", symbol.as_str(), property.id.as_str()), cell: cell.clone() })
            .chain(row.roles.iter().map(|((symbol, role), cell)| world_protocol::query::NamedCell { name: format!("role.{}.{}", symbol.as_str(), role.as_str()), cell: cell.clone() }))
            .chain(parameters.iter().map(|(id, cell)| world_protocol::query::NamedCell { name: format!("parameter.{}", id.as_str()), cell: cell.clone() })).collect();
        let input = super::receipt::ReadInput::Expression { declarations: declarations.to_vec(), parameters: parameters.clone(), expressions: expressions.iter().map(|expression| (*expression).clone()).collect(), at: at.clone(), read_mode: read_mode.clone(), known_at: known_at.cloned() };
        stored_read = Some(super::receipt::StoredRead { receipt: receipt.clone(), rows: vec![world_protocol::query::QueryRow { columns }], row_subjects: vec![projection.subjects.keys().cloned().collect()], objects, relations, impact: impact.clone(), actor, context, input, origin: None });
        Some(receipt)
    };
    Ok((CurrentEvaluation { parameters: parameters.clone(), row, collections, ranges, functions: plan.functions, annotations: Vec::new(), dependencies, incomplete: range_incomplete, range_incomplete, budget: budget.clone(), cancel: cancel.clone(), read_receipt }, stored_read))
}
