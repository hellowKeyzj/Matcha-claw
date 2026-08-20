use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::{
    AgentObservation, EndpointObservation, NodeObservation, RuntimeObservation, WorkloadObservation,
};

#[derive(Clone, Copy, Debug, Default)]
pub struct TopologyOracle;

impl TopologyOracle {
    pub fn validate(
        &self,
        nodes: &[NodeObservation],
        workloads: &[WorkloadObservation],
        runtimes: &[RuntimeObservation],
        endpoints: &[EndpointObservation],
    ) -> Result<(), TopologyError> {
        self.validate_core(nodes, &[], workloads, runtimes, endpoints, false)
    }

    pub fn validate_with_agents(
        &self,
        nodes: &[NodeObservation],
        agents: &[AgentObservation],
        workloads: &[WorkloadObservation],
        runtimes: &[RuntimeObservation],
        endpoints: &[EndpointObservation],
    ) -> Result<(), TopologyError> {
        self.validate_core(nodes, agents, workloads, runtimes, endpoints, true)
    }

    fn validate_core(
        &self,
        nodes: &[NodeObservation],
        agents: &[AgentObservation],
        workloads: &[WorkloadObservation],
        runtimes: &[RuntimeObservation],
        endpoints: &[EndpointObservation],
        validate_runtime_agents: bool,
    ) -> Result<(), TopologyError> {
        let mut node_ids = BTreeSet::new();
        for node in nodes {
            if !node_ids.insert(node.id()) {
                return Err(TopologyError::DuplicateNode);
            }
        }

        let mut agent_ids = HashSet::new();
        let mut agent_nodes = HashMap::new();
        for agent in agents {
            if !agent_ids.insert(agent.id()) {
                return Err(TopologyError::DuplicateAgent);
            }
            if !node_ids.contains(agent.node_id()) {
                return Err(TopologyError::UnknownAgentNode);
            }
            agent_nodes.insert(agent.id(), agent.node_id());
        }

        let mut workload_ids = BTreeSet::new();
        for workload in workloads {
            if !workload_ids.insert(workload.id()) {
                return Err(TopologyError::DuplicateWorkload);
            }
            if let Some(node_id) = workload.node_id()
                && !node_ids.contains(node_id)
            {
                return Err(TopologyError::UnknownWorkloadNode);
            }
        }

        let mut runtime_ids = BTreeSet::new();
        let mut runtime_nodes = BTreeMap::new();
        for runtime in runtimes {
            if !runtime_ids.insert(runtime.id()) {
                return Err(TopologyError::DuplicateRuntime);
            }
            if !node_ids.contains(runtime.node_id()) {
                return Err(TopologyError::UnknownRuntimeNode);
            }
            if validate_runtime_agents && let Some(agent_id) = runtime.agent_id() {
                let Some(agent_node_id) = agent_nodes.get(agent_id) else {
                    return Err(TopologyError::UnknownRuntimeAgent);
                };
                if *agent_node_id != runtime.node_id() {
                    return Err(TopologyError::MismatchedRuntimeAgentNode);
                }
            }
            runtime_nodes.insert(runtime.id(), runtime.node_id());
        }

        let mut endpoint_ids = HashSet::new();
        for endpoint in endpoints {
            if !endpoint_ids.insert(endpoint.id()) {
                return Err(TopologyError::DuplicateEndpoint);
            }
            let Some(runtime_node_id) = runtime_nodes.get(endpoint.runtime_id()) else {
                return Err(TopologyError::UnknownEndpointRuntime);
            };
            if endpoint.node_id() != *runtime_node_id {
                return Err(TopologyError::MismatchedEndpointNode);
            }
        }

        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TopologyError {
    DuplicateNode,
    DuplicateAgent,
    DuplicateWorkload,
    DuplicateRuntime,
    DuplicateEndpoint,
    UnknownAgentNode,
    UnknownRuntimeNode,
    UnknownRuntimeAgent,
    MismatchedRuntimeAgentNode,
    UnknownWorkloadNode,
    UnknownEndpointRuntime,
    MismatchedEndpointNode,
    UnknownRetiredNode,
    UnknownLifecycleAgent,
    UnknownLifecycleRuntime,
    UnknownLifecycleEndpoint,
    BackdatedLifecycle,
    DuplicateLifecycleIdentity,
}
