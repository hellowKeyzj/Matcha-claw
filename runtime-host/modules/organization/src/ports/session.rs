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
    pub(crate) fn for_runtime(
        team: TeamId,
        run: GraphRunId,
        role: RoleId,
        session_ref: RoleSessionRef,
        agent: ManagedAgentReference,
        endpoint: RuntimeEndpointReference,
    ) -> Self {
        let mut binding = Self::new(team, run, role, session_ref, agent, endpoint);
        if binding.endpoint().as_str()
            == runtime_directory::RuntimeDriverIdentity::matcha_agent().runtime_endpoint_reference()
        {
            use sha2::{Digest, Sha256};
            let mut digest = Sha256::new();
            digest.update(b"matcha-team-role-session-v1");
            for part in [
                binding.endpoint().as_str(), binding.team_run().as_str(),
                binding.role().as_str(), binding.session_ref().as_str(),
            ] {
                digest.update((part.len() as u64).to_be_bytes());
                digest.update(part.as_bytes());
            }
            let hash = digest.finalize();
            let mut bytes: [u8; 16] = hash[..16].try_into().expect("SHA-256 contains 16 bytes");
            bytes[6] = (bytes[6] & 0x0f) | 0x80;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            binding.endpoint_session_id = EndpointSessionId::try_new(format!(
                "{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..],
            )).expect("derived UUID is a valid endpoint session identity");
        }
        binding
    }

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

    fn ownership_receipt_key(
        &self,
        session: &RoleSessionReceipt,
    ) -> Option<(
        platform::endpoint::runtime_address::RuntimeEndpoint,
        Option<String>,
        String,
    )>;

    fn ownership_query_key(
        &self,
        identity: &platform::endpoint::runtime_address::SessionIdentity,
        endpoint_session_id: &str,
    ) -> (
        platform::endpoint::runtime_address::RuntimeEndpoint,
        Option<String>,
        String,
    );
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
