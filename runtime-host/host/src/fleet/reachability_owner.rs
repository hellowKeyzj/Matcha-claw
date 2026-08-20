use std::time::SystemTime;

use fleet::{
    reachability::{
        LoopbackIngressListener, ReachabilityError, ReachabilityInputError, ReachabilityStatus,
        RelayAuthority, RelayBinding, RuntimeAgentIngressReachabilityFacts,
        RuntimeAgentReachabilityOracle,
    },
    runtime_agent::RuntimeAgentId,
};

/// The callback proof that an external relay authenticated a round trip to one
/// RuntimeAgent ingress binding.
///
/// Local listener state, a RuntimeAgent ingress request, and an endpoint URL do
/// not create this value. It must be created by the external relay verifier
/// after it has authenticated the callback round trip.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthenticatedCallbackRoundTrip {
    agent_id: RuntimeAgentId,
    authority_id: fleet::reachability::RelayAuthorityId,
    binding_id: fleet::reachability::RelayBindingId,
    verified_at: SystemTime,
}

impl AuthenticatedCallbackRoundTrip {
    /// Creates the typed proof at the external relay verifier boundary.
    ///
    /// This constructor is intentionally not used by the local Fleet ingress
    /// handler: local bearer authentication is not external relay evidence.
    pub(crate) fn from_verified(
        agent_id: RuntimeAgentId,
        authority_id: fleet::reachability::RelayAuthorityId,
        binding_id: fleet::reachability::RelayBindingId,
        verified_at: SystemTime,
    ) -> Self {
        Self {
            agent_id,
            authority_id,
            binding_id,
            verified_at,
        }
    }

    fn matches(&self, context: &RelayReachabilityContext) -> bool {
        self.agent_id == context.agent_id
            && self.authority_id == *context.authority.id()
            && self.binding_id == *context.binding.id()
    }

    fn verified_at(&self) -> SystemTime {
        self.verified_at
    }
}

/// Explicit authority, binding, local listener, and RuntimeAgent identity
/// supplied by the relay integration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RelayReachabilityContext {
    agent_id: RuntimeAgentId,
    authority: RelayAuthority,
    binding: RelayBinding,
    _listener: LoopbackIngressListener,
    observed_at: SystemTime,
    expires_at: SystemTime,
}

impl RelayReachabilityContext {
    pub(crate) fn try_new(
        agent_id: RuntimeAgentId,
        authority: RelayAuthority,
        binding: RelayBinding,
        listener: LoopbackIngressListener,
        observed_at: SystemTime,
        expires_at: SystemTime,
    ) -> Result<Self, ReachabilityProducerError> {
        if binding.authority() != &authority || binding.listener() != listener {
            return Err(ReachabilityProducerError::BindingMismatch);
        }
        if expires_at <= observed_at {
            return Err(ReachabilityProducerError::InvalidObservation(
                ReachabilityInputError::InvalidObservation,
            ));
        }
        Ok(Self {
            agent_id,
            authority,
            binding,
            _listener: listener,
            observed_at,
            expires_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RelayReachabilityEvidence {
    Pending(RelayReachabilityContext),
    Authenticated {
        context: RelayReachabilityContext,
        callback: AuthenticatedCallbackRoundTrip,
    },
    Unreachable(RelayReachabilityContext),
}

impl RelayReachabilityEvidence {
    pub(crate) fn pending(context: RelayReachabilityContext) -> Self {
        Self::Pending(context)
    }

    pub(crate) fn authenticated(
        context: RelayReachabilityContext,
        callback: AuthenticatedCallbackRoundTrip,
    ) -> Self {
        Self::Authenticated { context, callback }
    }

    pub(crate) fn unreachable(context: RelayReachabilityContext) -> Self {
        Self::Unreachable(context)
    }
}

/// The narrow durable write contract owned by the Fleet domain integration.
///
/// The concrete Host owner delegates this seam to FleetDeliveryOwner's durable
/// transaction; local ingress authentication alone never supplies callback proof.
pub(crate) trait DurableReachabilityMutation {
    type Error;

    fn upsert_runtime_agent_reachability(
        &mut self,
        facts: RuntimeAgentIngressReachabilityFacts,
        now: SystemTime,
    ) -> Result<(), Self::Error>;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct RuntimeAgentReachabilityProducer;

impl RuntimeAgentReachabilityProducer {
    pub(crate) fn produce(
        &self,
        evidence: RelayReachabilityEvidence,
        now: SystemTime,
    ) -> Result<RuntimeAgentIngressReachabilityFacts, ReachabilityProducerError> {
        let (context, status) = match evidence {
            RelayReachabilityEvidence::Pending(context) => (
                context.clone(),
                ReachabilityStatus::Pending {
                    observed_at: context.observed_at,
                },
            ),
            RelayReachabilityEvidence::Authenticated { context, callback } => {
                if !callback.matches(&context) {
                    return Err(ReachabilityProducerError::CallbackEvidenceMismatch);
                }
                if callback.verified_at() > context.observed_at {
                    return Err(ReachabilityProducerError::InvalidObservation(
                        ReachabilityInputError::InvalidObservation,
                    ));
                }
                (
                    context,
                    ReachabilityStatus::Reachable {
                        verified_at: callback.verified_at(),
                    },
                )
            }
            RelayReachabilityEvidence::Unreachable(context) => (
                context.clone(),
                ReachabilityStatus::Unreachable {
                    observed_at: context.observed_at,
                },
            ),
        };
        let facts = RuntimeAgentIngressReachabilityFacts::try_new(
            context.agent_id,
            context.binding,
            status,
            context.observed_at,
            context.expires_at,
        )
        .map_err(ReachabilityProducerError::InvalidObservation)?;
        RuntimeAgentReachabilityOracle::validate_observation(&facts, now)
            .map_err(ReachabilityProducerError::Observation)?;
        if matches!(facts.status(), ReachabilityStatus::Reachable { .. }) {
            RuntimeAgentReachabilityOracle::require_reachable(&facts, now)
                .map_err(ReachabilityProducerError::Observation)?;
        }
        Ok(facts)
    }

    pub(crate) fn publish<M>(
        &self,
        evidence: RelayReachabilityEvidence,
        now: SystemTime,
        mutation: &mut M,
    ) -> Result<RuntimeAgentIngressReachabilityFacts, PublishReachabilityError<M::Error>>
    where
        M: DurableReachabilityMutation,
    {
        let facts = self
            .produce(evidence, now)
            .map_err(PublishReachabilityError::Producer)?;
        mutation
            .upsert_runtime_agent_reachability(facts.clone(), now)
            .map_err(PublishReachabilityError::Mutation)?;
        Ok(facts)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReachabilityProducerError {
    BindingMismatch,
    CallbackEvidenceMismatch,
    InvalidObservation(ReachabilityInputError),
    Observation(ReachabilityError),
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum PublishReachabilityError<E> {
    Producer(ReachabilityProducerError),
    Mutation(E),
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet::reachability::RuntimeAgentReachabilityFactsSource;
    use std::time::Duration;

    struct MemoryMutation {
        store: fleet::reachability::RuntimeAgentReachabilityFactsStore,
    }

    impl DurableReachabilityMutation for MemoryMutation {
        type Error = ReachabilityError;

        fn upsert_runtime_agent_reachability(
            &mut self,
            facts: RuntimeAgentIngressReachabilityFacts,
            now: SystemTime,
        ) -> Result<(), Self::Error> {
            self.store.upsert(facts, now).map(|_| ())
        }
    }

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn context() -> RelayReachabilityContext {
        let authority = RelayAuthority::try_new(
            fleet::reachability::RelayAuthorityId::try_new("relay-1").unwrap(),
            fleet::reachability::ExternalRelayOrigin::try_new(
                fleet::reachability::RelayScheme::Https,
                "relay.example.test",
                443,
            )
            .unwrap(),
            fleet::reachability::RelayKind::ReverseProxy,
        );
        let listener = LoopbackIngressListener::try_new(34123).unwrap();
        let binding = RelayBinding::new(
            fleet::reachability::RelayBindingId::try_new("binding-1").unwrap(),
            authority.clone(),
            listener,
        );
        RelayReachabilityContext::try_new(
            RuntimeAgentId::try_new("agent-1").unwrap(),
            authority,
            binding,
            listener,
            at(12),
            at(20),
        )
        .unwrap()
    }

    fn callback(
        context: &RelayReachabilityContext,
        verified_at: u64,
    ) -> AuthenticatedCallbackRoundTrip {
        AuthenticatedCallbackRoundTrip::from_verified(
            context.agent_id.clone(),
            context.authority.id().clone(),
            context.binding.id().clone(),
            at(verified_at),
        )
    }

    #[test]
    fn no_callback_evidence_can_only_produce_pending_or_unreachable() {
        let producer = RuntimeAgentReachabilityProducer;
        let pending = producer
            .produce(RelayReachabilityEvidence::pending(context()), at(12))
            .unwrap();
        assert_eq!(
            pending.status(),
            ReachabilityStatus::Pending {
                observed_at: at(12)
            }
        );

        let unreachable = producer
            .produce(RelayReachabilityEvidence::unreachable(context()), at(12))
            .unwrap();
        assert_eq!(
            unreachable.status(),
            ReachabilityStatus::Unreachable {
                observed_at: at(12)
            }
        );
    }

    #[test]
    fn authenticated_callback_round_trip_is_required_for_reachable() {
        let producer = RuntimeAgentReachabilityProducer;
        let context = context();
        let facts = producer
            .produce(
                RelayReachabilityEvidence::authenticated(context.clone(), callback(&context, 11)),
                at(12),
            )
            .unwrap();
        assert_eq!(
            facts.status(),
            ReachabilityStatus::Reachable {
                verified_at: at(11)
            }
        );
    }

    #[test]
    fn callback_identity_and_binding_are_fenced() {
        let producer = RuntimeAgentReachabilityProducer;
        let context = context();
        let callback = AuthenticatedCallbackRoundTrip::from_verified(
            RuntimeAgentId::try_new("other-agent").unwrap(),
            context.authority.id().clone(),
            context.binding.id().clone(),
            at(11),
        );
        assert_eq!(
            producer.produce(
                RelayReachabilityEvidence::authenticated(context, callback),
                at(12),
            ),
            Err(ReachabilityProducerError::CallbackEvidenceMismatch)
        );
    }

    #[test]
    fn expired_callback_evidence_cannot_produce_reachable() {
        let producer = RuntimeAgentReachabilityProducer;
        let context = context();
        assert_eq!(
            producer.produce(
                RelayReachabilityEvidence::authenticated(context.clone(), callback(&context, 11)),
                at(20),
            ),
            Err(ReachabilityProducerError::Observation(
                ReachabilityError::Expired
            ))
        );
    }

    #[test]
    fn publish_uses_the_durable_mutation_seam() {
        let producer = RuntimeAgentReachabilityProducer;
        let context = context();
        let mut mutation = MemoryMutation {
            store: fleet::reachability::RuntimeAgentReachabilityFactsStore::default(),
        };
        let facts = producer
            .publish(
                RelayReachabilityEvidence::authenticated(context.clone(), callback(&context, 11)),
                at(12),
                &mut mutation,
            )
            .unwrap();
        assert_eq!(
            mutation
                .store
                .runtime_agent_reachability(facts.agent_id())
                .unwrap(),
            &facts
        );
    }

    #[test]
    fn local_listener_without_remote_authority_is_rejected() {
        assert_eq!(
            fleet::reachability::ExternalRelayOrigin::try_new(
                fleet::reachability::RelayScheme::Https,
                "127.0.0.1",
                443,
            ),
            Err(ReachabilityInputError::InvalidRemoteOrigin)
        );
    }
}
