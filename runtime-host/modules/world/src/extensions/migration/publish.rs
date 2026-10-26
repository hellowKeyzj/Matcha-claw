use world_protocol::{
    authorization::{AccessMode, AccessScope},
    commit::CommittedRevision,
    ids::*,
    state::{StateFailure, StateMigrationReceipt, StateSnapshot},
};

use super::{
    PreparedMigration, StateError,
    checkpoint::{require_epoch, retain_checkpoint},
};
use crate::{
    authorization::{self, Admission},
    content::ContentOwner,
    extensions::package::{RetentionOwner, retain_packages},
    owner,
    store::{OutboxEvent, WorldTransaction},
};

/// Invoked by the binding publication reducer before graph guards/heads. No
/// runtime execution or second transaction can advance the namespace early.
pub(crate) async fn publish_state_head(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    prepared: &PreparedMigration,
) -> Result<StateMigrationReceipt, StateError> {
    let expected = &prepared.request.expected;
    if tx.world() != &expected.world || tx.commit_id() != prepared.commit_id() {
        return Err(StateFailure::CheckpointBarrierUnsatisfied.into());
    }
    tx.require_domain(&WriterDomain::try_new("state").expect("fixed domain"))?;
    tx.require_exclusive_domain(&expected.writer_domain)?;
    if !tx
        .fences()
        .iter()
        .any(|fence| fence.domain == expected.writer_domain && fence.epoch == expected.writer_epoch)
    {
        return Err(StateFailure::Fenced.into());
    }
    let scope = owner::management_scope(tx).await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![
                ResourceRef::State {
                    id: expected.root.id.clone(),
                },
                ResourceRef::Package {
                    id: prepared.implementation.install_id.clone(),
                },
            ],
            fields: Vec::new(),
            modes: vec![AccessMode::Manage, AccessMode::Publish],
            scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        vec![expected.root.clone()],
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    let at = tx.now().await?;
    authorization::recheck(tx, admission, &at).await?;
    let world = tx.world().clone();
    let row = tx.query_opt(
        "SELECT install_id,state_root_id,state_root_revision,schema_digest,writer_domain,writer_epoch,state_epoch FROM world_state_namespace WHERE tenant_id=$1 AND world_id=$2 AND namespace_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &expected.namespace.as_str()],
    ).await?.ok_or_else(|| StateFailure::NamespaceMissing { namespace: expected.namespace.clone() })?;
    require_epoch(&row, expected)?;
    if row.get::<_, String>("install_id")
        != prepared
            .checkpoint
            .source
            .implementation
            .install_id
            .as_str()
        || row.get::<_, i64>("state_epoch") != prepared.checkpoint.state_epoch
    {
        return Err(StateFailure::Fenced.into());
    }
    let next_state = prepared
        .checkpoint
        .state_epoch
        .checked_add(1)
        .ok_or(StateFailure::Fenced)?;
    let source = &prepared.checkpoint.source.implementation;
    let source_config = &prepared.checkpoint.source_config;
    let row = tx.query_opt(
        "SELECT i.phase,i.desired_enabled,i.pending_removal,i.package_digest,t.trusted,t.quarantined,h.revision,r.config_digest,r.body FROM world_package_install i JOIN world_extension_trust t USING(tenant_id,world_id,package_digest) JOIN world_extension_config_head h USING(tenant_id,world_id,install_id) JOIN world_extension_config_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.install_id=h.install_id AND r.revision=h.revision WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3 FOR SHARE OF i,t,h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &source.install_id.as_str()],
    ).await?.ok_or(StateFailure::Fenced)?;
    if row.get::<_, String>("phase") != "installed"
        || !row.get::<_, bool>("desired_enabled")
        || row.get::<_, bool>("pending_removal")
        || row.get::<_, String>("package_digest") != source.package_digest.as_str()
        || !row.get::<_, bool>("trusted")
        || row.get::<_, bool>("quarantined")
        || i64::try_from(source_config.revision.0).ok() != Some(row.get("revision"))
        || source_config.install_id != source.install_id
        || source_config.digest != source.config_digest
        || row.get::<_, String>("config_digest") != source_config.digest.as_str()
        || serde_json::from_value::<Vec<world_protocol::api::ConfigValue>>(row.get("body"))?
            != source_config.fields
    {
        return Err(StateFailure::Fenced.into());
    }
    crate::extensions::package::read_package_grants_in_transaction(tx, source).await?;
    let row = tx.query_opt(
        "SELECT i.phase,i.desired_enabled,i.pending_removal,i.package_digest,p.manifest,t.trusted,t.quarantined,h.revision,r.config_digest,r.body FROM world_package_install i JOIN world_package p USING(tenant_id,world_id,package_digest) JOIN world_extension_trust t USING(tenant_id,world_id,package_digest) JOIN world_extension_config_head h USING(tenant_id,world_id,install_id) JOIN world_extension_config_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.install_id=h.install_id AND r.revision=h.revision WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3 FOR SHARE OF i,t,h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &prepared.implementation.install_id.as_str()],
    ).await?.ok_or(StateFailure::Fenced)?;
    let manifest: world_protocol::package::PackageManifest =
        serde_json::from_value(row.get("manifest"))?;
    if row.get::<_, String>("phase") != "installed"
        || !row.get::<_, bool>("desired_enabled")
        || row.get::<_, bool>("pending_removal")
        || row.get::<_, String>("package_digest") != prepared.implementation.package_digest.as_str()
        || !row.get::<_, bool>("trusted")
        || row.get::<_, bool>("quarantined")
        || row.get::<_, i64>("revision") as u64 != prepared.config.revision.0
        || row.get::<_, String>("config_digest") != prepared.config.digest.as_str()
        || serde_json::from_value::<Vec<world_protocol::api::ConfigValue>>(row.get("body"))?
            != prepared.config.fields
        || !manifest.state.iter().any(|state| {
            state.namespace == expected.namespace
                && state.schema_digest == prepared.binding.schema
                && state.checkpoint_format == prepared.request.target_checkpoint_format
        })
    {
        return Err(StateFailure::Fenced.into());
    }
    // Pure migration does not import ordinary capabilities; only validate the current
    // canonical grant head and exact implementation here, not all optional requests.
    crate::extensions::package::read_package_grants_in_transaction(tx, &prepared.implementation)
        .await?;
    retain_checkpoint(tx, &prepared.checkpoint, &prepared.request.id).await?;
    let content = &prepared.checkpoint.content;
    content
        .retain_prepared(
            tx,
            &prepared.blob,
            ContentOwner::State {
                reference: prepared.binding.root.clone(),
            },
        )
        .await?;
    content
        .retain_prepared(
            tx,
            &prepared.blob,
            ContentOwner::Migration {
                id: prepared.request.id.clone(),
            },
        )
        .await?;
    retain_packages(
        tx,
        RetentionOwner::Migration(&prepared.request.id),
        Revision(1),
        &[
            prepared
                .checkpoint
                .source
                .implementation
                .package_digest
                .clone(),
            prepared.implementation.package_digest.clone(),
        ],
    )
    .await?;
    retain_packages(
        tx,
        RetentionOwner::State(&prepared.binding.root.id),
        Revision(1),
        std::slice::from_ref(&prepared.implementation.package_digest),
    )
    .await?;
    let root_digest = prepared.data.digest()?;
    tx.execute(
        "INSERT INTO world_state_root(tenant_id,world_id,state_root_id,revision,namespace_id,state_epoch,schema_digest,content_digest,body) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &prepared.binding.root.id.as_str(), &expected.namespace.as_str(),
            &next_state, &prepared.binding.schema.as_str(), &root_digest.as_str(), &serde_json::to_value(&prepared.data)?],
    ).await?;
    let changed = tx.execute(
        "UPDATE world_writer_gate SET writer_epoch=$5 WHERE tenant_id=$1 AND world_id=$2 AND domain=$3 AND writer_epoch=$4 AND mode='active'",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &expected.writer_domain.as_str(), &(expected.writer_epoch.0 as i64), &(prepared.binding.writer_epoch.0 as i64)],
    ).await?;
    if changed != 1 {
        return Err(StateFailure::Fenced.into());
    }
    let changed = tx.execute(
        "UPDATE world_state_namespace SET install_id=$4,revision=revision+1,state_epoch=$5,state_root_id=$6,state_root_revision=1,schema_digest=$7,writer_epoch=$8 WHERE tenant_id=$1 AND world_id=$2 AND namespace_id=$3 AND state_root_id=$9 AND state_root_revision=$10 AND writer_epoch=$11 AND revision<9223372036854775807",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &expected.namespace.as_str(), &prepared.implementation.install_id.as_str(),
            &next_state, &prepared.binding.root.id.as_str(), &prepared.binding.schema.as_str(), &(prepared.binding.writer_epoch.0 as i64),
            &expected.root.id.as_str(), &(expected.root.revision.0 as i64), &(expected.writer_epoch.0 as i64)],
    ).await?;
    if changed != 1 {
        return Err(StateFailure::Fenced.into());
    }
    let target_snapshot = StateSnapshot {
        epoch: world_protocol::state::StateEpoch {
            world: world.clone(),
            namespace: expected.namespace.clone(),
            root: prepared.binding.root.clone(),
            writer_domain: expected.writer_domain.clone(),
            writer_epoch: prepared.binding.writer_epoch,
            schema: prepared.binding.schema.clone(),
            checkpoint_format: prepared.request.target_checkpoint_format.clone(),
        },
        content: prepared.blob.reference().clone(),
        checkpoint: None,
        created_at: at.clone(),
    };
    let mut source = prepared
        .checkpoint
        .source
        .state
        .clone()
        .ok_or(StateFailure::Fenced)?;
    source.root = expected.root.clone();
    let receipt = StateMigrationReceipt {
        migration_id: prepared.request.id.clone(),
        source,
        target: prepared.binding.clone(),
        snapshot: target_snapshot,
        validated_at: at,
    };
    tx.execute(
        "INSERT INTO world_state_migration(tenant_id,world_id,migration_id,namespace_id,source_epoch,target_epoch,source_root_id,source_root_revision,target_root_id,target_root_revision,phase,checkpoint,receipt,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'published',$10,$11,$12)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &prepared.request.id.as_str(), &expected.namespace.as_str(),
            &prepared.checkpoint.state_epoch, &next_state, &expected.root.id.as_str(), &(expected.root.revision.0 as i64), &prepared.binding.root.id.as_str(),
            &serde_json::to_value(&prepared.checkpoint.snapshot)?, &serde_json::to_value(&receipt)?, &serde_json::to_value(&prepared.request)?],
    ).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::State {
            id: prepared.binding.root.id.clone(),
        },
        revision: Revision(1),
    })?;
    tx.emit(OutboxEvent {
        event_id: EventId::try_new(format!("state-migrated-{}", prepared.request.id))
            .map_err(|_| StateFailure::ShadowValidationFailed)?,
        aggregate_kind: "state_migration".into(),
        aggregate_id: prepared.request.id.to_string(),
        aggregate_revision: 1,
        event_kind: "world.state.migrated".into(),
        payload: serde_json::to_value(&receipt)?,
        causation_id: None,
        origin: "world.state".into(),
    })
    .await?;
    Ok(receipt)
}
