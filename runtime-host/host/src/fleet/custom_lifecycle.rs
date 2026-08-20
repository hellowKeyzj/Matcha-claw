//! Producer-owned Custom Fleet lifecycle seam.
//!
//! The only source-backed Custom peer protocol in this checkout is the
//! RuntimeAgent command admission/result protocol.  Probe and agent install
//! therefore use `runtime-agent.command.accept` and require a later ingress
//! result for completion.  Deploy and delete have no authoritative peer wire
//! operation here and are rejected explicitly; they must not be reported as
//! unavailable or completed by this adapter.

use std::{
    fmt,
    time::{Duration, SystemTime},
};

use fleet::{
    CustomTargetConfig, FleetDispatchRequest, FleetSecretResolverPort, RuntimeAgentEndpointConfig,
    command::{CommandAttempt, CommandId, CommandIntent, CommandKind, IdempotencyKey},
    environment::ManagedResourceLifecycleContext,
    outbox::DispatchAttempt,
    reachability::RuntimeAgentCallbackEndpoint,
    runtime_agent::{RuntimeAgentCommand, RuntimeAgentResult},
};
use platform::endpoint::NativeAgentId;
use tokio::time::timeout;

use super::runtime_agent::RuntimeAgentOutcome;

/// Existing RuntimeAgent peer message types used by this seam.
pub(crate) const RUNTIME_AGENT_COMMAND_ACCEPT: &str = "runtime-agent.command.accept";
pub(crate) const RUNTIME_AGENT_COMMAND_ACCEPT_RESPONSE: &str =
    "runtime-agent.command.accept.response";
pub(crate) const RUNTIME_AGENT_COMMAND_PROGRESS: &str = "runtime-agent.command.progress";
pub(crate) const RUNTIME_AGENT_COMMAND_RESULT: &str = "runtime-agent.command.result";

pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomLifecycleOperation {
    Probe,
    Install,
    Deploy,
    Delete,
}

impl CustomLifecycleOperation {
    pub(crate) const fn authority(self) -> CustomLifecycleAuthority {
        match self {
            Self::Probe | Self::Install => CustomLifecycleAuthority::RuntimeAgentCommand,
            Self::Deploy | Self::Delete => CustomLifecycleAuthority::UnsupportedPeerProtocol,
        }
    }

    pub(crate) const fn command_kind(self) -> Option<CommandKind> {
        match self {
            Self::Probe => Some(CommandKind::ProbeNode),
            Self::Install => Some(CommandKind::InstallAgent),
            Self::Deploy | Self::Delete => None,
        }
    }

    pub(crate) const fn wire_command_name(self) -> Option<&'static str> {
        match self {
            Self::Probe => Some("probe-node"),
            Self::Install => Some("install-agent"),
            Self::Deploy | Self::Delete => None,
        }
    }

    pub(crate) const fn from_command_kind(kind: CommandKind) -> Option<Self> {
        match kind {
            CommandKind::ProbeNode => Some(Self::Probe),
            CommandKind::InstallAgent => Some(Self::Install),
            CommandKind::StartRuntime
            | CommandKind::StopRuntime
            | CommandKind::SyncCapabilities
            | CommandKind::UpgradeAgent
            | CommandKind::MountWorkspace
            | CommandKind::ExposePort => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomLifecycleAuthority {
    RuntimeAgentCommand,
    UnsupportedPeerProtocol,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomReceiptOutcome {
    Accepted,
    Completed,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomReadbackEvidence {
    AdmissionAccepted,
    RuntimeAgentPending,
    PeerSucceeded,
    PeerFailed,
    PeerCancelled,
    PeerTimedOut,
    ReadbackUnavailable,
    AgentMismatch,
    CorrelationMismatch,
    AttemptMismatch,
    UnsupportedOperation,
    DispatchRejected,
    TransportUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomReceiptReason {
    AdmissionAccepted,
    ReadbackPending,
    PeerSucceeded,
    PeerFailed,
    PeerCancelled,
    PeerTimedOut,
    ReadbackUnavailable,
    AgentMismatch,
    CorrelationMismatch,
    AttemptMismatch,
    UnsupportedOperation,
    DispatchRejected,
    TransportUnknown,
}

impl fmt::Display for CustomReceiptReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AdmissionAccepted => "RuntimeAgent accepted the command",
            Self::ReadbackPending => "RuntimeAgent has not reported a terminal result",
            Self::PeerSucceeded => "RuntimeAgent reported success",
            Self::PeerFailed => "RuntimeAgent reported failure",
            Self::PeerCancelled => "RuntimeAgent reported cancellation",
            Self::PeerTimedOut => "RuntimeAgent reported a peer timeout",
            Self::ReadbackUnavailable => "RuntimeAgent command readback is unavailable",
            Self::AgentMismatch => "RuntimeAgent readback belongs to another agent",
            Self::CorrelationMismatch => "RuntimeAgent readback correlation does not match",
            Self::AttemptMismatch => "RuntimeAgent readback attempt does not match",
            Self::UnsupportedOperation => "Custom peer has no authoritative lifecycle operation",
            Self::DispatchRejected => "RuntimeAgent rejected the command admission",
            Self::TransportUnknown => "RuntimeAgent command outcome is unknown",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CustomLifecycleRequestError {
    ZeroTimeout,
    DeadlineOutOfRange,
    AttemptMismatch,
    InvalidCommandAttempt,
    CommandMismatch,
    MissingRuntimeAgentEndpoint,
    InvalidRuntimeAgentEndpoint,
}

impl fmt::Display for CustomLifecycleRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ZeroTimeout => "Custom lifecycle timeout must be positive",
            Self::DeadlineOutOfRange => "Custom lifecycle deadline is outside the supported range",
            Self::AttemptMismatch => "Custom lifecycle command and dispatch attempts must match",
            Self::InvalidCommandAttempt => "Custom lifecycle command attempt is invalid",
            Self::CommandMismatch => "Custom lifecycle operation does not match the command kind",
            Self::MissingRuntimeAgentEndpoint => {
                "Custom lifecycle RuntimeAgent endpoint is missing"
            }
            Self::InvalidRuntimeAgentEndpoint => {
                "Custom lifecycle RuntimeAgent endpoint is invalid"
            }
        })
    }
}

impl std::error::Error for CustomLifecycleRequestError {}

/// Safe, immutable inputs for one Custom peer command.
///
/// The request carries only a secret reference through the endpoint config;
/// plaintext is resolved by the existing RuntimeAgent adapter for the request
/// lifetime and is never copied into this request or its receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CustomLifecycleRequest {
    operation: CustomLifecycleOperation,
    authority: CustomLifecycleAuthority,
    runtime_agent: Option<RuntimeAgentEndpointConfig>,
    agent_id: NativeAgentId,
    command: CommandIntent,
    command_attempt: CommandAttempt,
    dispatch_attempt: DispatchAttempt,
    timeout: Duration,
    issued_at: SystemTime,
    deadline: SystemTime,
    lifecycle_context: ManagedResourceLifecycleContext,
}

impl CustomLifecycleRequest {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn try_new(
        config: &CustomTargetConfig,
        operation: CustomLifecycleOperation,
        agent_id: NativeAgentId,
        command: CommandIntent,
        command_attempt: CommandAttempt,
        dispatch_attempt: DispatchAttempt,
        timeout: Duration,
        issued_at: SystemTime,
        lifecycle_context: ManagedResourceLifecycleContext,
    ) -> Result<Self, CustomLifecycleRequestError> {
        if timeout.is_zero() {
            return Err(CustomLifecycleRequestError::ZeroTimeout);
        }
        if command_attempt.sequence() != dispatch_attempt.sequence() {
            return Err(CustomLifecycleRequestError::AttemptMismatch);
        }
        if operation
            .command_kind()
            .is_some_and(|kind| command.kind() != kind)
        {
            return Err(CustomLifecycleRequestError::CommandMismatch);
        }
        let runtime_agent = config.runtime_agent().cloned();
        if operation.authority() == CustomLifecycleAuthority::RuntimeAgentCommand {
            let endpoint = runtime_agent
                .as_ref()
                .ok_or(CustomLifecycleRequestError::MissingRuntimeAgentEndpoint)?;
            validate_runtime_agent_endpoint(endpoint.endpoint_url())?;
        }
        let deadline = issued_at
            .checked_add(timeout)
            .ok_or(CustomLifecycleRequestError::DeadlineOutOfRange)?;
        Ok(Self {
            operation,
            authority: operation.authority(),
            runtime_agent,
            agent_id,
            command,
            command_attempt,
            dispatch_attempt,
            timeout,
            issued_at,
            deadline,
            lifecycle_context,
        })
    }

    /// Build the request from the canonical durable dispatch context.
    ///
    /// The dispatch request is the only source for the command target,
    /// idempotency key, native agent identity, and dispatch attempt. Lifecycle
    /// ownership facts remain a discriminated domain projection: unavailable
    /// and not-applicable are never replaced with synthetic enum values.
    pub(crate) fn try_from_dispatch_request(
        config: &CustomTargetConfig,
        operation: CustomLifecycleOperation,
        dispatch: &FleetDispatchRequest,
        timeout: Duration,
        issued_at: SystemTime,
        lifecycle_context: ManagedResourceLifecycleContext,
    ) -> Result<Self, CustomLifecycleRequestError> {
        let command_attempt = CommandAttempt::try_new(dispatch.attempt().sequence())
            .map_err(|_| CustomLifecycleRequestError::InvalidCommandAttempt)?;
        Self::try_new(
            config,
            operation,
            dispatch.agent_id().clone(),
            dispatch.command().clone(),
            command_attempt,
            dispatch.attempt().clone(),
            timeout,
            issued_at,
            lifecycle_context,
        )
    }

    pub(crate) const fn operation(&self) -> CustomLifecycleOperation {
        self.operation
    }

    pub(crate) const fn authority(&self) -> CustomLifecycleAuthority {
        self.authority
    }

    pub(crate) fn runtime_agent(&self) -> Option<&RuntimeAgentEndpointConfig> {
        self.runtime_agent.as_ref()
    }

    pub(crate) fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub(crate) fn command(&self) -> &CommandIntent {
        &self.command
    }

    pub(crate) fn command_id(&self) -> &CommandId {
        self.command.command_id()
    }

    pub(crate) fn idempotency_key(&self) -> &IdempotencyKey {
        self.command.idempotency_key()
    }

    pub(crate) const fn command_attempt(&self) -> &CommandAttempt {
        &self.command_attempt
    }

    pub(crate) const fn dispatch_attempt(&self) -> &DispatchAttempt {
        &self.dispatch_attempt
    }

    pub(crate) const fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(crate) const fn issued_at(&self) -> SystemTime {
        self.issued_at
    }

    pub(crate) const fn deadline(&self) -> SystemTime {
        self.deadline
    }

    pub(crate) const fn lifecycle_context(&self) -> ManagedResourceLifecycleContext {
        self.lifecycle_context
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CustomLifecycleReceipt {
    operation: CustomLifecycleOperation,
    authority: CustomLifecycleAuthority,
    agent_id: NativeAgentId,
    command_id: CommandId,
    idempotency_key: IdempotencyKey,
    command_attempt: CommandAttempt,
    dispatch_attempt: DispatchAttempt,
    outcome: CustomReceiptOutcome,
    reason: CustomReceiptReason,
    readback: CustomReadbackEvidence,
    issued_at: SystemTime,
    deadline: SystemTime,
    observed_at: SystemTime,
    lifecycle_context: ManagedResourceLifecycleContext,
}

impl CustomLifecycleReceipt {
    pub(crate) const fn operation(&self) -> CustomLifecycleOperation {
        self.operation
    }

    pub(crate) const fn authority(&self) -> CustomLifecycleAuthority {
        self.authority
    }

    pub(crate) fn agent_id(&self) -> &NativeAgentId {
        &self.agent_id
    }

    pub(crate) fn command_id(&self) -> &CommandId {
        &self.command_id
    }

    pub(crate) fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    pub(crate) const fn command_attempt(&self) -> &CommandAttempt {
        &self.command_attempt
    }

    pub(crate) const fn dispatch_attempt(&self) -> &DispatchAttempt {
        &self.dispatch_attempt
    }

    pub(crate) const fn outcome(&self) -> CustomReceiptOutcome {
        self.outcome
    }

    pub(crate) const fn reason(&self) -> CustomReceiptReason {
        self.reason
    }

    pub(crate) const fn readback(&self) -> CustomReadbackEvidence {
        self.readback
    }

    pub(crate) const fn issued_at(&self) -> SystemTime {
        self.issued_at
    }

    pub(crate) const fn deadline(&self) -> SystemTime {
        self.deadline
    }

    pub(crate) const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }

    pub(crate) const fn lifecycle_context(&self) -> ManagedResourceLifecycleContext {
        self.lifecycle_context
    }
}

/// Admit a supported Custom command through the existing RuntimeAgent peer.
///
/// Admission is never completion.  The returned receipt is `Accepted` until
/// `readback_receipt` observes a matching terminal result from Fleet ingress.
/// A transport timeout or malformed response is `Unknown`.
pub(crate) async fn dispatch<R>(
    request: &CustomLifecycleRequest,
    callback: &RuntimeAgentCallbackEndpoint,
    resolver: &mut R,
) -> CustomLifecycleReceipt
where
    R: FleetSecretResolverPort,
    R::Secret: AsRef<str>,
{
    let observed_at = SystemTime::now();
    if request.authority != CustomLifecycleAuthority::RuntimeAgentCommand {
        return request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::UnsupportedOperation,
            CustomReadbackEvidence::UnsupportedOperation,
            observed_at,
        );
    }
    let Some(endpoint) = request.runtime_agent.as_ref() else {
        return request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::DispatchRejected,
            CustomReadbackEvidence::DispatchRejected,
            observed_at,
        );
    };
    let result = timeout(
        request.timeout,
        super::runtime_agent::dispatch(
            endpoint,
            callback,
            &request.agent_id,
            &request.command,
            request.dispatch_attempt.sequence(),
            resolver,
        ),
    )
    .await;
    match result {
        Ok(RuntimeAgentOutcome::Accepted) => request.receipt(
            CustomReceiptOutcome::Accepted,
            CustomReceiptReason::AdmissionAccepted,
            CustomReadbackEvidence::AdmissionAccepted,
            SystemTime::now(),
        ),
        Ok(RuntimeAgentOutcome::Rejected) => request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::DispatchRejected,
            CustomReadbackEvidence::DispatchRejected,
            SystemTime::now(),
        ),
        Ok(RuntimeAgentOutcome::Unknown) | Err(_) => request.receipt(
            CustomReceiptOutcome::Unknown,
            CustomReceiptReason::TransportUnknown,
            CustomReadbackEvidence::TransportUnknown,
            SystemTime::now(),
        ),
    }
}

/// Turn a durable RuntimeAgent command fact into a verified Custom receipt.
///
/// `None` means no readback fact was available and therefore remains `Unknown`.
/// Correlation, agent, and both attempt values must match before a terminal
/// result can be trusted.  RuntimeAgent's peer timeout is a definitive
/// rejection; a Host/transport timeout remains `Unknown`.
pub(crate) fn readback_receipt(
    request: &CustomLifecycleRequest,
    reported_agent_id: &NativeAgentId,
    command: Option<&RuntimeAgentCommand>,
    observed_at: SystemTime,
) -> CustomLifecycleReceipt {
    if request.authority != CustomLifecycleAuthority::RuntimeAgentCommand {
        return request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::UnsupportedOperation,
            CustomReadbackEvidence::UnsupportedOperation,
            observed_at,
        );
    }
    if request.agent_id != *reported_agent_id {
        return request.receipt(
            CustomReceiptOutcome::Unknown,
            CustomReceiptReason::AgentMismatch,
            CustomReadbackEvidence::AgentMismatch,
            observed_at,
        );
    }
    let Some(command) = command else {
        return request.receipt(
            CustomReceiptOutcome::Unknown,
            CustomReceiptReason::ReadbackUnavailable,
            CustomReadbackEvidence::ReadbackUnavailable,
            observed_at,
        );
    };
    if command.correlation().command_id() != request.command_id()
        || command.correlation().idempotency_key() != request.idempotency_key()
    {
        return request.receipt(
            CustomReceiptOutcome::Unknown,
            CustomReceiptReason::CorrelationMismatch,
            CustomReadbackEvidence::CorrelationMismatch,
            observed_at,
        );
    }
    if command.command_attempt() != Some(request.command_attempt.sequence())
        || command.dispatch_attempt() != Some(request.dispatch_attempt.sequence())
    {
        return request.receipt(
            CustomReceiptOutcome::Unknown,
            CustomReceiptReason::AttemptMismatch,
            CustomReadbackEvidence::AttemptMismatch,
            observed_at,
        );
    }
    match command.result() {
        None => request.receipt(
            CustomReceiptOutcome::Accepted,
            CustomReceiptReason::ReadbackPending,
            CustomReadbackEvidence::RuntimeAgentPending,
            observed_at,
        ),
        Some(RuntimeAgentResult::Succeeded { .. }) => request.receipt(
            CustomReceiptOutcome::Completed,
            CustomReceiptReason::PeerSucceeded,
            CustomReadbackEvidence::PeerSucceeded,
            observed_at,
        ),
        Some(RuntimeAgentResult::Failed { .. }) => request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::PeerFailed,
            CustomReadbackEvidence::PeerFailed,
            observed_at,
        ),
        Some(RuntimeAgentResult::Cancelled { .. }) => request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::PeerCancelled,
            CustomReadbackEvidence::PeerCancelled,
            observed_at,
        ),
        Some(RuntimeAgentResult::TimedOut { .. }) => request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::PeerTimedOut,
            CustomReadbackEvidence::PeerTimedOut,
            observed_at,
        ),
    }
}

impl CustomLifecycleRequest {
    fn receipt(
        &self,
        outcome: CustomReceiptOutcome,
        reason: CustomReceiptReason,
        readback: CustomReadbackEvidence,
        observed_at: SystemTime,
    ) -> CustomLifecycleReceipt {
        CustomLifecycleReceipt {
            operation: self.operation,
            authority: self.authority,
            agent_id: self.agent_id.clone(),
            command_id: self.command.command_id().clone(),
            idempotency_key: self.command.idempotency_key().clone(),
            command_attempt: self.command_attempt.clone(),
            dispatch_attempt: self.dispatch_attempt.clone(),
            outcome,
            reason,
            readback,
            issued_at: self.issued_at,
            deadline: self.deadline,
            observed_at,
            lifecycle_context: self.lifecycle_context,
        }
    }
}

fn validate_runtime_agent_endpoint(value: &str) -> Result<(), CustomLifecycleRequestError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| CustomLifecycleRequestError::InvalidRuntimeAgentEndpoint)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CustomLifecycleRequestError::InvalidRuntimeAgentEndpoint);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet::{
        CustomTargetConfig, FleetSecretRef,
        command::CommandTarget,
        runtime_agent::{
            CommandCorrelation, RuntimeAgent, RuntimeAgentProgress, RuntimeAgentProgressState,
        },
        topology::NodeId,
    };

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn request(operation: CustomLifecycleOperation, runtime_agent: bool) -> CustomLifecycleRequest {
        let token = FleetSecretRef::parse("remote-fleet://credentials/runtime-agent").unwrap();
        let endpoint = runtime_agent.then(|| {
            RuntimeAgentEndpointConfig::try_new("https://agent.example.test/ingress", token)
                .unwrap()
        });
        let config = CustomTargetConfig::try_new_with_terminal_and_runtime_agent(
            "https://custom.example.test",
            None,
            None,
            endpoint,
        )
        .unwrap();
        let command_kind = operation.command_kind().unwrap_or(CommandKind::ProbeNode);
        let command = CommandIntent::new(
            CommandId::try_new("command-1").unwrap(),
            IdempotencyKey::try_new("idempotency-1").unwrap(),
            CommandTarget::Node(NodeId::try_new("node-1").unwrap()),
            command_kind,
            at(1),
        );
        CustomLifecycleRequest::try_new(
            &config,
            operation,
            NativeAgentId::try_new("agent-1").unwrap(),
            command,
            CommandAttempt::try_new(1).unwrap(),
            DispatchAttempt::try_new(1).unwrap(),
            Duration::from_secs(5),
            at(1),
            ManagedResourceLifecycleContext::NotApplicable,
        )
        .unwrap()
    }

    #[test]
    fn dispatch_context_preserves_canonical_identity_and_attempts() {
        let token = FleetSecretRef::parse("remote-fleet://credentials/runtime-agent").unwrap();
        let endpoint =
            RuntimeAgentEndpointConfig::try_new("https://agent.example.test/ingress", token)
                .unwrap();
        let config = CustomTargetConfig::try_new_with_terminal_and_runtime_agent(
            "https://custom.example.test",
            None,
            None,
            Some(endpoint),
        )
        .unwrap();
        let command = CommandIntent::new(
            CommandId::try_new("command-context").unwrap(),
            IdempotencyKey::try_new("idempotency-context").unwrap(),
            CommandTarget::Node(NodeId::try_new("node-context").unwrap()),
            CommandKind::ProbeNode,
            at(1),
        );
        let agent_id = NativeAgentId::try_new("agent-context").unwrap();
        let dispatch = fleet::outbox::DispatchIntent::new(
            fleet::outbox::DispatchId::try_new("dispatch-context").unwrap(),
            command.command_id().clone(),
            agent_id.clone(),
        );
        let dispatch_request =
            FleetDispatchRequest::try_new(command, dispatch, DispatchAttempt::try_new(2).unwrap())
                .unwrap();
        let request = CustomLifecycleRequest::try_from_dispatch_request(
            &config,
            CustomLifecycleOperation::Probe,
            &dispatch_request,
            Duration::from_secs(5),
            at(1),
            ManagedResourceLifecycleContext::NotApplicable,
        )
        .unwrap();

        assert_eq!(request.agent_id(), &agent_id);
        assert_eq!(request.command_id().as_str(), "command-context");
        assert_eq!(request.idempotency_key().as_str(), "idempotency-context");
        assert_eq!(
            request.command().target().node_id().as_str(),
            "node-context"
        );
        assert_eq!(request.command_attempt().sequence(), 2);
        assert_eq!(request.dispatch_attempt().sequence(), 2);
    }

    fn runtime_command(result: Option<RuntimeAgentResult>) -> RuntimeAgentCommand {
        let agent_id = NativeAgentId::try_new("agent-1").unwrap();
        let correlation = CommandCorrelation::new(
            CommandId::try_new("command-1").unwrap(),
            IdempotencyKey::try_new("idempotency-1").unwrap(),
        );
        let mut agent = RuntimeAgent::new(agent_id.clone());
        agent
            .register_command_with_attempts(
                correlation.clone(),
                at(1),
                CommandAttempt::try_new(1).unwrap(),
                DispatchAttempt::try_new(1).unwrap(),
            )
            .unwrap();
        if let Some(result) = result {
            agent
                .record_result_with_attempt(
                    &agent_id,
                    &correlation,
                    result,
                    Some(&CommandAttempt::try_new(1).unwrap()),
                    Some(&DispatchAttempt::try_new(1).unwrap()),
                )
                .unwrap();
        } else {
            agent
                .record_progress_with_attempt(
                    &agent_id,
                    &correlation,
                    RuntimeAgentProgress::new(RuntimeAgentProgressState::Running, None, None, None),
                    at(2),
                    Some(&CommandAttempt::try_new(1).unwrap()),
                    Some(&DispatchAttempt::try_new(1).unwrap()),
                )
                .unwrap();
        }
        agent.command(correlation.command_id()).unwrap().clone()
    }

    #[test]
    fn supported_operations_use_the_existing_runtime_agent_protocol() {
        assert_eq!(
            CustomLifecycleOperation::Probe.authority(),
            CustomLifecycleAuthority::RuntimeAgentCommand
        );
        assert_eq!(
            CustomLifecycleOperation::Probe.wire_command_name(),
            Some("probe-node")
        );
        assert_eq!(
            CustomLifecycleOperation::Install.command_kind(),
            Some(CommandKind::InstallAgent)
        );
        assert_eq!(
            CustomLifecycleOperation::Deploy.authority(),
            CustomLifecycleAuthority::UnsupportedPeerProtocol
        );
        assert_eq!(CustomLifecycleOperation::Delete.wire_command_name(), None);
        assert_eq!(RUNTIME_AGENT_COMMAND_ACCEPT, "runtime-agent.command.accept");
        assert_eq!(RUNTIME_AGENT_COMMAND_RESULT, "runtime-agent.command.result");
    }

    #[test]
    fn request_rejects_invalid_endpoint_and_mismatched_attempts() {
        let mut valid = request(CustomLifecycleOperation::Probe, true);
        valid.runtime_agent = Some(
            RuntimeAgentEndpointConfig::try_new(
                "https://agent.example.test/ingress?token=secret",
                FleetSecretRef::parse("remote-fleet://credentials/runtime-agent").unwrap(),
            )
            .unwrap(),
        );
        assert_eq!(
            CustomLifecycleRequest::try_new(
                &CustomTargetConfig::try_new_with_terminal_and_runtime_agent(
                    "https://custom.example.test",
                    None,
                    None,
                    valid.runtime_agent.clone()
                )
                .unwrap(),
                CustomLifecycleOperation::Probe,
                valid.agent_id.clone(),
                valid.command.clone(),
                CommandAttempt::try_new(1).unwrap(),
                DispatchAttempt::try_new(1).unwrap(),
                valid.timeout,
                valid.issued_at,
                valid.lifecycle_context,
            )
            .unwrap_err(),
            CustomLifecycleRequestError::InvalidRuntimeAgentEndpoint
        );
        assert_eq!(
            CustomLifecycleRequest::try_new(
                &CustomTargetConfig::try_new("https://custom.example.test", None).unwrap(),
                CustomLifecycleOperation::Deploy,
                valid.agent_id,
                valid.command,
                CommandAttempt::try_new(1).unwrap(),
                DispatchAttempt::try_new(2).unwrap(),
                Duration::from_secs(1),
                at(1),
                ManagedResourceLifecycleContext::NotApplicable,
            )
            .unwrap_err(),
            CustomLifecycleRequestError::AttemptMismatch
        );
    }

    #[test]
    fn unsupported_lifecycle_is_an_explicit_rejection_not_unavailable() {
        let request = request(CustomLifecycleOperation::Deploy, false);
        let receipt = request.receipt(
            CustomReceiptOutcome::Rejected,
            CustomReceiptReason::UnsupportedOperation,
            CustomReadbackEvidence::UnsupportedOperation,
            at(2),
        );
        assert_eq!(receipt.outcome(), CustomReceiptOutcome::Rejected);
        assert_eq!(receipt.reason(), CustomReceiptReason::UnsupportedOperation);
        assert_eq!(
            receipt.authority(),
            CustomLifecycleAuthority::UnsupportedPeerProtocol
        );
    }

    #[test]
    fn readback_requires_full_correlation_and_attempts() {
        let request = request(CustomLifecycleOperation::Probe, true);
        let agent = NativeAgentId::try_new("agent-1").unwrap();
        let completed = runtime_command(Some(RuntimeAgentResult::Succeeded {
            completed_at: at(3),
        }));
        let receipt = readback_receipt(&request, &agent, Some(&completed), at(3));
        assert_eq!(receipt.outcome(), CustomReceiptOutcome::Completed);
        assert_eq!(receipt.readback(), CustomReadbackEvidence::PeerSucceeded);

        let mismatched = {
            let agent_id = NativeAgentId::try_new("agent-1").unwrap();
            let correlation = CommandCorrelation::new(
                CommandId::try_new("command-other").unwrap(),
                IdempotencyKey::try_new("idempotency-1").unwrap(),
            );
            let mut agent = RuntimeAgent::new(agent_id.clone());
            agent
                .register_command_with_attempts(
                    correlation.clone(),
                    at(1),
                    CommandAttempt::try_new(1).unwrap(),
                    DispatchAttempt::try_new(1).unwrap(),
                )
                .unwrap();
            agent
                .record_progress_with_attempt(
                    &agent_id,
                    &correlation,
                    RuntimeAgentProgress::new(RuntimeAgentProgressState::Running, None, None, None),
                    at(2),
                    Some(&CommandAttempt::try_new(1).unwrap()),
                    Some(&DispatchAttempt::try_new(1).unwrap()),
                )
                .unwrap();
            agent.command(correlation.command_id()).unwrap().clone()
        };
        let receipt = readback_receipt(&request, &agent, Some(&mismatched), at(3));
        assert_eq!(receipt.outcome(), CustomReceiptOutcome::Unknown);
        assert_eq!(receipt.reason(), CustomReceiptReason::CorrelationMismatch);
    }

    #[test]
    fn accepted_pending_and_peer_timeout_do_not_fake_completion() {
        let request = request(CustomLifecycleOperation::Install, true);
        let agent = NativeAgentId::try_new("agent-1").unwrap();
        let pending = runtime_command(None);
        assert_eq!(
            readback_receipt(&request, &agent, Some(&pending), at(3)).outcome(),
            CustomReceiptOutcome::Accepted
        );
        let timed_out = runtime_command(Some(RuntimeAgentResult::TimedOut {
            completed_at: at(3),
            timeout: Duration::from_secs(5),
        }));
        assert_eq!(
            readback_receipt(&request, &agent, Some(&timed_out), at(3)).outcome(),
            CustomReceiptOutcome::Rejected
        );
        assert_eq!(
            readback_receipt(&request, &agent, None, at(3)).outcome(),
            CustomReceiptOutcome::Unknown
        );
    }

    #[test]
    fn receipt_keeps_correlation_and_discriminated_lifecycle_context_without_secret_material() {
        let request = request(CustomLifecycleOperation::Probe, true);
        let receipt = request.receipt(
            CustomReceiptOutcome::Accepted,
            CustomReceiptReason::AdmissionAccepted,
            CustomReadbackEvidence::AdmissionAccepted,
            at(2),
        );
        assert_eq!(receipt.command_id().as_str(), "command-1");
        assert_eq!(receipt.idempotency_key().as_str(), "idempotency-1");
        assert_eq!(receipt.command_attempt().sequence(), 1);
        assert_eq!(receipt.dispatch_attempt().sequence(), 1);
        assert_eq!(
            receipt.lifecycle_context(),
            ManagedResourceLifecycleContext::NotApplicable
        );
        assert!(!format!("{request:?}{receipt:?}").contains("secret-value"));

        let mut unavailable = request.clone();
        unavailable.lifecycle_context = ManagedResourceLifecycleContext::Unavailable;
        assert_eq!(
            unavailable
                .receipt(
                    CustomReceiptOutcome::Unknown,
                    CustomReceiptReason::ReadbackUnavailable,
                    CustomReadbackEvidence::ReadbackUnavailable,
                    at(3),
                )
                .lifecycle_context(),
            ManagedResourceLifecycleContext::Unavailable
        );

        let mut source_backed = request;
        source_backed.lifecycle_context = ManagedResourceLifecycleContext::SourceBacked {
            ownership: fleet::environment::Ownership::MatchaManaged,
            cleanup_policy: fleet::environment::CleanupPolicy::DeleteOnEnvironmentDelete,
        };
        assert_eq!(
            source_backed
                .receipt(
                    CustomReceiptOutcome::Accepted,
                    CustomReceiptReason::AdmissionAccepted,
                    CustomReadbackEvidence::AdmissionAccepted,
                    at(3),
                )
                .lifecycle_context(),
            ManagedResourceLifecycleContext::SourceBacked {
                ownership: fleet::environment::Ownership::MatchaManaged,
                cleanup_policy: fleet::environment::CleanupPolicy::DeleteOnEnvironmentDelete,
            }
        );
    }
}
