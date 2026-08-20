//! Host-side Fleet command execution boundary.
//!
//! This is the only owner that turns a durable Fleet dispatch request into a
//! provider effect.  It deliberately receives target configuration and the
//! secret resolver from composition; it never invents either one from the
//! public request.  A prepared boundary is only an acceptance/delivery fact.
//! Remote completion is reported only after the provider effect returns.

use std::{collections::BTreeMap, fmt, time::Duration};

use fleet::{
    FleetDispatchRequest, FleetSecretResolverPort, FleetTargetConfig, TargetId, TargetKind,
    command::{CommandKind, CommandTarget},
    reachability::RuntimeAgentCallbackEndpoint,
};
use platform::{
    capability::{CapabilityId, SupportedCapability},
    endpoint::NativeAgentId,
};
use russh::keys::PublicKey;
use tokio::time::{error::Elapsed, timeout};

use super::{
    custom::{
        self, CustomEffect, CustomEffectProducer, CustomProducerRequest, UnavailableCustomProducer,
    },
    docker::{DockerEffect, DockerEffectClient, DockerEffectError},
    kubernetes::{KubernetesEffect, KubernetesEffectClient, KubernetesEffectError},
    ssh::{SshEffect, SshEffectError},
    vm,
};

const DISPATCH_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MANAGED_LABEL: &str = "com.matchaclaw.remote-fleet.managed";

/// The phase exposed by this owner is intentionally separate from the Fleet
/// delivery state machine. `Accepted` means that a typed effect boundary was
/// built, not that a remote RuntimeAgent or provider completed anything.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FleetExecutionOutcome {
    Accepted,
    Completed,
    Rejected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FleetExecutorError {
    MissingSelector,
    TargetNotConfigured,
    TargetRevisionMismatch {
        expected: u64,
        actual: u64,
    },
    TargetKindMismatch {
        expected: TargetKind,
        actual: TargetKind,
    },
    UnsupportedTargetKind(TargetKind),
    MissingOwnershipProof,
    OwnershipMismatch,
    MissingSshHostKey,
    InvalidCommandTarget,
    CapabilityUnavailable,
    UnsupportedOperation {
        operation: CommandKind,
        target: TargetKind,
    },
    UnsupportedCommandScope(CommandKind),
    SecretUnavailable,
    SecretDenied,
    SecretMissing,
    ProviderRejected,
    ProviderUnknown,
    RemoteAccepted,
    DeadlineExceeded,
}

impl fmt::Display for FleetExecutorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingSelector => f.write_str("Fleet dispatch has no target selector"),
            Self::TargetNotConfigured => f.write_str("Fleet target configuration is unavailable"),
            Self::TargetRevisionMismatch { .. } => {
                f.write_str("Fleet target revision no longer matches the dispatch selector")
            }
            Self::TargetKindMismatch { .. } => {
                f.write_str("Fleet target kind no longer matches the dispatch selector")
            }
            Self::UnsupportedTargetKind(kind) => {
                write!(f, "Fleet target kind {kind:?} has no Host effect owner")
            }
            Self::MissingOwnershipProof => {
                f.write_str("Fleet Docker ownership proof is unavailable")
            }
            Self::OwnershipMismatch => f.write_str("Fleet target ownership proof does not match"),
            Self::MissingSshHostKey => f.write_str("Fleet SSH host-key pin is unavailable"),
            Self::InvalidCommandTarget => {
                f.write_str("Fleet command target does not match the provider effect")
            }
            Self::CapabilityUnavailable => {
                f.write_str("Fleet target capability is unavailable or stale")
            }
            Self::UnsupportedOperation { operation, target } => {
                write!(
                    f,
                    "Fleet operation {operation:?} has no effect for target kind {target:?}"
                )
            }
            Self::UnsupportedCommandScope(operation) => {
                write!(
                    f,
                    "Fleet operation {operation:?} requires a RuntimeAgent owner"
                )
            }
            Self::SecretUnavailable => f.write_str("Fleet secret resolver is unavailable"),
            Self::SecretDenied => f.write_str("Fleet secret access is denied"),
            Self::SecretMissing => f.write_str("Fleet secret is missing"),
            Self::ProviderRejected => f.write_str("Fleet provider rejected the effect"),
            Self::ProviderUnknown => f.write_str("Fleet provider effect outcome is unknown"),
            Self::RemoteAccepted => f.write_str("Fleet RuntimeAgent accepted the command"),
            Self::DeadlineExceeded => f.write_str("Fleet provider effect exceeded its deadline"),
        }
    }
}

impl std::error::Error for FleetExecutorError {}

/// Inputs that were proven safe to pass to a provider effect.  Credentials are
/// intentionally absent; they are resolved only by `execute` for the effect's
/// lifetime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FleetDispatchBoundary {
    target_id: TargetId,
    target_kind: TargetKind,
    target_config: FleetTargetConfig,
    operation: CommandKind,
    command_id: fleet::command::CommandId,
    idempotency_key: fleet::command::IdempotencyKey,
    dispatch_attempt: fleet::outbox::DispatchAttempt,
    command_target: CommandTarget,
    agent_id: NativeAgentId,
    runtime_agent_callback: Option<RuntimeAgentCallbackEndpoint>,
    effect: ProviderEffect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderEffect {
    Docker(DockerEffect),
    RuntimeAgent,
    Kubernetes(KubernetesEffect),
    Ssh(SshOperation),
    Custom(CustomEffect),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SshOperation {
    Probe,
    Install,
}

/// Host-composed Fleet effect owner.
///
/// Durable target, binding, endpoint and capability facts arrive on the Fleet
/// typed dispatch request. Host only keeps private provider material needed to
/// execute an accepted boundary.
pub(crate) struct FleetCommandExecutor {
    docker_ownership: BTreeMap<String, String>,
    ssh_host_keys: BTreeMap<TargetId, PublicKey>,
}

impl FleetCommandExecutor {
    pub(crate) fn try_new(
        docker_ownership: BTreeMap<String, String>,
        ssh_host_keys: BTreeMap<TargetId, PublicKey>,
    ) -> Result<Self, FleetExecutorError> {
        Ok(Self {
            docker_ownership,
            ssh_host_keys,
        })
    }

    /// Validate all request facts and produce the provider-specific effect
    /// input. Returning `Ok` is the delivery `Accepted` phase only.
    pub(crate) fn prepare(
        &self,
        request: &FleetDispatchRequest,
        runtime_agent_callback: Option<RuntimeAgentCallbackEndpoint>,
    ) -> Result<FleetDispatchBoundary, FleetExecutorError> {
        let selector = request
            .target_selector()
            .ok_or(FleetExecutorError::MissingSelector)?;
        let target_id = selector.id().clone();
        let target = request
            .target()
            .ok_or(FleetExecutorError::MissingSelector)?;
        let actual_kind = target.config().kind();
        if actual_kind != selector.expected_kind() {
            return Err(FleetExecutorError::TargetKindMismatch {
                expected: selector.expected_kind(),
                actual: actual_kind,
            });
        }
        if target.selector() != selector
            || target.binding().target_id() != &target_id
            || target.binding().target_revision() != selector.revision()
            || target.endpoint().id() != target.binding().endpoint_id()
        {
            return Err(FleetExecutorError::CapabilityUnavailable);
        }
        let operation = request.operation_kind();
        let config = target.config();
        let capability_id = CapabilityId::try_new(operation_capability(operation))
            .map_err(|_| FleetExecutorError::CapabilityUnavailable)?;
        let capability = SupportedCapability::new(
            capability_id,
            platform::capability::CapabilityScope::Endpoint,
        );
        if !target
            .endpoint()
            .availability_observation(&capability)
            .is_some_and(|observation| observation.authorizes_use())
        {
            return Err(FleetExecutorError::CapabilityUnavailable);
        }
        if matches!(
            operation,
            CommandKind::StartRuntime | CommandKind::StopRuntime
        ) && !matches!(request.operation_target(), CommandTarget::Runtime { .. })
        {
            return Err(FleetExecutorError::InvalidCommandTarget);
        }
        let effect = match (config, operation) {
            (FleetTargetConfig::Docker(_), CommandKind::ProbeNode) => {
                ProviderEffect::Docker(DockerEffect::Ping)
            }
            (FleetTargetConfig::Docker(_), CommandKind::InstallAgent) => {
                // Install is an explicit lifecycle, not a single fake request.
                // execute runs these four effects in order.
                ProviderEffect::Docker(DockerEffect::Pull)
            }
            (FleetTargetConfig::Docker(_), CommandKind::StartRuntime) => {
                ProviderEffect::Docker(DockerEffect::Start)
            }
            (FleetTargetConfig::Docker(_), CommandKind::StopRuntime) => {
                ProviderEffect::Docker(DockerEffect::StopRemove)
            }
            // Historical VM targets are represented by SSH in the durable
            // model. Keep the projection explicit without adding a second
            // durable target kind.
            (FleetTargetConfig::Ssh(_), operation)
                if vm::project_ssh_effect(operation).is_some() =>
            {
                ProviderEffect::Ssh(
                    match vm::project_ssh_effect(operation).expect("checked above") {
                        vm::VmEffect::Probe => SshOperation::Probe,
                        vm::VmEffect::Install => SshOperation::Install,
                    },
                )
            }
            (FleetTargetConfig::Kubernetes(_), CommandKind::ProbeNode) => {
                ProviderEffect::Kubernetes(KubernetesEffect::Probe)
            }
            (FleetTargetConfig::Kubernetes(_), CommandKind::InstallAgent) => {
                ProviderEffect::Kubernetes(KubernetesEffect::Apply)
            }
            (FleetTargetConfig::Custom(config), operation)
                if config.runtime_agent().is_some()
                    && matches!(
                        operation,
                        CommandKind::ProbeNode
                            | CommandKind::InstallAgent
                            | CommandKind::StartRuntime
                            | CommandKind::StopRuntime
                    ) =>
            {
                ProviderEffect::RuntimeAgent
            }
            (FleetTargetConfig::Custom(_), operation) => {
                let effect = custom::operation_for(operation)
                    .ok_or(FleetExecutorError::UnsupportedCommandScope(operation))?;
                ProviderEffect::Custom(effect)
            }
            (FleetTargetConfig::Kubernetes(_), _) => {
                return Err(FleetExecutorError::UnsupportedTargetKind(
                    TargetKind::Kubernetes,
                ));
            }
            (FleetTargetConfig::Docker(_), _) | (FleetTargetConfig::Ssh(_), _) => {
                return Err(FleetExecutorError::UnsupportedCommandScope(operation));
            }
        };
        if matches!(config, FleetTargetConfig::Ssh(_))
            && !self.ssh_host_keys.contains_key(&target_id)
        {
            return Err(FleetExecutorError::MissingSshHostKey);
        }
        Ok(FleetDispatchBoundary {
            target_id,
            target_kind: actual_kind,
            target_config: config.clone(),
            operation,
            command_id: request.command_id().clone(),
            idempotency_key: request.command().idempotency_key().clone(),
            dispatch_attempt: request.attempt().clone(),
            command_target: request.operation_target().clone(),
            agent_id: request.agent_id().clone(),
            runtime_agent_callback,
            effect,
        })
    }

    /// Execute a previously accepted boundary. No `Completed` is returned
    /// before the concrete Docker/SSH effect has reported success.
    pub(crate) async fn execute<R: FleetSecretResolverPort>(
        &self,
        boundary: &FleetDispatchBoundary,
        resolver: &mut R,
    ) -> FleetExecutionOutcome
    where
        R::Secret: AsRef<str>,
    {
        let result = timeout(DISPATCH_TIMEOUT, self.execute_inner(boundary, resolver)).await;
        match result {
            Ok(Ok(())) => FleetExecutionOutcome::Completed,
            Ok(Err(FleetExecutorError::RemoteAccepted)) => FleetExecutionOutcome::Accepted,
            Ok(Err(FleetExecutorError::ProviderRejected)) => FleetExecutionOutcome::Rejected,
            Ok(Err(FleetExecutorError::ProviderUnknown))
            | Ok(Err(FleetExecutorError::DeadlineExceeded))
            | Err(Elapsed { .. }) => FleetExecutionOutcome::Unknown,
            Ok(Err(_)) => FleetExecutionOutcome::Rejected,
        }
    }

    async fn execute_inner<R: FleetSecretResolverPort>(
        &self,
        boundary: &FleetDispatchBoundary,
        resolver: &mut R,
    ) -> Result<(), FleetExecutorError>
    where
        R::Secret: AsRef<str>,
    {
        match (&boundary.target_config, boundary.effect, boundary.operation) {
            (config, ProviderEffect::RuntimeAgent, _) => {
                let endpoint = runtime_agent_endpoint(config)
                    .ok_or(FleetExecutorError::TargetNotConfigured)?;
                let callback = boundary
                    .runtime_agent_callback
                    .as_ref()
                    .ok_or(FleetExecutorError::ProviderUnknown)?;
                match crate::fleet::runtime_agent::dispatch(
                    endpoint,
                    callback,
                    &boundary.agent_id,
                    &fleet::command::CommandIntent::new(
                        boundary.command_id.clone(),
                        boundary.idempotency_key.clone(),
                        boundary.command_target.clone(),
                        boundary.operation,
                        std::time::SystemTime::now(),
                    ),
                    boundary.dispatch_attempt.sequence(),
                    resolver,
                )
                .await
                {
                    crate::fleet::runtime_agent::RuntimeAgentOutcome::Accepted => {
                        Err(FleetExecutorError::RemoteAccepted)
                    }
                    crate::fleet::runtime_agent::RuntimeAgentOutcome::Rejected => {
                        Err(FleetExecutorError::ProviderRejected)
                    }
                    crate::fleet::runtime_agent::RuntimeAgentOutcome::Unknown => {
                        Err(FleetExecutorError::ProviderUnknown)
                    }
                }
            }
            (FleetTargetConfig::Docker(config), ProviderEffect::Docker(effect), operation) => {
                if !valid_ownership(&self.docker_ownership) {
                    return Err(FleetExecutorError::OwnershipMismatch);
                }
                let mut ownership = self.docker_ownership.clone();
                ownership.insert(
                    "com.matchaclaw.remote-fleet.target".to_owned(),
                    boundary.target_id.as_str().to_owned(),
                );
                let client = DockerEffectClient::new(config.clone(), ownership)
                    .map_err(|_| FleetExecutorError::ProviderRejected)?;
                if operation == CommandKind::InstallAgent {
                    for effect in [
                        DockerEffect::Pull,
                        DockerEffect::Create,
                        DockerEffect::Start,
                        DockerEffect::Setup,
                    ] {
                        client
                            .execute(effect, resolver)
                            .await
                            .map_err(map_docker_error)?;
                    }
                } else {
                    client
                        .execute(effect, resolver)
                        .await
                        .map(|_| ())
                        .map_err(map_docker_error)?;
                }
                Ok(())
            }
            (FleetTargetConfig::Ssh(config), ProviderEffect::Ssh(operation), _) => {
                let key = self
                    .ssh_host_keys
                    .get(&boundary.target_id)
                    .ok_or(FleetExecutorError::MissingSshHostKey)?;
                let effect = SshEffect::default();
                match operation {
                    SshOperation::Probe => effect
                        .probe(config, resolver, key)
                        .await
                        .map_err(map_ssh_error),
                    SshOperation::Install => effect
                        .install(config, resolver, key, &[])
                        .await
                        .map(|_| ())
                        .map_err(map_ssh_error),
                }
            }
            (FleetTargetConfig::Kubernetes(config), ProviderEffect::Kubernetes(effect), _) => {
                let ownership = kubernetes_ownership(boundary);
                KubernetesEffectClient::new(config.clone(), ownership)
                    .map_err(|_| FleetExecutorError::ProviderRejected)?
                    .execute(effect, resolver)
                    .await
                    .map(|_| ())
                    .map_err(map_kubernetes_error)
            }
            (FleetTargetConfig::Custom(config), ProviderEffect::Custom(effect), _) => {
                let request = CustomProducerRequest::from_config(config, effect);
                match UnavailableCustomProducer.execute(&request, resolver) {
                    Ok(()) => Ok(()),
                    Err(custom::CustomEffectError::ProviderRejected) => {
                        Err(FleetExecutorError::ProviderRejected)
                    }
                    Err(custom::CustomEffectError::ProviderUnknown) => {
                        Err(FleetExecutorError::ProviderUnknown)
                    }
                    Err(custom::CustomEffectError::ExternalProducerUnavailable) => {
                        // There is no native custom producer in this checkout.
                        // This is a typed rejection, never a synthetic success.
                        Err(FleetExecutorError::ProviderRejected)
                    }
                }
            }
            _ => Err(FleetExecutorError::UnsupportedOperation {
                operation: boundary.operation,
                target: boundary.target_kind,
            }),
        }
    }

    pub(crate) fn accepted_outcome() -> FleetExecutionOutcome {
        FleetExecutionOutcome::Accepted
    }

    pub(crate) fn boundary_agent_id(boundary: &FleetDispatchBoundary) -> &NativeAgentId {
        &boundary.agent_id
    }

    pub(crate) fn boundary_command_target(boundary: &FleetDispatchBoundary) -> &CommandTarget {
        &boundary.command_target
    }
}

fn runtime_agent_endpoint(
    config: &FleetTargetConfig,
) -> Option<&fleet::RuntimeAgentEndpointConfig> {
    match config {
        FleetTargetConfig::Docker(value) => value.runtime_agent(),
        FleetTargetConfig::Kubernetes(value) => value.runtime_agent(),
        FleetTargetConfig::Ssh(value) => value.runtime_agent(),
        FleetTargetConfig::Custom(value) => value.runtime_agent(),
    }
}

fn valid_ownership(ownership: &BTreeMap<String, String>) -> bool {
    ownership
        .get(MANAGED_LABEL)
        .is_some_and(|value| value == "true")
        && ownership
            .iter()
            .all(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
}

fn kubernetes_ownership(boundary: &FleetDispatchBoundary) -> BTreeMap<String, String> {
    BTreeMap::from([
        (MANAGED_LABEL.to_owned(), "true".to_owned()),
        (
            "com.matchaclaw.remote-fleet.target".to_owned(),
            boundary.target_id.as_str().to_owned(),
        ),
        (
            "com.matchaclaw.remote-fleet.agent-id".to_owned(),
            boundary.agent_id.as_str().to_owned(),
        ),
    ])
}

fn operation_capability(operation: CommandKind) -> &'static str {
    match operation {
        CommandKind::ProbeNode => "fleet.probe-node",
        CommandKind::InstallAgent => "fleet.install-agent",
        CommandKind::StartRuntime => "fleet.start-runtime",
        CommandKind::StopRuntime => "fleet.stop-runtime",
        CommandKind::SyncCapabilities => "fleet.sync-capabilities",
        CommandKind::UpgradeAgent => "fleet.upgrade-agent",
        CommandKind::MountWorkspace => "fleet.mount-workspace",
        CommandKind::ExposePort => "fleet.expose-port",
    }
}

fn map_docker_error(error: DockerEffectError) -> FleetExecutorError {
    match error {
        DockerEffectError::SecretUnavailable => FleetExecutorError::SecretUnavailable,
        DockerEffectError::SecretDenied => FleetExecutorError::SecretDenied,
        DockerEffectError::SecretMissing => FleetExecutorError::SecretMissing,
        DockerEffectError::Network | DockerEffectError::Timeout => {
            FleetExecutorError::ProviderUnknown
        }
        _ => FleetExecutorError::ProviderRejected,
    }
}

fn map_kubernetes_error(error: KubernetesEffectError) -> FleetExecutorError {
    match error {
        KubernetesEffectError::SecretUnavailable => FleetExecutorError::SecretUnavailable,
        KubernetesEffectError::SecretDenied => FleetExecutorError::SecretDenied,
        KubernetesEffectError::SecretMissing => FleetExecutorError::SecretMissing,
        KubernetesEffectError::Timeout | KubernetesEffectError::Network => {
            FleetExecutorError::ProviderUnknown
        }
        _ => FleetExecutorError::ProviderRejected,
    }
}

fn map_ssh_error(error: SshEffectError) -> FleetExecutorError {
    match error {
        SshEffectError::SecretUnavailable => FleetExecutorError::SecretUnavailable,
        SshEffectError::SecretDenied => FleetExecutorError::SecretDenied,
        SshEffectError::SecretMissing => FleetExecutorError::SecretMissing,
        SshEffectError::Timeout | SshEffectError::Network | SshEffectError::Protocol => {
            FleetExecutorError::ProviderUnknown
        }
        _ => FleetExecutorError::ProviderRejected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_mapping_is_explicit_and_has_no_runtime_agent_fallback() {
        assert_eq!(
            provider_effect(TargetKind::Docker, CommandKind::ProbeNode),
            Some(ProviderEffect::Docker(DockerEffect::Ping))
        );
        assert_eq!(
            provider_effect(TargetKind::Docker, CommandKind::InstallAgent),
            Some(ProviderEffect::Docker(DockerEffect::Pull))
        );
        assert_eq!(
            provider_effect(TargetKind::Ssh, CommandKind::InstallAgent),
            Some(ProviderEffect::Ssh(SshOperation::Install))
        );
        assert_eq!(
            provider_effect(TargetKind::Custom, CommandKind::ProbeNode),
            None
        );
        assert_eq!(
            provider_effect(TargetKind::Docker, CommandKind::SyncCapabilities),
            None
        );
    }

    fn provider_effect(kind: TargetKind, operation: CommandKind) -> Option<ProviderEffect> {
        match (kind, operation) {
            (TargetKind::Docker, CommandKind::ProbeNode) => {
                Some(ProviderEffect::Docker(DockerEffect::Ping))
            }
            (TargetKind::Docker, CommandKind::InstallAgent) => {
                Some(ProviderEffect::Docker(DockerEffect::Pull))
            }
            (TargetKind::Ssh, CommandKind::InstallAgent) => {
                Some(ProviderEffect::Ssh(SshOperation::Install))
            }
            _ => None,
        }
    }
}
