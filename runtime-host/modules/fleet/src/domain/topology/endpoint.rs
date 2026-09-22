use platform::{
    capability::{CapabilityAvailability, SupportedCapability},
    endpoint::EndpointId,
};

use super::{NodeId, ObservationMetadata, RuntimeId, TopologyAssociation};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointHealth {
    Unknown,
    Ready,
    Busy,
    Draining,
    Unhealthy,
    Retired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityAvailabilityObservation {
    availability: CapabilityAvailability,
    metadata: ObservationMetadata,
}

impl CapabilityAvailabilityObservation {
    pub const fn new(availability: CapabilityAvailability, metadata: ObservationMetadata) -> Self {
        Self {
            availability,
            metadata,
        }
    }

    pub const fn availability(&self) -> CapabilityAvailability {
        self.availability
    }

    pub const fn metadata(&self) -> ObservationMetadata {
        self.metadata
    }

    pub const fn authorizes_use(&self) -> bool {
        matches!(self.availability, CapabilityAvailability::Available)
            && self.metadata.freshness().is_current()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EndpointObservation {
    id: EndpointId,
    node_id: NodeId,
    runtime_id: RuntimeId,
    association: TopologyAssociation,
    health: EndpointHealth,
    supported_capabilities: Vec<SupportedCapability>,
    availability: Vec<CapabilityAvailability>,
    metadata: ObservationMetadata,
}

impl EndpointObservation {
    pub fn new(
        id: EndpointId,
        node_id: NodeId,
        runtime_id: RuntimeId,
        health: EndpointHealth,
        supported_capabilities: Vec<SupportedCapability>,
        availability: Vec<CapabilityAvailability>,
        metadata: ObservationMetadata,
    ) -> Self {
        Self::with_association(
            id,
            node_id,
            runtime_id,
            TopologyAssociation::none(),
            health,
            supported_capabilities,
            availability,
            metadata,
        )
    }

    pub fn with_association(
        id: EndpointId,
        node_id: NodeId,
        runtime_id: RuntimeId,
        association: TopologyAssociation,
        health: EndpointHealth,
        supported_capabilities: Vec<SupportedCapability>,
        availability: Vec<CapabilityAvailability>,
        metadata: ObservationMetadata,
    ) -> Self {
        assert_eq!(supported_capabilities.len(), availability.len());
        Self {
            id,
            node_id,
            runtime_id,
            association,
            health,
            supported_capabilities,
            availability,
            metadata,
        }
    }

    pub const fn id(&self) -> &EndpointId {
        &self.id
    }

    pub const fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub const fn runtime_id(&self) -> &RuntimeId {
        &self.runtime_id
    }

    pub const fn association(&self) -> &TopologyAssociation {
        &self.association
    }

    pub const fn health(&self) -> EndpointHealth {
        self.health
    }

    pub fn supported_capabilities(&self) -> &[SupportedCapability] {
        &self.supported_capabilities
    }

    pub fn availability(&self) -> &[CapabilityAvailability] {
        &self.availability
    }

    pub fn availability_observation(
        &self,
        capability: &SupportedCapability,
    ) -> Option<CapabilityAvailabilityObservation> {
        self.supported_capabilities
            .iter()
            .position(|supported| supported == capability)
            .and_then(|index| self.availability.get(index).copied())
            .map(|availability| CapabilityAvailabilityObservation::new(availability, self.metadata))
    }

    pub const fn metadata(&self) -> ObservationMetadata {
        self.metadata
    }

    pub(crate) fn with_topology_association(&self, association: TopologyAssociation) -> Self {
        let mut observation = self.clone();
        observation.association = association;
        observation
    }

    pub(crate) fn set_health(&mut self, health: EndpointHealth, metadata: ObservationMetadata) {
        self.health = health;
        self.metadata = metadata;
    }

    pub(crate) fn set_capabilities(
        &mut self,
        supported_capabilities: Vec<SupportedCapability>,
        availability: Vec<CapabilityAvailability>,
        metadata: ObservationMetadata,
    ) {
        self.supported_capabilities = supported_capabilities;
        self.availability = availability;
        self.metadata = metadata;
    }
}
