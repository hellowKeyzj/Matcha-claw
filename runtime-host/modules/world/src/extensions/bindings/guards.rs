use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    api::{ConfigValue, PackageConfigView},
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::{BindingFailure, BindingNode, PortDirection, TrustClass},
    failure::FieldPath,
    ids::{ActivationLockId, ResourceRef},
    package::{ArtifactKind, InstalledRecord, PackageFailure},
};

use crate::store::{StoreError, WorldSnapshot, WorldTransaction};

enum GuardRead<'a, 'b> {
    Snapshot(&'a WorldSnapshot<'b>),
    Transaction(&'a WorldTransaction<'b>),
}

impl GuardRead<'_, '_> {
    fn world(&self) -> &world_protocol::ids::WorldRef {
        match self {
            Self::Snapshot(snapshot) => snapshot.world(),
            Self::Transaction(tx) => tx.world(),
        }
    }
    async fn query_opt(
        &self,
        sql: &'static str,
        locked: &'static str,
        parameters: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Option<tokio_postgres::Row>, StoreError> {
        match self {
            Self::Snapshot(snapshot) => snapshot.query_opt(sql, parameters).await,
            Self::Transaction(tx) => tx.query_opt(locked, parameters).await,
        }
    }
}
use super::{BindingError, BindingGraph, durable::decode};

/// Current metadata only; the caller creates any durable branch/run reference in this transaction.
pub(crate) async fn read_activation_metadata(
    tx: &WorldTransaction<'_>,
    target: &ActivationLockId,
) -> Result<(BindingGraph, Option<ActualImpact>), BindingError> {
    let graph = super::durable::read_graph_in_transaction(tx, target).await?;
    let installs: BTreeSet<_> = graph
        .lock()
        .nodes
        .iter()
        .map(|node| &node.implementation.install_id)
        .collect();
    let mut configs = Vec::with_capacity(installs.len());
    for install in installs {
        configs.push(crate::extensions::package::read_config(tx, install).await?);
    }
    recheck(tx, &graph, &configs).await?;
    if graph.lock().nodes.is_empty() {
        return Ok((graph, None));
    }
    let resources: BTreeSet<_> = graph
        .lock()
        .nodes
        .iter()
        .flat_map(|node| {
            [
                ResourceRef::Package {
                    id: node.implementation.install_id.clone(),
                },
                ResourceRef::Binding {
                    id: node.binding_id.clone(),
                },
            ]
        })
        .collect();
    let impact = crate::authorization::actual_impact(
        vec![AccessScope {
            resources: resources.into_iter().collect(),
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: crate::owner::management_scope(tx).await?,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    Ok((graph, Some(impact)))
}

/// Exact preparation inputs. Rechecking a digest alone would accept a config
/// changed away and back while the candidate was being prepared.
pub(super) async fn recheck(
    tx: &WorldTransaction<'_>,
    graph: &BindingGraph,
    configs: &[PackageConfigView],
) -> Result<(), BindingError> {
    check(GuardRead::Transaction(tx), graph, configs, None).await
}

pub(crate) async fn recheck_read(
    snapshot: &WorldSnapshot<'_>,
    graph: &BindingGraph,
    configs: &[PackageConfigView],
) -> Result<(), BindingError> {
    check(GuardRead::Snapshot(snapshot), graph, configs, None).await
}

pub(super) async fn recheck_plan(
    snapshot: &WorldSnapshot<'_>,
    graph: &BindingGraph,
    configs: &[PackageConfigView],
    namespaces: &[crate::extensions::migration::PreparedNamespace],
) -> Result<(), BindingError> {
    check(
        GuardRead::Snapshot(snapshot),
        graph,
        configs,
        Some(namespaces),
    )
    .await
}

async fn check(
    reader: GuardRead<'_, '_>,
    graph: &BindingGraph,
    configs: &[PackageConfigView],
    namespaces: Option<&[crate::extensions::migration::PreparedNamespace]>,
) -> Result<(), BindingError> {
    let world = reader.world();
    let mut ordered: Vec<_> = graph.lock().nodes.iter().collect();
    ordered.sort_unstable_by(|left, right| {
        (&left.implementation.install_id, &left.id)
            .cmp(&(&right.implementation.install_id, &right.id))
    });
    for node in ordered {
        let implementation = &node.implementation;
        let unavailable = || BindingFailure::PackageUnavailable {
            node_id: node.id.clone(),
            install_id: implementation.install_id.clone(),
        };
        let row = reader.query_opt(
            "SELECT phase,desired_enabled,pending_removal,package_digest,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
            "SELECT phase,desired_enabled,pending_removal,package_digest,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &implementation.install_id.as_str()],
        ).await?.ok_or_else(unavailable)?;
        if row.get::<_, String>("phase") != "installed"
            || !row.get::<_, bool>("desired_enabled")
            || row.get::<_, bool>("pending_removal")
            || row.get::<_, Option<String>>("package_digest").as_deref()
                != Some(implementation.package_digest.as_str())
        {
            return Err(unavailable().into());
        }
        let record: InstalledRecord = decode(row.get("body"))?;
        if record.world != *world {
            return Err(unavailable().into());
        }
        validate_installed(node, &record)?;
        for requirement in record
            .manifest
            .requires
            .iter()
            .filter(|requirement| requirement.trusted)
        {
            for edge in graph
                .lock()
                .edges
                .iter()
                .filter(|edge| edge.consumer == node.id && edge.contract.id == requirement.id)
            {
                let provider = graph.node(&edge.provider)?;
                for member in &graph.composition(&provider.binding_id)?.nodes {
                    if graph.node(member)?.trust == TrustClass::OrdinaryGuest {
                        return Err(BindingFailure::TrustBoundary {
                            node_id: member.clone(),
                        }
                        .into());
                    }
                }
            }
        }
        let trust = reader.query_opt(
            "SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3",
            "SELECT trusted,quarantined FROM world_extension_trust WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &implementation.package_digest.as_str()],
        ).await?.ok_or_else(|| BindingFailure::TrustBoundary { node_id: node.id.clone() })?;
        if trust.get::<_, bool>("quarantined") {
            return Err(BindingFailure::Quarantined {
                node_id: node.id.clone(),
            }
            .into());
        }
        if !trust.get::<_, bool>("trusted") {
            return Err(BindingFailure::TrustBoundary {
                node_id: node.id.clone(),
            }
            .into());
        }
        let expected = configs
            .iter()
            .find(|config| config.install_id == implementation.install_id)
            .ok_or_else(|| BindingFailure::ConfigurationChanged {
                node_id: node.id.clone(),
            })?;
        let row = reader.query_opt(
            "SELECT h.revision,r.config_digest,r.body FROM world_extension_config_head h JOIN world_extension_config_revision r USING(tenant_id,world_id,install_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.install_id=$3",
            "SELECT h.revision,r.config_digest,r.body FROM world_extension_config_head h JOIN world_extension_config_revision r USING(tenant_id,world_id,install_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.install_id=$3 FOR SHARE OF h,r",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &implementation.install_id.as_str()],
        ).await?.ok_or_else(|| BindingFailure::ConfigurationChanged { node_id: node.id.clone() })?;
        let fields: Vec<ConfigValue> = decode(row.get("body"))?;
        if i64::try_from(expected.revision.0).ok() != Some(row.get::<_, i64>("revision"))
            || expected.digest != implementation.config_digest
            || fields != expected.fields
            || row.get::<_, String>("config_digest") != implementation.config_digest.as_str()
            || world_protocol::api::package_config_digest(&fields)
                .ok()
                .as_ref()
                != Some(&implementation.config_digest)
        {
            return Err(BindingFailure::ConfigurationChanged {
                node_id: node.id.clone(),
            }
            .into());
        }
        validate_config(node, &record, &fields)?;
        match &reader {
            GuardRead::Snapshot(snapshot) => {
                crate::extensions::package::read_package_grants(snapshot, implementation).await?;
            }
            GuardRead::Transaction(tx) => {
                crate::extensions::package::read_package_grants_in_transaction(tx, implementation)
                    .await?;
            }
        }
        if let Some(state) = &node.state {
            let basis = match &reader {
                GuardRead::Snapshot(snapshot) => {
                    crate::extensions::migration::activation_basis_read(
                        snapshot,
                        implementation,
                        state,
                    )
                    .await?
                }
                GuardRead::Transaction(tx) => {
                    crate::extensions::migration::activation_basis(tx, implementation, state)
                        .await?
                }
            };
            let valid = match namespaces {
                None => basis.is_some(),
                Some(namespaces) => namespaces.iter().any(|prepared| {
                    prepared.implementation() == implementation
                        && prepared.binding() == state
                        && if prepared.initializes() {
                            basis.is_none()
                        } else {
                            basis.as_ref() == Some(&state.root)
                        }
                }),
            };
            if !valid {
                return Err(BindingFailure::StateConflict {
                    node_id: node.id.clone(),
                }
                .into());
            }
        }
    }
    Ok(())
}

fn validate_installed(node: &BindingNode, record: &InstalledRecord) -> Result<(), BindingError> {
    let implementation = &node.implementation;
    if record.install_id != implementation.install_id
        || record.package_digest != implementation.package_digest
        || record.lock.digest != implementation.dependency_lock
    {
        return Err(BindingFailure::PackageUnavailable {
            node_id: node.id.clone(),
            install_id: implementation.install_id.clone(),
        }
        .into());
    }
    let artifact = record
        .manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.id == implementation.artifact_id)
        .ok_or_else(|| PackageFailure::ArtifactInvalid {
            artifact_id: implementation.artifact_id.clone(),
        })?;
    if artifact.kind != ArtifactKind::Implementation
        || artifact.digest != implementation.artifact_digest
        || artifact.entrypoint != implementation.entrypoint
    {
        return Err(PackageFailure::ArtifactInvalid {
            artifact_id: artifact.id.clone(),
        }
        .into());
    }
    let provided = record
        .manifest
        .provides
        .iter()
        .find(|provided| {
            provided.provider_id == node.provider_id
                && provided.slot == node.slot
                && provided.artifact_id == artifact.id
        })
        .ok_or_else(|| PackageFailure::ArtifactInvalid {
            artifact_id: artifact.id.clone(),
        })?;
    if provided.trust != node.trust {
        return Err(BindingFailure::TrustBoundary {
            node_id: node.id.clone(),
        }
        .into());
    }
    for contract in &implementation.contracts {
        if !node.ports.iter().any(|port| &port.contract == contract) {
            return Err(PackageFailure::ContractMismatch {
                contract_id: contract.id.clone(),
            }
            .into());
        }
    }
    for port in &node.ports {
        let declared = match port.direction {
            PortDirection::Export => provided.contracts.contains(&port.contract),
            PortDirection::Import => record.manifest.requires.iter().any(|requirement| {
                requirement.id == port.contract.id
                    && semver::Version::parse(&port.contract.version)
                        .is_ok_and(|version| requirement.version.matches(&version))
                    && requirement.request_schema == port.request_schema
                    && requirement.result_schema == port.result_schema
                    && requirement.required == port.required
            }),
        };
        if !declared {
            return Err(PackageFailure::ContractMismatch {
                contract_id: port.contract.id.clone(),
            }
            .into());
        }
        if port.direction == PortDirection::Export {
            let contract = record
                .manifest
                .contracts
                .iter()
                .find(|contract| contract.reference == port.contract)
                .ok_or_else(|| PackageFailure::ContractMismatch {
                    contract_id: port.contract.id.clone(),
                })?;
            if contract.request_schema.digest != port.request_schema
                || contract.result_schema.digest != port.result_schema
            {
                return Err(PackageFailure::ContractMismatch {
                    contract_id: port.contract.id.clone(),
                }
                .into());
            }
        }
    }
    for requirement in record
        .manifest
        .requires
        .iter()
        .filter(|requirement| requirement.required)
    {
        if !node.ports.iter().any(|port| {
            port.direction == PortDirection::Import
                && port.required
                && port.contract.id == requirement.id
        }) {
            return Err(PackageFailure::ContractMismatch {
                contract_id: requirement.id.clone(),
            }
            .into());
        }
    }
    if let Some(state) = &node.state {
        if !record.manifest.state.iter().any(|schema| {
            schema.namespace == state.namespace
                && schema.schema_digest == state.schema
                && Some(&schema.checkpoint_format) == implementation.checkpoint_format.as_ref()
        }) {
            return Err(BindingFailure::StateConflict {
                node_id: node.id.clone(),
            }
            .into());
        }
    }
    Ok(())
}

fn validate_config(
    node: &BindingNode,
    record: &InstalledRecord,
    fields: &[ConfigValue],
) -> Result<(), BindingError> {
    let invalid = |name: &str| {
        BindingError::Package(PackageFailure::ManifestInvalid {
            field: FieldPath(vec!["config".into(), name.into()]),
        })
    };
    let mut values = BTreeMap::new();
    for field in fields {
        if values.insert(&field.name, &field.value).is_some() {
            return Err(invalid(&field.name));
        }
    }
    let schema = &record.manifest.config;
    let declared: BTreeSet<_> = schema.fields.iter().map(|field| &field.name).collect();
    if fields.iter().any(|field| !declared.contains(&field.name)) {
        return Err(BindingFailure::ConfigurationChanged {
            node_id: node.id.clone(),
        }
        .into());
    }
    for field in &schema.fields {
        match values.get(&field.name) {
            Some(value) => crate::definitions::validate_value(&field.value_type, false, value)
                .map_err(|_| invalid(&field.name))?,
            None if field.required => return Err(invalid(&field.name)),
            None => {}
        }
    }
    Ok(())
}
