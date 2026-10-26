use serde::{Deserialize, Serialize};
use world_protocol::{
    failure::FailureStage,
    ids::{ContentId, RunId},
    materials::MaterialFailure,
};

use super::{CleanupBatch, CleanupOutcome};
use crate::{
    content::{Error, decode, encode},
    owner::{self, StepRecord},
    store::{CommitRequest, WorldTransaction},
};

pub(super) const STEP_KIND: &str = "maintenance.content_cleanup";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CleanupCheckpoint {
    pub(super) entries: Vec<Entry>,
}

impl CleanupCheckpoint {
    pub(crate) fn validate(&self, batch: &CleanupBatch) -> Result<(), Error> {
        batch.validate()?;
        if self.entries.len() > 32
            || self.entries.iter().enumerate().any(|(index, entry)| {
                self.entries[..index]
                    .iter()
                    .any(|previous| previous.deletion_id == entry.deletion_id)
                    || !batch
                        .candidates
                        .iter()
                        .any(|candidate| candidate.deletion_id == entry.deletion_id)
                    || entry.finish.world != *batch.world()
                    || entry
                        .finish
                        .fences
                        .iter()
                        .any(|fence| fence.world != *batch.world())
                    || !entry
                        .finish
                        .fences
                        .iter()
                        .any(|fence| fence.domain.as_str() == "content")
                    || !entry
                        .finish
                        .fences
                        .iter()
                        .any(|fence| fence.domain.as_str() == "operation")
                    || (entry.outcome.is_some() && !entry.started)
            })
        {
            return Err(Error::material(MaterialFailure::CorruptContent));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    pub deletion_id: ContentId,
    pub token: ContentId,
    pub finish: CommitRequest,
    pub started: bool,
    pub outcome: Option<CleanupOutcome>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Recovery {
    pub finish: CommitRequest,
    pub started: bool,
    pub outcome: Option<CleanupOutcome>,
}

pub(super) async fn record(
    tx: &WorldTransaction<'_>,
    run: &RunId,
    batch: &CleanupBatch,
    entry: Entry,
) -> Result<(), owner::Error> {
    let step = step(tx, run, batch).await?;
    let mut next = step.clone();
    let mut checkpoint = next
        .checkpoint
        .get("contentCleanup")
        .cloned()
        .filter(|value| !value.is_null())
        .map(decode::<CleanupCheckpoint>)
        .transpose()?
        .unwrap_or(CleanupCheckpoint {
            entries: Vec::new(),
        });
    if let Some(previous) = checkpoint
        .entries
        .iter_mut()
        .find(|item| item.deletion_id == entry.deletion_id)
    {
        if previous.token != entry.token
            || (previous.started && encode(&previous.finish)? != encode(&entry.finish)?)
            || (previous.started && !entry.started)
            || (previous.outcome.is_some() && previous.outcome != entry.outcome)
        {
            return Err(Error::material(MaterialFailure::CorruptContent).into());
        }
        *previous = entry;
    } else {
        if checkpoint.entries.len() >= 32 {
            return Err(Error::material(MaterialFailure::SizeLimit).into());
        }
        checkpoint.entries.push(entry);
    }
    checkpoint.validate(batch)?;
    next.checkpoint
        .as_object_mut()
        .ok_or_else(|| owner::Error::internal(FailureStage::Recover))?
        .insert("contentCleanup".into(), encode(&checkpoint)?);
    owner::checkpoint_step(tx, &step, next).await?;
    Ok(())
}

pub(super) async fn recover(
    ctx: &owner::ExecutionContext,
    batch: &CleanupBatch,
) -> Result<Vec<Entry>, owner::Error> {
    let run = ctx.run.id.clone();
    let batch = batch.clone();
    ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
        let world = snapshot.world();
        let row = snapshot.query_opt(
            "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND ordinal=0 AND kind=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.as_str(), &STEP_KIND],
        ).await?.ok_or_else(|| owner::Error::internal(FailureStage::Recover))?;
        let step: StepRecord = decode(row.get("body"))?;
        let observed: CleanupBatch = decode(step.checkpoint.pointer("/basis/batch").cloned()
            .ok_or_else(|| owner::Error::internal(FailureStage::Recover))?)?;
        if step.run_id != run || step.input_digest != batch.input_digest()?
            || observed.input_digest()? != batch.input_digest()? {
            return Err(Error::material(MaterialFailure::CorruptContent).into());
        }
        let checkpoint = step.checkpoint.get("contentCleanup").cloned()
            .filter(|value| !value.is_null()).map(decode::<CleanupCheckpoint>).transpose()?;
        let checkpoint = checkpoint.unwrap_or(CleanupCheckpoint { entries: Vec::new() });
        checkpoint.validate(&batch)?;
        Ok(checkpoint.entries)
    })).await
}

async fn step(
    tx: &WorldTransaction<'_>,
    run: &RunId,
    batch: &CleanupBatch,
) -> Result<StepRecord, owner::Error> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND ordinal=0 AND kind=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.as_str(), &STEP_KIND],
    ).await?.ok_or_else(|| owner::Error::internal(FailureStage::Recover))?;
    let step: StepRecord = decode(row.get("body"))?;
    let observed: CleanupBatch = decode(
        step.checkpoint
            .pointer("/basis/batch")
            .cloned()
            .ok_or_else(|| owner::Error::internal(FailureStage::Recover))?,
    )?;
    if step.run_id != *run
        || step.kind != STEP_KIND
        || step.ordinal != 0
        || step.input_digest != batch.input_digest()?
        || observed.input_digest()? != batch.input_digest()?
        || step
            .checkpoint
            .pointer("/basis/kind")
            .and_then(serde_json::Value::as_str)
            != Some("content_cleanup")
    {
        return Err(Error::material(MaterialFailure::CorruptContent).into());
    }
    Ok(step)
}
