use std::sync::Arc;

use foundation::pipeline::PipelineContext;
use futures_util::future::BoxFuture;
use sha2::{Digest as _, Sha256};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::ApiFailure,
    budget::{BudgetDimension, Usage},
    failure::{Failure, FailureStage, Recovery},
    generation::{
        GenerationFailure, GenerationFailureKind, GenerationReceipt, GenerationRequest,
        GenerationStage, GenerationState,
    },
    ids::*,
    materials::SourceVersionRef,
    operation::OperationFailure,
    time::DurationMs,
};

use super::{
    BoundGeneration, GenerationError, GenerationInput, RecordedGeneration,
    error::{codec, rejected},
    ledger::{self, PreparedCall},
    recovery::{
        self, GenerationRecovery, Observed, Pending, Plan, observed_failure, pin_release_error,
        settle_observed,
    },
};
use crate::{
    authorization::{self, Admission},
    content::Content,
    extensions::invocation::{CallBudget, ReservationFailure},
    owner::Error,
    store::{CommitRequest, Committed, PreparedBatch, StoreFuture, TransactionError, WorldStore},
};

pub(crate) fn generate<'a>(
    store: &'a WorldStore,
    recovery: &'a GenerationRecovery,
    admission: &'a Admission,
    pipeline: &'a PipelineContext,
    budget: &'a CallBudget,
    content: Arc<Content>,
    bound: Arc<dyn BoundGeneration>,
    request: GenerationRequest,
    sources: Vec<SourceVersionRef>,
    call_key: &'a str,
    cancel: CancellationToken,
    deadline: Instant,
) -> StoreFuture<'a, RecordedGeneration, Error> {
    Box::pin(async move {
        if call_key.is_empty()
            || call_key.len() > 1024
            || call_key.chars().any(char::is_control)
            || request.binding != bound.binding().reference
            || request.world != admission.invocation().world
            || request.world != *content.world()
            || request.context.len() > 4096
        {
            return Err(rejected(
                GenerationStage::Admission,
                GenerationFailureKind::BindingInvalid,
            ));
        }
        let identity = (&request.world, &request.run_id, &request.step_id, call_key);
        let id = ModelCallId::try_new(hash(&identity)?.as_str()[7..].to_owned()).map_err(codec)?;
        let execution = recovery.execution(&id);
        let _execution = execution.lock().await;
        let descriptor_digest = bytes_digest(bound.descriptor().as_bytes());
        let input_digest = hash(&(&request, &sources, bound.binding(), &descriptor_digest))?;
        let plan = recovery::plan(store, &request.world, &id, &input_digest).await?;
        restore_allowances(store, budget, &request).await?;
        if let Some(pending) = recovery.get(&id) {
            if hash(&pending.call.input.request)? != hash(&request)? {
                return Err(ledger::conflict(&id));
            }
            return settle_observed(store, recovery, admission, budget, &content, pending).await;
        }
        let observed = recovery::read_observed(store, &plan).await?;
        let original = recovery::read::<PreparedCall>(store, &plan.prepare).await?;
        if let Some(prepared) = original.as_ref() {
            if recovery::read::<()>(store, &plan.failed).await?.is_some() {
                store
                    .release_generation_pins(&plan.prepare, prepared)
                    .await
                    .map_err(pin_release_error)?;
                return read_terminal(store, admission, &id, &input_digest)
                    .await?
                    .unwrap_or_else(|| Err(ledger::indeterminate(&id)));
            }
            if let Some(observed) = observed {
                let pending = recovery.retain(Pending {
                    plan: plan.clone(),
                    call: prepared.value.clone(),
                    primary: observed.failure.clone().map(Error::from),
                    observed,
                    output: None,
                    stage: None,
                    attempt: 0,
                });
                return settle_observed(store, recovery, admission, budget, &content, pending).await;
            }
            match recovery::resolve::<()>(store, &plan.dispatch).await {
                Ok(_) => {
                    confirm_dispatch(budget, &plan.dispatch.commit_id)?;
                    return read_terminal(store, admission, &id, &input_digest)
                        .await?
                        .unwrap_or_else(|| Err(ledger::indeterminate(&id)));
                }
                Err(TransactionError::NotCommitted { cleanup: None, .. }) => {
                    release_dispatch(budget, &plan.dispatch.commit_id)?;
                    release_dispatch(budget, &recovery::commit_id(&id, "allowance")?)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        check_current(store, admission).await?;
        let prepared_batch = plan.prepare.clone().prepare()?;
        let saved_admission = admission.clone();
        let saved_request = request.clone();
        let model = bound.binding().clone();
        let saved_id = id.clone();
        let saved_digest = input_digest.clone();
        let saved_key = call_key.to_owned();
        let prepared = prepare_call(
            store, prepared_batch, saved_admission, saved_request, sources, model,
            descriptor_digest, saved_id, saved_digest, saved_key,
        )
        .await?;
        let call = prepared.value.clone();
        if let Some(outcome) = read_terminal(store, admission, &id, &input_digest).await? {
            return outcome;
        }
        let input = match read_input(store, &content, &prepared).await {
            Ok(input) => input,
            Err(error) => {
                return Err(settle_prepared_failure(store, &plan, &call, error).await);
            }
        };
        let schema_result = async {
            let pin = call.pins.last().ok_or_else(|| {
                rejected(
                    GenerationStage::Admission,
                    GenerationFailureKind::InternalFault,
                )
            })?;
            let schema_bytes = content
                .read_pinned(
                    store,
                    &Committed {
                        value: pin.clone(),
                        receipt: prepared.receipt.clone(),
                        replayed: prepared.replayed,
                    },
                )
                .await?;
            let schema: serde_json::Value = serde_json::from_slice(&schema_bytes).map_err(|cause| {
                rejected(
                    GenerationStage::Admission,
                    GenerationFailureKind::SchemaMismatch {
                        expected: request.result_schema.clone(),
                    },
                )
                .caused(cause)
            })?;
            jsonschema::validator_for(&schema).map_err(|cause| {
                rejected(
                    GenerationStage::Admission,
                    GenerationFailureKind::SchemaMismatch {
                        expected: request.result_schema.clone(),
                    },
                )
                .caused(std::io::Error::other(cause.to_string()))
            })
        }
        .await;
        let validator = match schema_result {
            Ok(validator) => validator,
            Err(error) => {
                return Err(settle_prepared_failure(store, &plan, &call, error).await);
            }
        };
        let saved_allowance = recovery::read::<Usage>(store, &plan.allowance(&id)?).await?;
        let preflight = || -> Result<Instant, Error> {
            budget
                .check()
                .map_err(|error| budget_error(error.dimension))?;
            let limit = budget.limit();
            if request.budget.max_cost.is_some() || limit.max_cost.is_some() {
                return Err(unsupported_budget("max_cost"));
            }
            let input_bytes = input.prompt.len() as u64
                + input
                    .context
                    .iter()
                    .map(|text| text.len() as u64)
                    .sum::<u64>();
            if input_bytes >= request.budget.max_bytes {
                return Err(budget_error(BudgetDimension::Bytes));
            }
            let output_tokens = bound.binding().parameters.maximum_output_tokens;
            if output_tokens > request.budget.max_output_tokens
                || output_tokens
                    > budget
                        .remaining(BudgetDimension::OutputTokens)
                        .map_err(|error| budget_error(error.dimension))?
            {
                return Err(budget_error(BudgetDimension::OutputTokens));
            }
            if input_bytes
                >= budget
                    .remaining(BudgetDimension::Bytes)
                    .map_err(|error| budget_error(error.dimension))?
            {
                return Err(budget_error(BudgetDimension::Bytes));
            }
            if request.budget.max_model_calls == 0
                || budget
                    .remaining(BudgetDimension::ModelCalls)
                    .map_err(|error| budget_error(error.dimension))?
                    == 0
            {
                return Err(budget_error(BudgetDimension::ModelCalls));
            }
            if cancel.is_cancelled() || pipeline.is_cancelled() {
                return Err(cancelled());
            }
            let now = Instant::now();
            let wall_deadline = now
                .checked_add(std::time::Duration::from_millis(
                    request.budget.max_wall_time.0.saturating_sub(budget.usage().elapsed.0),
                ))
                .ok_or_else(|| budget_error(BudgetDimension::WallTime))?;
            if now >= wall_deadline {
                return Err(budget_error(BudgetDimension::WallTime));
            }
            let absolute_deadline = request.budget.deadline.as_ref().map(|at| {
                let millis = at.unix_millis().checked_sub(chrono::Utc::now().timestamp_millis())
                    .and_then(|millis| u64::try_from(millis).ok())
                    .filter(|millis| *millis != 0)
                    .ok_or_else(|| budget_error(BudgetDimension::Deadline))?;
                now.checked_add(std::time::Duration::from_millis(millis))
                    .ok_or_else(|| budget_error(BudgetDimension::Deadline))
            }).transpose()?;
            let deadline = deadline.min(budget.deadline()).min(wall_deadline)
                .min(absolute_deadline.unwrap_or(wall_deadline));
            if now >= deadline {
                return Err(budget_error(BudgetDimension::Deadline));
            }
            Ok(deadline)
        };
        let deadline = match preflight() {
            Ok(deadline) => deadline,
            Err(error) => return Err(settle_prepared_failure(store, &plan, &call, error).await),
        };
        let counted = if let Some(saved) = &saved_allowance {
            Ok(saved.value.input_tokens)
        } else {
            let count_cancel = cancel.child_token();
            let pipeline_cancel = pipeline.cancellation();
            let count = bound.count_input(&input, count_cancel.clone());
            tokio::pin!(count);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => { count_cancel.cancel(); Err(cancelled()) },
                _ = pipeline_cancel.cancelled() => { count_cancel.cancel(); Err(cancelled()) },
                _ = tokio::time::sleep_until(deadline.min(budget.deadline())) => {
                    count_cancel.cancel();
                    Err(budget_error(BudgetDimension::Deadline))
                },
                result = &mut count => result.map_err(Error::from),
            }
        };
        let input_tokens = match counted {
            Ok(tokens) if tokens <= request.budget.max_input_tokens => tokens,
            Ok(_) => {
                return Err(settle_prepared_failure(
                    store,
                    &plan,
                    &call,
                    budget_error(BudgetDimension::InputTokens),
                )
                .await);
            }
            Err(error) => return Err(settle_prepared_failure(store, &plan, &call, error).await),
        };
        let deadline = match preflight() {
            Ok(current) => deadline.min(current),
            Err(error) => return Err(settle_prepared_failure(store, &plan, &call, error).await),
        };
        let prepared_batch = plan.dispatch.clone().prepare()?;
        let saved_admission = admission.clone();
        let saved = call.clone();
        let dispatch_budget = budget.clone();
        let input_bytes = input.prompt.len() as u64
            + input
                .context
                .iter()
                .map(|text| text.len() as u64)
                .sum::<u64>();
        let mut reservation = empty_usage();
        reservation.bytes = input_bytes;
        reservation.model_calls = 1;
        let allowance_id = recovery::commit_id(&id, "allowance")?;
        let mut allowance = empty_usage();
        allowance.bytes = request.budget.max_bytes.saturating_sub(input_bytes).min(
            budget.remaining(BudgetDimension::Bytes)
                .map_err(|error| budget_error(error.dimension))?.saturating_sub(input_bytes),
        );
        allowance.input_tokens = input_tokens;
        allowance.output_tokens = bound.binding().parameters.maximum_output_tokens;
        if let Some(saved) = &saved_allowance {
            validate_allowance(&call.id, &call.input, &saved.value)?;
            allowance = saved.value.clone();
        }
        if allowance.bytes == 0 {
            return Err(settle_prepared_failure(store, &plan, &call, budget_error(BudgetDimension::Bytes)).await);
        }
        if let Err(error) = budget.reserve(&allowance_id, allowance.clone()) {
            return Err(settle_prepared_failure(store, &plan, &call, reservation_error(error)).await);
        }
        let held_allowance = allowance.clone();
        match store
            .transact(plan.allowance(&id)?.prepare()?, move |_| {
                Box::pin(async move { Ok::<_, Error>(held_allowance) })
            })
            .await
        {
            Ok(saved) if saved.value == allowance => {}
            Ok(_) => return Err(ledger::conflict(&id)),
            Err(error @ TransactionError::NotCommitted { cleanup: None, .. }) => {
                release_dispatch(budget, &allowance_id)?;
                return Err(settle_prepared_failure(store, &plan, &call, error.into()).await);
            }
            Err(error) => return Err(error.into()),
        }
        if let Err(error) = budget.reserve(&plan.dispatch.commit_id, reservation) {
            let primary = reservation_error(error);
            let primary = match release_dispatch(budget, &allowance_id) {
                Ok(()) => primary,
                Err(cleanup) => primary.with_related(cleanup),
            };
            return Err(settle_prepared_failure(store, &plan, &call, primary).await);
        }
        let dispatched = match dispatch_call(
            store, prepared_batch, saved_admission, saved, dispatch_budget, input_bytes,
        )
        .await
        {
            Ok(dispatched) => dispatched,
            Err(error @ TransactionError::NotCommitted { .. }) => {
                let primary = Error::from(error);
                let primary = match release_dispatch(budget, &plan.dispatch.commit_id) {
                    Ok(()) => primary,
                    Err(cleanup) => primary.with_related(cleanup),
                };
                let primary = match release_dispatch(budget, &allowance_id) {
                    Ok(()) => primary,
                    Err(cleanup) => primary.with_related(cleanup),
                };
                return Err(settle_prepared_failure(store, &plan, &call, primary).await);
            }
            Err(error) => return Err(error.into()),
        };
        let dispatch_failure = confirm_dispatch(budget, &plan.dispatch.commit_id).err();
        if dispatched.replayed {
            return read_terminal(store, admission, &id, &input_digest)
                .await?
                .unwrap_or_else(|| Err(ledger::indeterminate(&id)));
        }
        // Once dispatched, recovery reads the original call. It never repeats an ambiguous paid request.
        let work_cancel = cancel.child_token();
        let pipeline_cancel = pipeline.cancellation();
        let deadline = deadline.min(budget.deadline());
        let (mut result, raw_receipt) = if let Some(error) = dispatch_failure {
            (Err(error), None)
        } else {
            let work = bound.generate(input, id.clone(), work_cancel.clone());
            tokio::pin!(work);
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => { work_cancel.cancel(); work.await },
                _ = pipeline_cancel.cancelled() => { work_cancel.cancel(); work.await },
                _ = tokio::time::sleep_until(deadline) => { work_cancel.cancel(); work.await },
                result = &mut work => result,
            };
            let raw_receipt = match &result {
                Ok(receipt) => Some(receipt.clone()),
                Err(error) => error.failure.receipt.as_deref().cloned(),
            };
            (result.map_err(Error::from), raw_receipt)
        };
        if Instant::now() >= deadline {
            let exceeded = Error::from_host_failure(
                world_protocol::process::HostFailure::BudgetExceeded { dimension: BudgetDimension::Deadline },
                FailureStage::Generate,
            );
            result = Err(match result {
                Err(primary) => primary.with_related(exceeded),
                Ok(_) => exceeded,
            });
        }
        let mut receipt = raw_receipt.clone();
        if let Some(observed) = &receipt {
            if let Err(error) = ledger::validate_receipt(&request, observed, &id) {
                result = Err(match result {
                    Err(primary) => error.with_related(primary),
                    Ok(_) => error,
                });
                receipt = None;
            }
        }
        if let Ok(receipt) = &result {
            if receipt.state == GenerationState::Completed {
                let parsed = world_protocol::wire::decode::<serde_json::Value>(
                    receipt.text.as_bytes(),
                    request.budget.max_bytes.min(usize::MAX as u64) as usize,
                );
                if !parsed.as_ref().is_ok_and(|value| validator.is_valid(value)) {
                    result = Err(GenerationError::new(GenerationFailure {
                        stage: GenerationStage::Output,
                        kind: GenerationFailureKind::SchemaMismatch {
                            expected: request.result_schema.clone(),
                        },
                        receipt: Some(Box::new(receipt.clone())),
                    })
                    .into());
                }
            }
        }
        if let Some(observed) = &mut receipt {
            if !complete_usage(observed) {
                observed.state = GenerationState::Partial;
            }
        }
        if let Some(receipt) = &raw_receipt {
            for checked in [
                settle_usage(budget, &id, &plan.finish.commit_id, receipt),
                check_request_output(&request, receipt),
            ] {
                if let Err(error) = checked {
                    result = Err(match result {
                        Err(primary) => primary.with_related(error),
                        Ok(_) => error,
                    });
                }
            }
        }
        let primary = result.err();
        let observed = Observed {
            receipt,
            raw_receipt,
            failure: primary.as_ref().map(observed_failure).transpose()?,
        };
        let pending = recovery.retain(Pending {
            plan,
            call,
            observed,
            primary,
            output: None,
            stage: None,
            attempt: 0,
        });
        settle_observed(store, recovery, admission, budget, &content, pending).await
    })
}

fn prepare_call(
    store: &WorldStore,
    prepared_batch: PreparedBatch,
    saved_admission: Admission,
    saved_request: GenerationRequest,
    sources: Vec<SourceVersionRef>,
    model: world_protocol::generation::ModelBinding,
    descriptor_digest: Digest,
    saved_id: ModelCallId,
    saved_digest: Digest,
    saved_key: String,
) -> StoreFuture<'_, Committed<PreparedCall>, Error> {
    Box::pin(async move {
        store
            .transact(prepared_batch, move |tx| {
                Box::pin(async move {
                    ledger::prepare(
                        tx,
                        &saved_admission,
                        &saved_request,
                        &sources,
                        &model,
                        descriptor_digest,
                        &saved_id,
                        &saved_digest,
                        &saved_key,
                    )
                    .await
                })
            })
            .await
            .map_err(Error::from)
    })
}

fn dispatch_call(
    store: &WorldStore,
    prepared_batch: PreparedBatch,
    saved_admission: Admission,
    saved: PreparedCall,
    dispatch_budget: CallBudget,
    input_bytes: u64,
) -> StoreFuture<'_, Committed<()>, TransactionError<Error>> {
    Box::pin(async move {
        store
            .transact(prepared_batch, move |tx| {
                Box::pin(async move {
                    ledger::dispatch(tx, &saved_admission, &saved, &dispatch_budget, input_bytes).await
                })
            })
            .await
    })
}

async fn read_input(
    store: &WorldStore,
    content: &Content,
    prepared: &Committed<PreparedCall>,
) -> Result<GenerationInput, Error> {
    let mut bytes = Vec::with_capacity(prepared.value.pins.len());
    for pin in prepared
        .value
        .pins
        .iter()
        .take(prepared.value.pins.len().saturating_sub(1))
    {
        let committed = Committed {
            value: pin.clone(),
            receipt: prepared.receipt.clone(),
            replayed: prepared.replayed,
        };
        bytes
            .push(String::from_utf8(content.read_pinned(store, &committed).await?).map_err(codec)?);
    }
    let mut bytes = bytes.into_iter();
    Ok(GenerationInput {
        request: prepared.value.input.request.clone(),
        prompt: bytes
            .next()
            .ok_or_else(|| rejected(GenerationStage::Read, GenerationFailureKind::InternalFault))?,
        context: bytes.collect(),
        sources: prepared.value.input.sources.clone(),
    })
}

fn settle_prepared_failure<'a>(
    store: &'a WorldStore,
    plan: &'a Plan,
    call: &'a PreparedCall,
    error: Error,
) -> BoxFuture<'a, Error> {
    Box::pin(async move {
        match fail_prepared(store, plan, call, &error).await {
            Ok(()) => error,
            Err(settlement) => settlement.with_related(error),
        }
    })
}

fn fail_prepared<'a>(
    store: &'a WorldStore,
    plan: &'a Plan,
    call: &'a PreparedCall,
    error: &'a Error,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let prepared_batch = plan.failed.clone().prepare()?;
        let call = call.clone();
        let failure = observed_failure(error)?;
        store
            .transact(prepared_batch, move |tx| {
                Box::pin(async move { ledger::fail_prepared(tx, &call, &failure).await })
            })
            .await
            .map_err(Error::from)?;
        Ok(())
    })
}

pub(super) fn read_terminal<'a>(
    store: &'a WorldStore,
    admission: &'a Admission,
    id: &'a ModelCallId,
    digest: &'a Digest,
) -> StoreFuture<'a, Option<Result<RecordedGeneration, Error>>, Error> {
    Box::pin(async move {
        let prepared_batch = batch(store, admission, id, "read", digest).await?;
        let saved_admission = admission.clone();
        let id = id.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        store.transact(prepared_batch, move |tx| Box::pin(async move {
            let recorded = ledger::read_recorded(tx, &saved_admission, &id).await?;
            let row = tx.query_opt("SELECT status,failure FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?;
            let outcome = match row {
                Some(row) if row.get::<_, String>("status") == "failed" => {
                    let body = row.get::<_, Option<serde_json::Value>>("failure").ok_or_else(|| ledger::conflict(&id))?;
                    Some(Err(Error::from(serde_json::from_value::<Failure<OperationFailure>>(body).map_err(codec)?)))
                },
                Some(row) if matches!(row.get::<_, String>("status").as_str(), "dispatched" | "indeterminate") => {
                    Some(Err(ledger::indeterminate(&id)))
                },
                _ => recorded.map(Ok),
            };
            let _ = sender.send(outcome);
            Ok::<_, Error>(())
        })).await.map_err(Error::from)?;
        let outcome = receiver.await.map_err(codec)?;
        check_current(store, admission).await?;
        Ok(outcome)
    })
}

async fn batch(
    store: &WorldStore,
    admission: &Admission,
    id: &ModelCallId,
    phase: &str,
    digest: &Digest,
) -> Result<PreparedBatch, Error> {
    let (storage_epoch, fences) = store
        .snapshot(admission.invocation().world.clone(), |snapshot| {
            Box::pin(async move {
                crate::owner::writer_fences(snapshot, &["generation", "operation"]).await
            })
        })
        .await?;
    let commit_id = CommitId::try_new(if phase == "read" {
        format!("model-{}-read-{}", id.as_str(), uuid::Uuid::new_v4())
    } else {
        format!("model-{}-{phase}", id.as_str())
    })
    .map_err(codec)?;
    CommitRequest {
        world: admission.invocation().world.clone(),
        commit_id,
        input_digest: digest.clone(),
        storage_epoch,
        fences,
        watch_basis: Vec::new(),
    }
    .prepare()
    .map_err(Into::into)
}
fn check_current<'a>(store: &'a WorldStore, admission: &'a Admission) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let admission = admission.clone();
        store
            .snapshot(admission.invocation().world.clone(), move |snapshot| {
                Box::pin(async move {
                    authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
                    Ok::<_, Error>(())
                })
            })
            .await
    })
}
pub(super) fn hash(value: &impl serde::Serialize) -> Result<Digest, Error> {
    Ok(bytes_digest(&serde_json::to_vec(value).map_err(codec)?))
}
fn bytes_digest(bytes: &[u8]) -> Digest {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("SHA256 digest syntax")
}
/// A lower bound of observed consumption, never evidence that every usage dimension is known.
pub(super) fn output_usage(receipt: &GenerationReceipt) -> Usage {
    let mut usage = empty_usage();
    usage.bytes = receipt.text.len() as u64;
    if let Some(observed) = &receipt.usage {
        if let Some(input) = observed.input_tokens {
            usage.input_tokens = input;
        }
        if let Some(output) = observed.output_tokens {
            usage.output_tokens = output;
        }
    }
    usage
}

pub(super) fn complete_usage(receipt: &GenerationReceipt) -> bool {
    receipt
        .usage
        .as_ref()
        .is_some_and(|usage| usage.input_tokens.is_some() && usage.output_tokens.is_some())
}

pub(super) fn settle_usage(
    budget: &CallBudget,
    id: &ModelCallId,
    finish: &CommitId,
    receipt: &GenerationReceipt,
) -> Result<(), Error> {
    let usage = output_usage(receipt);
    let allowance = recovery::commit_id(id, "allowance")?;
    if complete_usage(receipt) {
        budget.settle_actual(&allowance, finish, usage)
    } else {
        budget.record_partial(&allowance, finish, usage)
    }.map_err(reservation_error)
}

pub(super) fn check_request_output(
    request: &GenerationRequest,
    receipt: &GenerationReceipt,
) -> Result<(), Error> {
    if !complete_usage(receipt) {
        let mut partial = receipt.clone();
        partial.state = GenerationState::Partial;
        return Err(GenerationError::new(GenerationFailure {
            stage: GenerationStage::Output,
            kind: GenerationFailureKind::InvalidOutput,
            receipt: Some(Box::new(partial)),
        })
        .into());
    }
    if receipt.state == GenerationState::Completed
        && (receipt.finish_reason.as_deref() != Some("stop")
            || receipt.completed_at.is_none()
            || receipt.delivery_uncertain)
    {
        return Err(GenerationError::new(GenerationFailure {
            stage: GenerationStage::Output,
            kind: GenerationFailureKind::InvalidOutput,
            receipt: Some(Box::new(receipt.clone())),
        })
        .into());
    }
    let usage = output_usage(receipt);
    for (dimension, used, maximum) in [
        (
            BudgetDimension::Bytes,
            usage.bytes,
            request.budget.max_bytes,
        ),
        (
            BudgetDimension::InputTokens,
            usage.input_tokens,
            request.budget.max_input_tokens,
        ),
        (
            BudgetDimension::OutputTokens,
            usage.output_tokens,
            request.budget.max_output_tokens,
        ),
    ] {
        if used > maximum {
            let mut failure = observed_failure(&budget_error(dimension))?;
            failure.stage = FailureStage::Generate;
            return Err(failure.into());
        }
    }
    Ok(())
}

pub(super) fn empty_usage() -> Usage {
    Usage {
        elapsed: DurationMs(0),
        steps: 0,
        source_reads: 0,
        rows: 0,
        bytes: 0,
        model_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: None,
    }
}

pub(super) fn reservation_error(error: ReservationFailure) -> Error {
    match error {
        ReservationFailure::Budget(error) => budget_error(error.dimension),
        ReservationFailure::IdentityConflict(commit_id) => {
            Error::from(crate::store::StoreError::new(
                world_protocol::commit::CommitFailure::CommitIdPayloadConflict { commit_id },
                world_protocol::failure::FailureStage::Recover,
            ))
        }
    }
}

pub(super) fn validate_allowance(id: &ModelCallId, input: &ledger::LedgerInput, usage: &Usage) -> Result<(), Error> {
    let request = &input.request;
    let input_bytes = request.context.iter().try_fold(request.prompt.byte_size, |bytes, blob| {
        bytes.checked_add(blob.byte_size).ok_or_else(|| ledger::conflict(id))
    })?;
    let mut expected = empty_usage();
    expected.bytes = usage.bytes;
    expected.input_tokens = usage.input_tokens;
    expected.output_tokens = input.model.parameters.maximum_output_tokens;
    if usage != &expected || request.binding != input.model.reference
        || usage.input_tokens > request.budget.max_input_tokens
        || usage.output_tokens > request.budget.max_output_tokens
        || usage.bytes == 0 || usage.bytes > request.budget.max_bytes.saturating_sub(input_bytes)
    {
        return Err(ledger::conflict(id).caused(std::io::Error::other(
            "original generation allowance does not cover the bound output dimensions",
        )));
    }
    Ok(())
}

fn restore_allowances<'a>(
    store: &'a WorldStore,
    budget: &'a CallBudget,
    request: &'a GenerationRequest,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let run = request.run_id.clone();
        let calls = store.snapshot(request.world.clone(), move |snapshot| {
            Box::pin(async move {
                let rows = snapshot.query(
                    "SELECT model_call_id,input_digest,request,receipt,status FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 ORDER BY model_call_id",
                    &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &run.as_str()],
                ).await?;
                rows.into_iter().map(|row| {
                    Ok::<_, Error>((
                        ModelCallId::try_new(row.get::<_, String>("model_call_id")).map_err(codec)?,
                        Digest::try_new(row.get::<_, String>("input_digest")).map_err(codec)?,
                        serde_json::from_value::<ledger::LedgerInput>(row.get("request")).map_err(codec)?,
                        row.get::<_, Option<serde_json::Value>>("receipt")
                            .map(serde_json::from_value::<GenerationReceipt>).transpose().map_err(codec)?,
                        row.get::<_, String>("status"),
                    ))
                }).collect::<Result<Vec<_>, Error>>()
            })
        }).await?;
        for (id, digest, input, receipt, status) in calls {
            if input.request.world != request.world || input.request.run_id != request.run_id {
                return Err(ledger::conflict(&id));
            }
            if status == "completed" || receipt.as_ref().is_some_and(complete_usage) {
                continue;
            }
            let plan_id = recovery::commit_id(&id, "plan")?;
            let Some(plan) = store
                .read_commit_optional::<Plan>(&request.world, &plan_id, &digest)
                .await?
            else {
                return Err(ledger::conflict(&id));
            };
            let plan = plan.value;
            plan.validate(&request.world, &id, &digest)?;
            // A confirmed pre-dispatch failure did not consume tokens; no paid retry is inferred.
            if recovery::read::<()>(store, &plan.failed).await?.is_some() {
                continue;
            }
            let allowance = plan.allowance(&id)?;
            if let Some(saved) = recovery::read::<Usage>(store, &allowance).await? {
                let usage = saved.value;
                validate_allowance(&id, &input, &usage)?;
                if status == "failed" {
                    if recovery::read::<()>(store, &plan.finish).await?.is_none() {
                        return Err(ledger::indeterminate(&id));
                    }
                    let observed = recovery::read_observed(store, &plan).await?
                        .ok_or_else(|| ledger::indeterminate(&id))?;
                    if let Some(raw) = &observed.raw_receipt {
                        if complete_usage(raw) { continue; }
                        budget.restore_partial(
                            &allowance.commit_id, &plan.finish.commit_id, usage, output_usage(raw),
                        ).map_err(reservation_error)?;
                        continue;
                    }
                }
                if budget.reserved_usage(&allowance.commit_id).is_none() {
                    budget.restore_reserved(&allowance.commit_id, usage).map_err(reservation_error)?;
                }
            } else if status != "prepared" {
                return Err(ledger::indeterminate(&id));
            }
        }
        Ok(())
    })
}

pub(super) fn confirm_dispatch(budget: &CallBudget, commit: &CommitId) -> Result<(), Error> {
    if budget.reserved_usage(commit).is_some() {
        budget.commit_reserved(commit).map_err(reservation_error)?;
    }
    Ok(())
}

fn release_dispatch(budget: &CallBudget, commit: &CommitId) -> Result<(), Error> {
    if budget.reserved_usage(commit).is_some() {
        budget.release_reserved(commit).map_err(reservation_error)?;
    }
    Ok(())
}

fn unsupported_budget(parameter: &str) -> Error {
    rejected(
        GenerationStage::Admission,
        GenerationFailureKind::UnsupportedParameter {
            parameter: parameter.to_owned(),
        },
    )
}

fn cancelled() -> Error {
    Error::new(
        "world.generation_cancelled",
        FailureStage::Admission,
        "模型调用已取消。",
        ApiFailure::Operation(OperationFailure::Cancelled),
        Recovery::None,
    )
}
fn budget_error(dimension: BudgetDimension) -> Error {
    Error::new(
        "world.generation_budget_exceeded",
        FailureStage::Admission,
        "模型调用超过预算。",
        ApiFailure::Operation(OperationFailure::BudgetExceeded { dimension }),
        Recovery::None,
    )
}
