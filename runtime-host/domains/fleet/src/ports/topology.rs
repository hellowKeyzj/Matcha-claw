use crate::topology::{
    EndpointObservation, NodeObservation, RuntimeObservation, TopologyError, TopologyOracle,
    WorkloadObservation,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetTopologySnapshot {
    nodes: Vec<NodeObservation>,
    workloads: Vec<WorkloadObservation>,
    runtimes: Vec<RuntimeObservation>,
    endpoints: Vec<EndpointObservation>,
}

impl FleetTopologySnapshot {
    pub fn try_new(
        nodes: Vec<NodeObservation>,
        workloads: Vec<WorkloadObservation>,
        runtimes: Vec<RuntimeObservation>,
        endpoints: Vec<EndpointObservation>,
    ) -> Result<Self, TopologyError> {
        TopologyOracle.validate(&nodes, &workloads, &runtimes, &endpoints)?;

        Ok(Self {
            nodes,
            workloads,
            runtimes,
            endpoints,
        })
    }

    pub fn nodes(&self) -> &[NodeObservation] {
        &self.nodes
    }

    pub fn workloads(&self) -> &[WorkloadObservation] {
        &self.workloads
    }

    pub fn runtimes(&self) -> &[RuntimeObservation] {
        &self.runtimes
    }

    pub fn endpoints(&self) -> &[EndpointObservation] {
        &self.endpoints
    }
}

pub trait FleetTopologyPort {
    type Error;

    fn observe(&mut self) -> Result<FleetTopologySnapshot, Self::Error>;
}
