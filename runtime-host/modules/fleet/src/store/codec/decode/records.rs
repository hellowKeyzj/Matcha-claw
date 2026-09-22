use super::*;

impl Reader<'_> {
    pub(super) fn optional_runtime_agent_result(
        &mut self,
    ) -> Result<Option<crate::domain::runtime_agent::RuntimeAgentResult>, StoreFault> {
        use crate::domain::runtime_agent::{OperatorMessage, RuntimeAgentResult};
        match self.byte()? {
            0 => Ok(None),
            1 => Ok(Some(RuntimeAgentResult::Succeeded {
                completed_at: self.system_time()?,
            })),
            2 => Ok(Some(RuntimeAgentResult::Failed {
                completed_at: self.system_time()?,
                message: OperatorMessage::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
            })),
            3 => Ok(Some(RuntimeAgentResult::Cancelled {
                completed_at: self.system_time()?,
                message: self
                    .optional_string()?
                    .map(OperatorMessage::try_new)
                    .transpose()
                    .map_err(|_| StoreFault::CorruptRecord)?,
            })),
            4 => {
                let completed_at = self.system_time()?;
                let seconds = self.u64()?;
                let nanoseconds = self.u32()?;
                if nanoseconds >= 1_000_000_000 {
                    return Err(StoreFault::CorruptRecord);
                }
                Ok(Some(RuntimeAgentResult::TimedOut {
                    completed_at,
                    timeout: std::time::Duration::new(seconds, nanoseconds),
                }))
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn optional_u64(&mut self) -> Result<Option<u64>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => {
                let value = self.u64()?;
                if value == 0 {
                    return Err(StoreFault::CorruptRecord);
                }
                Ok(Some(value))
            }
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn dispatches(&mut self) -> Result<Vec<OutboxRecord>, StoreFault> {
        let count = self.count()?;
        (0..count).map(|_| self.outbox_record()).collect()
    }

    pub(super) fn dispatches_v5(&mut self) -> Result<Vec<OutboxRecord>, StoreFault> {
        let count = self.count()?;
        (0..count).map(|_| self.outbox_record_v5()).collect()
    }

    pub(super) fn outbox_record_v5(&mut self) -> Result<OutboxRecord, StoreFault> {
        let dispatch_id =
            DispatchId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let command_id =
            CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let agent_id =
            NativeAgentId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let phase = match self.byte()? {
            0 => DispatchPhase::Pending,
            1 => DispatchPhase::InFlight,
            2 => DispatchPhase::OutcomeUnknown,
            3 => DispatchPhase::Delivered,
            _ => return Err(StoreFault::CorruptRecord),
        };
        let attempt = match self.byte()? {
            0 => None,
            1 => {
                Some(DispatchAttempt::try_new(self.u64()?).map_err(|_| StoreFault::CorruptRecord)?)
            }
            _ => return Err(StoreFault::CorruptRecord),
        };
        // v5 had no target selector. It cannot be rebound to a mutable target,
        // so retain it only as an unbound legacy dispatch and never infer one.
        OutboxRecord::restore(
            DispatchIntent::new(dispatch_id, command_id, agent_id),
            phase,
            attempt,
        )
        .map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn outbox_record(&mut self) -> Result<OutboxRecord, StoreFault> {
        let dispatch_id =
            DispatchId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let command_id =
            CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let agent_id =
            NativeAgentId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let target = match self.byte()? {
            0 => None,
            1 => Some(FleetTargetSelector::new(
                TargetId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
                self.u64()?,
                target_kind_from_tag(self.byte()?)?,
            )),
            _ => return Err(StoreFault::CorruptRecord),
        };
        let phase = match self.byte()? {
            0 => DispatchPhase::Pending,
            1 => DispatchPhase::InFlight,
            2 => DispatchPhase::OutcomeUnknown,
            3 => DispatchPhase::Delivered,
            _ => return Err(StoreFault::CorruptRecord),
        };
        let attempt = match self.byte()? {
            0 => None,
            1 => {
                Some(DispatchAttempt::try_new(self.u64()?).map_err(|_| StoreFault::CorruptRecord)?)
            }
            _ => return Err(StoreFault::CorruptRecord),
        };
        let intent = match target {
            Some(target) => DispatchIntent::for_target(dispatch_id, command_id, agent_id, target),
            None => DispatchIntent::new(dispatch_id, command_id, agent_id),
        };
        OutboxRecord::restore(intent, phase, attempt).map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn runtime_agent_reachability(
        &mut self,
    ) -> Result<Vec<RuntimeAgentIngressReachabilityFacts>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let agent_id = NativeAgentId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let binding_id = RelayBindingId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let authority_id = RelayAuthorityId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let scheme = match self.byte()? {
                    0 => RelayScheme::Http,
                    1 => RelayScheme::Https,
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let origin = ExternalRelayOrigin::try_new(scheme, self.string()?, self.u16()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let kind = match self.byte()? {
                    0 => RelayKind::ReverseProxy,
                    1 => RelayKind::OutboundTunnel,
                    2 => RelayKind::ManagedRelay,
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let authority = RelayAuthority::try_new(authority_id, origin, kind);
                let listener = LoopbackIngressListener::try_new(self.u16()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let binding = RelayBinding::new(binding_id, authority, listener);
                let status = match self.byte()? {
                    0 => ReachabilityStatus::Pending {
                        observed_at: self.system_time()?,
                    },
                    1 => ReachabilityStatus::Reachable {
                        verified_at: self.system_time()?,
                    },
                    2 => ReachabilityStatus::Unreachable {
                        observed_at: self.system_time()?,
                    },
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let observed_at = self.system_time()?;
                let expires_at = self.system_time()?;
                RuntimeAgentIngressReachabilityFacts::try_new(
                    agent_id,
                    binding,
                    status,
                    observed_at,
                    expires_at,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }

    pub(super) fn leases(&mut self) -> Result<Vec<Lease<EndpointId>>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let id = crate::domain::lease::LeaseId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let endpoint =
                    EndpointId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
                let owner_kind = match self.byte()? {
                    0 => LeaseOwnerKind::ManualOperation,
                    1 => LeaseOwnerKind::RuntimeStart,
                    2 => LeaseOwnerKind::Session,
                    3 => LeaseOwnerKind::TeamRun,
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let owner = LeaseOwner::try_new(owner_kind, self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?;
                let acquired_at = self.system_time()?;
                let state = match self.byte()? {
                    0 => LeaseState::Active {
                        expires_at: self.system_time()?,
                    },
                    1 => LeaseState::Released {
                        released_at: self.system_time()?,
                    },
                    2 => LeaseState::Expired {
                        expired_at: self.system_time()?,
                    },
                    _ => return Err(StoreFault::CorruptRecord),
                };
                Lease::restore(id, endpoint, owner, acquired_at, state)
                    .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }

    pub(super) fn runtime_agents_v7(
        &mut self,
    ) -> Result<Vec<crate::domain::runtime_agent::RuntimeAgent>, StoreFault> {
        self.runtime_agents(true)
    }

    pub(super) fn runtime_agents(
        &mut self,
        with_commands: bool,
    ) -> Result<Vec<crate::domain::runtime_agent::RuntimeAgent>, StoreFault> {
        let mut agents = Vec::new();
        for _ in 0..self.count()? {
            let id =
                NativeAgentId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
            let heartbeat = match self.byte()? {
                0 => None,
                1 => {
                    let observed = self.system_time()?;
                    let status = runtime_agent_status(self.byte()?)?;
                    let runtime_ids = (0..self.count()?)
                        .map(|_| {
                            crate::domain::topology::RuntimeId::try_new(self.string()?)
                                .map_err(|_| StoreFault::CorruptRecord)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let message = self
                        .optional_string()?
                        .map(crate::domain::runtime_agent::OperatorMessage::try_new)
                        .transpose()
                        .map_err(|_| StoreFault::CorruptRecord)?;
                    Some(
                        crate::domain::runtime_agent::RuntimeAgentHeartbeat::try_new(
                            observed,
                            status,
                            runtime_ids,
                            message,
                        )
                        .map_err(|_| StoreFault::CorruptRecord)?,
                    )
                }
                _ => return Err(StoreFault::CorruptRecord),
            };
            let commands = if with_commands {
                (0..self.count()?)
                    .map(|_| self.runtime_agent_command())
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                if self.count()? != 0 {
                    return Err(StoreFault::CorruptRecord);
                }
                Vec::new()
            };
            agents.push(
                crate::domain::runtime_agent::RuntimeAgent::restore(id, heartbeat, commands)
                    .map_err(|_| StoreFault::CorruptRecord)?,
            );
        }
        Ok(agents)
    }

    pub(super) fn runtime_agent_command(
        &mut self,
    ) -> Result<crate::domain::runtime_agent::RuntimeAgentCommand, StoreFault> {
        let correlation = crate::domain::runtime_agent::CommandCorrelation::new(
            CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
            IdempotencyKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
        );
        let state = runtime_agent_progress_state(self.byte()?)?;
        let phase = self
            .optional_string()?
            .map(crate::domain::runtime_agent::ProgressPhase::try_new)
            .transpose()
            .map_err(|_| StoreFault::CorruptRecord)?;
        let message = self
            .optional_string()?
            .map(crate::domain::runtime_agent::OperatorMessage::try_new)
            .transpose()
            .map_err(|_| StoreFault::CorruptRecord)?;
        let percent = match self.byte()? {
            0 => None,
            1 => Some(self.byte()?),
            _ => return Err(StoreFault::CorruptRecord),
        };
        let result = self.optional_runtime_agent_result()?;
        let updated_at = self.system_time()?;
        let command_attempt = self.optional_u64()?;
        let dispatch_attempt = self.optional_u64()?;
        Ok(crate::domain::runtime_agent::RuntimeAgentCommand::restore(
            correlation,
            crate::domain::runtime_agent::RuntimeAgentProgress::new(state, phase, message, percent),
            result,
            updated_at,
            command_attempt.ok_or(StoreFault::CorruptRecord)?,
            dispatch_attempt.ok_or(StoreFault::CorruptRecord)?,
        ))
    }

    pub(super) fn effects(&mut self) -> Result<Vec<EffectRecord>, StoreFault> {
        (0..self.count()?)
            .map(|_| {
                let identity = EffectIdentity::restore(
                    CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
                    PhaseKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
                );
                let target = FleetTargetSelector::new(
                    TargetId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?,
                    self.u64()?,
                    target_kind_from_tag(self.byte()?)?,
                );
                let desired_revision = self.u64()?;
                if desired_revision == 0 {
                    return Err(StoreFault::CorruptRecord);
                }
                let provider = provider_effect_kind(self.byte()?)?;
                let deadline = self.system_time()?;
                let attempt = match self.byte()? {
                    0 => None,
                    1 => Some(
                        CommandAttempt::try_new(self.u64()?)
                            .map_err(|_| StoreFault::CorruptRecord)?,
                    ),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                let state = effect_state(self.byte()?)?;
                let outcome = match self.byte()? {
                    0 => None,
                    1 => Some(receipt_outcome(self.byte()?)?),
                    _ => return Err(StoreFault::CorruptRecord),
                };
                EffectRecord::restore(
                    identity,
                    target,
                    desired_revision,
                    provider,
                    deadline,
                    attempt,
                    state,
                    outcome,
                )
                .map_err(|_| StoreFault::CorruptRecord)
            })
            .collect()
    }
}
