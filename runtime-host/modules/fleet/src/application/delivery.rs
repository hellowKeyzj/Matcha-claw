use std::{fmt, path::PathBuf, time::SystemTime};

use crate::{
    domain::audit::{FleetAuditEntry, FleetAuditEvent, FleetAuditEventInput},
    domain::command::{
        CommandAttempt, CommandCancellation, CommandFailure, CommandId, CommandIntent,
        CommandState, SubmitOutcome, TransitionOutcome,
    },
    domain::connection::{
        ConnectionId, ConnectionMutation, ConnectionMutationError, ConnectionRecord,
        ConnectionState, ProbeOutcome,
    },
    domain::effect::{
        EffectIdentity, EffectLedger, EffectOperationOutcome, EffectReceipt, EffectRecord,
        EffectTransitionError, PhaseKey,
    },
    domain::environment::{
        EnvironmentId, EnvironmentMutation, EnvironmentMutationError, EnvironmentRecord,
        EnvironmentState, ManagedResourceId, ManagedResourceLifecycleContext,
        ManagedResourceMetadata, ManagedResourceMutation, ManagedResourceRecord,
        ManagedResourceState,
    },
    domain::outbox::{
        AcknowledgeDeliveryOutcome, BeginDeliveryOutcome, DispatchAttempt, DispatchId,
        DispatchIntent, DispatchPhase, InsertOutcome, ReplayOutcome,
    },
    domain::ports::{FleetDispatchReadbackError, FleetDispatchRequest, FleetDispatchTarget},
    domain::reachability::{
        ReachabilityError, RuntimeAgentIngressReachabilityFacts, RuntimeAgentReachabilityFactsStore,
    },
    domain::runtime_agent::{
        CommandCorrelation, RuntimeAgent, RuntimeAgentCommand, RuntimeAgentError,
        RuntimeAgentHeartbeat, RuntimeAgentId, RuntimeAgentProgress, RuntimeAgentReportOutcome,
        RuntimeAgentResult,
    },
    domain::target::{FleetTargetConfig, TargetId, TargetSnapshot},
    domain::topology::{
        AgentObservation, CapabilitySync, EndpointHealth, EndpointObservation, NodeId,
        NodeObservation, RuntimeId, RuntimeObservation, TopologyMutation,
    },
    store::{
        AgentIngressIdentity, FleetFacts, FleetFactsRestoreInput, FleetStore,
        IngressAuthentication, StoreFault, TargetMatchError,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetDeliveryRequest {
    command: CommandIntent,
    dispatch: DispatchIntent,
}

impl FleetDeliveryRequest {
    pub fn try_new(
        command: CommandIntent,
        dispatch: DispatchIntent,
    ) -> Result<Self, FleetDeliveryError> {
        if command.command_id() != dispatch.command_id() {
            return Err(FleetDeliveryError::MismatchedDispatchCommand);
        }
        Ok(Self { command, dispatch })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetSubmitOutcome {
    Submitted,
    AlreadySubmitted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetDeliveryOutcome {
    Recorded,
    AlreadyRecorded,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FleetDeliveryError {
    CommandNotFound,
    DispatchNotFound,
    MismatchedDispatchCommand,
    DuplicateCommand,
    DuplicateDispatch,
    AttemptConflict,
    AuthenticatedAgentMismatch,
    InvalidTransition,
    DeliveryOutcomeUnknown,
    AlreadyInFlight,
    AlreadyDelivered,
    DispatchRequest,
    Store(StoreFault),
    Connection(ConnectionMutationError),
    Environment(EnvironmentMutationError),
    LifecycleCorrelationConflict,
    Effect(EffectTransitionError),
    EffectNotFound,
    DuplicateEffect,
    RuntimeAgentNotFound,
    RuntimeAgentAlreadyExists,
    RuntimeAgent(crate::domain::runtime_agent::RuntimeAgentError),
    Reachability(ReachabilityError),
    DispatchReadback(FleetDispatchReadbackError),
}

impl fmt::Display for FleetDeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CommandNotFound => "Fleet command was not found",
            Self::DispatchNotFound => "Fleet dispatch was not found",
            Self::MismatchedDispatchCommand => "Fleet dispatch must reference its command",
            Self::DuplicateCommand => "Fleet command already exists",
            Self::DuplicateDispatch => "Fleet dispatch already exists",
            Self::AttemptConflict => "Fleet delivery attempt is stale or conflicts",
            Self::AuthenticatedAgentMismatch => {
                "Fleet delivery receipt is not authorized for this RuntimeAgent"
            }
            Self::InvalidTransition => "Fleet delivery transition was rejected",
            Self::DeliveryOutcomeUnknown => "Fleet delivery outcome requires explicit replay",
            Self::AlreadyInFlight => "Fleet delivery is already in flight",
            Self::AlreadyDelivered => "Fleet delivery was already acknowledged",
            Self::DispatchRequest => "Fleet dispatch request was rejected",
            Self::Store(_) => "Fleet durable state transition failed",
            Self::Connection(_) => "Fleet connection mutation failed",
            Self::Environment(_) => "Fleet environment mutation failed",
            Self::LifecycleCorrelationConflict => {
                "Fleet lifecycle correlation is missing or ambiguous"
            }
            Self::Effect(_) => "Fleet provider effect mutation failed",
            Self::EffectNotFound => "Fleet provider effect was not found",
            Self::DuplicateEffect => "Fleet provider effect already exists",
            Self::RuntimeAgentNotFound => "Fleet RuntimeAgent was not found",
            Self::RuntimeAgentAlreadyExists => "Fleet RuntimeAgent already exists",
            Self::RuntimeAgent(_) => "Fleet RuntimeAgent mutation was rejected",
            Self::Reachability(_) => "Fleet RuntimeAgent reachability mutation was rejected",
            Self::DispatchReadback(_) => "Fleet RuntimeAgent readback did not match dispatch",
        })
    }
}

impl From<RuntimeAgentError> for FleetDeliveryError {
    fn from(error: RuntimeAgentError) -> Self {
        Self::RuntimeAgent(error)
    }
}

impl std::error::Error for FleetDeliveryError {}

pub struct FleetDeliveryOwner {
    store: FleetStore,
}

impl FleetDeliveryOwner {
    pub fn hash_ingress_credential(
        value: &str,
    ) -> Result<
        crate::domain::topology::CredentialHash,
        crate::domain::topology::InvalidCredentialHash,
    > {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(value.as_bytes());
        let encoded = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        crate::domain::topology::CredentialHash::try_new(encoded)
    }

    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Ok(Self {
            store: FleetStore::open(path)?,
        })
    }

    pub fn open_live(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Ok(Self {
            store: FleetStore::open_live(path)?,
        })
    }

    pub fn from_store(store: FleetStore) -> Self {
        Self { store }
    }

    pub fn facts(&self) -> &FleetFacts {
        self.store.facts()
    }

    pub fn environment(&self, id: &EnvironmentId) -> Option<&EnvironmentRecord> {
        self.store
            .facts()
            .environments()
            .find(|record| record.id() == id)
    }

    pub fn managed_resource_lifecycle_context(
        &self,
        id: Option<&ManagedResourceId>,
    ) -> ManagedResourceLifecycleContext {
        self.store.facts().managed_resource_lifecycle_context(id)
    }

    pub fn authenticate_or_enroll_ingress(
        &mut self,
        identity: AgentIngressIdentity,
    ) -> Result<IngressAuthentication, FleetDeliveryError> {
        self.store
            .authenticate_or_enroll_ingress(identity)
            .map_err(FleetDeliveryError::Store)
    }

    pub fn register_runtime_agent(
        &mut self,
        agent: RuntimeAgent,
    ) -> Result<(), FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .insert_runtime_agent(agent)
                .map_err(|_| FleetDeliveryError::RuntimeAgentAlreadyExists)
        })
    }

    pub fn upsert_runtime_agent_reachability(
        &mut self,
        reachability: RuntimeAgentIngressReachabilityFacts,
        now: SystemTime,
    ) -> Result<(), FleetDeliveryError> {
        self.transact(|facts| {
            let mut current = RuntimeAgentReachabilityFactsStore::default();
            for existing in facts.runtime_agent_reachability_facts() {
                current
                    .upsert(existing.clone(), now)
                    .map_err(FleetDeliveryError::Reachability)?;
            }
            current
                .upsert(reachability, now)
                .map_err(FleetDeliveryError::Reachability)?;
            let records = current.records().cloned().collect::<Vec<_>>();
            *facts = FleetFacts::restore_live(FleetFactsRestoreInput {
                commands: facts.command_records().cloned().collect(),
                dispatches: facts.dispatch_records().cloned().collect(),
                secret_references: facts.secret_references().cloned().collect(),
                audit_entries: facts.audit_entries().to_vec(),
                topology: facts.topology().clone(),
                enrollments: facts.access().enrollments().cloned().collect(),
                ingress_credentials: facts.access().ingress_credentials().cloned().collect(),
                targets: facts
                    .target_records()
                    .map(|(id, revision, config)| (id.clone(), revision, config.clone()))
                    .collect(),
                connections: facts.connections().cloned().collect(),
                environments: facts.environments().cloned().collect(),
                managed_resources: facts.managed_resources().cloned().collect(),
                effects: facts.effects().cloned().collect(),
                runtime_agents: facts.runtime_agents().cloned().collect(),
                runtime_agent_reachability: records,
                leases: facts.leases().leases().cloned().collect(),
                bindings: facts.target_bindings().cloned().collect(),
            })
            .map_err(|_| FleetDeliveryError::Reachability(ReachabilityError::InvalidLease))?;
            Ok(())
        })
    }

    pub fn dispatch_id_for_command(&self, command_id: &CommandId) -> Option<&DispatchId> {
        self.store.facts().dispatch_id_for_command(command_id)
    }

    pub fn record_for_command(
        &self,
        command_id: &CommandId,
    ) -> Option<&crate::domain::outbox::OutboxRecord> {
        self.store.facts().record_for_command(command_id)
    }

    pub fn pending_dispatches(&self) -> impl Iterator<Item = &crate::domain::outbox::OutboxRecord> {
        self.store.facts().outbox().pending()
    }

    pub fn begin_dispatch_for_command(
        &mut self,
        command_id: &CommandId,
        at: SystemTime,
    ) -> Result<FleetDispatchRequest, FleetDeliveryError> {
        let dispatch_id = self
            .dispatch_id_for_command(command_id)
            .cloned()
            .ok_or(FleetDeliveryError::CommandNotFound)?;
        self.begin_dispatch(&dispatch_id, at)
    }

    pub fn runtime_agent_command_for_dispatch(
        &self,
        request: &FleetDispatchRequest,
    ) -> Result<Option<&RuntimeAgentCommand>, FleetDeliveryError> {
        self.store
            .facts()
            .runtime_agent_command_for_dispatch(request)
            .map_err(FleetDeliveryError::DispatchReadback)
    }

    pub fn register_runtime_agent_command(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: CommandCorrelation,
        queued_at: SystemTime,
        command_attempt: CommandAttempt,
        dispatch_attempt: DispatchAttempt,
    ) -> Result<(), FleetDeliveryError> {
        self.transact(|facts| {
            let command = facts
                .command_ledger()
                .record(correlation.command_id())
                .ok_or(FleetDeliveryError::CommandNotFound)?;
            if command.intent().idempotency_key() != correlation.idempotency_key()
                || (command.attempt().is_some() && command.attempt() != Some(&command_attempt))
                || (!matches!(command.state(), CommandState::Queued { .. })
                    && command.attempt() != Some(&command_attempt))
            {
                return Err(FleetDeliveryError::AttemptConflict);
            }
            let dispatch = facts
                .outbox()
                .record_for_command(correlation.command_id())
                .ok_or(FleetDeliveryError::DispatchNotFound)?;
            if dispatch.intent().agent_id() != agent_id
                || dispatch.attempt() != Some(&dispatch_attempt)
                || dispatch_attempt.sequence() != command_attempt.sequence()
            {
                return Err(FleetDeliveryError::AttemptConflict);
            }
            let runtime_agent = facts
                .runtime_agent_mut(agent_id)
                .ok_or(FleetDeliveryError::RuntimeAgentNotFound)?;
            runtime_agent
                .register_command_with_attempts(
                    correlation,
                    queued_at,
                    command_attempt,
                    dispatch_attempt,
                )
                .map_err(Into::into)
        })
    }

    pub fn record_runtime_agent_heartbeat(
        &mut self,
        agent_id: &RuntimeAgentId,
        heartbeat: RuntimeAgentHeartbeat,
    ) -> Result<RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .runtime_agent_mut(agent_id)
                .ok_or(FleetDeliveryError::RuntimeAgentNotFound)?
                .record_heartbeat(agent_id, heartbeat)
                .map_err(Into::into)
        })
    }

    pub fn record_runtime_agent_progress(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        progress: RuntimeAgentProgress,
        reported_at: SystemTime,
        command_attempt: &CommandAttempt,
        dispatch_attempt: &DispatchAttempt,
    ) -> Result<RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .runtime_agent_mut(agent_id)
                .ok_or(FleetDeliveryError::RuntimeAgentNotFound)?
                .record_progress_with_attempt(
                    agent_id,
                    correlation,
                    progress,
                    reported_at,
                    Some(command_attempt),
                    Some(dispatch_attempt),
                )
                .map_err(Into::into)
        })
    }

    pub fn settle_runtime_agent_result(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        result: RuntimeAgentResult,
        command_attempt: &CommandAttempt,
        dispatch_attempt: &DispatchAttempt,
    ) -> Result<RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            let (dispatch_id, dispatch_agent_id, current_dispatch_attempt, dispatch_command_id) = {
                let dispatch = facts
                    .outbox()
                    .record_for_command(correlation.command_id())
                    .ok_or(FleetDeliveryError::DispatchNotFound)?;
                (
                    dispatch.intent().dispatch_id().clone(),
                    dispatch.intent().agent_id().clone(),
                    dispatch.attempt().cloned(),
                    dispatch.intent().command_id().clone(),
                )
            };
            if dispatch_agent_id != *agent_id
                || current_dispatch_attempt.as_ref() != Some(dispatch_attempt)
                || dispatch_attempt.sequence() != command_attempt.sequence()
                || dispatch_command_id != *correlation.command_id()
            {
                return Err(FleetDeliveryError::AttemptConflict);
            }
            let command = facts
                .command_ledger()
                .record(correlation.command_id())
                .ok_or(FleetDeliveryError::CommandNotFound)?;
            if command.intent().idempotency_key() != correlation.idempotency_key()
                || command
                    .attempt()
                    .is_some_and(|attempt| attempt != command_attempt)
            {
                return Err(FleetDeliveryError::AttemptConflict);
            }

            let report_outcome = facts
                .runtime_agent_mut(agent_id)
                .ok_or(FleetDeliveryError::RuntimeAgentNotFound)?
                .record_result_with_attempt(
                    agent_id,
                    correlation,
                    result.clone(),
                    Some(command_attempt),
                    Some(dispatch_attempt),
                )
                .map_err(FleetDeliveryError::from)?;

            if matches!(
                facts
                    .command_ledger()
                    .record(correlation.command_id())
                    .map(|record| record.state()),
                Some(CommandState::Queued { .. })
            ) {
                match facts
                    .command_ledger_mut()
                    .start(correlation.command_id(), result.completed_at())
                {
                    crate::domain::command::StartOutcome::Started { attempt, .. }
                    | crate::domain::command::StartOutcome::AlreadyRunning { attempt, .. }
                        if attempt == *command_attempt => {}
                    crate::domain::command::StartOutcome::NotFound => {
                        return Err(FleetDeliveryError::CommandNotFound);
                    }
                    crate::domain::command::StartOutcome::Started { .. }
                    | crate::domain::command::StartOutcome::AlreadyRunning { .. }
                    | crate::domain::command::StartOutcome::Rejected(_) => {
                        return Err(FleetDeliveryError::AttemptConflict);
                    }
                }
            }

            let lifecycle = lifecycle_correlation(facts, correlation.command_id())?;
            let command_outcome = match &result {
                RuntimeAgentResult::Succeeded { .. } => facts.command_ledger_mut().succeed(
                    correlation.command_id(),
                    command_attempt,
                    result.completed_at(),
                ),
                RuntimeAgentResult::Failed { .. } => facts.command_ledger_mut().fail(
                    correlation.command_id(),
                    command_attempt,
                    CommandFailure::ExecutionFailed,
                    result.completed_at(),
                ),
                RuntimeAgentResult::Cancelled { .. } => {
                    facts.command_ledger_mut().cancel_with_attempt(
                        correlation.command_id(),
                        command_attempt,
                        Some(CommandCancellation::Requested),
                        result.completed_at(),
                    )
                }
                RuntimeAgentResult::TimedOut { timeout, .. } => {
                    facts.command_ledger_mut().time_out_with_attempt(
                        correlation.command_id(),
                        command_attempt,
                        *timeout,
                        result.completed_at(),
                    )
                }
            };
            match command_outcome {
                TransitionOutcome::Transitioned(_) | TransitionOutcome::Unchanged(_) => {}
                TransitionOutcome::StaleAttempt(_) => {
                    return Err(FleetDeliveryError::AttemptConflict);
                }
                TransitionOutcome::NotFound => return Err(FleetDeliveryError::CommandNotFound),
                TransitionOutcome::Rejected(_) => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            }
            if report_outcome == RuntimeAgentReportOutcome::Recorded {
                settle_lifecycle(facts, lifecycle.as_ref(), correlation.command_id(), &result)?;
            }

            match facts
                .outbox_mut()
                .acknowledge_delivery(&dispatch_id, dispatch_attempt)
            {
                AcknowledgeDeliveryOutcome::Delivered(_)
                | AcknowledgeDeliveryOutcome::AlreadyDelivered => {}
                AcknowledgeDeliveryOutcome::NotFound => {
                    return Err(FleetDeliveryError::DispatchNotFound);
                }
                AcknowledgeDeliveryOutcome::StaleAttempt => {
                    return Err(FleetDeliveryError::AttemptConflict);
                }
            }
            append_command_audit(
                facts,
                correlation.command_id(),
                "fleet.runtime_agent.result_settled",
                result.completed_at(),
            )?;
            Ok(report_outcome)
        })
    }

    pub fn record_runtime_agent_result(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        result: RuntimeAgentResult,
        command_attempt: &CommandAttempt,
        dispatch_attempt: &DispatchAttempt,
    ) -> Result<RuntimeAgentReportOutcome, FleetDeliveryError> {
        self.settle_runtime_agent_result(
            agent_id,
            correlation,
            result,
            command_attempt,
            dispatch_attempt,
        )
    }

    pub fn upsert_node(
        &mut self,
        observation: NodeObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .upsert_node(observation, now)
                .map_err(map_topology_error)
        })
    }

    pub fn retire_node(
        &mut self,
        id: &NodeId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| facts.retire_node(id, at).map_err(map_topology_error))
    }

    pub fn upsert_agent(
        &mut self,
        observation: AgentObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .upsert_agent(observation, now)
                .map_err(map_topology_error)
        })
    }

    pub fn enroll_agent(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| facts.enroll_agent(id, at).map_err(map_topology_error))
    }

    pub fn revoke_agent(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| facts.revoke_agent(id, at).map_err(map_topology_error))
    }

    pub fn upsert_runtime(
        &mut self,
        observation: RuntimeObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .upsert_runtime(observation, now)
                .map_err(map_topology_error)
        })
    }

    pub fn begin_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .begin_runtime_start(id, command, at)
                .map_err(map_topology_error)
        })
    }

    pub fn complete_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_runtime_start(id, command, at)
                .map_err(map_topology_error)
        })
    }

    pub fn begin_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .begin_runtime_stop(id, command, at)
                .map_err(map_topology_error)
        })
    }

    pub fn complete_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_runtime_stop(id, command, at)
                .map_err(map_topology_error)
        })
    }

    pub fn retire_runtime(
        &mut self,
        id: &RuntimeId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| facts.retire_runtime(id, at).map_err(map_topology_error))
    }

    pub fn upsert_endpoint(
        &mut self,
        observation: EndpointObservation,
        now: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .upsert_endpoint(observation, now)
                .map_err(map_topology_error)
        })
    }

    pub fn drain_endpoint(
        &mut self,
        id: &platform::endpoint::EndpointId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| facts.drain_endpoint(id, at).map_err(map_topology_error))
    }

    pub fn retire_endpoint(
        &mut self,
        id: &platform::endpoint::EndpointId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| facts.retire_endpoint(id, at).map_err(map_topology_error))
    }

    pub fn begin_endpoint_probe(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .begin_endpoint_probe(id, command, at)
                .map_err(map_topology_error)
        })
    }

    pub fn complete_endpoint_probe(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: &CommandId,
        health: EndpointHealth,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_endpoint_probe(id, command, health, at)
                .map_err(map_topology_error)
        })
    }

    pub fn begin_capability_sync(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: CommandId,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .begin_capability_sync(id, command, at)
                .map_err(map_topology_error)
        })
    }

    pub fn complete_capability_sync(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: &CommandId,
        sync: CapabilitySync,
        at: SystemTime,
    ) -> Result<TopologyMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_capability_sync(id, command, sync, at)
                .map_err(map_topology_error)
        })
    }

    pub fn put_target(
        &mut self,
        id: TargetId,
        config: FleetTargetConfig,
    ) -> Result<TargetSnapshot, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .put_target(id, config)
                .map_err(|_| FleetDeliveryError::InvalidTransition)
        })
    }

    pub fn remove_target(&mut self, id: &TargetId) -> Result<bool, FleetDeliveryError> {
        self.transact(|facts| Ok(facts.remove_target(id)))
    }

    pub fn bind_target_endpoint(
        &mut self,
        binding: crate::domain::target::TargetEndpointBinding,
    ) -> Result<(), FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .bind_target_endpoint(binding)
                .map_err(|_| FleetDeliveryError::InvalidTransition)
        })
    }

    pub fn upsert_connection(
        &mut self,
        record: ConnectionRecord,
        now: SystemTime,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .upsert_connection(record, now)
                .map_err(map_connection_error)
        })
    }

    pub fn delete_connection(
        &mut self,
        id: &ConnectionId,
        now: SystemTime,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .delete_connection(id, now)
                .map_err(map_connection_error)
        })
    }

    pub fn begin_connection_probe(
        &mut self,
        id: &ConnectionId,
        command_id: CommandId,
        now: SystemTime,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .begin_connection_probe(id, command_id, now)
                .map_err(map_connection_error)
        })
    }

    pub fn complete_connection_probe(
        &mut self,
        id: &ConnectionId,
        command_id: &CommandId,
        outcome: ProbeOutcome,
        observed_at: SystemTime,
        message: Option<String>,
    ) -> Result<ConnectionMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_connection_probe(id, command_id, outcome, observed_at, message)
                .map_err(map_connection_error)
        })
    }

    pub fn register_environment(
        &mut self,
        record: EnvironmentRecord,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .register_environment(record, now)
                .map_err(map_environment_error)
        })
    }

    pub fn start_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .start_environment_deployment(id, command_id, phase, now)
                .map_err(map_environment_error)
        })
    }

    pub fn complete_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_environment_deployment(id, command_id, phase, ready_at)
                .map_err(map_environment_error)
        })
    }

    pub fn fail_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .fail_environment_deployment(id, command_id, phase, message, failed_at)
                .map_err(map_environment_error)
        })
    }

    pub fn start_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .start_environment_deletion(id, command_id, phase, now)
                .map_err(map_environment_error)
        })
    }

    pub fn complete_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_environment_deletion(id, command_id, phase, deleted_at)
                .map_err(map_environment_error)
        })
    }

    pub fn fail_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .fail_environment_deletion(id, command_id, phase, message, failed_at)
                .map_err(map_environment_error)
        })
    }

    pub fn register_managed_resource(
        &mut self,
        resource: ManagedResourceRecord,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .register_managed_resource(resource)
                .map_err(map_environment_error)
        })
    }

    pub fn register_observed_managed_resource(
        &mut self,
        resource: ManagedResourceRecord,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            let connection_id = resource.connection_id().clone();
            let environment_id = resource.environment_id().clone();
            let resource_id = resource.id().clone();
            let mutation = facts
                .register_managed_resource(resource)
                .map_err(map_environment_error)?;
            facts
                .associate_managed_resource(&connection_id, &environment_id, resource_id)
                .map_err(map_topology_error)?;
            Ok(mutation)
        })
    }

    pub fn refresh_observed_managed_resource(
        &mut self,
        id: &ManagedResourceId,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
        connection_id: &ConnectionId,
        environment_id: &EnvironmentId,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            let mutation = facts
                .refresh_observed_managed_resource(
                    id,
                    connection_id,
                    environment_id,
                    metadata,
                    observed_at,
                )
                .map_err(map_environment_error)?;
            facts
                .associate_managed_resource(connection_id, environment_id, id.clone())
                .map_err(map_topology_error)?;
            Ok(mutation)
        })
    }

    pub fn materialize_reused_environment_deployment(
        &mut self,
        environment_id: &EnvironmentId,
        id: &ManagedResourceId,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
        connection_id: &ConnectionId,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            let mutation = facts
                .refresh_observed_managed_resource(
                    id,
                    connection_id,
                    environment_id,
                    metadata,
                    observed_at,
                )
                .map_err(map_environment_error)?;
            facts
                .associate_managed_resource(connection_id, environment_id, id.clone())
                .map_err(map_topology_error)?;
            facts
                .complete_environment_deployment(environment_id, command_id, phase, ready_at)
                .map_err(map_environment_error)?;
            Ok(mutation)
        })
    }

    pub fn materialize_environment_deployment(
        &mut self,
        environment_id: &EnvironmentId,
        resource: ManagedResourceRecord,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            let connection_id = resource.connection_id().clone();
            let resource_id = resource.id().clone();
            let mutation = facts
                .register_managed_resource(resource)
                .map_err(map_environment_error)?;
            facts
                .associate_managed_resource(&connection_id, environment_id, resource_id)
                .map_err(map_topology_error)?;
            facts
                .complete_environment_deployment(environment_id, command_id, phase, ready_at)
                .map_err(map_environment_error)?;
            Ok(mutation)
        })
    }

    pub fn cleanup_resource_ids(
        &mut self,
        environment_id: &EnvironmentId,
    ) -> Result<Vec<ManagedResourceId>, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .cleanup_resource_ids(environment_id)
                .map_err(map_environment_error)
        })
    }

    pub fn start_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .start_resource_provisioning(id, command_id, phase, now)
                .map_err(map_environment_error)
        })
    }

    pub fn fail_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .fail_resource_provisioning(id, command_id, phase, message, failed_at)
                .map_err(map_environment_error)
        })
    }

    pub fn complete_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_resource_provisioning(id, command_id, phase, observed_at)
                .map_err(map_environment_error)
        })
    }

    pub fn materialize_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            let resource = facts
                .managed_resources()
                .find(|resource| resource.id() == id)
                .ok_or(FleetDeliveryError::InvalidTransition)?;
            let connection_id = resource.connection_id().clone();
            let environment_id = resource.environment_id().clone();
            facts
                .materialize_resource_provisioning(id, command_id, phase, metadata, observed_at)
                .map_err(map_environment_error)?;
            facts
                .associate_managed_resource(&connection_id, &environment_id, id.clone())
                .map_err(map_topology_error)?;
            Ok(ManagedResourceMutation::ProvisioningCompleted)
        })
    }

    pub fn start_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .start_resource_deletion(id, command_id, phase, now)
                .map_err(map_environment_error)
        })
    }

    pub fn complete_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .complete_resource_deletion(id, command_id, phase, deleted_at)
                .map_err(map_environment_error)
        })
    }

    pub fn fail_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .fail_resource_deletion(id, command_id, phase, message, failed_at)
                .map_err(map_environment_error)
        })
    }

    pub fn insert_effect(&mut self, record: EffectRecord) -> Result<(), FleetDeliveryError> {
        self.transact(|facts| {
            facts
                .effects_mut()
                .insert(record)
                .map_err(|_| FleetDeliveryError::DuplicateEffect)
        })
    }

    pub fn insert_and_begin_effect(
        &mut self,
        record: EffectRecord,
    ) -> Result<(EffectIdentity, CommandAttempt), FleetDeliveryError> {
        let identity = record.identity().clone();
        self.transact(|facts| {
            facts
                .effects_mut()
                .insert(record)
                .map_err(|_| FleetDeliveryError::DuplicateEffect)?;
            match facts.effect_operation(&identity, EffectLedger::begin) {
                EffectOperationOutcome::Applied {
                    transition: crate::domain::effect::EffectTransition::Began { attempt },
                } => Ok((identity, attempt)),
                EffectOperationOutcome::Applied { .. } => {
                    Err(FleetDeliveryError::InvalidTransition)
                }
                EffectOperationOutcome::NotFound => Err(FleetDeliveryError::EffectNotFound),
                EffectOperationOutcome::Rejected(error) => Err(FleetDeliveryError::Effect(error)),
            }
        })
    }

    pub fn begin_effect(
        &mut self,
        identity: &EffectIdentity,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.transact(|facts| Ok(facts.effect_operation(identity, EffectLedger::begin)))
    }

    pub fn accept_effect(
        &mut self,
        identity: &EffectIdentity,
        receipt: &EffectReceipt,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            Ok(facts.effect_operation(identity, |ledger, id| ledger.accept(id, receipt)))
        })
    }

    pub fn reject_effect(
        &mut self,
        identity: &EffectIdentity,
        receipt: &EffectReceipt,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            Ok(facts.effect_operation(identity, |ledger, id| ledger.reject(id, receipt)))
        })
    }

    pub fn mark_effect_unknown(
        &mut self,
        identity: &EffectIdentity,
        now: SystemTime,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            Ok(facts.effect_operation(identity, |ledger, id| ledger.unknown(id, now)))
        })
    }

    pub fn mark_effect_unknown_attempt(
        &mut self,
        identity: &EffectIdentity,
        attempt: &CommandAttempt,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            Ok(facts.effect_operation(identity, |ledger, id| ledger.mark_unknown(id, attempt)))
        })
    }

    pub fn authorize_effect_replay(
        &mut self,
        identity: &EffectIdentity,
    ) -> Result<EffectOperationOutcome, FleetDeliveryError> {
        self.transact(|facts| Ok(facts.effect_operation(identity, EffectLedger::replay)))
    }

    pub fn submit(
        &mut self,
        request: FleetDeliveryRequest,
        at: SystemTime,
    ) -> Result<FleetSubmitOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            let command_id = request.command.command_id().clone();
            let dispatch_id = request.dispatch.dispatch_id().clone();
            match facts.command_ledger_mut().submit(request.command) {
                SubmitOutcome::Submitted(_) => {}
                SubmitOutcome::Duplicate(existing)
                    if existing.intent().command_id() == &command_id
                        && facts.outbox().record_for_command(&command_id).is_some_and(
                            |record| record.intent().dispatch_id() == &dispatch_id,
                        ) =>
                {
                    return Ok(FleetSubmitOutcome::AlreadySubmitted);
                }
                SubmitOutcome::Duplicate(_) | SubmitOutcome::DuplicateCommandId(_) => {
                    return Err(FleetDeliveryError::DuplicateCommand);
                }
            }
            match facts.outbox_mut().insert(request.dispatch) {
                InsertOutcome::Inserted => {}
                InsertOutcome::DuplicateDispatchId(_) | InsertOutcome::DuplicateCommandId(_) => {
                    return Err(FleetDeliveryError::DuplicateDispatch);
                }
            }
            append_command_audit(facts, &command_id, "fleet.delivery.submitted", at)?;
            Ok(FleetSubmitOutcome::Submitted)
        })
    }

    pub fn begin_dispatch(
        &mut self,
        dispatch_id: &DispatchId,
        at: SystemTime,
    ) -> Result<FleetDispatchRequest, FleetDeliveryError> {
        self.transact(|facts| {
            let dispatch = facts
                .outbox()
                .record(dispatch_id)
                .ok_or(FleetDeliveryError::DispatchNotFound)?
                .intent()
                .clone();
            let command = facts
                .command_ledger()
                .record(dispatch.command_id())
                .ok_or(FleetDeliveryError::CommandNotFound)?
                .clone();
            if !matches!(command.state(), CommandState::Queued { .. }) {
                return Err(FleetDeliveryError::InvalidTransition);
            }
            let Some(selector) = dispatch.target() else {
                return Err(FleetDeliveryError::DispatchRequest);
            };
            facts
                .target_matches(selector)
                .map_err(|error| match error {
                    TargetMatchError::NotFound
                    | TargetMatchError::RevisionMismatch
                    | TargetMatchError::KindMismatch => FleetDeliveryError::DispatchRequest,
                })?;
            let target = facts
                .target_binding(selector.id())
                .filter(|binding| binding.target_revision() == selector.revision())
                .and_then(|binding| {
                    Some(FleetDispatchTarget::new(
                        selector.clone(),
                        facts.target_configuration(selector.id())?.clone(),
                        binding.clone(),
                        facts.topology().endpoint(binding.endpoint_id())?.clone(),
                    ))
                });
            let attempt = match facts.outbox_mut().begin_delivery(dispatch_id) {
                BeginDeliveryOutcome::Begun(attempt) => attempt,
                BeginDeliveryOutcome::AlreadyInFlight(_) => {
                    return Err(FleetDeliveryError::AlreadyInFlight);
                }
                BeginDeliveryOutcome::OutcomeUnknown => {
                    return Err(FleetDeliveryError::DeliveryOutcomeUnknown);
                }
                BeginDeliveryOutcome::AlreadyDelivered => {
                    return Err(FleetDeliveryError::AlreadyDelivered);
                }
                BeginDeliveryOutcome::NotFound => return Err(FleetDeliveryError::DispatchNotFound),
                BeginDeliveryOutcome::AttemptOverflow => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            };
            append_command_audit(
                facts,
                command.intent().command_id(),
                "fleet.delivery.begun",
                at,
            )?;
            FleetDispatchRequest::try_new(command.intent().clone(), dispatch, attempt)
                .map(|request| match target {
                    Some(target) => request.with_target(target),
                    None => request,
                })
                .map_err(|_| FleetDeliveryError::DispatchRequest)
        })
    }

    pub fn accept_dispatch(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            let command_id = facts
                .outbox()
                .record(dispatch_id)
                .ok_or(FleetDeliveryError::DispatchNotFound)?
                .intent()
                .command_id()
                .clone();
            match delivery_phase(facts, dispatch_id, attempt)? {
                DispatchPhase::Delivered => {
                    if matches!(
                        facts
                            .command_ledger()
                            .record(&command_id)
                            .map(|record| record.state()),
                        Some(CommandState::Succeeded { .. })
                    ) {
                        return Ok(FleetDeliveryOutcome::AlreadyRecorded);
                    }
                    return Err(FleetDeliveryError::InvalidTransition);
                }
                DispatchPhase::InFlight | DispatchPhase::OutcomeUnknown => {}
                DispatchPhase::Pending => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            }

            let command_attempt = CommandAttempt::try_new(attempt.sequence())
                .map_err(|_| FleetDeliveryError::AttemptConflict)?;
            match facts.command_ledger().record(&command_id) {
                Some(record) if matches!(record.state(), CommandState::Queued { .. }) => {
                    match facts.command_ledger_mut().start(&command_id, at) {
                        crate::domain::command::StartOutcome::Started {
                            attempt: started, ..
                        } if started == command_attempt => {}
                        crate::domain::command::StartOutcome::AlreadyRunning {
                            attempt: running,
                            ..
                        } if running == command_attempt => {}
                        crate::domain::command::StartOutcome::NotFound => {
                            return Err(FleetDeliveryError::CommandNotFound);
                        }
                        crate::domain::command::StartOutcome::Started { .. }
                        | crate::domain::command::StartOutcome::AlreadyRunning { .. }
                        | crate::domain::command::StartOutcome::Rejected(_) => {
                            return Err(FleetDeliveryError::AttemptConflict);
                        }
                    }
                    true
                }
                Some(_) => false,
                None => return Err(FleetDeliveryError::CommandNotFound),
            };
            match facts
                .command_ledger_mut()
                .succeed(&command_id, &command_attempt, at)
            {
                TransitionOutcome::Transitioned(_) | TransitionOutcome::Unchanged(_) => {}
                TransitionOutcome::StaleAttempt(_) => {
                    return Err(FleetDeliveryError::AttemptConflict);
                }
                TransitionOutcome::NotFound => return Err(FleetDeliveryError::CommandNotFound),
                TransitionOutcome::Rejected(_) => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            }

            match facts
                .outbox_mut()
                .acknowledge_delivery(dispatch_id, attempt)
            {
                AcknowledgeDeliveryOutcome::Delivered(_) => {
                    append_command_audit(facts, &command_id, "fleet.delivery.accepted", at)?;
                    Ok(FleetDeliveryOutcome::Recorded)
                }
                AcknowledgeDeliveryOutcome::AlreadyDelivered => {
                    Ok(FleetDeliveryOutcome::AlreadyRecorded)
                }
                AcknowledgeDeliveryOutcome::NotFound => Err(FleetDeliveryError::DispatchNotFound),
                AcknowledgeDeliveryOutcome::StaleAttempt => {
                    Err(FleetDeliveryError::AttemptConflict)
                }
            }
        })
    }

    pub fn reject_dispatch(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            let command_id = facts
                .outbox()
                .record(dispatch_id)
                .ok_or(FleetDeliveryError::DispatchNotFound)?
                .intent()
                .command_id()
                .clone();
            let command_attempt = CommandAttempt::try_new(attempt.sequence())
                .map_err(|_| FleetDeliveryError::AttemptConflict)?;
            let command_recorded = match facts.command_ledger_mut().fail(
                &command_id,
                &command_attempt,
                CommandFailure::Rejected,
                at,
            ) {
                TransitionOutcome::Transitioned(_) => true,
                TransitionOutcome::Unchanged(_) => false,
                TransitionOutcome::StaleAttempt(_) => {
                    return Err(FleetDeliveryError::AttemptConflict);
                }
                TransitionOutcome::NotFound => return Err(FleetDeliveryError::CommandNotFound),
                TransitionOutcome::Rejected(_) => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            };
            let delivery_recorded = match facts
                .outbox_mut()
                .acknowledge_delivery(dispatch_id, attempt)
            {
                AcknowledgeDeliveryOutcome::Delivered(_) => true,
                AcknowledgeDeliveryOutcome::AlreadyDelivered => false,
                AcknowledgeDeliveryOutcome::NotFound => {
                    return Err(FleetDeliveryError::DispatchNotFound);
                }
                AcknowledgeDeliveryOutcome::StaleAttempt => {
                    return Err(FleetDeliveryError::AttemptConflict);
                }
            };
            if command_recorded || delivery_recorded {
                append_command_audit(facts, &command_id, "fleet.delivery.rejected", at)?;
                Ok(FleetDeliveryOutcome::Recorded)
            } else {
                Ok(FleetDeliveryOutcome::AlreadyRecorded)
            }
        })
    }

    pub fn mark_outcome_unknown(
        &mut self,
        dispatch_id: &DispatchId,
        attempt: &DispatchAttempt,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            let command_id = facts
                .outbox()
                .record(dispatch_id)
                .ok_or(FleetDeliveryError::DispatchNotFound)?
                .intent()
                .command_id()
                .clone();
            let command_attempt = CommandAttempt::try_new(attempt.sequence())
                .map_err(|_| FleetDeliveryError::AttemptConflict)?;
            let command_recorded = match facts.command_ledger_mut().mark_outcome_unknown(
                &command_id,
                &command_attempt,
                at,
            ) {
                TransitionOutcome::Transitioned(_) => true,
                TransitionOutcome::Unchanged(_) => false,
                TransitionOutcome::StaleAttempt(_) => {
                    return Err(FleetDeliveryError::AttemptConflict);
                }
                TransitionOutcome::NotFound => return Err(FleetDeliveryError::CommandNotFound),
                TransitionOutcome::Rejected(_) => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            };
            let delivery_recorded = match delivery_phase(facts, dispatch_id, attempt)? {
                DispatchPhase::InFlight => match facts
                    .outbox_mut()
                    .mark_delivery_outcome_unknown(dispatch_id, attempt)
                {
                    ReplayOutcome::Authorized => true,
                    ReplayOutcome::Unchanged | ReplayOutcome::NotFound => {
                        return Err(FleetDeliveryError::InvalidTransition);
                    }
                },
                DispatchPhase::OutcomeUnknown => false,
                DispatchPhase::Pending | DispatchPhase::Delivered => {
                    return Err(FleetDeliveryError::InvalidTransition);
                }
            };
            if command_recorded || delivery_recorded {
                append_command_audit(facts, &command_id, "fleet.delivery.outcome_unknown", at)?;
                Ok(FleetDeliveryOutcome::Recorded)
            } else {
                Ok(FleetDeliveryOutcome::AlreadyRecorded)
            }
        })
    }

    pub fn authorize_replay(
        &mut self,
        command_id: &CommandId,
        dispatch_id: &DispatchId,
        at: SystemTime,
    ) -> Result<FleetDeliveryOutcome, FleetDeliveryError> {
        self.transact(|facts| {
            let phase = facts
                .outbox()
                .record(dispatch_id)
                .ok_or(FleetDeliveryError::DispatchNotFound)?;
            if phase.intent().command_id() != command_id {
                return Err(FleetDeliveryError::MismatchedDispatchCommand);
            }
            if !matches!(
                facts
                    .command_ledger()
                    .record(command_id)
                    .map(|record| record.state()),
                Some(CommandState::OutcomeUnknown { .. })
            ) {
                return Err(FleetDeliveryError::InvalidTransition);
            }
            let replay = match phase.phase() {
                DispatchPhase::OutcomeUnknown => facts.outbox_mut().authorize_replay(dispatch_id),
                DispatchPhase::Delivered => facts
                    .outbox_mut()
                    .authorize_replay_after_command_unknown(dispatch_id),
                DispatchPhase::Pending | DispatchPhase::InFlight => {
                    return Err(FleetDeliveryError::DeliveryOutcomeUnknown);
                }
            };
            if replay != ReplayOutcome::Authorized {
                return Err(FleetDeliveryError::DeliveryOutcomeUnknown);
            }
            match facts.command_ledger_mut().authorize_replay(command_id, at) {
                TransitionOutcome::Transitioned(_) => {
                    append_command_audit(facts, command_id, "fleet.delivery.replay", at)?;
                    Ok(FleetDeliveryOutcome::Replayed)
                }
                TransitionOutcome::Rejected(_) => Err(FleetDeliveryError::InvalidTransition),
                TransitionOutcome::NotFound => Err(FleetDeliveryError::CommandNotFound),
                TransitionOutcome::Unchanged(_) | TransitionOutcome::StaleAttempt(_) => {
                    Err(FleetDeliveryError::AttemptConflict)
                }
            }
        })
    }

    fn transact<T>(
        &mut self,
        mutation: impl FnOnce(&mut FleetFacts) -> Result<T, FleetDeliveryError>,
    ) -> Result<T, FleetDeliveryError> {
        let mut value = None;
        let mut error = None;
        let stored = self.store.transact(|facts| match mutation(facts) {
            Ok(result) => {
                value = Some(result);
                Ok(())
            }
            Err(rejection) => {
                error = Some(rejection);
                Err(StoreFault::RecoveryRequired)
            }
        });
        if let Some(error) = error {
            return Err(error);
        }
        stored.map_err(FleetDeliveryError::Store)?;
        Ok(value.expect("successful Fleet delivery operation returns a result"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum FleetLifecycleCorrelation {
    ConnectionProbe {
        id: ConnectionId,
    },
    EnvironmentDeployment {
        id: EnvironmentId,
        phase: PhaseKey,
    },
    EnvironmentDeletion {
        id: EnvironmentId,
        phase: PhaseKey,
    },
    ResourceProvisioning {
        id: ManagedResourceId,
        phase: PhaseKey,
    },
    ResourceDeletion {
        id: ManagedResourceId,
        phase: PhaseKey,
    },
}

fn lifecycle_correlation(
    facts: &FleetFacts,
    command_id: &CommandId,
) -> Result<Option<FleetLifecycleCorrelation>, FleetDeliveryError> {
    let mut matches = Vec::new();
    for connection in facts.connections() {
        if let ConnectionState::Probing {
            command_id: current,
        } = connection.state()
            && current == command_id
        {
            matches.push(FleetLifecycleCorrelation::ConnectionProbe {
                id: connection.id().clone(),
            });
        }
    }
    for environment in facts.environments() {
        match environment.state() {
            EnvironmentState::Deploying {
                command_id: current,
                phase,
            } if current == command_id => {
                matches.push(FleetLifecycleCorrelation::EnvironmentDeployment {
                    id: environment.id().clone(),
                    phase: phase.clone(),
                })
            }
            EnvironmentState::Deleting {
                command_id: current,
                phase,
            } if current == command_id => {
                matches.push(FleetLifecycleCorrelation::EnvironmentDeletion {
                    id: environment.id().clone(),
                    phase: phase.clone(),
                })
            }
            _ => {}
        }
    }
    for resource in facts.managed_resources() {
        match resource.state() {
            ManagedResourceState::Provisioning {
                command_id: current,
                phase,
            } if current == command_id => {
                matches.push(FleetLifecycleCorrelation::ResourceProvisioning {
                    id: resource.id().clone(),
                    phase: phase.clone(),
                })
            }
            ManagedResourceState::Deleting {
                command_id: current,
                phase,
            } if current == command_id => {
                matches.push(FleetLifecycleCorrelation::ResourceDeletion {
                    id: resource.id().clone(),
                    phase: phase.clone(),
                })
            }
            _ => {}
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        _ => Err(FleetDeliveryError::LifecycleCorrelationConflict),
    }
}

fn settle_lifecycle(
    facts: &mut FleetFacts,
    lifecycle: Option<&FleetLifecycleCorrelation>,
    command_id: &CommandId,
    result: &RuntimeAgentResult,
) -> Result<(), FleetDeliveryError> {
    let Some(lifecycle) = lifecycle else {
        return Ok(());
    };
    let completed_at = result.completed_at();
    match (lifecycle, result) {
        (
            FleetLifecycleCorrelation::ConnectionProbe { id },
            RuntimeAgentResult::Succeeded { .. },
        ) => facts
            .complete_connection_probe(id, command_id, ProbeOutcome::Ready, completed_at, None)
            .map(|_| ())
            .map_err(map_connection_error),
        (FleetLifecycleCorrelation::ConnectionProbe { id }, _) => facts
            .complete_connection_probe(
                id,
                command_id,
                ProbeOutcome::Unhealthy,
                completed_at,
                Some(lifecycle_failure_message(result)),
            )
            .map(|_| ())
            .map_err(map_connection_error),
        (
            FleetLifecycleCorrelation::EnvironmentDeployment { id, phase },
            RuntimeAgentResult::Succeeded { .. },
        ) => facts
            .complete_environment_deployment(id, command_id, phase, completed_at)
            .map(|_| ())
            .map_err(map_environment_error),
        (
            FleetLifecycleCorrelation::EnvironmentDeletion { id, phase },
            RuntimeAgentResult::Succeeded { .. },
        ) => facts
            .complete_environment_deletion(id, command_id, phase, completed_at)
            .map(|_| ())
            .map_err(map_environment_error),
        (
            FleetLifecycleCorrelation::ResourceProvisioning { id, phase },
            RuntimeAgentResult::Succeeded { .. },
        ) => facts
            .complete_resource_provisioning(id, command_id, phase, completed_at)
            .map(|_| ())
            .map_err(map_environment_error),
        (
            FleetLifecycleCorrelation::ResourceDeletion { id, phase },
            RuntimeAgentResult::Succeeded { .. },
        ) => facts
            .complete_resource_deletion(id, command_id, phase, completed_at)
            .map(|_| ())
            .map_err(map_environment_error),
        (FleetLifecycleCorrelation::EnvironmentDeployment { id, phase }, result) => facts
            .fail_environment_deployment(
                id,
                command_id,
                phase,
                lifecycle_failure_message(result),
                completed_at,
            )
            .map(|_| ())
            .map_err(map_environment_error),
        (FleetLifecycleCorrelation::EnvironmentDeletion { id, phase }, result) => facts
            .fail_environment_deletion(
                id,
                command_id,
                phase,
                lifecycle_failure_message(result),
                completed_at,
            )
            .map(|_| ())
            .map_err(map_environment_error),
        (FleetLifecycleCorrelation::ResourceProvisioning { id, phase }, result) => facts
            .fail_resource_provisioning(
                id,
                command_id,
                phase,
                lifecycle_failure_message(result),
                completed_at,
            )
            .map(|_| ())
            .map_err(map_environment_error),
        (FleetLifecycleCorrelation::ResourceDeletion { id, phase }, result) => facts
            .fail_resource_deletion(
                id,
                command_id,
                phase,
                lifecycle_failure_message(result),
                completed_at,
            )
            .map(|_| ())
            .map_err(map_environment_error),
    }
}

fn lifecycle_failure_message(result: &RuntimeAgentResult) -> String {
    match result {
        RuntimeAgentResult::Failed { .. } => "RuntimeAgent command failed".to_owned(),
        RuntimeAgentResult::Cancelled { .. } => "RuntimeAgent command was cancelled".to_owned(),
        RuntimeAgentResult::TimedOut { .. } => "RuntimeAgent command timed out".to_owned(),
        RuntimeAgentResult::Succeeded { .. } => unreachable!("success is handled separately"),
    }
}

fn map_topology_error(error: crate::store::FleetFactsError) -> FleetDeliveryError {
    match error {
        crate::store::FleetFactsError::TopologyMutation(_error) => {
            FleetDeliveryError::InvalidTransition
        }
        _ => FleetDeliveryError::InvalidTransition,
    }
}

fn map_connection_error(error: crate::store::FleetFactsError) -> FleetDeliveryError {
    match error {
        crate::store::FleetFactsError::Connection(error) => FleetDeliveryError::Connection(error),
        _ => FleetDeliveryError::InvalidTransition,
    }
}

fn map_environment_error(error: crate::store::FleetFactsError) -> FleetDeliveryError {
    match error {
        crate::store::FleetFactsError::Environment(error) => FleetDeliveryError::Environment(error),
        _ => FleetDeliveryError::InvalidTransition,
    }
}

fn delivery_phase(
    facts: &FleetFacts,
    dispatch_id: &DispatchId,
    attempt: &DispatchAttempt,
) -> Result<DispatchPhase, FleetDeliveryError> {
    let Some(record) = facts.outbox().record(dispatch_id) else {
        return Err(FleetDeliveryError::DispatchNotFound);
    };
    if record.attempt() == Some(attempt) {
        Ok(record.phase())
    } else {
        Err(FleetDeliveryError::AttemptConflict)
    }
}

fn append_command_audit(
    facts: &mut FleetFacts,
    command_id: &CommandId,
    event_name: &str,
    occurred_at: SystemTime,
) -> Result<(), FleetDeliveryError> {
    let command = facts
        .command_ledger()
        .record(command_id)
        .ok_or(FleetDeliveryError::CommandNotFound)?;
    let target = command.intent().target();
    let dispatch_agent_id = facts
        .outbox()
        .record_for_command(command_id)
        .map(|record| record.intent().agent_id().as_str().to_owned());
    let relations = crate::domain::audit::FleetAuditRelations::new(
        None,
        None,
        None,
        None,
        Some(target.node_id().as_str().to_owned()),
        dispatch_agent_id,
        target.runtime_id().map(|id| id.as_str().to_owned()),
        target.endpoint_id().map(|id| id.as_str().to_owned()),
        Some(command_id.as_str().to_owned()),
    )
    .ok_or(FleetDeliveryError::InvalidTransition)?;
    append_audit_with_relations(facts, event_name, occurred_at, relations)
}

fn append_audit_with_relations(
    facts: &mut FleetFacts,
    event_name: &str,
    occurred_at: SystemTime,
    relations: crate::domain::audit::FleetAuditRelations,
) -> Result<(), FleetDeliveryError> {
    let event = FleetAuditEvent::new(FleetAuditEventInput {
        event_name: event_name.to_owned(),
        occurred_at,
        message: None,
        metadata: Default::default(),
        relations,
    })
    .map_err(|_| FleetDeliveryError::InvalidTransition)?;
    let entry = FleetAuditEntry::try_new(
        facts
            .next_audit_sequence()
            .map_err(|_| FleetDeliveryError::InvalidTransition)?,
        event,
    )
    .map_err(|_| FleetDeliveryError::InvalidTransition)?;
    facts
        .append_audit(entry)
        .map_err(|_| FleetDeliveryError::InvalidTransition)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    use super::*;
    use crate::{
        domain::command::{CommandKind, CommandTarget, IdempotencyKey},
        domain::reachability::{
            ExternalRelayOrigin, LoopbackIngressListener, ReachabilityStatus, RelayAuthority,
            RelayAuthorityId, RelayBinding, RelayBindingId, RelayKind, RelayScheme,
        },
        domain::secret_ref::FleetSecretRef,
        domain::target::{
            DockerTargetConfig, FleetTargetConfig, FleetTargetSelector, TargetId, TargetKind,
        },
        domain::topology::NodeId,
    };
    use platform::endpoint::NativeAgentId;

    fn store_path() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "matcha-fleet-delivery-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root.join("facts.log")
    }

    fn owner() -> FleetDeliveryOwner {
        owner_at(store_path())
    }

    fn owner_at(path: PathBuf) -> FleetDeliveryOwner {
        let mut owner = FleetDeliveryOwner::open(path).unwrap();
        owner
            .put_target(
                TargetId::try_new("docker-a").unwrap(),
                FleetTargetConfig::Docker(
                    DockerTargetConfig::try_new(
                        "https://docker.example.test",
                        "runtime-agent-a",
                        "registry.example.test/runtime-agent:stable",
                        None,
                    )
                    .unwrap(),
                ),
            )
            .unwrap();
        owner
    }

    fn request(id: &str, key: &str, dispatch: &str, at: SystemTime) -> FleetDeliveryRequest {
        let command_id = CommandId::try_new(id).unwrap();
        let selector = FleetTargetSelector::new(
            TargetId::try_new("docker-a").unwrap(),
            1,
            TargetKind::Docker,
        );
        FleetDeliveryRequest::try_new(
            CommandIntent::new(
                command_id.clone(),
                IdempotencyKey::try_new(key).unwrap(),
                CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
                CommandKind::ProbeNode,
                at,
            ),
            DispatchIntent::for_target(
                DispatchId::try_new(dispatch).unwrap(),
                command_id,
                NativeAgentId::try_new("agent-1").unwrap(),
                selector,
            ),
        )
        .unwrap()
    }

    fn reachability(now: SystemTime) -> RuntimeAgentIngressReachabilityFacts {
        let authority = RelayAuthority::try_new(
            RelayAuthorityId::try_new("relay-authority-1").unwrap(),
            ExternalRelayOrigin::try_new(RelayScheme::Https, "relay.example.test", 443).unwrap(),
            RelayKind::ReverseProxy,
        );
        RuntimeAgentIngressReachabilityFacts::try_new(
            NativeAgentId::try_new("agent-1").unwrap(),
            RelayBinding::new(
                RelayBindingId::try_new("binding-1").unwrap(),
                authority,
                LoopbackIngressListener::try_new(34123).unwrap(),
            ),
            ReachabilityStatus::Reachable { verified_at: now },
            now,
            now + Duration::from_secs(60),
        )
        .unwrap()
    }

    #[test]
    fn target_configuration_survives_reopen_without_secret_material() {
        let path = store_path();
        let id = TargetId::try_new("docker-a").unwrap();
        let secret = FleetSecretRef::parse("remote-fleet://credentials/docker-token").unwrap();
        let config = FleetTargetConfig::Docker(
            DockerTargetConfig::try_new(
                "https://docker.example.test",
                "runtime-agent-a",
                "registry.example.test/runtime-agent:stable",
                Some(secret),
            )
            .unwrap(),
        );
        let sentinel = "docker-secret-material-sentinel";
        let first = {
            let mut owner = FleetDeliveryOwner::open(&path).unwrap();
            owner.put_target(id.clone(), config).unwrap()
        };
        assert_eq!(first.revision(), 1);
        assert_eq!(first.kind(), TargetKind::Docker);

        let reopened = FleetDeliveryOwner::open(&path).unwrap();
        let snapshot = reopened.facts().target_snapshot(&id).unwrap();
        assert_eq!(snapshot.revision(), 1);
        assert_eq!(snapshot.kind(), TargetKind::Docker);
        assert_eq!(
            format!("{:?}", reopened.facts().target_configuration(&id).unwrap()),
            "FleetTargetConfig(<redacted>)"
        );
        assert!(
            !fs::read(&path)
                .unwrap()
                .windows(sentinel.len())
                .any(|bytes| bytes == sentinel.as_bytes())
        );
    }

    #[test]
    fn submit_is_idempotent_and_begin_is_durable_before_an_external_effect() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        let input = request("command-1", "key-1", "dispatch-1", at);
        assert_eq!(
            owner.submit(input.clone(), at),
            Ok(FleetSubmitOutcome::Submitted)
        );
        assert_eq!(
            owner.submit(input, at),
            Ok(FleetSubmitOutcome::AlreadySubmitted)
        );
        let request = owner
            .begin_dispatch(&DispatchId::try_new("dispatch-1").unwrap(), at)
            .unwrap();
        assert_eq!(request.attempt().sequence(), 1);
        assert_eq!(
            owner
                .facts()
                .outbox()
                .record(&DispatchId::try_new("dispatch-1").unwrap())
                .unwrap()
                .phase(),
            DispatchPhase::InFlight
        );
        assert!(matches!(
            owner
                .facts()
                .command_ledger()
                .record(&CommandId::try_new("command-1").unwrap())
                .unwrap()
                .state(),
            CommandState::Queued { .. }
        ));
    }

    #[test]
    fn reachability_upsert_preserves_active_in_flight_dispatch() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        owner.begin_dispatch(&dispatch, at).unwrap();

        owner
            .upsert_runtime_agent_reachability(reachability(at), at)
            .unwrap();

        assert_eq!(
            owner.facts().outbox().record(&dispatch).unwrap().phase(),
            DispatchPhase::InFlight
        );
        assert_eq!(
            owner.begin_dispatch(&dispatch, at),
            Err(FleetDeliveryError::AlreadyInFlight)
        );
    }

    #[test]
    fn cold_restore_keeps_unknown_dispatch_out_of_pending_until_replay_is_authorized() {
        let at = SystemTime::UNIX_EPOCH;
        let path = store_path();
        let command_id = CommandId::try_new("command-replay").unwrap();
        let dispatch_id = DispatchId::try_new("dispatch-replay").unwrap();

        {
            let mut owner = owner_at(path.clone());
            owner
                .submit(
                    request("command-replay", "key-replay", "dispatch-replay", at),
                    at,
                )
                .unwrap();
            owner.begin_dispatch(&dispatch_id, at).unwrap();
        }

        let mut restored = FleetDeliveryOwner::open(path).unwrap();
        assert_eq!(
            restored.record_for_command(&command_id).unwrap().phase(),
            DispatchPhase::OutcomeUnknown
        );
        assert!(restored.pending_dispatches().next().is_none());

        assert_eq!(
            restored.authorize_replay(&command_id, &dispatch_id, at),
            Ok(FleetDeliveryOutcome::Replayed)
        );
        let pending = restored
            .pending_dispatches()
            .map(|record| record.intent().dispatch_id().as_str())
            .collect::<Vec<_>>();
        assert_eq!(pending, vec!["dispatch-replay"]);
        assert_eq!(
            restored.record_for_command(&command_id).unwrap().phase(),
            DispatchPhase::Pending
        );
        let replay = restored
            .begin_dispatch_for_command(&command_id, at)
            .unwrap();
        assert_eq!(replay.dispatch().dispatch_id(), &dispatch_id);
        assert_eq!(replay.attempt().sequence(), 2);
    }

    #[test]
    fn command_lookup_uses_durable_dispatch_identity_across_delivery_phases() {
        let at = SystemTime::UNIX_EPOCH;
        let command = CommandId::try_new("command-lookup").unwrap();
        let dispatch = DispatchId::try_new("dispatch-lookup").unwrap();
        let mut owner = owner();

        assert_eq!(owner.dispatch_id_for_command(&command), None);
        assert_eq!(owner.record_for_command(&command), None);
        assert_eq!(
            owner.begin_dispatch_for_command(&command, at),
            Err(FleetDeliveryError::CommandNotFound)
        );

        owner
            .submit(
                request("command-lookup", "key-lookup", "dispatch-lookup", at),
                at,
            )
            .unwrap();
        assert_eq!(owner.dispatch_id_for_command(&command), Some(&dispatch));
        assert_eq!(
            owner
                .record_for_command(&command)
                .map(|record| record.intent().dispatch_id()),
            Some(&dispatch)
        );
        assert_eq!(
            owner.record_for_command(&command).unwrap().phase(),
            DispatchPhase::Pending
        );

        let begun = owner.begin_dispatch_for_command(&command, at).unwrap();
        assert_eq!(begun.dispatch().dispatch_id(), &dispatch);
        assert_eq!(begun.attempt().sequence(), 1);
        assert_eq!(
            owner.record_for_command(&command).unwrap().phase(),
            DispatchPhase::InFlight
        );
        assert_eq!(
            owner.begin_dispatch_for_command(&command, at),
            Err(FleetDeliveryError::AlreadyInFlight)
        );

        assert_eq!(
            owner.mark_outcome_unknown(&dispatch, begun.attempt(), at),
            Ok(FleetDeliveryOutcome::Recorded)
        );
        assert_eq!(
            owner.record_for_command(&command).unwrap().phase(),
            DispatchPhase::OutcomeUnknown
        );
        assert_eq!(
            owner.begin_dispatch_for_command(&command, at),
            Err(FleetDeliveryError::InvalidTransition)
        );

        assert_eq!(
            owner.authorize_replay(&command, &dispatch, at),
            Ok(FleetDeliveryOutcome::Replayed)
        );
        let replay = owner.begin_dispatch_for_command(&command, at).unwrap();
        assert_eq!(replay.attempt().sequence(), 2);
        assert_eq!(
            owner.accept_dispatch(&dispatch, replay.attempt(), at),
            Ok(FleetDeliveryOutcome::Recorded)
        );
        assert_eq!(
            owner.record_for_command(&command).unwrap().phase(),
            DispatchPhase::Delivered
        );
        assert_eq!(
            owner.begin_dispatch_for_command(&command, at),
            Err(FleetDeliveryError::InvalidTransition)
        );
    }

    #[test]
    fn runtime_agent_result_settles_agent_command_ledger_and_outbox_atomically() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        owner
            .register_runtime_agent(RuntimeAgent::new(
                NativeAgentId::try_new("agent-1").unwrap(),
            ))
            .unwrap();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        let begun = owner.begin_dispatch(&dispatch, at).unwrap();
        let command_attempt = CommandAttempt::try_new(begun.attempt().sequence()).unwrap();
        let correlation = CommandCorrelation::new(
            CommandId::try_new("command-1").unwrap(),
            IdempotencyKey::try_new("key-1").unwrap(),
        );
        owner
            .register_runtime_agent_command(
                &NativeAgentId::try_new("agent-1").unwrap(),
                correlation.clone(),
                at,
                command_attempt.clone(),
                begun.attempt().clone(),
            )
            .unwrap();

        assert_eq!(
            owner.record_runtime_agent_result(
                &NativeAgentId::try_new("agent-1").unwrap(),
                &correlation,
                RuntimeAgentResult::Succeeded { completed_at: at },
                &command_attempt,
                begun.attempt(),
            ),
            Ok(RuntimeAgentReportOutcome::Recorded)
        );
        assert!(matches!(
            owner
                .facts()
                .command_ledger()
                .record(&CommandId::try_new("command-1").unwrap())
                .unwrap()
                .state(),
            CommandState::Succeeded { completed_at } if *completed_at == at
        ));
        assert_eq!(
            owner.facts().outbox().record(&dispatch).unwrap().phase(),
            DispatchPhase::Delivered
        );
        assert!(matches!(
            owner
                .facts()
                .runtime_agents()
                .next()
                .and_then(|agent| agent.command(&CommandId::try_new("command-1").unwrap()))
                .and_then(|command| command.result()),
            Some(RuntimeAgentResult::Succeeded { completed_at }) if *completed_at == at
        ));
    }

    #[test]
    fn dispatch_readback_lookup_is_source_backed_and_fences_stale_context() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        let agent_id = NativeAgentId::try_new("agent-1").unwrap();
        owner
            .register_runtime_agent(RuntimeAgent::new(agent_id.clone()))
            .unwrap();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        let dispatch_id = DispatchId::try_new("dispatch-1").unwrap();
        let begun = owner.begin_dispatch(&dispatch_id, at).unwrap();
        let correlation = CommandCorrelation::new(
            CommandId::try_new("command-1").unwrap(),
            IdempotencyKey::try_new("key-1").unwrap(),
        );
        owner
            .register_runtime_agent_command(
                &agent_id,
                correlation,
                at,
                begun.command_attempt(),
                begun.attempt().clone(),
            )
            .unwrap();

        assert!(
            owner
                .runtime_agent_command_for_dispatch(&begun)
                .unwrap()
                .is_some()
        );

        let stale = FleetDispatchRequest::try_new(
            begun.command().clone(),
            begun.dispatch().clone(),
            DispatchAttempt::try_new(2).unwrap(),
        )
        .unwrap();
        assert_eq!(
            owner.runtime_agent_command_for_dispatch(&stale),
            Err(FleetDeliveryError::DispatchReadback(
                FleetDispatchReadbackError::DispatchAttemptMismatch
            ))
        );

        let mismatched = FleetDispatchRequest::try_new(
            CommandIntent::new(
                CommandId::try_new("command-1").unwrap(),
                IdempotencyKey::try_new("different-key").unwrap(),
                begun.operation_target().clone(),
                begun.operation_kind(),
                at,
            ),
            begun.dispatch().clone(),
            begun.attempt().clone(),
        )
        .unwrap();
        assert_eq!(
            owner.runtime_agent_command_for_dispatch(&mismatched),
            Err(FleetDeliveryError::DispatchReadback(
                FleetDispatchReadbackError::CommandCorrelationMismatch
            ))
        );
    }

    #[test]
    fn accept_dispatch_converges_command_and_delivery_in_one_transaction() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        let command = CommandId::try_new("command-1").unwrap();
        let begun = owner.begin_dispatch(&dispatch, at).unwrap();

        assert_eq!(
            owner.accept_dispatch(&dispatch, begun.attempt(), at),
            Ok(FleetDeliveryOutcome::Recorded)
        );
        assert_eq!(
            owner.facts().outbox().record(&dispatch).unwrap().phase(),
            DispatchPhase::Delivered
        );
        assert!(matches!(
            owner
                .facts()
                .command_ledger()
                .record(&command)
                .unwrap()
                .state(),
            CommandState::Succeeded { completed_at } if *completed_at == at
        ));
        assert_eq!(owner.facts().audit_entries().len(), 3);
        assert_eq!(
            owner.accept_dispatch(&dispatch, begun.attempt(), at),
            Ok(FleetDeliveryOutcome::AlreadyRecorded)
        );
        assert_eq!(owner.facts().audit_entries().len(), 3);
    }

    #[test]
    fn accept_dispatch_fences_stale_attempt_without_partial_convergence() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        let command = CommandId::try_new("command-1").unwrap();
        owner.begin_dispatch(&dispatch, at).unwrap();
        let stale = DispatchAttempt::try_new(2).unwrap();

        assert_eq!(
            owner.accept_dispatch(&dispatch, &stale, at),
            Err(FleetDeliveryError::AttemptConflict)
        );
        assert_eq!(
            owner.facts().outbox().record(&dispatch).unwrap().phase(),
            DispatchPhase::InFlight
        );
        assert!(matches!(
            owner
                .facts()
                .command_ledger()
                .record(&command)
                .unwrap()
                .state(),
            CommandState::Queued { .. }
        ));
        assert_eq!(owner.facts().audit_entries().len(), 2);
    }

    #[test]
    fn reject_dispatch_converges_command_and_delivery_in_one_transaction() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        let command = CommandId::try_new("command-1").unwrap();
        let begun = owner.begin_dispatch(&dispatch, at).unwrap();

        assert_eq!(
            owner.reject_dispatch(&dispatch, begun.attempt(), at),
            Ok(FleetDeliveryOutcome::Recorded)
        );
        assert_eq!(
            owner.facts().outbox().record(&dispatch).unwrap().phase(),
            DispatchPhase::Delivered
        );
        assert_eq!(
            owner
                .facts()
                .command_ledger()
                .record(&command)
                .unwrap()
                .state(),
            &CommandState::Failed {
                completed_at: at,
                failure: CommandFailure::Rejected,
            }
        );
        assert_eq!(owner.facts().audit_entries().len(), 3);
        assert_eq!(
            owner.facts().audit_entries()[2].event().event_name(),
            "fleet.delivery.rejected"
        );
        assert_eq!(
            owner.reject_dispatch(&dispatch, begun.attempt(), at),
            Ok(FleetDeliveryOutcome::AlreadyRecorded)
        );
        assert_eq!(owner.facts().audit_entries().len(), 3);
    }

    #[test]
    fn reject_dispatch_fences_stale_attempt_without_partial_convergence() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        let command = CommandId::try_new("command-1").unwrap();
        owner.begin_dispatch(&dispatch, at).unwrap();
        let stale = DispatchAttempt::try_new(2).unwrap();

        assert_eq!(
            owner.reject_dispatch(&dispatch, &stale, at),
            Err(FleetDeliveryError::AttemptConflict)
        );
        assert_eq!(
            owner.facts().outbox().record(&dispatch).unwrap().phase(),
            DispatchPhase::InFlight
        );
        assert!(matches!(
            owner
                .facts()
                .command_ledger()
                .record(&command)
                .unwrap()
                .state(),
            CommandState::Queued { .. }
        ));
        assert_eq!(owner.facts().audit_entries().len(), 2);
    }

    #[test]
    fn begin_dispatch_rejects_a_missing_target_selector_before_claiming_delivery() {
        let at = SystemTime::UNIX_EPOCH;
        let mut owner = owner();
        let command_id = CommandId::try_new("command-1").unwrap();
        let request = FleetDeliveryRequest::try_new(
            CommandIntent::new(
                command_id.clone(),
                IdempotencyKey::try_new("key-1").unwrap(),
                CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
                CommandKind::ProbeNode,
                at,
            ),
            DispatchIntent::new(
                DispatchId::try_new("dispatch-1").unwrap(),
                command_id,
                NativeAgentId::try_new("agent-1").unwrap(),
            ),
        )
        .unwrap();
        owner.submit(request, at).unwrap();

        assert_eq!(
            owner.begin_dispatch(&DispatchId::try_new("dispatch-1").unwrap(), at),
            Err(FleetDeliveryError::DispatchRequest)
        );
        assert_eq!(
            owner
                .facts()
                .outbox()
                .record(&DispatchId::try_new("dispatch-1").unwrap())
                .unwrap()
                .phase(),
            DispatchPhase::Pending
        );
    }

    #[test]
    fn begin_dispatch_rejects_target_revision_drift_and_kind_drift() {
        let at = SystemTime::UNIX_EPOCH;
        let dispatch = DispatchId::try_new("dispatch-1").unwrap();
        let mut first_owner = owner();
        first_owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();
        first_owner
            .put_target(
                TargetId::try_new("docker-a").unwrap(),
                FleetTargetConfig::Docker(
                    DockerTargetConfig::try_new(
                        "https://docker.example.test",
                        "runtime-agent-b",
                        "registry.example.test/runtime-agent:new",
                        None,
                    )
                    .unwrap(),
                ),
            )
            .unwrap();
        assert_eq!(
            first_owner.begin_dispatch(&dispatch, at),
            Err(FleetDeliveryError::DispatchRequest)
        );

        let mut second_owner = owner();
        let command_id = CommandId::try_new("command-2").unwrap();
        let intent = FleetDeliveryRequest::try_new(
            CommandIntent::new(
                command_id.clone(),
                IdempotencyKey::try_new("key-2").unwrap(),
                CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
                CommandKind::ProbeNode,
                at,
            ),
            DispatchIntent::for_target(
                DispatchId::try_new("dispatch-2").unwrap(),
                command_id,
                NativeAgentId::try_new("agent-1").unwrap(),
                FleetTargetSelector::new(
                    TargetId::try_new("docker-a").unwrap(),
                    1,
                    TargetKind::Custom,
                ),
            ),
        )
        .unwrap();
        second_owner.submit(intent, at).unwrap();
        assert_eq!(
            second_owner.begin_dispatch(&DispatchId::try_new("dispatch-2").unwrap(), at),
            Err(FleetDeliveryError::DispatchRequest)
        );
    }

    #[test]
    fn delivery_audit_errors_and_durable_bytes_exclude_payload_like_sentinels() {
        let at = SystemTime::UNIX_EPOCH;
        let path = store_path();
        let mut owner = FleetDeliveryOwner::open(&path).unwrap();
        let sentinel = "credential-payload-sentinel";
        owner
            .submit(request("command-1", "key-1", "dispatch-1", at), at)
            .unwrap();

        let audit = format!("{:?}", owner.facts().audit_entries());
        let error = FleetDeliveryError::AttemptConflict;
        assert!(!audit.contains(sentinel));
        assert!(!format!("{error:?}").contains(sentinel));
        assert!(!error.to_string().contains(sentinel));
        assert!(
            !fs::read(&path)
                .unwrap()
                .windows(sentinel.len())
                .any(|bytes| bytes == sentinel.as_bytes())
        );
    }
}
