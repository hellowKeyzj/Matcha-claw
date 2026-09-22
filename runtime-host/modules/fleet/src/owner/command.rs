use std::time::SystemTime;

use crate as fleet;
use foundation::execution::{CommandRoute, QueryRoute};
use tokio::sync::oneshot;

use super::actor::FleetLaneKey;

/// Fleet owner command envelope for independent mailbox architecture.
pub(crate) enum FleetCommand {
    TerminalOpenAllocated {
        selector: crate::owner::actor::FleetTerminalTargetSelector,
        dimensions: fleet::terminal::Dimensions,
        reply: oneshot::Sender<
            Result<
                crate::owner::actor::FleetTerminalOpenResult,
                fleet::terminal::TerminalSessionError,
            >,
        >,
    },
    TerminalConsumeTicket {
        ticket: Vec<u8>,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalProviderOpen {
        target_id: fleet::TargetId,
        context: crate::application::terminal::TerminalContext,
        reply: oneshot::Sender<Result<crate::application::terminal::TerminalProviderOpen, ()>>,
    },
    TerminalClose {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalFail {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalCloseCurrent {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalBeginCloseCurrent {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalFinishCloseCurrent {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalReconnect {
        session: fleet::terminal::SessionId,
        reply: oneshot::Sender<
            Result<fleet::terminal::OpenedSession, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalBeginClose {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    TerminalFinishClose {
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
        reply: oneshot::Sender<
            Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>,
        >,
    },
    PutTarget {
        id: fleet::TargetId,
        config: fleet::FleetTargetConfig,
        reply: oneshot::Sender<Result<fleet::TargetSnapshot, fleet::FleetDeliveryError>>,
    },
    RemoveTarget {
        id: fleet::TargetId,
        reply: oneshot::Sender<Result<bool, fleet::FleetDeliveryError>>,
    },
    Submit {
        request: fleet::FleetDeliveryRequest,
        reply: oneshot::Sender<Result<fleet::FleetSubmitOutcome, fleet::FleetDeliveryError>>,
    },
    Begin {
        target_id: fleet::TargetId,
        dispatch_id: fleet::outbox::DispatchId,
        reply: oneshot::Sender<
            Result<crate::owner::actor::FleetDispatchResult, fleet::FleetDeliveryError>,
        >,
    },
    Accept {
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    Reject {
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    Unknown {
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    Replay {
        command_id: fleet::command::CommandId,
        dispatch_id: fleet::outbox::DispatchId,
        reply: oneshot::Sender<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>>,
    },
    UpsertConnection {
        record: fleet::connection::ConnectionRecord,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    DeleteConnection {
        id: fleet::connection::ConnectionId,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    BeginConnectionProbe {
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    RunConnectionProbe {
        target_id: fleet::TargetId,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        reply: oneshot::Sender<
            Result<
                crate::owner::lifecycle::FleetConnectionLifecycleOutcome,
                fleet::FleetDeliveryError,
            >,
        >,
    },
    RunEnvironmentDeployment {
        target_id: fleet::TargetId,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::owner::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RunEnvironmentDeletion {
        target_id: fleet::TargetId,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::owner::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RunResourceProvisioning {
        target_id: fleet::TargetId,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::owner::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RunResourceDeletion {
        target_id: fleet::TargetId,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<crate::owner::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    },
    CompleteConnectionProbe {
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        outcome: fleet::connection::ProbeOutcome,
        message: Option<String>,
        reply: oneshot::Sender<
            Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>,
        >,
    },
    RegisterEnvironment {
        record: fleet::environment::EnvironmentRecord,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    RegisterResource {
        request: crate::owner::actor::ManagedResourceRegistrationRequest,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    UpsertNode {
        observation: fleet::topology::NodeObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    UpsertAgent {
        observation: fleet::topology::AgentObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    WriteCredential {
        request: crate::application::credentials::FleetCredentialWriteRequest,
        reply: oneshot::Sender<
            Result<
                crate::application::credentials::FleetCredentialWriteOutcome,
                crate::application::credentials::FleetCredentialVaultError,
            >,
        >,
    },
    RevokeAgent {
        id: platform::endpoint::NativeAgentId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    UpsertRuntime {
        observation: fleet::topology::RuntimeObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    UpsertEndpoint {
        observation: fleet::topology::EndpointObservation,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    RetireNode {
        id: fleet::topology::NodeId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginRuntimeStart {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteRuntimeStart {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginRuntimeStop {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteRuntimeStop {
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    RetireRuntime {
        id: fleet::topology::RuntimeId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    DrainEndpoint {
        id: platform::endpoint::EndpointId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    RetireEndpoint {
        id: platform::endpoint::EndpointId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginEndpointProbe {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteEndpointProbe {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        health: fleet::topology::EndpointHealth,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginCapabilitySync {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    CompleteCapabilitySync {
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        sync: fleet::topology::CapabilitySync,
        reply:
            oneshot::Sender<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>>,
    },
    BeginEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailEnvironmentDeployment {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    BeginEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailEnvironmentDeletion {
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>,
        >,
    },
    StartResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteResourceProvisioning {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    StartResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    CompleteResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    FailResourceDeletion {
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
        reply: oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    },
    AuthenticateRuntimeAgentIngress {
        identity: fleet::store::AgentIngressIdentity,
        reply:
            oneshot::Sender<Result<fleet::store::IngressAuthentication, fleet::FleetDeliveryError>>,
    },
    RegisterRuntimeAgent {
        agent: fleet::runtime_agent::RuntimeAgent,
        reply: oneshot::Sender<Result<(), fleet::FleetDeliveryError>>,
    },
    RegisterRuntimeAgentCommand {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        queued_at: SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<Result<(), fleet::FleetDeliveryError>>,
    },
    RecordRuntimeAgentHeartbeat {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
        reply: oneshot::Sender<
            Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RecordRuntimeAgentProgress {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<
            Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        >,
    },
    RecordRuntimeAgentResult {
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
        reply: oneshot::Sender<
            Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        >,
    },
}

pub(crate) enum FleetQuery {
    TerminalContext {
        summary: fleet::terminal::SessionSummary,
        reply: oneshot::Sender<
            Result<
                Option<crate::application::terminal::TerminalContext>,
                fleet::FleetDeliveryError,
            >,
        >,
    },
    TerminalResolveContext {
        selector: crate::owner::actor::FleetTerminalTargetSelector,
        summary: fleet::terminal::SessionSummary,
        reply: oneshot::Sender<
            Result<
                Option<crate::application::terminal::TerminalContext>,
                fleet::FleetDeliveryError,
            >,
        >,
    },
    TerminalList {
        reply: oneshot::Sender<Vec<fleet::terminal::SessionSummary>>,
    },
    QuerySnapshot {
        now: SystemTime,
        reply: oneshot::Sender<Result<fleet::query::FleetQuerySnapshot, fleet::FleetDeliveryError>>,
    },
    Snapshot {
        now: SystemTime,
        reply:
            oneshot::Sender<Result<crate::owner::actor::FleetSnapshot, fleet::FleetDeliveryError>>,
    },
    SelectorPreview {
        constraints: fleet::query::SelectorConstraints,
        now: SystemTime,
        reply: oneshot::Sender<Result<fleet::query::SelectorPreview, fleet::FleetDeliveryError>>,
    },
    TargetSummaries {
        reply: oneshot::Sender<
            Result<Vec<crate::owner::actor::FleetTargetSummary>, fleet::FleetDeliveryError>,
        >,
    },
    TargetSelector {
        id: fleet::TargetId,
        revision: u64,
        kind: fleet::TargetKind,
        reply:
            oneshot::Sender<Result<Option<fleet::FleetTargetSelector>, fleet::FleetDeliveryError>>,
    },
    TopologySummary {
        reply: oneshot::Sender<
            Result<crate::owner::actor::FleetTopologySummary, fleet::FleetDeliveryError>,
        >,
    },
    NodeCommandRequest {
        request: crate::owner::actor::FleetNodeCommandRequest,
        reply: oneshot::Sender<
            Result<crate::owner::actor::FleetNodeCommandResolution, fleet::FleetDeliveryError>,
        >,
    },
    DispatchTarget {
        dispatch_id: fleet::outbox::DispatchId,
        reply: oneshot::Sender<Result<fleet::TargetId, fleet::FleetDeliveryError>>,
    },
    ConnectionTarget {
        id: fleet::connection::ConnectionId,
        reply: oneshot::Sender<Result<fleet::TargetId, fleet::FleetDeliveryError>>,
    },
    EnvironmentTarget {
        id: fleet::environment::EnvironmentId,
        reply: oneshot::Sender<Result<fleet::TargetId, fleet::FleetDeliveryError>>,
    },
    ResourceTarget {
        id: fleet::environment::ManagedResourceId,
        reply: oneshot::Sender<Result<fleet::TargetId, fleet::FleetDeliveryError>>,
    },
}

impl FleetCommand {
    pub(crate) fn route_command(&self) -> CommandRoute<FleetLaneKey> {
        match self {
            Self::TerminalOpenAllocated { .. } => CommandRoute::Exclusive,
            Self::TerminalProviderOpen { target_id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Target(target_id.clone()))
            }
            Self::PutTarget { id, .. } | Self::RemoveTarget { id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Target(id.clone()))
            }
            Self::Begin { target_id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Target(target_id.clone()))
            }
            Self::Accept { dispatch_id, .. }
            | Self::Reject { dispatch_id, .. }
            | Self::Unknown { dispatch_id, .. }
            | Self::Replay { dispatch_id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Dispatch(dispatch_id.clone()))
            }
            Self::BeginConnectionProbe { id, .. } | Self::CompleteConnectionProbe { id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Connection(id.clone()))
            }
            Self::RunConnectionProbe { target_id, .. }
            | Self::RunEnvironmentDeployment { target_id, .. }
            | Self::RunEnvironmentDeletion { target_id, .. }
            | Self::RunResourceProvisioning { target_id, .. }
            | Self::RunResourceDeletion { target_id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Target(target_id.clone()))
            }
            Self::BeginEnvironmentDeployment { id, .. }
            | Self::CompleteEnvironmentDeployment { id, .. }
            | Self::FailEnvironmentDeployment { id, .. }
            | Self::BeginEnvironmentDeletion { id, .. }
            | Self::CompleteEnvironmentDeletion { id, .. }
            | Self::FailEnvironmentDeletion { id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Environment(id.clone()))
            }
            Self::StartResourceProvisioning { id, .. }
            | Self::FailResourceProvisioning { id, .. }
            | Self::CompleteResourceProvisioning { id, .. }
            | Self::StartResourceDeletion { id, .. }
            | Self::CompleteResourceDeletion { id, .. }
            | Self::FailResourceDeletion { id, .. } => {
                CommandRoute::Keyed(FleetLaneKey::Resource(id.clone()))
            }
            Self::TerminalConsumeTicket { .. }
            | Self::TerminalClose { .. }
            | Self::TerminalFail { .. }
            | Self::TerminalCloseCurrent { .. }
            | Self::TerminalBeginCloseCurrent { .. }
            | Self::TerminalFinishCloseCurrent { .. }
            | Self::TerminalReconnect { .. }
            | Self::TerminalBeginClose { .. }
            | Self::TerminalFinishClose { .. }
            | Self::Submit { .. }
            | Self::UpsertConnection { .. }
            | Self::DeleteConnection { .. }
            | Self::RegisterEnvironment { .. }
            | Self::RegisterResource { .. }
            | Self::UpsertNode { .. }
            | Self::UpsertAgent { .. }
            | Self::WriteCredential { .. }
            | Self::RevokeAgent { .. }
            | Self::UpsertRuntime { .. }
            | Self::UpsertEndpoint { .. }
            | Self::RetireNode { .. }
            | Self::BeginRuntimeStart { .. }
            | Self::CompleteRuntimeStart { .. }
            | Self::BeginRuntimeStop { .. }
            | Self::CompleteRuntimeStop { .. }
            | Self::RetireRuntime { .. }
            | Self::DrainEndpoint { .. }
            | Self::RetireEndpoint { .. }
            | Self::BeginEndpointProbe { .. }
            | Self::CompleteEndpointProbe { .. }
            | Self::BeginCapabilitySync { .. }
            | Self::CompleteCapabilitySync { .. }
            | Self::AuthenticateRuntimeAgentIngress { .. }
            | Self::RegisterRuntimeAgent { .. }
            | Self::RegisterRuntimeAgentCommand { .. }
            | Self::RecordRuntimeAgentHeartbeat { .. }
            | Self::RecordRuntimeAgentProgress { .. }
            | Self::RecordRuntimeAgentResult { .. } => CommandRoute::Global,
        }
    }
}

impl FleetQuery {
    pub(crate) fn route_query(&self) -> QueryRoute<FleetLaneKey> {
        match self {
            Self::TerminalContext { .. }
            | Self::TerminalResolveContext { .. }
            | Self::QuerySnapshot { .. }
            | Self::Snapshot { .. }
            | Self::SelectorPreview { .. }
            | Self::TargetSummaries { .. }
            | Self::TargetSelector { .. }
            | Self::TopologySummary { .. }
            | Self::NodeCommandRequest { .. }
            | Self::DispatchTarget { .. }
            | Self::ConnectionTarget { .. }
            | Self::EnvironmentTarget { .. }
            | Self::ResourceTarget { .. } => QueryRoute::Exclusive,
            Self::TerminalList { .. } => QueryRoute::Global,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_id() -> fleet::command::CommandId {
        fleet::command::CommandId::try_new("command").unwrap()
    }

    fn dispatch_id() -> fleet::outbox::DispatchId {
        fleet::outbox::DispatchId::try_new("dispatch").unwrap()
    }

    fn dispatch_attempt() -> fleet::outbox::DispatchAttempt {
        fleet::outbox::DispatchAttempt::try_new(1).unwrap()
    }

    fn command_attempt() -> fleet::command::CommandAttempt {
        fleet::command::CommandAttempt::try_new(1).unwrap()
    }

    fn runtime_agent_id() -> fleet::runtime_agent::RuntimeAgentId {
        fleet::runtime_agent::RuntimeAgentId::try_new("agent").unwrap()
    }

    fn connection_id() -> fleet::connection::ConnectionId {
        fleet::connection::ConnectionId::try_new("connection").unwrap()
    }

    fn environment_id() -> fleet::environment::EnvironmentId {
        fleet::environment::EnvironmentId::try_new("environment").unwrap()
    }

    fn resource_id() -> fleet::environment::ManagedResourceId {
        fleet::environment::ManagedResourceId::try_new("resource").unwrap()
    }

    fn target_id() -> fleet::TargetId {
        fleet::TargetId::try_new("target").unwrap()
    }

    fn phase() -> fleet::effect::PhaseKey {
        fleet::effect::PhaseKey::try_new("phase").unwrap()
    }

    fn terminal_session_id() -> fleet::terminal::SessionId {
        fleet::terminal::SessionId::try_new("terminal-session").unwrap()
    }

    fn terminal_context() -> crate::application::terminal::TerminalContext {
        crate::application::terminal::TerminalContext {
            session: terminal_session_id(),
            target: fleet::terminal::TargetId::try_new("target").unwrap(),
            provider: fleet::terminal::ProviderId::try_new("provider").unwrap(),
            generation: fleet::terminal::Generation::FIRST,
            node: fleet::topology::NodeId::try_new("node").unwrap(),
            endpoint: platform::endpoint::EndpointId::try_new("endpoint").unwrap(),
            rows: 24,
            cols: 80,
        }
    }

    fn terminal_summary() -> fleet::terminal::SessionSummary {
        let mut owner = fleet::terminal::TerminalSessionOwner::default();
        owner
            .open(
                terminal_session_id(),
                fleet::terminal::TargetId::try_new("target").unwrap(),
                fleet::terminal::ProviderId::try_new("provider").unwrap(),
                fleet::terminal::Dimensions::try_new(24, 80).unwrap(),
                SystemTime::UNIX_EPOCH,
            )
            .unwrap()
            .session
    }

    fn node_command_request() -> crate::owner::actor::FleetNodeCommandRequest {
        crate::owner::actor::FleetNodeCommandRequest {
            node_id: fleet::topology::NodeId::try_new("node").unwrap(),
            command_id: command_id(),
            idempotency_key: fleet::command::IdempotencyKey::try_new("idempotency").unwrap(),
            dispatch_id: dispatch_id(),
            kind: fleet::command::CommandKind::ProbeNode,
        }
    }

    #[test]
    fn routes_terminal_provider_open_by_target() {
        let context = terminal_context();
        let target = target_id();
        let (reply, _) = oneshot::channel();

        assert_eq!(
            FleetCommand::TerminalProviderOpen {
                target_id: target.clone(),
                context,
                reply,
            }
            .route_command(),
            CommandRoute::Keyed(FleetLaneKey::Target(target))
        );
    }

    #[test]
    fn routes_terminal_open_allocation_exclusive() {
        let (reply, _) = oneshot::channel();

        assert_eq!(
            FleetCommand::TerminalOpenAllocated {
                selector: crate::owner::actor::FleetTerminalTargetSelector::Target(
                    fleet::terminal::TargetId::try_new("target").unwrap(),
                ),
                dimensions: fleet::terminal::Dimensions::try_new(24, 80).unwrap(),
                reply,
            }
            .route_command(),
            CommandRoute::Exclusive
        );
    }

    #[test]
    fn keeps_terminal_session_state_commands_global() {
        let session = terminal_session_id();
        let (consume_reply, _) = oneshot::channel();
        let (close_reply, _) = oneshot::channel();
        let (fail_reply, _) = oneshot::channel();
        let (close_current_reply, _) = oneshot::channel();
        let (begin_current_reply, _) = oneshot::channel();
        let (finish_current_reply, _) = oneshot::channel();
        let (reconnect_reply, _) = oneshot::channel();
        let (begin_reply, _) = oneshot::channel();
        let (finish_reply, _) = oneshot::channel();

        let commands = [
            FleetCommand::TerminalConsumeTicket {
                ticket: vec![1, 2, 3],
                reply: consume_reply,
            },
            FleetCommand::TerminalClose {
                session: session.clone(),
                generation: fleet::terminal::Generation::FIRST,
                reply: close_reply,
            },
            FleetCommand::TerminalFail {
                session: session.clone(),
                generation: fleet::terminal::Generation::FIRST,
                reply: fail_reply,
            },
            FleetCommand::TerminalCloseCurrent {
                session: session.clone(),
                reply: close_current_reply,
            },
            FleetCommand::TerminalBeginCloseCurrent {
                session: session.clone(),
                reply: begin_current_reply,
            },
            FleetCommand::TerminalFinishCloseCurrent {
                session: session.clone(),
                reply: finish_current_reply,
            },
            FleetCommand::TerminalReconnect {
                session: session.clone(),
                reply: reconnect_reply,
            },
            FleetCommand::TerminalBeginClose {
                session: session.clone(),
                generation: fleet::terminal::Generation::FIRST,
                reply: begin_reply,
            },
            FleetCommand::TerminalFinishClose {
                session,
                generation: fleet::terminal::Generation::FIRST,
                reply: finish_reply,
            },
        ];

        for command in commands {
            assert_eq!(command.route_command(), CommandRoute::Global);
        }
    }

    #[test]
    fn routes_dispatch_execution_by_target_and_receipts_by_dispatch_id() {
        let dispatch_id = dispatch_id();
        let target = target_id();
        let (begin_reply, _) = oneshot::channel();
        let (accept_reply, _) = oneshot::channel();
        let (reject_reply, _) = oneshot::channel();
        let (unknown_reply, _) = oneshot::channel();
        let (replay_reply, _) = oneshot::channel();

        assert_eq!(
            FleetCommand::Begin {
                target_id: target.clone(),
                dispatch_id: dispatch_id.clone(),
                reply: begin_reply,
            }
            .route_command(),
            CommandRoute::Keyed(FleetLaneKey::Target(target))
        );

        let commands = [
            FleetCommand::Accept {
                dispatch_id: dispatch_id.clone(),
                attempt: dispatch_attempt(),
                reply: accept_reply,
            },
            FleetCommand::Reject {
                dispatch_id: dispatch_id.clone(),
                attempt: dispatch_attempt(),
                reply: reject_reply,
            },
            FleetCommand::Unknown {
                dispatch_id: dispatch_id.clone(),
                attempt: dispatch_attempt(),
                reply: unknown_reply,
            },
            FleetCommand::Replay {
                command_id: command_id(),
                dispatch_id: dispatch_id.clone(),
                reply: replay_reply,
            },
        ];

        for command in commands {
            assert_eq!(
                command.route_command(),
                CommandRoute::Keyed(FleetLaneKey::Dispatch(dispatch_id.clone()))
            );
        }
    }

    #[test]
    fn routes_connection_probe_execution_by_target_and_facts_by_connection_id() {
        let id = connection_id();
        let target = target_id();
        let (begin_reply, _) = oneshot::channel();
        let (run_reply, _) = oneshot::channel();
        let (complete_reply, _) = oneshot::channel();

        assert_eq!(
            FleetCommand::RunConnectionProbe {
                target_id: target.clone(),
                id: id.clone(),
                command_id: command_id(),
                reply: run_reply,
            }
            .route_command(),
            CommandRoute::Keyed(FleetLaneKey::Target(target))
        );

        let commands = [
            FleetCommand::BeginConnectionProbe {
                id: id.clone(),
                command_id: command_id(),
                reply: begin_reply,
            },
            FleetCommand::CompleteConnectionProbe {
                id: id.clone(),
                command_id: command_id(),
                outcome: fleet::connection::ProbeOutcome::Ready,
                message: None,
                reply: complete_reply,
            },
        ];

        for command in commands {
            assert_eq!(
                command.route_command(),
                CommandRoute::Keyed(FleetLaneKey::Connection(id.clone()))
            );
        }
    }

    #[test]
    fn routes_environment_execution_by_target_and_facts_by_environment_id() {
        let id = environment_id();
        let target = target_id();
        let (run_deploy_reply, _) = oneshot::channel();
        let (run_delete_reply, _) = oneshot::channel();
        let (begin_deploy_reply, _) = oneshot::channel();
        let (complete_deploy_reply, _) = oneshot::channel();
        let (fail_deploy_reply, _) = oneshot::channel();
        let (begin_delete_reply, _) = oneshot::channel();
        let (complete_delete_reply, _) = oneshot::channel();
        let (fail_delete_reply, _) = oneshot::channel();

        let run_commands = [
            FleetCommand::RunEnvironmentDeployment {
                target_id: target.clone(),
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: run_deploy_reply,
            },
            FleetCommand::RunEnvironmentDeletion {
                target_id: target.clone(),
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: run_delete_reply,
            },
        ];
        for command in run_commands {
            assert_eq!(
                command.route_command(),
                CommandRoute::Keyed(FleetLaneKey::Target(target.clone()))
            );
        }

        let fact_commands = [
            FleetCommand::BeginEnvironmentDeployment {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: begin_deploy_reply,
            },
            FleetCommand::CompleteEnvironmentDeployment {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: complete_deploy_reply,
            },
            FleetCommand::FailEnvironmentDeployment {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                message: "failed".to_owned(),
                reply: fail_deploy_reply,
            },
            FleetCommand::BeginEnvironmentDeletion {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: begin_delete_reply,
            },
            FleetCommand::CompleteEnvironmentDeletion {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: complete_delete_reply,
            },
            FleetCommand::FailEnvironmentDeletion {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                message: "failed".to_owned(),
                reply: fail_delete_reply,
            },
        ];

        for command in fact_commands {
            assert_eq!(
                command.route_command(),
                CommandRoute::Keyed(FleetLaneKey::Environment(id.clone()))
            );
        }
    }

    #[test]
    fn routes_resource_execution_by_target_and_facts_by_resource_id() {
        let id = resource_id();
        let target = target_id();
        let (run_provision_reply, _) = oneshot::channel();
        let (run_delete_reply, _) = oneshot::channel();
        let (start_provision_reply, _) = oneshot::channel();
        let (complete_provision_reply, _) = oneshot::channel();
        let (fail_provision_reply, _) = oneshot::channel();
        let (start_delete_reply, _) = oneshot::channel();
        let (complete_delete_reply, _) = oneshot::channel();
        let (fail_delete_reply, _) = oneshot::channel();

        let run_commands = [
            FleetCommand::RunResourceProvisioning {
                target_id: target.clone(),
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: run_provision_reply,
            },
            FleetCommand::RunResourceDeletion {
                target_id: target.clone(),
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: run_delete_reply,
            },
        ];
        for command in run_commands {
            assert_eq!(
                command.route_command(),
                CommandRoute::Keyed(FleetLaneKey::Target(target.clone()))
            );
        }

        let fact_commands = [
            FleetCommand::StartResourceProvisioning {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: start_provision_reply,
            },
            FleetCommand::CompleteResourceProvisioning {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: complete_provision_reply,
            },
            FleetCommand::FailResourceProvisioning {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                message: "failed".to_owned(),
                reply: fail_provision_reply,
            },
            FleetCommand::StartResourceDeletion {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: start_delete_reply,
            },
            FleetCommand::CompleteResourceDeletion {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                reply: complete_delete_reply,
            },
            FleetCommand::FailResourceDeletion {
                id: id.clone(),
                command_id: command_id(),
                phase: phase(),
                message: "failed".to_owned(),
                reply: fail_delete_reply,
            },
        ];

        for command in fact_commands {
            assert_eq!(
                command.route_command(),
                CommandRoute::Keyed(FleetLaneKey::Resource(id.clone()))
            );
        }
    }

    #[test]
    fn keeps_topology_runtime_agent_and_public_mutation_commands_global() {
        let (submit_reply, _) = oneshot::channel();
        let (upsert_connection_reply, _) = oneshot::channel();
        let (delete_connection_reply, _) = oneshot::channel();
        let (begin_runtime_reply, _) = oneshot::channel();
        let (complete_endpoint_reply, _) = oneshot::channel();
        let (capability_reply, _) = oneshot::channel();
        let (runtime_agent_reply, _) = oneshot::channel();

        let command = fleet::command::CommandIntent::new(
            command_id(),
            fleet::command::IdempotencyKey::try_new("idempotency").unwrap(),
            fleet::command::CommandTarget::Node(fleet::topology::NodeId::try_new("node").unwrap()),
            fleet::command::CommandKind::ProbeNode,
            SystemTime::UNIX_EPOCH,
        );
        let dispatch = fleet::outbox::DispatchIntent::new(
            dispatch_id(),
            command.command_id().clone(),
            platform::endpoint::NativeAgentId::try_new("agent").unwrap(),
        );
        let request = fleet::FleetDeliveryRequest::try_new(command, dispatch).unwrap();
        let connection = fleet::connection::ConnectionRecord::new(
            connection_id(),
            fleet::connection::ConnectionKind::Custom,
            "connection".to_owned(),
            SystemTime::UNIX_EPOCH,
        );

        let commands = [
            FleetCommand::Submit {
                request,
                reply: submit_reply,
            },
            FleetCommand::UpsertConnection {
                record: connection,
                reply: upsert_connection_reply,
            },
            FleetCommand::DeleteConnection {
                id: connection_id(),
                reply: delete_connection_reply,
            },
            FleetCommand::BeginRuntimeStart {
                id: fleet::topology::RuntimeId::try_new("runtime").unwrap(),
                command_id: command_id(),
                reply: begin_runtime_reply,
            },
            FleetCommand::CompleteEndpointProbe {
                id: platform::endpoint::EndpointId::try_new("endpoint").unwrap(),
                command_id: command_id(),
                health: fleet::topology::EndpointHealth::Ready,
                reply: complete_endpoint_reply,
            },
            FleetCommand::BeginCapabilitySync {
                id: platform::endpoint::EndpointId::try_new("endpoint").unwrap(),
                command_id: command_id(),
                reply: capability_reply,
            },
            FleetCommand::RegisterRuntimeAgentCommand {
                agent_id: fleet::runtime_agent::RuntimeAgentId::try_new("agent").unwrap(),
                correlation: fleet::runtime_agent::CommandCorrelation::new(
                    command_id(),
                    fleet::command::IdempotencyKey::try_new("idempotency").unwrap(),
                ),
                queued_at: SystemTime::UNIX_EPOCH,
                command_attempt: fleet::command::CommandAttempt::try_new(1).unwrap(),
                dispatch_attempt: dispatch_attempt(),
                reply: runtime_agent_reply,
            },
        ];

        for command in commands {
            assert_eq!(command.route_command(), CommandRoute::Global);
        }
    }

    #[test]
    fn keeps_runtime_agent_ingress_commands_global() {
        let agent_id = runtime_agent_id();
        let correlation = fleet::runtime_agent::CommandCorrelation::new(
            command_id(),
            fleet::command::IdempotencyKey::try_new("idempotency").unwrap(),
        );
        let (auth_reply, _) = oneshot::channel();
        let (agent_reply, _) = oneshot::channel();
        let (command_reply, _) = oneshot::channel();
        let (heartbeat_reply, _) = oneshot::channel();
        let (progress_reply, _) = oneshot::channel();
        let (result_reply, _) = oneshot::channel();

        let commands = [
            FleetCommand::AuthenticateRuntimeAgentIngress {
                identity: fleet::store::AgentIngressIdentity::new(
                    agent_id.clone(),
                    fleet::topology::CredentialHash::try_new("a".repeat(64)).unwrap(),
                    None,
                    SystemTime::UNIX_EPOCH,
                ),
                reply: auth_reply,
            },
            FleetCommand::RegisterRuntimeAgent {
                agent: fleet::runtime_agent::RuntimeAgent::new(agent_id.clone()),
                reply: agent_reply,
            },
            FleetCommand::RegisterRuntimeAgentCommand {
                agent_id: agent_id.clone(),
                correlation: correlation.clone(),
                queued_at: SystemTime::UNIX_EPOCH,
                command_attempt: command_attempt(),
                dispatch_attempt: dispatch_attempt(),
                reply: command_reply,
            },
            FleetCommand::RecordRuntimeAgentHeartbeat {
                agent_id: agent_id.clone(),
                heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat::try_new(
                    SystemTime::UNIX_EPOCH,
                    fleet::runtime_agent::RuntimeAgentStatus::Running,
                    Vec::new(),
                    None,
                )
                .unwrap(),
                reply: heartbeat_reply,
            },
            FleetCommand::RecordRuntimeAgentProgress {
                agent_id: agent_id.clone(),
                correlation: correlation.clone(),
                progress: fleet::runtime_agent::RuntimeAgentProgress::new(
                    fleet::runtime_agent::RuntimeAgentProgressState::Running,
                    None,
                    None,
                    Some(50),
                ),
                reported_at: SystemTime::UNIX_EPOCH,
                command_attempt: command_attempt(),
                dispatch_attempt: dispatch_attempt(),
                reply: progress_reply,
            },
            FleetCommand::RecordRuntimeAgentResult {
                agent_id,
                correlation,
                result: fleet::runtime_agent::RuntimeAgentResult::Succeeded {
                    completed_at: SystemTime::UNIX_EPOCH,
                },
                command_attempt: command_attempt(),
                dispatch_attempt: dispatch_attempt(),
                reply: result_reply,
            },
        ];

        for command in commands {
            assert_eq!(command.route_command(), CommandRoute::Global);
        }
    }

    #[test]
    fn keeps_terminal_list_query_global() {
        let (reply, _) = oneshot::channel();

        assert_eq!(
            FleetQuery::TerminalList { reply }.route_query(),
            QueryRoute::Global
        );
    }

    #[test]
    fn routes_durable_queries_exclusive() {
        let summary = terminal_summary();
        let (context_reply, _) = oneshot::channel();
        let (resolve_reply, _) = oneshot::channel();
        let (query_snapshot_reply, _) = oneshot::channel();
        let (snapshot_reply, _) = oneshot::channel();
        let (selector_preview_reply, _) = oneshot::channel();
        let (target_summaries_reply, _) = oneshot::channel();
        let (target_selector_reply, _) = oneshot::channel();
        let (topology_reply, _) = oneshot::channel();
        let (node_command_reply, _) = oneshot::channel();
        let (dispatch_target_reply, _) = oneshot::channel();
        let (connection_target_reply, _) = oneshot::channel();
        let (environment_target_reply, _) = oneshot::channel();
        let (resource_target_reply, _) = oneshot::channel();

        let queries = [
            FleetQuery::TerminalContext {
                summary: summary.clone(),
                reply: context_reply,
            },
            FleetQuery::TerminalResolveContext {
                selector: crate::owner::actor::FleetTerminalTargetSelector::Target(
                    fleet::terminal::TargetId::try_new("target").unwrap(),
                ),
                summary,
                reply: resolve_reply,
            },
            FleetQuery::QuerySnapshot {
                now: SystemTime::UNIX_EPOCH,
                reply: query_snapshot_reply,
            },
            FleetQuery::Snapshot {
                now: SystemTime::UNIX_EPOCH,
                reply: snapshot_reply,
            },
            FleetQuery::SelectorPreview {
                constraints: fleet::query::SelectorConstraints::try_new(
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                )
                .unwrap(),
                now: SystemTime::UNIX_EPOCH,
                reply: selector_preview_reply,
            },
            FleetQuery::TargetSummaries {
                reply: target_summaries_reply,
            },
            FleetQuery::TargetSelector {
                id: target_id(),
                revision: 1,
                kind: fleet::TargetKind::Custom,
                reply: target_selector_reply,
            },
            FleetQuery::TopologySummary {
                reply: topology_reply,
            },
            FleetQuery::NodeCommandRequest {
                request: node_command_request(),
                reply: node_command_reply,
            },
            FleetQuery::DispatchTarget {
                dispatch_id: dispatch_id(),
                reply: dispatch_target_reply,
            },
            FleetQuery::ConnectionTarget {
                id: connection_id(),
                reply: connection_target_reply,
            },
            FleetQuery::EnvironmentTarget {
                id: environment_id(),
                reply: environment_target_reply,
            },
            FleetQuery::ResourceTarget {
                id: resource_id(),
                reply: resource_target_reply,
            },
        ];

        for query in queries {
            assert_eq!(query.route_query(), QueryRoute::Exclusive);
        }
    }
}
