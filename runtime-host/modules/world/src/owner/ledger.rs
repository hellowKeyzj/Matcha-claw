use serde::{Deserialize, Serialize};
use world_protocol::{
    api::{ApiFailure, CommandEnvelope},
    authorization::Actor,
    commit::CommittedRevision,
    failure::{Failure, FailureStage, Recovery},
    ids::*,
    operation::{CancellationState, OperationAccepted, OperationPhase, OperationProgress, OperationReceipt, OperationResult},
    time::Timestamp,
};

use crate::{
    authorization::{Admission, RestartIdentity, recheck},
    store::{OutboxEvent, WorldSnapshot, WorldTransaction},
};
use super::Error;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "input", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum OperationInput {
    Command(CommandEnvelope),
    Maintenance(MaintenanceInput),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaintenanceInput {
    pub world: WorldRef,
    pub request_id: RequestId,
    pub basis: MaintenanceBasis,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum MaintenanceBasis {
    Retirement { candidates: Vec<RetirementIdentity> },
    ContentCleanup { batch: crate::content::CleanupBatch },
    Support { claim: crate::facts::support::RecomputeClaim },
    SupportWatches { batch: crate::facts::support::DueWatches },
    PackageCleanup { batch: crate::extensions::package::PackageCleanupBatch },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetirementIdentity {
    pub id: ActivationLockId,
    pub revision: Revision,
    pub digest: Digest,
}

impl OperationInput {
    pub(crate) fn world(&self) -> &WorldRef {
        match self { Self::Command(input) => &input.world, Self::Maintenance(input) => &input.world }
    }

    fn request_id(&self) -> &RequestId {
        match self { Self::Command(input) => &input.request_id, Self::Maintenance(input) => &input.request_id }
    }

    pub(crate) fn operation_name(&self) -> &'static str {
        match self {
            Self::Command(input) => input.command.operation_name(),
            Self::Maintenance(MaintenanceInput { basis: MaintenanceBasis::Retirement { .. }, .. }) => "maintenance.retirement",
            Self::Maintenance(MaintenanceInput { basis: MaintenanceBasis::ContentCleanup { .. }, .. }) => "maintenance.content_cleanup",
            Self::Maintenance(MaintenanceInput { basis: MaintenanceBasis::Support { .. }, .. }) => "maintenance.support",
            Self::Maintenance(MaintenanceInput { basis: MaintenanceBasis::SupportWatches { .. }, .. }) => "maintenance.support_watches",
            Self::Maintenance(MaintenanceInput { basis: MaintenanceBasis::PackageCleanup { .. }, .. }) => "maintenance.package_cleanup",
        }
    }

    pub(crate) fn command_envelope(&self) -> Result<&CommandEnvelope, Error> {
        match self {
            Self::Command(input) => Ok(input),
            Self::Maintenance(_) => Err(Error::new("world.internal_operation_not_resumable", FailureStage::Recover,
                "内部维护操作不能通过业务命令入口恢复。", ApiFailure::UnsupportedOperation, Recovery::None)),
        }
    }

    pub(crate) fn command(&self) -> Result<&world_protocol::api::WorldCommand, Error> {
        Ok(&self.command_envelope()?.command)
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StrategyActionParent {
    pub operation_id: OperationId,
    pub run_id: RunId,
    pub step_id: StepId,
    pub input_digest: Digest,
    pub strategy_step: StepId,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationRecord {
    pub receipt: OperationReceipt,
    pub input: OperationInput,
    pub identity: RestartIdentity,
    pub impact: world_protocol::authorization::ActualImpact,
    pub strategy_parent: Option<StrategyActionParent>,
}

pub(super) fn operation_id(world: &WorldRef, request: &RequestId, kind: &str) -> OperationId {
    let digest = crate::definitions::canonical_digest(&("world.operation.v1", world, request, kind)).expect("operation identity serializes");
    OperationId::try_new(format!("operation-{}", &digest.as_str()[7..])).expect("digest identifier")
}

/// The caller's admission and operation insert are committed as one batch.
pub(crate) async fn accept(
    tx: &mut WorldTransaction<'_>, admission: &Admission, request: &OperationInput,
    operation_id: OperationId, incarnation: Generation, now: &Timestamp,
) -> Result<OperationRecord, Error> {
    accept_inner(tx, admission, request, None, &admission.invocation().request_digest, operation_id, incarnation, now).await
}

pub(super) async fn accept_strategy_action(
    tx: &mut WorldTransaction<'_>, admission: &Admission, request: &CommandEnvelope,
    parent: StrategyActionParent, operation_id: OperationId, incarnation: Generation, now: &Timestamp,
) -> Result<OperationRecord, Error> {
    if !matches!(request.command, world_protocol::api::WorldCommand::ActionSubmit(_)) {
        return Err(Error::internal(FailureStage::Admission));
    }
    let digest = crate::definitions::canonical_digest(&(request, &parent))?;
    accept_inner(tx, admission, &OperationInput::Command(request.clone()), Some(parent), &digest, operation_id, incarnation, now).await
}

async fn accept_inner(
    tx: &mut WorldTransaction<'_>, admission: &Admission, request: &OperationInput,
    strategy_parent: Option<StrategyActionParent>, input_digest: &Digest,
    operation_id: OperationId, incarnation: Generation, now: &Timestamp,
) -> Result<OperationRecord, Error> {
    if tx.world() != request.world() || &admission.invocation().world != tx.world() || incarnation.0 == 0 {
        return Err(Error::internal(FailureStage::Admission));
    }
    recheck(tx, admission, now).await?;
    let world = tx.world();
    let actor = match &admission.invocation().actor { Actor::Human { id } | Actor::Service { id } => id };
    let existing = tx.query_opt(
        "SELECT actor_id,input_digest,body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND kind=$3 AND request_id=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.operation_name(), &request.request_id().as_str()],
    ).await?;
    if let Some(row) = existing {
        if row.get::<_, String>("actor_id") != actor.as_str() {
            return Err(world_protocol::authorization::AuthorizationFailure::InsufficientScope.into());
        }
        if row.get::<_, String>("input_digest") != input_digest.as_str() {
            return Err(Error::new("world.request_payload_conflict", FailureStage::Admission,
                "同一请求身份已绑定其他输入。", ApiFailure::RevisionConflict, Recovery::None));
        }
        let record: OperationRecord = decode(row.get("body"))?;
        if record.strategy_parent != strategy_parent { return Err(conflict()); }
        return Ok(record);
    }
    let record = OperationRecord {
        receipt: OperationReceipt {
            accepted: OperationAccepted { world: world.clone(), operation_id, revision: Revision(1), incarnation },
            disclosure: world_protocol::operation::ReceiptDisclosure::Full,
            phase: OperationPhase::Accepted,
            progress: OperationProgress { stage: FailureStage::Admission, completed: 0, total: None, run_id: None, step_id: None },
            result: None, failure: None, commit: None, effects: Vec::new(),
            cancellation: CancellationState::NotRequested, updated_at: now.clone(),
        },
        input: request.clone(), identity: admission.restart_identity(), impact: admission.impact().clone(), strategy_parent,
    };
    let body = encode(&record)?;
    let fence = tx.fences().iter().find(|fence| fence.domain.as_str() == "operation")
        .ok_or_else(|| Error::internal(FailureStage::Admission))?;
    tx.execute(
        "INSERT INTO world_operation(tenant_id,world_id,operation_id,kind,request_id,input_digest,revision,phase,actor_id,branch_id,writer_domain,writer_epoch,body) VALUES($1,$2,$3,$4,$5,$6,1,'accepted',$7,$8,$9,$10,$11)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.receipt.accepted.operation_id.as_str(),
          &request.operation_name(), &request.request_id().as_str(), &input_digest.as_str(),
          &actor.as_str(), &admission.invocation().branch_id.as_ref().map(BranchId::as_str), &fence.domain.as_str(),
          &(fence.epoch.0 as i64), &body],
    ).await?;
    changed(tx, &record.receipt).await?;
    Ok(record)
}

pub(crate) async fn read(tx: &WorldTransaction<'_>, id: &OperationId) -> Result<OperationRecord, Error> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| Error::new("world.operation_not_found", FailureStage::Read,
        "操作不存在或当前不可访问。", ApiFailure::NotFound, Recovery::None))?;
    let record: OperationRecord = decode(row.get("body"))?;
    if record.receipt.accepted.world != *world || record.receipt.accepted.operation_id != *id || record.input.world() != world {
        return Err(Error::internal(FailureStage::Read));
    }
    Ok(record)
}

/// Internal durable fact read. Public callers still require current admission and output checks.
pub(crate) async fn read_snapshot(snapshot: &WorldSnapshot<'_>, id: &OperationId) -> Result<OperationReceipt, Error> {
    Ok(read_record_snapshot(snapshot, id).await?.receipt)
}

pub(crate) async fn read_record_snapshot(snapshot: &WorldSnapshot<'_>, id: &OperationId) -> Result<OperationRecord, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?
        .ok_or_else(|| Error::new("world.operation_not_found", FailureStage::Read,
            "操作不存在或当前不可访问。", ApiFailure::NotFound, Recovery::None))?;
    let record: OperationRecord = decode(row.get("body"))?;
    if record.receipt.accepted.world != *world || record.receipt.accepted.operation_id != *id || record.input.world() != world {
        return Err(Error::internal(FailureStage::Read));
    }
    Ok(record)
}

/// A domain reducer calls this inside its own final transaction, never after a second commit.
pub(crate) async fn complete(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted, result: OperationResult, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    complete_inner(tx, expected, Some(result), now).await
}

pub(crate) async fn complete_maintenance(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    complete_inner(tx, expected, None, now).await
}

async fn complete_inner(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted, result: Option<OperationResult>, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    let mut record = read(tx, &expected.operation_id).await?;
    check_expected(&record.receipt, expected)?;
    if terminal(record.receipt.phase)
        || matches!(&record.input, OperationInput::Maintenance(_)) != result.is_none() { return Err(conflict()); }
    record.receipt.phase = if record.receipt.cancellation == CancellationState::NotRequested {
        OperationPhase::Completed
    } else {
        record.receipt.cancellation = CancellationState::SettledAfterEffect;
        OperationPhase::CancelledAfterCommit
    };
    record.receipt.result = result;
    record.receipt.failure = None;
    record.receipt.progress.stage = FailureStage::Commit;
    save(tx, &mut record, now).await?;
    super::run::settle(tx, &record.receipt).await?;
    Ok(record.receipt)
}

/// Final counts include this operation's completion, run settlement and emitted hint.
pub(crate) async fn complete_world_deletion(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted, content: &crate::content::Content, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    let receipt = complete(tx, expected, OperationResult::Delete { deleted: true, retained: Vec::new() }, now).await?;
    let retained = tx.world_deletion_retained(content).await?;
    let mut record = read(tx, &expected.operation_id).await?;
    if record.receipt != receipt { return Err(conflict()); }
    record.receipt.result = Some(OperationResult::Delete { deleted: true, retained });
    let changed = tx.execute(
        "UPDATE world_operation SET body=$5 WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &expected.operation_id.as_str(), &(receipt.accepted.revision.0 as i64), &encode(&record)?],
    ).await?;
    if changed != 1 { return Err(conflict()); }
    Ok(record.receipt)
}

pub(crate) struct OperationUpdate {
    pub phase: OperationPhase,
    pub progress: OperationProgress,
    pub failure: Option<Failure<world_protocol::operation::OperationFailure>>,
    pub effects: Vec<world_protocol::actions::SourceReceipt>,
}

pub(crate) async fn update(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted, update: OperationUpdate, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    let mut record = read(tx, &expected.operation_id).await?;
    check_expected(&record.receipt, expected)?;
    if terminal(record.receipt.phase) || terminal(update.phase) { return Err(conflict()); }
    if record.receipt.phase == OperationPhase::CommitIndeterminate && update.phase != OperationPhase::CommitIndeterminate {
        return Err(conflict());
    }
    if record.receipt.phase == OperationPhase::EffectIndeterminate
        && !matches!(update.phase, OperationPhase::EffectIndeterminate | OperationPhase::Verifying | OperationPhase::Retained) {
        return Err(conflict());
    }
    record.receipt.phase = update.phase;
    record.receipt.progress = update.progress;
    record.receipt.failure = update.failure;
    for effect in update.effects {
        if let Some(previous) = record.receipt.effects.iter().find(|previous| previous.id == effect.id) {
            if previous != &effect { return Err(conflict()); }
        } else { record.receipt.effects.push(effect); }
    }
    save(tx, &mut record, now).await?;
    super::run::settle(tx, &record.receipt).await?;
    Ok(record.receipt)
}

pub(crate) async fn receipt(tx: &WorldTransaction<'_>, id: &OperationId) -> Result<OperationReceipt, Error> {
    Ok(read(tx, id).await?.receipt)
}

pub(crate) async fn fail(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted,
    failure: Failure<world_protocol::operation::OperationFailure>, cancelled: bool, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    fail_inner(tx, expected, failure, cancelled, None, now).await
}

pub(super) async fn fail_settled_work(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted,
    failure: Failure<world_protocol::operation::OperationFailure>, cancelled: bool,
    proof: &super::settlement::SettledWorkFailure, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    fail_inner(tx, expected, failure, cancelled, Some(proof), now).await
}

async fn fail_inner(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted,
    failure: Failure<world_protocol::operation::OperationFailure>, cancelled: bool,
    recovered: Option<&super::settlement::SettledWorkFailure>, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    let mut record = read(tx, &expected.operation_id).await?;
    check_expected(&record.receipt, expected)?;
    if terminal(record.receipt.phase) { return Err(conflict()); }
    if let Some(proof) = recovered {
        let run = super::run::read_run(tx, record.receipt.progress.run_id.as_ref().ok_or_else(conflict)?).await?;
        if !proof.matches(&run, expected) { return Err(conflict()); }
    }
    let indeterminate = unresolved_phase(&failure.details);
    let known_no_effect = !record.receipt.effects.is_empty() && record.receipt.effects.iter().all(|effect| matches!(effect.disposition,
        world_protocol::actions::EffectDisposition::NotSent | world_protocol::actions::EffectDisposition::Rejected | world_protocol::actions::EffectDisposition::NotApplied));
    let possible_effect = record.receipt.effects.iter().any(|effect| !matches!(effect.disposition,
        world_protocol::actions::EffectDisposition::NotSent | world_protocol::actions::EffectDisposition::Rejected | world_protocol::actions::EffectDisposition::NotApplied))
        || (recovered.is_none() && (matches!(record.receipt.phase, OperationPhase::Draining | OperationPhase::Retained | OperationPhase::CommitIndeterminate)
            || (!known_no_effect && matches!(record.receipt.phase, OperationPhase::Verifying | OperationPhase::Committing | OperationPhase::EffectIndeterminate))));
    record.receipt.phase = if let Some(phase) = indeterminate { phase } else if possible_effect {
        OperationPhase::Retained
    } else if cancelled {
        record.receipt.cancellation = CancellationState::SettledBeforeEffect;
        OperationPhase::CancelledBeforeCommit
    } else { OperationPhase::Failed };
    if cancelled && possible_effect { record.receipt.cancellation = CancellationState::Retained; }
    record.receipt.failure = Some(failure);
    if let Some(id) = &record.receipt.progress.run_id {
        let run = super::run::read_run(tx, id).await?;
        if let Some(result) = super::workflows::materials::failure_result(tx, &run).await? { record.receipt.result = Some(result); }
    }
    save(tx, &mut record, now).await?;
    super::run::settle(tx, &record.receipt).await?;
    Ok(record.receipt)
}

pub(crate) fn unresolved_phase(failure: &world_protocol::operation::OperationFailure) -> Option<OperationPhase> {
    use world_protocol::{operation::OperationFailure as F, commit::CommitFailure, sources::SourceFailure,
        releases::ReleaseFailure, generation::GenerationFailureKind, slots::SlotFailure,
        process::HostFailure, query::QueryFailure, state::StateFailure, actions::ActionFailure};
    fn commit(failure: &CommitFailure) -> Option<OperationPhase> {
        matches!(failure, CommitFailure::CommitIndeterminate { .. }).then_some(OperationPhase::CommitIndeterminate)
    }
    fn source(failure: &SourceFailure) -> Option<OperationPhase> {
        match failure {
            SourceFailure::Commit { failure } => commit(failure),
            SourceFailure::Release { failure } => release(failure),
            SourceFailure::PluginInvocation { failure } => host(failure),
            SourceFailure::EffectIndeterminate { .. } => Some(OperationPhase::EffectIndeterminate),
            SourceFailure::Cleanup { primary, .. } => primary.as_deref().and_then(source).or(Some(OperationPhase::Retained)),
            SourceFailure::ReaderNotStopped | SourceFailure::AckChannelNotStopped => Some(OperationPhase::Retained),
            _ => None,
        }
    }
    fn host(failure: &HostFailure) -> Option<OperationPhase> {
        match failure {
            HostFailure::Operation(failure) => unresolved_phase(failure),
            HostFailure::Source(failure) | HostFailure::Slot(SlotFailure::Connector(failure)) => source(failure),
            HostFailure::Slot(SlotFailure::Storage(failure)) | HostFailure::State(StateFailure::Commit { failure })
            | HostFailure::Binding(world_protocol::bindings::BindingFailure::Commit { failure }) => commit(failure),
            HostFailure::Query(QueryFailure::Source { failure, .. })
            | HostFailure::Slot(SlotFailure::Resolver(QueryFailure::Source { failure, .. })) => source(failure),
            HostFailure::Slot(SlotFailure::Action(failure)) => action(failure),
            HostFailure::Generation(failure) => generation(&failure.kind),
            HostFailure::Process(world_protocol::process::ProcessFailure::ExitUnconfirmed | world_protocol::process::ProcessFailure::Retained | world_protocol::process::ProcessFailure::CancelTimeout) => Some(OperationPhase::Retained),
            _ => None,
        }
    }
    fn action(failure: &ActionFailure) -> Option<OperationPhase> {
        match failure {
            ActionFailure::Source { failure } | ActionFailure::Evaluation { failure: QueryFailure::Source { failure, .. } } => source(failure),
            ActionFailure::Commit { failure } => commit(failure),
            ActionFailure::EffectIndeterminate { .. } => Some(OperationPhase::EffectIndeterminate),
            _ => None,
        }
    }
    fn generation(failure: &GenerationFailureKind) -> Option<OperationPhase> {
        match failure {
            GenerationFailureKind::Commit { failure } => commit(failure),
            GenerationFailureKind::CallIndeterminate { .. } => Some(OperationPhase::Retained),
            _ => None,
        }
    }
    fn release(failure: &ReleaseFailure) -> Option<OperationPhase> {
        match failure {
            ReleaseFailure::Commit { failure } => commit(failure),
            ReleaseFailure::BackfillFailed { failure, .. } => source(failure),
            _ => None,
        }
    }
    match failure {
        F::Commit(failure) => commit(failure),
        F::Source(failure) => source(failure),
        F::Query(QueryFailure::Source { failure, .. }) => source(failure),
        F::Action(failure) => action(failure),
        F::State(StateFailure::Commit { failure })
        | F::Binding(world_protocol::bindings::BindingFailure::Commit { failure })
        | F::Package(world_protocol::package::PackageFailure::Commit { failure }) => commit(failure),
        F::Package(world_protocol::package::PackageFailure::CleanupFailed) => Some(OperationPhase::Retained),
        F::Release(failure) => release(failure),
        F::Generation(failure) | F::Learning(world_protocol::learning::LearningFailure::Model { failure }) => generation(&failure.kind),
        F::Learning(world_protocol::learning::LearningFailure::Commit { failure })
        | F::Evaluation(world_protocol::evaluation::EvaluationFailure::Commit { failure })
        | F::Lifecycle(world_protocol::lifecycle::LifecycleFailure::Commit { failure }) => commit(failure),
        F::Lifecycle(world_protocol::lifecycle::LifecycleFailure::Retained { .. })
        | F::Process(world_protocol::process::ProcessFailure::ExitUnconfirmed | world_protocol::process::ProcessFailure::Retained | world_protocol::process::ProcessFailure::CancelTimeout)
        | F::CleanupFailed => Some(OperationPhase::Retained),
        F::Slot(SlotFailure::Connector(failure)) => source(failure),
        F::Slot(SlotFailure::Storage(failure)) => commit(failure),
        F::Slot(SlotFailure::Resolver(QueryFailure::Source { failure, .. })) => source(failure),
        F::Slot(SlotFailure::Action(failure)) => action(failure),
        _ => None,
    }
}

/// Owned evidence that the original disable actually joined every affected live resource.
pub(crate) struct DrainedDisableSettlement {
    operation: OperationAccepted,
    install: InstallId,
    revision: Revision,
    failure: Failure<world_protocol::operation::OperationFailure>,
}

impl DrainedDisableSettlement {
    pub(crate) fn new(
        live: &crate::extensions::lifecycle::LiveExtensions,
        intent: &crate::extensions::package::CommittedDisable,
        drained: &crate::extensions::lifecycle::DrainedInstall,
    ) -> Result<Self, Error> {
        if !live.validate_install_drained(drained) || drained.world() != intent.world()
            || drained.install() != intent.install() || drained.commit_id() != intent.commit_id()
            || drained.revision() != intent.revision() { return Err(conflict()); }
        let cause = drained.process_failures().first().ok_or_else(conflict)?;
        let error = Error::from(crate::extensions::lifecycle::LifecycleError::Process(cause.clone()));
        let mut failure = error.operation_failure().ok_or(error)?;
        failure.stage = FailureStage::Drain;
        failure.operation_id = Some(intent.operation().operation_id.clone());
        Ok(Self { operation: intent.operation().clone(), install: intent.install().clone(), revision: intent.revision(), failure })
    }
}

/// A joined process failure is final; generic failure cannot infer this from Draining.
pub(crate) async fn fail_drained_disable(
    tx: &mut WorldTransaction<'_>, expected: &OperationAccepted,
    proof: &DrainedDisableSettlement, now: &Timestamp,
) -> Result<OperationReceipt, Error> {
    if proof.operation.world != *tx.world() || proof.operation.operation_id != expected.operation_id
        || proof.operation.incarnation != expected.incarnation { return Err(conflict()); }
    let mut record = read(tx, &expected.operation_id).await?;
    check_expected(&record.receipt, expected)?;
    let world_protocol::api::WorldCommand::DisablePackage(command) = record.input.command()? else { return Err(conflict()); };
    if command.install_id != proof.install || command.expected_revision.0.checked_add(1) != Some(proof.revision.0)
        || !matches!(record.receipt.phase, OperationPhase::Draining | OperationPhase::Retained) { return Err(conflict()); }
    let mut failure = proof.failure.clone();
    failure.run_id = record.receipt.progress.run_id.clone();
    record.receipt.phase = OperationPhase::Failed;
    record.receipt.progress.stage = FailureStage::Drain;
    record.receipt.result = Some(OperationResult::Package { install_id: proof.install.clone(), revision: proof.revision });
    record.receipt.failure = Some(failure);
    if record.receipt.cancellation != CancellationState::NotRequested { record.receipt.cancellation = CancellationState::SettledAfterEffect; }
    save(tx, &mut record, now).await?;
    super::run::settle(tx, &record.receipt).await?;
    Ok(record.receipt)
}

pub(crate) async fn save(tx: &mut WorldTransaction<'_>, record: &mut OperationRecord, now: &Timestamp) -> Result<(), Error> {
    let expected = record.receipt.accepted.revision;
    let next = expected.0.checked_add(1).filter(|next| *next <= i64::MAX as u64)
        .ok_or_else(|| Error::internal(FailureStage::Commit))?;
    record.receipt.accepted.revision = Revision(next);
    record.receipt.updated_at = now.clone();
    let world = tx.world();
    let body = encode(record)?;
    let failure = record.receipt.failure.as_ref().map(encode).transpose()?;
    let phase = serde_json::to_value(record.receipt.phase).map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))?;
    let phase = phase.as_str().ok_or_else(|| Error::internal(FailureStage::Commit))?;
    let changed_count = tx.execute(
        "UPDATE world_operation SET revision=$4,phase=$5,body=$6,failure=$7,updated_at=$8::text::timestamptz,terminal_at=CASE WHEN $9 THEN $8::text::timestamptz ELSE NULL END WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 AND revision=$10",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &record.receipt.accepted.operation_id.as_str(),
          &(next as i64), &phase, &body, &failure, &now.as_str(), &terminal(record.receipt.phase), &(expected.0 as i64)],
    ).await?;
    if changed_count != 1 { return Err(conflict()); }
    changed(tx, &record.receipt).await
}

pub(crate) fn terminal(phase: OperationPhase) -> bool {
    matches!(phase, OperationPhase::Completed | OperationPhase::Failed | OperationPhase::CancelledBeforeCommit | OperationPhase::CancelledAfterCommit)
}

fn check_expected(receipt: &OperationReceipt, expected: &OperationAccepted) -> Result<(), Error> {
    if &receipt.accepted != expected { return Err(conflict()); }
    Ok(())
}
fn conflict() -> Error {
    Error::new("world.operation_revision_conflict", FailureStage::Validate,
        "操作状态已变化，请读取当前状态。", ApiFailure::RevisionConflict, Recovery::Refresh)
}
async fn changed(tx: &mut WorldTransaction<'_>, receipt: &OperationReceipt) -> Result<(), Error> {
    tx.record_revision(CommittedRevision { resource: ResourceRef::Operation { id: receipt.accepted.operation_id.clone() }, revision: receipt.accepted.revision })?;
    let hint = world_protocol::events::WorldHint::Changed {
        world: receipt.accepted.world.clone(), incarnation: receipt.accepted.incarnation,
        resource: ResourceRef::Operation { id: receipt.accepted.operation_id.clone() }, revision: receipt.accepted.revision,
    };
    tx.emit(OutboxEvent {
        event_id: EventId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        aggregate_kind: "operation".into(), aggregate_id: receipt.accepted.operation_id.to_string(),
        aggregate_revision: receipt.accepted.revision.0, event_kind: "world.changed".into(), payload: encode(&hint)?,
        causation_id: None, origin: "world".into(),
    }).await?;
    Ok(())
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))
}
fn decode<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|cause| Error::internal(FailureStage::Read).caused(cause))
}
