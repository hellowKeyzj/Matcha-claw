use std::{fmt, time::SystemTime};

use fleet::{
    connection::{ConnectionId, ConnectionKind, ConnectionState},
    environment::{EnvironmentId, ManagedResourceId},
    store::FleetFacts,
    target::{TargetEndpointBinding, TargetId, TargetKind},
    topology::{EndpointHealth, NodeId, RuntimeId, TopologyAssociation},
};
use platform::endpoint::{EndpointId, NativeAgentId};

/// A registration identity that Host may accept only when its source is explicit.
///
/// This owner deliberately has no endpoint, display-name, or provider-derived
/// identity rules. Those values are not canonical identity sources.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RegistrationIdentityResource {
    Connection,
    Environment,
    Node,
    Agent,
    Runtime,
    ManagedResource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AllocationUnavailableReason {
    NoCanonicalAllocator,
    NoSourceBackedDefaultAssociation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AllocationUnavailable {
    resource: RegistrationIdentityResource,
    reason: AllocationUnavailableReason,
}

impl AllocationUnavailable {
    pub(crate) const fn new(
        resource: RegistrationIdentityResource,
        reason: AllocationUnavailableReason,
    ) -> Self {
        Self { resource, reason }
    }

    pub(crate) const fn resource(self) -> RegistrationIdentityResource {
        self.resource
    }

    pub(crate) const fn reason(self) -> AllocationUnavailableReason {
        self.reason
    }
}

impl fmt::Display for AllocationUnavailable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let resource = match self.resource {
            RegistrationIdentityResource::Connection => "connection",
            RegistrationIdentityResource::Environment => "environment",
            RegistrationIdentityResource::Node => "node",
            RegistrationIdentityResource::Agent => "agent",
            RegistrationIdentityResource::Runtime => "runtime",
            RegistrationIdentityResource::ManagedResource => "managed resource",
        };
        let reason = match self.reason {
            AllocationUnavailableReason::NoCanonicalAllocator => {
                "no canonical allocator is available"
            }
            AllocationUnavailableReason::NoSourceBackedDefaultAssociation => {
                "no source-backed default association is available"
            }
        };
        write!(
            formatter,
            "{resource} identity allocation unavailable: {reason}"
        )
    }
}

impl std::error::Error for AllocationUnavailable {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RegistrationIdentityError {
    AllocationUnavailable(AllocationUnavailable),
    ConflictingAssociation(RegistrationIdentityResource),
    AmbiguousSourceAssociation(RegistrationIdentityResource),
}

impl fmt::Display for RegistrationIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllocationUnavailable(error) => error.fmt(formatter),
            Self::ConflictingAssociation(resource) => {
                write!(
                    formatter,
                    "conflicting {resource:?} registration association"
                )
            }
            Self::AmbiguousSourceAssociation(resource) => {
                write!(
                    formatter,
                    "ambiguous source-backed {resource:?} registration association"
                )
            }
        }
    }
}

impl std::error::Error for RegistrationIdentityError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RegistrationGraphAssociation {
    connection_id: ConnectionId,
    environment_id: EnvironmentId,
    node_id: NodeId,
    agent_id: NativeAgentId,
    runtime_id: RuntimeId,
    managed_resource_id: Option<ManagedResourceId>,
}

impl RegistrationGraphAssociation {
    pub(crate) fn new(
        connection_id: ConnectionId,
        environment_id: EnvironmentId,
        node_id: NodeId,
        agent_id: NativeAgentId,
        runtime_id: RuntimeId,
        managed_resource_id: Option<ManagedResourceId>,
    ) -> Self {
        Self {
            connection_id,
            environment_id,
            node_id,
            agent_id,
            runtime_id,
            managed_resource_id,
        }
    }

    pub(crate) fn connection_id(&self) -> &ConnectionId {
        &self.connection_id
    }

    pub(crate) fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub(crate) fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub(crate) fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub(crate) fn runtime_id(&self) -> &RuntimeId {
        &self.runtime_id
    }

    pub(crate) fn managed_resource_id(&self) -> Option<&ManagedResourceId> {
        self.managed_resource_id.as_ref()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RegistrationIdentityFacts {
    environment_graphs: Vec<RegistrationGraphAssociation>,
}

impl RegistrationIdentityFacts {
    pub(crate) fn from_environment_graphs(
        graphs: impl IntoIterator<Item = RegistrationGraphAssociation>,
    ) -> Result<Self, RegistrationIdentityError> {
        let mut environment_graphs = Vec::new();
        for graph in graphs {
            if environment_graphs
                .iter()
                .any(|current: &RegistrationGraphAssociation| {
                    current.environment_id() == graph.environment_id()
                })
            {
                return Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                    RegistrationIdentityResource::Environment,
                ));
            }
            if environment_graphs
                .iter()
                .any(|current: &RegistrationGraphAssociation| current.node_id() == graph.node_id())
            {
                return Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                    RegistrationIdentityResource::Node,
                ));
            }
            if environment_graphs
                .iter()
                .any(|current: &RegistrationGraphAssociation| {
                    current.agent_id() == graph.agent_id()
                })
            {
                return Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                    RegistrationIdentityResource::Agent,
                ));
            }
            if environment_graphs
                .iter()
                .any(|current: &RegistrationGraphAssociation| {
                    current.runtime_id() == graph.runtime_id()
                })
            {
                return Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                    RegistrationIdentityResource::Runtime,
                ));
            }
            if let Some(managed_resource_id) = graph.managed_resource_id()
                && environment_graphs
                    .iter()
                    .any(|current: &RegistrationGraphAssociation| {
                        current.managed_resource_id() == Some(managed_resource_id)
                    })
            {
                return Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                    RegistrationIdentityResource::ManagedResource,
                ));
            }
            environment_graphs.push(graph);
        }
        Ok(Self { environment_graphs })
    }

    fn environment_graph(&self, id: &EnvironmentId) -> Option<&RegistrationGraphAssociation> {
        self.environment_graphs
            .iter()
            .find(|graph| graph.environment_id() == id)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RegistrationIdentityAuthority {
    facts: RegistrationIdentityFacts,
}

impl RegistrationIdentityAuthority {
    pub(crate) fn new(facts: RegistrationIdentityFacts) -> Self {
        Self { facts }
    }

    pub(crate) fn resolve_connection(
        &self,
        request: ConnectionRegistrationIdentityRequest,
    ) -> Result<ConnectionRegistrationIdentity, RegistrationIdentityError> {
        let Some(connection_id) = request.id else {
            return Err(RegistrationIdentityError::AllocationUnavailable(
                AllocationUnavailable::new(
                    RegistrationIdentityResource::Connection,
                    AllocationUnavailableReason::NoCanonicalAllocator,
                ),
            ));
        };
        Ok(ConnectionRegistrationIdentity { connection_id })
    }

    pub(crate) fn resolve_environment(
        &self,
        request: EnvironmentRegistrationIdentityRequest,
    ) -> Result<EnvironmentRegistrationIdentity, RegistrationIdentityError> {
        let Some(environment_id) = request.id else {
            return Err(RegistrationIdentityError::AllocationUnavailable(
                AllocationUnavailable::new(
                    RegistrationIdentityResource::Environment,
                    AllocationUnavailableReason::NoCanonicalAllocator,
                ),
            ));
        };

        let source = self.facts.environment_graph(&environment_id);
        let connection_id = resolve_id(
            RegistrationIdentityResource::Connection,
            request.connection_id,
            source.map(RegistrationGraphAssociation::connection_id),
        )?
        .ok_or_else(|| missing_default(RegistrationIdentityResource::Connection))?;
        let node_id = resolve_id(
            RegistrationIdentityResource::Node,
            request.node_id,
            source.map(RegistrationGraphAssociation::node_id),
        )?
        .ok_or_else(|| missing_default(RegistrationIdentityResource::Node))?;
        let agent_id = resolve_id(
            RegistrationIdentityResource::Agent,
            request.agent_id,
            source.map(RegistrationGraphAssociation::agent_id),
        )?
        .ok_or_else(|| missing_default(RegistrationIdentityResource::Agent))?;
        let runtime_id = resolve_id(
            RegistrationIdentityResource::Runtime,
            request.runtime_id,
            source.map(RegistrationGraphAssociation::runtime_id),
        )?
        .ok_or_else(|| missing_default(RegistrationIdentityResource::Runtime))?;
        let managed_resource_id = resolve_id(
            RegistrationIdentityResource::ManagedResource,
            request.managed_resource_id,
            source.and_then(RegistrationGraphAssociation::managed_resource_id),
        )?;

        Ok(EnvironmentRegistrationIdentity {
            graph: RegistrationGraphAssociation::new(
                connection_id,
                environment_id,
                node_id,
                agent_id,
                runtime_id,
                managed_resource_id,
            ),
        })
    }
}

fn missing_default(resource: RegistrationIdentityResource) -> RegistrationIdentityError {
    RegistrationIdentityError::AllocationUnavailable(AllocationUnavailable::new(
        resource,
        AllocationUnavailableReason::NoSourceBackedDefaultAssociation,
    ))
}

fn resolve_id<T: Clone + Eq>(
    resource: RegistrationIdentityResource,
    requested: Option<T>,
    source: Option<&T>,
) -> Result<Option<T>, RegistrationIdentityError> {
    if let (Some(requested), Some(source)) = (&requested, source) {
        if requested != source {
            return Err(RegistrationIdentityError::ConflictingAssociation(resource));
        }
    }
    Ok(requested.or_else(|| source.cloned()))
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ConnectionRegistrationIdentityRequest {
    pub(crate) id: Option<ConnectionId>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct EnvironmentRegistrationIdentityRequest {
    pub(crate) id: Option<EnvironmentId>,
    pub(crate) connection_id: Option<ConnectionId>,
    pub(crate) node_id: Option<NodeId>,
    pub(crate) agent_id: Option<NativeAgentId>,
    pub(crate) runtime_id: Option<RuntimeId>,
    pub(crate) managed_resource_id: Option<ManagedResourceId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConnectionRegistrationIdentity {
    connection_id: ConnectionId,
}

impl ConnectionRegistrationIdentity {
    pub(crate) fn connection_id(&self) -> &ConnectionId {
        &self.connection_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EnvironmentRegistrationIdentity {
    graph: RegistrationGraphAssociation,
}

impl EnvironmentRegistrationIdentity {
    pub(crate) fn graph(&self) -> &RegistrationGraphAssociation {
        &self.graph
    }

    pub(crate) fn environment_id(&self) -> &EnvironmentId {
        self.graph.environment_id()
    }
}

/// Explicit source facts required to bind one canonical target to one canonical endpoint.
///
/// The request intentionally has no optional identity fields. Callers must provide every
/// identity and association fact; this producer never derives an ID from endpoint data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TargetEndpointBindingRequest {
    target_id: TargetId,
    endpoint_id: EndpointId,
    target_revision: u64,
    target_kind: TargetKind,
    association: TargetEndpointBindingAssociation,
    observed_at: SystemTime,
}

impl TargetEndpointBindingRequest {
    pub(crate) fn try_new(
        target_id: TargetId,
        endpoint_id: EndpointId,
        target_revision: u64,
        target_kind: TargetKind,
        association: TargetEndpointBindingAssociation,
        observed_at: SystemTime,
    ) -> Result<Self, TargetEndpointBindingProducerError> {
        if target_revision == 0 {
            return Err(TargetEndpointBindingProducerError::InvalidRevision);
        }
        if observed_at < SystemTime::UNIX_EPOCH {
            return Err(TargetEndpointBindingProducerError::InvalidObservedAt);
        }
        Ok(Self {
            target_id,
            endpoint_id,
            target_revision,
            target_kind,
            association,
            observed_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TargetEndpointBindingAssociation {
    connection_id: ConnectionId,
    environment_id: Option<EnvironmentId>,
    managed_resource_id: Option<ManagedResourceId>,
}

impl TargetEndpointBindingAssociation {
    pub(crate) fn new(
        connection_id: ConnectionId,
        environment_id: Option<EnvironmentId>,
        managed_resource_id: Option<ManagedResourceId>,
    ) -> Self {
        Self {
            connection_id,
            environment_id,
            managed_resource_id,
        }
    }

    fn topology(&self) -> TopologyAssociation {
        TopologyAssociation::new(
            Some(self.connection_id.clone()),
            self.environment_id.clone(),
            self.managed_resource_id.clone(),
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TargetEndpointBindingProducerError {
    InvalidRevision,
    InvalidObservedAt,
    TargetNotFound,
    TargetRevisionMismatch,
    TargetKindMismatch,
    ConnectionNotFound,
    ConnectionDeleted,
    ConnectionKindMismatch,
    EndpointNotFound,
    EndpointNotCurrent,
    EndpointNotReady,
    EndpointAssociationMismatch,
    EndpointTopologyMismatch,
    ObservationTimestampMismatch,
}

impl fmt::Display for TargetEndpointBindingProducerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRevision => "Fleet target binding producer revision is invalid",
            Self::InvalidObservedAt => "Fleet target binding producer observation time is invalid",
            Self::TargetNotFound => "Fleet target binding producer target was not found",
            Self::TargetRevisionMismatch => {
                "Fleet target binding producer target revision is stale"
            }
            Self::TargetKindMismatch => "Fleet target binding producer target kind does not match",
            Self::ConnectionNotFound => "Fleet target binding producer connection was not found",
            Self::ConnectionDeleted => "Fleet target binding producer connection is deleted",
            Self::ConnectionKindMismatch => {
                "Fleet target binding producer connection kind does not match"
            }
            Self::EndpointNotFound => "Fleet target binding producer endpoint was not found",
            Self::EndpointNotCurrent => {
                "Fleet target binding producer endpoint observation is stale"
            }
            Self::EndpointNotReady => "Fleet target binding producer endpoint is not ready",
            Self::EndpointAssociationMismatch => {
                "Fleet target binding producer endpoint association does not match"
            }
            Self::EndpointTopologyMismatch => {
                "Fleet target binding producer endpoint topology does not match"
            }
            Self::ObservationTimestampMismatch => {
                "Fleet target binding producer observation time does not match endpoint facts"
            }
        })
    }
}

impl std::error::Error for TargetEndpointBindingProducerError {}

pub(crate) struct TargetEndpointBindingProducer;

impl TargetEndpointBindingProducer {
    pub(crate) fn produce(
        facts: &FleetFacts,
        request: TargetEndpointBindingRequest,
    ) -> Result<TargetEndpointBinding, TargetEndpointBindingProducerError> {
        let snapshot = facts
            .target_snapshot(&request.target_id)
            .ok_or(TargetEndpointBindingProducerError::TargetNotFound)?;
        if snapshot.revision() != request.target_revision {
            return Err(TargetEndpointBindingProducerError::TargetRevisionMismatch);
        }
        if snapshot.kind() != request.target_kind {
            return Err(TargetEndpointBindingProducerError::TargetKindMismatch);
        }

        let connection = facts
            .connections()
            .find(|record| record.id() == &request.association.connection_id)
            .ok_or(TargetEndpointBindingProducerError::ConnectionNotFound)?;
        if matches!(connection.state(), ConnectionState::Deleted { .. }) {
            return Err(TargetEndpointBindingProducerError::ConnectionDeleted);
        }
        if !connection_kind_matches_target(connection.kind(), request.target_kind) {
            return Err(TargetEndpointBindingProducerError::ConnectionKindMismatch);
        }

        let endpoint = facts
            .topology()
            .endpoint(&request.endpoint_id)
            .ok_or(TargetEndpointBindingProducerError::EndpointNotFound)?;
        if !endpoint.metadata().freshness().is_current() {
            return Err(TargetEndpointBindingProducerError::EndpointNotCurrent);
        }
        if !matches!(endpoint.health(), EndpointHealth::Ready) {
            return Err(TargetEndpointBindingProducerError::EndpointNotReady);
        }
        if endpoint.association() != &request.association.topology() {
            return Err(TargetEndpointBindingProducerError::EndpointAssociationMismatch);
        }
        let runtime = facts
            .topology()
            .runtime(endpoint.runtime_id())
            .ok_or(TargetEndpointBindingProducerError::EndpointTopologyMismatch)?;
        if runtime.node_id() != endpoint.node_id()
            || !facts
                .topology()
                .nodes()
                .iter()
                .any(|node| node.id() == endpoint.node_id())
        {
            return Err(TargetEndpointBindingProducerError::EndpointTopologyMismatch);
        }
        if endpoint.metadata().observed_at() != request.observed_at {
            return Err(TargetEndpointBindingProducerError::ObservationTimestampMismatch);
        }

        TargetEndpointBinding::try_new(
            request.target_id,
            request.endpoint_id,
            request.target_revision,
            request.observed_at,
        )
        .map_err(|error| match error {
            fleet::FleetTargetBindingError::InvalidRevision => {
                TargetEndpointBindingProducerError::InvalidRevision
            }
            fleet::FleetTargetBindingError::InvalidObservedAt => {
                TargetEndpointBindingProducerError::InvalidObservedAt
            }
            fleet::FleetTargetBindingError::TargetNotFound
            | fleet::FleetTargetBindingError::RevisionMismatch
            | fleet::FleetTargetBindingError::DuplicateTarget => {
                TargetEndpointBindingProducerError::TargetRevisionMismatch
            }
        })
    }
}

fn connection_kind_matches_target(
    connection_kind: ConnectionKind,
    target_kind: TargetKind,
) -> bool {
    matches!(
        (connection_kind, target_kind),
        (
            ConnectionKind::SshHost | ConnectionKind::Vm,
            TargetKind::Ssh
        ) | (ConnectionKind::Container, TargetKind::Docker)
            | (ConnectionKind::KubernetesPod, TargetKind::Kubernetes)
            | (ConnectionKind::Custom, TargetKind::Custom)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id<T, E: std::fmt::Debug>(value: &str, parse: impl FnOnce(String) -> Result<T, E>) -> T {
        parse(value.to_owned()).unwrap()
    }

    fn graph() -> RegistrationGraphAssociation {
        RegistrationGraphAssociation::new(
            id("connection-1", ConnectionId::try_new),
            id("environment-1", EnvironmentId::try_new),
            id("node-1", NodeId::try_new),
            id("agent-1", NativeAgentId::try_new),
            id("runtime-1", RuntimeId::try_new),
            None,
        )
    }

    #[test]
    fn explicit_connection_identity_is_preserved() {
        let authority = RegistrationIdentityAuthority::default();
        let identity = authority
            .resolve_connection(ConnectionRegistrationIdentityRequest {
                id: Some(id("connection-1", ConnectionId::try_new)),
            })
            .unwrap();

        assert_eq!(identity.connection_id().as_str(), "connection-1");
    }

    #[test]
    fn missing_connection_identity_reports_allocation_unavailable() {
        let error = RegistrationIdentityAuthority::default()
            .resolve_connection(ConnectionRegistrationIdentityRequest::default())
            .unwrap_err();

        assert_eq!(
            error,
            RegistrationIdentityError::AllocationUnavailable(AllocationUnavailable::new(
                RegistrationIdentityResource::Connection,
                AllocationUnavailableReason::NoCanonicalAllocator,
            ))
        );
    }

    #[test]
    fn missing_environment_identity_reports_allocation_unavailable() {
        let error = RegistrationIdentityAuthority::default()
            .resolve_environment(EnvironmentRegistrationIdentityRequest::default())
            .unwrap_err();

        assert_eq!(
            error,
            RegistrationIdentityError::AllocationUnavailable(AllocationUnavailable::new(
                RegistrationIdentityResource::Environment,
                AllocationUnavailableReason::NoCanonicalAllocator,
            ))
        );
    }

    #[test]
    fn explicit_environment_graph_is_accepted_without_synthetic_values() {
        let graph = graph();
        let identity = RegistrationIdentityAuthority::default()
            .resolve_environment(EnvironmentRegistrationIdentityRequest {
                id: Some(graph.environment_id().clone()),
                connection_id: Some(graph.connection_id().clone()),
                node_id: Some(graph.node_id().clone()),
                agent_id: Some(graph.agent_id().clone()),
                runtime_id: Some(graph.runtime_id().clone()),
                managed_resource_id: None,
            })
            .unwrap();

        assert_eq!(identity.graph(), &graph);
    }

    #[test]
    fn source_backed_graph_fills_only_exact_environment_association() {
        let graph = graph();
        let authority = RegistrationIdentityAuthority::new(
            RegistrationIdentityFacts::from_environment_graphs([graph.clone()]).unwrap(),
        );
        let identity = authority
            .resolve_environment(EnvironmentRegistrationIdentityRequest {
                id: Some(graph.environment_id().clone()),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(identity.graph(), &graph);
    }

    #[test]
    fn missing_source_backed_graph_reports_the_first_unavailable_default() {
        let authority = RegistrationIdentityAuthority::default();
        let error = authority
            .resolve_environment(EnvironmentRegistrationIdentityRequest {
                id: Some(id("environment-1", EnvironmentId::try_new)),
                connection_id: Some(id("connection-1", ConnectionId::try_new)),
                node_id: Some(id("node-1", NodeId::try_new)),
                ..Default::default()
            })
            .unwrap_err();

        assert_eq!(
            error,
            RegistrationIdentityError::AllocationUnavailable(AllocationUnavailable::new(
                RegistrationIdentityResource::Agent,
                AllocationUnavailableReason::NoSourceBackedDefaultAssociation,
            ))
        );
    }

    #[test]
    fn explicit_association_conflict_is_rejected_against_source_facts() {
        let graph = graph();
        let authority = RegistrationIdentityAuthority::new(
            RegistrationIdentityFacts::from_environment_graphs([graph.clone()]).unwrap(),
        );
        let error = authority
            .resolve_environment(EnvironmentRegistrationIdentityRequest {
                id: Some(graph.environment_id().clone()),
                node_id: Some(id("other-node", NodeId::try_new)),
                ..Default::default()
            })
            .unwrap_err();

        assert_eq!(
            error,
            RegistrationIdentityError::ConflictingAssociation(RegistrationIdentityResource::Node)
        );
    }

    #[test]
    fn duplicate_node_agent_runtime_and_managed_resource_ids_are_rejected() {
        let original = graph();

        let mut duplicate_node = graph();
        duplicate_node.environment_id = id("environment-2", EnvironmentId::try_new);
        assert_eq!(
            RegistrationIdentityFacts::from_environment_graphs([original.clone(), duplicate_node]),
            Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                RegistrationIdentityResource::Node,
            ))
        );

        let mut duplicate_agent = graph();
        duplicate_agent.environment_id = id("environment-2", EnvironmentId::try_new);
        duplicate_agent.node_id = id("node-2", NodeId::try_new);
        duplicate_agent.runtime_id = id("runtime-2", RuntimeId::try_new);
        assert_eq!(
            RegistrationIdentityFacts::from_environment_graphs([original.clone(), duplicate_agent]),
            Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                RegistrationIdentityResource::Agent,
            ))
        );

        let mut duplicate_runtime = graph();
        duplicate_runtime.environment_id = id("environment-2", EnvironmentId::try_new);
        duplicate_runtime.node_id = id("node-2", NodeId::try_new);
        duplicate_runtime.agent_id = id("agent-2", NativeAgentId::try_new);
        assert_eq!(
            RegistrationIdentityFacts::from_environment_graphs([
                original.clone(),
                duplicate_runtime
            ]),
            Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                RegistrationIdentityResource::Runtime,
            ))
        );

        let managed_resource = id("resource-1", ManagedResourceId::try_new);
        let mut first_managed = original;
        first_managed.managed_resource_id = Some(managed_resource.clone());
        let mut second_managed = graph();
        second_managed.environment_id = id("environment-2", EnvironmentId::try_new);
        second_managed.node_id = id("node-2", NodeId::try_new);
        second_managed.agent_id = id("agent-2", NativeAgentId::try_new);
        second_managed.runtime_id = id("runtime-2", RuntimeId::try_new);
        second_managed.managed_resource_id = Some(managed_resource);
        assert_eq!(
            RegistrationIdentityFacts::from_environment_graphs([first_managed, second_managed]),
            Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                RegistrationIdentityResource::ManagedResource,
            ))
        );
    }

    #[test]
    fn duplicate_source_graphs_are_rejected_as_ambiguous() {
        let graph = graph();
        assert_eq!(
            RegistrationIdentityFacts::from_environment_graphs([graph.clone(), graph]),
            Err(RegistrationIdentityError::AmbiguousSourceAssociation(
                RegistrationIdentityResource::Environment,
            ))
        );
    }
}
