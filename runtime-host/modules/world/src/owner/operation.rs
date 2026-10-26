use world_protocol::{
    api::ApiFailure,
    authorization::{AccessMode, AccessScope},
    failure::{FailureStage, Recovery},
    ids::*,
    operation::{CancelOperation, CancelReceipt, CancellationState, OperationKey, OperationReceipt},
};
use std::sync::Arc;
use crate::{authorization::{self, RequestBinding, ServiceIngress}, store::{CommitRequest, WorldStore}};
use super::{Error, head, ledger};

/// Only the fixed signed adapter can construct this; it contains no public authority claims.
#[derive(Clone)]
pub(crate) struct SignedRequest {
    pub token: String,
    pub binding: RequestBinding,
}

pub(crate) async fn status(store: &WorldStore, ingress: Arc<ServiceIngress>, signed: SignedRequest, key: OperationKey) -> Result<OperationReceipt, Error> {
    let world = key.world.clone();
    let batch = batch(store, &signed.binding).await?.receipt_access()?;
    let committed = store.transact(batch, move |tx| Box::pin(async move {
        let now = head::now(tx).await?;
        let verified = ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
        let scope = head::management_scope(tx).await?;
        let impact = authorization::actual_impact(vec![AccessScope {
            resources: vec![ResourceRef::Operation { id: key.operation_id.clone() }], fields: Vec::new(),
            modes: vec![AccessMode::Read], scope, valid_time: None,
        }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
        let admission = authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
        let record = ledger::read(tx, &key.operation_id).await?;
        if record.receipt.accepted.world != world { return Err(Error::internal(FailureStage::Read)); }
        authorization::check_output(tx, &verified, &admission, &impact, 1, &now).await?;
        authorize_receipt(tx, &verified, &record, &now).await?;
        project_receipt(tx, &verified, &record, &now).await
    })).await?;
    Ok(committed.value)
}

pub(crate) async fn cancel(store: &WorldStore, ingress: Arc<ServiceIngress>, signed: SignedRequest, request: CancelOperation) -> Result<CancelReceipt, Error> {
    let batch = batch(store, &signed.binding).await?.receipt_access()?;
    let committed = store.transact(batch, move |tx| Box::pin(async move {
        let now = head::now(tx).await?;
        let verified = ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
        let scope = head::management_scope(tx).await?;
        let impact = authorization::actual_impact(vec![AccessScope {
            resources: vec![ResourceRef::Operation { id: request.key.operation_id.clone() }], fields: Vec::new(),
            modes: vec![AccessMode::Execute], scope, valid_time: None,
        }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
        authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
        let mut record = ledger::read(tx, &request.key.operation_id).await?;
        authorize_receipt(tx, &verified, &record, &now).await?;
        if record.receipt.accepted.revision != request.expected_revision {
            return Err(Error::new("world.operation_revision_conflict", FailureStage::Validate,
                "操作状态已变化，请读取当前状态。", ApiFailure::RevisionConflict, Recovery::Refresh));
        }
        if !ledger::terminal(record.receipt.phase) && record.receipt.cancellation == CancellationState::NotRequested {
            record.receipt.cancellation = CancellationState::Requested;
            ledger::save(tx, &mut record, &now).await?;
        }
        let settled = ledger::terminal(record.receipt.phase);
        let receipt = project_receipt(tx, &verified, &record, &now).await?;
        Ok::<_, Error>(CancelReceipt { receipt, settled })
    })).await?;
    Ok(committed.value)
}

pub(super) async fn authorize_receipt(
    tx: &crate::store::WorldTransaction<'_>, verified: &authorization::VerifiedInvocation,
    record: &ledger::OperationRecord, now: &world_protocol::time::Timestamp,
) -> Result<(), Error> {
    let mut access = record.impact.access.clone();
    for scope in &mut access { scope.modes = vec![AccessMode::Read]; }
    // Historical receipts are not current state observations or new source effects.
    let impact = authorization::actual_impact(access, Vec::new(), record.impact.labels.clone(), Vec::new(), record.impact.source_ids.clone())?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    authorization::check_output(tx, verified, &admission, &impact, 1, now).await?;
    Ok(())
}

pub(super) async fn project_receipt(
    tx: &crate::store::WorldTransaction<'_>, verified: &authorization::VerifiedInvocation,
    record: &ledger::OperationRecord, now: &world_protocol::time::Timestamp,
) -> Result<OperationReceipt, Error> {
    use world_protocol::{api::WorldCommand, operation::OperationResult};
    if let Some(OperationResult::Action(status)) = &record.receipt.result {
        let (_, execution, _) = crate::actions::read_operation_intent(tx, &status.operation_id).await?;
        let (proposal, _) = crate::actions::read_proposal(tx, &execution.proposal_id).await?;
        let mut access = record.impact.access.clone();
        for scope in &mut access { scope.modes = vec![AccessMode::Read]; }
        let base = authorization::actual_impact(access, Vec::new(), record.impact.labels.clone(), Vec::new(), record.impact.source_ids.clone())?;
        let impact = crate::actions::status_impact(tx, base, &proposal, status).await?;
        let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
        crate::actions::check_status_output(tx, &admission, &impact, status, now).await?;
    }
    let ledger::OperationInput::Command(world_protocol::api::CommandEnvelope { command: WorldCommand::TestBranch(request), .. }) = &record.input else {
        if matches!(record.receipt.result, Some(OperationResult::Evaluation(_) | OperationResult::EvaluationSummary(_))) {
            return Err(Error::internal(FailureStage::Disclose));
        }
        return Ok(record.receipt.clone());
    };
    let request = crate::evaluation::resolve_test(tx, request, &record.receipt.accepted.operation_id).await?;
    let has_report = matches!(record.receipt.result, Some(OperationResult::Evaluation(_) | OperationResult::EvaluationSummary(_)));
    let full_impact = if has_report {
        crate::evaluation::report_impact(tx, &request.id, true).await?
    } else { crate::evaluation::request_impact(tx, &request, true).await? };
    match authorization::admit(tx, verified, &full_impact, &[], None, now).await {
        Ok(admission) => {
            authorization::check_output(tx, verified, &admission, &full_impact, 1, now).await?;
            let mut receipt = record.receipt.clone();
            if has_report {
                receipt.result = Some(OperationResult::Evaluation(Box::new(crate::evaluation::full_report(tx, &admission, &request.id, now).await?)));
            }
            return Ok(receipt);
        }
        Err(authorization::AuthError::Denied(_)) => {}
        Err(error) => return Err(error.into()),
    }
    let impact = if has_report { crate::evaluation::owner_report_impact(tx, verified, &request.id).await? }
        else { crate::evaluation::owner_request_impact(tx, verified, &request, &record.receipt.accepted.operation_id).await? };
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    authorization::check_output(tx, verified, &admission, &impact, 1, now).await?;
    use world_protocol::operation::{ReceiptDetail, ReceiptDisclosure};
    let mut receipt = record.receipt.clone();
    let mut withheld = vec![ReceiptDetail::ProgressCounts, ReceiptDetail::Effects];
    receipt.progress.completed = 0;
    receipt.progress.total = None;
    receipt.effects.clear();
    if let Some(commit) = &mut receipt.commit {
        commit.revisions.clear();
        commit.outbox_ids.clear();
        withheld.push(ReceiptDetail::CommittedRevisions);
    }
    if has_report {
        receipt.result = Some(OperationResult::EvaluationSummary(crate::evaluation::summary(tx, &admission, &request.id, now).await?));
        withheld.push(ReceiptDetail::ResultDetails);
    }
    if let Some(failure) = &receipt.failure {
        receipt.failure = Some(crate::evaluation::summary_failure(failure));
        withheld.push(ReceiptDetail::FailureDetails);
    }
    receipt.disclosure = ReceiptDisclosure::Summary { withheld };
    Ok(receipt)
}

pub(crate) async fn batch(store: &WorldStore, binding: &RequestBinding) -> Result<crate::store::PreparedBatch, Error> {
    let (storage_epoch, fence) = store.snapshot(binding.world().clone(), |snapshot| Box::pin(head::operation_fence(snapshot))).await?;
    CommitRequest {
        world: binding.world().clone(), commit_id: CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        input_digest: binding.request_digest().clone(), storage_epoch, fences: vec![fence], watch_basis: Vec::new(),
    }.prepare().map_err(Error::from)
}
