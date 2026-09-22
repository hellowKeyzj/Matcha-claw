use std::io::{Read, Write};

use crate::{
    domain::audit::{FleetAuditEntry, FleetAuditEvent, FleetAuditEventInput, FleetAuditValue},
    domain::command::{
        CommandAttempt, CommandCancellation, CommandFailure, CommandId, CommandIntent, CommandKind,
        CommandRecord, CommandState, CommandTarget, IdempotencyKey,
    },
    domain::connection::{ConnectionKind, ConnectionRecord, ConnectionState},
    domain::effect::{
        EffectIdentity, EffectRecord, EffectState, PhaseKey, ProviderKind, ReceiptOutcome,
    },
    domain::environment::{
        CleanupPolicy, EnvironmentId, EnvironmentKind, EnvironmentRecord, EnvironmentState,
        ManagedResourceAssociation, ManagedResourceId, ManagedResourceKind,
        ManagedResourceMetadata, ManagedResourceProvider, ManagedResourceRecord,
        ManagedResourceRef, ManagedResourceState, Ownership,
    },
    domain::lease::{Lease, LeaseOwner, LeaseOwnerKind, LeaseState},
    domain::outbox::{DispatchAttempt, DispatchId, DispatchIntent, DispatchPhase, OutboxRecord},
    domain::reachability::{
        ExternalRelayOrigin, LoopbackIngressListener, ReachabilityStatus, RelayAuthority,
        RelayAuthorityId, RelayBinding, RelayBindingId, RelayKind, RelayScheme,
        RuntimeAgentIngressReachabilityFacts,
    },
    domain::secret_ref::FleetSecretRef,
    domain::target::{
        CustomTargetConfig, DockerTargetConfig, FleetTargetConfig, FleetTargetSelector,
        KubernetesTargetConfig, SshAuthentication, SshTargetConfig, TargetId, TargetKind,
    },
    domain::topology::{
        AgentObservation, CredentialHash, EndpointHealth, EndpointObservation, EnrollmentRecord,
        FleetTopologyFacts, IngressCredentialRecord, NodeHealth, NodeId, NodeObservation,
        ObservationFreshness, ObservationMetadata, ObservationSource, PendingEndpointCommand,
        PendingRuntimeCommand, RuntimeId, RuntimeKind, RuntimeObservation, RuntimeState,
    },
};
use platform::{
    capability::{CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability},
    endpoint::{EndpointId, NativeAgentId},
};

use super::{FleetFacts, FleetFactsRestoreInput, StoreFault};

pub(super) const CURRENT_SCHEMA_VERSION: u8 = 15;
const PREVIOUS_SCHEMA_VERSION: u8 = 14;
const LEGACY_V11_SCHEMA_VERSION: u8 = 11;
const LEGACY_V10_SCHEMA_VERSION: u8 = 10;
const OLDEST_SCHEMA_VERSION: u8 = 7;
const LEGACY_V6_SCHEMA_VERSION: u8 = 6;
const LEGACY_V5_SCHEMA_VERSION: u8 = 5;
pub(super) const LOG_MAGIC: [u8; 8] = *b"MFLTDUR1";
pub(super) const HEADER_LEN: usize = LOG_MAGIC.len() + 1 + 8;
const FRAME_MARKER: u8 = 0xA1;
const FRAME_METADATA_LEN: usize = 16;
pub(super) const MAX_FACTS_BYTES: usize = 1024 * 1024;
pub(super) const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_COLLECTION_ENTRIES: usize = 16_384;
const MAX_STRING_BYTES: usize = 16 * 1024;
const MAX_AUDIT_DEPTH: usize = 8;

pub(super) struct RecoveredFacts {
    pub(super) facts: FleetFacts,
    pub(super) schema: u8,
    pub(super) epoch: u64,
    pub(super) committed_len: u64,
    pub(super) truncated_tail: bool,
    pub(super) had_interrupted_delivery: bool,
}

pub(super) fn initialize_log(mut output: impl Write) -> Result<(), StoreFault> {
    output
        .write_all(&LOG_MAGIC)
        .and_then(|()| output.write_all(&[CURRENT_SCHEMA_VERSION]))
        .and_then(|()| output.write_all(&0_u64.to_le_bytes()))
        .map_err(|error| StoreFault::Commit(error.kind()))
}

pub(super) fn recover_log(mut input: impl Read) -> Result<RecoveredFacts, StoreFault> {
    let mut content = Vec::new();
    input
        .by_ref()
        .take(MAX_LOG_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| StoreFault::Read(error.kind()))?;
    if content.len() > MAX_LOG_BYTES as usize {
        return Err(StoreFault::LogFull);
    }
    if content.len() < HEADER_LEN || content[..LOG_MAGIC.len()] != LOG_MAGIC {
        return Err(StoreFault::CorruptRecord);
    }
    let schema = content[LOG_MAGIC.len()];
    if !matches!(
        schema,
        CURRENT_SCHEMA_VERSION
            | PREVIOUS_SCHEMA_VERSION
            | LEGACY_V11_SCHEMA_VERSION
            | LEGACY_V10_SCHEMA_VERSION
            | OLDEST_SCHEMA_VERSION
            | LEGACY_V6_SCHEMA_VERSION
            | LEGACY_V5_SCHEMA_VERSION
    ) {
        return Err(StoreFault::UnsupportedSchemaVersion(schema));
    }

    let mut expected_epoch = u64::from_le_bytes(
        content[LOG_MAGIC.len() + 1..HEADER_LEN]
            .try_into()
            .map_err(|_| StoreFault::CorruptRecord)?,
    );
    let mut facts = FleetFacts::default();
    let mut offset = HEADER_LEN;
    let mut committed_len = HEADER_LEN;
    let mut truncated_tail = false;
    let mut had_interrupted_delivery = false;

    while offset < content.len() {
        let frame_start = offset;
        if content[offset] != FRAME_MARKER {
            return Err(StoreFault::CorruptRecord);
        }
        offset += 1;
        let metadata_end = offset
            .checked_add(FRAME_METADATA_LEN)
            .ok_or(StoreFault::CorruptRecord)?;
        if metadata_end > content.len() {
            truncated_tail = true;
            break;
        }
        let metadata = &content[offset..metadata_end];
        offset = metadata_end;
        let frame_epoch = u64::from_le_bytes(
            metadata[..8]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        );
        let payload_len = usize::try_from(u32::from_le_bytes(
            metadata[8..12]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        ))
        .map_err(|_| StoreFault::CorruptRecord)?;
        if payload_len > MAX_FACTS_BYTES {
            return Err(StoreFault::CorruptRecord);
        }
        let expected_checksum = u32::from_le_bytes(
            metadata[12..]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
        );
        let payload_end = offset
            .checked_add(payload_len)
            .ok_or(StoreFault::CorruptRecord)?;
        if payload_end > content.len() {
            truncated_tail = true;
            break;
        }
        let payload = &content[offset..payload_end];
        offset = payload_end;
        if checksum(payload) != expected_checksum {
            return Err(StoreFault::CorruptRecord);
        }
        let next_epoch = expected_epoch
            .checked_add(1)
            .ok_or(StoreFault::EpochOverflow)?;
        if frame_epoch != next_epoch {
            return Err(StoreFault::CorruptRecord);
        }
        let decoded = decode_facts(payload, schema)?;
        had_interrupted_delivery = decoded.had_interrupted_delivery;
        facts = decoded.facts;
        expected_epoch = frame_epoch;
        committed_len = offset;
        debug_assert!(committed_len > frame_start);
    }

    Ok(RecoveredFacts {
        facts,
        schema,
        epoch: expected_epoch,
        committed_len: u64::try_from(committed_len).map_err(|_| StoreFault::LogFull)?,
        truncated_tail,
        had_interrupted_delivery,
    })
}

fn observation_source_tag(source: ObservationSource) -> u8 {
    match source {
        ObservationSource::Discovery => 0,
        ObservationSource::HealthProbe => 1,
        ObservationSource::RuntimeAgent => 2,
    }
}

fn observation_freshness_tag(freshness: ObservationFreshness) -> u8 {
    match freshness {
        ObservationFreshness::Current => 0,
        ObservationFreshness::Stale => 1,
        ObservationFreshness::Unknown => 2,
        ObservationFreshness::Pruned => 3,
    }
}

fn runtime_kind_tag(kind: RuntimeKind) -> u8 {
    match kind {
        RuntimeKind::OpenClaw => 0,
        RuntimeKind::MatchaAgent => 1,
        RuntimeKind::Plugin => 2,
    }
}

fn endpoint_health_tag(health: EndpointHealth) -> u8 {
    match health {
        EndpointHealth::Unknown => 0,
        EndpointHealth::Ready => 1,
        EndpointHealth::Busy => 2,
        EndpointHealth::Draining => 3,
        EndpointHealth::Unhealthy => 4,
        EndpointHealth::Retired => 5,
    }
}

fn capability_scope_tag(scope: CapabilityScope) -> u8 {
    match scope {
        CapabilityScope::Endpoint => 0,
        CapabilityScope::Agent => 1,
        CapabilityScope::Session => 2,
    }
}

fn capability_availability_tag(availability: CapabilityAvailability) -> u8 {
    match availability {
        CapabilityAvailability::Available => 0,
        CapabilityAvailability::Unavailable => 1,
        CapabilityAvailability::Unknown => 2,
    }
}

fn command_kind_tag(kind: CommandKind) -> u8 {
    match kind {
        CommandKind::ProbeNode => 0,
        CommandKind::InstallAgent => 1,
        CommandKind::StartRuntime => 2,
        CommandKind::StopRuntime => 3,
        CommandKind::SyncCapabilities => 4,
        CommandKind::UpgradeAgent => 5,
        CommandKind::MountWorkspace => 6,
        CommandKind::ExposePort => 7,
    }
}

fn connection_kind_tag(kind: ConnectionKind) -> u8 {
    match kind {
        ConnectionKind::SshHost => 0,
        ConnectionKind::Container => 1,
        ConnectionKind::Vm => 2,
        ConnectionKind::KubernetesPod => 3,
        ConnectionKind::Custom => 4,
    }
}
fn environment_kind_tag(kind: EnvironmentKind) -> u8 {
    match kind {
        EnvironmentKind::SshWorkdir => 0,
        EnvironmentKind::DockerContainer => 1,
        EnvironmentKind::KubernetesWorkload => 2,
        EnvironmentKind::VmWorkdir => 3,
        EnvironmentKind::Custom => 4,
    }
}
fn provider_kind_tag(kind: ManagedResourceProvider) -> u8 {
    match kind {
        ManagedResourceProvider::Docker => 0,
        ManagedResourceProvider::Kubernetes => 1,
        ManagedResourceProvider::Ssh => 2,
        ManagedResourceProvider::Vm => 3,
        ManagedResourceProvider::Custom => 4,
    }
}
fn resource_kind_tag(kind: ManagedResourceKind) -> u8 {
    match kind {
        ManagedResourceKind::DockerContainer => 0,
        ManagedResourceKind::KubernetesWorkload => 1,
        ManagedResourceKind::KubernetesDeployment => 2,
        ManagedResourceKind::KubernetesService => 3,
        ManagedResourceKind::KubernetesSecret => 4,
        ManagedResourceKind::SshAgentInstallation => 5,
        ManagedResourceKind::VmAgentInstallation => 6,
        ManagedResourceKind::Custom => 7,
    }
}
fn ownership_tag(kind: Ownership) -> u8 {
    match kind {
        Ownership::MatchaManaged => 0,
        Ownership::Unverified => 1,
        Ownership::External => 2,
    }
}
fn cleanup_policy_tag(kind: CleanupPolicy) -> u8 {
    match kind {
        CleanupPolicy::DeleteOnEnvironmentDelete => 0,
        CleanupPolicy::UninstallAgentOnly => 1,
        CleanupPolicy::Orphan => 2,
        CleanupPolicy::None => 3,
    }
}
fn encode_connection_state(o: &mut Vec<u8>, s: &ConnectionState) -> Result<(), StoreFault> {
    match s {
        ConnectionState::Registered => o.push(0),
        ConnectionState::Probing { command_id } => {
            o.push(1);
            push_string(o, command_id.as_str())?
        }
        ConnectionState::Ready { observed_at } => {
            o.push(2);
            push_system_time(o, *observed_at)?
        }
        ConnectionState::Unhealthy {
            observed_at,
            message,
        } => {
            o.push(3);
            push_optional_system_time(o, *observed_at)?;
            push_string(o, message)?
        }
        ConnectionState::Deleted { deleted_at } => {
            o.push(4);
            push_system_time(o, *deleted_at)?
        }
        ConnectionState::Failed { message } => {
            o.push(5);
            push_string(o, message)?
        }
    }
    Ok(())
}
fn encode_environment_state(o: &mut Vec<u8>, s: &EnvironmentState) -> Result<(), StoreFault> {
    match s {
        EnvironmentState::Registered => o.push(0),
        EnvironmentState::Deploying { command_id, phase } => {
            o.push(1);
            push_string(o, command_id.as_str())?;
            push_string(o, phase.as_str())?
        }
        EnvironmentState::Ready { ready_at } => {
            o.push(2);
            push_system_time(o, *ready_at)?
        }
        EnvironmentState::Deleting { command_id, phase } => {
            o.push(3);
            push_string(o, command_id.as_str())?;
            push_string(o, phase.as_str())?
        }
        EnvironmentState::Deleted { deleted_at } => {
            o.push(4);
            push_system_time(o, *deleted_at)?
        }
        EnvironmentState::Orphaned { message } => {
            o.push(5);
            push_optional_string(o, message.as_deref())?
        }
        EnvironmentState::Failed { message } => {
            o.push(6);
            push_string(o, message)?
        }
    }
    Ok(())
}
fn encode_resource_state(o: &mut Vec<u8>, s: &ManagedResourceState) -> Result<(), StoreFault> {
    match s {
        ManagedResourceState::Observed => o.push(0),
        ManagedResourceState::Provisioning { command_id, phase } => {
            o.push(1);
            push_string(o, command_id.as_str())?;
            push_string(o, phase.as_str())?
        }
        ManagedResourceState::Ready { observed_at } => {
            o.push(2);
            push_system_time(o, *observed_at)?
        }
        ManagedResourceState::Deleting { command_id, phase } => {
            o.push(3);
            push_string(o, command_id.as_str())?;
            push_string(o, phase.as_str())?
        }
        ManagedResourceState::Deleted { deleted_at } => {
            o.push(4);
            push_system_time(o, *deleted_at)?
        }
        ManagedResourceState::Conflict { message } => {
            o.push(5);
            push_string(o, message)?
        }
        ManagedResourceState::Failed { message } => {
            o.push(6);
            push_string(o, message)?
        }
    }
    Ok(())
}

fn environment_kind(tag: u8) -> Result<EnvironmentKind, StoreFault> {
    match tag {
        0 => Ok(EnvironmentKind::SshWorkdir),
        1 => Ok(EnvironmentKind::DockerContainer),
        2 => Ok(EnvironmentKind::KubernetesWorkload),
        3 => Ok(EnvironmentKind::VmWorkdir),
        4 => Ok(EnvironmentKind::Custom),
        _ => Err(StoreFault::CorruptRecord),
    }
}
fn provider_kind(tag: u8) -> Result<ManagedResourceProvider, StoreFault> {
    match tag {
        0 => Ok(ManagedResourceProvider::Docker),
        1 => Ok(ManagedResourceProvider::Kubernetes),
        2 => Ok(ManagedResourceProvider::Ssh),
        3 => Ok(ManagedResourceProvider::Vm),
        4 => Ok(ManagedResourceProvider::Custom),
        _ => Err(StoreFault::CorruptRecord),
    }
}
fn resource_kind(tag: u8) -> Result<ManagedResourceKind, StoreFault> {
    match tag {
        0 => Ok(ManagedResourceKind::DockerContainer),
        1 => Ok(ManagedResourceKind::KubernetesWorkload),
        2 => Ok(ManagedResourceKind::KubernetesDeployment),
        3 => Ok(ManagedResourceKind::KubernetesService),
        4 => Ok(ManagedResourceKind::KubernetesSecret),
        5 => Ok(ManagedResourceKind::SshAgentInstallation),
        6 => Ok(ManagedResourceKind::VmAgentInstallation),
        7 => Ok(ManagedResourceKind::Custom),
        _ => Err(StoreFault::CorruptRecord),
    }
}
fn ownership(tag: u8) -> Result<Ownership, StoreFault> {
    match tag {
        0 => Ok(Ownership::MatchaManaged),
        1 => Ok(Ownership::Unverified),
        2 => Ok(Ownership::External),
        _ => Err(StoreFault::CorruptRecord),
    }
}
fn cleanup(tag: u8) -> Result<CleanupPolicy, StoreFault> {
    match tag {
        0 => Ok(CleanupPolicy::DeleteOnEnvironmentDelete),
        1 => Ok(CleanupPolicy::UninstallAgentOnly),
        2 => Ok(CleanupPolicy::Orphan),
        3 => Ok(CleanupPolicy::None),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn target_kind_tag(kind: TargetKind) -> u8 {
    match kind {
        TargetKind::Docker => 0,
        TargetKind::Kubernetes => 1,
        TargetKind::Ssh => 2,
        TargetKind::Custom => 3,
    }
}

fn target_kind_from_tag(tag: u8) -> Result<TargetKind, StoreFault> {
    match tag {
        0 => Ok(TargetKind::Docker),
        1 => Ok(TargetKind::Kubernetes),
        2 => Ok(TargetKind::Ssh),
        3 => Ok(TargetKind::Custom),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn command_failure_tag(failure: CommandFailure) -> u8 {
    match failure {
        CommandFailure::Rejected => 0,
        CommandFailure::Unavailable => 1,
        CommandFailure::ExecutionFailed => 2,
    }
}

fn provider_effect_kind(kind: u8) -> Result<ProviderKind, StoreFault> {
    match kind {
        0 => Ok(ProviderKind::Ssh),
        1 => Ok(ProviderKind::Docker),
        2 => Ok(ProviderKind::Kubernetes),
        3 => Ok(ProviderKind::OpenClaw),
        4 => Ok(ProviderKind::MatchaAgent),
        5 => Ok(ProviderKind::Custom),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn effect_provider_kind_tag(kind: ProviderKind) -> u8 {
    match kind {
        ProviderKind::Ssh => 0,
        ProviderKind::Docker => 1,
        ProviderKind::Kubernetes => 2,
        ProviderKind::OpenClaw => 3,
        ProviderKind::MatchaAgent => 4,
        ProviderKind::Custom => 5,
    }
}

fn effect_state_tag(state: EffectState) -> u8 {
    match state {
        EffectState::Pending => 0,
        EffectState::InFlight => 1,
        EffectState::Delivered => 2,
        EffectState::OutcomeUnknown => 3,
        EffectState::Rejected => 4,
    }
}

fn effect_state(tag: u8) -> Result<EffectState, StoreFault> {
    match tag {
        0 => Ok(EffectState::Pending),
        1 => Ok(EffectState::InFlight),
        2 => Ok(EffectState::Delivered),
        3 => Ok(EffectState::OutcomeUnknown),
        4 => Ok(EffectState::Rejected),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn receipt_outcome_tag(outcome: ReceiptOutcome) -> u8 {
    match outcome {
        ReceiptOutcome::Delivered => 0,
        ReceiptOutcome::Rejected => 1,
    }
}

fn receipt_outcome(tag: u8) -> Result<ReceiptOutcome, StoreFault> {
    match tag {
        0 => Ok(ReceiptOutcome::Delivered),
        1 => Ok(ReceiptOutcome::Rejected),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn runtime_agent_progress_state_tag(
    state: crate::domain::runtime_agent::RuntimeAgentProgressState,
) -> u8 {
    match state {
        crate::domain::runtime_agent::RuntimeAgentProgressState::Queued => 0,
        crate::domain::runtime_agent::RuntimeAgentProgressState::Running => 1,
    }
}

fn runtime_agent_progress_state(
    tag: u8,
) -> Result<crate::domain::runtime_agent::RuntimeAgentProgressState, StoreFault> {
    match tag {
        0 => Ok(crate::domain::runtime_agent::RuntimeAgentProgressState::Queued),
        1 => Ok(crate::domain::runtime_agent::RuntimeAgentProgressState::Running),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn push_optional_runtime_agent_result(
    output: &mut Vec<u8>,
    result: Option<&crate::domain::runtime_agent::RuntimeAgentResult>,
) -> Result<(), StoreFault> {
    use crate::domain::runtime_agent::RuntimeAgentResult;
    match result {
        None => output.push(0),
        Some(RuntimeAgentResult::Succeeded { completed_at }) => {
            output.push(1);
            push_system_time(output, *completed_at)?;
        }
        Some(RuntimeAgentResult::Failed {
            completed_at,
            message,
        }) => {
            output.push(2);
            push_system_time(output, *completed_at)?;
            push_string(output, message.as_str())?;
        }
        Some(RuntimeAgentResult::Cancelled {
            completed_at,
            message,
        }) => {
            output.push(3);
            push_system_time(output, *completed_at)?;
            push_optional_string(output, message.as_ref().map(|value| value.as_str()))?;
        }
        Some(RuntimeAgentResult::TimedOut {
            completed_at,
            timeout,
        }) => {
            output.push(4);
            push_system_time(output, *completed_at)?;
            output.extend_from_slice(&timeout.as_secs().to_le_bytes());
            output.extend_from_slice(&timeout.subsec_nanos().to_le_bytes());
        }
    }
    Ok(())
}

fn runtime_agent_status_tag(status: crate::domain::runtime_agent::RuntimeAgentStatus) -> u8 {
    match status {
        crate::domain::runtime_agent::RuntimeAgentStatus::Starting => 0,
        crate::domain::runtime_agent::RuntimeAgentStatus::Running => 1,
        crate::domain::runtime_agent::RuntimeAgentStatus::Draining => 2,
        crate::domain::runtime_agent::RuntimeAgentStatus::Stopping => 3,
        crate::domain::runtime_agent::RuntimeAgentStatus::Stopped => 4,
        crate::domain::runtime_agent::RuntimeAgentStatus::Degraded => 5,
    }
}

fn runtime_agent_status(
    tag: u8,
) -> Result<crate::domain::runtime_agent::RuntimeAgentStatus, StoreFault> {
    match tag {
        0 => Ok(crate::domain::runtime_agent::RuntimeAgentStatus::Starting),
        1 => Ok(crate::domain::runtime_agent::RuntimeAgentStatus::Running),
        2 => Ok(crate::domain::runtime_agent::RuntimeAgentStatus::Draining),
        3 => Ok(crate::domain::runtime_agent::RuntimeAgentStatus::Stopping),
        4 => Ok(crate::domain::runtime_agent::RuntimeAgentStatus::Stopped),
        5 => Ok(crate::domain::runtime_agent::RuntimeAgentStatus::Degraded),
        _ => Err(StoreFault::CorruptRecord),
    }
}

fn dispatch_phase_tag(phase: DispatchPhase) -> u8 {
    match phase {
        DispatchPhase::Pending => 0,
        DispatchPhase::InFlight => 1,
        DispatchPhase::OutcomeUnknown => 2,
        DispatchPhase::Delivered => 3,
    }
}

fn push_optional_u64(output: &mut Vec<u8>, value: Option<u64>) {
    match value {
        Some(value) => {
            output.push(1);
            output.extend_from_slice(&value.to_le_bytes());
        }
        None => output.push(0),
    }
}

fn push_optional_command_attempt(output: &mut Vec<u8>, attempt: Option<&CommandAttempt>) {
    match attempt {
        Some(attempt) => {
            output.push(1);
            output.extend_from_slice(&attempt.sequence().to_le_bytes());
        }
        None => output.push(0),
    }
}

fn push_optional_failure(output: &mut Vec<u8>, failure: Option<CommandFailure>) {
    match failure {
        Some(failure) => {
            output.push(1);
            output.push(command_failure_tag(failure));
        }
        None => output.push(0),
    }
}

fn push_optional_cancellation(output: &mut Vec<u8>, cancellation: Option<CommandCancellation>) {
    match cancellation {
        Some(CommandCancellation::Requested) => output.extend_from_slice(&[1, 0]),
        Some(CommandCancellation::Superseded) => output.extend_from_slice(&[1, 1]),
        None => output.push(0),
    }
}

fn push_optional_system_time(
    output: &mut Vec<u8>,
    value: Option<std::time::SystemTime>,
) -> Result<(), StoreFault> {
    match value {
        Some(value) => {
            output.push(1);
            push_system_time(output, value)
        }
        None => {
            output.push(0);
            Ok(())
        }
    }
}

fn push_optional_string(output: &mut Vec<u8>, value: Option<&str>) -> Result<(), StoreFault> {
    match value {
        Some(value) => {
            output.push(1);
            push_string(output, value)
        }
        None => {
            output.push(0);
            Ok(())
        }
    }
}

fn push_system_time(output: &mut Vec<u8>, value: std::time::SystemTime) -> Result<(), StoreFault> {
    let duration = value
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_err(|_| StoreFault::CorruptRecord)?;
    output.extend_from_slice(&duration.as_secs().to_le_bytes());
    output.extend_from_slice(&duration.subsec_nanos().to_le_bytes());
    Ok(())
}

fn push_count(output: &mut Vec<u8>, count: usize) -> Result<(), StoreFault> {
    if count > MAX_COLLECTION_ENTRIES {
        return Err(StoreFault::RecordTooLarge);
    }
    let count = u32::try_from(count).map_err(|_| StoreFault::RecordTooLarge)?;
    output.extend_from_slice(&count.to_le_bytes());
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), StoreFault> {
    if value.len() > MAX_STRING_BYTES {
        return Err(StoreFault::RecordTooLarge);
    }
    let length = u32::try_from(value.len()).map_err(|_| StoreFault::RecordTooLarge)?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn checksum(content: &[u8]) -> u32 {
    let mut value = 0x811C_9DC5_u32;
    for byte in content {
        value ^= u32::from(*byte);
        value = value.wrapping_mul(0x0100_0193);
    }
    value
}

mod decode;
mod encode;

pub(super) use decode::decode_facts;
pub(super) use encode::encode_frame;
#[cfg(test)]
pub(super) use encode::encode_v5_frame;
