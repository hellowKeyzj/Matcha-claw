use world_protocol::{
    commit::{CommitFailure, ConstraintCode},
    failure::FailureStage,
    identity::SubjectRef,
    ids::*,
    operation::{RetainedCount, RetainedKind},
    releases::BranchRef,
};

use super::{
    CommittedWorldMutation, RetentionRoots, StoreError, WorldTransaction,
    archive::conflict,
    retention::{RetentionSet, reference_error},
    schema,
};
use crate::{
    content::{Content, ContentOwner},
    extensions::lifecycle::{DrainedWorld, LiveExtensions},
};

fn invalid() -> StoreError {
    StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate)
}

impl WorldTransaction<'_> {
    /// Logical deletion never releases physical pins or rewrites the retained safety domains.
    pub(crate) async fn finish_world_deletion(
        &mut self,
        intent: &CommittedWorldMutation,
        live: &LiveExtensions,
        drained: &DrainedWorld,
        content: &Content,
    ) -> Result<(), StoreError> {
        self.require_exclusive_storage()?;
        self.require_world_mutation(intent, "deleting")?;
        if !live.validate_world_drained(drained)
            || drained.world() != self.world()
            || drained.commit_id() != intent.commit_id()
        {
            return Err(invalid());
        }
        let world = self.world().clone();
        let row = self.query_opt("SELECT generation,revision,status FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?.ok_or_else(invalid)?;
        if row.get::<_, String>("status") != "deleting"
            || row.get::<_, i64>("generation") as u64 != intent.operation().incarnation.0
            || row.get::<_, i64>("generation") == i64::MAX
            || row.get::<_, i64>("revision") > i64::MAX - 2
        {
            return Err(conflict(ConstraintCode::HeadGeneration));
        }
        let keep = RetentionSet::new(self).await?;
        seed_retained(&keep, self).await?;
        for owner in content
            .world_deletion_roots(self)
            .await
            .map_err(|error| match error {
                crate::content::Error::Store(error) => error,
                error => reference_error(error),
            })?
        {
            seed_content(&keep, self, owner).await?;
        }
        close_typed(&keep, self).await?;
        self.execute("UPDATE world_runtime_head SET mutation_xid=pg_current_xact_id(),revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?;
        keep.delete_unmarked(self).await?;
        self.execute("UPDATE world_runtime_head SET status='retained',generation=generation+1,revision=revision+1,mutation_xid=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()]).await?;
        Ok(())
    }

    /// Read again after the caller has settled the original operation and emitted its hints.
    pub(crate) async fn world_deletion_retained(
        &self,
        content: &Content,
    ) -> Result<Vec<RetainedCount>, StoreError> {
        self.require_exclusive_storage()?;
        if self.world_mutation.as_ref().is_none_or(|intent| {
            intent.kind != "deleting" || intent.final_commit_id() != self.commit_id()
        }) {
            return Err(invalid());
        }
        retained_counts(self, content).await
    }
}

async fn seed_retained(keep: &RetentionSet, tx: &WorldTransaction<'_>) -> Result<(), StoreError> {
    keep.roots(tx, crate::authorization::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::query::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::facts::support::world_deletion_roots(tx).await?).await?;
    keep.roots(tx, crate::sources::sync::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::facts::assertions::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::actions::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::owner::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::generation::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    keep.roots(tx, crate::evaluation::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    if !keep.restoring() {
        keep.roots(tx, crate::learning::world_deletion_roots(tx).await.map_err(reference_error)?).await?;
    }
    Ok(())
}

pub(super) async fn restore_retention(tx: &WorldTransaction<'_>) -> Result<RetentionSet, StoreError> {
    let keep = RetentionSet::for_restore(tx).await?;
    seed_retained(&keep, tx).await?;
    for owner in crate::content::world_deletion_roots(tx).await.map_err(reference_error)? {
        seed_content(&keep, tx, owner).await?;
    }
    close_typed(&keep, tx).await?;
    Ok(keep)
}

async fn seed_content(
    keep: &RetentionSet,
    tx: &WorldTransaction<'_>,
    owner: ContentOwner,
) -> Result<(), StoreError> {
    match owner {
        ContentOwner::SourceVersion { reference } => {
            keep.roots(
                tx,
                RetentionRoots {
                    source_versions: vec![reference],
                    ..Default::default()
                },
            )
            .await?;
        }
        ContentOwner::ParseArtifact { id } => {
            keep.seed(
                tx,
                "world_parse_artifact",
                "artifact_id=$3",
                &[&id.as_str()],
            )
            .await?;
        }
        ContentOwner::Evidence { id, revision } => {
            keep.roots(
                tx,
                RetentionRoots {
                    evidence: vec![EvidenceRef {
                        world: tx.world().clone(),
                        id,
                        revision,
                    }],
                    ..Default::default()
                },
            )
            .await?;
        }
        ContentOwner::Artifact { id } => {
            keep.seed(
                tx,
                "world_artifact_manifest",
                "artifact_id=$3",
                &[&id.as_str()],
            )
            .await?;
        }
        ContentOwner::Release { id } => {
            keep.seed(tx, "world_release", "release_id=$3", &[&id.as_str()])
                .await?;
        }
        ContentOwner::Branch { id } => {
            keep.seed(tx, "world_branch", "branch_id=$3", &[&id.as_str()])
                .await?;
        }
        // These owners are retained domains or physical-only custody, never archive business rows.
        ContentOwner::Run { .. }
        | ContentOwner::Evaluation { .. }
        | ContentOwner::Case { .. }
        | ContentOwner::TestCase { .. }
        | ContentOwner::Suite { .. }
        | ContentOwner::Attachment { .. }
        | ContentOwner::State { .. }
        | ContentOwner::Migration { .. }
        | ContentOwner::Upload { .. }
        | ContentOwner::Backup { .. } => {}
    }
    Ok(())
}

async fn close_typed(keep: &RetentionSet, tx: &WorldTransaction<'_>) -> Result<(), StoreError> {
    loop {
        keep.close_foreign_keys(tx).await?;
        let references_before = keep.definition_references();
        let before: i64 = tx
            .transaction
            .query_one("SELECT count(*) FROM pg_temp.world_delete_keep", &[])
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))?
            .get(0);
        let releases = keep
            .kept(tx, "world_release", "t.release_id")
            .await?
            .into_iter()
            .map(|row| ReleaseId::try_new(row.get::<_, String>(0)).map_err(|_| invalid()))
            .collect::<Result<Vec<_>, _>>()?;
        let branches = keep
            .kept(tx, "world_branch_revision", "t.branch_id,t.revision")
            .await?
            .into_iter()
            .map(|row| {
                Ok(BranchRef {
                    world: tx.world().clone(),
                    id: BranchId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                    revision: Revision(row.get::<_, i64>(1) as u64),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        release_roots(
            keep,
            tx,
            crate::releases::release_retention(tx, &releases, &branches)
                .await
                .map_err(reference_error)?,
        )
        .await?;
        keep.roots(
            tx,
            crate::identity::branch_identity_retention_roots(tx, &branches)
                .await
                .map_err(reference_error)?,
        )
        .await?;
        if keep.restoring() {
            let candidates = keep.kept(tx, "world_candidate_revision", "t.candidate_id,t.revision").await?
                .into_iter().map(|row| {
                    Ok((
                        CandidateId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                        Revision(row.get::<_, i64>(1) as u64),
                    ))
                }).collect::<Result<Vec<_>, StoreError>>()?;
            keep.roots(tx, crate::learning::candidate_revision_retention_roots(tx, &candidates)
                .await.map_err(reference_error)?).await?;
        }
        let mut branch_roots = RetentionRoots::default();
        for row in keep.kept(tx, "world_branch_derivation_revision", "t.body").await? {
            let record: crate::facts::assertions::BranchDerivationRecord =
                serde_json::from_value(row.get(0)).map_err(reference_error)?;
            crate::facts::assertions::branch_derivation_retention_roots(&record, &mut branch_roots);
        }
        keep.roots(tx, branch_roots).await?;
        let mut definitions = keep
            .kept(
                tx,
                "world_definition_revision",
                "t.definition_id,t.revision",
            )
            .await?
            .into_iter()
            .map(|row| {
                Ok(DefinitionRef {
                    world: tx.world().clone(),
                    id: DefinitionId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                    revision: Revision(row.get::<_, i64>(1) as u64),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        definitions.extend(keep.definition_references().0);
        definitions.sort();
        definitions.dedup();
        release_roots(
            keep,
            tx,
            crate::releases::definition_retention(tx, &definitions)
                .await
                .map_err(reference_error)?,
        )
        .await?;
        release_roots(
            keep,
            tx,
            crate::releases::definition_resource_retention(tx, &keep.definition_references().1)
                .await
                .map_err(reference_error)?,
        )
        .await?;
        let assertions = keep
            .kept(tx, "world_assertion_revision", "t.assertion_id,t.revision")
            .await?
            .into_iter()
            .map(|row| {
                Ok(AssertionRef {
                    world: tx.world().clone(),
                    id: AssertionId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                    revision: Revision(row.get::<_, i64>(1) as u64),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let evidence = keep
            .kept(tx, "world_evidence_revision", "t.evidence_id,t.revision")
            .await?
            .into_iter()
            .map(|row| {
                Ok(EvidenceRef {
                    world: tx.world().clone(),
                    id: EvidenceId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                    revision: Revision(row.get::<_, i64>(1) as u64),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        keep.roots(
            tx,
            crate::facts::assertions::retention_roots(tx, &assertions, &evidence)
                .await
                .map_err(reference_error)?,
        )
        .await?;
        let supports = keep
            .kept(tx, "world_support_revision", "t.support_id,t.revision")
            .await?
            .into_iter()
            .map(|row| {
                Ok(SupportRef {
                    world: tx.world().clone(),
                    id: SupportId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                    revision: Revision(row.get::<_, i64>(1) as u64),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        keep.roots(
            tx,
            crate::facts::support::support_retention(tx, &supports).await?,
        )
        .await?;
        let watches = keep
            .kept(tx, "world_watch", "t.watch_id")
            .await?
            .into_iter()
            .map(|row| WatchId::try_new(row.get::<_, String>(0)).map_err(|_| invalid()))
            .collect::<Result<Vec<_>, _>>()?;
        keep.roots(
            tx,
            crate::facts::support::watch_retention(tx, &watches).await?,
        )
        .await?;
        for row in keep
            .kept(
                tx,
                "world_explanation_revision",
                "t.conclusion_id,t.conclusion_revision,t.revision",
            )
            .await?
        {
            let conclusion = AssertionRef {
                world: tx.world().clone(),
                id: AssertionId::try_new(row.get::<_, String>(0)).map_err(|_| invalid())?,
                revision: Revision(row.get::<_, i64>(1) as u64),
            };
            keep.roots(
                tx,
                crate::facts::support::explanation_retention(
                    tx,
                    &conclusion,
                    Revision(row.get::<_, i64>(2) as u64),
                )
                .await?,
            )
            .await?;
        }
        let mut subjects = Vec::new();
        for (table, column, object) in [
            ("world_object_identity", "t.object_id,t.type_id", true),
            ("world_relation_identity", "t.relation_id,t.type_id", false),
        ] {
            for row in keep.kept(tx, table, column).await? {
                keep.roots(
                    tx,
                    RetentionRoots {
                        resources: vec![ResourceRef::Definition {
                            id: DefinitionId::try_new(row.get::<_, String>(1))
                                .map_err(|_| invalid())?,
                        }],
                        ..Default::default()
                    },
                )
                .await?;
                let id: String = row.get(0);
                subjects.push(if object {
                    SubjectRef::Object {
                        id: ObjectId::try_new(id).map_err(|_| invalid())?,
                    }
                } else {
                    SubjectRef::Relation {
                        id: RelationId::try_new(id).map_err(|_| invalid())?,
                    }
                });
            }
        }
        let aliases = keep
            .kept(tx, "world_alias_range", "t.range_digest")
            .await?
            .into_iter()
            .map(|row| Digest::try_new(row.get::<_, String>(0)).map_err(|_| invalid()))
            .collect::<Result<Vec<_>, _>>()?;
        keep.roots(
            tx,
            crate::identity::retention_roots(tx, &subjects, &aliases)
                .await
                .map_err(reference_error)?,
        )
        .await?;
        let after: i64 = tx
            .transaction
            .query_one("SELECT count(*) FROM pg_temp.world_delete_keep", &[])
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))?
            .get(0);
        if before == after && references_before == keep.definition_references() {
            return Ok(());
        }
    }
}

async fn release_roots(
    keep: &RetentionSet,
    tx: &WorldTransaction<'_>,
    refs: crate::releases::ReleaseRetention,
) -> Result<(), StoreError> {
    for id in refs.candidate_ids {
        keep.seed(tx, "world_candidate", "candidate_id=$3", &[&id.as_str()]).await?;
    }
    keep.roots(
        tx,
        RetentionRoots {
            scopes: refs.scopes,
            resources: refs.resources,
            definitions: refs.definitions,
            evidence: refs.evidence,
            dependencies: refs.dependencies,
            sources: refs.source_bases,
            releases: refs.release_ids,
            branches: refs.branch_refs,
            source_versions: refs.source_versions,
            parse_artifacts: refs.parse_artifacts,
            schemas: refs.schemas,
            mappings: refs.schema_mappings,
            ..Default::default()
        },
    )
    .await
}

async fn retained_counts(
    tx: &WorldTransaction<'_>,
    content: &Content,
) -> Result<Vec<RetainedCount>, StoreError> {
    use RetainedKind::*;
    let physical = content
        .world_retention_counts(tx)
        .await
        .map_err(|error| match error {
            crate::content::Error::Store(error) => error,
            error => reference_error(error),
        })?;
    let mut counts: Vec<RetainedCount> = [
        (ContentBlobs, physical.blobs),
        (ContentReferences, physical.references),
        (ContentHolds, physical.holds),
        (ContentPins, physical.pins),
    ]
    .into_iter()
    .filter(|(_, count)| *count != 0)
    .map(|(kind, count)| RetainedCount { kind, count })
    .collect();
    for table in schema::tables() {
        let kind = match table {
            "world_storage_head"
            | "world_writer_gate"
            | "world_outbox_counter"
            | "world_storage_transfer"
            | "world_runtime_head" => continue,
            "world_scope_revision" => Scopes,
            "world_release"
            | "world_release_head"
            | "world_release_head_history"
            | "world_release_definition"
            | "world_release_backfill" => Releases,
            "world_activation_lock" => ActivationLocks,
            "world_authority_head"
            | "world_extension_trust"
            | "world_package_trust_policy"
            | "world_package_grant_revision"
            | "world_package_grant_head"
            | "world_source_authority_revision"
            | "world_source_authority_head"
            | "world_source_authority_field"
            | "world_source_authority_role"
            | "world_source_branch_authority" => Authority,
            name if name.starts_with("world_auth_") => Authority,
            "world_operation"
            | "world_run"
            | "world_step"
            | "world_model_call"
            | "world_candidate_model_call"
            | "world_dirty_recompute"
            | "world_recompute_attempt"
            | "world_read_receipt" => Execution,
            "world_action_proposal"
            | "world_effect_intent"
            | "world_source_receipt"
            | "world_verification_receipt" => Effects,
            "world_commit_receipt" => CommitReceipts,
            "world_outbox" => OutboxEvents,
            "world_blob" | "world_content_reference" | "world_content_hold" | "world_blob_pin" => {
                continue;
            }
            "world_source_version" => SourceVersions,
            "world_parse_artifact" => ParseArtifacts,
            "world_package" | "world_package_install" | "world_package_gc" => PackageInventory,
            "world_package_retention" => PackageRetention,
            "world_extension_config_revision"
            | "world_extension_config_head"
            | "world_binding_head"
            | "world_binding_channel"
            | "world_state_root"
            | "world_state_namespace"
            | "world_state_activation_ref"
            | "world_extension_update"
            | "world_state_migration"
            | "world_activation_lifecycle" => ExtensionState,
            "world_archive_manifest" | "world_content_upload" | "world_content_upload_chunk" => {
                Archives
            }
            "world_restore_barrier" | "world_content_deletion" => DeletionBarriers,
            _ => BusinessFacts,
        };
        let row = tx
            .transaction
            .query_one(
                &format!("SELECT count(*) FROM public.{table} WHERE tenant_id=$1 AND world_id=$2"),
                &[
                    &tx.world().tenant_id.as_str(),
                    &tx.world().world_id.as_str(),
                ],
            )
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))?;
        let count = row.get::<_, i64>(0) as u64;
        if count == 0 {
            continue;
        }
        if let Some(previous) = counts.iter_mut().find(|previous| previous.kind == kind) {
            previous.count = previous.count.checked_add(count).ok_or_else(invalid)?;
        } else {
            counts.push(RetainedCount { kind, count });
        }
    }
    Ok(counts)
}
