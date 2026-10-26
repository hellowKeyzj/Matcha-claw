use serde::{Deserialize, Serialize};
use world_protocol::{
    api::{MAX_PAGE_ITEMS, PackageConfigView},
    failure::{FailureStage, FieldPath, InputFailure, Recovery},
    ids::*,
    package::{Contribution, InstalledRecord, PackageFailure},
    query::{Page, PageRequest},
};

use super::PackageError;
use crate::{owner, store::WorldTransaction};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    world: WorldRef,
    install: InstallId,
}

pub(crate) async fn read_packages(
    tx: &WorldTransaction<'_>,
    page: &PageRequest,
) -> Result<Page<InstalledRecord>, owner::Error> {
    if page.limit == 0 || page.limit > MAX_PAGE_ITEMS {
        return Err(invalid("page.limit"));
    }
    let after = match &page.cursor {
        None => String::new(),
        Some(cursor) => {
            if cursor.len() > 4096 {
                return Err(invalid("page.cursor"));
            }
            let cursor: Cursor =
                serde_json::from_str(cursor).map_err(|_| invalid("page.cursor"))?;
            if &cursor.world != tx.world() {
                return Err(invalid("page.cursor"));
            }
            cursor.install.to_string()
        }
    };
    let rows = tx.query("SELECT install_id,revision,package_digest,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND phase='installed' AND install_id>$3 ORDER BY install_id LIMIT $4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after, &(i64::from(page.limit) + 1)]).await?;
    let more = rows.len() > page.limit as usize;
    let mut items = Vec::new();
    for row in rows.into_iter().take(page.limit as usize) {
        items.push(checked_record(tx.world(), &row)?);
    }
    let next_cursor = if more {
        let last = items.last().expect("nonzero page with extra row");
        Some(
            serde_json::to_string(&Cursor {
                world: tx.world().clone(),
                install: last.install_id.clone(),
            })
            .map_err(|cause| owner::Error::internal(FailureStage::Read).caused(cause))?,
        )
    } else {
        None
    };
    Ok(Page { items, next_cursor })
}

pub(crate) async fn read_config(
    tx: &WorldTransaction<'_>,
    install: &InstallId,
) -> Result<PackageConfigView, owner::Error> {
    let record = read_installed_record(tx, install).await?;
    let row = tx.query_opt("SELECT h.revision,r.config_digest,r.body FROM world_extension_config_head h JOIN world_extension_config_revision r USING(tenant_id,world_id,install_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.install_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install.as_str()]).await?
        .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
    let fields: Vec<world_protocol::api::ConfigValue> = serde_json::from_value(row.get("body"))
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    let digest = world_protocol::api::package_config_digest(&fields)
        .map_err(|cause| PackageError::caused(PackageFailure::SchemaInvalid, cause))?;
    let revision: i64 = row.get("revision");
    if revision <= 0
        || digest.as_str() != row.get::<_, String>("config_digest")
        || super::config::validate_fields(&record.manifest.config, &fields, false)? != fields
    {
        return Err(PackageError::new(PackageFailure::InstallConflict).into());
    }
    Ok(PackageConfigView {
        install_id: install.clone(),
        revision: Revision(revision as u64),
        digest,
        fields,
    })
}

pub(crate) async fn read_contributions(
    tx: &WorldTransaction<'_>,
    install: &InstallId,
) -> Result<Vec<Contribution>, owner::Error> {
    Ok(read_installed_record(tx, install)
        .await?
        .manifest
        .contributions)
}

pub(crate) async fn read_installed_record(
    tx: &WorldTransaction<'_>,
    install: &InstallId,
) -> Result<InstalledRecord, PackageError> {
    let row = tx.query_opt("SELECT install_id,revision,package_digest,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 AND phase='installed'",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &install.as_str()]).await?
        .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
    checked_record(tx.world(), &row)
}

fn checked_record(
    world: &WorldRef,
    row: &tokio_postgres::Row,
) -> Result<InstalledRecord, PackageError> {
    let record: InstalledRecord = serde_json::from_value(row.get("body"))
        .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
    if &record.world != world
        || record.install_id.as_str() != row.get::<_, String>("install_id")
        || i64::try_from(record.revision.0).ok() != Some(row.get("revision"))
        || record.revision.0 == 0
        || record.package_digest.as_str() != row.get::<_, String>("package_digest")
    {
        return Err(PackageError::new(PackageFailure::InstallConflict));
    }
    Ok(record)
}
fn invalid(field: &str) -> owner::Error {
    owner::Error::new(
        "world.package_query_invalid",
        FailureStage::Validate,
        "包查询参数无效。",
        world_protocol::api::ApiFailure::Input(InputFailure::InvalidValue {
            field: FieldPath(field.split('.').map(str::to_owned).collect()),
        }),
        Recovery::None,
    )
}
