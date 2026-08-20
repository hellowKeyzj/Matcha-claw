use std::{fmt, net::IpAddr, time::SystemTime};

use crate::runtime_agent::RuntimeAgentId;

pub const RUNTIME_AGENT_INGRESS_PATH: &str = "/api/remote-fleet/runtime-agent/ingress";

const MAX_ID_LENGTH: usize = 128;

macro_rules! reachability_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, ReachabilityInputError> {
                let value = value.into();
                if value.trim().is_empty() || value.len() > MAX_ID_LENGTH || value.contains('\0') {
                    return Err(ReachabilityInputError::InvalidIdentity);
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

reachability_id!(RelayAuthorityId);
reachability_id!(RelayBindingId);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RelayScheme {
    Http,
    Https,
}

impl RelayScheme {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
        }
    }
}

/// An origin owned by a remote relay authority.
///
/// The origin is an address projection only. Remote reachability is established
/// by [`RuntimeAgentIngressReachabilityFacts::status`], not by parsing this value
/// or by inspecting a local listener.
#[derive(Clone, Eq, PartialEq)]
pub struct ExternalRelayOrigin {
    scheme: RelayScheme,
    host: String,
    port: u16,
}

impl ExternalRelayOrigin {
    pub fn try_new(
        scheme: RelayScheme,
        host: impl Into<String>,
        port: u16,
    ) -> Result<Self, ReachabilityInputError> {
        let host = host.into();
        let host = host.trim();
        if host.is_empty()
            || host.len() > MAX_ID_LENGTH
            || host.contains('\0')
            || host.contains('/')
            || host.contains('\\')
            || host.eq_ignore_ascii_case("localhost")
            || port == 0
        {
            return Err(ReachabilityInputError::InvalidRemoteOrigin);
        }
        if host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback() || address.is_unspecified())
            .unwrap_or(false)
        {
            return Err(ReachabilityInputError::InvalidRemoteOrigin);
        }
        Ok(Self {
            scheme,
            host: host.to_owned(),
            port,
        })
    }

    pub const fn scheme(&self) -> RelayScheme {
        self.scheme
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    pub fn origin(&self) -> String {
        format!("{}://{}:{}", self.scheme.as_str(), self.host, self.port)
    }
}

impl fmt::Debug for ExternalRelayOrigin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalRelayOrigin")
            .field("scheme", &self.scheme)
            .field("host", &self.host)
            .field("port", &self.port)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RelayKind {
    ReverseProxy,
    OutboundTunnel,
    ManagedRelay,
}

/// Network authority that owns the remote callback origin.
///
/// A RuntimeAgent endpoint URL or a loopback listener is not an authority. The
/// relay authority must be supplied by the reachability facts source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayAuthority {
    id: RelayAuthorityId,
    origin: ExternalRelayOrigin,
    kind: RelayKind,
}

impl RelayAuthority {
    pub fn try_new(id: RelayAuthorityId, origin: ExternalRelayOrigin, kind: RelayKind) -> Self {
        Self { id, origin, kind }
    }

    pub const fn id(&self) -> &RelayAuthorityId {
        &self.id
    }

    pub const fn origin(&self) -> &ExternalRelayOrigin {
        &self.origin
    }

    pub const fn kind(&self) -> RelayKind {
        self.kind
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoopbackIngressListener {
    port: u16,
}

impl LoopbackIngressListener {
    pub fn try_new(port: u16) -> Result<Self, ReachabilityInputError> {
        if port == 0 {
            return Err(ReachabilityInputError::InvalidListener);
        }
        Ok(Self { port })
    }

    pub const fn port(self) -> u16 {
        self.port
    }
}

/// A relay-owned binding from the remote origin to the local callback listener.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayBinding {
    id: RelayBindingId,
    authority: RelayAuthority,
    listener: LoopbackIngressListener,
}

impl RelayBinding {
    pub fn new(
        id: RelayBindingId,
        authority: RelayAuthority,
        listener: LoopbackIngressListener,
    ) -> Self {
        Self {
            id,
            authority,
            listener,
        }
    }

    pub const fn id(&self) -> &RelayBindingId {
        &self.id
    }

    pub const fn authority(&self) -> &RelayAuthority {
        &self.authority
    }

    pub const fn listener(&self) -> LoopbackIngressListener {
        self.listener
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReachabilityStatus {
    Pending { observed_at: SystemTime },
    Reachable { verified_at: SystemTime },
    Unreachable { observed_at: SystemTime },
}

impl ReachabilityStatus {
    const fn observed_at(self) -> SystemTime {
        match self {
            Self::Pending { observed_at }
            | Self::Unreachable { observed_at }
            | Self::Reachable {
                verified_at: observed_at,
            } => observed_at,
        }
    }

    const fn is_reachable(self) -> bool {
        matches!(self, Self::Reachable { .. })
    }
}

/// Authoritative relay/tunnel facts for one RuntimeAgent callback path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentIngressReachabilityFacts {
    agent_id: RuntimeAgentId,
    binding: RelayBinding,
    status: ReachabilityStatus,
    observed_at: SystemTime,
    expires_at: SystemTime,
}

impl RuntimeAgentIngressReachabilityFacts {
    pub fn try_new(
        agent_id: RuntimeAgentId,
        binding: RelayBinding,
        status: ReachabilityStatus,
        observed_at: SystemTime,
        expires_at: SystemTime,
    ) -> Result<Self, ReachabilityInputError> {
        if expires_at <= observed_at || status.observed_at() > observed_at {
            return Err(ReachabilityInputError::InvalidObservation);
        }
        Ok(Self {
            agent_id,
            binding,
            status,
            observed_at,
            expires_at,
        })
    }

    pub const fn agent_id(&self) -> &RuntimeAgentId {
        &self.agent_id
    }

    pub const fn binding(&self) -> &RelayBinding {
        &self.binding
    }

    pub const fn status(&self) -> ReachabilityStatus {
        self.status
    }

    pub const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }

    pub const fn expires_at(&self) -> SystemTime {
        self.expires_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentCallbackEndpoint {
    agent_id: RuntimeAgentId,
    binding_id: RelayBindingId,
    authority_id: RelayAuthorityId,
    origin: ExternalRelayOrigin,
    expires_at: SystemTime,
}

impl RuntimeAgentCallbackEndpoint {
    fn from_facts(facts: &RuntimeAgentIngressReachabilityFacts) -> Self {
        Self {
            agent_id: facts.agent_id().clone(),
            binding_id: facts.binding().id().clone(),
            authority_id: facts.binding().authority().id().clone(),
            origin: facts.binding().authority().origin().clone(),
            expires_at: facts.expires_at(),
        }
    }

    pub const fn agent_id(&self) -> &RuntimeAgentId {
        &self.agent_id
    }

    pub const fn binding_id(&self) -> &RelayBindingId {
        &self.binding_id
    }

    pub const fn authority_id(&self) -> &RelayAuthorityId {
        &self.authority_id
    }

    pub const fn origin(&self) -> &ExternalRelayOrigin {
        &self.origin
    }

    pub const fn path(&self) -> &'static str {
        RUNTIME_AGENT_INGRESS_PATH
    }

    pub fn url(&self) -> String {
        format!("{}{}", self.origin.origin(), self.path())
    }
}

pub trait RuntimeAgentReachabilityFactsSource {
    fn runtime_agent_reachability(
        &self,
        agent_id: &RuntimeAgentId,
    ) -> Option<&RuntimeAgentIngressReachabilityFacts>;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RuntimeAgentReachabilityAdapter;

impl RuntimeAgentReachabilityAdapter {
    pub fn resolve<S>(
        &self,
        source: &S,
        agent_id: &RuntimeAgentId,
        now: SystemTime,
    ) -> Result<RuntimeAgentCallbackEndpoint, ReachabilityError>
    where
        S: RuntimeAgentReachabilityFactsSource + ?Sized,
    {
        let facts = source
            .runtime_agent_reachability(agent_id)
            .ok_or(ReachabilityError::FactsUnavailable)?;
        RuntimeAgentReachabilityOracle::require_reachable(facts, now)?;
        Ok(RuntimeAgentCallbackEndpoint::from_facts(facts))
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RuntimeAgentReachabilityOracle;

impl RuntimeAgentReachabilityOracle {
    pub fn validate_observation(
        facts: &RuntimeAgentIngressReachabilityFacts,
        now: SystemTime,
    ) -> Result<(), ReachabilityError> {
        if facts.observed_at() > now {
            return Err(ReachabilityError::ObservationInFuture);
        }
        if facts.expires_at() <= facts.observed_at() {
            return Err(ReachabilityError::InvalidLease);
        }
        if facts.status().observed_at() > facts.observed_at() {
            return Err(ReachabilityError::EvidenceInFuture);
        }
        Ok(())
    }

    pub fn require_reachable(
        facts: &RuntimeAgentIngressReachabilityFacts,
        now: SystemTime,
    ) -> Result<(), ReachabilityError> {
        Self::validate_observation(facts, now)?;
        if facts.expires_at() <= now {
            return Err(ReachabilityError::Expired);
        }
        if !facts.status().is_reachable() {
            return Err(ReachabilityError::NotReachable);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReachabilityMutation {
    Inserted,
    Replaced,
    Unchanged,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuntimeAgentReachabilityFactsStore {
    facts: std::collections::BTreeMap<String, RuntimeAgentIngressReachabilityFacts>,
}

impl RuntimeAgentReachabilityFactsStore {
    pub fn upsert(
        &mut self,
        facts: RuntimeAgentIngressReachabilityFacts,
        now: SystemTime,
    ) -> Result<ReachabilityMutation, ReachabilityError> {
        RuntimeAgentReachabilityOracle::validate_observation(&facts, now)?;
        let key = facts.agent_id().as_str().to_owned();
        if let Some(current) = self.facts.get(&key) {
            if current.observed_at() > facts.observed_at() {
                return Err(ReachabilityError::StaleObservation);
            }
            if current == &facts {
                return Ok(ReachabilityMutation::Unchanged);
            }
        }
        let mutation = if self.facts.insert(key, facts).is_some() {
            ReachabilityMutation::Replaced
        } else {
            ReachabilityMutation::Inserted
        };
        Ok(mutation)
    }

    pub fn records(&self) -> impl Iterator<Item = &RuntimeAgentIngressReachabilityFacts> {
        self.facts.values()
    }
}

impl RuntimeAgentReachabilityFactsSource for RuntimeAgentReachabilityFactsStore {
    fn runtime_agent_reachability(
        &self,
        agent_id: &RuntimeAgentId,
    ) -> Option<&RuntimeAgentIngressReachabilityFacts> {
        self.facts.get(agent_id.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReachabilityInputError {
    InvalidIdentity,
    InvalidRemoteOrigin,
    InvalidListener,
    InvalidObservation,
}

impl fmt::Display for ReachabilityInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidIdentity => "reachability identity is invalid",
            Self::InvalidRemoteOrigin => "relay origin must be a non-loopback remote authority",
            Self::InvalidListener => "loopback ingress listener port is invalid",
            Self::InvalidObservation => "reachability observation timestamps are invalid",
        })
    }
}

impl std::error::Error for ReachabilityInputError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReachabilityError {
    FactsUnavailable,
    ObservationInFuture,
    EvidenceInFuture,
    InvalidLease,
    Expired,
    NotReachable,
    StaleObservation,
}

impl fmt::Display for ReachabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::FactsUnavailable => "runtime agent reachability facts are unavailable",
            Self::ObservationInFuture => {
                "runtime agent reachability observation is from the future"
            }
            Self::EvidenceInFuture => "runtime agent reachability evidence is from the future",
            Self::InvalidLease => "runtime agent reachability lease is invalid",
            Self::Expired => "runtime agent reachability lease has expired",
            Self::NotReachable => "runtime agent callback route is not reachable",
            Self::StaleObservation => "runtime agent reachability observation is stale",
        })
    }
}

impl std::error::Error for ReachabilityError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn facts(status: ReachabilityStatus) -> RuntimeAgentIngressReachabilityFacts {
        facts_at(status, at(12))
    }

    fn facts_at(
        status: ReachabilityStatus,
        observed_at: SystemTime,
    ) -> RuntimeAgentIngressReachabilityFacts {
        let agent_id = RuntimeAgentId::try_new("agent-1").unwrap();
        let authority_id = RelayAuthorityId::try_new("relay-authority-1").unwrap();
        let origin =
            ExternalRelayOrigin::try_new(RelayScheme::Https, "relay.example.test", 443).unwrap();
        let authority = RelayAuthority::try_new(authority_id, origin, RelayKind::ReverseProxy);
        let binding_id = RelayBindingId::try_new("binding-1").unwrap();
        let listener = LoopbackIngressListener::try_new(34123).unwrap();
        RuntimeAgentIngressReachabilityFacts::try_new(
            agent_id,
            RelayBinding::new(binding_id, authority, listener),
            status,
            observed_at,
            observed_at + Duration::from_secs(10),
        )
        .unwrap()
    }

    #[test]
    fn loopback_listener_is_only_the_relay_destination() {
        let facts = facts(ReachabilityStatus::Reachable {
            verified_at: at(11),
        });
        let mut store = RuntimeAgentReachabilityFactsStore::default();
        store.upsert(facts, at(12)).unwrap();

        let endpoint = RuntimeAgentReachabilityAdapter
            .resolve(&store, &RuntimeAgentId::try_new("agent-1").unwrap(), at(12))
            .unwrap();
        assert_eq!(endpoint.path(), RUNTIME_AGENT_INGRESS_PATH);
        assert_eq!(
            endpoint.url(),
            "https://relay.example.test:443/api/remote-fleet/runtime-agent/ingress"
        );
        assert_eq!(endpoint.origin().host(), "relay.example.test");
        assert_eq!(
            store
                .runtime_agent_reachability(&RuntimeAgentId::try_new("agent-1").unwrap())
                .unwrap()
                .binding()
                .listener()
                .port(),
            34123
        );
    }

    #[test]
    fn adapter_requires_authoritative_reachable_facts_and_lease() {
        let mut store = RuntimeAgentReachabilityFactsStore::default();
        store
            .upsert(
                facts(ReachabilityStatus::Pending {
                    observed_at: at(10),
                }),
                at(12),
            )
            .unwrap();
        assert_eq!(
            RuntimeAgentReachabilityAdapter.resolve(
                &store,
                &RuntimeAgentId::try_new("agent-1").unwrap(),
                at(12),
            ),
            Err(ReachabilityError::NotReachable)
        );

        store
            .upsert(
                facts(ReachabilityStatus::Reachable {
                    verified_at: at(11),
                }),
                at(12),
            )
            .unwrap();
        assert_eq!(
            RuntimeAgentReachabilityAdapter.resolve(
                &store,
                &RuntimeAgentId::try_new("agent-1").unwrap(),
                at(23),
            ),
            Err(ReachabilityError::Expired)
        );
    }

    #[test]
    fn facts_source_rejects_stale_observations() {
        let mut store = RuntimeAgentReachabilityFactsStore::default();
        store
            .upsert(
                facts(ReachabilityStatus::Reachable {
                    verified_at: at(11),
                }),
                at(12),
            )
            .unwrap();
        let stale = facts_at(
            ReachabilityStatus::Unreachable { observed_at: at(9) },
            at(9),
        );
        assert_eq!(
            store.upsert(stale, at(12)),
            Err(ReachabilityError::StaleObservation)
        );
    }

    #[test]
    fn remote_origin_rejects_loopback_authorities_without_claiming_reachability() {
        assert_eq!(
            ExternalRelayOrigin::try_new(RelayScheme::Https, "127.0.0.1", 443),
            Err(ReachabilityInputError::InvalidRemoteOrigin)
        );
        assert_eq!(
            ExternalRelayOrigin::try_new(RelayScheme::Https, "localhost", 443),
            Err(ReachabilityInputError::InvalidRemoteOrigin)
        );
        assert_eq!(
            ExternalRelayOrigin::try_new(RelayScheme::Https, "relay.example.test", 0),
            Err(ReachabilityInputError::InvalidRemoteOrigin)
        );
    }

    #[test]
    fn observation_and_evidence_must_be_monotonic() {
        let agent_id = RuntimeAgentId::try_new("agent-1").unwrap();
        let authority = RelayAuthority::try_new(
            RelayAuthorityId::try_new("relay-authority-1").unwrap(),
            ExternalRelayOrigin::try_new(RelayScheme::Https, "relay.example.test", 443).unwrap(),
            RelayKind::OutboundTunnel,
        );
        let binding = RelayBinding::new(
            RelayBindingId::try_new("binding-1").unwrap(),
            authority,
            LoopbackIngressListener::try_new(34123).unwrap(),
        );
        assert_eq!(
            RuntimeAgentIngressReachabilityFacts::try_new(
                agent_id,
                binding,
                ReachabilityStatus::Reachable {
                    verified_at: at(12)
                },
                at(10),
                at(20),
            ),
            Err(ReachabilityInputError::InvalidObservation)
        );
    }
}
