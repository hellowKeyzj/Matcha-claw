use std::collections::BTreeSet;

use serde_json::Value;
use world_protocol::{
    commit::CommitFailure,
    failure::FailureStage,
    ids::{Digest, WorldRef},
};

use super::{StoreError, WorldSnapshot, retention::reference_error};

impl WorldSnapshot<'_> {
    pub(crate) async fn package_catalog(&self) -> Result<Vec<(Digest, Digest)>, StoreError> {
        read(&self.transaction, self.world()).await
    }
}

/// One readonly catalog for archives and both sides of storage transfer.
pub(super) async fn read(
    tx: &tokio_postgres::Transaction<'_>,
    world: &WorldRef,
) -> Result<Vec<(Digest, Digest)>, StoreError> {
    let parameters: &[&(dyn tokio_postgres::types::ToSql + Sync)] =
        &[&world.tenant_id.as_str(), &world.world_id.as_str()];
    let packages: Vec<Value> = tx.query("SELECT to_jsonb(p) FROM world_package p WHERE p.tenant_id=$1 AND p.world_id=$2 AND NOT EXISTS(SELECT 1 FROM world_package_gc g WHERE g.tenant_id=p.tenant_id AND g.world_id=p.world_id AND g.package_digest=p.package_digest AND g.state='removed') ORDER BY p.package_digest COLLATE \"C\" LIMIT 4097", parameters)
        .await.map_err(|error| StoreError::database(error, FailureStage::Read))?
        .into_iter().map(|row| row.get(0)).collect();
    let gc: Vec<Value> = tx.query("SELECT to_jsonb(g) FROM world_package_gc g WHERE tenant_id=$1 AND world_id=$2 AND state<>'removed' ORDER BY package_digest COLLATE \"C\" LIMIT 4097", parameters)
        .await.map_err(|error| StoreError::database(error, FailureStage::Read))?
        .into_iter().map(|row| row.get(0)).collect();
    if packages.len() > 4096 || gc.len() > 4096 {
        return Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Validate,
        ));
    }
    let mut catalog: BTreeSet<_> =
        crate::extensions::package::catalog_from_rows(&packages, &[], &gc, world)
            .map_err(reference_error)?
            .into_iter()
            .collect();
    let mut after: Option<String> = None;
    loop {
        let rows = tx.query("SELECT install_id,to_jsonb(i) AS record FROM world_package_install i WHERE tenant_id=$1 AND world_id=$2 AND phase='installed' AND NOT pending_removal AND ($3::text IS NULL OR install_id COLLATE \"C\">$3) ORDER BY install_id COLLATE \"C\" LIMIT 512",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after]).await
            .map_err(|error| StoreError::database(error, FailureStage::Read))?;
        let done = rows.len() < 512;
        let mut installs = Vec::with_capacity(rows.len());
        for row in rows {
            after = Some(row.get("install_id"));
            installs.push(row.get("record"));
        }
        catalog.extend(
            crate::extensions::package::catalog_from_rows(&packages, &installs, &gc, world)
                .map_err(reference_error)?,
        );
        if catalog.len() > 4096 {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Validate,
            ));
        }
        if done {
            return Ok(catalog.into_iter().collect());
        }
    }
}
