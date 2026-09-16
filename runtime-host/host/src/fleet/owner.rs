use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::SystemTime,
};

use fleet::topology::{
    AgentObservation, CapabilitySync, EndpointHealth, EndpointObservation, NodeId, NodeObservation,
    ObservationFreshness, RuntimeId, RuntimeObservation,
};
use foundation::execution::{CommandRoute, OwnerSpec, QueryRoute};

use crate::fleet::reachability_owner::DurableReachabilityMutation;

use super::command::{FleetCommand, FleetQuery};

use fleet::{
    FleetDeliveryError, FleetDeliveryOutcome, FleetDeliveryOwner, FleetDeliveryRequest,
    FleetSubmitOutcome, FleetTargetConfig, FleetTargetSelector, TargetId, TargetSnapshot,
    command::{CommandId, CommandIntent, CommandKind, CommandTarget, IdempotencyKey},
    connection::{
        ConnectionId, ConnectionKind, ConnectionMutation, ConnectionRecord, ProbeOutcome,
    },
    effect::{EffectIdentity, EffectOperationOutcome, EffectReceipt, EffectRecord, PhaseKey},
    environment::{
        CleanupPolicy, EnvironmentId, EnvironmentMutation, EnvironmentRecord,
        ManagedResourceAssociation, ManagedResourceId, ManagedResourceKind,
        ManagedResourceMetadata, ManagedResourceMutation, ManagedResourceProvider,
        ManagedResourceRecord, ManagedResourceRef, Ownership,
    },
    outbox::{DispatchAttempt, DispatchId, DispatchIntent},
    query::{FleetQuerySnapshot, SelectorConstraints, SelectorPreview},
    terminal::{
        Dimensions as TerminalDimensions, Generation, OpenedSession,
        ProviderId as TerminalProviderId, SessionId as TerminalSessionId, SessionSummary,
        TargetId as TerminalTargetId, TerminalSessionError, TerminalSessionOwner,
    },
};

/// Host-composed durable owner for Fleet delivery facts.
///
/// The delivery state machine and persistence remain owned by the Fleet domain. This
/// type only gives Host composition a single durable instance to dispatch through.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FleetTargetSummary {
    pub(crate) id: TargetId,
    pub(crate) revision: u64,
    pub(crate) kind: fleet::TargetKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FleetTargetResolution {
    pub(crate) selector: fleet::FleetTargetSelector,
    pub(crate) config: FleetTargetConfig,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FleetTopologySummary {
    pub(crate) nodes: Vec<NodeObservation>,
    pub(crate) agents: Vec<AgentObservation>,
    pub(crate) runtimes: Vec<RuntimeObservation>,
    pub(crate) endpoints: Vec<EndpointObservation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetTerminalTargetSelector {
    Target(TerminalTargetId),
    Node(NodeId),
    Runtime(RuntimeId),
    Endpoint(platform::endpoint::EndpointId),
}

pub(crate) struct FleetSnapshot {
    pub(crate) query: FleetQuerySnapshot,
    pub(crate) topology: FleetTopologySummary,
    pub(crate) sessions: Vec<SessionSummary>,
    pub(crate) updated_at: SystemTime,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum FleetLaneKey {
    Connection(ConnectionId),
    Dispatch(DispatchId),
    Environment(EnvironmentId),
    Resource(ManagedResourceId),
    Target(TargetId),
}

#[derive(Clone)]
pub(crate) struct FleetShared {
    facts_path: PathBuf,
    private_root: PathBuf,
    docker_ownership: BTreeMap<String, String>,
    ssh_host_keys: BTreeMap<TargetId, russh::keys::PublicKey>,
}

impl FleetShared {
    fn open_operation_owner(&self) -> Result<FleetOwner, FleetDeliveryError> {
        FleetOwner::open_live(
            &self.facts_path,
            &self.private_root,
            self.docker_ownership.clone(),
            self.ssh_host_keys.clone(),
        )
        .map_err(|_| FleetDeliveryError::InvalidTransition)
    }
}

pub(crate) struct FleetOwner {
    facts_path: PathBuf,
    private_root: PathBuf,
    pub(crate) delivery: FleetDeliveryOwner,
    terminal: TerminalSessionOwner,
    executor: crate::fleet::executor::FleetCommandExecutor,
    pub(crate) credentials: crate::fleet::credentials::FleetCredentialVault,
    pub(crate) ssh_host_keys: BTreeMap<TargetId, russh::keys::PublicKey>,
    pub(crate) docker_ownership: BTreeMap<String, String>,
}

pub(crate) struct FleetLaneState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FleetDispatchResult {
    pub(crate) dispatch_id: DispatchId,
    pub(crate) attempt: DispatchAttempt,
    pub(crate) outcome: crate::fleet::executor::FleetExecutionOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingDispatch {
    pub(crate) dispatch_id: DispatchId,
    pub(crate) target_id: TargetId,
}

pub(crate) struct ManagedResourceRegistrationRequest {
    pub(crate) requested_id: String,
    pub(crate) connection_id: ConnectionId,
    pub(crate) environment_id: EnvironmentId,
    pub(crate) provider: ManagedResourceProvider,
    pub(crate) kind: ManagedResourceKind,
    pub(crate) remote_resource_id: String,
    pub(crate) ownership: Ownership,
    pub(crate) cleanup_policy: CleanupPolicy,
}

pub(crate) struct FleetNodeCommandRequest {
    pub(crate) node_id: NodeId,
    pub(crate) command_id: CommandId,
    pub(crate) idempotency_key: IdempotencyKey,
    pub(crate) dispatch_id: DispatchId,
    pub(crate) kind: CommandKind,
}

pub(crate) struct FleetNodeCommandResolution {
    pub(crate) request: FleetDeliveryRequest,
    pub(crate) dispatch_id: DispatchId,
    pub(crate) selector: FleetTargetSelector,
}

pub(crate) struct FleetTerminalOpenResult {
    pub(crate) opened: OpenedSession,
    pub(crate) context: crate::fleet::terminal::TerminalContext,
}

impl DurableReachabilityMutation for FleetOwner {
    type Error = FleetDeliveryError;

    fn upsert_runtime_agent_reachability(
        &mut self,
        facts: fleet::reachability::RuntimeAgentIngressReachabilityFacts,
        now: SystemTime,
    ) -> Result<(), Self::Error> {
        self.delivery.upsert_runtime_agent_reachability(facts, now)
    }
}

impl FleetOwner {
    pub(crate) fn open(
        facts_path: impl AsRef<Path>,
        private_root: impl AsRef<Path>,
        docker_ownership: BTreeMap<String, String>,
        ssh_host_keys: BTreeMap<TargetId, russh::keys::PublicKey>,
    ) -> Result<Self, ()> {
        Self::open_with_delivery(
            facts_path,
            private_root,
            docker_ownership,
            ssh_host_keys,
            FleetDeliveryOwner::open,
        )
    }

    pub(crate) fn open_live(
        facts_path: impl AsRef<Path>,
        private_root: impl AsRef<Path>,
        docker_ownership: BTreeMap<String, String>,
        ssh_host_keys: BTreeMap<TargetId, russh::keys::PublicKey>,
    ) -> Result<Self, ()> {
        Self::open_with_delivery(
            facts_path,
            private_root,
            docker_ownership,
            ssh_host_keys,
            FleetDeliveryOwner::open_live,
        )
    }

    fn open_with_delivery(
        facts_path: impl AsRef<Path>,
        private_root: impl AsRef<Path>,
        docker_ownership: BTreeMap<String, String>,
        ssh_host_keys: BTreeMap<TargetId, russh::keys::PublicKey>,
        open_delivery: impl FnOnce(PathBuf) -> Result<FleetDeliveryOwner, fleet::store::StoreFault>,
    ) -> Result<Self, ()> {
        let facts_path = facts_path.as_ref().to_path_buf();
        let private_root = private_root.as_ref().to_path_buf();
        let delivery = open_delivery(facts_path.clone()).map_err(|_| ())?;
        let executor = crate::fleet::executor::FleetCommandExecutor::try_new(
            docker_ownership.clone(),
            ssh_host_keys.clone(),
        )
        .map_err(|_| ())?;
        let credentials =
            crate::fleet::credentials::FleetCredentialVault::open(&private_root).map_err(|_| ())?;
        Ok(Self {
            facts_path,
            private_root,
            delivery,
            terminal: TerminalSessionOwner::default(),
            executor,
            credentials,
            ssh_host_keys,
            docker_ownership,
        })
    }

    pub(crate) fn operation_owner(&self) -> Result<Self, ()> {
        Self::open_live(
            &self.facts_path,
            &self.private_root,
            self.docker_ownership.clone(),
            self.ssh_host_keys.clone(),
        )
    }

    pub(crate) fn refresh_from_store(&mut self) -> Result<(), FleetDeliveryError> {
        self.delivery =
            FleetDeliveryOwner::open_live(&self.facts_path).map_err(FleetDeliveryError::Store)?;
        Ok(())
    }

    pub(crate) fn terminal_open_allocated(
        &mut self,
        selector: &FleetTerminalTargetSelector,
        dimensions: TerminalDimensions,
        now: SystemTime,
    ) -> Result<FleetTerminalOpenResult, TerminalSessionError> {
        let (target, endpoint) = self
            .resolve_terminal_target_endpoint(selector)
            .ok_or(TerminalSessionError::InvalidState)?;
        let provider = match self.target_config(&target) {
            Some(FleetTargetConfig::Docker(_)) => "docker",
            Some(FleetTargetConfig::Ssh(_)) => "ssh",
            Some(FleetTargetConfig::Custom(_)) => "custom",
            Some(FleetTargetConfig::Kubernetes(_)) | None => {
                return Err(TerminalSessionError::InvalidState);
            }
        };
        let provider = TerminalProviderId::try_new(provider)
            .map_err(|_| TerminalSessionError::InvalidState)?;
        let node = endpoint.node_id().clone();
        let endpoint_id = endpoint.id().clone();
        let target = TerminalTargetId::try_new(target.as_str())
            .map_err(|_| TerminalSessionError::InvalidState)?;
        let opened = self
            .terminal
            .open_allocated(target, provider, dimensions, now)?;
        let context = crate::fleet::terminal::TerminalContext {
            session: opened.session.id().clone(),
            target: opened.session.target().clone(),
            provider: opened.session.provider().clone(),
            generation: opened.session.generation(),
            node,
            endpoint: endpoint_id,
            rows: opened.session.dimensions().rows(),
            cols: opened.session.dimensions().cols(),
        };
        Ok(FleetTerminalOpenResult { opened, context })
    }

    pub(crate) fn terminal_reconnect(
        &mut self,
        session: TerminalSessionId,
        now: SystemTime,
    ) -> Result<OpenedSession, TerminalSessionError> {
        self.terminal.reconnect(session, now)
    }

    pub(crate) fn terminal_begin_close(
        &mut self,
        session: &TerminalSessionId,
        generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        self.terminal.begin_close(session, generation, now)
    }

    pub(crate) fn terminal_finish_close(
        &mut self,
        session: &TerminalSessionId,
        generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        self.terminal.finish_close(session, generation, now)
    }

    pub(crate) fn terminal_list(&self) -> Vec<SessionSummary> {
        self.terminal.list()
    }

    pub(crate) fn terminal_consume_ticket(
        &mut self,
        ticket: &[u8],
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        self.terminal.consume_ticket_any(ticket, now)
    }

    pub(crate) fn terminal_close(
        &mut self,
        session: &TerminalSessionId,
        generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        self.terminal.close(session, generation, now)
    }

    pub(crate) fn terminal_fail(
        &mut self,
        session: &TerminalSessionId,
        generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        self.terminal.fail(session, generation, now)
    }

    pub(crate) fn write_credential(
        &self,
        request: crate::fleet::credentials::FleetCredentialWriteRequest,
    ) -> Result<
        crate::fleet::credentials::FleetCredentialWriteOutcome,
        crate::fleet::credentials::FleetCredentialVaultError,
    > {
        self.credentials.write_credential(request)
    }

    pub(crate) fn target_config(&self, id: &TargetId) -> Option<FleetTargetConfig> {
        self.delivery.facts().target_configuration(id).cloned()
    }

    pub(crate) fn dispatch_target_id(
        &self,
        dispatch_id: &DispatchId,
    ) -> Result<TargetId, FleetDeliveryError> {
        let record = self
            .delivery
            .facts()
            .outbox()
            .record(dispatch_id)
            .ok_or(FleetDeliveryError::DispatchNotFound)?;
        record
            .intent()
            .target()
            .map(|target| target.id().clone())
            .ok_or(FleetDeliveryError::InvalidTransition)
    }

    pub(crate) fn pending_dispatches(&self) -> Vec<PendingDispatch> {
        self.delivery
            .pending_dispatches()
            .filter_map(|record| {
                let target_id = record.intent().target()?.id().clone();
                Some(PendingDispatch {
                    dispatch_id: record.intent().dispatch_id().clone(),
                    target_id,
                })
            })
            .collect()
    }

    pub(crate) fn connection_target_id(
        &self,
        id: &ConnectionId,
    ) -> Result<TargetId, FleetDeliveryError> {
        self.connection_target_resolution(id)
            .map(|target| target.selector.id().clone())
            .ok_or(FleetDeliveryError::InvalidTransition)
    }

    pub(crate) fn environment_target_id(
        &self,
        id: &EnvironmentId,
    ) -> Result<TargetId, FleetDeliveryError> {
        self.environment_target_resolution(id)
            .map(|target| target.selector.id().clone())
            .ok_or(FleetDeliveryError::InvalidTransition)
    }

    pub(crate) fn resource_target_id(
        &self,
        id: &ManagedResourceId,
    ) -> Result<TargetId, FleetDeliveryError> {
        self.resource_target_resolution(id)
            .map(|target| target.selector.id().clone())
            .ok_or(FleetDeliveryError::InvalidTransition)
    }

    pub(crate) fn environment_target_resolution(
        &self,
        id: &EnvironmentId,
    ) -> Option<FleetTargetResolution> {
        let environment = self
            .delivery
            .facts()
            .environments()
            .find(|value| value.id() == id)?;
        self.target_resolution_for_scope(environment.connection_id(), Some(environment.id()), None)
    }

    pub(crate) fn resource_target_resolution(
        &self,
        id: &ManagedResourceId,
    ) -> Option<FleetTargetResolution> {
        let resource = self
            .delivery
            .facts()
            .managed_resources()
            .find(|value| value.id() == id)?;
        self.target_resolution_for_scope(
            resource.connection_id(),
            Some(resource.environment_id()),
            Some(resource.id()),
        )
    }

    pub(crate) fn connection_target_resolution(
        &self,
        connection_id: &ConnectionId,
    ) -> Option<FleetTargetResolution> {
        self.target_resolution_for_scope(connection_id, None, None)
    }

    fn target_resolution_for_scope(
        &self,
        connection_id: &ConnectionId,
        environment_id: Option<&EnvironmentId>,
        managed_resource_id: Option<&ManagedResourceId>,
    ) -> Option<FleetTargetResolution> {
        let facts = self.delivery.facts();
        let connection = facts
            .connections()
            .find(|record| record.id() == connection_id)?;
        let topology = facts.topology();
        let mut resolved = None;

        for snapshot in facts.target_snapshots() {
            let Some(binding) = facts.target_binding(snapshot.id()) else {
                continue;
            };
            if binding.target_revision() != snapshot.revision() {
                continue;
            }
            let Some(endpoint) = topology.endpoint(binding.endpoint_id()) else {
                continue;
            };
            let association = endpoint.association();
            if !endpoint.metadata().freshness().is_current()
                || !matches!(endpoint.health(), EndpointHealth::Ready)
                || association.connection_id() != Some(connection_id)
                || environment_id.is_some_and(|id| association.environment_id() != Some(id))
                || managed_resource_id
                    .is_some_and(|id| association.managed_resource_id() != Some(id))
                || !connection_kind_matches_target(connection.kind(), snapshot.kind())
            {
                continue;
            }
            if resolved.is_some() {
                return None;
            }
            let config = facts.target_configuration(snapshot.id())?.clone();
            resolved = Some(FleetTargetResolution {
                selector: snapshot.selector(),
                config,
            });
        }

        resolved
    }

    pub(crate) async fn terminal_provider_open(
        &mut self,
        context: crate::fleet::terminal::TerminalContext,
    ) -> Result<crate::fleet::terminal::TerminalProviderOpen, ()> {
        let target = TargetId::try_from(context.target.as_str()).map_err(|_| ())?;
        let provider = context.provider.as_str();
        let config = self.target_config(&target).ok_or(())?;
        match (provider, config) {
            ("ssh", FleetTargetConfig::Ssh(config)) => {
                let key = self.ssh_host_keys.get(&target).ok_or(())?;
                let (commands, events) = crate::fleet::ssh::open_terminal(
                    &config,
                    &mut self.credentials,
                    key,
                    context.rows,
                    context.cols,
                )
                .await
                .map_err(|_| ())?;
                Ok(crate::fleet::terminal::TerminalProviderOpen { commands, events })
            }
            ("docker", FleetTargetConfig::Docker(config)) => crate::fleet::docker::open_terminal(
                &config,
                &mut self.credentials,
                context.rows,
                context.cols,
            )
            .await
            .map_err(|_| ()),
            ("custom", FleetTargetConfig::Custom(config)) => {
                let Some(terminal) = config.terminal() else {
                    return Err(());
                };
                if !crate::fleet::custom::supports_terminal_protocol(terminal)
                    || !self.custom_terminal_capability_ready(&context.endpoint)
                {
                    return Err(());
                }
                crate::fleet::custom::open_terminal(&config, &mut self.credentials, &context)
                    .await
                    .map_err(|_| ())
            }
            _ => Err(()),
        }
    }

    fn custom_terminal_capability_ready(
        &self,
        endpoint_id: &platform::endpoint::EndpointId,
    ) -> bool {
        let capability = platform::capability::SupportedCapability::new(
            platform::capability::CapabilityId::try_new("remoteFleet.terminal.attach")
                .expect("static custom terminal capability is valid"),
            platform::capability::CapabilityScope::Endpoint,
        );
        self.delivery
            .facts()
            .topology()
            .endpoints()
            .iter()
            .find(|endpoint| endpoint.id() == endpoint_id)
            .and_then(|endpoint| endpoint.availability_observation(&capability))
            .is_some_and(|observation| observation.authorizes_use())
    }

    pub(crate) fn terminal_context(
        &self,
        summary: &SessionSummary,
    ) -> Option<crate::fleet::terminal::TerminalContext> {
        self.resolve_terminal_context(
            &FleetTerminalTargetSelector::Target(summary.target().clone()),
            summary,
        )
    }

    fn resolve_terminal_target_endpoint(
        &self,
        selector: &FleetTerminalTargetSelector,
    ) -> Option<(TargetId, &EndpointObservation)> {
        let facts = self.delivery.facts();
        let topology = facts.topology();
        let identity_exists = match selector {
            FleetTerminalTargetSelector::Target(_) => true,
            FleetTerminalTargetSelector::Node(node) => topology
                .nodes()
                .iter()
                .any(|observation| observation.id() == node),
            FleetTerminalTargetSelector::Runtime(runtime) => topology
                .runtimes()
                .iter()
                .any(|observation| observation.id() == runtime),
            FleetTerminalTargetSelector::Endpoint(endpoint) => {
                topology.endpoint(endpoint).is_some()
            }
        };
        if !identity_exists {
            return None;
        }

        let mut resolved = None;
        for snapshot in facts.target_snapshots() {
            let Some(binding) = facts.target_binding(snapshot.id()) else {
                continue;
            };
            if binding.target_revision() != snapshot.revision() {
                continue;
            }
            let Some(endpoint) = topology.endpoint(binding.endpoint_id()) else {
                continue;
            };
            if !endpoint.metadata().freshness().is_current()
                || !matches!(endpoint.health(), EndpointHealth::Ready)
            {
                continue;
            }
            let matches = match selector {
                FleetTerminalTargetSelector::Target(target) => {
                    target.as_str() == snapshot.id().as_str()
                }
                FleetTerminalTargetSelector::Node(node) => endpoint.node_id() == node,
                FleetTerminalTargetSelector::Runtime(runtime) => endpoint.runtime_id() == runtime,
                FleetTerminalTargetSelector::Endpoint(endpoint_id) => endpoint.id() == endpoint_id,
            };
            if !matches {
                continue;
            }
            if resolved.is_some() {
                return None;
            }
            resolved = Some((snapshot.id().clone(), endpoint));
        }
        resolved
    }

    fn resolve_terminal_target(
        &self,
        selector: &FleetTerminalTargetSelector,
    ) -> Option<TerminalTargetId> {
        self.resolve_terminal_target_endpoint(selector)
            .and_then(|(target, _)| TerminalTargetId::try_new(target.as_str()).ok())
    }

    pub(crate) fn resolve_terminal_context(
        &self,
        selector: &FleetTerminalTargetSelector,
        summary: &SessionSummary,
    ) -> Option<crate::fleet::terminal::TerminalContext> {
        let (target, endpoint) = self.resolve_terminal_target_endpoint(selector)?;
        if summary.target().as_str() != target.as_str() {
            return None;
        }
        Some(crate::fleet::terminal::TerminalContext {
            session: summary.id().clone(),
            target: summary.target().clone(),
            provider: summary.provider().clone(),
            generation: summary.generation(),
            node: endpoint.node_id().clone(),
            endpoint: endpoint.id().clone(),
            rows: summary.dimensions().rows(),
            cols: summary.dimensions().cols(),
        })
    }

    pub(crate) fn credential_resolver(
        &mut self,
    ) -> &mut crate::fleet::credentials::FleetCredentialVault {
        &mut self.credentials
    }

    pub(crate) fn ssh_host_key(&self, id: &TargetId) -> Option<russh::keys::PublicKey> {
        self.ssh_host_keys.get(id).cloned()
    }

    pub(crate) fn target_selector(
        &self,
        id: &TargetId,
        revision: u64,
        kind: fleet::TargetKind,
    ) -> Option<fleet::FleetTargetSelector> {
        self.delivery
            .facts()
            .target_snapshot(id)
            .filter(|snapshot| snapshot.revision() == revision && snapshot.kind() == kind)
            .map(|snapshot| snapshot.selector())
    }

    pub(crate) fn target_summaries(&self) -> Vec<FleetTargetSummary> {
        self.delivery
            .facts()
            .target_snapshots()
            .into_iter()
            .map(|snapshot| FleetTargetSummary {
                id: snapshot.id().clone(),
                revision: snapshot.revision(),
                kind: snapshot.kind(),
            })
            .collect()
    }

    pub(crate) fn topology_summary(&self) -> FleetTopologySummary {
        let topology = self.delivery.facts().topology();
        FleetTopologySummary {
            nodes: topology.nodes().to_vec(),
            agents: topology.agents().to_vec(),
            runtimes: topology.runtimes().to_vec(),
            endpoints: topology.endpoints().to_vec(),
        }
    }

    pub(crate) fn query_snapshot(&self, now: SystemTime) -> FleetQuerySnapshot {
        FleetQuerySnapshot::from_facts(self.delivery.facts(), self.delivery.facts().leases(), now)
    }

    pub(crate) fn registration_identity_authority(
        &self,
    ) -> crate::fleet::registration_identity::RegistrationIdentityAuthority {
        let facts = self.delivery.facts();
        let topology = facts.topology();
        let graphs = facts.environments().filter_map(|environment| {
            let nodes = topology
                .nodes()
                .iter()
                .filter(|node| {
                    node.association().connection_id() == Some(environment.connection_id())
                        && node.association().environment_id() == Some(environment.id())
                })
                .collect::<Vec<_>>();
            let [node] = nodes.as_slice() else {
                return None;
            };

            let managed_resource_id = node.association().managed_resource_id();
            if let Some(managed_resource_id) = managed_resource_id
                && !facts.managed_resources().any(|resource| {
                    resource.id() == managed_resource_id
                        && resource.connection_id() == environment.connection_id()
                        && resource.environment_id() == environment.id()
                })
            {
                return None;
            }

            let agents = topology
                .agents()
                .iter()
                .filter(|agent| {
                    agent.node_id() == node.id() && agent.association() == node.association()
                })
                .collect::<Vec<_>>();
            let [agent] = agents.as_slice() else {
                return None;
            };

            let runtimes = topology
                .runtimes()
                .iter()
                .filter(|runtime| {
                    runtime.node_id() == node.id()
                        && runtime.agent_id() == Some(agent.id())
                        && runtime.association() == node.association()
                })
                .collect::<Vec<_>>();
            let [runtime] = runtimes.as_slice() else {
                return None;
            };

            Some(
                crate::fleet::registration_identity::RegistrationGraphAssociation::new(
                    environment.connection_id().clone(),
                    environment.id().clone(),
                    node.id().clone(),
                    agent.id().clone(),
                    runtime.id().clone(),
                    managed_resource_id.cloned(),
                ),
            )
        });
        let identity_facts = crate::fleet::registration_identity::RegistrationIdentityFacts::from_environment_graphs(graphs)
            .unwrap_or_default();
        crate::fleet::registration_identity::RegistrationIdentityAuthority::new(identity_facts)
    }

    pub(crate) fn snapshot(&self, now: SystemTime) -> FleetSnapshot {
        FleetSnapshot {
            query: self.query_snapshot(now),
            topology: self.topology_summary(),
            sessions: self.terminal_list(),
            updated_at: now,
        }
    }

    pub(crate) fn selector_preview(
        &self,
        constraints: SelectorConstraints,
        now: SystemTime,
    ) -> SelectorPreview {
        FleetQuerySnapshot::selector_preview(
            self.delivery.facts().topology(),
            self.delivery.facts().leases(),
            constraints,
            now,
        )
    }

    pub(crate) fn put_target(
        &mut self,
        id: TargetId,
        config: FleetTargetConfig,
    ) -> Result<TargetSnapshot, FleetDeliveryError> {
        self.delivery.put_target(id, config)
    }

    pub(crate) fn remove_target(&mut self, id: &TargetId) -> Result<bool, FleetDeliveryError> {
        self.delivery.remove_target(id)
    }

    pub(crate) fn bind_target_endpoint(
        &mut self,
        binding: fleet::TargetEndpointBinding,
    ) -> Result<(), FleetDeliveryError> {
        self.delivery.bind_target_endpoint(binding)
    }

    pub(crate) fn bind_target_endpoint_from_registration(
        &mut self,
        request: crate::fleet::registration_identity::TargetEndpointBindingRequest,
    ) -> Result<(), FleetDeliveryError> {
        let binding = crate::fleet::registration_identity::TargetEndpointBindingProducer::produce(
            self.delivery.facts(),
            request,
        )
        .map_err(|_| FleetDeliveryError::InvalidTransition)?;
        self.bind_target_endpoint(binding)
    }

    pub(crate) fn submit(
        &mut self,
        request: FleetDeliveryRequest,
        at: SystemTime,
    ) -> Result<FleetSubmitOutcome, FleetDeliveryError> {
        self.delivery.submit(request, at)
    }

    pub(crate) fn node_command_request(
        &self,
        request: FleetNodeCommandRequest,
        queued_at: SystemTime,
    ) -> Result<FleetNodeCommandResolution, FleetDeliveryError> {
        let topology = self.delivery.facts().topology();
        let node = topology
            .nodes()
            .iter()
            .find(|node| node.id() == &request.node_id)
            .ok_or(FleetDeliveryError::CommandNotFound)?;
        if node.metadata().freshness() != ObservationFreshness::Current {
            return Err(FleetDeliveryError::DispatchRequest);
        }

        let mut resolved = None;
        for snapshot in self.delivery.facts().target_snapshots() {
            let Some(binding) = self.delivery.facts().target_binding(snapshot.id()) else {
                continue;
            };
            if binding.target_revision() != snapshot.revision() {
                continue;
            }
            let Some(endpoint) = topology.endpoint(binding.endpoint_id()) else {
                continue;
            };
            if endpoint.node_id() != &request.node_id
                || endpoint.metadata().freshness() != ObservationFreshness::Current
                || !matches!(endpoint.health(), EndpointHealth::Ready)
            {
                continue;
            }
            if resolved.is_some() {
                return Err(FleetDeliveryError::DispatchRequest);
            }
            let Some(runtime) = topology.runtime(endpoint.runtime_id()) else {
                return Err(FleetDeliveryError::DispatchRequest);
            };
            let Some(agent_id) = runtime.agent_id().cloned() else {
                return Err(FleetDeliveryError::DispatchRequest);
            };
            let selector = snapshot.selector();
            let command = CommandIntent::new(
                request.command_id.clone(),
                request.idempotency_key.clone(),
                CommandTarget::Node(request.node_id.clone()),
                request.kind,
                queued_at,
            );
            let dispatch = DispatchIntent::for_target(
                request.dispatch_id.clone(),
                request.command_id.clone(),
                agent_id,
                selector.clone(),
            );
            let delivery = FleetDeliveryRequest::try_new(command, dispatch)
                .map_err(|_| FleetDeliveryError::MismatchedDispatchCommand)?;
            resolved = Some(FleetNodeCommandResolution {
                request: delivery,
                dispatch_id: request.dispatch_id.clone(),
                selector,
            });
        }

        resolved.ok_or(FleetDeliveryError::DispatchRequest)
    }

    pub(crate) fn begin(
        &mut self,
        dispatch_id: &DispatchId,
        at: SystemTime,
    ) -> Result<fleet::FleetDispatchRequest, FleetDeliveryError> {
        self.delivery.begin_dispatch(dispatch_id, at)
    }

    pub(crate) async fn dispatch(
        &mut self,
        dispatch_id: &DispatchId,
        at: SystemTime,
    ) -> Result<FleetDispatchResult, FleetDeliveryError> {
        let request = self.delivery.begin_dispatch(dispatch_id, at)?;
        let attempt = request.attempt().clone();
        let correlation = fleet::runtime_agent::CommandCorrelation::new(
            request.command_id().clone(),
            request.command().idempotency_key().clone(),
        );
        let command_attempt = fleet::command::CommandAttempt::try_new(attempt.sequence())
            .map_err(|_| FleetDeliveryError::AttemptConflict)?;
        if let Err(error) = self.delivery.register_runtime_agent_command(
            request.agent_id(),
            correlation,
            request.command().queued_at(),
            command_attempt,
            attempt.clone(),
        ) {
            if self
                .delivery
                .reject_dispatch(dispatch_id, &attempt, at)
                .is_err()
            {
                let _ = self
                    .delivery
                    .mark_outcome_unknown(dispatch_id, &attempt, at);
            }
            return Err(error);
        }
        let runtime_agent_callback = fleet::reachability::RuntimeAgentReachabilityAdapter
            .resolve(self.delivery.facts(), request.agent_id(), at)
            .ok();
        let outcome = {
            let executor = &self.executor;
            let resolver = &mut self.credentials;
            {
                let boundary = match executor.prepare(&request, runtime_agent_callback) {
                    Ok(boundary) => boundary,
                    Err(_) => {
                        self.delivery.reject_dispatch(dispatch_id, &attempt, at)?;
                        return Ok(FleetDispatchResult {
                            dispatch_id: dispatch_id.clone(),
                            attempt,
                            outcome: crate::fleet::executor::FleetExecutionOutcome::Rejected,
                        });
                    }
                };
                executor.execute(&boundary, resolver).await
            }
        };
        let terminal = match outcome {
            crate::fleet::executor::FleetExecutionOutcome::Completed => {
                self.delivery.accept_dispatch(dispatch_id, &attempt, at)
            }
            crate::fleet::executor::FleetExecutionOutcome::Rejected => {
                self.delivery.reject_dispatch(dispatch_id, &attempt, at)
            }
            crate::fleet::executor::FleetExecutionOutcome::Unknown => self
                .delivery
                .mark_outcome_unknown(dispatch_id, &attempt, at),
            crate::fleet::executor::FleetExecutionOutcome::Accepted => {
                // RuntimeAgent accepted the durable command. Completion is owned by
                // the authenticated result ingress, not by this accept response.
                return Ok(FleetDispatchResult {
                    dispatch_id: dispatch_id.clone(),
                    attempt,
                    outcome,
                });
            }
        }?;
        let _ = terminal;
        Ok(FleetDispatchResult {
            dispatch_id: dispatch_id.clone(),
            attempt,
            outcome,
        })
    }

    pub(crate) fn accept(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.delivery.accept_dispatch(dispatch_id, attempt, at)
    }

    pub(crate) fn reject(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.delivery.reject_dispatch(dispatch_id, attempt, at)
    }

    pub(crate) fn mark_unknown(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.delivery.mark_outcome_unknown(dispatch_id, attempt, at)
    }

    pub(crate) fn authorize_replay(
        &mut self,
        command_id: &CommandId,
        dispatch_id: &DispatchId,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.delivery.authorize_replay(command_id, dispatch_id, at)
    }

    pub(crate) fn authenticate_runtime_agent_ingress(
        &mut self,
        identity: fleet::store::AgentIngressIdentity,
    ) -> Result<fleet::store::IngressAuthentication, FleetDeliveryError> {
        self.delivery.authenticate_or_enroll_ingress(identity)
    }

    pub(crate) fn register_runtime_agent(
        &mut self,
        agent: fleet::runtime_agent::RuntimeAgent,
    ) -> Result<(), FleetDeliveryError> {
        self.delivery.register_runtime_agent(agent)
    }

    pub(crate) fn register_runtime_agent_command(
        &mut self,
        agent_id: &fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        queued_at: SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: DispatchAttempt,
    ) -> Result<(), FleetDeliveryError> {
        self.delivery.register_runtime_agent_command(
            agent_id,
            correlation,
            queued_at,
            command_attempt,
            dispatch_attempt,
        )
    }

    pub(crate) fn record_runtime_agent_heartbeat(
        &mut self,
        agent_id: &fleet::runtime_agent::RuntimeAgentId,
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
    ) -> Result<fleet::runtime_agent::RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.delivery
            .record_runtime_agent_heartbeat(agent_id, heartbeat)
    }

    pub(crate) fn record_runtime_agent_progress(
        &mut self,
        agent_id: &fleet::runtime_agent::RuntimeAgentId,
        correlation: &fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: SystemTime,
        command_attempt: &fleet::command::CommandAttempt,
        dispatch_attempt: &DispatchAttempt,
    ) -> Result<fleet::runtime_agent::RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.delivery.record_runtime_agent_progress(
            agent_id,
            correlation,
            progress,
            reported_at,
            command_attempt,
            dispatch_attempt,
        )
    }

    pub(crate) fn record_runtime_agent_result(
        &mut self,
        agent_id: &fleet::runtime_agent::RuntimeAgentId,
        correlation: &fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: &fleet::command::CommandAttempt,
        dispatch_attempt: &DispatchAttempt,
    ) -> Result<fleet::runtime_agent::RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.delivery.record_runtime_agent_result(
            agent_id,
            correlation,
            result,
            command_attempt,
            dispatch_attempt,
        )
    }

    pub(crate) fn upsert_connection(
        &mut self,
        record: ConnectionRecord,
        now: SystemTime,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.delivery.upsert_connection(record, now)
    }
    pub(crate) fn delete_connection(
        &mut self,
        id: &ConnectionId,
        now: SystemTime,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.delivery.delete_connection(id, now)
    }
    pub(crate) fn begin_connection_probe(
        &mut self,
        id: &ConnectionId,
        command_id: CommandId,
        now: SystemTime,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.delivery.begin_connection_probe(id, command_id, now)
    }
    pub(crate) fn complete_connection_probe(
        &mut self,
        id: &ConnectionId,
        command_id: &CommandId,
        outcome: ProbeOutcome,
        observed_at: SystemTime,
        message: Option<String>,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.delivery
            .complete_connection_probe(id, command_id, outcome, observed_at, message)
    }
    pub(crate) fn register_environment(
        &mut self,
        record: EnvironmentRecord,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery.register_environment(record, now)
    }
    pub(crate) fn start_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery
            .start_environment_deployment(id, command_id, phase, now)
    }
    pub(crate) fn complete_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery
            .complete_environment_deployment(id, command_id, phase, ready_at)
    }
    pub(crate) fn fail_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery
            .fail_environment_deployment(id, command_id, phase, message, failed_at)
    }
    pub(crate) fn start_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery
            .start_environment_deletion(id, command_id, phase, now)
    }
    pub(crate) fn complete_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery
            .complete_environment_deletion(id, command_id, phase, deleted_at)
    }
    pub(crate) fn fail_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.delivery
            .fail_environment_deletion(id, command_id, phase, message, failed_at)
    }
    pub(crate) fn register_managed_resource(
        &mut self,
        resource: ManagedResourceRecord,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery.register_managed_resource(resource)
    }

    pub(crate) async fn register_source_backed_resource(
        &mut self,
        request: ManagedResourceRegistrationRequest,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        let environment = self
            .delivery
            .facts()
            .environments()
            .find(|environment| environment.id() == &request.environment_id)
            .ok_or(FleetDeliveryError::InvalidTransition)?;
        if environment.connection_id() != &request.connection_id {
            return Err(FleetDeliveryError::InvalidTransition);
        }
        let expected_environment_kind = match (request.provider, request.kind) {
            (ManagedResourceProvider::Docker, ManagedResourceKind::DockerContainer) => {
                fleet::environment::EnvironmentKind::DockerContainer
            }
            (ManagedResourceProvider::Kubernetes, ManagedResourceKind::KubernetesWorkload) => {
                fleet::environment::EnvironmentKind::KubernetesWorkload
            }
            _ => return Err(FleetDeliveryError::InvalidTransition),
        };
        if environment.kind() != expected_environment_kind {
            return Err(FleetDeliveryError::InvalidTransition);
        }
        let target = self
            .environment_target_resolution(&request.environment_id)
            .ok_or(FleetDeliveryError::InvalidTransition)?;
        let expected_target_kind = match (request.provider, request.kind, &target.config) {
            (
                ManagedResourceProvider::Docker,
                ManagedResourceKind::DockerContainer,
                FleetTargetConfig::Docker(_),
            )
            | (
                ManagedResourceProvider::Kubernetes,
                ManagedResourceKind::KubernetesWorkload,
                FleetTargetConfig::Kubernetes(_),
            ) => (request.provider, request.kind),
            _ => return Err(FleetDeliveryError::InvalidTransition),
        };
        let observed_at = SystemTime::now();
        let fact = match &target.config {
            FleetTargetConfig::Docker(config) => {
                let client = crate::fleet::docker::DockerEffectClient::new(
                    config.clone(),
                    self.docker_ownership.clone(),
                )
                .map_err(|_| FleetDeliveryError::InvalidTransition)?;
                client
                    .readback_resource(&mut self.credentials, observed_at)
                    .await
                    .map_err(|_| FleetDeliveryError::InvalidTransition)?
                    .fact()
                    .cloned()
                    .ok_or(FleetDeliveryError::InvalidTransition)?
            }
            FleetTargetConfig::Kubernetes(config) => {
                let client = crate::fleet::kubernetes::KubernetesEffectClient::new(
                    config.clone(),
                    self.docker_ownership.clone(),
                )
                .map_err(|_| FleetDeliveryError::InvalidTransition)?;
                client
                    .readback_resource(&mut self.credentials, observed_at)
                    .await
                    .map_err(|_| FleetDeliveryError::InvalidTransition)?
                    .fact()
                    .cloned()
                    .ok_or(FleetDeliveryError::InvalidTransition)?
            }
            FleetTargetConfig::Ssh(_) | FleetTargetConfig::Custom(_) => {
                return Err(FleetDeliveryError::InvalidTransition);
            }
        };
        let (provider, kind) = provider_resource_kind(&fact)?;
        if (provider, kind) != expected_target_kind
            || request.remote_resource_id != fact.remote_id()
            || request.ownership != Ownership::MatchaManaged
        {
            return Err(FleetDeliveryError::InvalidTransition);
        }
        match (&target.config, fact.association()) {
            (
                FleetTargetConfig::Docker(config),
                crate::fleet::provider_resource::ProviderResourceAssociation::DockerContainer {
                    name,
                },
            ) if name == config.container_name() => {}
            (
                FleetTargetConfig::Kubernetes(config),
                crate::fleet::provider_resource::ProviderResourceAssociation::KubernetesWorkload {
                    namespace,
                    deployment_name,
                    service_name,
                },
            ) if namespace == config.namespace()
                && deployment_name == config.deployment_name()
                && service_name == config.service_name() => {}
            _ => return Err(FleetDeliveryError::InvalidTransition),
        }
        let metadata = provider_resource_metadata(&fact)?;
        let id = crate::fleet::managed_resource_identity::ManagedResourceIdentityProducer::allocate_opaque_id(
            self.delivery.facts(),
        )
        .map_err(|_| FleetDeliveryError::InvalidTransition)?;
        let authority =
            crate::fleet::managed_resource_identity::ManagedResourceAllocationAuthority::allocate(
                id.clone(),
                request.connection_id.clone(),
                request.environment_id.clone(),
                request.ownership,
                request.cleanup_policy,
            );
        let resolution =
            crate::fleet::managed_resource_identity::ManagedResourceIdentityProducer::resolve(
                self.delivery.facts(),
                &authority,
                &fact,
            )
            .map_err(|_| FleetDeliveryError::InvalidTransition)?;
        match resolution {
            crate::fleet::managed_resource_identity::ManagedResourceIdentityResolution::Reused(id) => self
                .delivery
                .refresh_observed_managed_resource(
                    &id,
                    metadata,
                    fact.observed_at(),
                    &request.connection_id,
                    &request.environment_id,
                ),
            crate::fleet::managed_resource_identity::ManagedResourceIdentityResolution::Allocated(id) => {
                let resource = ManagedResourceRecord::with_metadata_observed(
                    id,
                    request.connection_id,
                    request.environment_id,
                    provider,
                    kind,
                    fact.remote_id().to_owned(),
                    request.ownership,
                    request.cleanup_policy,
                    metadata,
                    environment.created_at(),
                    fact.observed_at(),
                )
                .map_err(|_| FleetDeliveryError::InvalidTransition)?;
                self.delivery.register_observed_managed_resource(resource)
            }
        }
    }

    pub(crate) fn materialize_provider_resource(
        &mut self,
        existing_id: &ManagedResourceId,
        fact: crate::fleet::provider_resource::ProviderResourceFact,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        let resource = self
            .delivery
            .facts()
            .managed_resources()
            .find(|resource| resource.id() == existing_id)
            .ok_or(FleetDeliveryError::InvalidTransition)?;
        let authority =
            crate::fleet::managed_resource_identity::ManagedResourceAllocationAuthority::existing(
                existing_id.clone(),
                resource.connection_id().clone(),
                resource.environment_id().clone(),
                resource.ownership(),
                resource.cleanup_policy(),
            );
        let resolution =
            crate::fleet::managed_resource_identity::ManagedResourceIdentityProducer::resolve(
                self.delivery.facts(),
                &authority,
                &fact,
            )
            .map_err(|_| FleetDeliveryError::InvalidTransition)?;
        if resolution.id() != existing_id {
            return Err(FleetDeliveryError::InvalidTransition);
        }
        let (command_id, phase) = match resource.state() {
            fleet::environment::ManagedResourceState::Provisioning { command_id, phase } => {
                (command_id.clone(), phase.clone())
            }
            _ => return Err(FleetDeliveryError::InvalidTransition),
        };
        let metadata = provider_resource_metadata(&fact)?;
        self.delivery.materialize_resource_provisioning(
            existing_id,
            &command_id,
            &phase,
            metadata,
            now,
        )
    }

    pub(crate) fn materialize_provider_environment(
        &mut self,
        environment_id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        fact: crate::fleet::provider_resource::ProviderResourceFact,
        ready_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        let environment = self
            .delivery
            .facts()
            .environments()
            .find(|environment| environment.id() == environment_id)
            .ok_or(FleetDeliveryError::InvalidTransition)?;
        let connection_id = environment.connection_id().clone();
        let metadata = provider_resource_metadata(&fact)?;
        let (provider, kind) = provider_resource_kind(&fact)?;
        let id = crate::fleet::managed_resource_identity::ManagedResourceIdentityProducer::allocate_opaque_id(
            self.delivery.facts(),
        )
        .map_err(|_| FleetDeliveryError::InvalidTransition)?;
        let authority =
            crate::fleet::managed_resource_identity::ManagedResourceAllocationAuthority::allocate(
                id,
                connection_id.clone(),
                environment_id.clone(),
                Ownership::MatchaManaged,
                CleanupPolicy::DeleteOnEnvironmentDelete,
            );
        let resolution =
            crate::fleet::managed_resource_identity::ManagedResourceIdentityProducer::resolve(
                self.delivery.facts(),
                &authority,
                &fact,
            )
            .map_err(|_| FleetDeliveryError::InvalidTransition)?;
        match resolution {
            crate::fleet::managed_resource_identity::ManagedResourceIdentityResolution::Reused(id) => self
                .delivery
                .materialize_reused_environment_deployment(
                    environment_id,
                    &id,
                    metadata,
                    fact.observed_at(),
                    &connection_id,
                    command_id,
                    phase,
                    ready_at,
                ),
            crate::fleet::managed_resource_identity::ManagedResourceIdentityResolution::Allocated(id) => {
                let resource = ManagedResourceRecord::with_metadata_ready(
                    id,
                    connection_id,
                    environment_id.clone(),
                    provider,
                    kind,
                    fact.remote_id().to_owned(),
                    Ownership::MatchaManaged,
                    CleanupPolicy::DeleteOnEnvironmentDelete,
                    metadata,
                    environment.created_at(),
                    ready_at,
                )
                .map_err(|_| FleetDeliveryError::InvalidTransition)?;
                self.delivery.materialize_environment_deployment(
                    environment_id,
                    resource,
                    command_id,
                    phase,
                    ready_at,
                )
            }
        }
    }
    pub(crate) fn cleanup_resource_ids(
        &mut self,
        environment_id: &EnvironmentId,
    ) -> Result<Vec<ManagedResourceId>, FleetDeliveryError> {
        self.delivery.cleanup_resource_ids(environment_id)
    }
    pub(crate) fn start_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery
            .start_resource_provisioning(id, command_id, phase, now)
    }
    pub(crate) fn fail_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery
            .fail_resource_provisioning(id, command_id, phase, message, failed_at)
    }

    pub(crate) fn complete_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery
            .complete_resource_provisioning(id, command_id, phase, observed_at)
    }
    pub(crate) fn start_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery
            .start_resource_deletion(id, command_id, phase, now)
    }
    pub(crate) fn complete_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery
            .complete_resource_deletion(id, command_id, phase, deleted_at)
    }
    pub(crate) fn fail_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.delivery
            .fail_resource_deletion(id, command_id, phase, message, failed_at)
    }
    pub(crate) fn insert_effect(&mut self, record: EffectRecord) -> Result<(), FleetDeliveryError> {
        self.delivery.insert_effect(record)
    }
    pub(crate) fn insert_and_begin_effect(
        &mut self,
        record: EffectRecord,
    ) -> Result<(EffectIdentity, fleet::command::CommandAttempt), FleetDeliveryError> {
        self.delivery.insert_and_begin_effect(record)
    }
    pub(crate) fn begin_effect(
        &mut self,
        identity: &EffectIdentity,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.delivery.begin_effect(identity)
    }
    pub(crate) fn accept_effect(
        &mut self,
        identity: &EffectIdentity,
        receipt: &EffectReceipt,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.delivery.accept_effect(identity, receipt)
    }
    pub(crate) fn reject_effect(
        &mut self,
        identity: &EffectIdentity,
        receipt: &EffectReceipt,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.delivery.reject_effect(identity, receipt)
    }
    pub(crate) fn mark_effect_unknown(
        &mut self,
        identity: &EffectIdentity,
        now: SystemTime,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.delivery.mark_effect_unknown(identity, now)
    }
    pub(crate) fn mark_effect_unknown_attempt(
        &mut self,
        identity: &EffectIdentity,
        attempt: &fleet::command::CommandAttempt,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.delivery.mark_effect_unknown_attempt(identity, attempt)
    }
    pub(crate) fn authorize_effect_replay(
        &mut self,
        identity: &EffectIdentity,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.delivery.authorize_effect_replay(identity)
    }

    pub(crate) fn upsert_node(
        &mut self,
        observation: NodeObservation,
        now: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.upsert_node(observation, now);
        result
    }
    pub(crate) fn retire_node(
        &mut self,
        id: &NodeId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.retire_node(id, at);
        result
    }
    pub(crate) fn upsert_agent(
        &mut self,
        observation: AgentObservation,
        now: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.upsert_agent(observation, now);
        result
    }
    pub(crate) fn enroll_agent(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.enroll_agent(id, at);
        result
    }

    pub(crate) fn revoke_agent(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.revoke_agent(id, at);
        result
    }
    pub(crate) fn upsert_runtime(
        &mut self,
        observation: RuntimeObservation,
        now: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.upsert_runtime(observation, now);
        result
    }
    pub(crate) fn begin_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.begin_runtime_start(id, command, at);
        result
    }
    pub(crate) fn complete_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.complete_runtime_start(id, command, at);
        result
    }
    pub(crate) fn begin_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.begin_runtime_stop(id, command, at);
        result
    }
    pub(crate) fn complete_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.complete_runtime_stop(id, command, at);
        result
    }
    pub(crate) fn retire_runtime(
        &mut self,
        id: &RuntimeId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.retire_runtime(id, at);
        result
    }
    pub(crate) fn upsert_endpoint(
        &mut self,
        observation: EndpointObservation,
        now: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.upsert_endpoint(observation, now);
        result
    }
    pub(crate) fn drain_endpoint(
        &mut self,
        id: &platform::endpoint::EndpointId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.drain_endpoint(id, at);
        result
    }
    pub(crate) fn retire_endpoint(
        &mut self,
        id: &platform::endpoint::EndpointId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.retire_endpoint(id, at);
        result
    }
    pub(crate) fn begin_endpoint_probe(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.begin_endpoint_probe(id, command, at);
        result
    }
    pub(crate) fn complete_endpoint_probe(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: &CommandId,
        health: EndpointHealth,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self
            .delivery
            .complete_endpoint_probe(id, command, health, at);
        result
    }
    pub(crate) fn begin_capability_sync(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self.delivery.begin_capability_sync(id, command, at);
        result
    }
    pub(crate) fn complete_capability_sync(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: &CommandId,
        sync: CapabilitySync,
        at: SystemTime,
    ) -> Result<fleet::topology::TopologyMutation, FleetDeliveryError> {
        let result = self
            .delivery
            .complete_capability_sync(id, command, sync, at);
        result
    }
}

impl OwnerSpec for FleetOwner {
    type Command = FleetCommand;
    type Query = FleetQuery;
    type Key = FleetLaneKey;
    type Shared = FleetShared;
    type GlobalState = FleetOwner;
    type LaneState = FleetLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        let shared = FleetShared {
            facts_path: self.facts_path.clone(),
            private_root: self.private_root.clone(),
            docker_ownership: self.docker_ownership.clone(),
            ssh_host_keys: self.ssh_host_keys.clone(),
        };
        (shared, self)
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        command.route_command()
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        query.route_query()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        FleetLaneState
    }

    async fn handle_keyed_command(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        let now = SystemTime::now();
        let mut owner = match shared.open_operation_owner() {
            Ok(owner) => owner,
            Err(error) => {
                send_keyed_delivery_error(command, error);
                return;
            }
        };
        match command {
            FleetCommand::TerminalProviderOpen {
                target_id,
                context,
                reply,
            } => {
                let result = match TargetId::try_from(context.target.as_str()) {
                    Ok(context_target_id) if context_target_id == target_id => {
                        owner.terminal_provider_open(context).await
                    }
                    _ => Err(()),
                };
                let _ = reply.send(result);
            }
            FleetCommand::Begin {
                target_id,
                dispatch_id,
                reply,
            } => {
                let result = match owner.dispatch_target_id(&dispatch_id) {
                    Ok(resolved) if resolved == target_id => {
                        owner.dispatch(&dispatch_id, now).await
                    }
                    Ok(_) => Err(FleetDeliveryError::InvalidTransition),
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }
            FleetCommand::Accept {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(owner.accept(&dispatch_id, &attempt, now));
            }
            FleetCommand::Reject {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(owner.reject(&dispatch_id, &attempt, now));
            }
            FleetCommand::Unknown {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(owner.mark_unknown(&dispatch_id, &attempt, now));
            }
            FleetCommand::Replay {
                command_id,
                dispatch_id,
                reply,
            } => {
                let _ = reply.send(owner.authorize_replay(&command_id, &dispatch_id, now));
            }
            FleetCommand::BeginConnectionProbe {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(owner.begin_connection_probe(&id, command_id, now));
            }
            FleetCommand::RunConnectionProbe {
                target_id,
                id,
                command_id,
                reply,
            } => {
                let result = match owner.connection_target_id(&id) {
                    Ok(resolved) if resolved == target_id => {
                        crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                            .probe_connection(id, command_id, now)
                            .await
                    }
                    Ok(_) => Err(FleetDeliveryError::InvalidTransition),
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }
            FleetCommand::CompleteConnectionProbe {
                id,
                command_id,
                outcome,
                message,
                reply,
            } => {
                let _ = reply.send(owner.complete_connection_probe(
                    &id,
                    &command_id,
                    outcome,
                    now,
                    message,
                ));
            }
            FleetCommand::RunEnvironmentDeployment {
                target_id,
                id,
                command_id,
                phase,
                reply,
            } => {
                let result = async {
                    let target = owner
                        .environment_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    if target.selector.id() != &target_id {
                        return Err(FleetDeliveryError::InvalidTransition);
                    }
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                        .deploy_environment(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunEnvironmentDeletion {
                target_id,
                id,
                command_id,
                phase,
                reply,
            } => {
                let result = async {
                    let target = owner
                        .environment_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    if target.selector.id() != &target_id {
                        return Err(FleetDeliveryError::InvalidTransition);
                    }
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                        .delete_environment(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunResourceProvisioning {
                target_id,
                id,
                command_id,
                phase,
                reply,
            } => {
                let result = async {
                    let target = owner
                        .resource_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    if target.selector.id() != &target_id {
                        return Err(FleetDeliveryError::InvalidTransition);
                    }
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                        .provision_resource(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunResourceDeletion {
                target_id,
                id,
                command_id,
                phase,
                reply,
            } => {
                let result = async {
                    let target = owner
                        .resource_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    if target.selector.id() != &target_id {
                        return Err(FleetDeliveryError::InvalidTransition);
                    }
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                        .delete_resource(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::BeginEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(owner.start_environment_deployment(&id, command_id, phase, now));
            }
            FleetCommand::CompleteEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(owner.complete_environment_deployment(
                    &id,
                    &command_id,
                    &phase,
                    now,
                ));
            }
            FleetCommand::FailEnvironmentDeployment {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(owner.fail_environment_deployment(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::BeginEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(owner.start_environment_deletion(&id, command_id, phase, now));
            }
            FleetCommand::CompleteEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(owner.complete_environment_deletion(&id, &command_id, &phase, now));
            }
            FleetCommand::FailEnvironmentDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(owner.fail_environment_deletion(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::StartResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(owner.start_resource_provisioning(&id, command_id, phase, now));
            }
            FleetCommand::FailResourceProvisioning {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(owner.fail_resource_provisioning(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::CompleteResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(owner.complete_resource_provisioning(&id, &command_id, &phase, now));
            }
            FleetCommand::StartResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(owner.start_resource_deletion(&id, command_id, phase, now));
            }
            FleetCommand::CompleteResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(owner.complete_resource_deletion(&id, &command_id, &phase, now));
            }
            FleetCommand::FailResourceDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(owner.fail_resource_deletion(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            _ => unreachable!("Fleet command was routed to an incompatible keyed lane"),
        }
    }

    async fn handle_global_command(
        _shared: Self::Shared,
        global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        let now = SystemTime::now();
        match command {
            FleetCommand::TerminalOpenAllocated {
                selector,
                dimensions,
                reply,
            } => {
                let _ = reply.send(global.terminal_open_allocated(&selector, dimensions, now));
            }
            FleetCommand::TerminalConsumeTicket { ticket, reply } => {
                let _ = reply.send(global.terminal_consume_ticket(&ticket, now));
            }
            FleetCommand::TerminalProviderOpen { context, reply, .. } => {
                let _ = reply.send(global.terminal_provider_open(context).await);
            }
            FleetCommand::TerminalClose {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(global.terminal_close(&session, generation, now));
            }
            FleetCommand::TerminalFail {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(global.terminal_fail(&session, generation, now));
            }
            FleetCommand::TerminalCloseCurrent { session, reply } => {
                let result = current_terminal_generation(global, &session)
                    .and_then(|generation| global.terminal_close(&session, generation, now));
                let _ = reply.send(result);
            }
            FleetCommand::TerminalBeginCloseCurrent { session, reply } => {
                let result = current_terminal_generation(global, &session)
                    .and_then(|generation| global.terminal_begin_close(&session, generation, now));
                let _ = reply.send(result);
            }
            FleetCommand::TerminalFinishCloseCurrent { session, reply } => {
                let result = current_terminal_generation(global, &session)
                    .and_then(|generation| global.terminal_finish_close(&session, generation, now));
                let _ = reply.send(result);
            }
            FleetCommand::TerminalReconnect { session, reply } => {
                let _ = reply.send(global.terminal_reconnect(session, now));
            }
            FleetCommand::TerminalBeginClose {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(global.terminal_begin_close(&session, generation, now));
            }
            FleetCommand::TerminalFinishClose {
                session,
                generation,
                reply,
            } => {
                let _ = reply.send(global.terminal_finish_close(&session, generation, now));
            }
            FleetCommand::PutTarget { id, config, reply } => {
                let _ = reply.send(global.put_target(id, config));
            }
            FleetCommand::RemoveTarget { id, reply } => {
                let _ = reply.send(global.remove_target(&id));
            }
            FleetCommand::Submit { request, reply } => {
                let _ = reply.send(global.submit(request, now));
            }
            FleetCommand::Begin {
                dispatch_id, reply, ..
            } => {
                let _ = reply.send(global.dispatch(&dispatch_id, now).await);
            }
            FleetCommand::Accept {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(global.accept(&dispatch_id, &attempt, now));
            }
            FleetCommand::Reject {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(global.reject(&dispatch_id, &attempt, now));
            }
            FleetCommand::Unknown {
                dispatch_id,
                attempt,
                reply,
            } => {
                let _ = reply.send(global.mark_unknown(&dispatch_id, &attempt, now));
            }
            FleetCommand::Replay {
                command_id,
                dispatch_id,
                reply,
            } => {
                let _ = reply.send(global.authorize_replay(&command_id, &dispatch_id, now));
            }
            FleetCommand::UpsertConnection { record, reply } => {
                let _ = reply.send(global.upsert_connection(record, now));
            }
            FleetCommand::DeleteConnection { id, reply } => {
                let _ = reply.send(global.delete_connection(&id, now));
            }
            FleetCommand::BeginConnectionProbe {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.begin_connection_probe(&id, command_id, now));
            }
            FleetCommand::RunConnectionProbe {
                id,
                command_id,
                reply,
                ..
            } => {
                let result = crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(global)
                    .probe_connection(id, command_id, now)
                    .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
                ..
            } => {
                let result = async {
                    let target = global
                        .environment_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(global)
                        .deploy_environment(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
                ..
            } => {
                let result = async {
                    let target = global
                        .environment_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(global)
                        .delete_environment(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
                ..
            } => {
                let result = async {
                    let target = global
                        .resource_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(global)
                        .provision_resource(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::RunResourceDeletion {
                id,
                command_id,
                phase,
                reply,
                ..
            } => {
                let result = async {
                    let target = global
                        .resource_target_resolution(&id)
                        .ok_or(FleetDeliveryError::InvalidTransition)?;
                    crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(global)
                        .delete_resource(id, command_id, phase, target, now)
                        .await
                        .map(|(_, outcome)| outcome)
                }
                .await;
                let _ = reply.send(result);
            }
            FleetCommand::CompleteConnectionProbe {
                id,
                command_id,
                outcome,
                message,
                reply,
            } => {
                let _ = reply.send(global.complete_connection_probe(
                    &id,
                    &command_id,
                    outcome,
                    now,
                    message,
                ));
            }
            FleetCommand::RegisterEnvironment { record, reply } => {
                let _ = reply.send(global.register_environment(record, now));
            }
            FleetCommand::RegisterResource { request, reply } => {
                let _ = reply.send(global.register_source_backed_resource(request).await);
            }
            FleetCommand::UpsertNode { observation, reply } => {
                let _ = reply.send(global.upsert_node(observation, now));
            }
            FleetCommand::UpsertAgent { observation, reply } => {
                let _ = reply.send(global.upsert_agent(observation, now));
            }
            FleetCommand::WriteCredential { request, reply } => {
                let _ = reply.send(global.write_credential(request));
            }
            FleetCommand::RevokeAgent { id, reply } => {
                let _ = reply.send(global.revoke_agent(&id, now));
            }
            FleetCommand::UpsertRuntime { observation, reply } => {
                let _ = reply.send(global.upsert_runtime(observation, now));
            }
            FleetCommand::UpsertEndpoint { observation, reply } => {
                let _ = reply.send(global.upsert_endpoint(observation, now));
            }
            FleetCommand::RetireNode { id, reply } => {
                let _ = reply.send(global.retire_node(&id, now));
            }
            FleetCommand::BeginRuntimeStart {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.begin_runtime_start(&id, command_id, now));
            }
            FleetCommand::CompleteRuntimeStart {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.complete_runtime_start(&id, &command_id, now));
            }
            FleetCommand::BeginRuntimeStop {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.begin_runtime_stop(&id, command_id, now));
            }
            FleetCommand::CompleteRuntimeStop {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.complete_runtime_stop(&id, &command_id, now));
            }
            FleetCommand::RetireRuntime { id, reply } => {
                let _ = reply.send(global.retire_runtime(&id, now));
            }
            FleetCommand::DrainEndpoint { id, reply } => {
                let _ = reply.send(global.drain_endpoint(&id, now));
            }
            FleetCommand::RetireEndpoint { id, reply } => {
                let _ = reply.send(global.retire_endpoint(&id, now));
            }
            FleetCommand::BeginEndpointProbe {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.begin_endpoint_probe(&id, command_id, now));
            }
            FleetCommand::CompleteEndpointProbe {
                id,
                command_id,
                health,
                reply,
            } => {
                let _ = reply.send(global.complete_endpoint_probe(&id, &command_id, health, now));
            }
            FleetCommand::BeginCapabilitySync {
                id,
                command_id,
                reply,
            } => {
                let _ = reply.send(global.begin_capability_sync(&id, command_id, now));
            }
            FleetCommand::CompleteCapabilitySync {
                id,
                command_id,
                sync,
                reply,
            } => {
                let _ = reply.send(global.complete_capability_sync(&id, &command_id, sync, now));
            }
            FleetCommand::BeginEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(global.start_environment_deployment(&id, command_id, phase, now));
            }
            FleetCommand::CompleteEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(global.complete_environment_deployment(
                    &id,
                    &command_id,
                    &phase,
                    now,
                ));
            }
            FleetCommand::FailEnvironmentDeployment {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(global.fail_environment_deployment(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::BeginEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(global.start_environment_deletion(&id, command_id, phase, now));
            }
            FleetCommand::CompleteEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(global.complete_environment_deletion(&id, &command_id, &phase, now));
            }
            FleetCommand::FailEnvironmentDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(global.fail_environment_deletion(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::StartResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(global.start_resource_provisioning(&id, command_id, phase, now));
            }
            FleetCommand::FailResourceProvisioning {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(global.fail_resource_provisioning(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::CompleteResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(global.complete_resource_provisioning(
                    &id,
                    &command_id,
                    &phase,
                    now,
                ));
            }
            FleetCommand::StartResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ = reply.send(global.start_resource_deletion(&id, command_id, phase, now));
            }
            FleetCommand::CompleteResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            } => {
                let _ =
                    reply.send(global.complete_resource_deletion(&id, &command_id, &phase, now));
            }
            FleetCommand::FailResourceDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            } => {
                let _ = reply.send(global.fail_resource_deletion(
                    &id,
                    &command_id,
                    &phase,
                    message,
                    now,
                ));
            }
            FleetCommand::AuthenticateRuntimeAgentIngress { identity, reply } => {
                let _ = reply.send(global.authenticate_runtime_agent_ingress(identity));
            }
            FleetCommand::RegisterRuntimeAgent { agent, reply } => {
                let _ = reply.send(global.register_runtime_agent(agent));
            }
            FleetCommand::RegisterRuntimeAgentCommand {
                agent_id,
                correlation,
                queued_at,
                command_attempt,
                dispatch_attempt,
                reply,
            } => {
                let _ = reply.send(global.register_runtime_agent_command(
                    &agent_id,
                    correlation,
                    queued_at,
                    command_attempt,
                    dispatch_attempt,
                ));
            }
            FleetCommand::RecordRuntimeAgentHeartbeat {
                agent_id,
                heartbeat,
                reply,
            } => {
                let _ = reply.send(global.record_runtime_agent_heartbeat(&agent_id, heartbeat));
            }
            FleetCommand::RecordRuntimeAgentProgress {
                agent_id,
                correlation,
                progress,
                reported_at,
                command_attempt,
                dispatch_attempt,
                reply,
            } => {
                let _ = reply.send(global.record_runtime_agent_progress(
                    &agent_id,
                    &correlation,
                    progress,
                    reported_at,
                    &command_attempt,
                    &dispatch_attempt,
                ));
            }
            FleetCommand::RecordRuntimeAgentResult {
                agent_id,
                correlation,
                result,
                command_attempt,
                dispatch_attempt,
                reply,
            } => {
                let _ = reply.send(global.record_runtime_agent_result(
                    &agent_id,
                    &correlation,
                    result,
                    &command_attempt,
                    &dispatch_attempt,
                ));
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        _shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        let now = SystemTime::now();
        match query {
            FleetQuery::TerminalContext { summary, reply } => {
                let _ = reply.send(Ok(global.terminal_context(&summary)));
            }
            FleetQuery::TerminalResolveContext {
                selector,
                summary,
                reply,
            } => {
                let _ = reply.send(Ok(global.resolve_terminal_context(&selector, &summary)));
            }
            FleetQuery::TerminalList { reply } => {
                let _ = reply.send(global.terminal_list());
            }
            FleetQuery::QuerySnapshot { now, reply } => {
                let _ = reply.send(Ok(global.query_snapshot(now)));
            }
            FleetQuery::Snapshot { now, reply } => {
                let _ = reply.send(Ok(global.snapshot(now)));
            }
            FleetQuery::SelectorPreview {
                constraints,
                now,
                reply,
            } => {
                let _ = reply.send(Ok(global.selector_preview(constraints, now)));
            }
            FleetQuery::TargetSummaries { reply } => {
                let _ = reply.send(Ok(global.target_summaries()));
            }
            FleetQuery::TargetSelector {
                id,
                revision,
                kind,
                reply,
            } => {
                let _ = reply.send(Ok(global.target_selector(&id, revision, kind)));
            }
            FleetQuery::TopologySummary { reply } => {
                let _ = reply.send(Ok(global.topology_summary()));
            }
            FleetQuery::NodeCommandRequest { request, reply } => {
                let _ = reply.send(global.node_command_request(request, now));
            }
            FleetQuery::DispatchTarget { dispatch_id, reply } => {
                let _ = reply.send(global.dispatch_target_id(&dispatch_id));
            }
            FleetQuery::ConnectionTarget { id, reply } => {
                let _ = reply.send(global.connection_target_id(&id));
            }
            FleetQuery::EnvironmentTarget { id, reply } => {
                let _ = reply.send(global.environment_target_id(&id));
            }
            FleetQuery::ResourceTarget { id, reply } => {
                let _ = reply.send(global.resource_target_id(&id));
            }
        }
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        if let Err(error) = global.refresh_from_store() {
            send_query_delivery_error(query, error);
            return;
        }
        Self::handle_global_query(shared, global, query).await;
    }
}

fn send_query_delivery_error(query: FleetQuery, error: FleetDeliveryError) {
    match query {
        FleetQuery::TerminalContext { reply, .. }
        | FleetQuery::TerminalResolveContext { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::QuerySnapshot { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::Snapshot { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::SelectorPreview { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::TargetSummaries { reply } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::TargetSelector { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::TopologySummary { reply } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::NodeCommandRequest { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::DispatchTarget { reply, .. }
        | FleetQuery::ConnectionTarget { reply, .. }
        | FleetQuery::EnvironmentTarget { reply, .. }
        | FleetQuery::ResourceTarget { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetQuery::TerminalList { reply } => {
            let _ = reply.send(Vec::new());
        }
    }
}

fn send_keyed_delivery_error(command: FleetCommand, error: FleetDeliveryError) {
    match command {
        FleetCommand::TerminalProviderOpen { reply, .. } => {
            let _ = reply.send(Err(()));
        }
        FleetCommand::Begin { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::Accept { reply, .. }
        | FleetCommand::Reject { reply, .. }
        | FleetCommand::Unknown { reply, .. }
        | FleetCommand::Replay { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::BeginConnectionProbe { reply, .. }
        | FleetCommand::CompleteConnectionProbe { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::RunConnectionProbe { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::RunEnvironmentDeployment { reply, .. }
        | FleetCommand::RunEnvironmentDeletion { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::BeginEnvironmentDeployment { reply, .. }
        | FleetCommand::CompleteEnvironmentDeployment { reply, .. }
        | FleetCommand::FailEnvironmentDeployment { reply, .. }
        | FleetCommand::BeginEnvironmentDeletion { reply, .. }
        | FleetCommand::CompleteEnvironmentDeletion { reply, .. }
        | FleetCommand::FailEnvironmentDeletion { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::RunResourceProvisioning { reply, .. }
        | FleetCommand::RunResourceDeletion { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        FleetCommand::StartResourceProvisioning { reply, .. }
        | FleetCommand::FailResourceProvisioning { reply, .. }
        | FleetCommand::CompleteResourceProvisioning { reply, .. }
        | FleetCommand::StartResourceDeletion { reply, .. }
        | FleetCommand::CompleteResourceDeletion { reply, .. }
        | FleetCommand::FailResourceDeletion { reply, .. } => {
            let _ = reply.send(Err(error));
        }
        _ => unreachable!("Fleet non-keyed command cannot be rejected as keyed"),
    }
}

fn current_terminal_generation(
    owner: &FleetOwner,
    session: &TerminalSessionId,
) -> Result<Generation, TerminalSessionError> {
    owner
        .terminal_list()
        .into_iter()
        .find(|summary| summary.id() == session)
        .map(|summary| summary.generation())
        .ok_or(TerminalSessionError::NotFound)
}

fn connection_kind_matches_target(
    connection_kind: ConnectionKind,
    target_kind: fleet::TargetKind,
) -> bool {
    matches!(
        (connection_kind, target_kind),
        (
            ConnectionKind::SshHost | ConnectionKind::Vm,
            fleet::TargetKind::Ssh
        ) | (ConnectionKind::Container, fleet::TargetKind::Docker)
            | (ConnectionKind::KubernetesPod, fleet::TargetKind::Kubernetes)
            | (ConnectionKind::Custom, fleet::TargetKind::Custom)
    )
}

fn provider_resource_kind(
    fact: &crate::fleet::provider_resource::ProviderResourceFact,
) -> Result<(ManagedResourceProvider, ManagedResourceKind), FleetDeliveryError> {
    match (fact.provider(), fact.kind()) {
        (
            crate::fleet::provider_resource::ProviderResourceProvider::Docker,
            crate::fleet::provider_resource::ProviderResourceKind::DockerContainer,
        ) => Ok((
            ManagedResourceProvider::Docker,
            ManagedResourceKind::DockerContainer,
        )),
        (
            crate::fleet::provider_resource::ProviderResourceProvider::Kubernetes,
            crate::fleet::provider_resource::ProviderResourceKind::KubernetesWorkload,
        ) => Ok((
            ManagedResourceProvider::Kubernetes,
            ManagedResourceKind::KubernetesWorkload,
        )),
        _ => Err(FleetDeliveryError::InvalidTransition),
    }
}

fn provider_resource_metadata(
    fact: &crate::fleet::provider_resource::ProviderResourceFact,
) -> Result<ManagedResourceMetadata, FleetDeliveryError> {
    provider_resource_kind(fact)?;
    let remote_refs = fact
        .refs()
        .iter()
        .map(|reference| {
            if reference.provider() != fact.provider() {
                return Err(FleetDeliveryError::InvalidTransition);
            }
            let kind = match reference.kind() {
                crate::fleet::provider_resource::ProviderResourceKind::DockerContainer => {
                    ManagedResourceKind::DockerContainer
                }
                crate::fleet::provider_resource::ProviderResourceKind::KubernetesWorkload => {
                    ManagedResourceKind::KubernetesWorkload
                }
                crate::fleet::provider_resource::ProviderResourceKind::KubernetesDeployment => {
                    ManagedResourceKind::KubernetesDeployment
                }
                crate::fleet::provider_resource::ProviderResourceKind::KubernetesService => {
                    ManagedResourceKind::KubernetesService
                }
                crate::fleet::provider_resource::ProviderResourceKind::SshAgentInstallation => {
                    ManagedResourceKind::SshAgentInstallation
                }
            };
            let provider = match reference.provider() {
                crate::fleet::provider_resource::ProviderResourceProvider::Docker => {
                    ManagedResourceProvider::Docker
                }
                crate::fleet::provider_resource::ProviderResourceProvider::Kubernetes => {
                    ManagedResourceProvider::Kubernetes
                }
                crate::fleet::provider_resource::ProviderResourceProvider::Ssh => {
                    ManagedResourceProvider::Ssh
                }
            };
            ManagedResourceRef::try_new(
                provider,
                kind,
                reference.remote_id().to_owned(),
                reference.namespace().map(str::to_owned),
                reference.name().map(str::to_owned),
            )
            .map_err(|_| FleetDeliveryError::InvalidTransition)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let association = match fact.association() {
        crate::fleet::provider_resource::ProviderResourceAssociation::DockerContainer { name } => {
            ManagedResourceAssociation::docker_container(name.to_owned())
        }
        crate::fleet::provider_resource::ProviderResourceAssociation::KubernetesWorkload {
            namespace,
            deployment_name,
            service_name,
        } => ManagedResourceAssociation::kubernetes_workload(
            namespace.to_owned(),
            deployment_name.to_owned(),
            service_name.to_owned(),
        ),
    }
    .map_err(|_| FleetDeliveryError::InvalidTransition)?;
    ManagedResourceMetadata::try_new(
        fact.display_name().to_owned(),
        fact.labels().clone(),
        remote_refs,
        fact.ownership().labels().clone(),
        association,
        fact.observed_at(),
    )
    .map_err(|_| FleetDeliveryError::InvalidTransition)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, UNIX_EPOCH},
    };

    use fleet::{
        connection::{ConnectionId, ConnectionKind, ConnectionRecord},
        topology::{
            EndpointHealth, EndpointObservation, NodeHealth, NodeObservation, ObservationFreshness,
            ObservationMetadata, ObservationSource, RuntimeKind, RuntimeObservation, RuntimeState,
            TopologyAssociation,
        },
    };

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct Fixture {
        root: PathBuf,
        owner: FleetOwner,
        target: TargetId,
        endpoint: platform::endpoint::EndpointId,
        node: NodeId,
        now: SystemTime,
    }

    impl Fixture {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "runtime-host-fleet-owner-terminal-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&root).expect("create terminal owner test root");
            let now = UNIX_EPOCH + Duration::from_secs(10);
            let mut owner = FleetOwner::open(
                root.join("fleet-facts.log"),
                root.join("private"),
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .expect("open Fleet owner");
            owner
                .upsert_connection(
                    ConnectionRecord::new(
                        ConnectionId::try_new("connection-terminal").unwrap(),
                        ConnectionKind::Container,
                        "terminal connection".into(),
                        now,
                    ),
                    now,
                )
                .expect("insert terminal connection");
            let target = TargetId::try_new("target-terminal").unwrap();
            let endpoint = platform::endpoint::EndpointId::try_new("endpoint-terminal").unwrap();
            let node = NodeId::try_new("node-terminal").unwrap();
            let runtime = RuntimeId::try_new("runtime-terminal").unwrap();
            owner
                .put_target(
                    target.clone(),
                    fleet::DockerTargetConfig::try_new(
                        "https://docker.example.test",
                        "matcha-terminal",
                        "matcha-terminal:latest",
                        None,
                    )
                    .map(fleet::FleetTargetConfig::Docker)
                    .unwrap(),
                )
                .expect("put terminal target");
            let metadata = ObservationMetadata::new(
                ObservationSource::Discovery,
                now,
                ObservationFreshness::Current,
            );
            owner
                .upsert_node(
                    NodeObservation::new(
                        node.clone(),
                        NodeHealth::Online { last_seen_at: now },
                        metadata,
                    ),
                    now,
                )
                .expect("insert terminal node");
            owner
                .upsert_runtime(
                    RuntimeObservation::new(
                        runtime.clone(),
                        node.clone(),
                        None,
                        RuntimeKind::OpenClaw,
                        RuntimeState::Running { started_at: now },
                        metadata,
                    ),
                    now,
                )
                .expect("insert terminal runtime");
            owner
                .upsert_endpoint(
                    EndpointObservation::with_association(
                        endpoint.clone(),
                        node.clone(),
                        runtime,
                        TopologyAssociation::new(
                            Some(ConnectionId::try_new("connection-terminal").unwrap()),
                            None,
                            None,
                        ),
                        EndpointHealth::Ready,
                        Vec::new(),
                        Vec::new(),
                        metadata,
                    ),
                    now,
                )
                .expect("insert terminal endpoint");
            owner
                .bind_target_endpoint_from_registration(
                    crate::fleet::registration_identity::TargetEndpointBindingRequest::try_new(
                        target.clone(),
                        endpoint.clone(),
                        1,
                        fleet::TargetKind::Docker,
                        crate::fleet::registration_identity::TargetEndpointBindingAssociation::new(
                            ConnectionId::try_new("connection-terminal").unwrap(),
                            None,
                            None,
                        ),
                        now,
                    )
                    .unwrap(),
                )
                .expect("bind terminal target");
            Self {
                root,
                owner,
                target,
                endpoint,
                node,
                now,
            }
        }

        fn summary(&mut self, target: &str) -> SessionSummary {
            self.owner
                .terminal_open_allocated(
                    &FleetTerminalTargetSelector::Target(
                        TerminalTargetId::try_new(target).unwrap(),
                    ),
                    TerminalDimensions::try_new(24, 80).unwrap(),
                    self.now,
                )
                .expect("open terminal session")
                .opened
                .session
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn terminal_context_resolves_endpoint_through_target_binding() {
        let mut fixture = Fixture::new();
        let target = fixture.target.clone();
        let summary = fixture.summary(target.as_str());

        let context = fixture
            .owner
            .terminal_context(&summary)
            .expect("current ready bound endpoint must resolve");

        assert_eq!(context.target.as_str(), target.as_str());
        assert_eq!(context.node, fixture.node);
        assert_eq!(context.endpoint, fixture.endpoint);
        assert_ne!(context.node.as_str(), context.target.as_str());
    }

    #[test]
    fn terminal_context_resolves_each_canonical_selector() {
        let mut fixture = Fixture::new();
        let target = fixture.target.clone();
        let summary = fixture.summary(target.as_str());
        let selectors = [
            FleetTerminalTargetSelector::Target(
                TerminalTargetId::try_new(target.as_str()).unwrap(),
            ),
            FleetTerminalTargetSelector::Node(fixture.node.clone()),
            FleetTerminalTargetSelector::Runtime(RuntimeId::try_new("runtime-terminal").unwrap()),
            FleetTerminalTargetSelector::Endpoint(fixture.endpoint.clone()),
        ];

        for selector in selectors {
            let context = fixture
                .owner
                .resolve_terminal_context(&selector, &summary)
                .expect("canonical selector must resolve its unique target");
            assert_eq!(context.target.as_str(), target.as_str());
            assert_eq!(context.node, fixture.node);
            assert_eq!(context.endpoint, fixture.endpoint);
        }
    }

    #[test]
    fn terminal_context_rejects_missing_selectors() {
        let mut fixture = Fixture::new();
        let target = fixture.target.clone();
        let summary = fixture.summary(target.as_str());
        let selectors = [
            FleetTerminalTargetSelector::Target(
                TerminalTargetId::try_new("missing-target").unwrap(),
            ),
            FleetTerminalTargetSelector::Node(NodeId::try_new("missing-node").unwrap()),
            FleetTerminalTargetSelector::Runtime(RuntimeId::try_new("missing-runtime").unwrap()),
            FleetTerminalTargetSelector::Endpoint(
                platform::endpoint::EndpointId::try_new("missing-endpoint").unwrap(),
            ),
        ];

        for selector in selectors {
            assert!(
                fixture
                    .owner
                    .resolve_terminal_context(&selector, &summary)
                    .is_none()
            );
        }
    }

    #[test]
    fn terminal_context_rejects_ambiguous_topology_selectors() {
        let mut fixture = Fixture::new();
        let target = fixture.target.clone();
        let summary = fixture.summary(target.as_str());
        let second_target = TargetId::try_new("target-terminal-second").unwrap();
        fixture
            .owner
            .put_target(
                second_target.clone(),
                fleet::DockerTargetConfig::try_new(
                    "https://docker.example.test",
                    "matcha-terminal-second",
                    "matcha-terminal:latest",
                    None,
                )
                .map(fleet::FleetTargetConfig::Docker)
                .unwrap(),
            )
            .expect("put second target");
        fixture
            .owner
            .bind_target_endpoint(
                fleet::TargetEndpointBinding::try_new(
                    second_target,
                    fixture.endpoint.clone(),
                    1,
                    fixture.now,
                )
                .unwrap(),
            )
            .expect("bind second target");

        for selector in [
            FleetTerminalTargetSelector::Node(fixture.node.clone()),
            FleetTerminalTargetSelector::Runtime(RuntimeId::try_new("runtime-terminal").unwrap()),
            FleetTerminalTargetSelector::Endpoint(fixture.endpoint.clone()),
        ] {
            assert!(
                fixture
                    .owner
                    .resolve_terminal_context(&selector, &summary)
                    .is_none()
            );
        }
        assert!(
            fixture
                .owner
                .resolve_terminal_context(
                    &FleetTerminalTargetSelector::Target(
                        TerminalTargetId::try_new(target.as_str()).unwrap(),
                    ),
                    &summary,
                )
                .is_some()
        );
    }

    #[test]
    fn terminal_context_rejects_target_revision_replacement() {
        let mut fixture = Fixture::new();
        let target = fixture.target.clone();
        let summary = fixture.summary(target.as_str());
        fixture
            .owner
            .put_target(
                target.clone(),
                fleet::DockerTargetConfig::try_new(
                    "https://docker.example.test",
                    "matcha-terminal-replaced",
                    "matcha-terminal:latest",
                    None,
                )
                .map(fleet::FleetTargetConfig::Docker)
                .unwrap(),
            )
            .expect("replace target and invalidate old binding");

        for selector in [
            FleetTerminalTargetSelector::Target(
                TerminalTargetId::try_new(target.as_str()).unwrap(),
            ),
            FleetTerminalTargetSelector::Node(fixture.node.clone()),
            FleetTerminalTargetSelector::Runtime(RuntimeId::try_new("runtime-terminal").unwrap()),
            FleetTerminalTargetSelector::Endpoint(fixture.endpoint.clone()),
        ] {
            assert!(
                fixture
                    .owner
                    .resolve_terminal_context(&selector, &summary)
                    .is_none()
            );
        }
    }

    #[test]
    fn terminal_context_rejects_missing_binding_stale_and_unready_endpoints() {
        let mut missing_binding = Fixture::new();
        let target = missing_binding.target.clone();
        let summary = missing_binding.summary(target.as_str());
        missing_binding
            .owner
            .remove_target(&target)
            .expect("remove target and binding");
        assert!(missing_binding.owner.terminal_context(&summary).is_none());

        let mut stale = Fixture::new();
        let target = stale.target.clone();
        let stale_summary = stale.summary(target.as_str());
        let stale_metadata = ObservationMetadata::new(
            ObservationSource::HealthProbe,
            stale.now + Duration::from_secs(1),
            ObservationFreshness::Stale,
        );
        let runtime = RuntimeId::try_new("runtime-terminal").unwrap();
        stale
            .owner
            .upsert_endpoint(
                EndpointObservation::new(
                    stale.endpoint.clone(),
                    stale.node.clone(),
                    runtime,
                    EndpointHealth::Ready,
                    Vec::new(),
                    Vec::new(),
                    stale_metadata,
                ),
                stale.now + Duration::from_secs(1),
            )
            .expect("update endpoint freshness");
        assert!(stale.owner.terminal_context(&stale_summary).is_none());

        let mut unready = Fixture::new();
        let target = unready.target.clone();
        let unready_summary = unready.summary(target.as_str());
        let metadata = ObservationMetadata::new(
            ObservationSource::HealthProbe,
            unready.now + Duration::from_secs(1),
            ObservationFreshness::Current,
        );
        let runtime = RuntimeId::try_new("runtime-terminal").unwrap();
        unready
            .owner
            .upsert_endpoint(
                EndpointObservation::new(
                    unready.endpoint.clone(),
                    unready.node.clone(),
                    runtime,
                    EndpointHealth::Busy,
                    Vec::new(),
                    Vec::new(),
                    metadata,
                ),
                unready.now + Duration::from_secs(1),
            )
            .expect("update endpoint health");
        assert!(unready.owner.terminal_context(&unready_summary).is_none());
    }
}
