use std::collections::BTreeMap;

use world_protocol::{
    api::PackageConfigView,
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure},
    bindings::{
        ActivationLock, ActivationRequest, ActivationSelection, BindingEdge, BindingFailure,
        BindingHeadCas, BindingNode, Composition, DataflowEdge, DataflowProjection,
        ImplementationRef, MethodPort, PortDirection,
    },
    ids::{Digest, ResourceRef, ScopeId, WorldRef},
    package::{ArtifactKind, PackageFailure},
};

use super::{BindingError, BindingGraph, Bindings, durable, guards};
use crate::{
    authorization,
    extensions::{
        lifecycle::load_recovery,
        migration::{PreparedNamespace, prepare_namespace},
        package::Inventory,
    },
    store::{WorldSnapshot, WorldTransaction},
};

/// Read-only authoring facts, not a prepared generation or execution authority.
pub(crate) struct ActivationPlan {
    graph: BindingGraph,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    heads: Vec<BindingHeadCas>,
    configs: Vec<PackageConfigView>,
    namespaces: Vec<PreparedNamespace>,
    impact: ActualImpact,
}

pub(crate) async fn activation_plan_impact(
    tx: &WorldTransaction<'_>,
    selection: &ActivationSelection,
) -> Result<ActualImpact, BindingError> {
    metadata_impact(selection, crate::owner::management_scope(tx).await?)
}

fn metadata_impact(
    selection: &ActivationSelection,
    scope: ScopeId,
) -> Result<ActualImpact, BindingError> {
    let mut resources = Vec::new();
    for node in &selection.nodes {
        resources.push(ResourceRef::Package {
            id: node.install_id.clone(),
        });
        resources.push(ResourceRef::Binding {
            id: node.binding_id.clone(),
        });
    }
    resources.extend(
        selection
            .compositions
            .iter()
            .map(|composition| ResourceRef::Binding {
                id: composition.binding_id.clone(),
            }),
    );
    resources.extend(
        selection
            .channels
            .iter()
            .map(|mapping| ResourceRef::Binding {
                id: mapping.binding_id.clone(),
            }),
    );
    resources.extend(selection.heads.iter().map(|head| ResourceRef::Head {
        channel: head.channel.clone(),
    }));
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources,
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}

impl Bindings {
    pub(crate) async fn build_activation(
        &self,
        world: &WorldRef,
        selection: &ActivationSelection,
        inventory: &Inventory,
    ) -> Result<ActivationPlan, BindingError> {
        let recovery = load_recovery(&self.store, world.clone()).await?;
        let mut nodes = Vec::with_capacity(selection.nodes.len());
        let mut configs = BTreeMap::new();
        for selected in &selection.nodes {
            let unavailable = || BindingFailure::PackageUnavailable {
                node_id: selected.id.clone(),
                install_id: selected.install_id.clone(),
            };
            let installed = recovery
                .installs
                .get(&selected.install_id)
                .ok_or_else(unavailable)?;
            let record = &installed.record;
            let provided = record
                .manifest
                .provides
                .iter()
                .find(|provided| {
                    provided.provider_id == selected.provider_id
                        && provided.slot == selected.slot
                        && provided.artifact_id == selected.artifact_id
                })
                .ok_or_else(unavailable)?;
            let artifact = record
                .manifest
                .artifacts
                .iter()
                .find(|artifact| {
                    artifact.id == selected.artifact_id
                        && artifact.kind == ArtifactKind::Implementation
                })
                .ok_or_else(unavailable)?;
            let config =
                installed
                    .config
                    .as_ref()
                    .ok_or_else(|| BindingFailure::ConfigurationChanged {
                        node_id: selected.id.clone(),
                    })?;
            configs.insert(config.install_id.clone(), config.clone());
            let mut ports = provided
                .contracts
                .iter()
                .map(|reference| {
                    let contract = record
                        .manifest
                        .contracts
                        .iter()
                        .find(|contract| &contract.reference == reference)
                        .ok_or_else(|| PackageFailure::ContractMismatch {
                            contract_id: reference.id.clone(),
                        })?;
                    Ok(MethodPort {
                        name: reference.id.to_string(),
                        contract: reference.clone(),
                        request_schema: contract.request_schema.digest.clone(),
                        result_schema: contract.result_schema.digest.clone(),
                        direction: PortDirection::Export,
                        required: true,
                    })
                })
                .collect::<Result<Vec<_>, BindingError>>()?;
            let mut contracts = provided.contracts.clone();
            for import in &selected.host_imports {
                let mut port = world_protocol::process::host_import_port(*import)
                    .map_err(|_| BindingFailure::InternalFault)?;
                if ports.iter().any(|actual| actual.name == port.name) {
                    return Err(BindingFailure::DuplicatePort {
                        node_id: selected.id.clone(),
                        port: port.name,
                    }.into());
                }
                let requirement = record.manifest.requires.iter().find(|requirement| {
                    requirement.id == port.contract.id
                        && semver::Version::parse(&port.contract.version)
                            .is_ok_and(|version| requirement.version.matches(&version))
                        && requirement.request_schema == port.request_schema
                        && requirement.result_schema == port.result_schema
                }).ok_or_else(|| PackageFailure::ContractMismatch {
                    contract_id: port.contract.id.clone(),
                })?;
                port.required = requirement.required;
                if !contracts.contains(&port.contract) {
                    contracts.push(port.contract.clone());
                }
                ports.push(port);
            }
            let checkpoint_format = selected
                .state_namespace
                .as_ref()
                .map(|namespace| {
                    record
                        .manifest
                        .state
                        .iter()
                        .find(|state| &state.namespace == namespace)
                        .map(|state| state.checkpoint_format.clone())
                        .ok_or_else(|| BindingFailure::StateConflict {
                            node_id: selected.id.clone(),
                        })
                })
                .transpose()?;
            nodes.push(BindingNode {
                id: selected.id.clone(),
                provider_id: selected.provider_id.clone(),
                binding_id: selected.binding_id.clone(),
                slot: selected.slot,
                implementation: ImplementationRef {
                    install_id: selected.install_id.clone(),
                    package_digest: record.package_digest.clone(),
                    artifact_id: artifact.id.clone(),
                    artifact_digest: artifact.digest.clone(),
                    entrypoint: artifact.entrypoint.clone(),
                    contracts,
                    config_digest: config.digest.clone(),
                    dependency_lock: record.lock.digest.clone(),
                    checkpoint_format,
                },
                ports,
                required: selected.required,
                state: None,
                trust: provided.trust,
            });
        }
        let mut index = BTreeMap::new();
        for (position, node) in nodes.iter().enumerate() {
            if index.insert(node.id.clone(), position).is_some() {
                return Err(BindingFailure::DuplicateNode {
                    node_id: node.id.clone(),
                }
                .into());
            }
        }
        let mut edges = Vec::with_capacity(selection.edges.len());
        for selected in &selection.edges {
            let consumer =
                *index
                    .get(&selected.consumer)
                    .ok_or_else(|| BindingFailure::MissingNode {
                        node_id: selected.consumer.clone(),
                    })?;
            let provider =
                *index
                    .get(&selected.provider)
                    .ok_or_else(|| BindingFailure::MissingNode {
                        node_id: selected.provider.clone(),
                    })?;
            let export = super::graph::port(&nodes[provider], &selected.provider_port)?.clone();
            let mismatch = || BindingFailure::ContractMismatch {
                consumer: selected.consumer.clone(),
                provider: selected.provider.clone(),
                contract: export.contract.clone(),
            };
            let record = &recovery.installs[&nodes[consumer].implementation.install_id].record;
            let requirement = record
                .manifest
                .requires
                .iter()
                .find(|requirement| {
                    requirement.id.as_str() == selected.consumer_port
                        && requirement.id == export.contract.id
                })
                .ok_or_else(mismatch)?;
            if export.direction != PortDirection::Export
                || !semver::Version::parse(&export.contract.version)
                    .is_ok_and(|version| requirement.version.matches(&version))
            {
                return Err(mismatch().into());
            }
            if requirement.request_schema != export.request_schema
                || requirement.result_schema != export.result_schema
            {
                return Err(BindingFailure::SchemaMismatch {
                    consumer: selected.consumer.clone(),
                    provider: selected.provider.clone(),
                }
                .into());
            }
            let node = &mut nodes[consumer];
            if !node
                .ports
                .iter()
                .any(|port| port.name == selected.consumer_port)
            {
                node.ports.push(MethodPort {
                    name: selected.consumer_port.clone(),
                    contract: export.contract.clone(),
                    request_schema: requirement.request_schema.clone(),
                    result_schema: requirement.result_schema.clone(),
                    direction: PortDirection::Import,
                    required: requirement.required,
                });
                if !node.implementation.contracts.contains(&export.contract) {
                    node.implementation.contracts.push(export.contract.clone());
                }
            }
            edges.push(BindingEdge {
                consumer: selected.consumer.clone(),
                consumer_port: selected.consumer_port.clone(),
                provider: selected.provider.clone(),
                provider_port: selected.provider_port.clone(),
                contract: export.contract,
                required: requirement.required,
            });
        }
        let mut namespaces = Vec::new();
        for (node, selected) in nodes.iter_mut().zip(&selection.nodes) {
            if let Some(namespace) = &selected.state_namespace {
                let prepared = prepare_namespace(
                    &self.store,
                    inventory,
                    world,
                    &node.implementation,
                    namespace,
                )
                .await?;
                node.state = Some(prepared.binding().clone());
                namespaces.push(prepared);
            }
        }
        let compositions = selection
            .compositions
            .iter()
            .map(|selected| {
                let wiring = selected
                    .wiring
                    .iter()
                    .map(|edge| {
                        let schema_digest = match edge.projection {
                            DataflowProjection::CompilerIr => world_protocol::schema::digest::<
                                world_protocol::compiler::TypedIr,
                            >()
                            .map_err(|_| BindingFailure::InternalFault)?,
                        };
                        Ok(DataflowEdge {
                            projection: edge.projection,
                            output_node: edge.output_node.clone(),
                            output_port: edge.output_port.clone(),
                            input_node: edge.input_node.clone(),
                            input_port: edge.input_port.clone(),
                            schema_digest,
                        })
                    })
                    .collect::<Result<_, BindingError>>()?;
                Ok(Composition {
                    binding_id: selected.binding_id.clone(),
                    nodes: selected.nodes.clone(),
                    mode: selected.mode,
                    order: selected.order.clone(),
                    wiring,
                    merge: selected.merge,
                    failure: selected.failure,
                })
            })
            .collect::<Result<_, BindingError>>()?;
        let mut lock = ActivationLock {
            world: world.clone(),
            id: selection.id.clone(),
            // The sole content digest excludes this field, as in genesis_graph.
            digest: Digest::try_new(format!("sha256:{}", "0".repeat(64))).expect("fixed digest"),
            nodes,
            edges,
            compositions,
            roots: selection.roots.clone(),
            trusted_roots: selection.trusted_roots.clone(),
        };
        lock.digest = world_protocol::bindings::activation_lock_digest(&lock)?;
        let graph = BindingGraph::validate(lock)?;
        let heads = selection
            .heads
            .iter()
            .map(|head| BindingHeadCas {
                world: world.clone(),
                channel: head.channel.clone(),
                expected: head.expected.clone(),
                replacement: selection.id.clone(),
            })
            .collect::<Vec<_>>();
        durable::validate_heads(&graph, &heads, &selection.channels)?;
        let channels = selection.channels.clone();
        let selection = selection.clone();
        let impact = self
            .store
            .snapshot(world.clone(), move |snapshot| {
                Box::pin(
                    async move { metadata_impact(&selection, management_scope(snapshot).await?) },
                )
            })
            .await?;
        Ok(ActivationPlan {
            graph,
            channels,
            heads,
            configs: configs.into_values().collect(),
            namespaces,
            impact,
        })
    }
}

impl ActivationPlan {
    pub(crate) fn impact(&self) -> &ActualImpact {
        &self.impact
    }

    pub(crate) async fn recheck(
        &self,
        snapshot: &WorldSnapshot<'_>,
    ) -> Result<ActivationRequest, BindingError> {
        if snapshot.world() != &self.graph.lock().world {
            return Err(BindingFailure::HeadInvalid.into());
        }
        let scope = management_scope(snapshot).await?;
        if self
            .impact
            .access
            .iter()
            .any(|access| access.scope != scope)
        {
            return Err(
                authorization::AuthError::from(AuthorizationFailure::InsufficientScope).into(),
            );
        }
        guards::recheck_plan(snapshot, &self.graph, &self.configs, &self.namespaces).await?;
        durable::recheck_heads_read(snapshot, &self.graph, &self.heads, &self.channels).await?;
        Ok(ActivationRequest {
            graph: self.graph.lock().clone(),
            channels: self.channels.clone(),
            heads: self.heads.clone(),
        })
    }
}

async fn management_scope(snapshot: &WorldSnapshot<'_>) -> Result<ScopeId, BindingError> {
    let world = snapshot.world();
    let row = snapshot
        .query_opt(
            "SELECT management_scope_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        )
        .await?
        .ok_or(BindingFailure::HeadInvalid)?;
    ScopeId::try_new(row.get::<_, String>("management_scope_id"))
        .map_err(|_| BindingFailure::HeadInvalid.into())
}
