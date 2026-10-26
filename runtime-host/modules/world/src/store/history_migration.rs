use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use tokio_postgres::{Row, Transaction, types::ToSql};
use world_protocol::{
    commit::{CommitFailure, ConstraintCode},
    failure::FailureStage,
    ids::{CandidateId, ChangeSetId, Revision, RunId, TenantId, WorldId, WorldRef},
    releases::BranchRef,
};

use super::{StoreError, StoreLimits, postgres, retention::reference_error};

/// Borrowed read access to one world's original rows in the schema-installation transaction.
/// It cannot start another transaction or mutate migration evidence.
pub(crate) struct WorldMigrationRead<'a, 'connection> {
    pub(super) transaction: &'a Transaction<'connection>,
    pub(super) world: WorldRef,
}

impl WorldMigrationRead<'_, '_> {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }

    pub(crate) async fn query(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, StoreError> {
        self.transaction
            .query(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Prepare))
    }

    pub(crate) async fn query_opt(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, StoreError> {
        self.transaction
            .query_opt(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Prepare))
    }
}

pub(crate) struct RunBranchMigration {
    pub id: RunId,
    pub branch: BranchRef,
}

pub(crate) struct ChangeBranchMigration {
    pub id: ChangeSetId,
    pub revision: Revision,
    pub branch: BranchRef,
}

pub(crate) struct CandidateChangeMigration {
    pub id: CandidateId,
    pub change_set_id: ChangeSetId,
    pub revision: Revision,
}

/// Complete exact references proved from the original per-world owner records, never current heads.
pub(crate) struct RestoreHistoryMigration {
    pub runs: Vec<RunBranchMigration>,
    pub changes: Vec<ChangeBranchMigration>,
    pub candidates: Vec<CandidateChangeMigration>,
}

pub(super) struct PreparedWorld {
    world: WorldRef,
    source_digest: String,
    proof: RestoreHistoryMigration,
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::caused_by(
        CommitFailure::ConstraintConflict {
            constraint: ConstraintCode::ForeignReference,
        },
        FailureStage::Prepare,
        std::io::Error::new(std::io::ErrorKind::InvalidData, message),
    )
}

pub(super) async fn prepare(
    transaction: &Transaction<'_>,
    limits: &StoreLimits,
    original_tables: &[&str],
) -> Result<Vec<PreparedWorld>, StoreError> {
    // The installation lock and these table locks keep every original proof row stable through DDL.
    let old_tables: Vec<_> = original_tables
        .iter()
        .map(|name| format!("public.{name}"))
        .collect();
    transaction
        .batch_execute(&format!("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE", old_tables.join(",")))
        .await
        .map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
    transaction
        .query_one("SELECT set_config('app.world_catalog_read','on',true)", &[])
        .await
        .map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
    let rows = transaction
        .query("SELECT tenant_id,world_id FROM world_runtime_head ORDER BY tenant_id,world_id", &[])
        .await
        .map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
    transaction
        .query_one("SELECT set_config('app.world_catalog_read','off',true)", &[])
        .await
        .map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
    let mut prepared = Vec::new();
    for row in rows {
        let world = WorldRef {
            tenant_id: TenantId::try_new(row.get::<_, String>("tenant_id")).map_err(|_| invalid("invalid migration tenant"))?,
            world_id: WorldId::try_new(row.get::<_, String>("world_id")).map_err(|_| invalid("invalid migration world"))?,
        };
        postgres::configure(transaction, &world, limits).await?;
        let read = WorldMigrationRead { transaction, world: world.clone() };
        let source_digest = source_digest(&read).await?;
        let proof = crate::owner::restore_history_migration(&read).await.map_err(|cause| {
            let mut error = reference_error(cause);
            error.stage = FailureStage::Prepare;
            error
        })?;
        validate_proof(&read, &proof).await?;
        prepared.push(PreparedWorld { world, source_digest, proof });
    }
    Ok(prepared)
}

async fn source_digest(read: &WorldMigrationRead<'_, '_>) -> Result<String, StoreError> {
    use sha2::{Digest as _, Sha256};
    let mut digest = Sha256::new();
    for table in [
        "world_branch", "world_branch_revision", "world_change_set", "world_candidate", "world_run",
        "world_operation", "world_step", "world_commit_receipt", "world_outbox",
    ] {
        digest.update(table.as_bytes());
        let row = if matches!(table, "world_run" | "world_change_set") {
            "(to_jsonb(t)-'branch_revision')"
        } else {
            "to_jsonb(t)"
        };
        let sql = format!("SELECT {row} FROM public.{table} t WHERE tenant_id=$1 AND world_id=$2 ORDER BY {row}::text COLLATE \"C\" LIMIT 256 OFFSET $3");
        let mut offset = 0i64;
        loop {
            let rows = read.transaction.query(&sql, &[&read.world.tenant_id.as_str(), &read.world.world_id.as_str(), &offset])
                .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
            let count = rows.len();
            for row in rows {
                let bytes = serde_json::to_vec(&row.get::<_, Value>(0)).map_err(|_| invalid("invalid migration row"))?;
                digest.update((bytes.len() as u64).to_be_bytes());
                digest.update(bytes);
            }
            if count < 256 { break; }
            offset += count as i64;
        }
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

async fn validate_proof(
    read: &WorldMigrationRead<'_, '_>,
    proof: &RestoreHistoryMigration,
) -> Result<(), StoreError> {
    let tenant = read.world.tenant_id.as_str();
    let world = read.world.world_id.as_str();
    if read.query_opt("SELECT 1 FROM world_branch b LEFT JOIN world_branch_revision r USING(tenant_id,world_id,branch_id,revision) WHERE b.tenant_id=$1 AND b.world_id=$2 AND (r.branch_id IS NULL OR (b.base_release_id,b.activation_lock_id,b.basis_digest,b.status,b.body) IS DISTINCT FROM (r.base_release_id,r.activation_lock_id,r.basis_digest,r.status,r.body)) LIMIT 1", &[&tenant, &world]).await?.is_some() {
        return Err(invalid("branch current row lacks its exact immutable revision"));
    }
    let runs: BTreeMap<_, _> = read.query("SELECT run_id,branch_id FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND branch_id IS NOT NULL", &[&tenant, &world]).await?
        .into_iter().map(|row| (row.get::<_, String>(0), row.get::<_, String>(1))).collect();
    let changes: BTreeMap<_, _> = read.query("SELECT change_set_id,revision,branch_id FROM world_change_set WHERE tenant_id=$1 AND world_id=$2", &[&tenant, &world]).await?
        .into_iter().map(|row| ((row.get::<_, String>(0), row.get::<_, i64>(1)), row.get::<_, String>(2))).collect();
    let candidates: BTreeMap<_, _> = read.query("SELECT candidate_id,revision,branch_id FROM world_candidate WHERE tenant_id=$1 AND world_id=$2", &[&tenant, &world]).await?
        .into_iter().map(|row| (row.get::<_, String>(0), (row.get::<_, i64>(1), row.get::<_, String>(2)))).collect();
    let mut seen_runs = BTreeSet::new();
    for run in &proof.runs {
        if !seen_runs.insert(run.id.as_str()) || runs.get(run.id.as_str()).map(String::as_str) != Some(run.branch.id.as_str()) {
            return Err(invalid("run branch proof coverage mismatch"));
        }
        exact_branch(read, &run.branch).await?;
    }
    let mut seen_changes = BTreeSet::new();
    for change in &proof.changes {
        let revision = i64::try_from(change.revision.0).map_err(|_| invalid("invalid change revision"))?;
        let key = (change.id.to_string(), revision);
        if revision <= 0 || !seen_changes.insert(key.clone()) || changes.get(&key).map(String::as_str) != Some(change.branch.id.as_str()) {
            return Err(invalid("change set branch proof coverage mismatch"));
        }
        exact_branch(read, &change.branch).await?;
    }
    let mut seen_candidates = BTreeSet::new();
    for candidate in &proof.candidates {
        let revision = i64::try_from(candidate.revision.0).map_err(|_| invalid("invalid candidate revision"))?;
        let change = changes.get(&(candidate.change_set_id.to_string(), revision));
        if !seen_candidates.insert(candidate.id.as_str()) || candidates.get(candidate.id.as_str()).is_none_or(|(old_revision, branch)| *old_revision != revision || Some(branch) != change) {
            return Err(invalid("candidate change set proof coverage mismatch"));
        }
    }
    if seen_runs.len() != runs.len() || seen_changes.len() != changes.len() || seen_candidates.len() != candidates.len() {
        return Err(invalid("incomplete restore history migration proof"));
    }
    Ok(())
}

async fn exact_branch(read: &WorldMigrationRead<'_, '_>, branch: &BranchRef) -> Result<(), StoreError> {
    let revision = i64::try_from(branch.revision.0).map_err(|_| invalid("invalid branch revision"))?;
    if branch.world != read.world || revision <= 0 || read.query_opt(
        "SELECT 1 FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND revision=$4",
        &[&read.world.tenant_id.as_str(), &read.world.world_id.as_str(), &branch.id.as_str(), &revision],
    ).await?.is_none() {
        return Err(invalid("migration proof lacks exact branch revision"));
    }
    Ok(())
}

pub(super) async fn apply(
    transaction: &Transaction<'_>,
    limits: &StoreLimits,
    prepared: Vec<PreparedWorld>,
) -> Result<(), StoreError> {
    for prepared in prepared {
        postgres::configure(transaction, &prepared.world, limits).await?;
        let read = WorldMigrationRead { transaction, world: prepared.world };
        // The two added nullable columns are not part of the original-row digest.
        if source_digest(&read).await? != prepared.source_digest {
            return Err(invalid("migration source rows changed after proof"));
        }
        validate_proof(&read, &prepared.proof).await?;
        let tenant = read.world.tenant_id.as_str();
        let world = read.world.world_id.as_str();
        for run in prepared.proof.runs {
            let revision = run.branch.revision.0 as i64;
            transaction.execute("UPDATE world_run SET branch_revision=$4,body=jsonb_set(body,'{branchRevision}',to_jsonb($4::bigint),true) WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3", &[&tenant, &world, &run.id.as_str(), &revision])
                .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
        }
        transaction.execute("UPDATE world_run SET body=jsonb_set(body,'{branchRevision}','null'::jsonb,true) WHERE tenant_id=$1 AND world_id=$2 AND branch_id IS NULL", &[&tenant, &world])
            .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
        for change in prepared.proof.changes {
            transaction.execute("UPDATE world_change_set SET branch_revision=$5 WHERE tenant_id=$1 AND world_id=$2 AND change_set_id=$3 AND revision=$4", &[&tenant, &world, &change.id.as_str(), &(change.revision.0 as i64), &(change.branch.revision.0 as i64)])
                .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
        }
        for candidate in prepared.proof.candidates {
            transaction.execute("INSERT INTO world_candidate_revision(tenant_id,world_id,candidate_id,revision,task_id,task_revision,change_set_id,content_digest,status,body) SELECT tenant_id,world_id,candidate_id,revision,task_id,task_revision,$4,content_digest,status,body FROM world_candidate WHERE tenant_id=$1 AND world_id=$2 AND candidate_id=$3", &[&tenant, &world, &candidate.id.as_str(), &candidate.change_set_id.as_str()])
                .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
        }
        transaction.execute("INSERT INTO world_branch_head(tenant_id,world_id,branch_id,revision) SELECT tenant_id,world_id,branch_id,revision FROM world_branch WHERE tenant_id=$1 AND world_id=$2", &[&tenant, &world])
            .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
        transaction.execute("INSERT INTO world_candidate_head(tenant_id,world_id,candidate_id,revision) SELECT tenant_id,world_id,candidate_id,revision FROM world_candidate WHERE tenant_id=$1 AND world_id=$2", &[&tenant, &world])
            .await.map_err(|error| StoreError::database(error, FailureStage::Prepare))?;
    }
    Ok(())
}
