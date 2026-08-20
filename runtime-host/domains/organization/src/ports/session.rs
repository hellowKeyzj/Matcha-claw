use crate::{GraphRunId, RoleId, TeamId};

use super::{
    ExternalSessionReference, ManagedAgentReference, RuntimeEndpointReference,
    SessionWindowReference,
};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LocalSessionReference(String);

impl LocalSessionReference {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidLocalSessionReference> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidLocalSessionReference);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidLocalSessionReference;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleSessionReceipt {
    team: TeamId,
    team_run: GraphRunId,
    role: RoleId,
    local_session: LocalSessionReference,
    external_session: ExternalSessionReference,
    agent: ManagedAgentReference,
    endpoint: RuntimeEndpointReference,
}

impl RoleSessionReceipt {
    pub fn new(
        team: TeamId,
        team_run: GraphRunId,
        role: RoleId,
        local_session: LocalSessionReference,
        external_session: ExternalSessionReference,
        agent: ManagedAgentReference,
        endpoint: RuntimeEndpointReference,
    ) -> Self {
        Self {
            team,
            team_run,
            role,
            local_session,
            external_session,
            agent,
            endpoint,
        }
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub fn team_run(&self) -> &GraphRunId {
        &self.team_run
    }

    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn local_session(&self) -> &LocalSessionReference {
        &self.local_session
    }

    pub fn external_session(&self) -> &ExternalSessionReference {
        &self.external_session
    }

    pub fn agent(&self) -> &ManagedAgentReference {
        &self.agent
    }

    pub fn endpoint(&self) -> &RuntimeEndpointReference {
        &self.endpoint
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleSessionWindow {
    Available {
        session: ExternalSessionReference,
        window: SessionWindowReference,
    },
    PendingHydration {
        session: ExternalSessionReference,
    },
    Unavailable {
        session: ExternalSessionReference,
    },
}

pub trait RoleSessionPort {
    type Error;

    fn abort(&mut self, receipt: &RoleSessionReceipt) -> Result<(), Self::Error>;

    fn delete(&mut self, receipt: &RoleSessionReceipt) -> Result<(), Self::Error>;

    fn read_window(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Result<RoleSessionWindow, Self::Error>;
}
