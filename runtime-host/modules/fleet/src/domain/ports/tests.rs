use std::time::SystemTime;

use crate::{
    FleetDispatchOutcome, FleetDispatchPort, FleetDispatchRequest, FleetDispatchRequestError,
    FleetSecretResolution, FleetSecretResolverPort, FleetTopologyPort, FleetTopologySnapshot,
    domain::command::{CommandId, CommandIntent, CommandKind, CommandTarget, IdempotencyKey},
    domain::outbox::{DispatchAttempt, DispatchId, DispatchIntent},
    domain::secret_ref::FleetSecretRef,
    domain::topology::NodeId,
};
use platform::endpoint::NativeAgentId;

fn command(id: &str) -> CommandIntent {
    CommandIntent::new(
        CommandId::try_new(id).unwrap(),
        IdempotencyKey::try_new(format!("key-{id}")).unwrap(),
        CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
        CommandKind::ProbeNode,
        SystemTime::UNIX_EPOCH,
    )
}

struct Boundary {
    dispatched: Option<(CommandId, DispatchId, u64)>,
}

impl FleetTopologyPort for Boundary {
    type Error = ();

    fn observe(&mut self) -> Result<FleetTopologySnapshot, Self::Error> {
        Ok(FleetTopologySnapshot::try_new(Vec::new(), Vec::new(), Vec::new(), Vec::new()).unwrap())
    }
}

impl FleetDispatchPort for Boundary {
    type Error = ();

    fn dispatch(
        &mut self,
        request: &FleetDispatchRequest,
    ) -> Result<FleetDispatchOutcome, Self::Error> {
        self.dispatched = Some((
            request.command_id().clone(),
            request.dispatch().dispatch_id().clone(),
            request.attempt().sequence(),
        ));
        Ok(FleetDispatchOutcome::Accepted)
    }
}

struct OpaqueSecret;

impl FleetSecretResolverPort for Boundary {
    type Secret = OpaqueSecret;
    type Error = ();

    fn resolve(
        &mut self,
        _: &FleetSecretRef,
    ) -> Result<FleetSecretResolution<Self::Secret>, Self::Error> {
        Ok(FleetSecretResolution::AccessDenied)
    }
}

#[test]
fn topology_port_returns_a_validated_snapshot() {
    let mut boundary = Boundary { dispatched: None };

    let snapshot = boundary.observe().unwrap();

    assert!(snapshot.nodes().is_empty());
    assert!(snapshot.workloads().is_empty());
    assert!(snapshot.runtimes().is_empty());
    assert!(snapshot.endpoints().is_empty());
}

#[test]
fn dispatch_request_keeps_command_dispatch_and_attempt_correlated() {
    let command = command("command-1");
    let dispatch = DispatchIntent::new(
        DispatchId::try_new("dispatch-1").unwrap(),
        command.command_id().clone(),
        NativeAgentId::try_new("agent-1").unwrap(),
    );
    let request =
        FleetDispatchRequest::try_new(command, dispatch, DispatchAttempt::try_new(3).unwrap())
            .unwrap();
    let mut boundary = Boundary { dispatched: None };

    assert_eq!(
        boundary.dispatch(&request),
        Ok(FleetDispatchOutcome::Accepted)
    );
    assert_eq!(
        boundary.dispatched,
        Some((
            CommandId::try_new("command-1").unwrap(),
            DispatchId::try_new("dispatch-1").unwrap(),
            3,
        ))
    );
    assert_eq!(request.dispatch().agent_id().as_str(), "agent-1");
    assert_eq!(request.operation_kind(), CommandKind::ProbeNode);
    assert_eq!(request.operation_target().node_id().as_str(), "node-1");
    assert!(request.target_selector().is_none());
}

#[test]
fn dispatch_request_rejects_a_dispatch_for_another_command() {
    let error = FleetDispatchRequest::try_new(
        command("command-1"),
        DispatchIntent::new(
            DispatchId::try_new("dispatch-1").unwrap(),
            CommandId::try_new("command-2").unwrap(),
            NativeAgentId::try_new("agent-1").unwrap(),
        ),
        DispatchAttempt::try_new(1).unwrap(),
    )
    .unwrap_err();

    assert_eq!(error, FleetDispatchRequestError::MismatchedCommand);
    assert_eq!(
        error.to_string(),
        "Fleet dispatch intent must reference its command"
    );
}

#[test]
fn secret_resolution_preserves_non_plaintext_failure() {
    let mut boundary = Boundary { dispatched: None };
    let reference = FleetSecretRef::parse("remote-fleet://production/bootstrap-token").unwrap();

    assert!(matches!(
        boundary.resolve(&reference),
        Ok(FleetSecretResolution::AccessDenied)
    ));
}
