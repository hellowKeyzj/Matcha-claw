use super::*;
use crate::{
    connection::ConnectionId,
    environment::{EnvironmentId, ManagedResourceId},
    topology::TopologyAssociation,
};

impl Reader<'_> {
    pub(super) fn topology(
        &mut self,
        with_lifecycle: bool,
        with_associations: bool,
    ) -> Result<FleetTopologyFacts, StoreFault> {
        let nodes = (0..self.count()?)
            .map(|_| {
                let id = self.node_id()?;
                let association = self.topology_association(with_associations)?;
                Ok(NodeObservation::with_association(
                    id,
                    association,
                    self.node_health()?,
                    self.observation_metadata()?,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let agents = (0..self.count()?)
            .map(|_| {
                let id = self.native_agent_id()?;
                let node_id = self.node_id()?;
                let association = self.topology_association(with_associations)?;
                Ok(AgentObservation::with_association(
                    id,
                    node_id,
                    association,
                    self.observation_metadata()?,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let runtimes = (0..self.count()?)
            .map(|_| {
                let id =
                    RuntimeId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let node_id = self.node_id()?;
                let agent_id = self.optional_native_agent_id()?;
                let association = self.topology_association(with_associations)?;
                let kind = self.runtime_kind()?;
                let state = self.runtime_state()?;
                let metadata = self.observation_metadata()?;
                Ok(RuntimeObservation::with_association(
                    id,
                    node_id,
                    agent_id,
                    association,
                    kind,
                    state,
                    metadata,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let endpoints = (0..self.count()?)
            .map(|_| {
                let id =
                    EndpointId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let node_id = self.node_id()?;
                let runtime_id =
                    RuntimeId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let association = self.topology_association(with_associations)?;
                let health = self.endpoint_health()?;
                let encoded_capabilities = (0..self.count()?)
                    .map(|_| {
                        Ok((
                            SupportedCapability::new(
                                CapabilityId::try_new(self.string()?)
                                    .map_err(|_| StoreFault::CorruptRecord)?,
                                self.capability_scope()?,
                            ),
                            self.capability_availability()?,
                        ))
                    })
                    .collect::<Result<Vec<_>, StoreFault>>()?;
                let metadata = self.observation_metadata()?;
                let (supported_capabilities, availability) =
                    encoded_capabilities.into_iter().unzip();
                Ok(EndpointObservation::with_association(
                    id,
                    node_id,
                    runtime_id,
                    association,
                    health,
                    supported_capabilities,
                    availability,
                    metadata,
                ))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        if !with_lifecycle {
            return FleetTopologyFacts::restore(nodes, agents, runtimes, endpoints)
                .map_err(|_| StoreFault::CorruptRecord);
        }
        let retired_nodes = (0..self.count()?)
            .map(|_| Ok((self.node_id()?, self.system_time()?)))
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let enrolled_agents = (0..self.count()?)
            .map(|_| Ok((self.string()?, self.system_time()?)))
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let revoked_agents = (0..self.count()?)
            .map(|_| Ok((self.string()?, self.system_time()?)))
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let runtime_commands = (0..self.count()?)
            .map(|_| {
                let id =
                    RuntimeId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let kind = self.byte()?;
                let command =
                    CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let pending = match kind {
                    0 => PendingRuntimeCommand::Start(command),
                    1 => PendingRuntimeCommand::Stop(command),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                Ok((id, pending))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let endpoint_commands = (0..self.count()?)
            .map(|_| {
                let id = self.string()?;
                let kind = self.byte()?;
                let command =
                    CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let pending = match kind {
                    0 => PendingEndpointCommand::Probe(command),
                    1 => PendingEndpointCommand::CapabilitySync(command),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                Ok((id, pending))
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        FleetTopologyFacts::restore_with_lifecycle(
            nodes,
            agents,
            runtimes,
            endpoints,
            retired_nodes,
            enrolled_agents,
            revoked_agents,
            runtime_commands,
            endpoint_commands,
        )
        .map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn topology_association(
        &mut self,
        present: bool,
    ) -> Result<TopologyAssociation, StoreFault> {
        if !present {
            return Ok(TopologyAssociation::none());
        }
        let connection_id = self
            .optional_string()?
            .map(ConnectionId::try_new)
            .transpose()
            .map_err(|_| StoreFault::CorruptRecord)?;
        let environment_id = self
            .optional_string()?
            .map(EnvironmentId::try_new)
            .transpose()
            .map_err(|_| StoreFault::CorruptRecord)?;
        let managed_resource_id = self
            .optional_string()?
            .map(ManagedResourceId::try_new)
            .transpose()
            .map_err(|_| StoreFault::CorruptRecord)?;
        Ok(TopologyAssociation::new(
            connection_id,
            environment_id,
            managed_resource_id,
        ))
    }

    pub(super) fn native_agent_id(&mut self) -> Result<NativeAgentId, StoreFault> {
        NativeAgentId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn optional_native_agent_id(&mut self) -> Result<Option<NativeAgentId>, StoreFault> {
        match self.optional_string()? {
            Some(value) => NativeAgentId::try_new(value)
                .map(Some)
                .map_err(|_| StoreFault::CorruptRecord),
            None => Ok(None),
        }
    }

    pub(super) fn observation_metadata(&mut self) -> Result<ObservationMetadata, StoreFault> {
        let source = match self.byte()? {
            0 => ObservationSource::Discovery,
            1 => ObservationSource::HealthProbe,
            2 => ObservationSource::RuntimeAgent,
            _ => return Err(StoreFault::CorruptRecord),
        };
        let observed_at = self.system_time()?;
        let freshness = match self.byte()? {
            0 => ObservationFreshness::Current,
            1 => ObservationFreshness::Stale,
            2 => ObservationFreshness::Unknown,
            3 => ObservationFreshness::Pruned,
            _ => return Err(StoreFault::CorruptRecord),
        };
        Ok(ObservationMetadata::new(source, observed_at, freshness))
    }

    pub(super) fn node_health(&mut self) -> Result<NodeHealth, StoreFault> {
        match self.byte()? {
            0 => Ok(NodeHealth::Unknown),
            1 => Ok(NodeHealth::Online {
                last_seen_at: self.system_time()?,
            }),
            2 => Ok(NodeHealth::Offline {
                last_seen_at: self.optional_system_time()?,
            }),
            3 => Ok(NodeHealth::Disabled),
            4 => Ok(NodeHealth::Error),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn runtime_kind(&mut self) -> Result<RuntimeKind, StoreFault> {
        match self.byte()? {
            0 => Ok(RuntimeKind::OpenClaw),
            1 => Ok(RuntimeKind::MatchaAgent),
            2 => Ok(RuntimeKind::Plugin),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn runtime_state(&mut self) -> Result<RuntimeState, StoreFault> {
        match self.byte()? {
            0 => Ok(RuntimeState::Discovered),
            1 => Ok(RuntimeState::Running {
                started_at: self.system_time()?,
            }),
            2 => Ok(RuntimeState::Stopped {
                stopped_at: self.optional_system_time()?,
            }),
            3 => Ok(RuntimeState::Degraded),
            4 => Ok(RuntimeState::Retired {
                retired_at: self.system_time()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn endpoint_health(&mut self) -> Result<EndpointHealth, StoreFault> {
        match self.byte()? {
            0 => Ok(EndpointHealth::Unknown),
            1 => Ok(EndpointHealth::Ready),
            2 => Ok(EndpointHealth::Busy),
            3 => Ok(EndpointHealth::Draining),
            4 => Ok(EndpointHealth::Unhealthy),
            5 => Ok(EndpointHealth::Retired),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn capability_scope(&mut self) -> Result<CapabilityScope, StoreFault> {
        match self.byte()? {
            0 => Ok(CapabilityScope::Endpoint),
            1 => Ok(CapabilityScope::Agent),
            2 => Ok(CapabilityScope::Session),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn capability_availability(&mut self) -> Result<CapabilityAvailability, StoreFault> {
        match self.byte()? {
            0 => Ok(CapabilityAvailability::Available),
            1 => Ok(CapabilityAvailability::Unavailable),
            2 => Ok(CapabilityAvailability::Unknown),
            _ => Err(StoreFault::CorruptRecord),
        }
    }
}
