//! Private, source-backed Fleet read projections.
//!
//! This module deliberately projects only facts that already exist in Fleet's
//! domain stores. It does not manufacture operation records; no operation
//! source is present in the current Fleet domain.

use std::{collections::BTreeMap, time::SystemTime};

use platform::{capability::CapabilityAvailability, endpoint::EndpointId};

use crate::{
    audit::FleetAuditEntry,
    command::{
        CommandCancellation, CommandFailure, CommandId, CommandKind, CommandLedger, CommandRecord,
        CommandState, CommandTarget,
    },
    connection::{ConnectionKind, ConnectionRecord, ConnectionState},
    environment::{
        CleanupPolicy, EnvironmentKind, EnvironmentRecord, EnvironmentState, ManagedResourceKind,
        ManagedResourceMetadata, ManagedResourceProvider, ManagedResourceRecord,
        ManagedResourceState, Ownership,
    },
    lease::{LeaseBook, LeaseOwnerKind, LeaseState},
    store::FleetFacts,
    topology::{
        EndpointHealth, FleetTopologyFacts, NodeHealth, ObservationFreshness, ObservationMetadata,
        ObservationSource, RuntimeKind, RuntimeState,
    },
};

/// Constraints accepted by the source-backed selector preview.
///
/// The current Fleet topology has no endpoint labels or operation-ID facts;
/// those dimensions are retained only to report that they are unavailable.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SelectorConstraints {
    endpoint_ids: Vec<String>,
    node_ids: Vec<String>,
    runtime_ids: Vec<String>,
    labels: Vec<String>,
    operation_ids: Vec<String>,
}

impl SelectorConstraints {
    pub fn try_new(
        endpoint_ids: Vec<String>,
        node_ids: Vec<String>,
        runtime_ids: Vec<String>,
        labels: Vec<String>,
        operation_ids: Vec<String>,
    ) -> Result<Self, InvalidSelectorConstraint> {
        let mut constraints = Self {
            endpoint_ids,
            node_ids,
            runtime_ids,
            labels,
            operation_ids,
        };
        constraints.normalize_and_validate()?;
        Ok(constraints)
    }

    fn normalize_and_validate(&mut self) -> Result<(), InvalidSelectorConstraint> {
        for (dimension, values) in [
            (
                SelectorConstraintDimension::EndpointIds,
                &mut self.endpoint_ids,
            ),
            (SelectorConstraintDimension::NodeIds, &mut self.node_ids),
            (
                SelectorConstraintDimension::RuntimeIds,
                &mut self.runtime_ids,
            ),
            (SelectorConstraintDimension::Labels, &mut self.labels),
            (
                SelectorConstraintDimension::OperationIds,
                &mut self.operation_ids,
            ),
        ] {
            if values.iter().any(|value| value.trim().is_empty()) {
                return Err(InvalidSelectorConstraint { dimension });
            }
            values.sort();
            values.dedup();
        }
        Ok(())
    }

    pub fn endpoint_ids(&self) -> &[String] {
        &self.endpoint_ids
    }
    pub fn node_ids(&self) -> &[String] {
        &self.node_ids
    }
    pub fn runtime_ids(&self) -> &[String] {
        &self.runtime_ids
    }
    pub fn labels(&self) -> &[String] {
        &self.labels
    }
    pub fn operation_ids(&self) -> &[String] {
        &self.operation_ids
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectorConstraintDimension {
    EndpointIds,
    NodeIds,
    RuntimeIds,
    Labels,
    OperationIds,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidSelectorConstraint {
    dimension: SelectorConstraintDimension,
}

impl InvalidSelectorConstraint {
    pub fn dimension(self) -> SelectorConstraintDimension {
        self.dimension
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorPreview {
    constraints: SelectorConstraints,
    candidates: Vec<SelectorCandidate>,
    exclusions: Vec<SelectorExclusion>,
    unavailable_constraints: Vec<SelectorConstraintDimension>,
}

impl SelectorPreview {
    pub fn constraints(&self) -> &SelectorConstraints {
        &self.constraints
    }
    pub fn candidates(&self) -> &[SelectorCandidate] {
        &self.candidates
    }
    pub fn exclusions(&self) -> &[SelectorExclusion] {
        &self.exclusions
    }
    pub fn unavailable_constraints(&self) -> &[SelectorConstraintDimension] {
        &self.unavailable_constraints
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorCandidate {
    endpoint_id: EndpointId,
    node_id: crate::topology::NodeId,
    runtime_id: crate::topology::RuntimeId,
    health: EndpointHealth,
    active_lease_count: usize,
    capabilities: Vec<SelectorCapability>,
}

impl SelectorCandidate {
    pub fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }
    pub fn node_id(&self) -> &crate::topology::NodeId {
        &self.node_id
    }
    pub fn runtime_id(&self) -> &crate::topology::RuntimeId {
        &self.runtime_id
    }
    pub fn health(&self) -> EndpointHealth {
        self.health
    }
    pub fn active_lease_count(&self) -> usize {
        self.active_lease_count
    }
    pub fn capabilities(&self) -> &[SelectorCapability] {
        &self.capabilities
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorCapability {
    id: String,
    availability: CapabilityAvailability,
}

impl SelectorCapability {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn availability(&self) -> CapabilityAvailability {
        self.availability
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorExclusion {
    endpoint_id: EndpointId,
    node_id: crate::topology::NodeId,
    runtime_id: crate::topology::RuntimeId,
    reasons: Vec<SelectorExclusionReason>,
}

impl SelectorExclusion {
    pub fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }
    pub fn node_id(&self) -> &crate::topology::NodeId {
        &self.node_id
    }
    pub fn runtime_id(&self) -> &crate::topology::RuntimeId {
        &self.runtime_id
    }
    pub fn reasons(&self) -> &[SelectorExclusionReason] {
        &self.reasons
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SelectorExclusionReason {
    EndpointIdMismatch,
    NodeIdMismatch,
    RuntimeIdMismatch,
    LabelsUnavailable,
    OperationIdsUnavailable,
    EndpointHealthNotReady,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetQuerySnapshot {
    nodes: Vec<NodeSummary>,
    runtimes: Vec<RuntimeSummary>,
    endpoints: Vec<EndpointSummary>,
    capabilities: Vec<CapabilitySummary>,
    connections: Vec<ConnectionSummary>,
    environments: Vec<EnvironmentSummary>,
    resources: Vec<ResourceSummary>,
    commands: Vec<CommandSummary>,
    audit: Vec<AuditSummary>,
    leases: Vec<LeaseSummary>,
    metrics: FleetMetrics,
}

impl FleetQuerySnapshot {
    pub fn from_sources(
        topology: &FleetTopologyFacts,
        commands: &CommandLedger,
        audit: &[FleetAuditEntry],
        leases: &LeaseBook<EndpointId>,
        now: SystemTime,
    ) -> Self {
        let nodes = topology
            .nodes()
            .iter()
            .map(NodeSummary::from_source)
            .collect();
        let runtimes = topology
            .runtimes()
            .iter()
            .map(RuntimeSummary::from_source)
            .collect();
        let endpoints = topology
            .endpoints()
            .iter()
            .map(EndpointSummary::from_source)
            .collect();
        let capabilities = topology
            .endpoints()
            .iter()
            .flat_map(CapabilitySummary::from_source)
            .collect();
        let command_summaries = commands
            .records()
            .map(CommandSummary::from_source)
            .collect();
        let audit_summaries = audit.iter().map(AuditSummary::from_source).collect();
        let lease_summaries = leases.leases().map(LeaseSummary::from_source).collect();
        let metrics = FleetMetrics::from_sources(topology, commands, audit, leases, now);

        Self {
            nodes,
            runtimes,
            endpoints,
            capabilities,
            connections: Vec::new(),
            environments: Vec::new(),
            resources: Vec::new(),
            commands: command_summaries,
            audit: audit_summaries,
            leases: lease_summaries,
            metrics,
        }
    }

    /// Previews endpoint selection using only topology and lease facts.
    pub fn selector_preview(
        topology: &FleetTopologyFacts,
        leases: &LeaseBook<EndpointId>,
        constraints: SelectorConstraints,
        now: SystemTime,
    ) -> SelectorPreview {
        let unavailable_constraints = [
            (!constraints.labels().is_empty()).then_some(SelectorConstraintDimension::Labels),
            (!constraints.operation_ids().is_empty())
                .then_some(SelectorConstraintDimension::OperationIds),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let mut candidates = Vec::new();
        let mut exclusions = Vec::new();
        for endpoint in topology.endpoints() {
            let mut reasons = Vec::new();
            if !constraints.endpoint_ids().is_empty()
                && !constraints
                    .endpoint_ids()
                    .iter()
                    .any(|id| id == endpoint.id().as_str())
            {
                reasons.push(SelectorExclusionReason::EndpointIdMismatch);
            }
            if !constraints.node_ids().is_empty()
                && !constraints
                    .node_ids()
                    .iter()
                    .any(|id| id == endpoint.node_id().as_str())
            {
                reasons.push(SelectorExclusionReason::NodeIdMismatch);
            }
            if !constraints.runtime_ids().is_empty()
                && !constraints
                    .runtime_ids()
                    .iter()
                    .any(|id| id == endpoint.runtime_id().as_str())
            {
                reasons.push(SelectorExclusionReason::RuntimeIdMismatch);
            }
            if !constraints.labels().is_empty() {
                reasons.push(SelectorExclusionReason::LabelsUnavailable);
            }
            if !constraints.operation_ids().is_empty() {
                reasons.push(SelectorExclusionReason::OperationIdsUnavailable);
            }
            if !matches!(
                endpoint.health(),
                EndpointHealth::Ready | EndpointHealth::Busy
            ) {
                reasons.push(SelectorExclusionReason::EndpointHealthNotReady);
            }

            let active_lease_count = leases.active_lease_count(endpoint.id(), now);
            let capabilities = endpoint
                .supported_capabilities()
                .iter()
                .zip(endpoint.availability())
                .map(|(capability, availability)| SelectorCapability {
                    id: capability.id().as_str().to_owned(),
                    availability: *availability,
                })
                .collect::<Vec<_>>();
            if reasons.is_empty() {
                candidates.push(SelectorCandidate {
                    endpoint_id: endpoint.id().clone(),
                    node_id: endpoint.node_id().clone(),
                    runtime_id: endpoint.runtime_id().clone(),
                    health: endpoint.health(),
                    active_lease_count,
                    capabilities,
                });
            } else {
                exclusions.push(SelectorExclusion {
                    endpoint_id: endpoint.id().clone(),
                    node_id: endpoint.node_id().clone(),
                    runtime_id: endpoint.runtime_id().clone(),
                    reasons,
                });
            }
        }
        candidates.sort_by(|left, right| left.endpoint_id.as_str().cmp(right.endpoint_id.as_str()));
        exclusions.sort_by(|left, right| left.endpoint_id.as_str().cmp(right.endpoint_id.as_str()));
        for candidate in &mut candidates {
            candidate
                .capabilities
                .sort_by(|left, right| left.id.cmp(&right.id));
        }
        SelectorPreview {
            constraints,
            candidates,
            exclusions,
            unavailable_constraints,
        }
    }

    /// Builds all available projections from the durable Fleet facts.
    ///
    /// Connection, environment, and managed-resource summaries intentionally
    /// omit endpoint/config/secret material and command payload details.
    pub fn from_facts(facts: &FleetFacts, leases: &LeaseBook<EndpointId>, now: SystemTime) -> Self {
        let mut snapshot = Self::from_sources(
            facts.topology(),
            facts.command_ledger(),
            facts.audit_entries(),
            leases,
            now,
        );
        snapshot.connections = facts
            .connections()
            .map(ConnectionSummary::from_source)
            .collect();
        snapshot.environments = facts
            .environments()
            .map(EnvironmentSummary::from_source)
            .collect();
        snapshot.resources = facts
            .managed_resources()
            .map(|resource| {
                ResourceSummary::from_source(
                    resource,
                    exact_resource_node_id(facts.topology(), resource),
                )
            })
            .collect();
        snapshot
    }

    pub fn connections(&self) -> &[ConnectionSummary] {
        &self.connections
    }

    pub fn environments(&self) -> &[EnvironmentSummary] {
        &self.environments
    }

    pub fn resources(&self) -> &[ResourceSummary] {
        &self.resources
    }

    pub fn nodes(&self) -> &[NodeSummary] {
        &self.nodes
    }

    pub fn runtimes(&self) -> &[RuntimeSummary] {
        &self.runtimes
    }

    pub fn endpoints(&self) -> &[EndpointSummary] {
        &self.endpoints
    }

    pub fn capabilities(&self) -> &[CapabilitySummary] {
        &self.capabilities
    }

    pub fn commands(&self) -> &[CommandSummary] {
        &self.commands
    }

    pub fn audit(&self) -> &[AuditSummary] {
        &self.audit
    }

    pub fn leases(&self) -> &[LeaseSummary] {
        &self.leases
    }

    pub fn metrics(&self) -> &FleetMetrics {
        &self.metrics
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservationSummary {
    source: ObservationSource,
    observed_at: SystemTime,
    freshness: ObservationFreshness,
}

impl ObservationSummary {
    fn from_source(metadata: ObservationMetadata) -> Self {
        Self {
            source: metadata.source(),
            observed_at: metadata.observed_at(),
            freshness: metadata.freshness(),
        }
    }

    pub fn source(&self) -> ObservationSource {
        self.source
    }

    pub fn observed_at(&self) -> SystemTime {
        self.observed_at
    }

    pub fn freshness(&self) -> ObservationFreshness {
        self.freshness
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeSummary {
    id: crate::topology::NodeId,
    association: crate::topology::TopologyAssociation,
    health: NodeHealth,
    observation: ObservationSummary,
}

impl NodeSummary {
    fn from_source(source: &crate::topology::NodeObservation) -> Self {
        Self {
            id: source.id().clone(),
            association: source.association().clone(),
            health: source.health(),
            observation: ObservationSummary::from_source(source.metadata()),
        }
    }

    pub fn id(&self) -> &crate::topology::NodeId {
        &self.id
    }

    pub fn association(&self) -> &crate::topology::TopologyAssociation {
        &self.association
    }

    pub fn health(&self) -> NodeHealth {
        self.health
    }

    pub fn observation(&self) -> &ObservationSummary {
        &self.observation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSummary {
    id: crate::topology::RuntimeId,
    node_id: crate::topology::NodeId,
    agent_id: Option<platform::endpoint::NativeAgentId>,
    association: crate::topology::TopologyAssociation,
    kind: RuntimeKind,
    state: RuntimeState,
    observation: ObservationSummary,
}

impl RuntimeSummary {
    fn from_source(source: &crate::topology::RuntimeObservation) -> Self {
        Self {
            id: source.id().clone(),
            node_id: source.node_id().clone(),
            agent_id: source.agent_id().cloned(),
            association: source.association().clone(),
            kind: source.kind(),
            state: source.state(),
            observation: ObservationSummary::from_source(source.metadata()),
        }
    }

    pub fn id(&self) -> &crate::topology::RuntimeId {
        &self.id
    }

    pub fn node_id(&self) -> &crate::topology::NodeId {
        &self.node_id
    }

    pub fn agent_id(&self) -> Option<&platform::endpoint::NativeAgentId> {
        self.agent_id.as_ref()
    }

    pub fn association(&self) -> &crate::topology::TopologyAssociation {
        &self.association
    }

    pub fn kind(&self) -> RuntimeKind {
        self.kind
    }

    pub fn state(&self) -> RuntimeState {
        self.state
    }

    pub fn observation(&self) -> &ObservationSummary {
        &self.observation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointSummary {
    id: EndpointId,
    node_id: crate::topology::NodeId,
    runtime_id: crate::topology::RuntimeId,
    association: crate::topology::TopologyAssociation,
    health: EndpointHealth,
    supported_capability_count: usize,
    available_capability_count: usize,
    unavailable_capability_count: usize,
    unknown_capability_count: usize,
    observation: ObservationSummary,
}

impl EndpointSummary {
    fn from_source(source: &crate::topology::EndpointObservation) -> Self {
        let mut available_capability_count = 0;
        let mut unavailable_capability_count = 0;
        let mut unknown_capability_count = 0;
        for availability in source.availability() {
            match availability {
                platform::capability::CapabilityAvailability::Available => {
                    available_capability_count += 1
                }
                platform::capability::CapabilityAvailability::Unavailable => {
                    unavailable_capability_count += 1
                }
                platform::capability::CapabilityAvailability::Unknown => {
                    unknown_capability_count += 1
                }
            }
        }

        Self {
            id: source.id().clone(),
            node_id: source.node_id().clone(),
            runtime_id: source.runtime_id().clone(),
            association: source.association().clone(),
            health: source.health(),
            supported_capability_count: source.supported_capabilities().len(),
            available_capability_count,
            unavailable_capability_count,
            unknown_capability_count,
            observation: ObservationSummary::from_source(source.metadata()),
        }
    }

    pub fn id(&self) -> &EndpointId {
        &self.id
    }

    pub fn node_id(&self) -> &crate::topology::NodeId {
        &self.node_id
    }

    pub fn runtime_id(&self) -> &crate::topology::RuntimeId {
        &self.runtime_id
    }

    pub fn association(&self) -> &crate::topology::TopologyAssociation {
        &self.association
    }

    pub fn health(&self) -> EndpointHealth {
        self.health
    }

    pub fn supported_capability_count(&self) -> usize {
        self.supported_capability_count
    }

    pub fn available_capability_count(&self) -> usize {
        self.available_capability_count
    }

    pub fn unavailable_capability_count(&self) -> usize {
        self.unavailable_capability_count
    }

    pub fn unknown_capability_count(&self) -> usize {
        self.unknown_capability_count
    }

    pub fn observation(&self) -> &ObservationSummary {
        &self.observation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilitySummary {
    id: platform::capability::CapabilityId,
    scope: platform::capability::CapabilityScope,
    endpoint_id: EndpointId,
    node_id: crate::topology::NodeId,
    runtime_id: crate::topology::RuntimeId,
    availability: platform::capability::CapabilityAvailability,
    observation: ObservationSummary,
}

impl CapabilitySummary {
    fn from_source(
        source: &crate::topology::EndpointObservation,
    ) -> impl Iterator<Item = Self> + '_ {
        source
            .supported_capabilities()
            .iter()
            .filter_map(move |capability| {
                let observation = source.availability_observation(capability)?;
                Some(Self {
                    id: capability.id().clone(),
                    scope: capability.scope(),
                    endpoint_id: source.id().clone(),
                    node_id: source.node_id().clone(),
                    runtime_id: source.runtime_id().clone(),
                    availability: observation.availability(),
                    observation: ObservationSummary::from_source(observation.metadata()),
                })
            })
    }

    pub fn id(&self) -> &platform::capability::CapabilityId {
        &self.id
    }
    pub fn scope(&self) -> platform::capability::CapabilityScope {
        self.scope
    }
    pub fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }
    pub fn node_id(&self) -> &crate::topology::NodeId {
        &self.node_id
    }
    pub fn runtime_id(&self) -> &crate::topology::RuntimeId {
        &self.runtime_id
    }
    pub fn availability(&self) -> platform::capability::CapabilityAvailability {
        self.availability
    }
    pub fn observation(&self) -> &ObservationSummary {
        &self.observation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionSummary {
    id: crate::connection::ConnectionId,
    kind: ConnectionKind,
    display_name: String,
    endpoint: Option<String>,
    labels: Vec<String>,
    public_config: BTreeMap<String, String>,
    state: ConnectionSummaryState,
    enabled: bool,
    created_at: SystemTime,
    updated_at: SystemTime,
}

impl ConnectionSummary {
    fn from_source(source: &ConnectionRecord) -> Self {
        Self {
            id: source.id().clone(),
            kind: source.kind(),
            display_name: source.display_name().to_owned(),
            endpoint: source.endpoint().map(str::to_owned),
            labels: source.labels().to_vec(),
            public_config: source.public_config().clone(),
            state: ConnectionSummaryState::from_source(source.state()),
            enabled: source.enabled(),
            created_at: source.created_at(),
            updated_at: source.updated_at(),
        }
    }

    pub fn id(&self) -> &crate::connection::ConnectionId {
        &self.id
    }
    pub fn kind(&self) -> ConnectionKind {
        self.kind
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }
    pub fn labels(&self) -> &[String] {
        &self.labels
    }
    pub fn public_config(&self) -> &BTreeMap<String, String> {
        &self.public_config
    }
    pub fn state(&self) -> &ConnectionSummaryState {
        &self.state
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectionSummaryState {
    Registered,
    Probing,
    Ready { observed_at: SystemTime },
    Unhealthy { observed_at: Option<SystemTime> },
    Deleted { deleted_at: SystemTime },
    Failed,
}

impl ConnectionSummaryState {
    fn from_source(source: &ConnectionState) -> Self {
        match source {
            ConnectionState::Registered => Self::Registered,
            ConnectionState::Probing { .. } => Self::Probing,
            ConnectionState::Ready { observed_at } => Self::Ready {
                observed_at: *observed_at,
            },
            ConnectionState::Unhealthy { observed_at, .. } => Self::Unhealthy {
                observed_at: *observed_at,
            },
            ConnectionState::Deleted { deleted_at } => Self::Deleted {
                deleted_at: *deleted_at,
            },
            ConnectionState::Failed { .. } => Self::Failed,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentSummary {
    id: crate::environment::EnvironmentId,
    connection_id: crate::connection::ConnectionId,
    display_name: String,
    kind: EnvironmentKind,
    labels: Vec<String>,
    public_config: BTreeMap<String, String>,
    state: EnvironmentSummaryState,
    enabled: bool,
    managed_resource_count: usize,
    created_at: SystemTime,
    updated_at: SystemTime,
}

impl EnvironmentSummary {
    fn from_source(source: &EnvironmentRecord) -> Self {
        Self {
            id: source.id().clone(),
            connection_id: source.connection_id().clone(),
            display_name: source.display_name().to_owned(),
            kind: source.kind(),
            labels: source.labels().to_vec(),
            public_config: source.public_config().clone(),
            state: EnvironmentSummaryState::from_source(source.state()),
            enabled: source.enabled(),
            managed_resource_count: source.managed_resource_ids().len(),
            created_at: source.created_at(),
            updated_at: source.updated_at(),
        }
    }

    pub fn id(&self) -> &crate::environment::EnvironmentId {
        &self.id
    }
    pub fn connection_id(&self) -> &crate::connection::ConnectionId {
        &self.connection_id
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn kind(&self) -> EnvironmentKind {
        self.kind
    }
    pub fn labels(&self) -> &[String] {
        &self.labels
    }
    pub fn public_config(&self) -> &BTreeMap<String, String> {
        &self.public_config
    }
    pub fn state(&self) -> &EnvironmentSummaryState {
        &self.state
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn managed_resource_count(&self) -> usize {
        self.managed_resource_count
    }
    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentSummaryState {
    Registered,
    Deploying,
    Ready { ready_at: SystemTime },
    Deleting,
    Deleted { deleted_at: SystemTime },
    Orphaned,
    Failed,
}

impl EnvironmentSummaryState {
    fn from_source(source: &EnvironmentState) -> Self {
        match source {
            EnvironmentState::Registered => Self::Registered,
            EnvironmentState::Deploying { .. } => Self::Deploying,
            EnvironmentState::Ready { ready_at } => Self::Ready {
                ready_at: *ready_at,
            },
            EnvironmentState::Deleting { .. } => Self::Deleting,
            EnvironmentState::Deleted { deleted_at } => Self::Deleted {
                deleted_at: *deleted_at,
            },
            EnvironmentState::Orphaned { .. } => Self::Orphaned,
            EnvironmentState::Failed { .. } => Self::Failed,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceSummary {
    id: crate::environment::ManagedResourceId,
    connection_id: crate::connection::ConnectionId,
    environment_id: crate::environment::EnvironmentId,
    node_id: Option<crate::topology::NodeId>,
    provider: ManagedResourceProvider,
    kind: ManagedResourceKind,
    remote_resource_id: String,
    metadata: Option<ManagedResourceMetadata>,
    ownership: Ownership,
    cleanup_policy: CleanupPolicy,
    state: ResourceSummaryState,
    tombstone: bool,
    created_at: SystemTime,
    updated_at: SystemTime,
}

fn exact_resource_node_id(
    topology: &FleetTopologyFacts,
    resource: &ManagedResourceRecord,
) -> Option<crate::topology::NodeId> {
    let mut matches = topology.nodes().iter().filter(|node| {
        let association = node.association();
        association.connection_id() == Some(resource.connection_id())
            && association.environment_id() == Some(resource.environment_id())
            && association.managed_resource_id() == Some(resource.id())
    });
    let node = matches.next()?;
    matches.next().is_none().then(|| node.id().clone())
}

impl ResourceSummary {
    fn from_source(
        source: &ManagedResourceRecord,
        node_id: Option<crate::topology::NodeId>,
    ) -> Self {
        Self {
            id: source.id().clone(),
            connection_id: source.connection_id().clone(),
            environment_id: source.environment_id().clone(),
            node_id,
            provider: source.provider(),
            kind: source.kind(),
            remote_resource_id: source.remote_resource_id().to_owned(),
            metadata: source.metadata().cloned(),
            ownership: source.ownership(),
            cleanup_policy: source.cleanup_policy(),
            state: ResourceSummaryState::from_source(source.state()),
            tombstone: source.is_tombstone(),
            created_at: source.created_at(),
            updated_at: source.updated_at(),
        }
    }

    pub fn id(&self) -> &crate::environment::ManagedResourceId {
        &self.id
    }
    pub fn connection_id(&self) -> &crate::connection::ConnectionId {
        &self.connection_id
    }
    pub fn environment_id(&self) -> &crate::environment::EnvironmentId {
        &self.environment_id
    }
    pub fn node_id(&self) -> Option<&crate::topology::NodeId> {
        self.node_id.as_ref()
    }
    pub fn provider(&self) -> ManagedResourceProvider {
        self.provider
    }
    pub fn kind(&self) -> ManagedResourceKind {
        self.kind
    }
    pub fn remote_resource_id(&self) -> &str {
        &self.remote_resource_id
    }
    pub fn metadata(&self) -> Option<&ManagedResourceMetadata> {
        self.metadata.as_ref()
    }
    pub fn display_name(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .map(ManagedResourceMetadata::display_name)
    }
    pub fn labels(&self) -> Option<&BTreeMap<String, String>> {
        self.metadata.as_ref().map(ManagedResourceMetadata::labels)
    }
    pub fn remote_refs(&self) -> Option<&[crate::environment::ManagedResourceRef]> {
        self.metadata
            .as_ref()
            .map(ManagedResourceMetadata::remote_refs)
    }
    pub fn ownership_evidence(&self) -> Option<&BTreeMap<String, String>> {
        self.metadata
            .as_ref()
            .map(ManagedResourceMetadata::ownership_evidence)
    }
    pub fn association(&self) -> Option<&crate::environment::ManagedResourceAssociation> {
        self.metadata
            .as_ref()
            .map(ManagedResourceMetadata::association)
    }
    pub fn observed_at(&self) -> Option<SystemTime> {
        self.metadata
            .as_ref()
            .map(ManagedResourceMetadata::observed_at)
    }
    pub fn ownership(&self) -> Ownership {
        self.ownership
    }
    pub fn cleanup_policy(&self) -> CleanupPolicy {
        self.cleanup_policy
    }
    pub fn state(&self) -> &ResourceSummaryState {
        &self.state
    }
    pub fn tombstone(&self) -> bool {
        self.tombstone
    }
    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResourceSummaryState {
    Observed,
    Provisioning,
    Ready { observed_at: SystemTime },
    Deleting,
    Deleted { deleted_at: SystemTime },
    Conflict,
    Failed,
}

impl ResourceSummaryState {
    fn from_source(source: &ManagedResourceState) -> Self {
        match source {
            ManagedResourceState::Observed => Self::Observed,
            ManagedResourceState::Provisioning { .. } => Self::Provisioning,
            ManagedResourceState::Ready { observed_at } => Self::Ready {
                observed_at: *observed_at,
            },
            ManagedResourceState::Deleting { .. } => Self::Deleting,
            ManagedResourceState::Deleted { deleted_at } => Self::Deleted {
                deleted_at: *deleted_at,
            },
            ManagedResourceState::Conflict { .. } => Self::Conflict,
            ManagedResourceState::Failed { .. } => Self::Failed,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSummary {
    command_id: CommandId,
    kind: CommandKind,
    target: CommandTargetSummary,
    state: CommandSummaryState,
    created_at: SystemTime,
    updated_at: SystemTime,
}

impl CommandSummary {
    fn from_source(source: &CommandRecord) -> Self {
        Self {
            command_id: source.intent().command_id().clone(),
            kind: source.intent().kind(),
            target: CommandTargetSummary::from_source(source.intent().target()),
            state: CommandSummaryState::from_source(source.state()),
            created_at: source.intent().queued_at(),
            updated_at: source.updated_at(),
        }
    }

    pub fn command_id(&self) -> &CommandId {
        &self.command_id
    }

    pub fn kind(&self) -> CommandKind {
        self.kind
    }

    pub fn target(&self) -> &CommandTargetSummary {
        &self.target
    }

    pub fn state(&self) -> &CommandSummaryState {
        &self.state
    }

    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }

    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandTargetSummary {
    Node(crate::topology::NodeId),
    Runtime {
        node_id: crate::topology::NodeId,
        runtime_id: crate::topology::RuntimeId,
    },
    Endpoint {
        node_id: crate::topology::NodeId,
        runtime_id: crate::topology::RuntimeId,
        endpoint_id: EndpointId,
    },
}

impl CommandTargetSummary {
    fn from_source(source: &CommandTarget) -> Self {
        match source {
            CommandTarget::Node(node_id) => Self::Node(node_id.clone()),
            CommandTarget::Runtime {
                node_id,
                runtime_id,
            } => Self::Runtime {
                node_id: node_id.clone(),
                runtime_id: runtime_id.clone(),
            },
            CommandTarget::Endpoint {
                node_id,
                runtime_id,
                endpoint_id,
            } => Self::Endpoint {
                node_id: node_id.clone(),
                runtime_id: runtime_id.clone(),
                endpoint_id: endpoint_id.clone(),
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandSummaryState {
    Queued {
        queued_at: SystemTime,
    },
    Running {
        started_at: SystemTime,
    },
    Succeeded {
        completed_at: SystemTime,
    },
    Failed {
        completed_at: SystemTime,
        failure: CommandFailure,
    },
    Cancelled {
        completed_at: SystemTime,
        reason: Option<CommandCancellation>,
    },
    TimedOut {
        completed_at: SystemTime,
    },
    OutcomeUnknown {
        observed_at: SystemTime,
    },
}

impl CommandSummaryState {
    fn from_source(source: &CommandState) -> Self {
        match source {
            CommandState::Queued { queued_at } => Self::Queued {
                queued_at: *queued_at,
            },
            CommandState::Running { started_at } => Self::Running {
                started_at: *started_at,
            },
            CommandState::Succeeded { completed_at } => Self::Succeeded {
                completed_at: *completed_at,
            },
            CommandState::Failed {
                completed_at,
                failure,
            } => Self::Failed {
                completed_at: *completed_at,
                failure: *failure,
            },
            CommandState::Cancelled {
                completed_at,
                reason,
            } => Self::Cancelled {
                completed_at: *completed_at,
                reason: *reason,
            },
            CommandState::TimedOut { completed_at, .. } => Self::TimedOut {
                completed_at: *completed_at,
            },
            CommandState::OutcomeUnknown { observed_at } => Self::OutcomeUnknown {
                observed_at: *observed_at,
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseSummary {
    lease_id: crate::lease::LeaseId,
    endpoint_id: EndpointId,
    owner_kind: LeaseOwnerKind,
    owner_id: String,
    acquired_at: SystemTime,
    state: LeaseSummaryState,
}

impl LeaseSummary {
    fn from_source(source: &crate::lease::Lease<EndpointId>) -> Self {
        Self {
            lease_id: source.id().clone(),
            endpoint_id: source.endpoint().clone(),
            owner_kind: source.owner().kind(),
            owner_id: source.owner().id().to_owned(),
            acquired_at: source.acquired_at(),
            state: LeaseSummaryState::from_source(source.state()),
        }
    }

    pub fn lease_id(&self) -> &crate::lease::LeaseId {
        &self.lease_id
    }
    pub fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }
    pub fn owner_kind(&self) -> LeaseOwnerKind {
        self.owner_kind
    }
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
    pub fn acquired_at(&self) -> SystemTime {
        self.acquired_at
    }
    pub fn state(&self) -> LeaseSummaryState {
        self.state
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseSummaryState {
    Active { expires_at: SystemTime },
    Released { released_at: SystemTime },
    Expired { expired_at: SystemTime },
}

impl LeaseSummaryState {
    fn from_source(source: LeaseState) -> Self {
        match source {
            LeaseState::Active { expires_at } => Self::Active { expires_at },
            LeaseState::Released { released_at } => Self::Released { released_at },
            LeaseState::Expired { expired_at } => Self::Expired { expired_at },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditSummary {
    sequence: u64,
    event_name: String,
    occurred_at: SystemTime,
    relations: crate::audit::FleetAuditRelations,
}

impl AuditSummary {
    fn from_source(source: &FleetAuditEntry) -> Self {
        let event = source.event();
        Self {
            sequence: source.sequence(),
            event_name: event.event_name().to_owned(),
            occurred_at: event.occurred_at(),
            relations: event.relations().clone(),
        }
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn event_name(&self) -> &str {
        &self.event_name
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }

    pub fn relations(&self) -> &crate::audit::FleetAuditRelations {
        &self.relations
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetMetrics {
    nodes: NodeMetrics,
    runtimes: RuntimeMetrics,
    endpoints: EndpointMetrics,
    agents: AgentMetrics,
    capabilities: CapabilityMetrics,
    commands: CommandMetrics,
    audit: AuditMetrics,
    leases: LeaseMetrics,
}

impl FleetMetrics {
    fn from_sources(
        topology: &FleetTopologyFacts,
        commands: &CommandLedger,
        audit: &[FleetAuditEntry],
        leases: &LeaseBook<EndpointId>,
        now: SystemTime,
    ) -> Self {
        Self {
            nodes: NodeMetrics::from_sources(topology),
            runtimes: RuntimeMetrics::from_sources(topology),
            endpoints: EndpointMetrics::from_sources(topology),
            agents: AgentMetrics::from_sources(topology),
            capabilities: CapabilityMetrics::from_sources(topology),
            commands: CommandMetrics::from_source(commands),
            audit: AuditMetrics::from_sources(audit),
            leases: LeaseMetrics::from_source(leases, now),
        }
    }

    pub fn nodes(&self) -> &NodeMetrics {
        &self.nodes
    }

    pub fn runtimes(&self) -> &RuntimeMetrics {
        &self.runtimes
    }

    pub fn endpoints(&self) -> &EndpointMetrics {
        &self.endpoints
    }

    pub fn agents(&self) -> &AgentMetrics {
        &self.agents
    }

    pub fn capabilities(&self) -> &CapabilityMetrics {
        &self.capabilities
    }

    pub fn commands(&self) -> &CommandMetrics {
        &self.commands
    }

    pub fn audit(&self) -> &AuditMetrics {
        &self.audit
    }

    pub fn leases(&self) -> &LeaseMetrics {
        &self.leases
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct NodeMetrics {
    total: usize,
    unknown: usize,
    online: usize,
    offline: usize,
    disabled: usize,
    error: usize,
}

impl NodeMetrics {
    fn from_sources(topology: &FleetTopologyFacts) -> Self {
        let mut metrics = Self {
            total: topology.nodes().len(),
            ..Self::default()
        };
        for node in topology.nodes() {
            match node.health() {
                NodeHealth::Unknown => metrics.unknown += 1,
                NodeHealth::Online { .. } => metrics.online += 1,
                NodeHealth::Offline { .. } => metrics.offline += 1,
                NodeHealth::Disabled => metrics.disabled += 1,
                NodeHealth::Error => metrics.error += 1,
            }
        }
        metrics
    }

    pub fn total(self) -> usize {
        self.total
    }
    pub fn unknown(self) -> usize {
        self.unknown
    }
    pub fn online(self) -> usize {
        self.online
    }
    pub fn offline(self) -> usize {
        self.offline
    }
    pub fn disabled(self) -> usize {
        self.disabled
    }
    pub fn error(self) -> usize {
        self.error
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RuntimeMetrics {
    total: usize,
    discovered: usize,
    running: usize,
    stopped: usize,
    degraded: usize,
    retired: usize,
}

impl RuntimeMetrics {
    fn from_sources(topology: &FleetTopologyFacts) -> Self {
        let mut metrics = Self {
            total: topology.runtimes().len(),
            ..Self::default()
        };
        for runtime in topology.runtimes() {
            match runtime.state() {
                RuntimeState::Discovered => metrics.discovered += 1,
                RuntimeState::Running { .. } => metrics.running += 1,
                RuntimeState::Stopped { .. } => metrics.stopped += 1,
                RuntimeState::Degraded => metrics.degraded += 1,
                RuntimeState::Retired { .. } => metrics.retired += 1,
            }
        }
        metrics
    }

    pub fn total(self) -> usize {
        self.total
    }
    pub fn discovered(self) -> usize {
        self.discovered
    }
    pub fn running(self) -> usize {
        self.running
    }
    pub fn stopped(self) -> usize {
        self.stopped
    }
    pub fn degraded(self) -> usize {
        self.degraded
    }
    pub fn retired(self) -> usize {
        self.retired
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EndpointMetrics {
    total: usize,
    unknown: usize,
    ready: usize,
    busy: usize,
    draining: usize,
    unhealthy: usize,
    retired: usize,
    draining_endpoints: Vec<EndpointMetricRef>,
    retired_endpoints: Vec<EndpointMetricRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointMetricRef {
    id: EndpointId,
    node_id: crate::topology::NodeId,
    runtime_id: crate::topology::RuntimeId,
}

impl EndpointMetricRef {
    fn from_source(source: &crate::topology::EndpointObservation) -> Self {
        Self {
            id: source.id().clone(),
            node_id: source.node_id().clone(),
            runtime_id: source.runtime_id().clone(),
        }
    }

    pub fn id(&self) -> &EndpointId {
        &self.id
    }

    pub fn node_id(&self) -> &crate::topology::NodeId {
        &self.node_id
    }

    pub fn runtime_id(&self) -> &crate::topology::RuntimeId {
        &self.runtime_id
    }
}

impl EndpointMetrics {
    fn from_sources(topology: &FleetTopologyFacts) -> Self {
        let mut metrics = Self {
            total: topology.endpoints().len(),
            ..Self::default()
        };
        for endpoint in topology.endpoints() {
            match endpoint.health() {
                EndpointHealth::Unknown => metrics.unknown += 1,
                EndpointHealth::Ready => metrics.ready += 1,
                EndpointHealth::Busy => metrics.busy += 1,
                EndpointHealth::Draining => {
                    metrics.draining += 1;
                    metrics
                        .draining_endpoints
                        .push(EndpointMetricRef::from_source(endpoint));
                }
                EndpointHealth::Unhealthy => metrics.unhealthy += 1,
                EndpointHealth::Retired => {
                    metrics.retired += 1;
                    metrics
                        .retired_endpoints
                        .push(EndpointMetricRef::from_source(endpoint));
                }
            }
        }
        metrics
    }

    pub fn total(&self) -> usize {
        self.total
    }
    pub fn unknown(&self) -> usize {
        self.unknown
    }
    pub fn ready(&self) -> usize {
        self.ready
    }
    pub fn busy(&self) -> usize {
        self.busy
    }
    pub fn draining(&self) -> usize {
        self.draining
    }
    pub fn unhealthy(&self) -> usize {
        self.unhealthy
    }
    pub fn retired(&self) -> usize {
        self.retired
    }
    pub fn draining_endpoints(&self) -> &[EndpointMetricRef] {
        &self.draining_endpoints
    }
    pub fn retired_endpoints(&self) -> &[EndpointMetricRef] {
        &self.retired_endpoints
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AgentMetrics {
    total: usize,
}

impl AgentMetrics {
    fn from_sources(topology: &FleetTopologyFacts) -> Self {
        Self {
            total: topology.agents().len(),
        }
    }
    pub fn total(self) -> usize {
        self.total
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CapabilityMetrics {
    total: usize,
    available: usize,
    unavailable: usize,
    unknown: usize,
    stale: usize,
}

impl CapabilityMetrics {
    fn from_sources(topology: &FleetTopologyFacts) -> Self {
        let mut total = 0;
        let mut available = 0;
        let mut unavailable = 0;
        let mut unknown = 0;
        let mut stale = 0;
        for endpoint in topology.endpoints() {
            for capability in endpoint.supported_capabilities() {
                if let Some(observation) = endpoint.availability_observation(capability) {
                    total += 1;
                    match observation.availability() {
                        CapabilityAvailability::Available => available += 1,
                        CapabilityAvailability::Unavailable => unavailable += 1,
                        CapabilityAvailability::Unknown => unknown += 1,
                    }
                    if observation.metadata().freshness() != ObservationFreshness::Current {
                        stale += 1;
                    }
                }
            }
        }
        Self {
            total,
            available,
            unavailable,
            unknown,
            stale,
        }
    }
    pub fn total(self) -> usize {
        self.total
    }
    pub fn available(self) -> usize {
        self.available
    }
    pub fn unavailable(self) -> usize {
        self.unavailable
    }
    pub fn unknown(self) -> usize {
        self.unknown
    }
    pub fn stale(self) -> usize {
        self.stale
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CommandMetrics {
    total: usize,
    queued: usize,
    running: usize,
    succeeded: usize,
    failed: usize,
    cancelled: usize,
    timed_out: usize,
    outcome_unknown: usize,
}

impl CommandMetrics {
    fn from_source(ledger: &CommandLedger) -> Self {
        let mut metrics = Self {
            total: ledger.records().count(),
            ..Self::default()
        };
        for command in ledger.records() {
            match command.state() {
                CommandState::Queued { .. } => metrics.queued += 1,
                CommandState::Running { .. } => metrics.running += 1,
                CommandState::Succeeded { .. } => metrics.succeeded += 1,
                CommandState::Failed { .. } => metrics.failed += 1,
                CommandState::Cancelled { .. } => metrics.cancelled += 1,
                CommandState::TimedOut { .. } => metrics.timed_out += 1,
                CommandState::OutcomeUnknown { .. } => metrics.outcome_unknown += 1,
            }
        }
        metrics
    }

    pub fn total(self) -> usize {
        self.total
    }
    pub fn queued(self) -> usize {
        self.queued
    }
    pub fn running(self) -> usize {
        self.running
    }
    pub fn succeeded(self) -> usize {
        self.succeeded
    }
    pub fn failed(self) -> usize {
        self.failed
    }
    pub fn cancelled(self) -> usize {
        self.cancelled
    }
    pub fn timed_out(self) -> usize {
        self.timed_out
    }
    pub fn outcome_unknown(self) -> usize {
        self.outcome_unknown
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AuditMetrics {
    total: usize,
    event_counts: BTreeMap<String, usize>,
}

impl AuditMetrics {
    fn from_sources(audit: &[FleetAuditEntry]) -> Self {
        let mut event_counts = BTreeMap::new();
        for entry in audit {
            *event_counts
                .entry(entry.event().event_name().to_owned())
                .or_default() += 1;
        }
        Self {
            total: audit.len(),
            event_counts,
        }
    }

    pub fn total(&self) -> usize {
        self.total
    }

    pub fn event_counts(&self) -> &BTreeMap<String, usize> {
        &self.event_counts
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LeaseMetrics {
    total: usize,
    active: usize,
    released: usize,
    expired: usize,
    manual_operation: usize,
    runtime_start: usize,
    session: usize,
    team_run: usize,
}

impl LeaseMetrics {
    fn from_source(leases: &LeaseBook<EndpointId>, now: SystemTime) -> Self {
        let mut metrics = Self::default();
        for lease in leases.leases() {
            metrics.total += 1;
            match lease.state() {
                LeaseState::Active { expires_at } if expires_at > now => metrics.active += 1,
                LeaseState::Released { .. } => metrics.released += 1,
                LeaseState::Active { .. } | LeaseState::Expired { .. } => metrics.expired += 1,
            }
            match lease.owner().kind() {
                LeaseOwnerKind::ManualOperation => metrics.manual_operation += 1,
                LeaseOwnerKind::RuntimeStart => metrics.runtime_start += 1,
                LeaseOwnerKind::Session => metrics.session += 1,
                LeaseOwnerKind::TeamRun => metrics.team_run += 1,
            }
        }
        metrics
    }

    pub fn total(self) -> usize {
        self.total
    }
    pub fn active(self) -> usize {
        self.active
    }
    pub fn released(self) -> usize {
        self.released
    }
    pub fn expired(self) -> usize {
        self.expired
    }
    pub fn manual_operation(self) -> usize {
        self.manual_operation
    }
    pub fn runtime_start(self) -> usize {
        self.runtime_start
    }
    pub fn session(self) -> usize {
        self.session
    }
    pub fn team_run(self) -> usize {
        self.team_run
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audit::{FleetAuditEvent, FleetAuditEventInput, FleetAuditValue},
        command::{CommandIntent, CommandTarget},
        lease::{Capacity, LeaseDuration, LeaseId, LeaseOwner},
        topology::{NodeId, ObservationFreshness},
    };
    use platform::{
        capability::{CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability},
        endpoint::EndpointId,
    };
    use std::{collections::BTreeMap, time::Duration};

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn metadata() -> ObservationMetadata {
        ObservationMetadata::new(
            ObservationSource::HealthProbe,
            at(10),
            ObservationFreshness::Current,
        )
    }

    fn topology() -> FleetTopologyFacts {
        let node_id = NodeId::try_new("node-1").unwrap();
        let runtime_id = crate::topology::RuntimeId::try_new("runtime-1").unwrap();
        let endpoint_id = EndpointId::try_new("endpoint-1").unwrap();
        FleetTopologyFacts::restore(
            vec![crate::topology::NodeObservation::new(
                node_id.clone(),
                NodeHealth::Online {
                    last_seen_at: at(9),
                },
                metadata(),
            )],
            Vec::new(),
            vec![crate::topology::RuntimeObservation::new(
                runtime_id.clone(),
                node_id.clone(),
                None,
                RuntimeKind::OpenClaw,
                RuntimeState::Running { started_at: at(1) },
                metadata(),
            )],
            vec![crate::topology::EndpointObservation::new(
                endpoint_id,
                node_id,
                runtime_id,
                EndpointHealth::Ready,
                vec![SupportedCapability::new(
                    CapabilityId::try_new("capability.prompt").unwrap(),
                    CapabilityScope::Endpoint,
                )],
                vec![CapabilityAvailability::Available],
                metadata(),
            )],
        )
        .unwrap()
    }

    fn command_ledger() -> CommandLedger {
        let intent = CommandIntent::new(
            CommandId::try_new("command-1").unwrap(),
            crate::command::IdempotencyKey::try_new("private-key").unwrap(),
            CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
            CommandKind::ProbeNode,
            at(1),
        );
        CommandLedger::restore([CommandRecord::queued(intent)]).unwrap()
    }

    #[test]
    fn selector_preview_projects_real_facts_with_stable_order_and_explicit_unavailable_dimensions()
    {
        let topology = topology();
        let constraints = SelectorConstraints::try_new(
            vec!["endpoint-1".to_owned()],
            Vec::new(),
            Vec::new(),
            vec!["production".to_owned()],
            vec!["session.prompt".to_owned()],
        )
        .unwrap();
        let preview = FleetQuerySnapshot::selector_preview(
            &topology,
            &LeaseBook::default(),
            constraints,
            at(20),
        );
        assert!(preview.candidates().is_empty());
        assert_eq!(preview.exclusions().len(), 1);
        assert_eq!(preview.exclusions()[0].endpoint_id().as_str(), "endpoint-1");
        assert_eq!(
            preview.exclusions()[0].reasons(),
            &[
                SelectorExclusionReason::LabelsUnavailable,
                SelectorExclusionReason::OperationIdsUnavailable,
            ]
        );
        assert_eq!(
            preview.unavailable_constraints(),
            &[
                SelectorConstraintDimension::Labels,
                SelectorConstraintDimension::OperationIds,
            ]
        );
    }

    #[test]
    fn selector_preview_accepts_only_source_backed_identity_constraints() {
        let preview = FleetQuerySnapshot::selector_preview(
            &topology(),
            &LeaseBook::default(),
            SelectorConstraints::try_new(
                vec!["endpoint-1".to_owned()],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
            .unwrap(),
            at(20),
        );
        assert_eq!(preview.candidates().len(), 1);
        assert_eq!(
            preview.candidates()[0].capabilities()[0].id(),
            "capability.prompt"
        );
        assert_eq!(preview.candidates()[0].active_lease_count(), 0);
    }

    #[test]
    fn topology_projection_keeps_relationships_and_only_capability_counts() {
        let topology = topology();
        let leases = LeaseBook::default();
        let snapshot = FleetQuerySnapshot::from_sources(
            &topology,
            &CommandLedger::default(),
            &[],
            &leases,
            at(20),
        );

        assert_eq!(snapshot.nodes().len(), 1);
        assert_eq!(snapshot.runtimes()[0].kind(), RuntimeKind::OpenClaw);
        assert_eq!(snapshot.endpoints()[0].supported_capability_count(), 1);
        assert_eq!(snapshot.endpoints()[0].available_capability_count(), 1);
        assert_eq!(snapshot.endpoints()[0].unknown_capability_count(), 0);
        assert_eq!(snapshot.capabilities().len(), 1);
        let capability = &snapshot.capabilities()[0];
        assert_eq!(capability.id().as_str(), "capability.prompt");
        assert_eq!(capability.scope(), CapabilityScope::Endpoint);
        assert_eq!(capability.endpoint_id().as_str(), "endpoint-1");
        assert_eq!(capability.node_id().as_str(), "node-1");
        assert_eq!(capability.runtime_id().as_str(), "runtime-1");
        assert_eq!(capability.availability(), CapabilityAvailability::Available);
        assert_eq!(
            capability.observation().source(),
            ObservationSource::HealthProbe
        );
        assert_eq!(
            capability.observation().freshness(),
            ObservationFreshness::Current
        );
    }

    #[test]
    fn command_projection_excludes_idempotency_and_execution_payloads() {
        let snapshot = FleetQuerySnapshot::from_sources(
            &topology(),
            &command_ledger(),
            &[],
            &LeaseBook::default(),
            at(20),
        );
        let command = &snapshot.commands()[0];

        assert_eq!(command.command_id().as_str(), "command-1");
        assert_eq!(command.kind(), CommandKind::ProbeNode);
        assert!(matches!(
            command.state(),
            CommandSummaryState::Queued { .. }
        ));
    }

    #[test]
    fn audit_projection_keeps_event_identity_and_time_without_message_or_metadata() {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "token".to_owned(),
            FleetAuditValue::Text("secret-value".to_owned()),
        );
        let event = FleetAuditEvent::new(FleetAuditEventInput {
            event_name: "command.completed".to_owned(),
            occurred_at: at(4),
            message: Some("stdout secret-value".to_owned()),
            relations: crate::audit::FleetAuditRelations::default(),
            metadata,
        })
        .unwrap();
        let entry = FleetAuditEntry::try_new(1, event).unwrap();
        let snapshot = FleetQuerySnapshot::from_sources(
            &topology(),
            &CommandLedger::default(),
            &[entry],
            &LeaseBook::default(),
            at(20),
        );

        assert_eq!(snapshot.audit()[0].event_name(), "command.completed");
        assert_eq!(snapshot.audit()[0].occurred_at(), at(4));
        assert_eq!(snapshot.metrics().audit().total(), 1);
    }

    #[test]
    fn metrics_count_logically_expired_leases_without_exposing_lease_identity() {
        let mut leases = LeaseBook::default();
        leases.acquire(
            LeaseId::try_new("lease-1").unwrap(),
            EndpointId::try_new("endpoint-1").unwrap(),
            LeaseOwner::try_new(LeaseOwnerKind::RuntimeStart, "runtime-1").unwrap(),
            at(1),
            LeaseDuration::try_new(Duration::from_secs(5)).unwrap(),
            Capacity::try_new(1).unwrap(),
        );
        let snapshot = FleetQuerySnapshot::from_sources(
            &topology(),
            &CommandLedger::default(),
            &[],
            &leases,
            at(20),
        );

        assert_eq!(snapshot.metrics().leases().total(), 1);
        assert_eq!(snapshot.metrics().leases().active(), 0);
        assert_eq!(snapshot.metrics().leases().expired(), 1);
        assert_eq!(snapshot.metrics().leases().runtime_start(), 1);
    }

    #[test]
    fn lease_projection_keeps_safe_identity_and_state_without_secret_material() {
        let mut leases = LeaseBook::default();
        leases.acquire(
            LeaseId::try_new("lease-1").unwrap(),
            EndpointId::try_new("endpoint-1").unwrap(),
            LeaseOwner::try_new(LeaseOwnerKind::Session, "session-1").unwrap(),
            at(10),
            LeaseDuration::try_new(Duration::from_secs(5)).unwrap(),
            Capacity::try_new(1).unwrap(),
        );

        let snapshot = FleetQuerySnapshot::from_sources(
            &topology(),
            &CommandLedger::default(),
            &[],
            &leases,
            at(12),
        );
        let lease = &snapshot.leases()[0];
        assert_eq!(lease.lease_id().as_str(), "lease-1");
        assert_eq!(lease.endpoint_id().as_str(), "endpoint-1");
        assert_eq!(lease.owner_kind(), LeaseOwnerKind::Session);
        assert_eq!(lease.owner_id(), "session-1");
        assert_eq!(lease.acquired_at(), at(10));
        assert_eq!(
            lease.state(),
            LeaseSummaryState::Active { expires_at: at(15) }
        );
    }

    #[test]
    fn observation_projection_preserves_freshness_without_source_payload() {
        let snapshot = FleetQuerySnapshot::from_sources(
            &topology(),
            &CommandLedger::default(),
            &[],
            &LeaseBook::default(),
            at(20),
        );
        assert_eq!(
            snapshot.nodes()[0].observation().freshness(),
            ObservationFreshness::Current
        );
    }
}
