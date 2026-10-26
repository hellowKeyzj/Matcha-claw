use std::{io::Cursor, sync::Arc};
use crate::{
    authorization, content::{self, ContentOwner, ContentReference, PinKind},
    owner::ExecutionContext, sources::{connectors::SourceBroker, mapping}, store::{StoreFuture, TransactionError},
};
use world_protocol::{ids::*, materials::{SourceVersion, SourceVersionRef}, releases::BranchRef, sources::{BranchSourceCapture, SourceReadPlan}, time::ValidTime};
use super::{BranchCapture, SyncError, branch_capture::{self, RawBranchCapture}};

pub(crate) fn capture_branch<'a>(
    ctx: &'a ExecutionContext,
    branch: &'a BranchRef,
    binding: &'a DefinitionRef,
    broker: Arc<SourceBroker>,
) -> StoreFuture<'a, BranchCapture, SyncError> {
    Box::pin(async move {
        if branch.world != ctx.operation.world || binding.world != branch.world { return Err(SyncError::protocol()); }
        let branch = branch.clone(); let binding = binding.clone();
        let b = branch.clone(); let r = binding.clone();
        let prepared = ctx.transact(&format!("source.branch.prepare:{}:{}:{}:{}", branch.id, branch.revision.0, binding.id, binding.revision.0), crate::definitions::canonical_digest(&(&branch, &binding)).map_err(mapping::MappingError::from)?, &["sources"], move |tx, admission, _, run| Box::pin(async move {
            let result: StoreFuture<'_, _, SyncError> = Box::pin(async {
                let plan = mapping::compile_branch_binding(tx, &b, &r).await?;
                let model = crate::releases::read_branch_revision(tx, &b).await.map_err(mapping::MappingError::from)?.ok_or_else(SyncError::protocol)?;
                if run.activation_lock_id.as_ref() != Some(&model.compile.activation_lock.id) { return Err(SyncError::protocol()); }
                let now = tx.now().await?;
                let access = authorization::source_capture_policy(tx, &admission, &plan.binding_body.scope, &plan.binding_body.source_id, &plan.binding_body.retention, &now).await?;
                let digests = branch_capture::model_digests(&model)?;
                Ok((plan, access, digests))
            });
            result.await.map_err(crate::owner::Error::from)
        })).await?;
        let (plan, access, (compile_digest, model_digest)) = prepared.value;
        let b = branch.clone(); let r = binding.clone();
        if let Some(existing) = ctx.store.snapshot(branch.world.clone(), move |snapshot| Box::pin(async move { super::read_branch_capture_snapshot(snapshot, &b, &r).await })).await? {
            verify_branch_capture(&ctx.store, &ctx.resources.content, &ctx.admission, &existing, &ctx.budget, &ctx.cancellation).await?;
            return Ok(existing);
        }
        let read_plan = SourceReadPlan { binding: binding.clone(), resource: plan.binding_body.resource.clone(), row_symbol: SymbolId::try_new("source_row").map_err(|_| SyncError::protocol())?, fields: plan.binding_body.selected_fields.iter().map(ToString::to_string).collect(), predicate: None, order: Vec::new(), limit: world_protocol::api::MAX_PAGE_ITEMS, continuation: None, as_of: None };
        let mut carrier = broker.open_branch_snapshot(read_plan, &branch, &ctx.admission, &ctx.pipeline, ctx.cancellation.clone(), ctx.deadline, ctx.budget.clone()).await?;
        let read = carrier.collect_trusted(ctx.deadline).await?;
        if read.connection().id != plan.binding_body.connection_id || read.connection().revision != plan.binding_body.connection_revision { return Err(SyncError::protocol()); }
        let raw = RawBranchCapture { branch: branch.clone(), compile_digest, model_digest, plan_digest: plan.digest.clone(), page: read.page().clone(), valid_time: ValidTime { from: read.page().basis.observed_at.clone(), to: None }, budget: ctx.budget.limit(), assignment: broker.branch_assignment(&read, &plan)? };
        let bytes = branch_capture::raw_bytes(&raw)?;
        let hash = world_protocol::schema::hash(&bytes).map_err(|_| SyncError::protocol())?;
        let blob = Arc::new(ctx.resources.content.prepare_blob(&mut Cursor::new(&bytes), Some(&hash), &ctx.cancellation)?);
        let origin = crate::definitions::canonical_digest(&("world.source.origin.v1", &branch.world, &plan.binding_body.source_id)).map_err(mapping::MappingError::from)?;
        let version = SourceVersion { reference: SourceVersionRef { world: branch.world.clone(), source_id: plan.binding_body.source_id.clone(), version_id: SourceVersionId::try_new(hash.as_str().replace(':', "-")).map_err(|_| SyncError::protocol())? }, blob: blob.reference().clone(), media_type: "application/vnd.matcha.branch-source-records+json".into(), captured_at: raw.page.basis.captured_at.clone().unwrap_or_else(|| raw.page.basis.observed_at.clone()), supersedes: None, origin_family: OriginFamilyId::try_new(origin.as_str().replace(':', "-")).map_err(|_| SyncError::protocol())?, lineage: Vec::new(), access, retention: plan.binding_body.retention.clone() };
        let mapped = mapping::map_branch_records(&branch_capture::request(&raw, &plan, &version), &ctx.budget, &ctx.cancellation);
        let (proposals, evidence, failures) = match mapped {
            Ok(mapped) => mapped,
            Err(error) => { let error = SyncError::from(error); return Err(discard(ctx, &blob, error)); }
        };
        let input = crate::definitions::canonical_digest(&(&raw, &version)).map_err(mapping::MappingError::from)?;
        let key = format!("source.branch.capture:{}", hash);
        let request = match ctx.commit_request(&key, input, &["sources", "identity", "content"]).await { Ok(value) => value, Err(error) => return Err(discard(ctx, &blob, error.into())) };
        let staged = match ctx.resources.content.stage_commit(request.clone(), &[blob.as_ref()]) { Ok(value) => value, Err(error) => return Err(discard(ctx, &blob, error.into())) };
        let stage_digest = crate::definitions::canonical_digest(&staged).map_err(mapping::MappingError::from)?;
        let stage_request = ctx.commit_request(&format!("source.branch.stage:{}", hash), stage_digest, &[]).await?;
        let checkpoint = match ctx.transact_outcome(stage_request, move |_, _, _, _| Box::pin(async move { Ok(staged) })).await {
            Ok(committed) => committed,
            Err(TransactionError::NotCommitted { error, cleanup: None }) => return Err(discard(ctx, &blob, error.into())),
            Err(error) => return Err(crate::owner::Error::from(error).into()),
        };
        let input = Box::new((read, raw, plan, version));
        let content = ctx.resources.content.clone(); let budget = ctx.budget.clone(); let cancellation = ctx.cancellation.clone();
        let outcome = ctx.transact_outcome(request, move |tx, admission, _, _| Box::pin(async move {
            let (read, raw, plan, version) = &*input;
            let result: StoreFuture<'_, _, SyncError> = Box::pin(async {
                let now = tx.now().await?;
                read.recheck(tx, &admission, &now).await?;
                let current = mapping::compile_branch_binding(tx, &raw.branch, &plan.binding).await?;
                if current != *plan { return Err(SyncError::protocol()); }
                let model = crate::releases::read_branch_revision(tx, &raw.branch).await.map_err(mapping::MappingError::from)?.ok_or_else(SyncError::protocol)?;
                if branch_capture::model_digests(&model)? != (raw.compile_digest.clone(), raw.model_digest.clone()) { return Err(SyncError::protocol()); }
                authorization::require_material_policies(tx, &admission, &version.reference.source_id, &version.access, &version.retention, &now).await?;
                content.register_source_version(tx, &blob, version).await?;
                let mut proposals = proposals;
                let mut order: Vec<_> = (0..proposals.len()).collect();
                order.sort_by(|left, right| (&proposals[*left].key.native_key, &proposals[*left].key.incarnation).cmp(&(&proposals[*right].key.native_key, &proposals[*right].key.incarnation)));
                for index in order {
                    if cancellation.is_cancelled() { return Err(SyncError::from(world_protocol::sources::MappingFailure::Cancelled).into()); }
                    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|error| SyncError::from(world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension }))?;
                    let proposal = &mut proposals[index];
                    proposal.identity = Some(crate::identity::reserve_branch_identity(tx, &admission, &raw.branch, &proposal.type_ref, &proposal.key, &plan.binding_body.scope, &now).await?);
                }
                let mut dto = BranchSourceCapture { branch: raw.branch.clone(), compile_digest: raw.compile_digest.clone(), model_digest: raw.model_digest.clone(), binding: plan.binding.clone(), plan_digest: plan.digest.clone(), source_version: version.reference.clone(), basis: raw.page.basis.clone(), proposals, evidence, failures, complete: raw.page.complete, consistent: branch_capture::consistent(plan, &raw.page), digest: plan.digest.clone() };
                dto.digest = branch_capture::digest(&dto)?;
                branch_capture::insert(tx, &dto, raw).await?;
                Ok(dto)
            });
            result.await.map_err(crate::owner::Error::from)
        })).await;
        if !matches!(&outcome, Err(TransactionError::Indeterminate(_))) {
            if let Err(cleanup) = ctx.resources.content.discard_committed_stages(&ctx.store, &ctx.authority, &checkpoint).await {
                let error = match outcome {
                    Err(error) => SyncError::Owner(crate::owner::Error::from(error).with_related(cleanup.into())),
                    Ok(_) => SyncError::from(cleanup),
                };
                return Err(error);
            }
        }
        let committed = outcome.map_err(crate::owner::Error::from)?;
        ctx.recheck_replay(&committed).await?;
        let b = committed.value.branch.clone(); let r = committed.value.binding.clone();
        let capture = ctx.store.snapshot(branch.world.clone(), move |snapshot| Box::pin(async move { super::read_branch_capture_snapshot(snapshot, &b, &r).await?.ok_or_else(SyncError::protocol) })).await?;
        if capture.capture() != &committed.value { return Err(SyncError::protocol()); }
        verify_branch_capture(&ctx.store, &ctx.resources.content, &ctx.admission, &capture, &ctx.budget, &ctx.cancellation).await?;
        Ok(capture)
    })
}

fn discard(ctx: &ExecutionContext, blob: &content::PreparedBlob, error: SyncError) -> SyncError {
    match ctx.resources.content.discard_prepared(blob) {
        Ok(()) => error,
        Err(cleanup) => SyncError::Owner(crate::owner::Error::from(error).with_related(cleanup.into())),
    }
}

/// A confirmed Content pin precedes real filesystem reads, under this reader's own admission.
pub(crate) fn verify_branch_capture<'a>(
    store: &'a crate::store::WorldStore,
    content: &'a content::Content,
    admission: &'a authorization::Admission,
    capture: &'a BranchCapture,
    budget: &'a crate::extensions::invocation::CallBudget,
    cancellation: &'a tokio_util::sync::CancellationToken,
) -> StoreFuture<'a, (), SyncError> {
    Box::pin(async move {
        if cancellation.is_cancelled() { return Err(world_protocol::sources::MappingFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Bytes, capture.version.blob.byte_size).map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
        let current = capture.clone(); let admission = admission.clone();
        let nonce = uuid::Uuid::new_v4().to_string();
        let pin_id = ContentId::try_new(nonce.clone()).map_err(|_| SyncError::protocol())?;
        let input = crate::definitions::canonical_digest(&(capture.capture(), &pin_id)).map_err(mapping::MappingError::from)?;
        let request = read_request(store, &capture.dto.branch.world, &format!("pin-{nonce}"), input.clone()).await?;
        let pinned = store.transact(request.prepare()?, move |tx| Box::pin(async move {
            current.recheck(tx, &admission, &tx.now().await?).await?;
            let reference = ContentReference::new(ContentOwner::SourceVersion { reference: current.version.reference.clone() }, current.version.blob.clone())?;
            Ok::<_, SyncError>(content::pin(tx, &reference, pin_id, PinKind::Read).await?)
        })).await?;
        let read = content.read_pinned(store, &pinned).await.map_err(SyncError::from).and_then(|bytes| {
            if bytes != branch_capture::raw_bytes(&capture.raw)? { return Err(SyncError::protocol()); }
            if cancellation.is_cancelled() { return Err(world_protocol::sources::MappingFailure::Cancelled.into()); }
            budget.check().map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
            Ok(())
        });
        let release = async {
            let request = read_request(store, &capture.dto.branch.world, &format!("unpin-{nonce}"), input).await?;
            let pin = pinned.value;
            store.transact(request.prepare()?, move |tx| Box::pin(async move { Ok::<_, SyncError>(content::release_pin(tx, &pin).await?) })).await.map_err(SyncError::from)
        }.await;
        match (read, release) {
            (Ok(()), Ok(_)) => Ok(()),
            (Err(error), Ok(_)) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(SyncError::Owner(crate::owner::Error::from(error).with_related(cleanup.into()))),
        }
    })
}

async fn read_request(store: &crate::store::WorldStore, world: &WorldRef, key: &str, input_digest: Digest) -> Result<crate::store::CommitRequest, SyncError> {
    let (storage_epoch, fences) = store.snapshot(world.clone(), |snapshot| Box::pin(async move { crate::owner::writer_fences(snapshot, &["content"]).await })).await?;
    Ok(crate::store::CommitRequest { world: world.clone(), commit_id: CommitId::try_new(format!("source-branch-{key}")).map_err(|_| SyncError::protocol())?, input_digest, storage_epoch, fences, watch_basis: Vec::new() })
}
