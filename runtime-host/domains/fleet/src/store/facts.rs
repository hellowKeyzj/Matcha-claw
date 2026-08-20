use std::{collections::BTreeMap, time::SystemTime};

use crate::{
    audit::FleetAuditEntry,
    command::{CommandId, CommandLedger, CommandRecord},
    connection::{
        ConnectionId, ConnectionMutation, ConnectionMutationError, ConnectionRecord,
        ConnectionStore, ProbeOutcome,
    },
    effect::{EffectIdentity, EffectLedger, EffectOperationOutcome, EffectRecord, PhaseKey},
    environment::{
        EnvironmentId, EnvironmentMutation, EnvironmentMutationError, EnvironmentRecord,
        EnvironmentStore, ManagedResourceId, ManagedResourceLifecycleContext,
        ManagedResourceMetadata, ManagedResourceMutation, ManagedResourceRecord,
    },
    lease::{Lease, LeaseBook, RestoreLeaseError},
    outbox::{Outbox, OutboxRecord},
    ports::{FleetDispatchReadbackError, FleetDispatchRequest},
    reachability::{
        RuntimeAgentIngressReachabilityFacts, RuntimeAgentReachabilityFactsSource,
        RuntimeAgentReachabilityOracle,
    },
    runtime_agent::{RuntimeAgent, RuntimeAgentCommand},
    secret_ref::FleetSecretRef,
    target::{
        FleetTargetConfig, FleetTargetStore, TargetEndpointBinding, TargetId, TargetSnapshot,
    },
    topology::{
        AgentObservation, CapabilitySync, EndpointObservation, EnrollmentRecord, FleetAccessFacts,
        FleetAccessFactsError, FleetTopologyFacts, IngressCredentialRecord, NodeId,
        NodeObservation, RuntimeId, RuntimeObservation, TopologyError, TopologyMutation,
        TopologyMutationError,
    },
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FleetFacts {
    command_ledger: CommandLedger,
    outbox: Outbox,
    secret_references: BTreeMap<String, FleetSecretRef>,
    audit_entries: Vec<FleetAuditEntry>,
    topology: FleetTopologyFacts,
    access: FleetAccessFacts,
    targets: FleetTargetStore,
    connections: ConnectionStore,
    environments: EnvironmentStore,
    effects: EffectLedger,
    runtime_agents: Vec<RuntimeAgent>,
    runtime_agent_reachability: Vec<RuntimeAgentIngressReachabilityFacts>,
    leases: LeaseBook<platform::endpoint::EndpointId>,
}

pub struct FleetFactsRestoreInput {
    pub commands: Vec<CommandRecord>,
    pub dispatches: Vec<OutboxRecord>,
    pub secret_references: Vec<FleetSecretRef>,
    pub audit_entries: Vec<FleetAuditEntry>,
    pub topology: FleetTopologyFacts,
    pub enrollments: Vec<EnrollmentRecord>,
    pub ingress_credentials: Vec<IngressCredentialRecord>,
    pub targets: Vec<(TargetId, u64, FleetTargetConfig)>,
    pub connections: Vec<ConnectionRecord>,
    pub environments: Vec<EnvironmentRecord>,
    pub managed_resources: Vec<ManagedResourceRecord>,
    pub effects: Vec<EffectRecord>,
    pub runtime_agents: Vec<RuntimeAgent>,
    pub runtime_agent_reachability: Vec<RuntimeAgentIngressReachabilityFacts>,
    pub leases: Vec<Lease<platform::endpoint::EndpointId>>,
    pub bindings: Vec<TargetEndpointBinding>,
}

impl FleetFacts {
    pub fn restore(input: FleetFactsRestoreInput) -> Result<Self, FleetFactsError> {
        let FleetFactsRestoreInput {
            commands,
            dispatches,
            secret_references,
            audit_entries,
            topology,
            enrollments,
            ingress_credentials,
            targets,
            connections,
            environments,
            managed_resources,
            effects,
            runtime_agents,
            runtime_agent_reachability,
            leases,
            bindings,
        } = input;
        let command_ledger =
            CommandLedger::restore(commands).map_err(FleetFactsError::CommandLedger)?;
        let outbox = Outbox::restore(dispatches).map_err(FleetFactsError::Outbox)?;
        if outbox.records().any(|record| {
            command_ledger
                .record(record.intent().command_id())
                .is_none()
        }) {
            return Err(FleetFactsError::UnknownOutboxCommand);
        }
        let mut references = BTreeMap::new();
        for reference in secret_references {
            if references
                .insert(reference.as_str().to_owned(), reference)
                .is_some()
            {
                return Err(FleetFactsError::DuplicateSecretReference);
            }
        }
        let audit_entries: Vec<_> = audit_entries
            .into_iter()
            .map(|entry| entry.redacted_for_commit())
            .collect();
        ensure_audit_entries(&audit_entries)?;
        let access = FleetAccessFacts::restore(&topology, enrollments, ingress_credentials)
            .map_err(FleetFactsError::Access)?;
        let targets = FleetTargetStore::restore(targets, bindings)
            .map_err(|_| FleetFactsError::InvalidTarget)?;
        let connections = ConnectionStore::restore(connections)
            .map_err(|_| FleetFactsError::InvalidConnections)?;
        let environments = EnvironmentStore::restore(environments, managed_resources)
            .map_err(|_| FleetFactsError::InvalidEnvironments)?;
        validate_topology_associations(&topology, &connections, &environments)?;
        let effects = EffectLedger::restore(effects).map_err(FleetFactsError::Effects)?;
        let leases = LeaseBook::restore(leases).map_err(FleetFactsError::Leases)?;
        let mut runtime_agent_records = Vec::new();
        for agent in runtime_agents {
            if runtime_agent_records
                .iter()
                .any(|current: &RuntimeAgent| current.id() == agent.id())
            {
                return Err(FleetFactsError::DuplicateRuntimeAgent);
            }
            runtime_agent_records.push(agent);
        }
        let mut reachability_records = Vec::new();
        for facts in runtime_agent_reachability {
            RuntimeAgentReachabilityOracle::validate_observation(&facts, SystemTime::now())
                .map_err(FleetFactsError::Reachability)?;
            if reachability_records
                .iter()
                .any(|current: &RuntimeAgentIngressReachabilityFacts| {
                    current.agent_id() == facts.agent_id()
                })
            {
                return Err(FleetFactsError::DuplicateRuntimeAgentReachability);
            }
            reachability_records.push(facts);
        }
        for (_, _, config) in targets.records() {
            for reference in config.secret_references() {
                references
                    .entry(reference.as_str().to_owned())
                    .or_insert_with(|| reference.clone());
            }
        }

        Ok(Self {
            command_ledger,
            outbox,
            secret_references: references,
            audit_entries,
            topology,
            access,
            targets,
            connections,
            environments,
            effects,
            runtime_agents: runtime_agent_records,
            runtime_agent_reachability: reachability_records,
            leases,
        })
    }

    pub fn command_ledger(&self) -> &CommandLedger {
        &self.command_ledger
    }

    pub fn outbox(&self) -> &Outbox {
        &self.outbox
    }

    pub fn dispatch_id_for_command(
        &self,
        command_id: &CommandId,
    ) -> Option<&crate::outbox::DispatchId> {
        self.outbox.dispatch_id_for_command(command_id)
    }

    pub fn record_for_command(&self, command_id: &CommandId) -> Option<&OutboxRecord> {
        self.outbox.record_for_command(command_id)
    }

    pub fn runtime_agents(&self) -> impl Iterator<Item = &RuntimeAgent> {
        self.runtime_agents.iter()
    }

    pub fn runtime_agent_reachability_facts(
        &self,
    ) -> impl Iterator<Item = &RuntimeAgentIngressReachabilityFacts> {
        self.runtime_agent_reachability.iter()
    }

    pub fn runtime_agent_reachability(
        &self,
        agent_id: &crate::runtime_agent::RuntimeAgentId,
    ) -> Option<&RuntimeAgentIngressReachabilityFacts> {
        self.runtime_agent_reachability
            .iter()
            .find(|facts| facts.agent_id() == agent_id)
    }

    pub(crate) fn runtime_agent(
        &self,
        id: &platform::endpoint::NativeAgentId,
    ) -> Option<&RuntimeAgent> {
        self.runtime_agents.iter().find(|agent| agent.id() == id)
    }

    pub(crate) fn runtime_agent_mut(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
    ) -> Option<&mut RuntimeAgent> {
        self.runtime_agents
            .iter_mut()
            .find(|agent| agent.id() == id)
    }

    pub fn runtime_agent_command_for_dispatch(
        &self,
        request: &FleetDispatchRequest,
    ) -> Result<Option<&RuntimeAgentCommand>, FleetDispatchReadbackError> {
        let dispatch = self
            .outbox
            .record(request.dispatch().dispatch_id())
            .ok_or(FleetDispatchReadbackError::DispatchNotFound)?;
        if dispatch.intent().command_id() != request.command_id() {
            return Err(FleetDispatchReadbackError::DispatchCommandMismatch);
        }
        if dispatch.intent().agent_id() != request.agent_id() {
            return Err(FleetDispatchReadbackError::DispatchAgentMismatch);
        }
        if dispatch.attempt() != Some(request.attempt()) {
            return Err(FleetDispatchReadbackError::DispatchAttemptMismatch);
        }

        let command = self
            .command_ledger
            .record(request.command_id())
            .ok_or(FleetDispatchReadbackError::CommandNotFound)?;
        if command.intent().idempotency_key() != request.command().idempotency_key() {
            return Err(FleetDispatchReadbackError::CommandCorrelationMismatch);
        }

        let Some(agent) = self.runtime_agent(request.agent_id()) else {
            return Ok(None);
        };
        let Some(runtime_command) = agent.command(request.command_id()) else {
            return Ok(None);
        };
        if runtime_command.correlation().idempotency_key() != request.command().idempotency_key()
            || runtime_command.correlation().command_id() != request.command_id()
        {
            return Err(FleetDispatchReadbackError::CommandCorrelationMismatch);
        }
        if runtime_command.command_attempt() != Some(request.command_attempt().sequence())
            || runtime_command.dispatch_attempt() != Some(request.attempt().sequence())
        {
            return Err(FleetDispatchReadbackError::RuntimeAgentAttemptMismatch);
        }
        Ok(Some(runtime_command))
    }

    pub(crate) fn insert_runtime_agent(
        &mut self,
        agent: RuntimeAgent,
    ) -> Result<(), FleetFactsError> {
        if self
            .runtime_agents
            .iter()
            .any(|current| current.id() == agent.id())
        {
            return Err(FleetFactsError::DuplicateRuntimeAgent);
        }
        self.runtime_agents.push(agent);
        Ok(())
    }

    pub fn leases(&self) -> &LeaseBook<platform::endpoint::EndpointId> {
        &self.leases
    }

    pub(crate) fn leases_mut(&mut self) -> &mut LeaseBook<platform::endpoint::EndpointId> {
        &mut self.leases
    }

    pub fn effects(&self) -> impl Iterator<Item = &EffectRecord> {
        self.effects.records()
    }

    pub(crate) fn effects_mut(&mut self) -> &mut EffectLedger {
        &mut self.effects
    }

    pub(crate) fn effect_operation(
        &mut self,
        identity: &EffectIdentity,
        operation: impl FnOnce(&mut EffectLedger, &EffectIdentity) -> EffectOperationOutcome,
    ) -> EffectOperationOutcome {
        operation(&mut self.effects, identity)
    }

    pub(crate) fn command_ledger_mut(&mut self) -> &mut CommandLedger {
        &mut self.command_ledger
    }

    pub(crate) fn outbox_mut(&mut self) -> &mut Outbox {
        &mut self.outbox
    }

    pub fn secret_references(&self) -> impl Iterator<Item = &FleetSecretRef> {
        self.secret_references.values()
    }

    pub fn audit_entries(&self) -> &[FleetAuditEntry] {
        &self.audit_entries
    }

    pub fn topology(&self) -> &FleetTopologyFacts {
        &self.topology
    }

    pub(crate) fn upsert_node(
        &mut self,
        observation: NodeObservation,
        now: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        validate_topology_association(
            observation.association(),
            &self.connections,
            &self.environments,
        )?;
        self.topology
            .upsert_node(observation, now)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn retire_node(
        &mut self,
        id: &NodeId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .retire_node(id, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn upsert_agent(
        &mut self,
        observation: AgentObservation,
        now: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        validate_topology_association(
            observation.association(),
            &self.connections,
            &self.environments,
        )?;
        self.topology
            .upsert_agent(observation, now)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn enroll_agent(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .enroll_agent(id, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn revoke_agent(
        &mut self,
        id: &platform::endpoint::NativeAgentId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .revoke_agent(id, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn upsert_runtime(
        &mut self,
        observation: RuntimeObservation,
        now: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        validate_topology_association(
            observation.association(),
            &self.connections,
            &self.environments,
        )?;
        self.topology
            .upsert_runtime(observation, now)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn begin_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .begin_runtime_start(id, command, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn complete_runtime_start(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .complete_runtime_start(id, command, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn begin_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: CommandId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .begin_runtime_stop(id, command, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn complete_runtime_stop(
        &mut self,
        id: &RuntimeId,
        command: &CommandId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .complete_runtime_stop(id, command, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn retire_runtime(
        &mut self,
        id: &RuntimeId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .retire_runtime(id, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn upsert_endpoint(
        &mut self,
        observation: EndpointObservation,
        now: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        validate_topology_association(
            observation.association(),
            &self.connections,
            &self.environments,
        )?;
        self.topology
            .upsert_endpoint(observation, now)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn drain_endpoint(
        &mut self,
        id: &platform::endpoint::EndpointId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .drain_endpoint(id, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn retire_endpoint(
        &mut self,
        id: &platform::endpoint::EndpointId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .retire_endpoint(id, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn begin_endpoint_probe(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: CommandId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .begin_endpoint_probe(id, command, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn complete_endpoint_probe(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: &CommandId,
        health: crate::topology::EndpointHealth,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .complete_endpoint_probe(id, command, health, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn begin_capability_sync(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: CommandId,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .begin_capability_sync(id, command, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn complete_capability_sync(
        &mut self,
        id: &platform::endpoint::EndpointId,
        command: &CommandId,
        sync: CapabilitySync,
        at: std::time::SystemTime,
    ) -> Result<TopologyMutation, FleetFactsError> {
        self.topology
            .complete_capability_sync(id, command, sync, at)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub fn access(&self) -> &FleetAccessFacts {
        &self.access
    }

    pub fn connections(&self) -> impl Iterator<Item = &ConnectionRecord> {
        self.connections.records()
    }
    pub fn environments(&self) -> impl Iterator<Item = &EnvironmentRecord> {
        self.environments.environments()
    }
    pub fn managed_resources(&self) -> impl Iterator<Item = &ManagedResourceRecord> {
        self.environments.managed_resources()
    }

    pub fn managed_resource_lifecycle_context(
        &self,
        id: Option<&ManagedResourceId>,
    ) -> ManagedResourceLifecycleContext {
        self.environments.managed_resource_lifecycle_context(id)
    }

    pub fn target_snapshot(&self, id: &TargetId) -> Option<TargetSnapshot> {
        self.targets.snapshot(id)
    }

    pub fn target_snapshots(&self) -> Vec<TargetSnapshot> {
        self.targets
            .records()
            .map(|(id, revision, config)| TargetSnapshot::new(id.clone(), revision, config.kind()))
            .collect()
    }

    pub fn target_configuration(&self, id: &TargetId) -> Option<&FleetTargetConfig> {
        self.targets.configuration(id)
    }

    pub fn target_binding(&self, id: &TargetId) -> Option<&TargetEndpointBinding> {
        self.targets.binding(id)
    }

    pub fn target_bindings(&self) -> impl Iterator<Item = &TargetEndpointBinding> {
        self.targets.bindings()
    }

    pub(crate) fn target_matches(
        &self,
        selector: &crate::target::FleetTargetSelector,
    ) -> Result<(), TargetMatchError> {
        let Some(snapshot) = self.targets.snapshot(selector.id()) else {
            return Err(TargetMatchError::NotFound);
        };
        if snapshot.revision() != selector.revision() {
            return Err(TargetMatchError::RevisionMismatch);
        }
        if snapshot.kind() != selector.expected_kind() {
            return Err(TargetMatchError::KindMismatch);
        }
        Ok(())
    }

    pub(crate) fn authenticate_or_enroll_ingress(
        &mut self,
        agent_id: &platform::endpoint::NativeAgentId,
        presented_ingress_hash: crate::topology::CredentialHash,
        enrollment_hash: Option<crate::topology::CredentialHash>,
        at: std::time::SystemTime,
    ) -> Result<Option<crate::topology::IngressCredentialIssue>, FleetFactsError> {
        self.access
            .authenticate_or_enroll_ingress(
                &self.topology,
                agent_id,
                presented_ingress_hash,
                enrollment_hash,
                at,
            )
            .map_err(FleetFactsError::Access)
    }

    pub fn next_audit_sequence(&self) -> Result<u64, FleetFactsError> {
        match self.audit_entries.last() {
            Some(entry) => entry
                .sequence()
                .checked_add(1)
                .ok_or(FleetFactsError::AuditSequenceOverflow),
            None => Ok(1),
        }
    }

    pub(crate) fn append_audit(&mut self, entry: FleetAuditEntry) -> Result<(), FleetFactsError> {
        let expected = self.next_audit_sequence()?;
        if entry.sequence() != expected {
            return Err(FleetFactsError::InvalidAuditSequence);
        }
        self.audit_entries.push(entry.redacted_for_commit());
        Ok(())
    }

    pub(crate) fn command_records(&self) -> impl Iterator<Item = &CommandRecord> {
        self.command_ledger.records()
    }

    pub(crate) fn dispatch_records(&self) -> impl Iterator<Item = &OutboxRecord> {
        self.outbox.records()
    }

    pub(crate) fn retain_secret_reference(&mut self, reference: FleetSecretRef) {
        self.secret_references
            .entry(reference.as_str().to_owned())
            .or_insert(reference);
    }

    pub(crate) fn put_target(
        &mut self,
        id: TargetId,
        config: FleetTargetConfig,
    ) -> Result<TargetSnapshot, FleetFactsError> {
        for reference in config.secret_references() {
            self.retain_secret_reference(reference.clone());
        }
        self.targets
            .put(id, config)
            .map_err(|_| FleetFactsError::InvalidTarget)
    }

    pub(crate) fn remove_target(&mut self, id: &TargetId) -> bool {
        self.targets.remove(id)
    }

    pub(crate) fn bind_target_endpoint(
        &mut self,
        binding: TargetEndpointBinding,
    ) -> Result<(), FleetFactsError> {
        let endpoint = self
            .topology
            .endpoint(binding.endpoint_id())
            .ok_or(FleetFactsError::InvalidTargetBinding)?;
        let runtime = self
            .topology
            .runtime(endpoint.runtime_id())
            .ok_or(FleetFactsError::InvalidTargetBinding)?;
        if runtime.node_id() != endpoint.node_id()
            || !self
                .topology
                .nodes()
                .iter()
                .any(|node| node.id() == endpoint.node_id())
        {
            return Err(FleetFactsError::InvalidTargetBinding);
        }
        self.targets
            .bind(binding)
            .map_err(|_| FleetFactsError::InvalidTargetBinding)
    }

    pub(crate) fn upsert_connection(
        &mut self,
        record: ConnectionRecord,
        now: std::time::SystemTime,
    ) -> Result<ConnectionMutation, FleetFactsError> {
        let references = record.secret_refs().values().cloned().collect::<Vec<_>>();
        let mutation = self
            .connections
            .upsert(record, now)
            .map_err(FleetFactsError::Connection)?;
        for reference in references {
            self.retain_secret_reference(reference);
        }
        Ok(mutation)
    }

    pub(crate) fn delete_connection(
        &mut self,
        id: &ConnectionId,
        now: std::time::SystemTime,
    ) -> Result<ConnectionMutation, FleetFactsError> {
        let associated = self
            .environments
            .environments()
            .any(|environment| environment.connection_id() == id)
            || self
                .environments
                .managed_resources()
                .any(|resource| resource.connection_id() == id);
        self.connections
            .delete_if_unassociated(id, now, |_| Ok::<bool, ()>(associated))
            .map_err(FleetFactsError::Connection)
    }

    pub(crate) fn begin_connection_probe(
        &mut self,
        id: &ConnectionId,
        command_id: CommandId,
        now: std::time::SystemTime,
    ) -> Result<ConnectionMutation, FleetFactsError> {
        self.connections
            .begin_probe(id, command_id, now)
            .map_err(FleetFactsError::Connection)
    }

    pub(crate) fn complete_connection_probe(
        &mut self,
        id: &ConnectionId,
        command_id: &CommandId,
        outcome: ProbeOutcome,
        observed_at: std::time::SystemTime,
        message: Option<String>,
    ) -> Result<ConnectionMutation, FleetFactsError> {
        self.connections
            .complete_probe(id, command_id, outcome, observed_at, message)
            .map_err(FleetFactsError::Connection)
    }

    pub(crate) fn register_environment(
        &mut self,
        record: EnvironmentRecord,
        now: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        let references = record.secret_refs().values().cloned().collect::<Vec<_>>();
        let mutation = self
            .environments
            .register_environment(record, now)
            .map_err(FleetFactsError::Environment)?;
        for reference in references {
            self.retain_secret_reference(reference);
        }
        Ok(mutation)
    }

    pub(crate) fn start_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        self.environments
            .start_deployment(id, command_id, phase, now)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn complete_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        self.environments
            .complete_deployment(id, command_id, phase, ready_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn fail_environment_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        self.environments
            .fail_deployment(id, command_id, phase, message, failed_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn start_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        self.environments
            .start_deletion(id, command_id, phase, now)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn complete_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        self.environments
            .complete_deletion(id, command_id, phase, deleted_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn fail_environment_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: std::time::SystemTime,
    ) -> Result<EnvironmentMutation, FleetFactsError> {
        self.environments
            .fail_deletion(id, command_id, phase, message, failed_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn register_managed_resource(
        &mut self,
        resource: ManagedResourceRecord,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .register_managed_resource(resource)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn refresh_observed_managed_resource(
        &mut self,
        id: &ManagedResourceId,
        connection_id: &ConnectionId,
        environment_id: &EnvironmentId,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .refresh_observed_managed_resource(
                id,
                connection_id,
                environment_id,
                metadata,
                observed_at,
            )
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn associate_managed_resource(
        &mut self,
        connection_id: &ConnectionId,
        environment_id: &EnvironmentId,
        managed_resource_id: ManagedResourceId,
    ) -> Result<TopologyMutation, FleetFactsError> {
        let resource = self
            .environments
            .managed_resource(&managed_resource_id)
            .ok_or(FleetFactsError::InvalidTopologyAssociation)?;
        if resource.connection_id() != connection_id || resource.environment_id() != environment_id
        {
            return Err(FleetFactsError::InvalidTopologyAssociation);
        }
        self.topology
            .associate_managed_resource(connection_id, environment_id, managed_resource_id)
            .map_err(FleetFactsError::TopologyMutation)
    }

    pub(crate) fn cleanup_resource_ids(
        &self,
        environment_id: &EnvironmentId,
    ) -> Result<Vec<ManagedResourceId>, FleetFactsError> {
        self.environments
            .cleanup_resource_ids(environment_id)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn start_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .start_resource_provisioning(id, command_id, phase, now)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn fail_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .fail_resource_provisioning(id, command_id, phase, message, failed_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn complete_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        observed_at: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .complete_resource_provisioning(id, command_id, phase, observed_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn materialize_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        metadata: ManagedResourceMetadata,
        observed_at: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .materialize_resource_provisioning(id, command_id, phase, metadata, observed_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn start_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .start_resource_deletion(id, command_id, phase, now)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn complete_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .complete_resource_deletion(id, command_id, phase, deleted_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn fail_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: std::time::SystemTime,
    ) -> Result<ManagedResourceMutation, FleetFactsError> {
        self.environments
            .fail_resource_deletion(id, command_id, phase, message, failed_at)
            .map_err(FleetFactsError::Environment)
    }

    pub(crate) fn target_records(
        &self,
    ) -> impl Iterator<Item = (&TargetId, u64, &FleetTargetConfig)> {
        self.targets.records()
    }

    pub(crate) fn recover_interrupted_deliveries(&mut self) {
        let interrupted = self
            .outbox
            .records()
            .filter(|record| record.phase() == crate::outbox::DispatchPhase::OutcomeUnknown)
            .map(|record| {
                (
                    record.intent().dispatch_id().clone(),
                    record.intent().command_id().clone(),
                    record.attempt().cloned(),
                )
            })
            .collect::<Vec<_>>();
        for (dispatch_id, command_id, dispatch_attempt) in interrupted {
            let Some(dispatch_attempt) = dispatch_attempt else {
                continue;
            };
            let _ = self.outbox.recover_interrupted_delivery(&dispatch_id);
            let Ok(command_attempt) =
                crate::command::CommandAttempt::try_new(dispatch_attempt.sequence())
            else {
                continue;
            };
            let observed_at = self
                .command_ledger
                .record(&command_id)
                .map(crate::command::CommandRecord::updated_at)
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let _ = self.command_ledger.mark_outcome_unknown(
                &command_id,
                &command_attempt,
                observed_at,
            );
        }
    }
}

fn validate_topology_associations(
    topology: &FleetTopologyFacts,
    connections: &ConnectionStore,
    environments: &EnvironmentStore,
) -> Result<(), FleetFactsError> {
    for association in topology
        .nodes()
        .iter()
        .map(|item| item.association())
        .chain(topology.agents().iter().map(|item| item.association()))
        .chain(topology.runtimes().iter().map(|item| item.association()))
        .chain(topology.endpoints().iter().map(|item| item.association()))
    {
        validate_topology_association(association, connections, environments)?;
    }
    Ok(())
}

fn validate_topology_association(
    association: &crate::topology::TopologyAssociation,
    connections: &ConnectionStore,
    environments: &EnvironmentStore,
) -> Result<(), FleetFactsError> {
    let environment = association
        .environment_id()
        .and_then(|id| environments.environment(id));
    let resource = association
        .managed_resource_id()
        .and_then(|id| environments.managed_resource(id));
    let valid = association
        .connection_id()
        .is_none_or(|id| connections.record(id).is_some())
        && association
            .environment_id()
            .is_none_or(|_| environment.is_some())
        && association
            .managed_resource_id()
            .is_none_or(|_| resource.is_some())
        && association.connection_id().is_none_or(|id| {
            environment.is_none_or(|record| record.connection_id() == id)
                && resource.is_none_or(|record| record.connection_id() == id)
        })
        && association
            .environment_id()
            .is_none_or(|id| resource.is_none_or(|record| record.environment_id() == id));
    valid
        .then_some(())
        .ok_or(FleetFactsError::InvalidTopologyAssociation)
}

fn ensure_audit_entries(entries: &[FleetAuditEntry]) -> Result<(), FleetFactsError> {
    for (index, entry) in entries.iter().enumerate() {
        let expected = u64::try_from(index)
            .ok()
            .and_then(|index| index.checked_add(1))
            .ok_or(FleetFactsError::AuditSequenceOverflow)?;
        if entry.sequence() != expected {
            return Err(FleetFactsError::InvalidAuditSequence);
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TargetMatchError {
    NotFound,
    RevisionMismatch,
    KindMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FleetFactsError {
    CommandLedger(crate::command::RestoreLedgerError),
    Outbox(crate::outbox::RestoreError),
    UnknownOutboxCommand,
    DuplicateSecretReference,
    Topology(TopologyError),
    TopologyMutation(TopologyMutationError),
    Access(FleetAccessFactsError),
    InvalidTarget,
    InvalidTargetBinding,
    InvalidConnections,
    InvalidEnvironments,
    InvalidTopologyAssociation,
    Effects(crate::effect::RestoreEffectError),
    Leases(RestoreLeaseError),
    DuplicateRuntimeAgent,
    DuplicateRuntimeAgentReachability,
    Reachability(crate::reachability::ReachabilityError),
    Connection(ConnectionMutationError),
    Environment(EnvironmentMutationError),
    InvalidAuditSequence,
    AuditSequenceOverflow,
}

impl RuntimeAgentReachabilityFactsSource for FleetFacts {
    fn runtime_agent_reachability(
        &self,
        agent_id: &crate::runtime_agent::RuntimeAgentId,
    ) -> Option<&RuntimeAgentIngressReachabilityFacts> {
        self.runtime_agent_reachability(agent_id)
    }
}
