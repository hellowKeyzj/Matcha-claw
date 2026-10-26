use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    expression::Effect,
    generation::{
        GenerationFailureKind, GenerationReceipt, GenerationRequest, GenerationStage, ModelBinding,
    },
    ids::*,
    materials::SourceVersionRef,
};

use super::error::{codec, rejected};
use crate::owner::Error;
use crate::{
    authorization::{self, Admission},
    content::{self, BlobPin, ContentOwner, PinKind},
    store::WorldTransaction,
};
use world_protocol::{failure::Failure, operation::OperationFailure};

/// Only the durable producer and its current-authorized reader can construct this witness.
pub(crate) struct RecordedGeneration {
    request: GenerationRequest,
    receipt: GenerationReceipt,
}
impl RecordedGeneration {
    pub(crate) fn request(&self) -> &GenerationRequest {
        &self.request
    }
    pub(crate) fn receipt(&self) -> &GenerationReceipt {
        &self.receipt
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LedgerInput {
    pub request: GenerationRequest,
    pub model: ModelBinding,
    pub descriptor_digest: Digest,
    pub sources: Vec<SourceVersionRef>,
    pub impact: ActualImpact,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedCall {
    pub(super) id: ModelCallId,
    pub(super) input: LedgerInput,
    pub(super) pins: Vec<BlobPin>,
}

impl PreparedCall {
    pub(crate) fn id(&self) -> &ModelCallId {
        &self.id
    }

    pub(crate) fn run(&self) -> &RunId {
        &self.input.request.run_id
    }

    pub(crate) fn recovery_pins(&self, world: &WorldRef, run: &RunId) -> Result<&[BlobPin], Error> {
        let request = &self.input.request;
        if &request.world != world
            || &request.run_id != run
            || self.pins.len() != request.context.len() + 2
        {
            return Err(conflict(&self.id));
        }
        for (index, pin) in self.pins.iter().enumerate() {
            let blob = if index == 0 {
                &request.prompt
            } else if index <= request.context.len() {
                &request.context[index - 1]
            } else {
                if pin.reference().digest != request.result_schema {
                    return Err(conflict(&self.id));
                }
                pin.reference()
            };
            let id =
                ContentId::try_new(format!("model-{}-{index}", self.id.as_str())).map_err(codec)?;
            if !pin.matches_recovery_run(world, run, blob, &id) {
                return Err(conflict(&self.id));
            }
        }
        Ok(&self.pins)
    }

    pub(crate) async fn recovery_terminal(&self, tx: &WorldTransaction<'_>) -> Result<bool, Error> {
        self.recovery_pins(tx.world(), self.run())?;
        let row = tx.query_opt(
            "SELECT run_id,step_id,binding_digest,request,status FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3 FOR SHARE",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &self.id.as_str()],
        ).await?.ok_or_else(|| conflict(&self.id))?;
        let request = &self.input.request;
        if row.get::<_, String>("run_id") != request.run_id.as_str()
            || row.get::<_, String>("step_id") != request.step_id.as_str()
            || row.get::<_, String>("binding_digest") != request.binding.digest.as_str()
            || row.get::<_, serde_json::Value>("request") != encode(&self.input)?
        {
            return Err(conflict(&self.id));
        }
        match row.get::<_, String>("status").as_str() {
            "completed" | "failed" => Ok(true),
            "prepared" | "dispatched" | "indeterminate" => Ok(false),
            _ => Err(conflict(&self.id)),
        }
    }
}

pub(crate) async fn has_unsettled(tx: &WorldTransaction<'_>, run: &RunId) -> Result<bool, Error> {
    Ok(tx.query_opt(
        "SELECT 1 FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND status IN ('prepared','dispatched','indeterminate') LIMIT 1",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.as_str()],
    ).await?.is_some())
}

pub(crate) async fn has_unsettled_world(
    store: &crate::store::WorldStore,
    world: &WorldRef,
) -> Result<bool, Error> {
    store.snapshot(world.clone(), |snapshot| Box::pin(async move {
        let world = snapshot.world();
        Ok(snapshot.query_opt(
            "SELECT 1 FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND status IN ('prepared','dispatched','indeterminate') LIMIT 1",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?.is_some())
    })).await
}

pub(crate) async fn read_recorded(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &ModelCallId,
) -> Result<Option<RecordedGeneration>, Error> {
    let Some(row) = tx.query_opt(
        "SELECT request,receipt,status FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()],
    ).await? else { return Ok(None); };
    let input: LedgerInput = decode(row.get("request"))?;
    let now = tx.now().await?;
    require_run(tx, admission, &input.request).await?;
    let impact = current_impact(tx, admission, &input.request, &input.sources).await?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, 1, &now).await?;
    let receipt: Option<GenerationReceipt> = row
        .get::<_, Option<serde_json::Value>>("receipt")
        .map(decode)
        .transpose()?;
    match (row.get::<_, String>("status").as_str(), receipt) {
        ("completed" | "failed", Some(receipt)) if receipt.id == *id => {
            validate_receipt(&input.request, &receipt, id)?;
            Ok(Some(RecordedGeneration {
                request: input.request,
                receipt,
            }))
        }
        ("completed", _) => Err(rejected(
            GenerationStage::Output,
            GenerationFailureKind::InternalFault,
        )),
        _ => Ok(None),
    }
}

pub(super) async fn prepare(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &GenerationRequest,
    sources: &[SourceVersionRef],
    model: &ModelBinding,
    descriptor_digest: Digest,
    id: &ModelCallId,
    input_digest: &Digest,
    call_key: &str,
) -> Result<PreparedCall, Error> {
    require_execution_run(tx, admission, request).await?;
    let impact = current_impact(tx, admission, request, sources).await?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    let saved = LedgerInput {
        request: request.clone(),
        model: model.clone(),
        descriptor_digest,
        sources: sources.to_vec(),
        impact,
    };
    let world = tx.world();
    let changed = tx.execute(
        "INSERT INTO world_model_call(tenant_id,world_id,model_call_id,run_id,step_id,invocation_id,call_key,binding_digest,input_digest,revision,status,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'prepared',$10) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &request.run_id.as_str(), &request.step_id.as_str(), &admission.invocation().id.as_str(), &call_key, &request.binding.digest.as_str(), &input_digest.as_str(), &encode(&saved)?],
    ).await?;
    let row = tx.query_opt(
        "SELECT input_digest,request,status FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| conflict(id))?;
    if row.get::<_, String>("input_digest") != input_digest.as_str()
        || row.get::<_, serde_json::Value>("request") != encode(&saved)?
    {
        return Err(conflict(id));
    }
    if changed != 1 && row.get::<_, String>("status") != "prepared" {
        return Err(indeterminate(id));
    }
    let owner = ContentOwner::Run {
        id: request.run_id.clone(),
    };
    let references = content::owner_references(tx, &owner).await?;
    let mut blobs = vec![request.prompt.clone()];
    blobs.extend(request.context.clone());
    let schema = references
        .iter()
        .find(|reference| reference.blob.digest == request.result_schema)
        .ok_or_else(|| {
            rejected(
                GenerationStage::Admission,
                GenerationFailureKind::SchemaMismatch {
                    expected: request.result_schema.clone(),
                },
            )
        })?;
    blobs.push(schema.blob.clone());
    let mut pins = Vec::with_capacity(blobs.len());
    for (index, blob) in blobs.into_iter().enumerate() {
        let reference = references
            .iter()
            .find(|reference| reference.blob == blob)
            .ok_or_else(|| {
                rejected(
                    GenerationStage::Admission,
                    GenerationFailureKind::Material {
                        failure: world_protocol::materials::MaterialFailure::ContentNotFound,
                    },
                )
            })?;
        let pin_id = ContentId::try_new(format!("model-{}-{index}", id.as_str())).map_err(codec)?;
        pins.push(content::pin(tx, reference, pin_id, PinKind::Recovery).await?);
    }
    Ok(PreparedCall {
        id: id.clone(),
        input: saved,
        pins,
    })
}

pub(super) async fn dispatch(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    call: &PreparedCall,
    budget: &crate::extensions::invocation::CallBudget,
    input_bytes: u64,
) -> Result<(), Error> {
    let run = require_execution_run(tx, admission, &call.input.request).await?;
    let impact = current_impact(tx, admission, &call.input.request, &call.input.sources).await?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    let changed = tx.execute(
        "UPDATE world_model_call SET status='dispatched',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3 AND status='prepared'",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &call.id.as_str()],
    ).await?;
    if changed != 1 {
        return Err(indeterminate(&call.id));
    }
    let mut usage = run.usage.clone();
    add_usage(
        &mut usage.bytes,
        input_bytes,
        world_protocol::budget::BudgetDimension::Bytes,
    )?;
    add_usage(
        &mut usage.model_calls,
        1,
        world_protocol::budget::BudgetDimension::ModelCalls,
    )?;
    usage.elapsed = usage.elapsed.max(budget.usage().elapsed);
    crate::extensions::invocation::CallBudget::resume(
        run.budget.clone(),
        usage.clone(),
        &tx.now().await?,
    )
    .map_err(|error| budget_error(error.dimension))?;
    crate::owner::checkpoint_usage(tx, &run, usage).await?;
    Ok(())
}

pub(super) async fn fail_prepared(
    tx: &WorldTransaction<'_>,
    call: &PreparedCall,
    failure: &Failure<OperationFailure>,
) -> Result<(), Error> {
    let changed = tx.execute(
        "UPDATE world_model_call SET status='failed',revision=revision+1,failure=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3 AND status='prepared'",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &call.id.as_str(), &encode(failure)?],
    ).await?;
    if changed != 1 {
        return Err(indeterminate(&call.id));
    }
    for pin in &call.pins {
        content::release_pin(tx, pin).await?;
    }
    Ok(())
}

pub(super) async fn finish(
    tx: &WorldTransaction<'_>,
    call: &PreparedCall,
    receipt: Option<&GenerationReceipt>,
    failure: Option<&Failure<OperationFailure>>,
    observed_usage: &world_protocol::budget::Usage,
    elapsed: world_protocol::time::DurationMs,
) -> Result<(), Error> {
    let run = crate::owner::read_run(tx, &call.input.request.run_id).await?;
    let step = crate::owner::read_step(tx, &run.id, &call.input.request.step_id)
        .await?
        .ok_or_else(|| run_mismatch(&call.input.request))?;
    if run.operation.world != call.input.request.world
        || step.run_id != run.id
        || step.id != call.input.request.step_id
    {
        return Err(run_mismatch(&call.input.request));
    }
    if let Some(receipt) = receipt {
        validate_receipt(&call.input.request, receipt, &call.id)?;
    }
    if failure.is_none() {
        let receipt = receipt.ok_or_else(|| {
            rejected(
                GenerationStage::Output,
                GenerationFailureKind::InvalidOutput,
            )
        })?;
        super::run::check_request_output(&call.input.request, receipt)?;
        if receipt.state != world_protocol::generation::GenerationState::Completed
            || receipt.finish_reason.as_deref() != Some("stop")
            || receipt.completed_at.is_none()
            || receipt.delivery_uncertain
        {
            return Err(rejected(
                GenerationStage::Output,
                GenerationFailureKind::InvalidOutput,
            ));
        }
    }
    if observed_usage.elapsed.0 != 0
        || observed_usage.steps != 0
        || observed_usage.source_reads != 0
        || observed_usage.rows != 0
        || observed_usage.model_calls != 0
        || observed_usage.cost.is_some()
    {
        return Err(conflict(&call.id));
    }
    let status = if failure.is_some() {
        "failed"
    } else {
        "completed"
    };
    let changed = tx.execute(
        "UPDATE world_model_call SET status=$4,revision=revision+1,receipt=$5,failure=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3 AND status IN ('dispatched','indeterminate')",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &call.id.as_str(), &status, &receipt.map(encode).transpose()?, &failure.map(encode).transpose()?],
    ).await?;
    if changed != 1 {
        return Err(conflict(&call.id));
    }
    let mut usage = run.usage.clone();
    usage.elapsed = usage.elapsed.max(elapsed);
    add_usage(
        &mut usage.bytes,
        observed_usage.bytes,
        world_protocol::budget::BudgetDimension::Bytes,
    )?;
    add_usage(
        &mut usage.input_tokens,
        observed_usage.input_tokens,
        world_protocol::budget::BudgetDimension::InputTokens,
    )?;
    add_usage(
        &mut usage.output_tokens,
        observed_usage.output_tokens,
        world_protocol::budget::BudgetDimension::OutputTokens,
    )?;
    crate::owner::checkpoint_usage(tx, &run, usage).await?;
    for pin in &call.pins {
        content::release_pin(tx, pin).await?;
    }
    Ok(())
}

async fn attached_record(
    tx: &WorldTransaction<'_>,
    attached: &crate::learning::AttachedModelCall,
) -> Result<Option<(LedgerInput, GenerationReceipt)>, Error> {
    if attached.world() != tx.world() {
        return Err(rejected(
            GenerationStage::Admission,
            GenerationFailureKind::Authorization {
                failure: world_protocol::authorization::AuthorizationFailure::InsufficientScope,
            },
        ));
    }
    let Some(row) = tx.query_opt(
        "SELECT m.request,m.receipt FROM world_candidate_model_call c JOIN world_model_call m USING(tenant_id,world_id,model_call_id) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.candidate_id=$3 AND c.model_call_id=$4 AND c.request_digest=$5 AND c.receipt_digest=$6 AND m.status='completed'",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &attached.candidate_id().as_str(), &attached.id().as_str(), &attached.request_digest().as_str(), &attached.receipt_digest().as_str()],
    ).await? else { return Ok(None); };
    let input: LedgerInput = decode(row.get("request"))?;
    let receipt: GenerationReceipt = decode(row.get("receipt"))?;
    if crate::definitions::canonical_digest(&input.request)? != *attached.request_digest()
        || crate::definitions::canonical_digest(&receipt)? != *attached.receipt_digest()
    {
        return Err(conflict(attached.id()));
    }
    validate_receipt(&input.request, &receipt, attached.id())?;
    Ok(Some((input, receipt)))
}

async fn draft_record(
    tx: &WorldTransaction<'_>,
    reference: &world_protocol::materials::MaterialDraftRef,
    id: &ModelCallId,
) -> Result<Option<(LedgerInput, GenerationReceipt)>, Error> {
    if &reference.world != tx.world() {
        return Err(conflict(id));
    }
    let Some(row) = tx.query_opt(
        "SELECT run_id,step_id,binding_digest,input_digest,request,receipt FROM world_model_call WHERE tenant_id=$1 AND world_id=$2 AND model_call_id=$3 AND status='completed'",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()],
    ).await? else { return Ok(None); };
    let input: LedgerInput = decode(row.get("request"))?;
    let receipt: GenerationReceipt = decode(
        row.get::<_, Option<serde_json::Value>>("receipt")
            .ok_or_else(|| conflict(id))?,
    )?;
    use sha2::{Digest as _, Sha256};
    let bytes = serde_json::to_vec(&(
        &input.request,
        &input.sources,
        &input.model,
        &input.descriptor_digest,
    ))
    .map_err(codec)?;
    let digest = Digest::try_new(format!("sha256:{:x}", Sha256::digest(&bytes)))
        .expect("SHA256 digest syntax");
    if input.request.world != *tx.world()
        || input.model.reference != input.request.binding
        || input.request.run_id.as_str() != row.get::<_, String>("run_id")
        || input.request.step_id.as_str() != row.get::<_, String>("step_id")
        || input.request.binding.digest.as_str() != row.get::<_, String>("binding_digest")
        || digest.as_str() != row.get::<_, String>("input_digest")
        || receipt.state != world_protocol::generation::GenerationState::Completed
        || receipt.delivery_uncertain
        || receipt.completed_at.is_none()
    {
        return Err(conflict(id));
    }
    validate_receipt(&input.request, &receipt, id)?;
    Ok(Some((input, receipt)))
}

async fn candidate_draft_record(
    tx: &WorldTransaction<'_>,
    proof: &crate::owner::DraftModelCalls,
    id: &ModelCallId,
) -> Result<Option<(LedgerInput, GenerationReceipt)>, Error> {
    let Some((input, receipt)) = draft_record(tx, proof.reference(), id).await? else {
        return Ok(None);
    };
    if !proof.accepts(&input.request, id)
        || proof.sources(&input.request, id) != Some(input.sources.as_slice())
    {
        return Err(conflict(id));
    }
    Ok(Some((input, receipt)))
}

async fn observation_draft_record(
    tx: &WorldTransaction<'_>,
    proof: &crate::owner::DraftObservation,
) -> Result<(LedgerInput, GenerationReceipt), Error> {
    let id = proof.model_call_id();
    let (input, receipt) = draft_record(tx, proof.reference(), id)
        .await?
        .ok_or_else(|| conflict(id))?;
    if proof.request() != &input.request || proof.sources() != input.sources.as_slice() {
        return Err(conflict(id));
    }
    Ok((input, receipt))
}

pub(crate) async fn draft_observation_impact(
    tx: &WorldTransaction<'_>,
    proof: &crate::owner::DraftObservation,
) -> Result<ActualImpact, Error> {
    let (input, _) = observation_draft_record(tx, proof).await?;
    let impact = crate::owner::material_draft_impact(tx, proof.reference()).await?;
    source_impact(tx, impact, &input.sources).await
}

pub(crate) async fn read_draft_observation_recorded(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    proof: &crate::owner::DraftObservation,
) -> Result<RecordedGeneration, Error> {
    if &admission.invocation().world != tx.world() {
        return Err(conflict(proof.model_call_id()));
    }
    let (input, receipt) = observation_draft_record(tx, proof).await?;
    let impact = crate::owner::material_draft_impact(tx, proof.reference()).await?;
    let impact = source_impact(tx, impact, &input.sources).await?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, 1, &tx.now().await?).await?;
    Ok(RecordedGeneration {
        request: input.request,
        receipt,
    })
}

pub(crate) async fn draft_impact(
    tx: &WorldTransaction<'_>,
    proof: &crate::owner::DraftModelCalls,
    id: &ModelCallId,
) -> Result<ActualImpact, Error> {
    let (input, _) = candidate_draft_record(tx, proof, id)
        .await?
        .ok_or_else(|| conflict(id))?;
    let impact = crate::owner::material_draft_impact(tx, proof.reference()).await?;
    source_impact(tx, impact, &input.sources).await
}

pub(crate) async fn read_draft_recorded(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    proof: &crate::owner::DraftModelCalls,
    id: &ModelCallId,
) -> Result<Option<RecordedGeneration>, Error> {
    if &admission.invocation().world != tx.world() {
        return Err(conflict(id));
    }
    let Some((input, receipt)) = candidate_draft_record(tx, proof, id).await? else {
        return Ok(None);
    };
    let impact = crate::owner::material_draft_impact(tx, proof.reference()).await?;
    let impact = source_impact(tx, impact, &input.sources).await?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, 1, &tx.now().await?).await?;
    Ok(Some(RecordedGeneration {
        request: input.request,
        receipt,
    }))
}

pub(crate) async fn attached_impact(
    tx: &WorldTransaction<'_>,
    attached: &crate::learning::AttachedModelCall,
) -> Result<ActualImpact, Error> {
    let (input, _) = attached_record(tx, attached)
        .await?
        .ok_or_else(|| conflict(attached.id()))?;
    source_impact(tx, attached.impact().clone(), &input.sources).await
}

pub(crate) async fn read_attached(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    attached: &crate::learning::AttachedModelCall,
) -> Result<Option<RecordedGeneration>, Error> {
    if attached.world() != &admission.invocation().world {
        return Err(rejected(
            GenerationStage::Admission,
            GenerationFailureKind::Authorization {
                failure: world_protocol::authorization::AuthorizationFailure::InsufficientScope,
            },
        ));
    }
    let Some((input, receipt)) = attached_record(tx, attached).await? else {
        return Ok(None);
    };
    let impact = source_impact(tx, attached.impact().clone(), &input.sources).await?;
    admission.require_access(&impact)?;
    authorization::check_admitted_output(tx, admission, &impact, 1, &tx.now().await?).await?;
    Ok(Some(RecordedGeneration {
        request: input.request,
        receipt,
    }))
}

async fn source_impact(
    tx: &WorldTransaction<'_>,
    mut impact: ActualImpact,
    sources: &[SourceVersionRef],
) -> Result<ActualImpact, Error> {
    for source in sources {
        let version = content::read_source_version_in_transaction(tx, source).await?;
        let current = authorization::material_read_impact(tx, &version).await?;
        impact.access.extend(current.access);
        impact.effects.extend(current.effects);
        impact.labels.extend(current.labels);
        impact.state.extend(current.state);
        impact.source_ids.extend(current.source_ids);
    }
    Ok(authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

async fn require_run(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &GenerationRequest,
) -> Result<(crate::owner::RunRecord, crate::owner::StepRecord), Error> {
    if &request.world != tx.world() || request.world != admission.invocation().world {
        return Err(run_mismatch(request));
    }
    let run = crate::owner::require_run_invocation(tx, admission, &request.run_id).await?;
    let step = crate::owner::read_step(tx, &request.run_id, &request.step_id)
        .await?
        .ok_or_else(|| run_mismatch(request))?;
    if step.run_id != request.run_id || step.id != request.step_id {
        return Err(run_mismatch(request));
    }
    Ok((run, step))
}

async fn require_execution_run(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &GenerationRequest,
) -> Result<crate::owner::RunRecord, Error> {
    let (run, step) = require_run(tx, admission, request).await?;
    let operation = crate::owner::read_operation(tx, &run.operation.operation_id).await?;
    use world_protocol::operation::{CancellationState, OperationPhase};
    if !matches!(
        run.phase,
        OperationPhase::Admitted | OperationPhase::Running | OperationPhase::Verifying
    ) || !matches!(
        operation.phase,
        OperationPhase::Admitted | OperationPhase::Running | OperationPhase::Verifying
    ) || operation.cancellation != CancellationState::NotRequested
        || step.phase != OperationPhase::Running
        || !tx
            .fences()
            .iter()
            .any(|fence| fence.domain.as_str() == "operation" && fence.epoch == step.writer_epoch)
    {
        return Err(run_mismatch(request));
    }
    Ok(run)
}

async fn current_impact(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &GenerationRequest,
    sources: &[SourceVersionRef],
) -> Result<ActualImpact, Error> {
    let (run, step) = require_run(tx, admission, request).await?;
    let access = vec![if step.kind == "materials.extract" {
        crate::owner::extraction_access(tx, &run, &step, request, sources).await?
    } else {
        AccessScope {
            resources: vec![ResourceRef::Operation {
                id: run.operation.operation_id,
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Execute],
            scope: crate::owner::management_scope(tx).await?,
            valid_time: None,
        }
    }];
    let impact = authorization::actual_impact(
        access,
        vec![Effect::Probabilistic],
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    source_impact(tx, impact, sources).await
}

pub(super) fn validate_receipt(
    request: &GenerationRequest,
    receipt: &GenerationReceipt,
    id: &ModelCallId,
) -> Result<(), Error> {
    if receipt.id != *id
        || receipt.binding != request.binding
        || receipt.prompt_digest != request.prompt.digest
        || receipt.context_digests
            != request
                .context
                .iter()
                .map(|blob| blob.digest.clone())
                .collect::<Vec<_>>()
        || receipt.delivered_text_bytes > receipt.text.len() as u64
        || receipt
            .completed_at
            .as_ref()
            .is_some_and(|at| at < &receipt.started_at)
    {
        return Err(rejected(
            GenerationStage::Output,
            GenerationFailureKind::InvalidOutput,
        ));
    }
    Ok(())
}
fn add_usage(
    used: &mut u64,
    amount: u64,
    dimension: world_protocol::budget::BudgetDimension,
) -> Result<(), Error> {
    *used = used
        .checked_add(amount)
        .ok_or_else(|| budget_error(dimension))?;
    Ok(())
}
fn budget_error(dimension: world_protocol::budget::BudgetDimension) -> Error {
    Error::from_host_failure(
        world_protocol::process::HostFailure::BudgetExceeded { dimension },
        world_protocol::failure::FailureStage::Admission,
    )
}
pub(super) fn conflict(id: &ModelCallId) -> Error {
    rejected(
        GenerationStage::Admission,
        GenerationFailureKind::CallConflict {
            model_call_id: id.clone(),
        },
    )
}
pub(super) fn indeterminate(id: &ModelCallId) -> Error {
    rejected(
        GenerationStage::Output,
        GenerationFailureKind::CallIndeterminate {
            model_call_id: id.clone(),
        },
    )
}
fn run_mismatch(request: &GenerationRequest) -> Error {
    rejected(
        GenerationStage::Admission,
        GenerationFailureKind::RunMismatch {
            run_id: request.run_id.clone(),
            step_id: request.step_id.clone(),
        },
    )
}
pub(super) fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(codec)
}
fn decode<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(codec)
}
