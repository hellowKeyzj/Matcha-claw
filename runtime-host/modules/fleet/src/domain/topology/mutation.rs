use std::{collections::BTreeSet, time::SystemTime};

use platform::{
    capability::{CapabilityAvailability, SupportedCapability},
    endpoint::{EndpointId, NativeAgentId},
};

use crate::domain::command::CommandId;

use super::{
    AgentObservation, EndpointHealth, EndpointObservation, FleetTopologyFacts, NodeHealth, NodeId,
    NodeObservation, ObservationMetadata, RuntimeId, RuntimeObservation, RuntimeState,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TopologyMutation {
    Inserted,
    Updated,
    Unchanged,
    Started,
    Completed,
    Drained,
    Retired,
    Revoked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TopologyMutationError {
    NotFound,
    InvalidRecord,
    AlreadyRetired,
    Backdated,
    InvalidTransition,
    StaleCommand,
    UnknownNode,
    UnknownAgent,
    UnknownRuntime,
    UnknownEndpoint,
    UnknownRuntimeAgent,
    MismatchedRuntimeAgentNode,
    MissingTopologyGraph,
    AmbiguousTopologyGraph,
    ConflictingTopologyAssociation,
    ConflictingManagedResourceAssociation,
    DuplicateCapability,
    CapabilityLengthMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilitySync {
    pub capabilities: Vec<SupportedCapability>,
    pub availability: Vec<CapabilityAvailability>,
    pub metadata: ObservationMetadata,
}

impl FleetTopologyFacts {
    pub fn associate_managed_resource(
        &mut self,
        connection_id: &crate::domain::connection::ConnectionId,
        environment_id: &crate::domain::environment::EnvironmentId,
        managed_resource_id: crate::domain::environment::ManagedResourceId,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let graph_nodes = self
            .nodes
            .iter()
            .filter(|node| {
                node.association()
                    .is_for_environment(connection_id, environment_id)
            })
            .collect::<Vec<_>>();
        let [node] = graph_nodes.as_slice() else {
            return Err(if graph_nodes.is_empty() {
                TopologyMutationError::MissingTopologyGraph
            } else {
                TopologyMutationError::AmbiguousTopologyGraph
            });
        };

        let graph_agents = self
            .agents
            .iter()
            .filter(|agent| {
                agent.node_id() == node.id()
                    && agent
                        .association()
                        .is_for_environment(connection_id, environment_id)
            })
            .collect::<Vec<_>>();
        let agent = match graph_agents.as_slice() {
            [agent] => *agent,
            [] => {
                let related_agents = self
                    .agents
                    .iter()
                    .filter(|agent| agent.node_id() == node.id())
                    .collect::<Vec<_>>();
                match related_agents.as_slice() {
                    [] => return Err(TopologyMutationError::MissingTopologyGraph),
                    [_] => return Err(TopologyMutationError::ConflictingTopologyAssociation),
                    _ => return Err(TopologyMutationError::AmbiguousTopologyGraph),
                }
            }
            _ => return Err(TopologyMutationError::AmbiguousTopologyGraph),
        };

        let graph_runtimes = self
            .runtimes
            .iter()
            .filter(|runtime| {
                runtime.node_id() == node.id()
                    && runtime.agent_id() == Some(agent.id())
                    && runtime
                        .association()
                        .is_for_environment(connection_id, environment_id)
            })
            .collect::<Vec<_>>();
        let runtime = match graph_runtimes.as_slice() {
            [runtime] => *runtime,
            [] => {
                let related_runtimes = self
                    .runtimes
                    .iter()
                    .filter(|runtime| {
                        runtime.node_id() == node.id() && runtime.agent_id() == Some(agent.id())
                    })
                    .collect::<Vec<_>>();
                match related_runtimes.as_slice() {
                    [] => return Err(TopologyMutationError::MissingTopologyGraph),
                    [_] => return Err(TopologyMutationError::ConflictingTopologyAssociation),
                    _ => return Err(TopologyMutationError::AmbiguousTopologyGraph),
                }
            }
            _ => return Err(TopologyMutationError::AmbiguousTopologyGraph),
        };

        let graph_endpoints = self
            .endpoints
            .iter()
            .filter(|endpoint| {
                endpoint.runtime_id() == runtime.id()
                    && endpoint
                        .association()
                        .is_for_environment(connection_id, environment_id)
            })
            .collect::<Vec<_>>();
        let endpoint = match graph_endpoints.as_slice() {
            [endpoint] => *endpoint,
            [] => {
                let related_endpoints = self
                    .endpoints
                    .iter()
                    .filter(|endpoint| endpoint.runtime_id() == runtime.id())
                    .collect::<Vec<_>>();
                match related_endpoints.as_slice() {
                    [] => return Err(TopologyMutationError::MissingTopologyGraph),
                    [_] => return Err(TopologyMutationError::ConflictingTopologyAssociation),
                    _ => return Err(TopologyMutationError::AmbiguousTopologyGraph),
                }
            }
            _ => return Err(TopologyMutationError::AmbiguousTopologyGraph),
        };

        let observations = [
            node.association(),
            agent.association(),
            runtime.association(),
            endpoint.association(),
        ];
        if observations
            .iter()
            .any(|association| !association.is_for_environment(connection_id, environment_id))
        {
            return Err(TopologyMutationError::ConflictingTopologyAssociation);
        }

        let association = observations[0].with_managed_resource_id(&managed_resource_id);
        if observations.iter().any(|current| {
            current
                .managed_resource_id()
                .is_some_and(|current| current != &managed_resource_id)
        }) {
            return Err(TopologyMutationError::ConflictingManagedResourceAssociation);
        }
        if observations
            .iter()
            .all(|current| current.managed_resource_id() == Some(&managed_resource_id))
        {
            return Ok(TopologyMutation::Unchanged);
        }

        let node_id = node.id().clone();
        let agent_id = agent.id().clone();
        let runtime_id = runtime.id().clone();
        let endpoint_id = endpoint.id().clone();
        let updated_node = node.with_topology_association(association.clone());
        let updated_agent = agent.with_topology_association(association.clone());
        let updated_runtime = runtime.with_topology_association(association.clone());
        let updated_endpoint = endpoint.with_topology_association(association);

        *self
            .nodes
            .iter_mut()
            .find(|current| current.id() == &node_id)
            .expect("validated node remains in topology") = updated_node;
        *self
            .agents
            .iter_mut()
            .find(|current| current.id() == &agent_id)
            .expect("validated agent remains in topology") = updated_agent;
        *self
            .runtimes
            .iter_mut()
            .find(|current| current.id() == &runtime_id)
            .expect("validated runtime remains in topology") = updated_runtime;
        *self
            .endpoints
            .iter_mut()
            .find(|current| current.id() == &endpoint_id)
            .expect("validated endpoint remains in topology") = updated_endpoint;

        Ok(TopologyMutation::Updated)
    }

    pub fn upsert_node(
        &mut self,
        observation: NodeObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        if observation.metadata().observed_at() > now {
            return Err(TopologyMutationError::Backdated);
        }
        if self.retired_nodes.contains_key(observation.id()) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        match self
            .nodes
            .iter_mut()
            .find(|item| item.id() == observation.id())
        {
            None => {
                self.nodes.push(observation);
                self.sort();
                Ok(TopologyMutation::Inserted)
            }
            Some(current) => {
                if observation.metadata().observed_at() < current.metadata().observed_at() {
                    return Err(TopologyMutationError::Backdated);
                }
                if *current == observation {
                    Ok(TopologyMutation::Unchanged)
                } else {
                    *current = observation;
                    Ok(TopologyMutation::Updated)
                }
            }
        }
    }

    pub fn retire_node(
        &mut self,
        id: &NodeId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let current = self
            .nodes
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::NotFound)?;
        if self
            .retired_nodes
            .get(id)
            .is_some_and(|retired| *retired <= at)
        {
            return Ok(TopologyMutation::Unchanged);
        }
        if at < current.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        self.retired_nodes.insert(id.clone(), at);
        current.set_health(
            NodeHealth::Disabled,
            ObservationMetadata::new(
                current.metadata().source(),
                at,
                super::ObservationFreshness::Pruned,
            ),
        );
        Ok(TopologyMutation::Retired)
    }

    pub fn upsert_agent(
        &mut self,
        observation: AgentObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        if !self
            .nodes
            .iter()
            .any(|node| node.id() == observation.node_id())
        {
            return Err(TopologyMutationError::UnknownNode);
        }
        if observation.metadata().observed_at() > now {
            return Err(TopologyMutationError::Backdated);
        }
        if self.revoked_agents.contains_key(observation.id().as_str()) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        match self
            .agents
            .iter_mut()
            .find(|item| item.id() == observation.id())
        {
            None => {
                self.agents.push(observation);
                self.sort();
                Ok(TopologyMutation::Inserted)
            }
            Some(current) => {
                if current.node_id() != observation.node_id() {
                    return Err(TopologyMutationError::MismatchedRuntimeAgentNode);
                }
                if observation.metadata().observed_at() < current.metadata().observed_at() {
                    return Err(TopologyMutationError::Backdated);
                }
                if *current == observation {
                    Ok(TopologyMutation::Unchanged)
                } else {
                    *current = observation;
                    Ok(TopologyMutation::Updated)
                }
            }
        }
    }

    pub fn enroll_agent(
        &mut self,
        id: &NativeAgentId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        if !self.agents.iter().any(|agent| agent.id() == id) {
            return Err(TopologyMutationError::UnknownAgent);
        }
        if let Some(previous) = self.enrolled_agents.get(id.as_str()) {
            if at < *previous {
                return Err(TopologyMutationError::Backdated);
            }
            return Ok(TopologyMutation::Unchanged);
        }
        if self.revoked_agents.contains_key(id.as_str()) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        self.enrolled_agents.insert(id.as_str().to_owned(), at);
        Ok(TopologyMutation::Inserted)
    }

    pub fn revoke_agent(
        &mut self,
        id: &NativeAgentId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        if !self.agents.iter().any(|agent| agent.id() == id) {
            return Err(TopologyMutationError::UnknownAgent);
        }
        if let Some(previous) = self.revoked_agents.get(id.as_str()) {
            if *previous > at {
                return Err(TopologyMutationError::Backdated);
            }
            return Ok(TopologyMutation::Unchanged);
        }
        if self
            .enrolled_agents
            .get(id.as_str())
            .is_some_and(|issued| at < *issued)
        {
            return Err(TopologyMutationError::Backdated);
        }
        self.revoked_agents.insert(id.as_str().to_owned(), at);
        Ok(TopologyMutation::Revoked)
    }

    pub fn upsert_runtime(
        &mut self,
        observation: RuntimeObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        if !self
            .nodes
            .iter()
            .any(|node| node.id() == observation.node_id())
        {
            return Err(TopologyMutationError::UnknownNode);
        }
        if let Some(agent_id) = observation.agent_id() {
            let Some(agent) = self.agents.iter().find(|agent| agent.id() == agent_id) else {
                return Err(TopologyMutationError::UnknownRuntimeAgent);
            };
            if agent.node_id() != observation.node_id() {
                return Err(TopologyMutationError::MismatchedRuntimeAgentNode);
            }
        }
        if observation.metadata().observed_at() > now {
            return Err(TopologyMutationError::Backdated);
        }
        match self
            .runtimes
            .iter_mut()
            .find(|item| item.id() == observation.id())
        {
            None => {
                self.runtimes.push(observation);
                self.sort();
                Ok(TopologyMutation::Inserted)
            }
            Some(current) => {
                if matches!(current.state(), RuntimeState::Retired { .. }) {
                    return Err(TopologyMutationError::AlreadyRetired);
                }
                if observation.metadata().observed_at() < current.metadata().observed_at() {
                    return Err(TopologyMutationError::Backdated);
                }
                if *current == observation {
                    Ok(TopologyMutation::Unchanged)
                } else {
                    *current = observation;
                    Ok(TopologyMutation::Updated)
                }
            }
        }
    }

    pub fn begin_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let runtime = self
            .runtimes
            .iter()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownRuntime)?;
        if at < runtime.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        if matches!(runtime.state(), RuntimeState::Retired { .. }) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        self.runtime_commands
            .insert(id.clone(), PendingRuntimeCommand::Start(command));
        Ok(TopologyMutation::Started)
    }

    pub fn complete_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let pending = self
            .runtime_commands
            .get(id)
            .ok_or(TopologyMutationError::InvalidTransition)?;
        if !matches!(pending, PendingRuntimeCommand::Start(current) if current == command) {
            return Err(TopologyMutationError::StaleCommand);
        }
        let runtime = self
            .runtimes
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownRuntime)?;
        if at < runtime.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        runtime.set_state(
            RuntimeState::Running { started_at: at },
            ObservationMetadata::new(
                runtime.metadata().source(),
                at,
                super::ObservationFreshness::Current,
            ),
        );
        self.runtime_commands.remove(id);
        Ok(TopologyMutation::Completed)
    }

    pub fn begin_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let runtime = self
            .runtimes
            .iter()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownRuntime)?;
        if at < runtime.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        if matches!(runtime.state(), RuntimeState::Retired { .. }) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        self.runtime_commands
            .insert(id.clone(), PendingRuntimeCommand::Stop(command));
        Ok(TopologyMutation::Started)
    }

    pub fn complete_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let pending = self
            .runtime_commands
            .get(id)
            .ok_or(TopologyMutationError::InvalidTransition)?;
        if !matches!(pending, PendingRuntimeCommand::Stop(current) if current == command) {
            return Err(TopologyMutationError::StaleCommand);
        }
        let runtime = self
            .runtimes
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownRuntime)?;
        if at < runtime.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        runtime.set_state(
            RuntimeState::Stopped {
                stopped_at: Some(at),
            },
            ObservationMetadata::new(
                runtime.metadata().source(),
                at,
                super::ObservationFreshness::Current,
            ),
        );
        self.runtime_commands.remove(id);
        Ok(TopologyMutation::Completed)
    }

    pub fn retire_runtime(
        &mut self,
        id: &RuntimeId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let runtime = self
            .runtimes
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownRuntime)?;
        if let RuntimeState::Retired { retired_at } = runtime.state() {
            if retired_at <= at {
                return Ok(TopologyMutation::Unchanged);
            }
        }
        if at < runtime.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        runtime.set_state(
            RuntimeState::Retired { retired_at: at },
            ObservationMetadata::new(
                runtime.metadata().source(),
                at,
                super::ObservationFreshness::Pruned,
            ),
        );
        Ok(TopologyMutation::Retired)
    }

    pub fn upsert_endpoint(
        &mut self,
        observation: EndpointObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let runtime = self
            .runtimes
            .iter()
            .find(|item| item.id() == observation.runtime_id())
            .ok_or(TopologyMutationError::UnknownRuntime)?;
        if runtime.node_id() != observation.node_id() {
            return Err(TopologyMutationError::MismatchedRuntimeAgentNode);
        }
        if observation.metadata().observed_at() > now {
            return Err(TopologyMutationError::Backdated);
        }
        validate_capabilities(&observation)?;
        match self
            .endpoints
            .iter_mut()
            .find(|item| item.id() == observation.id())
        {
            None => {
                self.endpoints.push(observation);
                self.sort();
                Ok(TopologyMutation::Inserted)
            }
            Some(current) => {
                if matches!(current.health(), EndpointHealth::Retired) {
                    return Err(TopologyMutationError::AlreadyRetired);
                }
                if observation.metadata().observed_at() < current.metadata().observed_at() {
                    return Err(TopologyMutationError::Backdated);
                }
                if *current == observation {
                    Ok(TopologyMutation::Unchanged)
                } else {
                    *current = observation;
                    Ok(TopologyMutation::Updated)
                }
            }
        }
    }

    pub fn drain_endpoint(
        &mut self,
        id: &EndpointId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let endpoint = self
            .endpoints
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownEndpoint)?;
        if matches!(endpoint.health(), EndpointHealth::Retired) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        if at < endpoint.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        endpoint.set_health(
            EndpointHealth::Draining,
            ObservationMetadata::new(
                endpoint.metadata().source(),
                at,
                super::ObservationFreshness::Current,
            ),
        );
        Ok(TopologyMutation::Drained)
    }

    pub fn retire_endpoint(
        &mut self,
        id: &EndpointId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let endpoint = self
            .endpoints
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownEndpoint)?;
        if matches!(endpoint.health(), EndpointHealth::Retired) {
            return Ok(TopologyMutation::Unchanged);
        }
        if at < endpoint.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        endpoint.set_health(
            EndpointHealth::Retired,
            ObservationMetadata::new(
                endpoint.metadata().source(),
                at,
                super::ObservationFreshness::Pruned,
            ),
        );
        Ok(TopologyMutation::Retired)
    }

    pub fn begin_endpoint_probe(
        &mut self,
        id: &EndpointId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let endpoint = self
            .endpoints
            .iter()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownEndpoint)?;
        if at < endpoint.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        if matches!(endpoint.health(), EndpointHealth::Retired) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        self.endpoint_commands.insert(
            id.as_str().to_owned(),
            PendingEndpointCommand::Probe(command),
        );
        Ok(TopologyMutation::Started)
    }

    pub fn complete_endpoint_probe(
        &mut self,
        id: &EndpointId,
        command: &CommandId,
        health: EndpointHealth,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let pending = self
            .endpoint_commands
            .get(id.as_str())
            .ok_or(TopologyMutationError::InvalidTransition)?;
        if !matches!(pending, PendingEndpointCommand::Probe(current) if current == command) {
            return Err(TopologyMutationError::StaleCommand);
        }
        let endpoint = self
            .endpoints
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownEndpoint)?;
        if at < endpoint.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        endpoint.set_health(
            health,
            ObservationMetadata::new(
                endpoint.metadata().source(),
                at,
                super::ObservationFreshness::Current,
            ),
        );
        self.endpoint_commands.remove(id.as_str());
        Ok(TopologyMutation::Completed)
    }

    pub fn begin_capability_sync(
        &mut self,
        id: &EndpointId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let endpoint = self
            .endpoints
            .iter()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownEndpoint)?;
        if at < endpoint.metadata().observed_at() {
            return Err(TopologyMutationError::Backdated);
        }
        if matches!(endpoint.health(), EndpointHealth::Retired) {
            return Err(TopologyMutationError::AlreadyRetired);
        }
        self.endpoint_commands.insert(
            id.as_str().to_owned(),
            PendingEndpointCommand::CapabilitySync(command),
        );
        Ok(TopologyMutation::Started)
    }

    pub fn complete_capability_sync(
        &mut self,
        id: &EndpointId,
        command: &CommandId,
        sync: CapabilitySync,
        at: SystemTime,
    ) -> Result<TopologyMutation, TopologyMutationError> {
        let pending = self
            .endpoint_commands
            .get(id.as_str())
            .ok_or(TopologyMutationError::InvalidTransition)?;
        if !matches!(pending, PendingEndpointCommand::CapabilitySync(current) if current == command)
        {
            return Err(TopologyMutationError::StaleCommand);
        }
        if sync.capabilities.len() != sync.availability.len() {
            return Err(TopologyMutationError::CapabilityLengthMismatch);
        }
        let mut ids = BTreeSet::new();
        for capability in &sync.capabilities {
            if !ids.insert(capability.id().as_str()) {
                return Err(TopologyMutationError::DuplicateCapability);
            }
        }
        let endpoint = self
            .endpoints
            .iter_mut()
            .find(|item| item.id() == id)
            .ok_or(TopologyMutationError::UnknownEndpoint)?;
        if at < endpoint.metadata().observed_at() || sync.metadata.observed_at() > at {
            return Err(TopologyMutationError::Backdated);
        }
        endpoint.set_capabilities(sync.capabilities, sync.availability, sync.metadata);
        self.endpoint_commands.remove(id.as_str());
        Ok(TopologyMutation::Completed)
    }

    fn sort(&mut self) {
        self.nodes
            .sort_by(|a, b| a.id().as_str().cmp(b.id().as_str()));
        self.agents
            .sort_by(|a, b| a.id().as_str().cmp(b.id().as_str()));
        self.runtimes
            .sort_by(|a, b| a.id().as_str().cmp(b.id().as_str()));
        self.endpoints
            .sort_by(|a, b| a.id().as_str().cmp(b.id().as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::super::RuntimeKind;
    use super::*;
    use crate::{
        domain::connection::ConnectionId,
        domain::environment::{EnvironmentId, ManagedResourceId},
    };
    use platform::endpoint::NativeAgentId;

    const OBSERVED_AT: SystemTime = SystemTime::UNIX_EPOCH;

    fn metadata() -> ObservationMetadata {
        ObservationMetadata::new(
            super::super::ObservationSource::Discovery,
            OBSERVED_AT,
            super::super::ObservationFreshness::Current,
        )
    }

    fn facts(resource_id: Option<&str>) -> FleetTopologyFacts {
        let connection_id = ConnectionId::try_new("connection-a").unwrap();
        let environment_id = EnvironmentId::try_new("environment-a").unwrap();
        let association = super::super::TopologyAssociation::new(
            Some(connection_id),
            Some(environment_id),
            resource_id.map(|id| ManagedResourceId::try_new(id).unwrap()),
        );
        let node_id = NodeId::try_new("node-a").unwrap();
        let agent_id = NativeAgentId::try_new("agent-a").unwrap();
        let runtime_id = RuntimeId::try_new("runtime-a").unwrap();
        FleetTopologyFacts::restore(
            vec![NodeObservation::with_association(
                node_id.clone(),
                association.clone(),
                NodeHealth::Online {
                    last_seen_at: OBSERVED_AT,
                },
                metadata(),
            )],
            vec![AgentObservation::with_association(
                agent_id.clone(),
                node_id.clone(),
                association.clone(),
                metadata(),
            )],
            vec![RuntimeObservation::with_association(
                runtime_id.clone(),
                node_id.clone(),
                Some(agent_id),
                association.clone(),
                RuntimeKind::OpenClaw,
                RuntimeState::Running {
                    started_at: OBSERVED_AT,
                },
                metadata(),
            )],
            vec![EndpointObservation::with_association(
                EndpointId::try_new("endpoint-a").unwrap(),
                node_id,
                runtime_id,
                association,
                EndpointHealth::Ready,
                Vec::new(),
                Vec::new(),
                metadata(),
            )],
        )
        .unwrap()
    }

    fn association_inputs() -> (ConnectionId, EnvironmentId, ManagedResourceId) {
        (
            ConnectionId::try_new("connection-a").unwrap(),
            EnvironmentId::try_new("environment-a").unwrap(),
            ManagedResourceId::try_new("resource-a").unwrap(),
        )
    }

    #[test]
    fn associates_one_complete_graph() {
        let mut topology = facts(None);
        let (connection_id, environment_id, resource_id) = association_inputs();

        assert_eq!(
            topology.associate_managed_resource(
                &connection_id,
                &environment_id,
                resource_id.clone()
            ),
            Ok(TopologyMutation::Updated)
        );
        assert!(
            topology
                .nodes()
                .iter()
                .all(|item| item.association().managed_resource_id() == Some(&resource_id))
        );
        assert!(
            topology
                .agents()
                .iter()
                .all(|item| item.association().managed_resource_id() == Some(&resource_id))
        );
        assert!(
            topology
                .runtimes()
                .iter()
                .all(|item| item.association().managed_resource_id() == Some(&resource_id))
        );
        assert!(
            topology
                .endpoints()
                .iter()
                .all(|item| item.association().managed_resource_id() == Some(&resource_id))
        );
    }

    #[test]
    fn repeated_association_is_unchanged() {
        let mut topology = facts(Some("resource-a"));
        let (connection_id, environment_id, resource_id) = association_inputs();

        assert_eq!(
            topology.associate_managed_resource(&connection_id, &environment_id, resource_id),
            Ok(TopologyMutation::Unchanged)
        );
    }

    #[test]
    fn missing_graph_is_rejected() {
        let mut topology = FleetTopologyFacts::default();
        let (connection_id, environment_id, resource_id) = association_inputs();

        assert_eq!(
            topology.associate_managed_resource(&connection_id, &environment_id, resource_id),
            Err(TopologyMutationError::MissingTopologyGraph)
        );
    }

    #[test]
    fn multiple_nodes_are_rejected() {
        let mut topology = facts(None);
        let association = topology.nodes()[0].association().clone();
        topology.nodes.push(NodeObservation::with_association(
            NodeId::try_new("node-b").unwrap(),
            association,
            NodeHealth::Online {
                last_seen_at: OBSERVED_AT,
            },
            metadata(),
        ));
        let (connection_id, environment_id, resource_id) = association_inputs();

        assert_eq!(
            topology.associate_managed_resource(&connection_id, &environment_id, resource_id),
            Err(TopologyMutationError::AmbiguousTopologyGraph)
        );
    }

    #[test]
    fn conflicting_resource_is_not_overwritten() {
        let mut topology = facts(Some("resource-existing"));
        let (connection_id, environment_id, resource_id) = association_inputs();

        assert_eq!(
            topology.associate_managed_resource(&connection_id, &environment_id, resource_id),
            Err(TopologyMutationError::ConflictingManagedResourceAssociation)
        );
        assert_eq!(
            topology.nodes()[0]
                .association()
                .managed_resource_id()
                .unwrap()
                .as_str(),
            "resource-existing"
        );
    }
}

fn validate_capabilities(endpoint: &EndpointObservation) -> Result<(), TopologyMutationError> {
    if endpoint.supported_capabilities().len() != endpoint.availability().len() {
        return Err(TopologyMutationError::CapabilityLengthMismatch);
    }
    let mut ids = BTreeSet::new();
    for capability in endpoint.supported_capabilities() {
        if !ids.insert(capability.id().as_str()) {
            return Err(TopologyMutationError::DuplicateCapability);
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PendingRuntimeCommand {
    Start(CommandId),
    Stop(CommandId),
}

impl PendingRuntimeCommand {
    pub(crate) const fn command_id(&self) -> &CommandId {
        match self {
            Self::Start(command) | Self::Stop(command) => command,
        }
    }

    pub(crate) const fn kind(&self) -> PendingRuntimeCommandKind {
        match self {
            Self::Start(_) => PendingRuntimeCommandKind::Start,
            Self::Stop(_) => PendingRuntimeCommandKind::Stop,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PendingRuntimeCommandKind {
    Start,
    Stop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PendingEndpointCommand {
    Probe(CommandId),
    CapabilitySync(CommandId),
}

impl PendingEndpointCommand {
    pub(crate) const fn command_id(&self) -> &CommandId {
        match self {
            Self::Probe(command) | Self::CapabilitySync(command) => command,
        }
    }

    pub(crate) const fn kind(&self) -> PendingEndpointCommandKind {
        match self {
            Self::Probe(_) => PendingEndpointCommandKind::Probe,
            Self::CapabilitySync(_) => PendingEndpointCommandKind::CapabilitySync,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PendingEndpointCommandKind {
    Probe,
    CapabilitySync,
}
