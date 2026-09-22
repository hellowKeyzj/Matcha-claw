use super::*;

pub(crate) fn encode_frame(epoch: u64, facts: &FleetFacts) -> Result<Vec<u8>, StoreFault> {
    encode_frame_payload(epoch, encode_facts(facts)?)
}

#[cfg(test)]
pub(crate) fn encode_v5_frame(epoch: u64, facts: &FleetFacts) -> Result<Vec<u8>, StoreFault> {
    encode_frame_payload(epoch, encode_facts_v5(facts)?)
}

fn encode_frame_payload(epoch: u64, payload: Vec<u8>) -> Result<Vec<u8>, StoreFault> {
    if payload.len() > MAX_FACTS_BYTES {
        return Err(StoreFault::RecordTooLarge);
    }
    let checksum = checksum(&payload);
    let payload_len = u32::try_from(payload.len()).map_err(|_| StoreFault::RecordTooLarge)?;
    let mut frame = Vec::with_capacity(1 + FRAME_METADATA_LEN + payload.len());
    frame.push(FRAME_MARKER);
    frame.extend_from_slice(&epoch.to_le_bytes());
    frame.extend_from_slice(&payload_len.to_le_bytes());
    frame.extend_from_slice(&checksum.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

#[cfg(test)]
fn encode_facts_v5(facts: &FleetFacts) -> Result<Vec<u8>, StoreFault> {
    let mut output = Vec::new();
    push_count(&mut output, facts.command_records().count())?;
    for record in facts.command_records() {
        encode_command_record(&mut output, record)?;
    }
    push_count(&mut output, facts.dispatch_records().count())?;
    for record in facts.dispatch_records() {
        encode_outbox_record_v5(&mut output, record)?;
    }
    push_count(&mut output, facts.secret_references().count())?;
    for reference in facts.secret_references() {
        push_string(&mut output, reference.as_str())?;
    }
    push_count(&mut output, facts.audit_entries().len())?;
    for entry in facts.audit_entries() {
        output.extend_from_slice(&entry.sequence().to_le_bytes());
        encode_audit_event(&mut output, entry.event())?;
    }
    encode_topology(&mut output, facts.topology(), false)?;
    encode_access(&mut output, facts)?;
    encode_targets(&mut output, facts, false, false)?;
    Ok(output)
}

fn encode_facts(facts: &FleetFacts) -> Result<Vec<u8>, StoreFault> {
    let mut output = Vec::new();
    push_count(&mut output, facts.command_records().count())?;
    for record in facts.command_records() {
        encode_command_record(&mut output, record)?;
    }
    push_count(&mut output, facts.dispatch_records().count())?;
    for record in facts.dispatch_records() {
        encode_outbox_record(&mut output, record)?;
    }
    push_count(&mut output, facts.secret_references().count())?;
    for reference in facts.secret_references() {
        push_string(&mut output, reference.as_str())?;
    }
    push_count(&mut output, facts.audit_entries().len())?;
    for entry in facts.audit_entries() {
        output.extend_from_slice(&entry.sequence().to_le_bytes());
        encode_audit_event(&mut output, entry.event())?;
    }
    encode_topology(&mut output, facts.topology(), true)?;
    encode_access(&mut output, facts)?;
    encode_targets(&mut output, facts, true, true)?;
    encode_target_bindings(&mut output, facts)?;
    encode_connections(&mut output, facts)?;
    encode_environments(&mut output, facts)?;
    encode_effects(&mut output, facts)?;
    encode_runtime_agents(&mut output, facts)?;
    encode_leases(&mut output, facts)?;
    encode_runtime_agent_reachability(&mut output, facts)?;
    Ok(output)
}

fn relay_scheme_tag(scheme: RelayScheme) -> u8 {
    match scheme {
        RelayScheme::Http => 0,
        RelayScheme::Https => 1,
    }
}

fn relay_kind_tag(kind: RelayKind) -> u8 {
    match kind {
        RelayKind::ReverseProxy => 0,
        RelayKind::OutboundTunnel => 1,
        RelayKind::ManagedRelay => 2,
    }
}

fn encode_reachability_status(
    output: &mut Vec<u8>,
    status: ReachabilityStatus,
) -> Result<(), StoreFault> {
    match status {
        ReachabilityStatus::Pending { observed_at } => {
            output.push(0);
            push_system_time(output, observed_at)?;
        }
        ReachabilityStatus::Reachable { verified_at } => {
            output.push(1);
            push_system_time(output, verified_at)?;
        }
        ReachabilityStatus::Unreachable { observed_at } => {
            output.push(2);
            push_system_time(output, observed_at)?;
        }
    }
    Ok(())
}

fn encode_runtime_agent_reachability(
    output: &mut Vec<u8>,
    facts: &FleetFacts,
) -> Result<(), StoreFault> {
    push_count(output, facts.runtime_agent_reachability_facts().count())?;
    for record in facts.runtime_agent_reachability_facts() {
        push_string(output, record.agent_id().as_str())?;
        push_string(output, record.binding().id().as_str())?;
        push_string(output, record.binding().authority().id().as_str())?;
        output.push(relay_scheme_tag(
            record.binding().authority().origin().scheme(),
        ));
        push_string(output, record.binding().authority().origin().host())?;
        output.extend_from_slice(&record.binding().authority().origin().port().to_le_bytes());
        output.push(relay_kind_tag(record.binding().authority().kind()));
        output.extend_from_slice(&record.binding().listener().port().to_le_bytes());
        encode_reachability_status(output, record.status())?;
        push_system_time(output, record.observed_at())?;
        push_system_time(output, record.expires_at())?;
    }
    Ok(())
}

fn lease_owner_kind_tag(kind: LeaseOwnerKind) -> u8 {
    match kind {
        LeaseOwnerKind::ManualOperation => 0,
        LeaseOwnerKind::RuntimeStart => 1,
        LeaseOwnerKind::Session => 2,
        LeaseOwnerKind::TeamRun => 3,
    }
}

fn encode_leases(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.leases().leases().count())?;
    for lease in facts.leases().leases() {
        push_string(output, lease.id().as_str())?;
        push_string(output, lease.endpoint().as_str())?;
        output.push(lease_owner_kind_tag(lease.owner().kind()));
        push_string(output, lease.owner().id())?;
        push_system_time(output, lease.acquired_at())?;
        match lease.state() {
            LeaseState::Active { expires_at } => {
                output.push(0);
                push_system_time(output, expires_at)?;
            }
            LeaseState::Released { released_at } => {
                output.push(1);
                push_system_time(output, released_at)?;
            }
            LeaseState::Expired { expired_at } => {
                output.push(2);
                push_system_time(output, expired_at)?;
            }
        }
    }
    Ok(())
}

fn encode_runtime_agents(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.runtime_agents().count())?;
    for agent in facts.runtime_agents() {
        push_string(output, agent.id().as_str())?;
        match agent.last_heartbeat() {
            Some(heartbeat) => {
                output.push(1);
                push_system_time(output, heartbeat.observed_at())?;
                output.push(runtime_agent_status_tag(heartbeat.status()));
                push_count(output, heartbeat.runtime_ids().len())?;
                for runtime_id in heartbeat.runtime_ids() {
                    push_string(output, runtime_id.as_str())?;
                }
                push_optional_string(output, heartbeat.message().map(|m| m.as_str()))?;
            }
            None => output.push(0),
        }
        push_count(output, agent.commands().count())?;
        for command in agent.commands() {
            push_string(output, command.correlation().command_id().as_str())?;
            push_string(output, command.correlation().idempotency_key().as_str())?;
            output.push(runtime_agent_progress_state_tag(command.progress().state()));
            push_optional_string(
                output,
                command.progress().phase().map(|value| value.as_str()),
            )?;
            push_optional_string(
                output,
                command.progress().message().map(|value| value.as_str()),
            )?;
            match command.progress().percent() {
                Some(value) => {
                    output.push(1);
                    output.push(value);
                }
                None => output.push(0),
            }
            push_optional_runtime_agent_result(output, command.result())?;
            push_system_time(output, command.updated_at())?;
            push_optional_u64(output, command.command_attempt());
            push_optional_u64(output, command.dispatch_attempt());
        }
    }
    Ok(())
}

fn encode_effects(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.effects().count())?;
    for effect in facts.effects() {
        push_string(output, effect.operation_id().as_str())?;
        push_string(output, effect.phase_key().as_str())?;
        push_string(output, effect.target().id().as_str())?;
        output.extend_from_slice(&effect.target().revision().to_le_bytes());
        output.push(target_kind_tag(effect.target().expected_kind()));
        output.extend_from_slice(&effect.desired_revision().to_le_bytes());
        output.push(effect_provider_kind_tag(effect.provider_kind()));
        push_system_time(output, effect.deadline())?;
        match effect.attempt() {
            Some(attempt) => {
                output.push(1);
                output.extend_from_slice(&attempt.sequence().to_le_bytes());
            }
            None => output.push(0),
        }
        output.push(effect_state_tag(effect.state()));
        match effect.last_outcome() {
            Some(outcome) => {
                output.push(1);
                output.push(receipt_outcome_tag(outcome));
            }
            None => output.push(0),
        }
    }
    Ok(())
}

fn encode_connections(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.connections().count())?;
    for record in facts.connections() {
        push_string(output, record.id().as_str())?;
        output.push(connection_kind_tag(record.kind()));
        push_string(output, record.display_name())?;
        push_optional_string(output, record.endpoint())?;
        push_count(output, record.labels().len())?;
        for label in record.labels() {
            push_string(output, label)?;
        }
        output.push(u8::from(record.enabled()));
        encode_string_map(output, record.public_config())?;
        encode_secret_map(output, record.secret_refs())?;
        encode_connection_state(output, record.state())?;
        push_system_time(output, record.created_at())?;
        push_system_time(output, record.updated_at())?;
    }
    Ok(())
}
fn encode_environments(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.environments().count())?;
    for record in facts.environments() {
        push_string(output, record.id().as_str())?;
        push_string(output, record.connection_id().as_str())?;
        push_string(output, record.display_name())?;
        output.push(environment_kind_tag(record.kind()));
        push_count(output, record.labels().len())?;
        for label in record.labels() {
            push_string(output, label)?;
        }
        output.push(u8::from(record.enabled()));
        encode_string_map(output, record.public_config())?;
        encode_secret_map(output, record.secret_refs())?;
        encode_environment_state(output, record.state())?;
        push_count(output, record.managed_resource_ids().len())?;
        for id in record.managed_resource_ids() {
            push_string(output, id.as_str())?;
        }
        push_system_time(output, record.created_at())?;
        push_system_time(output, record.updated_at())?;
    }
    push_count(output, facts.managed_resources().count())?;
    for r in facts.managed_resources() {
        push_string(output, r.id().as_str())?;
        push_string(output, r.connection_id().as_str())?;
        push_string(output, r.environment_id().as_str())?;
        output.push(provider_kind_tag(r.provider()));
        output.push(resource_kind_tag(r.kind()));
        push_string(output, r.remote_resource_id())?;
        output.push(ownership_tag(r.ownership()));
        output.push(cleanup_policy_tag(r.cleanup_policy()));
        encode_resource_state(output, r.state())?;
        output.push(u8::from(r.is_tombstone()));
        push_system_time(output, r.created_at())?;
        push_system_time(output, r.updated_at())?;
        encode_optional_resource_metadata(output, r.metadata())?;
    }
    Ok(())
}

fn encode_optional_resource_metadata(
    output: &mut Vec<u8>,
    metadata: Option<&ManagedResourceMetadata>,
) -> Result<(), StoreFault> {
    match metadata {
        None => output.push(0),
        Some(metadata) => {
            output.push(1);
            push_string(output, metadata.display_name())?;
            encode_string_map(output, metadata.labels())?;
            push_count(output, metadata.remote_refs().len())?;
            for reference in metadata.remote_refs() {
                output.push(provider_kind_tag(reference.provider()));
                output.push(resource_kind_tag(reference.kind()));
                push_string(output, reference.remote_resource_id())?;
                push_optional_string(output, reference.namespace())?;
                push_optional_string(output, reference.name())?;
            }
            encode_string_map(output, metadata.ownership_evidence())?;
            match metadata.association() {
                ManagedResourceAssociation::DockerContainer { name } => {
                    output.push(0);
                    push_string(output, name)?;
                }
                ManagedResourceAssociation::KubernetesWorkload {
                    namespace,
                    deployment_name,
                    service_name,
                } => {
                    output.push(1);
                    push_string(output, namespace)?;
                    push_string(output, deployment_name)?;
                    push_string(output, service_name)?;
                }
            }
            push_system_time(output, metadata.observed_at())?;
        }
    }
    Ok(())
}
fn encode_string_map(
    output: &mut Vec<u8>,
    map: &std::collections::BTreeMap<String, String>,
) -> Result<(), StoreFault> {
    push_count(output, map.len())?;
    for (k, v) in map {
        push_string(output, k)?;
        push_string(output, v)?;
    }
    Ok(())
}
fn encode_secret_map(
    output: &mut Vec<u8>,
    map: &std::collections::BTreeMap<String, FleetSecretRef>,
) -> Result<(), StoreFault> {
    push_count(output, map.len())?;
    for (k, v) in map {
        push_string(output, k)?;
        push_string(output, v.as_str())?;
    }
    Ok(())
}

fn encode_topology(
    output: &mut Vec<u8>,
    topology: &FleetTopologyFacts,
    with_lifecycle: bool,
) -> Result<(), StoreFault> {
    push_count(output, topology.nodes().len())?;
    for node in topology.nodes() {
        push_string(output, node.id().as_str())?;
        encode_topology_association(output, node.association())?;
        encode_node_health(output, node.health())?;
        encode_observation_metadata(output, node.metadata())?;
    }
    push_count(output, topology.agents().len())?;
    for agent in topology.agents() {
        push_string(output, agent.id().as_str())?;
        push_string(output, agent.node_id().as_str())?;
        encode_topology_association(output, agent.association())?;
        encode_observation_metadata(output, agent.metadata())?;
    }
    push_count(output, topology.runtimes().len())?;
    for runtime in topology.runtimes() {
        push_string(output, runtime.id().as_str())?;
        push_string(output, runtime.node_id().as_str())?;
        push_optional_string(output, runtime.agent_id().map(NativeAgentId::as_str))?;
        encode_topology_association(output, runtime.association())?;
        output.push(runtime_kind_tag(runtime.kind()));
        encode_runtime_state(output, runtime.state())?;
        encode_observation_metadata(output, runtime.metadata())?;
    }
    push_count(output, topology.endpoints().len())?;
    for endpoint in topology.endpoints() {
        push_string(output, endpoint.id().as_str())?;
        push_string(output, endpoint.node_id().as_str())?;
        push_string(output, endpoint.runtime_id().as_str())?;
        encode_topology_association(output, endpoint.association())?;
        output.push(endpoint_health_tag(endpoint.health()));
        push_count(output, endpoint.supported_capabilities().len())?;
        for (capability, availability) in endpoint
            .supported_capabilities()
            .iter()
            .zip(endpoint.availability())
        {
            push_string(output, capability.id().as_str())?;
            output.push(capability_scope_tag(capability.scope()));
            output.push(capability_availability_tag(*availability));
        }
        encode_observation_metadata(output, endpoint.metadata())?;
    }
    if !with_lifecycle {
        return Ok(());
    }
    push_count(output, topology.retired_nodes().count())?;
    for (node_id, retired_at) in topology.retired_nodes() {
        push_string(output, node_id.as_str())?;
        push_system_time(output, *retired_at)?;
    }
    push_count(output, topology.enrolled_agents().count())?;
    for (agent_id, enrolled_at) in topology.enrolled_agents() {
        push_string(output, agent_id)?;
        push_system_time(output, enrolled_at)?;
    }
    push_count(output, topology.revoked_agents().count())?;
    for (agent_id, revoked_at) in topology.revoked_agents() {
        push_string(output, agent_id)?;
        push_system_time(output, revoked_at)?;
    }
    push_count(output, topology.runtime_commands().count())?;
    for (runtime_id, pending) in topology.runtime_commands() {
        push_string(output, runtime_id.as_str())?;
        output.push(match pending.kind() {
            crate::domain::topology::PendingRuntimeCommandKind::Start => 0,
            crate::domain::topology::PendingRuntimeCommandKind::Stop => 1,
        });
        push_string(output, pending.command_id().as_str())?;
    }
    push_count(output, topology.endpoint_commands().count())?;
    for (endpoint_id, pending) in topology.endpoint_commands() {
        push_string(output, endpoint_id)?;
        output.push(match pending.kind() {
            crate::domain::topology::PendingEndpointCommandKind::Probe => 0,
            crate::domain::topology::PendingEndpointCommandKind::CapabilitySync => 1,
        });
        push_string(output, pending.command_id().as_str())?;
    }
    Ok(())
}

fn encode_access(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.access().enrollments().count())?;
    for enrollment in facts.access().enrollments() {
        push_string(output, enrollment.agent_id().as_str())?;
        push_string(output, enrollment.credential_hash().as_str())?;
        push_system_time(output, enrollment.issued_at())?;
        push_system_time(output, enrollment.expires_at())?;
        push_optional_system_time(output, enrollment.consumed_at())?;
    }
    push_count(output, facts.access().ingress_credentials().count())?;
    for credential in facts.access().ingress_credentials() {
        push_string(output, credential.agent_id().as_str())?;
        push_string(output, credential.credential_hash().as_str())?;
        push_system_time(output, credential.issued_at())?;
        push_optional_system_time(output, credential.revoked_at())?;
    }
    Ok(())
}

fn encode_targets(
    output: &mut Vec<u8>,
    facts: &FleetFacts,
    with_terminal: bool,
    with_runtime_agent: bool,
) -> Result<(), StoreFault> {
    push_count(output, facts.target_records().count())?;
    for (id, revision, config) in facts.target_records() {
        push_string(output, id.as_str())?;
        output.extend_from_slice(&revision.to_le_bytes());
        encode_target_config(output, config, with_terminal, with_runtime_agent)?;
    }
    Ok(())
}

fn encode_target_bindings(output: &mut Vec<u8>, facts: &FleetFacts) -> Result<(), StoreFault> {
    push_count(output, facts.target_bindings().count())?;
    for binding in facts.target_bindings() {
        push_string(output, binding.target_id().as_str())?;
        push_string(output, binding.endpoint_id().as_str())?;
        output.extend_from_slice(&binding.target_revision().to_le_bytes());
        push_system_time(output, binding.observed_at())?;
    }
    Ok(())
}

fn encode_target_config(
    output: &mut Vec<u8>,
    config: &FleetTargetConfig,
    with_terminal: bool,
    with_runtime_agent: bool,
) -> Result<(), StoreFault> {
    match config {
        FleetTargetConfig::Docker(config) => {
            output.push(0);
            push_string(output, config.endpoint())?;
            push_string(output, config.container_name())?;
            push_string(output, config.image())?;
            push_optional_secret_reference(output, config.bearer_token())?;
            if with_runtime_agent {
                push_optional_runtime_agent_endpoint(output, config.runtime_agent())?;
            }
            Ok(())
        }
        FleetTargetConfig::Kubernetes(config) => {
            output.push(1);
            push_string(output, config.api_server())?;
            push_string(output, config.namespace())?;
            push_string(output, config.deployment_name())?;
            push_string(output, config.service_name())?;
            push_string(output, config.image())?;
            push_string(output, config.bearer_token().as_str())?;
            if with_runtime_agent {
                push_optional_runtime_agent_endpoint(output, config.runtime_agent())?;
            }
            Ok(())
        }
        FleetTargetConfig::Ssh(config) => {
            output.push(2);
            push_string(output, config.host())?;
            match config.port() {
                Some(port) => {
                    output.push(1);
                    output.extend_from_slice(&port.to_le_bytes());
                }
                None => output.push(0),
            }
            push_optional_string(output, config.username())?;
            match config.authentication() {
                SshAuthentication::PrivateKey(reference) => {
                    output.push(0);
                    push_string(output, reference.as_str())?;
                }
                SshAuthentication::Password(reference) => {
                    output.push(1);
                    push_string(output, reference.as_str())?;
                }
            }
            push_string(output, config.install_command())?;
            if with_runtime_agent {
                push_optional_runtime_agent_endpoint(output, config.runtime_agent())?;
            }
            Ok(())
        }
        FleetTargetConfig::Custom(config) => {
            output.push(3);
            push_string(output, config.endpoint())?;
            push_optional_secret_reference(output, config.credential())?;
            if with_terminal {
                match config.terminal() {
                    Some(terminal) => {
                        output.push(1);
                        output.push(match terminal.transport() {
                            crate::domain::target::CustomTerminalTransport::Websocket => 0,
                        });
                        push_string(output, terminal.endpoint())?;
                        push_string(output, terminal.protocol_version())?;
                        push_optional_string(output, terminal.credential_ref_name())?;
                    }
                    None => output.push(0),
                }
            }
            if with_runtime_agent {
                push_optional_runtime_agent_endpoint(output, config.runtime_agent())?;
            }
            Ok(())
        }
    }
}

fn push_optional_runtime_agent_endpoint(
    output: &mut Vec<u8>,
    config: Option<&crate::domain::target::RuntimeAgentEndpointConfig>,
) -> Result<(), StoreFault> {
    match config {
        Some(config) => {
            output.push(1);
            push_string(output, config.endpoint_url())?;
            push_string(output, config.token().as_str())
        }
        None => {
            output.push(0);
            Ok(())
        }
    }
}

fn push_optional_secret_reference(
    output: &mut Vec<u8>,
    reference: Option<&FleetSecretRef>,
) -> Result<(), StoreFault> {
    push_optional_string(output, reference.map(FleetSecretRef::as_str))
}

fn encode_topology_association(
    output: &mut Vec<u8>,
    association: &crate::domain::topology::TopologyAssociation,
) -> Result<(), StoreFault> {
    push_optional_string(output, association.connection_id().map(|id| id.as_str()))?;
    push_optional_string(output, association.environment_id().map(|id| id.as_str()))?;
    push_optional_string(
        output,
        association.managed_resource_id().map(|id| id.as_str()),
    )?;
    Ok(())
}

fn encode_observation_metadata(
    output: &mut Vec<u8>,
    metadata: ObservationMetadata,
) -> Result<(), StoreFault> {
    output.push(observation_source_tag(metadata.source()));
    push_system_time(output, metadata.observed_at())?;
    output.push(observation_freshness_tag(metadata.freshness()));
    Ok(())
}

fn encode_node_health(output: &mut Vec<u8>, health: NodeHealth) -> Result<(), StoreFault> {
    match health {
        NodeHealth::Unknown => output.push(0),
        NodeHealth::Online { last_seen_at } => {
            output.push(1);
            push_system_time(output, last_seen_at)?;
        }
        NodeHealth::Offline { last_seen_at } => {
            output.push(2);
            push_optional_system_time(output, last_seen_at)?;
        }
        NodeHealth::Disabled => output.push(3),
        NodeHealth::Error => output.push(4),
    }
    Ok(())
}

fn encode_runtime_state(output: &mut Vec<u8>, state: RuntimeState) -> Result<(), StoreFault> {
    match state {
        RuntimeState::Discovered => output.push(0),
        RuntimeState::Running { started_at } => {
            output.push(1);
            push_system_time(output, started_at)?;
        }
        RuntimeState::Stopped { stopped_at } => {
            output.push(2);
            push_optional_system_time(output, stopped_at)?;
        }
        RuntimeState::Degraded => output.push(3),
        RuntimeState::Retired { retired_at } => {
            output.push(4);
            push_system_time(output, retired_at)?;
        }
    }
    Ok(())
}

fn encode_command_record(output: &mut Vec<u8>, record: &CommandRecord) -> Result<(), StoreFault> {
    encode_command_intent(output, record.intent())?;
    encode_command_state(output, record.state())?;
    push_optional_command_attempt(output, record.attempt());
    push_optional_failure(output, record.last_failure());
    push_system_time(output, record.updated_at())
}

fn encode_command_intent(output: &mut Vec<u8>, intent: &CommandIntent) -> Result<(), StoreFault> {
    push_string(output, intent.command_id().as_str())?;
    push_string(output, intent.idempotency_key().as_str())?;
    encode_command_target(output, intent.target())?;
    output.push(command_kind_tag(intent.kind()));
    push_system_time(output, intent.queued_at())
}

fn encode_command_target(output: &mut Vec<u8>, target: &CommandTarget) -> Result<(), StoreFault> {
    match target {
        CommandTarget::Node(node_id) => {
            output.push(0);
            push_string(output, node_id.as_str())
        }
        CommandTarget::Runtime {
            node_id,
            runtime_id,
        } => {
            output.push(1);
            push_string(output, node_id.as_str())?;
            push_string(output, runtime_id.as_str())
        }
        CommandTarget::Endpoint {
            node_id,
            runtime_id,
            endpoint_id,
        } => {
            output.push(2);
            push_string(output, node_id.as_str())?;
            push_string(output, runtime_id.as_str())?;
            push_string(output, endpoint_id.as_str())
        }
    }
}

fn encode_command_state(output: &mut Vec<u8>, state: &CommandState) -> Result<(), StoreFault> {
    match state {
        CommandState::Queued { queued_at } => {
            output.push(0);
            push_system_time(output, *queued_at)
        }
        CommandState::Running { started_at } => {
            output.push(1);
            push_system_time(output, *started_at)
        }
        CommandState::Succeeded { completed_at } => {
            output.push(2);
            push_system_time(output, *completed_at)
        }
        CommandState::Failed {
            completed_at,
            failure,
        } => {
            output.push(3);
            push_system_time(output, *completed_at)?;
            output.push(command_failure_tag(*failure));
            Ok(())
        }
        CommandState::Cancelled {
            completed_at,
            reason,
        } => {
            output.push(4);
            push_system_time(output, *completed_at)?;
            push_optional_cancellation(output, *reason);
            Ok(())
        }
        CommandState::TimedOut {
            completed_at,
            timeout,
        } => {
            output.push(5);
            push_system_time(output, *completed_at)?;
            output.extend_from_slice(&timeout.as_secs().to_le_bytes());
            output.extend_from_slice(&timeout.subsec_nanos().to_le_bytes());
            Ok(())
        }
        CommandState::OutcomeUnknown { observed_at } => {
            output.push(6);
            push_system_time(output, *observed_at)
        }
    }
}

#[cfg(test)]
fn encode_outbox_record_v5(output: &mut Vec<u8>, record: &OutboxRecord) -> Result<(), StoreFault> {
    push_string(output, record.intent().dispatch_id().as_str())?;
    push_string(output, record.intent().command_id().as_str())?;
    push_string(output, record.intent().agent_id().as_str())?;
    output.push(dispatch_phase_tag(record.phase()));
    match record.attempt() {
        Some(attempt) => {
            output.push(1);
            output.extend_from_slice(&attempt.sequence().to_le_bytes());
        }
        None => output.push(0),
    }
    Ok(())
}

fn encode_outbox_record(output: &mut Vec<u8>, record: &OutboxRecord) -> Result<(), StoreFault> {
    push_string(output, record.intent().dispatch_id().as_str())?;
    push_string(output, record.intent().command_id().as_str())?;
    push_string(output, record.intent().agent_id().as_str())?;
    match record.intent().target() {
        Some(selector) => {
            output.push(1);
            push_string(output, selector.id().as_str())?;
            output.extend_from_slice(&selector.revision().to_le_bytes());
            output.push(target_kind_tag(selector.expected_kind()));
        }
        None => output.push(0),
    }
    output.push(dispatch_phase_tag(record.phase()));
    match record.attempt() {
        Some(attempt) => {
            output.push(1);
            output.extend_from_slice(&attempt.sequence().to_le_bytes());
        }
        None => output.push(0),
    }
    Ok(())
}

fn encode_audit_event(output: &mut Vec<u8>, event: &FleetAuditEvent) -> Result<(), StoreFault> {
    push_string(output, event.event_name())?;
    push_system_time(output, event.occurred_at())?;
    push_optional_string(output, event.message())?;
    encode_audit_relations(output, event.relations())?;
    encode_audit_fields(output, event.metadata(), 0)
}

fn encode_audit_relations(
    output: &mut Vec<u8>,
    relations: &crate::domain::audit::FleetAuditRelations,
) -> Result<(), StoreFault> {
    for value in [
        relations.actor_id(),
        relations.connection_id(),
        relations.environment_id(),
        relations.managed_resource_id(),
        relations.node_id(),
        relations.agent_id(),
        relations.runtime_id(),
        relations.endpoint_id(),
        relations.command_id(),
    ] {
        push_optional_string(output, value)?;
    }
    Ok(())
}

fn encode_audit_fields(
    output: &mut Vec<u8>,
    fields: &std::collections::BTreeMap<String, FleetAuditValue>,
    depth: usize,
) -> Result<(), StoreFault> {
    if depth > MAX_AUDIT_DEPTH {
        return Err(StoreFault::RecordTooLarge);
    }
    push_count(output, fields.len())?;
    for (key, value) in fields {
        push_string(output, key)?;
        encode_audit_value(output, value, depth)?;
    }
    Ok(())
}

fn encode_audit_value(
    output: &mut Vec<u8>,
    value: &FleetAuditValue,
    depth: usize,
) -> Result<(), StoreFault> {
    if depth > MAX_AUDIT_DEPTH {
        return Err(StoreFault::RecordTooLarge);
    }
    match value {
        FleetAuditValue::Text(value) => {
            output.push(0);
            push_string(output, value)
        }
        FleetAuditValue::Integer(value) => {
            output.push(1);
            output.extend_from_slice(&value.to_le_bytes());
            Ok(())
        }
        FleetAuditValue::Boolean(value) => {
            output.push(2);
            output.push(u8::from(*value));
            Ok(())
        }
        FleetAuditValue::List(values) => {
            output.push(3);
            push_count(output, values.len())?;
            for value in values {
                encode_audit_value(output, value, depth + 1)?;
            }
            Ok(())
        }
        FleetAuditValue::Fields(fields) => {
            output.push(4);
            encode_audit_fields(output, fields, depth + 1)
        }
    }
}
