use crate::{GraphRunId, RoleId, TeamId};

use super::{
    EndpointSessionId, ManagedAgentReference, RuntimeEndpointReference, SessionWindowReference,
};

pub const ROLE_SESSION_REF_INITIAL: &str = "rs0";

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RoleSessionRef(String);

impl RoleSessionRef {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidRoleSessionRef> {
        let value = value.into();
        if !valid_session_ref(&value) {
            return Err(InvalidRoleSessionRef);
        }
        Ok(Self(value))
    }

    pub fn initial() -> Self {
        Self(ROLE_SESSION_REF_INITIAL.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidRoleSessionRef;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RoleSessionSlot {
    role_id: RoleId,
    session_ref: RoleSessionRef,
}

impl RoleSessionSlot {
    pub fn new(role_id: RoleId, session_ref: RoleSessionRef) -> Self {
        Self {
            role_id,
            session_ref,
        }
    }

    pub fn role_id(&self) -> &RoleId {
        &self.role_id
    }

    pub fn session_ref(&self) -> &RoleSessionRef {
        &self.session_ref
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleSessionReceipt {
    team: TeamId,
    team_run: GraphRunId,
    slot: RoleSessionSlot,
    endpoint_session_id: EndpointSessionId,
    agent: ManagedAgentReference,
    endpoint: RuntimeEndpointReference,
}

impl RoleSessionReceipt {
    pub fn new(
        team: TeamId,
        team_run: GraphRunId,
        role: RoleId,
        session_ref: RoleSessionRef,
        agent: ManagedAgentReference,
        endpoint: RuntimeEndpointReference,
    ) -> Self {
        let endpoint_session_id = derived_endpoint_session_id(&team_run, &role, &session_ref);
        Self::with_endpoint_session_id(
            team,
            team_run,
            role,
            session_ref,
            endpoint_session_id,
            agent,
            endpoint,
        )
    }

    pub fn with_endpoint_session_id(
        team: TeamId,
        team_run: GraphRunId,
        role: RoleId,
        session_ref: RoleSessionRef,
        endpoint_session_id: EndpointSessionId,
        agent: ManagedAgentReference,
        endpoint: RuntimeEndpointReference,
    ) -> Self {
        Self {
            team,
            team_run,
            slot: RoleSessionSlot::new(role, session_ref),
            endpoint_session_id,
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

    pub fn slot(&self) -> &RoleSessionSlot {
        &self.slot
    }

    pub fn role(&self) -> &RoleId {
        self.slot.role_id()
    }

    pub fn session_ref(&self) -> &RoleSessionRef {
        self.slot.session_ref()
    }

    pub fn endpoint_session_id(&self) -> &EndpointSessionId {
        &self.endpoint_session_id
    }

    pub fn agent(&self) -> &ManagedAgentReference {
        &self.agent
    }

    pub fn endpoint(&self) -> &RuntimeEndpointReference {
        &self.endpoint
    }
}

pub trait RoleSessionIdentityResolver: Send + Sync {
    fn session_key(&self, session: &RoleSessionReceipt) -> Option<String>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleSessionWindow {
    Available {
        session: EndpointSessionId,
        window: SessionWindowReference,
    },
    PendingHydration {
        session: EndpointSessionId,
    },
    Unavailable {
        session: EndpointSessionId,
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

fn derived_endpoint_session_id(
    run_id: &GraphRunId,
    role_id: &RoleId,
    session_ref: &RoleSessionRef,
) -> EndpointSessionId {
    EndpointSessionId::try_new(format!(
        "tr-{}-{}-{}",
        run_short(run_id.as_str()),
        role_id.as_str(),
        session_ref.as_str()
    ))
    .expect("derived endpoint session identity must be non-empty")
}

fn run_short(run_id: &str) -> &str {
    run_id
        .rsplit(|byte| matches!(byte, ':' | '/' | '#'))
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(run_id)
}

fn valid_session_ref(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("rs") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}
