use super::{
    StoreError, WorldTransaction,
    archive::{ArchiveSnapshot, conflict, history_table},
    retention::RetentionSet,
};
use world_protocol::{commit::ConstraintCode, failure::FailureStage};

pub(super) async fn retain(
    snapshot: &ArchiveSnapshot,
    tx: &WorldTransaction<'_>,
) -> Result<RetentionSet, StoreError> {
    let keep = super::world_deletion::restore_retention(tx).await?;
    for table in &keep.names {
        let rows = serde_json::to_value(snapshot.rows(table)).map_err(|_| conflict(ConstraintCode::ForeignReference))?;
        let sql = if history_table(table) {
            let keys = tx.transaction.query_one(
                "SELECT string_agg(format('s.%I=a.%I',a.attname,a.attname),' AND ' ORDER BY k.ordinality) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.contype='p' AND c.conrelid=to_regclass($1)",
                &[&format!("public.{table}")],
            ).await.map_err(|error| StoreError::database(error, FailureStage::Validate))?.get::<_, Option<String>>(0)
                .ok_or_else(|| conflict(ConstraintCode::ForeignReference))?;
            format!("SELECT EXISTS(SELECT 1 FROM public.{table} s JOIN jsonb_populate_recordset(NULL::public.{table},$3) a ON {keys} WHERE s.tenant_id=$1 AND s.world_id=$2 AND to_jsonb(s)<>to_jsonb(a))")
        } else {
            // A marked mutable dependency must already be exactly present in A, never copied from B.
            format!("SELECT EXISTS(SELECT 1 FROM public.{table} s JOIN pg_temp.world_delete_keep k ON k.table_name='{table}' AND k.row_id=s.ctid WHERE s.tenant_id=$1 AND s.world_id=$2 AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.{table},$3) a WHERE to_jsonb(s)=to_jsonb(a)))")
        };
        let invalid: bool = tx.transaction.query_one(&sql, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &rows])
            .await.map_err(|error| StoreError::database(error, FailureStage::Validate))?.get(0);
        if invalid {
            return Err(conflict(ConstraintCode::ForeignReference));
        }
    }
    Ok(keep)
}

pub(super) async fn delete_replaced(
    snapshot: &ArchiveSnapshot,
    tx: &WorldTransaction<'_>,
) -> Result<(), StoreError> {
    for table in snapshot.tables.iter().rev() {
        if matches!(table.table.as_str(), "world_source_version" | "world_parse_artifact") {
            continue;
        }
        let predicate = if history_table(&table.table) {
            format!(" AND NOT EXISTS(SELECT 1 FROM pg_temp.world_delete_keep k WHERE k.table_name='{}' AND k.row_id=t.ctid)", table.table)
        } else {
            String::new()
        };
        tx.transaction.execute(
            &format!("DELETE FROM public.{} t WHERE tenant_id=$1 AND world_id=$2{predicate}", table.table),
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()],
        ).await.map_err(|error| StoreError::database(error, FailureStage::Execute))?;
    }
    Ok(())
}

pub(super) async fn release_marks(tx: &WorldTransaction<'_>) -> Result<(), StoreError> {
    tx.transaction.batch_execute("DROP TABLE pg_temp.world_delete_keep")
        .await.map_err(|error| StoreError::database(error, FailureStage::Validate))
}
