use sha2::{Digest as _, Sha256};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    bindings::{ImplementationRef, StateBinding},
    commit::CommittedRevision,
    ids::*,
    package::{ArtifactKind, PackageFailure},
    state::{KV_CHECKPOINT_FORMAT, StateFailure},
};

use super::{StateError, data::StateData};
use crate::{
    authorization::{self, Admission},
    extensions::package::{Inventory, RetentionOwner, retain_packages},
    owner,
    store::{OutboxEvent, WorldSnapshot, WorldStore, WorldTransaction},
};

/// Names and schemas come from the exact installed manifest, not a guest's root/domain choice.
/// Planning is read-only; the first root and its graph are published in one transaction.
pub(crate) struct PreparedNamespace {
    binding: StateBinding,
    implementation: ImplementationRef,
    existing: bool,
}

impl PreparedNamespace {
    pub(crate) fn binding(&self) -> &StateBinding {
        &self.binding
    }
    pub(crate) fn implementation(&self) -> &ImplementationRef {
        &self.implementation
    }
    pub(crate) fn initializes(&self) -> bool {
        !self.existing
    }
}

pub(crate) async fn prepare_namespace(
    store: &WorldStore,
    inventory: &Inventory,
    world: &WorldRef,
    implementation: &ImplementationRef,
    namespace: &StateNamespaceId,
) -> Result<PreparedNamespace, StateError> {
    let record = inventory
        .lookup(
            world,
            &implementation.install_id,
            &implementation.package_digest,
        )
        .await?;
    let declaration = record
        .manifest
        .state
        .iter()
        .find(|state| &state.namespace == namespace)
        .ok_or_else(|| StateFailure::NamespaceMissing {
            namespace: namespace.clone(),
        })?;
    if declaration.checkpoint_format.as_str() != KV_CHECKPOINT_FORMAT
        || implementation.checkpoint_format.as_ref() != Some(&declaration.checkpoint_format)
    {
        return Err(StateFailure::CheckpointIncompatible {
            format: declaration.checkpoint_format.clone(),
        }
        .into());
    }
    let artifact = record.manifest.artifacts.iter().find(|artifact| {
        artifact.id == implementation.artifact_id
            && artifact.digest == implementation.artifact_digest
            && artifact.entrypoint == implementation.entrypoint
            && artifact.kind == ArtifactKind::Implementation
    });
    if artifact.is_none() || record.lock.digest != implementation.dependency_lock {
        return Err(crate::extensions::bindings::BindingError::Package(
            PackageFailure::InstallConflict,
        )
        .into());
    }
    let world = world.clone();
    let implementation = implementation.clone();
    let namespace = namespace.clone();
    let schema = declaration.schema_digest.clone();
    store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let row = snapshot.query_opt(
            "SELECT n.install_id,n.state_root_id,n.state_root_revision,n.schema_digest,n.writer_domain,n.writer_epoch,g.writer_epoch AS gate_epoch,g.mode FROM world_state_namespace n JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &namespace.as_str()],
        ).await?;
        let (binding, existing) = match row {
            Some(row) => {
                if row.get::<_, String>("install_id") != implementation.install_id.as_str()
                    || row.get::<_, String>("schema_digest") != schema.as_str()
                    || row.get::<_, String>("mode") != "active"
                    || row.get::<_, i64>("writer_epoch") != row.get::<_, i64>("gate_epoch") {
                    return Err(StateFailure::Fenced.into());
                }
                let binding = StateBinding {
                    namespace, root: StateRef { world: world.clone(),
                        id: StateRootId::try_new(row.get::<_, String>("state_root_id")).map_err(|_| StateFailure::ShadowValidationFailed)?,
                        revision: Revision(positive(row.get("state_root_revision"))?), },
                    schema, writer_domain: WriterDomain::try_new(row.get::<_, String>("writer_domain")).map_err(|_| StateFailure::ShadowValidationFailed)?,
                    writer_epoch: WriterEpoch(positive(row.get("writer_epoch"))?), migration: None,
                };
                (binding, true)
            }
            None => {
                (initial_binding(&world, &implementation, namespace, schema)?, false)
            }
        };
        Ok::<_, StateError>(PreparedNamespace { binding, implementation, existing })
    })).await
}

pub(crate) async fn apply_namespace(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    prepared: &PreparedNamespace,
) -> Result<StateBinding, StateError> {
    tx.require_domain(&WriterDomain::try_new("state").expect("fixed domain"))?;
    let binding = &prepared.binding;
    if binding.root.world != *tx.world() {
        return Err(StateFailure::Fenced.into());
    }
    let scope = owner::management_scope(tx).await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![
                ResourceRef::Package {
                    id: prepared.implementation.install_id.clone(),
                },
                ResourceRef::State {
                    id: binding.root.id.clone(),
                },
            ],
            fields: Vec::new(),
            modes: vec![AccessMode::Manage],
            scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    let world = tx.world().clone();
    let row = tx.query_opt(
        "SELECT i.phase,i.pending_removal,i.package_digest,p.manifest,t.trusted,t.quarantined FROM world_package_install i JOIN world_package p USING(tenant_id,world_id,package_digest) JOIN world_extension_trust t USING(tenant_id,world_id,package_digest) WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3 FOR SHARE OF i,t",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &prepared.implementation.install_id.as_str()],
    ).await?.ok_or(StateFailure::Fenced)?;
    let manifest: world_protocol::package::PackageManifest =
        serde_json::from_value(row.get("manifest"))?;
    if row.get::<_, String>("phase") != "installed"
        || row.get::<_, bool>("pending_removal")
        || row.get::<_, String>("package_digest") != prepared.implementation.package_digest.as_str()
        || !row.get::<_, bool>("trusted")
        || row.get::<_, bool>("quarantined")
        || !manifest.state.iter().any(|state| {
            state.namespace == binding.namespace
                && state.schema_digest == binding.schema
                && state.checkpoint_format.as_str() == KV_CHECKPOINT_FORMAT
        })
    {
        return Err(StateFailure::Fenced.into());
    }
    if !prepared.existing {
        let data = StateData::empty();
        let digest = data.digest()?;
        tx.execute("INSERT INTO world_writer_gate(tenant_id,world_id,domain,writer_epoch,mode) VALUES($1,$2,$3,1,'active')",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.writer_domain.as_str()]).await?;
        tx.execute("INSERT INTO world_state_root(tenant_id,world_id,state_root_id,revision,namespace_id,state_epoch,schema_digest,content_digest,body) VALUES($1,$2,$3,1,$4,1,$5,$6,$7)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.root.id.as_str(), &binding.namespace.as_str(), &binding.schema.as_str(), &digest.as_str(), &serde_json::to_value(&data)?]).await?;
        tx.execute("INSERT INTO world_state_namespace(tenant_id,world_id,namespace_id,install_id,revision,state_epoch,state_root_id,state_root_revision,schema_digest,writer_domain,writer_epoch) VALUES($1,$2,$3,$4,1,1,$5,1,$6,$7,1)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.namespace.as_str(), &prepared.implementation.install_id.as_str(), &binding.root.id.as_str(), &binding.schema.as_str(), &binding.writer_domain.as_str()]).await?;
        retain_packages(
            tx,
            RetentionOwner::State(&binding.root.id),
            binding.root.revision,
            std::slice::from_ref(&prepared.implementation.package_digest),
        )
        .await?;
        tx.record_revision(CommittedRevision {
            resource: ResourceRef::State {
                id: binding.root.id.clone(),
            },
            revision: binding.root.revision,
        })?;
        tx.emit(OutboxEvent {
            event_id: EventId::try_new(format!("initialized-{}", binding.root.id))
                .expect("bounded identifier"),
            aggregate_kind: "state_root".into(),
            aggregate_id: binding.root.id.to_string(),
            aggregate_revision: 1,
            event_kind: "world.state.initialized".into(),
            payload: serde_json::to_value(binding)?,
            causation_id: None,
            origin: "world.state".into(),
        })
        .await?;
    }
    let row = tx.query_opt("SELECT install_id,state_root_id,state_root_revision,schema_digest,writer_domain,writer_epoch FROM world_state_namespace WHERE tenant_id=$1 AND world_id=$2 AND namespace_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.namespace.as_str()]).await?.ok_or(StateFailure::Fenced)?;
    if row.get::<_, String>("install_id") != prepared.implementation.install_id.as_str()
        || row.get::<_, String>("state_root_id") != binding.root.id.as_str()
        || positive(row.get("state_root_revision"))? < binding.root.revision.0
        || row.get::<_, String>("schema_digest") != binding.schema.as_str()
        || row.get::<_, String>("writer_domain") != binding.writer_domain.as_str()
        || positive(row.get("writer_epoch"))? != binding.writer_epoch.0
    {
        return Err(StateFailure::Fenced.into());
    }
    Ok(binding.clone())
}

const ACTIVATION_PACKAGE: &str = "SELECT i.phase,i.pending_removal,i.package_digest,p.manifest FROM world_package_install i JOIN world_package p USING(tenant_id,world_id,package_digest) WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.install_id=$3";
const ACTIVATION_NAMESPACE: &str = "SELECT n.install_id,n.state_root_id,n.state_root_revision,n.schema_digest,n.writer_domain,n.writer_epoch,r.namespace_id AS root_namespace,r.schema_digest AS root_schema,r.state_epoch AS root_epoch,n.state_epoch,g.writer_epoch AS gate_epoch,g.mode FROM world_state_namespace n LEFT JOIN world_state_root r ON r.tenant_id=n.tenant_id AND r.world_id=n.world_id AND r.state_root_id=n.state_root_id AND r.revision=n.state_root_revision LEFT JOIN world_writer_gate g ON g.tenant_id=n.tenant_id AND g.world_id=n.world_id AND g.domain=n.writer_domain WHERE n.tenant_id=$1 AND n.world_id=$2 AND n.namespace_id=$3";

/// Same-transaction namespace identity guard; activation metadata does not read state contents.
pub(crate) async fn activation_basis(
    tx: &WorldTransaction<'_>,
    implementation: &ImplementationRef,
    state: &StateBinding,
) -> Result<Option<StateRef>, StateError> {
    let world = tx.world();
    if state.root.world != *world {
        return Err(StateFailure::Fenced.into());
    }
    let package = tx
        .query_opt(
            ACTIVATION_PACKAGE,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &implementation.install_id.as_str(),
            ],
        )
        .await?
        .ok_or(StateFailure::Fenced)?;
    let namespace = tx
        .query_opt(
            ACTIVATION_NAMESPACE,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &state.namespace.as_str(),
            ],
        )
        .await?;
    checked_activation_basis(world, implementation, state, &package, namespace.as_ref())
}

/// Cold restoration checks the same current namespace identity without minting initialization.
pub(crate) async fn activation_basis_read(
    snapshot: &WorldSnapshot<'_>,
    implementation: &ImplementationRef,
    state: &StateBinding,
) -> Result<Option<StateRef>, StateError> {
    let world = snapshot.world();
    if state.root.world != *world {
        return Err(StateFailure::Fenced.into());
    }
    let package = snapshot
        .query_opt(
            ACTIVATION_PACKAGE,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &implementation.install_id.as_str(),
            ],
        )
        .await?
        .ok_or(StateFailure::Fenced)?;
    let namespace = snapshot
        .query_opt(
            ACTIVATION_NAMESPACE,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &state.namespace.as_str(),
            ],
        )
        .await?;
    checked_activation_basis(world, implementation, state, &package, namespace.as_ref())
}

fn checked_activation_basis(
    world: &WorldRef,
    implementation: &ImplementationRef,
    state: &StateBinding,
    package: &tokio_postgres::Row,
    namespace: Option<&tokio_postgres::Row>,
) -> Result<Option<StateRef>, StateError> {
    let manifest: world_protocol::package::PackageManifest =
        serde_json::from_value(package.get("manifest"))?;
    if package.get::<_, String>("phase") != "installed"
        || package.get::<_, bool>("pending_removal")
        || package.get::<_, String>("package_digest") != implementation.package_digest.as_str()
        || !manifest.artifacts.iter().any(|artifact| {
            artifact.id == implementation.artifact_id
                && artifact.kind == ArtifactKind::Implementation
                && artifact.digest == implementation.artifact_digest
                && artifact.entrypoint == implementation.entrypoint
        })
    {
        return Err(StateFailure::Fenced.into());
    }
    let declaration = manifest
        .state
        .iter()
        .find(|declaration| {
            declaration.namespace == state.namespace
                && declaration.schema_digest == state.schema
                && declaration.checkpoint_format.as_str() == KV_CHECKPOINT_FORMAT
                && implementation.checkpoint_format.as_ref() == Some(&declaration.checkpoint_format)
        })
        .ok_or(StateFailure::Fenced)?;
    let Some(row) = namespace else {
        if initial_binding(
            world,
            implementation,
            state.namespace.clone(),
            declaration.schema_digest.clone(),
        )? != *state
        {
            return Err(StateFailure::Fenced.into());
        }
        return Ok(None);
    };
    let revision = Revision(positive(row.get("state_root_revision"))?);
    if row.get::<_, String>("install_id") != implementation.install_id.as_str()
        || row.get::<_, String>("state_root_id") != state.root.id.as_str()
        || state.root.revision.0 == 0
        || state.root.revision > revision
        || row.get::<_, String>("schema_digest") != state.schema.as_str()
        || row.get::<_, String>("writer_domain") != state.writer_domain.as_str()
        || positive(row.get("writer_epoch"))? != state.writer_epoch.0
        || row.get::<_, Option<String>>("root_namespace").as_deref()
            != Some(state.namespace.as_str())
        || row.get::<_, Option<String>>("root_schema").as_deref() != Some(state.schema.as_str())
        || row.get::<_, Option<i64>>("root_epoch") != Some(row.get("state_epoch"))
        || row.get::<_, Option<i64>>("gate_epoch") != Some(row.get("writer_epoch"))
        || row.get::<_, Option<String>>("mode").as_deref() != Some("active")
    {
        return Err(StateFailure::Fenced.into());
    }
    Ok(Some(StateRef {
        world: world.clone(),
        id: state.root.id.clone(),
        revision,
    }))
}

fn initial_binding(
    world: &WorldRef,
    implementation: &ImplementationRef,
    namespace: StateNamespaceId,
    schema: Digest,
) -> Result<StateBinding, StateError> {
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-state-namespace/1\n");
    hash.update(serde_json::to_vec(&(
        world,
        &implementation.install_id,
        &namespace,
    ))?);
    let key = format!("{:x}", hash.finalize());
    Ok(StateBinding {
        namespace,
        root: StateRef {
            world: world.clone(),
            id: StateRootId::try_new(format!("state-{key}")).expect("digest identifier"),
            revision: Revision(1),
        },
        schema,
        writer_domain: WriterDomain::try_new(format!("state-{key}")).expect("digest identifier"),
        writer_epoch: WriterEpoch(1),
        migration: None,
    })
}

fn positive(value: i64) -> Result<u64, StateError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| StateFailure::ShadowValidationFailed.into())
}
