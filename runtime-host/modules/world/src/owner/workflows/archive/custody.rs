use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

use serde::{Deserialize, Serialize};
use world_protocol::{
    api::{CommandResult, WorldCommand},
    failure::FailureStage,
    ids::{Digest, OperationId, RunId, WorldRef},
    operation::OperationReceipt,
};

use crate::{
    content::{PreparedBlob, StagedCommit},
    definitions::canonical_digest,
    extensions::{
        bindings::PreparedRestore,
        lifecycle::{DrainedWorld, WorldClosing},
    },
    owner::{Error, ExecutionContext, execution_commit_id},
    store::{CommitRequest, Committed, StoreFuture},
};

#[derive(Default)]
pub(crate) struct ArchiveWorkflows {
    execution: Mutex<BTreeMap<OperationId, Weak<tokio::sync::Mutex<()>>>>,
    pending: Mutex<BTreeMap<OperationId, Arc<tokio::sync::Mutex<Pending>>>>,
    backups: Mutex<BTreeMap<OperationId, Arc<BackupPending>>>,
}

pub(super) struct BackupPending {
    pub request: CommitRequest,
    pub prepared: Arc<PreparedBlob>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MutationPlan {
    pub command: WorldCommand,
    pub intent: CommitRequest,
    pub final_commit: CommitRequest,
    pub pin: Option<CommitRequest>,
    pub release: Option<CommitRequest>,
    pub archive: Option<Digest>,
}

pub(super) struct Pending {
    pub input: Digest,
    pub plan: MutationPlan,
    pub snapshot: Option<Arc<crate::store::ArchiveSnapshot>>,
    pub closing: Option<WorldClosing>,
    pub drained: Option<Arc<DrainedWorld>>,
    pub prepared: Option<Arc<PreparedRestore>>,
    pub completed: Option<Committed<OperationReceipt>>,
    pub published: bool,
}

impl ArchiveWorkflows {
    fn execution(&self, operation: &OperationId) -> Arc<tokio::sync::Mutex<()>> {
        let mut executions = self.execution.lock().expect("archive executions poisoned");
        executions.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = executions.get(operation).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        executions.insert(operation.clone(), Arc::downgrade(&lock));
        lock
    }

    pub(crate) fn has_pending(&self, operation: &OperationId) -> bool {
        self.pending
            .lock()
            .expect("archive custody poisoned")
            .contains_key(operation)
            || self.backup(operation).is_some()
    }

    pub(crate) fn has_any_pending(&self) -> bool {
        !self
            .pending
            .lock()
            .expect("archive custody poisoned")
            .is_empty()
            || !self
                .backups
                .lock()
                .expect("archive backup custody poisoned")
                .is_empty()
    }

    pub(super) fn backup(&self, operation: &OperationId) -> Option<Arc<BackupPending>> {
        self.backups
            .lock()
            .expect("archive backup custody poisoned")
            .get(operation)
            .cloned()
    }

    pub(super) fn hold_backup(
        &self,
        operation: OperationId,
        request: CommitRequest,
        prepared: Arc<PreparedBlob>,
    ) {
        self.backups
            .lock()
            .expect("archive backup custody poisoned")
            .insert(operation, Arc::new(BackupPending { request, prepared }));
    }

    pub(super) fn remove_backup(&self, operation: &OperationId) {
        self.backups
            .lock()
            .expect("archive backup custody poisoned")
            .remove(operation);
    }

    pub(super) fn pending(
        &self,
        ctx: &ExecutionContext,
        input: &Digest,
        plan: MutationPlan,
    ) -> Result<Arc<tokio::sync::Mutex<Pending>>, Error> {
        let mut pending = self.pending.lock().expect("archive custody poisoned");
        Ok(pending
            .entry(ctx.operation.operation_id.clone())
            .or_insert_with(|| {
                Arc::new(tokio::sync::Mutex::new(Pending {
                    input: input.clone(),
                    plan,
                    snapshot: None,
                    closing: None,
                    drained: None,
                    prepared: None,
                    completed: None,
                    published: false,
                }))
            })
            .clone())
    }

    pub(super) fn held(&self, operation: &OperationId) -> Option<Arc<tokio::sync::Mutex<Pending>>> {
        self.pending
            .lock()
            .expect("archive custody poisoned")
            .get(operation)
            .cloned()
    }

    pub(crate) async fn recover_committed(
        &self,
        store: &crate::store::WorldStore,
        resources: &Arc<crate::owner::resources::Resources>,
        authority: &crate::authorization::AuthorityRoot,
        world: &WorldRef,
        operation: &OperationId,
        run: &RunId,
    ) -> Result<(), Error> {
        let execution = self.execution(operation);
        let _execution = execution.lock().await;
        super::recovery::run(self, store, resources, authority, world, operation, run).await
    }

    pub(super) fn remove(&self, operation: &OperationId) {
        self.pending
            .lock()
            .expect("archive custody poisoned")
            .remove(operation);
    }

    pub(crate) fn run(
        self: Arc<Self>,
        ctx: ExecutionContext,
        command: WorldCommand,
    ) -> StoreFuture<'static, CommandResult, Error> {
        Box::pin(async move {
            let execution = self.execution(&ctx.operation.operation_id);
            let _execution = execution.lock().await;
            match command {
                WorldCommand::Backup(request) => super::backup::run(&self, &ctx, request).await,
                command @ (WorldCommand::Restore(_) | WorldCommand::DeleteWorld(_)) => {
                    super::mutation::run(&self, &ctx, command).await
                }
                _ => Err(Error::internal(FailureStage::Decode)),
            }
        })
    }
}

pub(crate) async fn resume_intent(
    store: &crate::store::WorldStore,
    authority: &crate::authorization::AuthorityRoot,
    world: &WorldRef,
    operation: &OperationId,
    run: &RunId,
    command: &WorldCommand,
) -> Result<Option<crate::store::CommittedWorldMutation>, Error> {
    if !matches!(
        command,
        WorldCommand::Restore(_) | WorldCommand::DeleteWorld(_)
    ) {
        return Ok(None);
    }
    let input = canonical_digest(command)?;
    let checkpoint = execution_commit_id(world, operation, run, "archive.mutation.prepare")?;
    let Some(committed) = store
        .read_commit_optional::<MutationPlan>(world, &checkpoint, &input)
        .await?
    else {
        return Ok(None);
    };
    let plan = committed.value;
    validate_identity(world, operation, run, command, &plan)?;
    let Some(intent) = store
        .read_commit_optional::<OperationReceipt>(world, &plan.intent.commit_id, &input)
        .await?
    else {
        return Ok(None);
    };
    if intent.value.accepted.world != *world
        || intent.value.accepted.operation_id != *operation
        || intent.value.progress.run_id.as_ref() != Some(run)
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    let proof = store.committed_world_mutation(authority, &intent).await?;
    if proof.world() != world
        || proof.operation() != &intent.value.accepted
        || proof.final_commit_id() != &plan.final_commit.commit_id
        || match (proof.restore(), plan.archive.as_ref()) {
            (Some(restore), Some(archive)) => restore.archive_digest() != archive,
            (None, None) => false,
            _ => true,
        }
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    Ok(Some(proof))
}

pub(super) async fn plan(
    ctx: &ExecutionContext,
    command: &WorldCommand,
    input: &Digest,
) -> Result<MutationPlan, Error> {
    let checkpoint_id = ctx.commit_id("archive.mutation.prepare")?;
    if let Some(committed) = ctx
        .store
        .read_commit_optional::<MutationPlan>(&ctx.operation.world, &checkpoint_id, input)
        .await?
    {
        validate_plan(ctx, command, &committed.value)?;
        return Ok(committed.value);
    }
    let restore = matches!(command, WorldCommand::Restore(_));
    let archive = match command {
        WorldCommand::Restore(request) => Some(
            ctx.store
                .sealed_archive(ctx.operation.world.clone(), &request.manifest)
                .await?,
        ),
        WorldCommand::DeleteWorld(_) => None,
        _ => return Err(Error::internal(FailureStage::Decode)),
    };
    let plan = MutationPlan {
        command: command.clone(),
        intent: ctx
            .commit_request("archive.mutation.intent", input.clone(), &["authorization"])
            .await?,
        final_commit: ctx
            .commit_request(
                "archive.mutation.final",
                input.clone(),
                &[
                    "authorization",
                    "content",
                    "packages",
                    "bindings",
                    "releases",
                ],
            )
            .await?,
        pin: if restore {
            Some(
                ctx.commit_request(
                    "archive.mutation.pin",
                    input.clone(),
                    &["authorization", "content"],
                )
                .await?,
            )
        } else {
            None
        },
        release: if restore {
            Some(
                ctx.commit_request("archive.mutation.release", input.clone(), &["content"])
                    .await?,
            )
        } else {
            None
        },
        archive,
    };
    validate_plan(ctx, command, &plan)?;
    let stored = plan.clone();
    let checkpoint = ctx
        .commit_request("archive.mutation.prepare", input.clone(), &[])
        .await?;
    let committed = ctx
        .transact_outcome(checkpoint, move |_, _, _, _| {
            Box::pin(async move { Ok(stored) })
        })
        .await?;
    validate_plan(ctx, command, &committed.value)?;
    Ok(committed.value)
}

pub(super) fn validate_plan(
    ctx: &ExecutionContext,
    command: &WorldCommand,
    plan: &MutationPlan,
) -> Result<(), Error> {
    validate_identity(
        &ctx.operation.world,
        &ctx.operation.operation_id,
        &ctx.run.id,
        command,
        plan,
    )
}

pub(super) fn validate_identity(
    world: &WorldRef,
    operation: &OperationId,
    run: &RunId,
    command: &WorldCommand,
    plan: &MutationPlan,
) -> Result<(), Error> {
    let restore = matches!(command, WorldCommand::Restore(_));
    if !matches!(
        command,
        WorldCommand::Restore(_) | WorldCommand::DeleteWorld(_)
    ) || &plan.command != command
        || plan.intent.input_digest != canonical_digest(command)?
        || plan.final_commit.input_digest != plan.intent.input_digest
        || plan.pin.is_some() != restore
        || plan.release.is_some() != restore
        || plan.archive.is_some() != restore
    {
        return Err(Error::internal(FailureStage::Recover));
    }
    for (request, key) in [
        (Some(&plan.intent), "archive.mutation.intent"),
        (Some(&plan.final_commit), "archive.mutation.final"),
        (plan.pin.as_ref(), "archive.mutation.pin"),
        (plan.release.as_ref(), "archive.mutation.release"),
    ] {
        if let Some(request) = request {
            if &request.world != world
                || request.commit_id != execution_commit_id(world, operation, run, key)?
                || request.input_digest != plan.intent.input_digest
            {
                return Err(Error::internal(FailureStage::Recover));
            }
            request.clone().prepare()?;
        }
    }
    Ok(())
}

pub(super) async fn current(ctx: &ExecutionContext) -> Result<(), Error> {
    let admission = ctx.admission.clone();
    ctx.store
        .snapshot(ctx.operation.world.clone(), move |snapshot| {
            Box::pin(async move {
                let now = snapshot.now().await?;
                crate::authorization::recheck_read(snapshot, &admission, &now).await?;
                crate::authorization::check_admitted_output_read(
                    snapshot,
                    &admission,
                    admission.impact(),
                    1,
                    &now,
                )
                .await?;
                Ok::<_, Error>(())
            })
        })
        .await
}

pub(super) async fn staged_checkpoint(
    ctx: &ExecutionContext,
    input: Digest,
    staged: StagedCommit,
) -> Result<Committed<StagedCommit>, Error> {
    ctx.transact("archive.backup.prepare", input, &[], move |_, _, _, _| {
        Box::pin(async move { Ok(staged) })
    })
    .await
}
