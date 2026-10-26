use serde::{Deserialize, Serialize};
use world_protocol::ids::{Digest, OperationId, RunId};

use super::{Outcome, PackageCleanupBatch, invalid};
use crate::{
    owner::{self, StepRecord},
    store::{CommitRequest, WorldSnapshot, WorldTransaction},
};

pub(super) const STEP_KIND: &str = "maintenance.package_cleanup";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageCleanupCheckpoint {
    pub(super) entries: Vec<Entry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    pub package: Digest,
    pub token: String,
    pub generation: i64,
    pub operation: OperationId,
    pub run: RunId,
    pub claim: CommitRequest,
    pub pending: CommitRequest,
    pub finish: CommitRequest,
    pub started: bool,
    pub outcome: Option<Outcome>,
}

impl PackageCleanupCheckpoint {
    pub(crate) fn validate(&self, batch: &PackageCleanupBatch) -> Result<(), owner::Error> {
        batch.validate()?;
        if self.entries.len() > 32 {
            return Err(invalid());
        }
        for (index, entry) in self.entries.iter().enumerate() {
            if entry.token.is_empty()
                || entry.token.len() > 128
                || entry.token.chars().any(char::is_control)
                || self.entries[..index]
                    .iter()
                    .any(|previous| previous.package == entry.package)
                || !batch.candidates.iter().any(|candidate| {
                    candidate.package == entry.package && candidate.generation == entry.generation
                })
                || (entry.outcome.is_some() && !entry.started)
            {
                return Err(invalid());
            }
            for (stage, request) in [
                ("claim", &entry.claim),
                ("pending", &entry.pending),
                ("finish", &entry.finish),
            ] {
                let key = format!("package.cleanup.{}.{stage}", entry.package);
                if request.world != *batch.world()
                    || request.commit_id
                        != crate::owner::execution_commit_id(
                            batch.world(),
                            &entry.operation,
                            &entry.run,
                            &key,
                        )?
                    || request.input_digest != entry.input_digest(batch)?
                    || !["packages", "operation"].iter().all(|domain| {
                        request
                            .fences
                            .iter()
                            .any(|fence| fence.domain.as_str() == *domain)
                    })
                    || request
                        .fences
                        .iter()
                        .any(|fence| fence.world != *batch.world())
                {
                    return Err(invalid());
                }
                request.clone().prepare()?;
            }
        }
        Ok(())
    }
}

impl Entry {
    pub(super) fn input_digest(&self, batch: &PackageCleanupBatch) -> Result<Digest, owner::Error> {
        let candidate = batch
            .candidates
            .iter()
            .find(|candidate| candidate.package == self.package)
            .ok_or_else(invalid)?;
        Ok(crate::definitions::canonical_digest(&(
            batch.world(),
            candidate,
            &self.token,
        ))?)
    }
}

pub(super) async fn record(
    tx: &WorldTransaction<'_>,
    run: &RunId,
    batch: &PackageCleanupBatch,
    entry: Entry,
) -> Result<(), owner::Error> {
    let step = read_step(tx, run, batch).await?;
    let mut next = step.clone();
    let mut checkpoint = decode_checkpoint(&next)?;
    if let Some(previous) = checkpoint
        .entries
        .iter_mut()
        .find(|previous| previous.package == entry.package)
    {
        if previous.token != entry.token
            || previous.generation != entry.generation
            || previous.operation != entry.operation
            || previous.run != entry.run
            || serde_json::to_value((&previous.claim, &previous.pending, &previous.finish))
                .map_err(invalid_json)?
                != serde_json::to_value((&entry.claim, &entry.pending, &entry.finish))
                    .map_err(invalid_json)?
            || (previous.started && !entry.started)
            || (previous.outcome.is_some() && previous.outcome != entry.outcome)
        {
            return Err(invalid());
        }
        *previous = entry;
    } else {
        checkpoint.entries.push(entry);
    }
    checkpoint.validate(batch)?;
    next.checkpoint.as_object_mut().ok_or_else(invalid)?.insert(
        "packageCleanup".into(),
        serde_json::to_value(checkpoint).map_err(invalid_json)?,
    );
    owner::checkpoint_step(tx, &step, next).await?;
    Ok(())
}

pub(super) async fn recover(
    ctx: &owner::ExecutionContext,
    batch: &PackageCleanupBatch,
) -> Result<Vec<Entry>, owner::Error> {
    let run = ctx.run.id.clone();
    let batch = batch.clone();
    ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
        let world = snapshot.world();
        let row = snapshot.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND ordinal=0 AND kind=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.as_str(), &STEP_KIND]).await?.ok_or_else(invalid)?;
        let step: StepRecord = serde_json::from_value(row.get("body")).map_err(invalid_json)?;
        validate_step(&step, &run, &batch)?;
        let checkpoint = decode_checkpoint(&step)?;
        checkpoint.validate(&batch)?;
        Ok(checkpoint.entries)
    })).await
}

pub(super) async fn previous(
    snapshot: &WorldSnapshot<'_>,
    batch: &PackageCleanupBatch,
    package: &Digest,
) -> Result<Option<Entry>, owner::Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt("SELECT s.body FROM world_step s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.body#>'{checkpoint,packageCleanup,entries}','[]'::jsonb)) entry WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.kind=$3 AND entry->>'package'=$4 AND (entry->>'generation')::bigint=$5 ORDER BY (SELECT r.created_at FROM world_run r WHERE r.tenant_id=s.tenant_id AND r.world_id=s.world_id AND r.run_id=s.run_id) DESC,s.run_id,s.step_id LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &STEP_KIND, &package.as_str(), &batch.candidates.iter().find(|candidate| &candidate.package == package).ok_or_else(invalid)?.generation]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let step: StepRecord = serde_json::from_value(row.get("body")).map_err(invalid_json)?;
    let observed: PackageCleanupBatch = serde_json::from_value(
        step.checkpoint
            .pointer("/basis/batch")
            .cloned()
            .ok_or_else(invalid)?,
    )
    .map_err(invalid_json)?;
    validate_step(&step, &step.run_id, &observed)?;
    let checkpoint = decode_checkpoint(&step)?;
    checkpoint.validate(&observed)?;
    Ok(checkpoint
        .entries
        .into_iter()
        .find(|entry| &entry.package == package))
}

async fn read_step(
    tx: &WorldTransaction<'_>,
    run: &RunId,
    batch: &PackageCleanupBatch,
) -> Result<StepRecord, owner::Error> {
    let world = tx.world();
    let row = tx.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND ordinal=0 AND kind=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &run.as_str(), &STEP_KIND]).await?.ok_or_else(invalid)?;
    let step: StepRecord = serde_json::from_value(row.get("body")).map_err(invalid_json)?;
    validate_step(&step, run, batch)?;
    Ok(step)
}

fn validate_step(
    step: &StepRecord,
    run: &RunId,
    batch: &PackageCleanupBatch,
) -> Result<(), owner::Error> {
    let observed: PackageCleanupBatch = serde_json::from_value(
        step.checkpoint
            .pointer("/basis/batch")
            .cloned()
            .ok_or_else(invalid)?,
    )
    .map_err(invalid_json)?;
    if step.run_id != *run
        || step.kind != STEP_KIND
        || step.ordinal != 0
        || step.input_digest != batch.input_digest()?
        || observed.input_digest()? != batch.input_digest()?
        || step
            .checkpoint
            .pointer("/basis/kind")
            .and_then(serde_json::Value::as_str)
            != Some("package_cleanup")
    {
        return Err(invalid());
    }
    Ok(())
}

fn decode_checkpoint(step: &StepRecord) -> Result<PackageCleanupCheckpoint, owner::Error> {
    step.checkpoint
        .get("packageCleanup")
        .cloned()
        .filter(|value| !value.is_null())
        .map(serde_json::from_value)
        .transpose()
        .map_err(invalid_json)
        .map(Option::unwrap_or_default)
}

fn invalid_json(cause: serde_json::Error) -> owner::Error {
    invalid().caused(cause)
}
