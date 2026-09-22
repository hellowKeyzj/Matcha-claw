use crate::{
    domain::connection::ConnectionId,
    domain::environment::{EnvironmentId, ManagedResourceId},
};

/// Durable ownership links reported by a Fleet topology producer.
///
/// The association is intentionally optional because discovery can report
/// externally managed topology. A reported link must resolve to the Fleet
/// connection, environment, or managed resource that owns the observation.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TopologyAssociation {
    connection_id: Option<ConnectionId>,
    environment_id: Option<EnvironmentId>,
    managed_resource_id: Option<ManagedResourceId>,
}

impl TopologyAssociation {
    pub const fn none() -> Self {
        Self {
            connection_id: None,
            environment_id: None,
            managed_resource_id: None,
        }
    }

    pub const fn new(
        connection_id: Option<ConnectionId>,
        environment_id: Option<EnvironmentId>,
        managed_resource_id: Option<ManagedResourceId>,
    ) -> Self {
        Self {
            connection_id,
            environment_id,
            managed_resource_id,
        }
    }

    pub const fn connection_id(&self) -> Option<&ConnectionId> {
        self.connection_id.as_ref()
    }

    pub const fn environment_id(&self) -> Option<&EnvironmentId> {
        self.environment_id.as_ref()
    }

    pub const fn managed_resource_id(&self) -> Option<&ManagedResourceId> {
        self.managed_resource_id.as_ref()
    }

    pub(crate) fn is_for_environment(
        &self,
        connection_id: &ConnectionId,
        environment_id: &EnvironmentId,
    ) -> bool {
        self.connection_id() == Some(connection_id) && self.environment_id() == Some(environment_id)
    }

    pub(crate) fn with_managed_resource_id(&self, managed_resource_id: &ManagedResourceId) -> Self {
        Self::new(
            self.connection_id.clone(),
            self.environment_id.clone(),
            Some(managed_resource_id.clone()),
        )
    }
}
