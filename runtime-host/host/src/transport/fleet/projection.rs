use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::{
    fleet::owner::{FleetTargetSummary, FleetTopologySummary},
    public_string,
};
use fleet::connection::ConnectionKind;
use fleet::environment::{EnvironmentKind, ManagedResourceKind, ManagedResourceProvider};
use fleet::query::{
    AuditSummary, CapabilitySummary, CommandSummary, CommandSummaryState, CommandTargetSummary,
    ConnectionSummary, EnvironmentSummary, FleetQuerySnapshot, LeaseSummary, LeaseSummaryState,
    ResourceSummary,
};
use fleet::target::FleetTargetSelector;
use fleet::topology::{ObservationFreshness, ObservationSource};
use platform::capability::{CapabilityAvailability, CapabilityScope};

pub(crate) enum Delivery {
    Mutation(Value),
    Targets(Vec<FleetTargetSummary>),
    Topology(FleetTopologySummary),
    Connections(Vec<ConnectionSummary>),
    Capabilities(Vec<CapabilitySummary>),
    Environments(Vec<EnvironmentSummary>),
    Resources(Vec<ResourceSummary>),
    Commands(Vec<CommandSummary>),
    Audit(Vec<AuditSummary>),
    Leases(Vec<LeaseSummary>),
    Metrics(FleetQuerySnapshot),
    Snapshot(crate::fleet::owner::FleetSnapshot),
    SelectorPreview(fleet::query::SelectorPreview),
    Invalid,
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Mutation(_)
            | Self::Targets(_)
            | Self::Topology(_)
            | Self::Connections(_)
            | Self::Capabilities(_)
            | Self::Environments(_)
            | Self::Resources(_)
            | Self::Commands(_)
            | Self::Audit(_)
            | Self::Leases(_)
            | Self::Metrics(_)
            | Self::Snapshot(_)
            | Self::SelectorPreview(_) => 200,
            Self::Invalid => 400,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Mutation(value) => value.clone(),
            Self::Targets(targets) => json!({
                "targets": targets.iter().map(target_json).collect::<Vec<_>>(),
            }),
            Self::Topology(topology) => json!({
                "nodes": topology.nodes.iter().map(node_json).collect::<Vec<_>>(),
                "agents": topology.agents.iter().map(agent_json).collect::<Vec<_>>(),
                "runtimes": topology.runtimes.iter().map(runtime_json).collect::<Vec<_>>(),
                "endpoints": topology.endpoints.iter().map(endpoint_json).collect::<Vec<_>>(),
            }),
            Self::Connections(items) => json!({
                "connections": items.iter().map(connection_json).collect::<Vec<_>>(),
            }),
            Self::Capabilities(items) => json!({
                "capabilities": items.iter().map(capability_json).collect::<Vec<_>>(),
            }),
            Self::Environments(items) => json!({
                "environments": items.iter().map(environment_json).collect::<Vec<_>>(),
            }),
            Self::Resources(items) => json!({
                "resources": items.iter().map(resource_json).collect::<Vec<_>>(),
            }),
            Self::Commands(items) => json!({
                "commands": items.iter().map(command_json).collect::<Vec<_>>(),
            }),
            Self::Audit(items) => json!({
                "audit": items.iter().map(audit_json).collect::<Vec<_>>(),
            }),
            Self::Leases(items) => json!({
                "leases": items.iter().map(lease_json).collect::<Vec<_>>(),
            }),
            Self::Metrics(snapshot) => json!({"metrics": metrics_json(snapshot)}),
            Self::Snapshot(snapshot) => fleet_snapshot_json(snapshot),
            Self::SelectorPreview(preview) => selector_preview_json(preview.clone()),
            Self::Invalid => {
                json!({"success":false,"error":"Fleet request is invalid"})
            }
            Self::Unavailable => json!({
                "success": false,
                "error": "Fleet data is unavailable",
            }),
        }
    }
}

pub(super) fn delivery_outcome_json(outcome: fleet::FleetDeliveryOutcome, operation: u8) -> Value {
    json!({"outcome": match (outcome, operation) { (fleet::FleetDeliveryOutcome::Recorded, 0) => "accepted", (fleet::FleetDeliveryOutcome::Recorded, 1) => "rejected", (fleet::FleetDeliveryOutcome::Recorded, _) => "outcomeUnknown", (fleet::FleetDeliveryOutcome::AlreadyRecorded, _) => "alreadyRecorded", (fleet::FleetDeliveryOutcome::Replayed, _) => "replayed" }})
}

pub(super) fn fleet_snapshot_json(snapshot: &crate::fleet::owner::FleetSnapshot) -> Value {
    let query = &snapshot.query;
    json!({
        "connections": query.connections().iter().map(snapshot_connection_json).collect::<Vec<_>>(),
        "environments": query.environments().iter().map(snapshot_environment_json).collect::<Vec<_>>(),
        "managedResources": query.resources().iter().map(snapshot_resource_json).collect::<Vec<_>>(),
        "nodes": snapshot.topology.nodes.iter().map(snapshot_node_json).collect::<Vec<_>>(),
        "agents": snapshot.topology.agents.iter().map(snapshot_agent_json).collect::<Vec<_>>(),
        "runtimes": snapshot.topology.runtimes.iter().map(snapshot_runtime_json).collect::<Vec<_>>(),
        "endpoints": snapshot.topology.endpoints.iter().map(snapshot_endpoint_json).collect::<Vec<_>>(),
        "capabilities": query.capabilities().iter().map(snapshot_capability_json).collect::<Vec<_>>(),
        "commands": query.commands().iter().map(snapshot_command_json).collect::<Vec<_>>(),
        "leases": query.leases().iter().map(snapshot_lease_json).collect::<Vec<_>>(),
        "sessions": snapshot.sessions.iter().map(snapshot_session_json).collect::<Vec<_>>(),
        "auditEvents": query.audit().iter().map(snapshot_audit_json).collect::<Vec<_>>(),
        "updatedAt": timestamp(snapshot.updated_at),
    })
}

fn snapshot_connection_json(item: &ConnectionSummary) -> Value {
    json!({
        "id": item.id().as_str(),
        "displayName": item.display_name(),
        "connectionKind": snapshot_connection_kind_name(item.kind()),
        "status": snapshot_connection_status_name(item.state()),
        "labels": item.labels(),
        "enabled": item.enabled(),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
    })
}

fn snapshot_environment_json(item: &EnvironmentSummary) -> Value {
    json!({
        "id": item.id().as_str(),
        "connectionId": item.connection_id().as_str(),
        "displayName": item.display_name(),
        "environmentKind": snapshot_environment_kind_name(item.kind()),
        "status": snapshot_environment_status_name(item.state()),
        "labels": item.labels(),
        "enabled": item.enabled(),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
    })
}

fn snapshot_resource_json(item: &ResourceSummary) -> Value {
    let metadata = item.metadata();
    json!({
        "id": item.id().as_str(),
        "connectionId": item.connection_id().as_str(),
        "environmentId": item.environment_id().as_str(),
        "nodeId": item.node_id().map(|id| id.as_str()),
        "providerKind": snapshot_resource_provider_name(item.provider()),
        "resourceKind": snapshot_resource_kind_name(item.kind()),
        "remoteResourceId": item.remote_resource_id(),
        "displayName": metadata.and_then(|value| public_string::public_text(value.display_name())),
        "status": snapshot_resource_status_name(item.state()),
        "ownership": ownership_name(item.ownership()),
        "cleanupPolicy": cleanup_policy_name(item.cleanup_policy()),
        "labels": metadata.map(|value| public_resource_labels(value.labels())),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
        "lastObservedAt": metadata.map(|value| timestamp(value.observed_at())),
    })
}

fn public_resource_labels(labels: &std::collections::BTreeMap<String, String>) -> Vec<String> {
    labels
        .iter()
        .filter(|(key, _)| public_resource_label_key(key))
        .filter_map(|(key, value)| {
            public_string::public_text(value).map(|value| format!("{key}={value}"))
        })
        .collect()
}

fn public_resource_label_key(key: &str) -> bool {
    matches!(
        key,
        "app.kubernetes.io/name"
            | "app.kubernetes.io/component"
            | "app.kubernetes.io/part-of"
            | "com.matchaclaw.remote-fleet.managed"
            | "com.matchaclaw.remote-fleet.target"
            | "com.matchaclaw.remote-fleet.agent-id"
    )
}

fn snapshot_node_json(node: &fleet::topology::NodeObservation) -> Value {
    let association = node.association();
    json!({
        "id": node.id().as_str(),
        "connectionId": association.connection_id().map(|id| id.as_str()),
        "environmentId": association.environment_id().map(|id| id.as_str()),
        "managedResourceId": association.managed_resource_id().map(|id| id.as_str()),
        "status": node_health_name(node.health()),
        "lastSeenAt": timestamp(node.metadata().observed_at()),
    })
}

fn snapshot_agent_json(agent: &fleet::topology::AgentObservation) -> Value {
    let association = agent.association();
    json!({
        "id": agent.id().as_str(),
        "connectionId": association.connection_id().map(|id| id.as_str()),
        "environmentId": association.environment_id().map(|id| id.as_str()),
        "managedResourceId": association.managed_resource_id().map(|id| id.as_str()),
        "nodeId": agent.node_id().as_str(),
    })
}

fn snapshot_runtime_json(runtime: &fleet::topology::RuntimeObservation) -> Value {
    let association = runtime.association();
    json!({
        "id": runtime.id().as_str(),
        "connectionId": association.connection_id().map(|id| id.as_str()),
        "environmentId": association.environment_id().map(|id| id.as_str()),
        "managedResourceId": association.managed_resource_id().map(|id| id.as_str()),
        "nodeId": runtime.node_id().as_str(),
        "agentId": runtime.agent_id().map(|id| id.as_str()),
        "status": snapshot_runtime_status_name(runtime.state()),
        "startedAt": snapshot_runtime_started_at(runtime.state()).map(timestamp),
    })
}

fn snapshot_endpoint_json(endpoint: &fleet::topology::EndpointObservation) -> Value {
    let association = endpoint.association();
    json!({
        "id": endpoint.id().as_str(),
        "connectionId": association.connection_id().map(|id| id.as_str()),
        "environmentId": association.environment_id().map(|id| id.as_str()),
        "managedResourceId": association.managed_resource_id().map(|id| id.as_str()),
        "nodeId": endpoint.node_id().as_str(),
        "runtimeId": endpoint.runtime_id().as_str(),
        "status": endpoint_health_name(endpoint.health()),
        "lastProbeAt": timestamp(endpoint.metadata().observed_at()),
    })
}

fn snapshot_capability_json(item: &CapabilitySummary) -> Value {
    json!({
        "id": item.id().as_str(),
        "endpointId": item.endpoint_id().as_str(),
        "nodeId": item.node_id().as_str(),
        "runtimeId": item.runtime_id().as_str(),
        "status": snapshot_capability_status_name(item.availability(), item.observation().freshness()),
    })
}

fn snapshot_command_json(item: &CommandSummary) -> Value {
    let mut value = json!({
        "id": item.command_id().as_str(),
        "command": command_kind_name(item.kind()),
        "status": snapshot_command_status_name(item.state()),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
    });
    let object = value
        .as_object_mut()
        .expect("Fleet snapshot command projection is an object");
    match item.target() {
        CommandTargetSummary::Node(node_id) => {
            object.insert("nodeId".to_owned(), json!(node_id.as_str()));
        }
        CommandTargetSummary::Runtime {
            node_id,
            runtime_id,
        } => {
            object.insert("nodeId".to_owned(), json!(node_id.as_str()));
            object.insert("runtimeId".to_owned(), json!(runtime_id.as_str()));
        }
        CommandTargetSummary::Endpoint {
            node_id,
            runtime_id,
            endpoint_id,
        } => {
            object.insert("nodeId".to_owned(), json!(node_id.as_str()));
            object.insert("runtimeId".to_owned(), json!(runtime_id.as_str()));
            object.insert("endpointId".to_owned(), json!(endpoint_id.as_str()));
        }
    }
    value
}

fn snapshot_lease_json(item: &LeaseSummary) -> Value {
    let (status, expires_at) = match item.state() {
        LeaseSummaryState::Active { expires_at } => ("active", Some(timestamp(expires_at))),
        LeaseSummaryState::Released { .. } => ("released", None),
        LeaseSummaryState::Expired { .. } => ("expired", None),
    };
    json!({
        "id": item.lease_id().as_str(),
        "endpointId": item.endpoint_id().as_str(),
        "ownerKind": lease_owner_kind_name(item.owner_kind()),
        "ownerId": item.owner_id(),
        "status": status,
        "expiresAt": expires_at,
    })
}

fn snapshot_session_json(session: &fleet::terminal::SessionSummary) -> Value {
    json!({
        "id": session.id().as_str(),
        "nodeId": session.target().as_str(),
        "status": snapshot_session_status_name(session.status()),
        "createdAt": timestamp(session.created_at()),
        "updatedAt": timestamp(session.updated_at()),
        "expiresAt": timestamp(session.expires_at()),
    })
}

fn snapshot_audit_json(item: &AuditSummary) -> Value {
    let relations = item.relations();
    json!({
        "id": format!("audit:{}", item.sequence()),
        "eventName": item.event_name(),
        "occurredAt": timestamp(item.occurred_at()),
        "connectionId": relations.connection_id(),
        "environmentId": relations.environment_id(),
        "managedResourceId": relations.managed_resource_id(),
        "nodeId": relations.node_id(),
        "agentId": relations.agent_id(),
        "runtimeId": relations.runtime_id(),
        "endpointId": relations.endpoint_id(),
        "commandId": relations.command_id(),
    })
}

fn snapshot_connection_kind_name(kind: ConnectionKind) -> &'static str {
    match kind {
        ConnectionKind::SshHost => "ssh-host",
        ConnectionKind::Container => "container",
        ConnectionKind::Vm => "vm",
        ConnectionKind::KubernetesPod => "k8s-pod",
        ConnectionKind::Custom => "custom",
    }
}

fn snapshot_connection_status_name(state: &fleet::query::ConnectionSummaryState) -> &'static str {
    match state {
        fleet::query::ConnectionSummaryState::Registered => "unknown",
        fleet::query::ConnectionSummaryState::Probing => "unknown",
        fleet::query::ConnectionSummaryState::Ready { .. } => "online",
        fleet::query::ConnectionSummaryState::Unhealthy { .. } => "offline",
        fleet::query::ConnectionSummaryState::Deleted { .. } => "disabled",
        fleet::query::ConnectionSummaryState::Failed => "error",
    }
}

fn snapshot_environment_kind_name(kind: EnvironmentKind) -> &'static str {
    match kind {
        EnvironmentKind::SshWorkdir => "ssh-workdir",
        EnvironmentKind::DockerContainer => "docker-container",
        EnvironmentKind::KubernetesWorkload => "k8s-workload",
        EnvironmentKind::VmWorkdir => "vm-workdir",
        EnvironmentKind::Custom => "custom",
    }
}

fn snapshot_environment_status_name(state: &fleet::query::EnvironmentSummaryState) -> &'static str {
    match state {
        fleet::query::EnvironmentSummaryState::Registered => "registered",
        fleet::query::EnvironmentSummaryState::Deploying => "deploying",
        fleet::query::EnvironmentSummaryState::Ready { .. } => "ready",
        fleet::query::EnvironmentSummaryState::Deleting => "deleting",
        fleet::query::EnvironmentSummaryState::Deleted { .. } => "deleted",
        fleet::query::EnvironmentSummaryState::Orphaned => "orphaned",
        fleet::query::EnvironmentSummaryState::Failed => "failed",
    }
}

fn connection_kind_name(kind: ConnectionKind) -> &'static str {
    match kind {
        ConnectionKind::SshHost => "sshHost",
        ConnectionKind::Container => "container",
        ConnectionKind::Vm => "vm",
        ConnectionKind::KubernetesPod => "kubernetesPod",
        ConnectionKind::Custom => "custom",
    }
}

fn environment_kind_name(kind: EnvironmentKind) -> &'static str {
    match kind {
        EnvironmentKind::SshWorkdir => "sshWorkdir",
        EnvironmentKind::DockerContainer => "dockerContainer",
        EnvironmentKind::KubernetesWorkload => "kubernetesWorkload",
        EnvironmentKind::VmWorkdir => "vmWorkdir",
        EnvironmentKind::Custom => "custom",
    }
}

fn snapshot_resource_provider_name(provider: ManagedResourceProvider) -> &'static str {
    match provider {
        ManagedResourceProvider::Docker => "docker",
        ManagedResourceProvider::Kubernetes => "k8s",
        ManagedResourceProvider::Ssh => "ssh",
        ManagedResourceProvider::Vm => "vm",
        ManagedResourceProvider::Custom => "custom",
    }
}

fn snapshot_resource_kind_name(kind: ManagedResourceKind) -> &'static str {
    match kind {
        ManagedResourceKind::DockerContainer => "docker-container",
        ManagedResourceKind::KubernetesWorkload => "k8s-workload",
        ManagedResourceKind::KubernetesDeployment => "k8s-deployment",
        ManagedResourceKind::KubernetesService => "k8s-service",
        ManagedResourceKind::KubernetesSecret => "k8s-secret",
        ManagedResourceKind::SshAgentInstallation => "ssh-agent-installation",
        ManagedResourceKind::VmAgentInstallation => "vm-agent-installation",
        ManagedResourceKind::Custom => "custom",
    }
}

fn snapshot_resource_status_name(state: &fleet::query::ResourceSummaryState) -> &'static str {
    match state {
        fleet::query::ResourceSummaryState::Observed => "observed",
        fleet::query::ResourceSummaryState::Provisioning => "provisioning",
        fleet::query::ResourceSummaryState::Ready { .. } => "ready",
        fleet::query::ResourceSummaryState::Deleting => "deleting",
        fleet::query::ResourceSummaryState::Deleted { .. } => "deleted",
        fleet::query::ResourceSummaryState::Conflict => "conflict",
        fleet::query::ResourceSummaryState::Failed => "failed",
    }
}

fn snapshot_runtime_status_name(state: fleet::topology::RuntimeState) -> &'static str {
    match state {
        fleet::topology::RuntimeState::Discovered => "unknown",
        fleet::topology::RuntimeState::Running { .. } => "running",
        fleet::topology::RuntimeState::Stopped { .. } => "stopped",
        fleet::topology::RuntimeState::Degraded => "error",
        fleet::topology::RuntimeState::Retired { .. } => "stopped",
    }
}

fn snapshot_runtime_started_at(state: fleet::topology::RuntimeState) -> Option<SystemTime> {
    match state {
        fleet::topology::RuntimeState::Running { started_at } => Some(started_at),
        _ => None,
    }
}

fn snapshot_capability_status_name(
    availability: CapabilityAvailability,
    freshness: ObservationFreshness,
) -> &'static str {
    match freshness {
        ObservationFreshness::Current => match availability {
            CapabilityAvailability::Available => "current",
            CapabilityAvailability::Unavailable => "unavailable",
            CapabilityAvailability::Unknown => "unknown",
        },
        ObservationFreshness::Stale => "stale",
        ObservationFreshness::Unknown | ObservationFreshness::Pruned => "unknown",
    }
}

fn snapshot_command_status_name(state: &CommandSummaryState) -> &'static str {
    match state {
        CommandSummaryState::Queued { .. } => "queued",
        CommandSummaryState::Running { .. } => "running",
        CommandSummaryState::Succeeded { .. } => "succeeded",
        CommandSummaryState::Failed { .. } => "failed",
        CommandSummaryState::Cancelled { .. } => "cancelled",
        CommandSummaryState::TimedOut { .. } => "timed-out",
        CommandSummaryState::OutcomeUnknown { .. } => "unknown",
    }
}

pub(super) fn snapshot_session_status_name(status: fleet::terminal::SessionStatus) -> &'static str {
    match status {
        fleet::terminal::SessionStatus::Opening => "opening",
        fleet::terminal::SessionStatus::Connected => "connected",
        fleet::terminal::SessionStatus::Closing => "closing",
        fleet::terminal::SessionStatus::Closed => "closed",
        fleet::terminal::SessionStatus::Failed => "failed",
        fleet::terminal::SessionStatus::Expired => "expired",
    }
}

fn target_json(target: &FleetTargetSummary) -> Value {
    json!({
        "id": target.id.as_str(),
        "revision": target.revision,
        "kind": target_kind_name(target.kind),
    })
}

pub(super) fn selector_target_json(selector: &FleetTargetSelector) -> Value {
    json!({
        "id": selector.id().as_str(),
        "revision": selector.revision(),
        "kind": target_kind_name(selector.expected_kind()),
    })
}

fn topology_association_json(association: &fleet::topology::TopologyAssociation) -> Value {
    json!({
        "connectionId": association.connection_id().map(|id| id.as_str()),
        "environmentId": association.environment_id().map(|id| id.as_str()),
        "managedResourceId": association.managed_resource_id().map(|id| id.as_str()),
    })
}

fn node_json(node: &fleet::topology::NodeObservation) -> Value {
    let association = topology_association_json(node.association());
    json!({
        "id": node.id().as_str(),
        "health": node_health_name(node.health()),
        "connectionId": association["connectionId"],
        "environmentId": association["environmentId"],
        "managedResourceId": association["managedResourceId"],
        "observedAt": timestamp(node.metadata().observed_at()),
        "freshness": freshness_name(node.metadata().freshness()),
    })
}

fn agent_json(agent: &fleet::topology::AgentObservation) -> Value {
    let association = topology_association_json(agent.association());
    json!({
        "id": agent.id().as_str(),
        "nodeId": agent.node_id().as_str(),
        "connectionId": association["connectionId"],
        "environmentId": association["environmentId"],
        "managedResourceId": association["managedResourceId"],
        "observedAt": timestamp(agent.metadata().observed_at()),
        "freshness": freshness_name(agent.metadata().freshness()),
    })
}

fn runtime_json(runtime: &fleet::topology::RuntimeObservation) -> Value {
    let association = topology_association_json(runtime.association());
    json!({
        "id": runtime.id().as_str(),
        "nodeId": runtime.node_id().as_str(),
        "agentId": runtime.agent_id().map(|id| id.as_str()).unwrap_or("unknown"),
        "connectionId": association["connectionId"],
        "environmentId": association["environmentId"],
        "managedResourceId": association["managedResourceId"],
        "kind": runtime_kind_name(runtime.kind()),
        "state": runtime_state_name(runtime.state()),
        "observedAt": timestamp(runtime.metadata().observed_at()),
        "freshness": freshness_name(runtime.metadata().freshness()),
    })
}

fn endpoint_json(endpoint: &fleet::topology::EndpointObservation) -> Value {
    let association = topology_association_json(endpoint.association());
    json!({
        "id": endpoint.id().as_str(),
        "nodeId": endpoint.node_id().as_str(),
        "runtimeId": endpoint.runtime_id().as_str(),
        "connectionId": association["connectionId"],
        "environmentId": association["environmentId"],
        "managedResourceId": association["managedResourceId"],
        "health": endpoint_health_name(endpoint.health()),
        "observedAt": timestamp(endpoint.metadata().observed_at()),
        "freshness": freshness_name(endpoint.metadata().freshness()),
    })
}

fn capability_json(item: &CapabilitySummary) -> Value {
    json!({
        "id": item.id().as_str(),
        "scope": match item.scope() { CapabilityScope::Endpoint => "endpoint", CapabilityScope::Agent => "agent", CapabilityScope::Session => "session" },
        "endpointId": item.endpoint_id().as_str(),
        "nodeId": item.node_id().as_str(),
        "runtimeId": item.runtime_id().as_str(),
        "availability": match item.availability() { CapabilityAvailability::Available => "available", CapabilityAvailability::Unavailable => "unavailable", CapabilityAvailability::Unknown => "unknown" },
        "observedAt": timestamp(item.observation().observed_at()),
        "source": match item.observation().source() { ObservationSource::Discovery => "discovery", ObservationSource::HealthProbe => "healthProbe", ObservationSource::RuntimeAgent => "runtimeAgent" },
        "freshness": freshness_name(item.observation().freshness()),
    })
}

fn connection_json(item: &ConnectionSummary) -> Value {
    json!({
        "id": item.id().as_str(),
        "kind": connection_kind_name(item.kind()),
        "displayName": item.display_name(),
        "endpoint": item.endpoint(),
        "labels": item.labels(),
        "publicConfig": item.public_config(),
        "state": connection_state_json(item.state()),
        "enabled": item.enabled(),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
    })
}

fn connection_state_json(state: &fleet::query::ConnectionSummaryState) -> Value {
    match state {
        fleet::query::ConnectionSummaryState::Registered => json!({"kind":"registered"}),
        fleet::query::ConnectionSummaryState::Probing => json!({"kind":"probing"}),
        fleet::query::ConnectionSummaryState::Ready { observed_at } => {
            json!({"kind":"ready", "observedAt":timestamp(*observed_at)})
        }
        fleet::query::ConnectionSummaryState::Unhealthy { observed_at } => json!({
            "kind":"unhealthy",
            "observedAt":observed_at.map(timestamp),
        }),
        fleet::query::ConnectionSummaryState::Deleted { deleted_at } => {
            json!({"kind":"deleted", "deletedAt":timestamp(*deleted_at)})
        }
        fleet::query::ConnectionSummaryState::Failed => json!({"kind":"failed"}),
    }
}

fn environment_json(item: &EnvironmentSummary) -> Value {
    json!({
        "id": item.id().as_str(),
        "connectionId": item.connection_id().as_str(),
        "displayName": item.display_name(),
        "kind": environment_kind_name(item.kind()),
        "labels": item.labels(),
        "publicConfig": item.public_config(),
        "state": environment_state_json(item.state()),
        "enabled": item.enabled(),
        "managedResourceCount": item.managed_resource_count(),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
    })
}

fn environment_state_json(state: &fleet::query::EnvironmentSummaryState) -> Value {
    match state {
        fleet::query::EnvironmentSummaryState::Registered => json!({"kind":"registered"}),
        fleet::query::EnvironmentSummaryState::Deploying => json!({"kind":"deploying"}),
        fleet::query::EnvironmentSummaryState::Ready { ready_at } => {
            json!({"kind":"ready", "readyAt":timestamp(*ready_at)})
        }
        fleet::query::EnvironmentSummaryState::Deleting => json!({"kind":"deleting"}),
        fleet::query::EnvironmentSummaryState::Deleted { deleted_at } => {
            json!({"kind":"deleted", "deletedAt":timestamp(*deleted_at)})
        }
        fleet::query::EnvironmentSummaryState::Orphaned => json!({"kind":"orphaned"}),
        fleet::query::EnvironmentSummaryState::Failed => json!({"kind":"failed"}),
    }
}

fn resource_json(item: &ResourceSummary) -> Value {
    let metadata = item.metadata();
    json!({
        "id": item.id().as_str(),
        "connectionId": item.connection_id().as_str(),
        "environmentId": item.environment_id().as_str(),
        "nodeId": item.node_id().map(|id| id.as_str()),
        "provider": resource_provider_name(item.provider()),
        "kind": resource_kind_name(item.kind()),
        "remoteResourceId": item.remote_resource_id(),
        "displayName": metadata.and_then(|value| public_string::public_text(value.display_name())),
        "ownership": ownership_name(item.ownership()),
        "cleanupPolicy": cleanup_policy_name(item.cleanup_policy()),
        "labels": metadata.map(|value| public_resource_labels(value.labels())),
        "state": resource_state_json(item.state()),
        "tombstone": item.tombstone(),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
        "lastObservedAt": metadata.map(|value| timestamp(value.observed_at())),
    })
}

fn resource_state_json(state: &fleet::query::ResourceSummaryState) -> Value {
    match state {
        fleet::query::ResourceSummaryState::Observed => json!({"kind":"observed"}),
        fleet::query::ResourceSummaryState::Provisioning => json!({"kind":"provisioning"}),
        fleet::query::ResourceSummaryState::Ready { observed_at } => {
            json!({"kind":"ready", "observedAt":timestamp(*observed_at)})
        }
        fleet::query::ResourceSummaryState::Deleting => json!({"kind":"deleting"}),
        fleet::query::ResourceSummaryState::Deleted { deleted_at } => {
            json!({"kind":"deleted", "deletedAt":timestamp(*deleted_at)})
        }
        fleet::query::ResourceSummaryState::Conflict => json!({"kind":"conflict"}),
        fleet::query::ResourceSummaryState::Failed => json!({"kind":"failed"}),
    }
}

fn command_json(item: &CommandSummary) -> Value {
    json!({
        "commandId": item.command_id().as_str(),
        "kind": command_kind_name(item.kind()),
        "target": command_target_json(item.target()),
        "state": command_state_json(item.state()),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
    })
}

fn command_target_json(target: &CommandTargetSummary) -> Value {
    match target {
        CommandTargetSummary::Node(node_id) => json!({"kind":"node", "nodeId":node_id.as_str()}),
        CommandTargetSummary::Runtime {
            node_id,
            runtime_id,
        } => json!({
            "kind":"runtime", "nodeId":node_id.as_str(), "runtimeId":runtime_id.as_str()
        }),
        CommandTargetSummary::Endpoint {
            node_id,
            runtime_id,
            endpoint_id,
        } => json!({
            "kind":"endpoint", "nodeId":node_id.as_str(), "runtimeId":runtime_id.as_str(),
            "endpointId":endpoint_id.as_str()
        }),
    }
}

fn command_failure_name(failure: fleet::command::CommandFailure) -> &'static str {
    match failure {
        fleet::command::CommandFailure::Rejected => "rejected",
        fleet::command::CommandFailure::Unavailable => "unavailable",
        fleet::command::CommandFailure::ExecutionFailed => "executionFailed",
    }
}

fn command_cancellation_name(cancellation: fleet::command::CommandCancellation) -> &'static str {
    match cancellation {
        fleet::command::CommandCancellation::Requested => "requested",
        fleet::command::CommandCancellation::Superseded => "superseded",
    }
}

pub(super) fn command_state_json(state: &CommandSummaryState) -> Value {
    match state {
        CommandSummaryState::Queued { queued_at } => {
            json!({"kind":"queued", "queuedAt":timestamp(*queued_at)})
        }
        CommandSummaryState::Running { started_at } => {
            json!({"kind":"running", "startedAt":timestamp(*started_at)})
        }
        CommandSummaryState::Succeeded { completed_at } => {
            json!({"kind":"succeeded", "completedAt":timestamp(*completed_at)})
        }
        CommandSummaryState::Failed {
            completed_at,
            failure,
        } => {
            json!({"kind":"failed", "completedAt":timestamp(*completed_at), "failure": command_failure_name(*failure)})
        }
        CommandSummaryState::Cancelled {
            completed_at,
            reason,
        } => {
            json!({"kind":"cancelled", "completedAt":timestamp(*completed_at), "reason": reason.map(command_cancellation_name)})
        }
        CommandSummaryState::TimedOut { completed_at } => {
            json!({"kind":"timedOut", "completedAt":timestamp(*completed_at)})
        }
        CommandSummaryState::OutcomeUnknown { observed_at } => {
            json!({"kind":"outcomeUnknown", "observedAt":timestamp(*observed_at)})
        }
    }
}

fn lease_json(item: &LeaseSummary) -> Value {
    let state = match item.state() {
        LeaseSummaryState::Active { expires_at } => {
            json!({"kind":"active", "expiresAt":timestamp(expires_at)})
        }
        LeaseSummaryState::Released { released_at } => {
            json!({"kind":"released", "releasedAt":timestamp(released_at)})
        }
        LeaseSummaryState::Expired { expired_at } => {
            json!({"kind":"expired", "expiredAt":timestamp(expired_at)})
        }
    };
    json!({
        "leaseId": item.lease_id().as_str(),
        "endpointId": item.endpoint_id().as_str(),
        "owner": {"kind": lease_owner_kind_name(item.owner_kind()), "id": item.owner_id()},
        "acquiredAt": timestamp(item.acquired_at()),
        "state": state,
    })
}

fn lease_owner_kind_name(kind: fleet::lease::LeaseOwnerKind) -> &'static str {
    match kind {
        fleet::lease::LeaseOwnerKind::ManualOperation => "manualOperation",
        fleet::lease::LeaseOwnerKind::RuntimeStart => "runtimeStart",
        fleet::lease::LeaseOwnerKind::Session => "session",
        fleet::lease::LeaseOwnerKind::TeamRun => "teamRun",
    }
}

fn audit_json(item: &AuditSummary) -> Value {
    let relations = item.relations();
    json!({
        "sequence": item.sequence(),
        "eventName": item.event_name(),
        "occurredAt": timestamp(item.occurred_at()),
        "actorId": relations.actor_id(),
        "connectionId": relations.connection_id(),
        "environmentId": relations.environment_id(),
        "managedResourceId": relations.managed_resource_id(),
        "nodeId": relations.node_id(),
        "agentId": relations.agent_id(),
        "runtimeId": relations.runtime_id(),
        "endpointId": relations.endpoint_id(),
        "commandId": relations.command_id(),
    })
}

fn selector_preview_json(preview: fleet::query::SelectorPreview) -> Value {
    json!({
        "constraints": {
            "endpointIds": preview.constraints().endpoint_ids(), "nodeIds": preview.constraints().node_ids(),
            "runtimeIds": preview.constraints().runtime_ids(), "labels": preview.constraints().labels(), "operationIds": preview.constraints().operation_ids(),
        },
        "candidates": preview.candidates().iter().map(|candidate| json!({
            "endpointId": candidate.endpoint_id().as_str(), "nodeId": candidate.node_id().as_str(), "runtimeId": candidate.runtime_id().as_str(),
            "health": endpoint_health_name(candidate.health()), "activeLeaseCount": candidate.active_lease_count(),
            "capabilities": candidate.capabilities().iter().map(|capability| json!({"id": capability.id(), "availability": match capability.availability() { CapabilityAvailability::Available => "available", CapabilityAvailability::Unavailable => "unavailable", CapabilityAvailability::Unknown => "unknown" }})).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "exclusions": preview.exclusions().iter().map(|exclusion| json!({
            "endpointId": exclusion.endpoint_id().as_str(), "nodeId": exclusion.node_id().as_str(), "runtimeId": exclusion.runtime_id().as_str(),
            "reasons": exclusion.reasons().iter().map(selector_exclusion_reason_name).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "unavailableConstraints": preview.unavailable_constraints().iter().map(selector_constraint_dimension_name).collect::<Vec<_>>(),
    })
}

fn selector_exclusion_reason_name(reason: &fleet::query::SelectorExclusionReason) -> &'static str {
    match reason {
        fleet::query::SelectorExclusionReason::EndpointIdMismatch => "endpointIdMismatch",
        fleet::query::SelectorExclusionReason::NodeIdMismatch => "nodeIdMismatch",
        fleet::query::SelectorExclusionReason::RuntimeIdMismatch => "runtimeIdMismatch",
        fleet::query::SelectorExclusionReason::LabelsUnavailable => "labelsUnavailable",
        fleet::query::SelectorExclusionReason::OperationIdsUnavailable => "operationIdsUnavailable",
        fleet::query::SelectorExclusionReason::EndpointHealthNotReady => "endpointHealthNotReady",
    }
}

fn selector_constraint_dimension_name(
    dimension: &fleet::query::SelectorConstraintDimension,
) -> &'static str {
    match dimension {
        fleet::query::SelectorConstraintDimension::EndpointIds => "endpointIds",
        fleet::query::SelectorConstraintDimension::NodeIds => "nodeIds",
        fleet::query::SelectorConstraintDimension::RuntimeIds => "runtimeIds",
        fleet::query::SelectorConstraintDimension::Labels => "labels",
        fleet::query::SelectorConstraintDimension::OperationIds => "operationIds",
    }
}

fn metrics_json(snapshot: &FleetQuerySnapshot) -> Value {
    let metrics = snapshot.metrics();
    let nodes = metrics.nodes();
    let runtimes = metrics.runtimes();
    let endpoints = metrics.endpoints();
    let agents = metrics.agents();
    let capabilities = metrics.capabilities();
    let commands = metrics.commands();
    let audit = metrics.audit();
    let leases = metrics.leases();
    json!({
        "nodes": {
            "total": nodes.total(), "unknown": nodes.unknown(), "online": nodes.online(),
            "offline": nodes.offline(), "disabled": nodes.disabled(), "error": nodes.error()
        },
        "runtimes": {
            "total": runtimes.total(), "discovered": runtimes.discovered(), "running": runtimes.running(),
            "stopped": runtimes.stopped(), "degraded": runtimes.degraded(), "retired": runtimes.retired()
        },
        "agents": { "total": agents.total() },
        "capabilities": {
            "total": capabilities.total(), "available": capabilities.available(),
            "unavailable": capabilities.unavailable(), "unknown": capabilities.unknown(),
            "stale": capabilities.stale()
        },
        "endpoints": {
            "total": endpoints.total(), "unknown": endpoints.unknown(), "ready": endpoints.ready(),
            "busy": endpoints.busy(), "draining": endpoints.draining(), "unhealthy": endpoints.unhealthy(),
            "retired": endpoints.retired(),
            "drainingEndpoints": endpoints.draining_endpoints().iter().map(|endpoint| json!({
                "id": endpoint.id().as_str(), "nodeId": endpoint.node_id().as_str(), "runtimeId": endpoint.runtime_id().as_str()
            })).collect::<Vec<_>>(),
            "retiredEndpoints": endpoints.retired_endpoints().iter().map(|endpoint| json!({
                "id": endpoint.id().as_str(), "nodeId": endpoint.node_id().as_str(), "runtimeId": endpoint.runtime_id().as_str()
            })).collect::<Vec<_>>()
        },
        "commands": {
            "total": commands.total(), "queued": commands.queued(), "running": commands.running(),
            "succeeded": commands.succeeded(), "failed": commands.failed(), "cancelled": commands.cancelled(),
            "timedOut": commands.timed_out(), "outcomeUnknown": commands.outcome_unknown()
        },
        "audit": {
            "total": audit.total(),
            "eventCounts": audit.event_counts()
        },
        "leases": {
            "total": leases.total(), "active": leases.active(), "released": leases.released(),
            "expired": leases.expired(), "manualOperation": leases.manual_operation(),
            "runtimeStart": leases.runtime_start(), "session": leases.session(), "teamRun": leases.team_run()
        }
    })
}

pub(super) fn target_kind_name(kind: fleet::TargetKind) -> &'static str {
    match kind {
        fleet::TargetKind::Docker => "docker",
        fleet::TargetKind::Kubernetes => "kubernetes",
        fleet::TargetKind::Ssh => "ssh",
        fleet::TargetKind::Custom => "custom",
    }
}

fn resource_provider_name(provider: fleet::environment::ManagedResourceProvider) -> &'static str {
    match provider {
        fleet::environment::ManagedResourceProvider::Docker => "docker",
        fleet::environment::ManagedResourceProvider::Kubernetes => "kubernetes",
        fleet::environment::ManagedResourceProvider::Ssh => "ssh",
        fleet::environment::ManagedResourceProvider::Vm => "vm",
        fleet::environment::ManagedResourceProvider::Custom => "custom",
    }
}

fn resource_kind_name(kind: fleet::environment::ManagedResourceKind) -> &'static str {
    match kind {
        fleet::environment::ManagedResourceKind::DockerContainer => "dockerContainer",
        fleet::environment::ManagedResourceKind::KubernetesWorkload => "kubernetesWorkload",
        fleet::environment::ManagedResourceKind::KubernetesDeployment => "kubernetesDeployment",
        fleet::environment::ManagedResourceKind::KubernetesService => "kubernetesService",
        fleet::environment::ManagedResourceKind::KubernetesSecret => "kubernetesSecret",
        fleet::environment::ManagedResourceKind::SshAgentInstallation => "sshAgentInstallation",
        fleet::environment::ManagedResourceKind::VmAgentInstallation => "vmAgentInstallation",
        fleet::environment::ManagedResourceKind::Custom => "custom",
    }
}

fn ownership_name(value: fleet::environment::Ownership) -> &'static str {
    match value {
        fleet::environment::Ownership::MatchaManaged => "matchaManaged",
        fleet::environment::Ownership::Unverified => "unverified",
        fleet::environment::Ownership::External => "external",
    }
}

fn cleanup_policy_name(value: fleet::environment::CleanupPolicy) -> &'static str {
    match value {
        fleet::environment::CleanupPolicy::DeleteOnEnvironmentDelete => "deleteOnEnvironmentDelete",
        fleet::environment::CleanupPolicy::UninstallAgentOnly => "uninstallAgentOnly",
        fleet::environment::CleanupPolicy::Orphan => "orphan",
        fleet::environment::CleanupPolicy::None => "none",
    }
}

fn command_kind_name(value: fleet::command::CommandKind) -> &'static str {
    match value {
        fleet::command::CommandKind::ProbeNode => "probeNode",
        fleet::command::CommandKind::InstallAgent => "installAgent",
        fleet::command::CommandKind::StartRuntime => "startRuntime",
        fleet::command::CommandKind::StopRuntime => "stopRuntime",
        fleet::command::CommandKind::SyncCapabilities => "syncCapabilities",
        fleet::command::CommandKind::UpgradeAgent => "upgradeAgent",
        fleet::command::CommandKind::MountWorkspace => "mountWorkspace",
        fleet::command::CommandKind::ExposePort => "exposePort",
    }
}

fn node_health_name(value: fleet::topology::NodeHealth) -> &'static str {
    match value {
        fleet::topology::NodeHealth::Unknown => "unknown",
        fleet::topology::NodeHealth::Online { .. } => "online",
        fleet::topology::NodeHealth::Offline { .. } => "offline",
        fleet::topology::NodeHealth::Disabled => "disabled",
        fleet::topology::NodeHealth::Error => "error",
    }
}

fn endpoint_health_name(value: fleet::topology::EndpointHealth) -> &'static str {
    match value {
        fleet::topology::EndpointHealth::Unknown => "unknown",
        fleet::topology::EndpointHealth::Ready => "ready",
        fleet::topology::EndpointHealth::Busy => "busy",
        fleet::topology::EndpointHealth::Draining => "draining",
        fleet::topology::EndpointHealth::Unhealthy => "unhealthy",
        fleet::topology::EndpointHealth::Retired => "retired",
    }
}

fn runtime_kind_name(value: fleet::topology::RuntimeKind) -> &'static str {
    match value {
        fleet::topology::RuntimeKind::OpenClaw => "openClaw",
        fleet::topology::RuntimeKind::MatchaAgent => "matchaAgent",
        fleet::topology::RuntimeKind::Plugin => "plugin",
    }
}

fn runtime_state_name(value: fleet::topology::RuntimeState) -> &'static str {
    match value {
        fleet::topology::RuntimeState::Discovered => "discovered",
        fleet::topology::RuntimeState::Running { .. } => "running",
        fleet::topology::RuntimeState::Stopped { .. } => "stopped",
        fleet::topology::RuntimeState::Degraded => "degraded",
        fleet::topology::RuntimeState::Retired { .. } => "retired",
    }
}

fn freshness_name(value: fleet::topology::ObservationFreshness) -> &'static str {
    match value {
        fleet::topology::ObservationFreshness::Current => "current",
        fleet::topology::ObservationFreshness::Stale => "stale",
        fleet::topology::ObservationFreshness::Unknown => "unknown",
        fleet::topology::ObservationFreshness::Pruned => "pruned",
    }
}

pub(super) fn timestamp(value: SystemTime) -> String {
    let millis = value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix:{millis}")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn provider_resource_labels_publish_only_allowlisted_public_values() {
        let labels = public_resource_labels(&BTreeMap::from([
            ("app.kubernetes.io/name".into(), "worker".into()),
            ("com.matchaclaw.remote-fleet.managed".into(), "true".into()),
            ("token".into(), "secret".into()),
            ("stderr".into(), "raw stderr".into()),
            (
                "app.kubernetes.io/component".into(),
                "path=/home/me/.ssh/id_rsa".into(),
            ),
        ]));

        assert_eq!(
            labels,
            vec![
                "app.kubernetes.io/component=[redacted]".to_owned(),
                "app.kubernetes.io/name=worker".to_owned(),
                "com.matchaclaw.remote-fleet.managed=true".to_owned(),
            ]
        );
    }
}
