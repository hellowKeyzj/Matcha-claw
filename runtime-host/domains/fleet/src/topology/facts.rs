use std::{collections::BTreeMap, time::SystemTime};

use super::{
    AgentObservation, EndpointObservation, NodeId, NodeObservation, RuntimeId, RuntimeObservation,
    TopologyError, TopologyOracle,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FleetTopologyFacts {
    pub(crate) nodes: Vec<NodeObservation>,
    pub(crate) agents: Vec<AgentObservation>,
    pub(crate) runtimes: Vec<RuntimeObservation>,
    pub(crate) endpoints: Vec<EndpointObservation>,
    pub(crate) retired_nodes: BTreeMap<NodeId, SystemTime>,
    pub(crate) enrolled_agents: BTreeMap<String, SystemTime>,
    pub(crate) revoked_agents: BTreeMap<String, SystemTime>,
    pub(crate) runtime_commands: BTreeMap<RuntimeId, super::PendingRuntimeCommand>,
    pub(crate) endpoint_commands: BTreeMap<String, super::PendingEndpointCommand>,
}

fn collect_unique<K: Ord, V>(
    entries: impl IntoIterator<Item = (K, V)>,
) -> Result<BTreeMap<K, V>, TopologyError> {
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if result.insert(key, value).is_some() {
            return Err(TopologyError::DuplicateLifecycleIdentity);
        }
    }
    Ok(result)
}

impl FleetTopologyFacts {
    pub fn restore(
        nodes: Vec<NodeObservation>,
        agents: Vec<AgentObservation>,
        runtimes: Vec<RuntimeObservation>,
        endpoints: Vec<EndpointObservation>,
    ) -> Result<Self, TopologyError> {
        Self::restore_with_lifecycle(nodes, agents, runtimes, endpoints, [], [], [], [], [])
    }

    pub(crate) fn restore_with_lifecycle(
        mut nodes: Vec<NodeObservation>,
        mut agents: Vec<AgentObservation>,
        mut runtimes: Vec<RuntimeObservation>,
        mut endpoints: Vec<EndpointObservation>,
        retired_nodes: impl IntoIterator<Item = (NodeId, SystemTime)>,
        enrolled_agents: impl IntoIterator<Item = (String, SystemTime)>,
        revoked_agents: impl IntoIterator<Item = (String, SystemTime)>,
        runtime_commands: impl IntoIterator<Item = (RuntimeId, super::PendingRuntimeCommand)>,
        endpoint_commands: impl IntoIterator<Item = (String, super::PendingEndpointCommand)>,
    ) -> Result<Self, TopologyError> {
        TopologyOracle.validate_with_agents(&nodes, &agents, &[], &runtimes, &endpoints)?;
        nodes.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        agents.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        runtimes.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        endpoints.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));

        let retired_nodes = collect_unique(retired_nodes)?;
        let enrolled_agents = collect_unique(enrolled_agents)?;
        let revoked_agents = collect_unique(revoked_agents)?;
        let runtime_commands = collect_unique(runtime_commands)?;
        let endpoint_commands = collect_unique(endpoint_commands)?;

        for (node_id, retired_at) in &retired_nodes {
            let Some(node) = nodes.iter().find(|node| node.id() == node_id) else {
                return Err(TopologyError::UnknownRetiredNode);
            };
            if *retired_at < node.metadata().observed_at() {
                return Err(TopologyError::BackdatedLifecycle);
            }
        }
        for agent_id in enrolled_agents.keys().chain(revoked_agents.keys()) {
            if !agents.iter().any(|agent| agent.id().as_str() == agent_id) {
                return Err(TopologyError::UnknownLifecycleAgent);
            }
        }
        for runtime_id in runtime_commands.keys() {
            if !runtimes.iter().any(|runtime| runtime.id() == runtime_id) {
                return Err(TopologyError::UnknownLifecycleRuntime);
            }
        }
        for endpoint_id in endpoint_commands.keys() {
            if !endpoints
                .iter()
                .any(|endpoint| endpoint.id().as_str() == endpoint_id)
            {
                return Err(TopologyError::UnknownLifecycleEndpoint);
            }
        }

        Ok(Self {
            nodes,
            agents,
            runtimes,
            endpoints,
            retired_nodes,
            enrolled_agents,
            revoked_agents,
            runtime_commands,
            endpoint_commands,
        })
    }

    pub fn nodes(&self) -> &[NodeObservation] {
        &self.nodes
    }

    pub fn agents(&self) -> &[AgentObservation] {
        &self.agents
    }

    pub fn runtimes(&self) -> &[RuntimeObservation] {
        &self.runtimes
    }

    pub fn endpoints(&self) -> &[EndpointObservation] {
        &self.endpoints
    }

    pub(crate) fn retired_nodes(&self) -> impl Iterator<Item = (&NodeId, &SystemTime)> {
        self.retired_nodes.iter()
    }

    pub(crate) fn enrolled_agents(&self) -> impl Iterator<Item = (&str, SystemTime)> {
        self.enrolled_agents
            .iter()
            .map(|(id, at)| (id.as_str(), *at))
    }

    pub(crate) fn revoked_agents(&self) -> impl Iterator<Item = (&str, SystemTime)> {
        self.revoked_agents
            .iter()
            .map(|(id, at)| (id.as_str(), *at))
    }

    pub(crate) fn runtime_commands(
        &self,
    ) -> impl Iterator<Item = (&RuntimeId, &super::PendingRuntimeCommand)> {
        self.runtime_commands.iter()
    }

    pub(crate) fn endpoint_commands(
        &self,
    ) -> impl Iterator<Item = (&str, &super::PendingEndpointCommand)> {
        self.endpoint_commands
            .iter()
            .map(|(id, command)| (id.as_str(), command))
    }

    pub fn agent(&self, agent_id: &platform::endpoint::NativeAgentId) -> Option<&AgentObservation> {
        self.agents.iter().find(|agent| agent.id() == agent_id)
    }

    pub fn runtime(&self, runtime_id: &super::RuntimeId) -> Option<&RuntimeObservation> {
        self.runtimes
            .iter()
            .find(|runtime| runtime.id() == runtime_id)
    }

    pub fn endpoint(
        &self,
        endpoint_id: &platform::endpoint::EndpointId,
    ) -> Option<&EndpointObservation> {
        self.endpoints
            .iter()
            .find(|endpoint| endpoint.id() == endpoint_id)
    }

    pub fn has_agent(&self, agent_id: &platform::endpoint::NativeAgentId) -> bool {
        self.agent(agent_id).is_some()
    }
}
