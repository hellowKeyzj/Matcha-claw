use std::collections::BTreeSet;

use super::{BranchCapture, SyncError, VerifiedCandidateSources, branch_sources::check};
use crate::{
    authorization::Admission,
    content::Content,
    extensions::invocation::CallBudget,
    facts::{assertions, support},
    identity,
    sources::mapping,
    store::WorldTransaction,
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    facts::Assertion,
    identity::{AliasResolution, IdentityReceipt},
    ids::*,
    provenance::ReadDependency,
    sources::{MappingFailure, SourceBasis},
};

/// Runs after the immutable Release and its definition index are inserted, before the head CAS.
pub(crate) async fn promote_candidate_sources(
    tx: &mut WorldTransaction<'_>,
    content: &Content,
    admission: &Admission,
    verified: &VerifiedCandidateSources,
    release_id: &ReleaseId,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<Vec<SourceBasis>, SyncError> {
    super::require_writer(tx)?;
    check(budget, cancel)?;
    let expected = &verified.sources;
    let branch = crate::releases::read_branch_revision(tx, &expected.branch)
        .await
        .map_err(mapping::MappingError::from)?
        .ok_or_else(SyncError::protocol)?;
    let release = crate::releases::read_release(tx, release_id)
        .await
        .map_err(mapping::MappingError::from)?
        .ok_or_else(SyncError::protocol)?;
    let base = crate::releases::read_release(tx, &branch.basis.release_id)
        .await
        .map_err(mapping::MappingError::from)?
        .ok_or_else(SyncError::protocol)?;
    let mut dependencies = Vec::new();
    for dependency in branch
        .basis
        .read_receipts
        .iter()
        .flat_map(|receipt| &receipt.actual_dependencies)
    {
        if !dependencies.contains(dependency) {
            dependencies.push(dependency.clone());
        }
    }
    if release.world != *tx.world()
        || release.source_branch.as_ref() != Some(&expected.branch)
        || release.parent.as_ref() != Some(&base.id)
        || release.definitions != branch.compile.definitions
        || release.scopes != branch.compile.scopes
        || release.sources != branch.basis.sources
        || release.read_receipts != branch.basis.read_receipts
        || release.basis != dependencies
        || release.artifact.model_digest != super::branch_capture::model_digests(&branch)?.1
        || release.artifact.activation_lock_id != branch.basis.activation_lock_id
        || release.artifact.config_digest != branch.compile.config_digest
        || release.artifact.targets != branch.compile.targets
    {
        return Err(SyncError::protocol());
    }
    let affected = crate::releases::source_bindings(&release.definitions);
    if affected != expected.affected {
        return Err(SyncError::protocol());
    }
    let fresh =
        super::require_candidate_ready(tx, admission, &expected.branch, &affected, budget, cancel)
            .await?;
    if fresh.captures.len() != expected.captures.len()
        || fresh.captures.iter().zip(&expected.captures).any(|(a, b)| {
            a.dto != b.dto || a.raw != b.raw || a.version != b.version || a.plan != b.plan
        })
    {
        return Err(SyncError::protocol());
    }
    let impact = super::candidate_promotion_impact(tx, &branch, &affected).await?;
    admission.require_access(&impact)?;
    crate::authorization::recheck(tx, admission, &tx.now().await?).await?;
    let captures = &fresh.captures;
    let old = lock_ranges(tx, captures, budget, cancel).await?;
    let mut keys = BTreeSet::new();
    for capture in captures {
        for proposal in &capture.dto.proposals {
            keys.insert((
                proposal.key.source_id.clone(),
                proposal.key.namespace.clone(),
                proposal.key.native_key.clone(),
            ));
            for role in proposal
                .relations
                .iter()
                .flat_map(|relation| &relation.roles)
            {
                keys.insert((
                    role.target_source.clone(),
                    role.target_namespace.clone(),
                    role.native_key.clone(),
                ));
            }
        }
    }
    for (source, namespace, key) in &keys {
        check(budget, cancel)?;
        identity::lock_source_alias_range(tx, source, namespace, key).await?;
    }
    let mut before = Vec::new();
    for capture in captures {
        for proposal in &capture.dto.proposals {
            before.push(
                identity::resolve_in_transaction(
                    tx,
                    &proposal.key,
                    &capture.plan.binding_body.scope,
                )
                .await?,
            );
            for role in proposal
                .relations
                .iter()
                .flat_map(|relation| &relation.roles)
            {
                if let Some(receipt) = identity::resolve_native_key_transaction(
                    tx,
                    &role.target_source,
                    &role.target_namespace,
                    &role.native_key,
                    &capture.plan.binding_body.scope,
                    &capture.raw.valid_time,
                )
                .await?
                {
                    before.push(receipt);
                }
            }
        }
    }
    let mut subjects: BTreeSet<_> = old
        .iter()
        .flat_map(|assertion| assertions::claim_subjects(&assertion.claim))
        .collect();
    for receipt in &before {
        for dependency in &receipt.dependencies {
            if let ReadDependency::Identity { subject, .. } = dependency {
                subjects.insert(subject.clone());
            }
        }
    }
    identity::lock_influence(tx, &subjects.into_iter().collect::<Vec<_>>()).await?;
    let now = tx.now().await?;
    for capture in captures {
        check(budget, cancel)?;
        // The strict reader above reacquires Content's live blob gate after the physical preflight.
        mapping::promote_branch_binding(
            tx,
            admission,
            &capture.dto.branch,
            &expected.branch,
            &capture.dto.binding,
            release_id,
            &now,
        )
        .await?;
        for evidence in &capture.dto.evidence {
            if let Some(existing) = assertions::read_evidence(tx, &evidence.reference).await? {
                if existing != *evidence {
                    return Err(SyncError::protocol());
                }
            } else {
                assertions::append_evidence(
                    tx,
                    content,
                    None,
                    admission,
                    &capture.plan.binding_body.scope,
                    evidence,
                    budget,
                    cancel,
                )
                .await?;
            }
        }
    }
    for capture in captures {
        for proposal in &capture.dto.proposals {
            check(budget, cancel)?;
            let mut evidence: Vec<_> = proposal
                .fields
                .iter()
                .flat_map(|field| &field.evidence)
                .chain(
                    proposal
                        .relations
                        .iter()
                        .flat_map(|relation| &relation.evidence),
                )
                .cloned()
                .collect();
            evidence.sort();
            evidence.dedup();
            identity::promote_branch_identity(
                tx,
                admission,
                &capture.dto.branch,
                &proposal.type_ref,
                &proposal.key,
                &capture.plan.binding_body.scope,
                None,
                &evidence,
                &now,
                budget,
                cancel,
            )
            .await?;
        }
    }
    for capture in captures {
        check(budget, cancel)?;
        let assignment = super::partition::install_branch_capture(tx, admission, capture).await?;
        let run = RunId::try_new(capture.dto.digest.as_str().replace(':', "-"))
            .map_err(|_| SyncError::protocol())?;
        let input = super::inbox::capture_branch(tx, admission, &assignment, capture, &run).await?;
        let proof = super::snapshot::branch_complete(tx, &assignment, &run, capture).await?;
        let receipts = current_receipts(tx, capture).await?;
        let observations =
            super::branch_observation::prepare(tx, capture, receipts.clone(), budget, cancel)
                .await?;
        for index in 0..observations.len() {
            check(budget, cancel)?;
            let observation = observations
                .observation(index)
                .ok_or_else(SyncError::protocol)?;
            for assertion in
                assertions::admit_branch_observation(tx, admission, &observation, budget, cancel)
                    .await?
            {
                super::claims::record_branch(tx, &assignment, &observation, &assertion).await?;
            }
        }
        super::record_state::available(
            tx, admission, &assignment, &input, &input.input.rows.iter().collect::<Vec<_>>(), &capture.plan,
        ).await?;
        let w = tx.world();
        let missing = tx.query("SELECT DISTINCT c.native_key,c.record_incarnation FROM world_source_claim c WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4 AND c.binding_id=$6 AND c.namespace=$7 AND NOT EXISTS(SELECT 1 FROM world_source_snapshot_member m WHERE m.tenant_id=c.tenant_id AND m.world_id=c.world_id AND m.source_id=c.source_id AND m.partition_key=c.partition_key AND m.run_id=$5 AND m.native_key=c.native_key AND m.record_incarnation=c.record_incarnation) ORDER BY c.native_key,c.record_incarnation", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &run.as_str(), &assignment.binding.id.as_str(), &capture.plan.binding_body.namespace]).await?;
        for row in missing {
            check(budget, cancel)?;
            let retraction = super::claims::SourceRetraction::from_branch_snapshot(
                tx,
                &assignment,
                capture,
                proof.clone(),
                &row.get::<_, String>("native_key"),
                &row.get::<_, String>("record_incarnation"),
                &[],
            )
            .await?;
            super::claims::retract(tx, content, admission, &retraction, budget, cancel).await?;
        }
        super::inbox::apply_branch(tx, admission, &assignment, &input).await?;
        super::changed(tx.execute("UPDATE world_source_reconcile SET phase='complete',last_reconciled_at=$6::text::timestamptz WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND run_id=$5 AND phase='capturing'", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &run.as_str(), &now.as_str()]).await?, &assignment)?;
    }
    check(budget, cancel)?;
    Ok(fresh.bases())
}

async fn current_receipts(
    tx: &WorldTransaction<'_>,
    capture: &BranchCapture,
) -> Result<Vec<IdentityReceipt>, SyncError> {
    let mut receipts = Vec::new();
    for proposal in &capture.dto.proposals {
        let primary =
            identity::resolve_in_transaction(tx, &proposal.key, &capture.plan.binding_body.scope)
                .await?;
        if !matches!(&primary.resolution, AliasResolution::Existing { .. }) {
            return Err(MappingFailure::IdentityUnresolved.into());
        }
        if !receipts.contains(&primary) {
            receipts.push(primary);
        }
        for role in proposal
            .relations
            .iter()
            .flat_map(|relation| &relation.roles)
        {
            let receipt = identity::resolve_native_key_transaction(
                tx,
                &role.target_source,
                &role.target_namespace,
                &role.native_key,
                &capture.plan.binding_body.scope,
                &capture.raw.valid_time,
            )
            .await?
            .ok_or(MappingFailure::IdentityUnresolved)?;
            if !receipts.contains(&receipt) {
                receipts.push(receipt);
            }
        }
    }
    Ok(receipts)
}

async fn lock_ranges(
    tx: &WorldTransaction<'_>,
    captures: &[BranchCapture],
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<Vec<Assertion>, SyncError> {
    let mut datasets = BTreeSet::new();
    let mut partitions = BTreeSet::new();
    let mut old = Vec::new();
    for capture in captures {
        check(budget, cancel)?;
        let plan = &capture.plan;
        datasets.extend([plan.mapping.type_ref.id.clone(), plan.binding.id.clone()]);
        datasets.extend(
            plan.field_definitions
                .iter()
                .map(|definition| definition.reference.id.clone()),
        );
        datasets.extend(
            plan.relation_definitions
                .iter()
                .map(|definition| definition.reference.id.clone()),
        );
        partitions.insert(capture.raw.assignment.partition.clone());
        let w = tx.world();
        for row in tx.query("SELECT body FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND binding_id=$5", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &capture.dto.basis.source_id.as_str(), &capture.raw.assignment.partition, &capture.dto.binding.id.as_str()]).await? {
            old.push(super::decode::<Assertion>(row.get("body"))?);
        }
    }
    let claims = old
        .iter()
        .map(|assertion| (&assertion.claim, &assertion.origin))
        .collect::<Vec<_>>();
    let (actual, source_partitions) = support::assertion_ranges(tx, &claims).await?;
    datasets.extend(actual);
    partitions.extend(source_partitions);
    support::lock_ranges(
        tx,
        &datasets.into_iter().collect::<Vec<_>>(),
        &partitions.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    Ok(old)
}
