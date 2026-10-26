use super::{StorageIdentity, StoreError, StoreLimits, history_migration, postgres::Connection};
use sha2::{Digest as _, Sha256};
use world_protocol::{
    commit::{CommitFailure, InstallationFailure},
    failure::FailureStage,
};

const MIGRATIONS: &[(&str, &str)] = &[
    ("001_ledger", include_str!("migrations/001_ledger.sql")),
    ("002_content", include_str!("migrations/002_content.sql")),
    ("003_model", include_str!("migrations/003_model.sql")),
    ("004_facts", include_str!("migrations/004_facts.sql")),
    ("005_support", include_str!("migrations/005_support.sql")),
    (
        "006_extensions",
        include_str!("migrations/006_extensions.sql"),
    ),
    ("007_sources", include_str!("migrations/007_sources.sql")),
    (
        "008_authorization",
        include_str!("migrations/008_authorization.sql"),
    ),
    (
        "009_evaluation",
        include_str!("migrations/009_evaluation.sql"),
    ),
    ("010_release", include_str!("migrations/010_release.sql")),
    ("011_guards", include_str!("migrations/011_guards.sql")),
    ("012_control", include_str!("migrations/012_control.sql")),
    ("013_archive", include_str!("migrations/013_archive.sql")),
    (
        "014_restore_history",
        include_str!("migrations/014_restore_history.sql"),
    ),
    (
        "015_branch_derivation",
        include_str!("migrations/015_branch_derivation.sql"),
    ),
    (
        "016_evaluation_authority",
        include_str!("migrations/016_evaluation_authority.sql"),
    ),
];

pub(super) fn checksum(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(super) fn installation(reason: InstallationFailure) -> StoreError {
    StoreError::new(
        CommitFailure::Installation { reason },
        FailureStage::Prepare,
    )
}

/// Read-only classification. A marked store is still verified by `migrate` when opened.
pub(super) async fn inspect(client: &mut Connection, limits: &StoreLimits) -> Result<Option<String>, StoreError> {
    client.dirty = true;
    let tx = client.build_transaction().read_only(true).start().await.map_err(migration_error)?;
    tx.query_one("SELECT set_config('statement_timeout',$1,true),set_config('search_path','pg_catalog,public',true)",
        &[&limits.statement_timeout.as_millis().to_string()]).await.map_err(migration_error)?;
    let marker: bool = tx.query_one("SELECT to_regclass('public.world_storage_identity') IS NOT NULL", &[])
        .await.map_err(migration_error)?.get(0);
    let storage_id = if marker {
        let rows = tx.query("SELECT storage_id FROM public.world_storage_identity WHERE singleton", &[]).await.map_err(migration_error)?;
        if rows.len() != 1 { return Err(installation(InstallationFailure::StorageIdentityMismatch)); }
        let id: String = rows[0].get(0);
        if id.is_empty() || id.len() > 256 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) {
            return Err(installation(InstallationFailure::StorageIdentityMismatch));
        }
        Some(id)
    } else {
        let occupied: bool = tx.query_one("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)' AND c.relkind IN ('r','p','v','m','S','f'))", &[]).await.map_err(migration_error)?.get(0);
        if occupied { return Err(installation(InstallationFailure::StorageIdentityMismatch)); }
        None
    };
    tx.rollback().await.map_err(migration_error)?;
    client.dirty = false;
    Ok(storage_id)
}

pub(super) async fn migrate(
    client: &mut Connection,
    identity: &StorageIdentity,
    limits: &StoreLimits,
) -> Result<(), StoreError> {
    let (storage_id, configuration_token) = identity.values();
    if [storage_id, configuration_token]
        .iter()
        .any(|value| value.is_empty() || value.len() > 256 || value.chars().any(char::is_control))
    {
        return Err(installation(InstallationFailure::StorageIdentityMismatch));
    }
    let version: i32 = client
        .query_one("SELECT current_setting('server_version_num')::integer", &[])
        .await
        .map_err(migration_error)?
        .get(0);
    if version < 140000 {
        return Err(installation(InstallationFailure::UnsupportedVersion));
    }
    client.dirty = true;
    let tx = client.transaction().await.map_err(migration_error)?;
    tx.batch_execute("SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='15s'; SET LOCAL search_path=public;")
        .await.map_err(migration_error)?;
    // Schema-installation lock only. World business transactions never acquire it.
    tx.query_one("SELECT pg_advisory_xact_lock(8754830197241)", &[])
        .await
        .map_err(migration_error)?;
    let marker_exists: bool = tx
        .query_one(
            "SELECT to_regclass('public.world_storage_identity') IS NOT NULL",
            &[],
        )
        .await
        .map_err(migration_error)?
        .get(0);
    if marker_exists {
        let rows = tx
            .query(
                "SELECT storage_id FROM public.world_storage_identity WHERE singleton",
                &[],
            )
            .await
            .map_err(migration_error)?;
        if rows.len() != 1 || rows[0].get::<_, String>("storage_id") != storage_id {
            return Err(installation(InstallationFailure::StorageIdentityMismatch));
        }
    } else {
        if matches!(identity, StorageIdentity::Existing { .. }) {
            return Err(installation(InstallationFailure::StorageIdentityMismatch));
        }
        let occupied: bool = tx.query_one("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)' AND c.relkind IN ('r','p','v','m','S','f'))", &[]).await.map_err(migration_error)?.get(0);
        if occupied {
            return Err(installation(InstallationFailure::StorageIdentityMismatch));
        }
    }
    tx.batch_execute("CREATE TABLE IF NOT EXISTS world_schema_migration(version text PRIMARY KEY,digest text NOT NULL,installed_at timestamptz NOT NULL DEFAULT clock_timestamp())")
        .await.map_err(migration_error)?;
    let installed = tx
        .query(
            "SELECT version,digest FROM world_schema_migration ORDER BY version",
            &[],
        )
        .await
        .map_err(migration_error)?;
    if installed.len() > MIGRATIONS.len() {
        return Err(installation(InstallationFailure::SchemaMismatch));
    }
    for (index, (name, sql)) in MIGRATIONS.iter().enumerate() {
        let digest = checksum(sql.as_bytes());
        if let Some(row) = installed.get(index) {
            if row.get::<_, String>("version") != *name || row.get::<_, String>("digest") != digest
            {
                return Err(installation(InstallationFailure::SchemaMismatch));
            }
        } else {
            if *name == "014_restore_history" {
                let prepared = history_migration::prepare(&tx, limits, &tables_before(index)).await?;
                let (before, after) = sql
                    .split_once("-- world:restore-history-backfill")
                    .ok_or_else(|| installation(InstallationFailure::SchemaMismatch))?;
                tx.batch_execute(&format!("SET LOCAL search_path=public;\n{before}"))
                    .await.map_err(migration_error)?;
                history_migration::apply(&tx, limits, prepared).await?;
                tx.batch_execute(&format!("SET LOCAL search_path=public;\n{after}"))
                    .await.map_err(migration_error)?;
            } else {
                tx.batch_execute(sql).await.map_err(migration_error)?;
            }
            tx.execute(
                "INSERT INTO world_schema_migration(version,digest) VALUES($1,$2)",
                &[name, &digest],
            )
            .await
            .map_err(migration_error)?;
        }
    }
    // A reconnect with the same sealed schema does not take application table DDL locks.
    if installed.len() == MIGRATIONS.len() {
        tx.rollback().await.map_err(migration_error)?;
        client.dirty = false;
        return Ok(());
    }
    if !marker_exists {
        tx.execute(
            "INSERT INTO public.world_storage_identity(singleton,storage_id) VALUES(true,$1)",
            &[&storage_id],
        )
        .await
        .map_err(migration_error)?;
    }
    // All world table families have tenant/world columns; the database marker is not a world fact.
    for table in tables() {
        let policy = format!(
            "ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY; ALTER TABLE public.{table} FORCE ROW LEVEL SECURITY; \
             DROP POLICY IF EXISTS world_boundary ON public.{table}; \
             CREATE POLICY world_boundary ON public.{table} USING (tenant_id=current_setting('app.world_tenant',true) AND world_id=current_setting('app.world_id',true)) \
             WITH CHECK (tenant_id=current_setting('app.world_tenant',true) AND world_id=current_setting('app.world_id',true));"
        );
        tx.batch_execute(&policy).await.map_err(migration_error)?;
    }
    tx.batch_execute("DROP POLICY IF EXISTS world_catalog_read ON public.world_runtime_head; CREATE POLICY world_catalog_read ON public.world_runtime_head FOR SELECT USING (current_setting('app.world_catalog_read',true)='on')")
        .await.map_err(migration_error)?;
    // Exact FKs remain enforced at COMMIT, allowing mutually-referencing same-batch definitions.
    let constraints = tx.query(
        "SELECT c.conrelid::regclass::text AS tab,c.conname FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND c.contype='f' AND r.relname=ANY($1)",
        &[&tables()],
    ).await.map_err(migration_error)?;
    for row in constraints {
        let table: String = row.get("tab");
        let constraint: String = row.get("conname");
        tx.batch_execute(&format!(
            "ALTER TABLE {table} ALTER CONSTRAINT \"{}\" DEFERRABLE INITIALLY DEFERRED",
            constraint.replace('"', "\"\"")
        ))
        .await
        .map_err(migration_error)?;
    }
    tx.commit().await.map_err(migration_error)?;
    client.dirty = false;
    Ok(())
}

/// Names come exclusively from checked-in DDL, not callers or catalog discoveries.
pub(super) fn tables() -> Vec<&'static str> {
    tables_before(MIGRATIONS.len())
}
fn tables_before(migration: usize) -> Vec<&'static str> {
    MIGRATIONS[..migration]
        .iter()
        .flat_map(|(_, sql)| sql.lines())
        .filter_map(|line| {
            line.strip_prefix("CREATE TABLE ")
                .and_then(|rest| rest.strip_suffix(" ("))
        })
        .filter(|table| *table != "world_storage_identity")
        .collect()
}
pub(super) fn fingerprint() -> String {
    checksum(
        MIGRATIONS
            .iter()
            .flat_map(|(_, sql)| sql.as_bytes().iter().copied())
            .collect::<Vec<_>>()
            .as_slice(),
    )
}
fn migration_error(error: tokio_postgres::Error) -> StoreError {
    use tokio_postgres::error::SqlState;
    let reason = match error.code() {
        Some(&SqlState::INSUFFICIENT_PRIVILEGE) => Some(InstallationFailure::PermissionDenied),
        Some(&SqlState::UNDEFINED_FILE | &SqlState::FEATURE_NOT_SUPPORTED) => {
            Some(InstallationFailure::ExtensionUnavailable)
        }
        _ => None,
    };
    match reason {
        Some(reason) => StoreError::caused_by(
            CommitFailure::Installation { reason },
            FailureStage::Prepare,
            error,
        ),
        None => StoreError::database(error, FailureStage::Prepare),
    }
}
