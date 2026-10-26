use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::generation::{
    GenerationFailureKind, GenerationStage, ModelBinding, ModelBindingRef,
};

use super::{BoundGeneration, GenerationError, GenerationSelection, WorldGeneration};
use crate::{
    authorization::{self, Admission},
    store::{WorldSnapshot, WorldStore},
};

/// The existing materials.binding step result. Deserialization is not binding authority.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindingBasis {
    binding: ModelBinding,
    descriptor: String,
}

impl BindingBasis {
    pub(crate) fn reference(&self) -> &ModelBindingRef {
        &self.binding.reference
    }
}

/// The workflow persists this Provider-issued basis in its existing binding step.
pub(crate) async fn prepare_binding(
    store: &WorldStore,
    admission: &Admission,
    generation: &dyn WorldGeneration,
    selection: GenerationSelection,
    cancel: CancellationToken,
) -> Result<(Arc<dyn BoundGeneration>, BindingBasis), GenerationError> {
    check_cancelled(&cancel)?;
    check_current(store, admission).await?;
    let bound = generation.prepare(selection, cancel.clone()).await?;
    check_cancelled(&cancel)?;
    let basis = BindingBasis {
        binding: bound.binding().clone(),
        descriptor: bound.descriptor().to_owned(),
    };
    validate(&basis)?;
    check_current(store, admission).await?;
    check_cancelled(&cancel)?;
    Ok((bound, basis))
}

/// Resolve only a completed durable producer for the exact reference, never a model head.
/// This restores Provider custody; source reads remain subject to the model-call ledger.
pub(crate) async fn restore_binding(
    store: &WorldStore,
    admission: &Admission,
    generation: &dyn WorldGeneration,
    exact: &ModelBindingRef,
    cancel: CancellationToken,
) -> Result<Arc<dyn BoundGeneration>, GenerationError> {
    check_cancelled(&cancel)?;
    let saved_admission = admission.clone();
    let reference = exact.clone();
    let basis = store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(async move {
                current(snapshot, &saved_admission).await?;
                let revision = reference.revision.0.to_string();
                let row = snapshot.query_opt(
                    "SELECT result FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND kind='materials.binding' AND phase='completed' AND result #>> '{binding,reference,id}'=$3 AND result #>> '{binding,reference,revision}'=$4 AND result #>> '{binding,reference,digest}'=$5 ORDER BY run_id,step_id LIMIT 1",
                    &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &reference.id.as_str(), &revision, &reference.digest.as_str()],
                ).await?.ok_or_else(|| GenerationError::rejected(
                    GenerationStage::Binding,
                    GenerationFailureKind::BindingMissing { binding_id: reference.id.clone() },
                ))?;
                let basis: BindingBasis = serde_json::from_value(row.get("result"))
                    .map_err(GenerationError::codec)?;
                if basis.reference() != &reference {
                    return Err(invalid());
                }
                validate(&basis)?;
                Ok::<_, GenerationError>(basis)
            })
        })
        .await?;
    check_cancelled(&cancel)?;
    let bound = generation
        .restore(
            basis.binding.clone(),
            basis.descriptor.clone(),
            cancel.clone(),
        )
        .await?;
    if bound.binding() != &basis.binding || bound.descriptor() != basis.descriptor {
        return Err(GenerationError::rejected(
            GenerationStage::Binding,
            GenerationFailureKind::BindingStale,
        ));
    }
    check_current(store, admission).await?;
    check_cancelled(&cancel)?;
    Ok(bound)
}

async fn check_current(store: &WorldStore, admission: &Admission) -> Result<(), GenerationError> {
    let admission = admission.clone();
    store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(async move { current(snapshot, &admission).await })
        })
        .await
}

async fn current(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
) -> Result<(), GenerationError> {
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    authorization::check_admitted_output_read(snapshot, admission, admission.impact(), 1, &now)
        .await?;
    Ok(())
}

fn validate(basis: &BindingBasis) -> Result<(), GenerationError> {
    if basis.binding.reference.digest.as_str()
        != format!("sha256:{:x}", Sha256::digest(basis.descriptor.as_bytes()))
    {
        return Err(invalid());
    }
    Ok(())
}

fn invalid() -> GenerationError {
    GenerationError::rejected(
        GenerationStage::Binding,
        GenerationFailureKind::BindingInvalid,
    )
}

fn check_cancelled(cancel: &CancellationToken) -> Result<(), GenerationError> {
    if cancel.is_cancelled() {
        return Err(GenerationError::rejected(
            GenerationStage::Binding,
            GenerationFailureKind::Cancelled,
        ));
    }
    Ok(())
}
