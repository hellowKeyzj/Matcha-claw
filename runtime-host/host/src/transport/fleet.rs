use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::fleet::owner::{
    FleetTargetSummary, FleetTopologySummary, ManagedResourceRegistrationRequest,
};
use fleet::connection::{ConnectionId, ConnectionKind, ConnectionRecord};
use fleet::environment::{
    CleanupPolicy, EnvironmentId, EnvironmentKind, EnvironmentRecord, ManagedResourceId,
    ManagedResourceKind, ManagedResourceProvider, Ownership,
};
use fleet::query::{
    AuditSummary, CapabilitySummary, CommandSummary, CommandSummaryState, CommandTargetSummary,
    ConnectionSummary, EnvironmentSummary, FleetQuerySnapshot, LeaseSummary, LeaseSummaryState,
    ResourceSummary,
};
use fleet::topology::{
    AgentObservation, EndpointHealth, EndpointObservation, NodeHealth, NodeId, NodeObservation,
    ObservationFreshness, ObservationMetadata, ObservationSource, RuntimeId, RuntimeKind,
    RuntimeObservation, RuntimeState,
};
use fleet::{
    command::{CommandId, CommandIntent, CommandKind, CommandTarget, IdempotencyKey},
    outbox::{DispatchAttempt, DispatchId, DispatchIntent},
    target::{
        CustomTargetConfig, DockerTargetConfig, FleetTargetConfig, FleetTargetSelector,
        KubernetesTargetConfig, SshAuthentication, SshTargetConfig, TargetId, TargetKind,
    },
};
use platform::capability::{
    CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability,
};
use platform::endpoint::{EndpointId, NativeAgentId};

use crate::{fleet::handle::FleetHandle, transport::authorization::CapabilityDecisionVerifier};

pub(crate) mod server;

const AUTHORIZATION_ENDPOINT: &str = "/api/fleet";
const AUTHORIZATION_SCOPE: &str = "fleet:read";
const MUTATION_AUTHORIZATION_SCOPE: &str = "fleet:write";
const AUTHORIZATION_SUBJECT: &str = "fleet";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    operation: Operation,
    input: Input,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Input {
    List,
    Topology,
    Connections,
    Capabilities,
    Environments,
    Resources,
    Commands,
    Audit,
    Leases,
    Metrics,
    Snapshot {},
    SelectorPreview {
        payload: SelectorPreviewPayload,
    },
    TargetPut {
        payload: TargetPutPayload,
    },
    TargetRemove {
        payload: TargetRemovePayload,
    },
    CommandSubmit {
        payload: CommandSubmitPayload,
    },
    NodeCommandSubmit {
        payload: NodeCommandSubmitPayload,
    },
    CommandBegin {
        payload: DispatchPayload,
    },
    CommandAccept {
        payload: DispatchAttemptPayload,
    },
    CommandReject {
        payload: DispatchAttemptPayload,
    },
    CommandUnknown {
        payload: DispatchAttemptPayload,
    },
    CommandReplay {
        payload: CommandReplayPayload,
    },
    ConnectionUpsert {
        payload: ConnectionUpsertPayload,
    },
    ConnectionRemove {
        payload: ConnectionRemovePayload,
    },
    EnvironmentRegister {
        payload: EnvironmentRegisterPayload,
    },
    ResourceRegister {
        payload: ResourceRegisterPayload,
    },
    NodeUpsert {
        payload: NodeUpsertPayload,
    },
    AgentUpsert {
        payload: AgentUpsertPayload,
    },
    AgentRevoke {
        payload: IdPayload,
    },
    RuntimeUpsert {
        payload: RuntimeUpsertPayload,
    },
    EndpointUpsert {
        payload: EndpointUpsertPayload,
    },
    ConnectionProbeBegin {
        payload: ConnectionProbeBeginPayload,
    },
    ConnectionProbeComplete {
        payload: ConnectionProbeCompletePayload,
    },
    EnvironmentDeployBegin {
        payload: CommandPhasePayload,
    },
    EnvironmentDeployComplete {
        payload: CommandPhasePayload,
    },
    EnvironmentDeployFail {
        payload: CommandFailurePayload,
    },
    EnvironmentDeleteBegin {
        payload: CommandPhasePayload,
    },
    EnvironmentDeleteComplete {
        payload: CommandPhasePayload,
    },
    EnvironmentDeleteFail {
        payload: CommandFailurePayload,
    },
    ResourceProvisionBegin {
        payload: CommandPhasePayload,
    },
    ResourceProvisionComplete {
        payload: CommandPhasePayload,
    },
    ResourceDeleteBegin {
        payload: CommandPhasePayload,
    },
    ResourceDeleteComplete {
        payload: CommandPhasePayload,
    },
    ResourceDeleteFail {
        payload: CommandFailurePayload,
    },
    NodeRetire {
        payload: IdPayload,
    },
    RuntimeStartBegin {
        payload: CommandIdPayload,
    },
    RuntimeStartComplete {
        payload: CommandIdPayload,
    },
    RuntimeStopBegin {
        payload: CommandIdPayload,
    },
    RuntimeStopComplete {
        payload: CommandIdPayload,
    },
    RuntimeRetire {
        payload: IdPayload,
    },
    EndpointDrain {
        payload: IdPayload,
    },
    EndpointRetire {
        payload: IdPayload,
    },
    EndpointProbeBegin {
        payload: CommandIdPayload,
    },
    CapabilitySyncBegin {
        payload: CommandIdPayload,
    },
    CapabilitySyncComplete {
        payload: CapabilitySyncPayload,
    },
    TerminalOpen {
        payload: TerminalOpenPayload,
    },
    TerminalReconnect {
        payload: TerminalSessionPayload,
    },
    TerminalBeginClose {
        payload: TerminalSessionPayload,
    },
    TerminalFinishClose {
        payload: TerminalSessionPayload,
    },
    TerminalClose {
        payload: TerminalSessionPayload,
    },
    TerminalList,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetPutPayload {
    id: String,
    target: TargetConfigPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetRemovePayload {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispatchPayload {
    dispatch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispatchAttemptPayload {
    dispatch_id: String,
    attempt: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandReplayPayload {
    command_id: String,
    dispatch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionUpsertPayload {
    id: String,
    kind: String,
    display_name: String,
    endpoint: Option<String>,
    labels: Vec<String>,
    enabled: bool,
    public_config: BTreeMap<String, String>,
    secret_refs: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionRemovePayload {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvironmentRegisterPayload {
    id: String,
    connection_id: String,
    kind: String,
    display_name: String,
    labels: Vec<String>,
    enabled: bool,
    public_config: BTreeMap<String, String>,
    secret_refs: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceRegisterPayload {
    id: String,
    connection_id: String,
    environment_id: String,
    provider: String,
    kind: String,
    remote_resource_id: String,
    ownership: String,
    cleanup_policy: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeUpsertPayload {
    id: String,
    health: String,
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentUpsertPayload {
    id: String,
    node_id: String,
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeUpsertPayload {
    id: String,
    node_id: String,
    agent_id: Option<String>,
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
    kind: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointUpsertPayload {
    id: String,
    node_id: String,
    runtime_id: String,
    health: String,
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdPayload {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandIdPayload {
    id: String,
    command_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionProbeBeginPayload {
    id: String,
    command_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionProbeCompletePayload {
    id: String,
    command_id: String,
    outcome: String,
    message: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandPhasePayload {
    id: String,
    command_id: String,
    phase: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandFailurePayload {
    id: String,
    command_id: String,
    phase: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalOpenPayload {
    #[serde(default, deserialize_with = "deserialize_optional_identifier")]
    node_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_identifier")]
    runtime_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_identifier")]
    endpoint_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_terminal_size")]
    size: Option<TerminalSizePayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalSizePayload {
    rows: u16,
    cols: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalSessionPayload {
    session_id: String,
}

fn deserialize_optional_identifier<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Value::deserialize(deserializer)? {
        Value::String(value) => Ok(Some(value)),
        Value::Null => Err(serde::de::Error::custom(
            "terminal selector must not be null",
        )),
        _ => Err(serde::de::Error::custom(
            "terminal selector must be a string",
        )),
    }
}

fn deserialize_optional_terminal_size<'de, D>(
    deserializer: D,
) -> Result<Option<TerminalSizePayload>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("terminal size must not be null"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilitySyncPayload {
    id: String,
    command_id: String,
    capabilities: Vec<CapabilityPayload>,
    metadata: ObservationMetadataPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityPayload {
    id: String,
    scope: String,
    availability: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationMetadataPayload {
    source: String,
    #[serde(rename = "observedAt")]
    observed_at: String,
    freshness: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectorPayload {
    target_id: String,
    revision: u64,
    expected_kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectorPreviewPayload {
    endpoint_ids: Vec<String>,
    node_ids: Vec<String>,
    runtime_ids: Vec<String>,
    labels: Vec<String>,
    operation_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandSubmitPayload {
    command_id: String,
    idempotency_key: String,
    agent_id: String,
    target: CommandTargetPayload,
    kind: String,
    dispatch_id: String,
    selector: SelectorPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeCommandSubmitPayload {
    node_id: String,
    command_id: String,
    idempotency_key: String,
    dispatch_id: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum CommandTargetPayload {
    Node {
        node_id: String,
    },
    Runtime {
        node_id: String,
        runtime_id: String,
    },
    Endpoint {
        node_id: String,
        runtime_id: String,
        endpoint_id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum TargetConfigPayload {
    Docker {
        endpoint: String,
        container_name: String,
        image: String,
        secret_ref: Option<String>,
    },
    Kubernetes {
        api_server: String,
        namespace: String,
        deployment_name: String,
        service_name: String,
        image: String,
        secret_ref: String,
    },
    Ssh {
        host: String,
        port: Option<u16>,
        username: Option<String>,
        auth_kind: String,
        secret_ref: String,
        install_command: String,
    },
    Custom {
        endpoint: String,
        secret_ref: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    TargetsList,
    TargetPut,
    TargetRemove,
    TopologyGet,
    ConnectionsList,
    CapabilitiesList,
    EnvironmentsList,
    ResourcesList,
    CommandsList,
    AuditList,
    LeasesList,
    MetricsGet,
    SnapshotGet,
    SelectorPreview,
    CommandSubmit,
    NodeCommandSubmit,
    CommandBegin,
    CommandAccept,
    CommandReject,
    CommandUnknown,
    CommandReplay,
    ConnectionUpsert,
    ConnectionRemove,
    EnvironmentRegister,
    ResourceRegister,
    NodeUpsert,
    AgentUpsert,
    AgentRevoke,
    RuntimeUpsert,
    EndpointUpsert,
    ConnectionProbeBegin,
    ConnectionProbeComplete,
    EnvironmentDeployBegin,
    EnvironmentDeployComplete,
    EnvironmentDeployFail,
    EnvironmentDeleteBegin,
    EnvironmentDeleteComplete,
    EnvironmentDeleteFail,
    ResourceProvisionBegin,
    ResourceProvisionComplete,
    ResourceDeleteBegin,
    ResourceDeleteComplete,
    ResourceDeleteFail,
    NodeRetire,
    RuntimeStartBegin,
    RuntimeStartComplete,
    RuntimeStopBegin,
    RuntimeStopComplete,
    RuntimeRetire,
    EndpointDrain,
    EndpointRetire,
    EndpointProbeBegin,
    CapabilitySyncBegin,
    CapabilitySyncComplete,
    TerminalOpen,
    TerminalReconnect,
    TerminalBeginClose,
    TerminalFinishClose,
    TerminalClose,
    TerminalList,
}

impl<'de> Deserialize<'de> for Operation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "fleet.targets.list" => Ok(Self::TargetsList),
            "fleet.targets.put" => Ok(Self::TargetPut),
            "fleet.targets.remove" => Ok(Self::TargetRemove),
            "fleet.topology.get" => Ok(Self::TopologyGet),
            "fleet.commands.submit" => Ok(Self::CommandSubmit),
            "fleet.commands.submit.node" => Ok(Self::NodeCommandSubmit),
            "fleet.commands.begin" => Ok(Self::CommandBegin),
            "fleet.commands.accept" => Ok(Self::CommandAccept),
            "fleet.commands.reject" => Ok(Self::CommandReject),
            "fleet.commands.unknown" => Ok(Self::CommandUnknown),
            "fleet.commands.replay" => Ok(Self::CommandReplay),
            "fleet.connections.upsert" => Ok(Self::ConnectionUpsert),
            "fleet.connections.remove" => Ok(Self::ConnectionRemove),
            "fleet.environments.register" => Ok(Self::EnvironmentRegister),
            "fleet.resources.register" => Ok(Self::ResourceRegister),
            "fleet.nodes.upsert" => Ok(Self::NodeUpsert),
            "fleet.agents.upsert" => Ok(Self::AgentUpsert),
            "fleet.agents.revoke" => Ok(Self::AgentRevoke),
            "fleet.runtimes.upsert" => Ok(Self::RuntimeUpsert),
            "fleet.endpoints.upsert" => Ok(Self::EndpointUpsert),
            "fleet.connections.probe.begin" => Ok(Self::ConnectionProbeBegin),
            "fleet.connections.probe.complete" => Ok(Self::ConnectionProbeComplete),
            "fleet.environments.deploy.begin" => Ok(Self::EnvironmentDeployBegin),
            "fleet.environments.deploy.complete" => Ok(Self::EnvironmentDeployComplete),
            "fleet.environments.deploy.fail" => Ok(Self::EnvironmentDeployFail),
            "fleet.environments.delete.begin" => Ok(Self::EnvironmentDeleteBegin),
            "fleet.environments.delete.complete" => Ok(Self::EnvironmentDeleteComplete),
            "fleet.environments.delete.fail" => Ok(Self::EnvironmentDeleteFail),
            "fleet.resources.provision.begin" => Ok(Self::ResourceProvisionBegin),
            "fleet.resources.provision.complete" => Ok(Self::ResourceProvisionComplete),
            "fleet.resources.delete.begin" => Ok(Self::ResourceDeleteBegin),
            "fleet.resources.delete.complete" => Ok(Self::ResourceDeleteComplete),
            "fleet.resources.delete.fail" => Ok(Self::ResourceDeleteFail),
            "fleet.nodes.retire" => Ok(Self::NodeRetire),
            "fleet.runtimes.start.begin" => Ok(Self::RuntimeStartBegin),
            "fleet.runtimes.start.complete" => Ok(Self::RuntimeStartComplete),
            "fleet.runtimes.stop.begin" => Ok(Self::RuntimeStopBegin),
            "fleet.runtimes.stop.complete" => Ok(Self::RuntimeStopComplete),
            "fleet.runtimes.retire" => Ok(Self::RuntimeRetire),
            "fleet.endpoints.drain" => Ok(Self::EndpointDrain),
            "fleet.endpoints.retire" => Ok(Self::EndpointRetire),
            "fleet.endpoints.probe.begin" => Ok(Self::EndpointProbeBegin),
            "fleet.capabilities.sync.begin" => Ok(Self::CapabilitySyncBegin),
            "fleet.capabilities.sync.complete" => Ok(Self::CapabilitySyncComplete),
            "fleet.terminals.open" => Ok(Self::TerminalOpen),
            "fleet.terminals.reconnect" => Ok(Self::TerminalReconnect),
            "fleet.terminals.close.begin" => Ok(Self::TerminalBeginClose),
            "fleet.terminals.close.complete" => Ok(Self::TerminalFinishClose),
            "fleet.terminals.close" => Ok(Self::TerminalClose),
            "fleet.terminals.list" => Ok(Self::TerminalList),
            "fleet.connections.list" => Ok(Self::ConnectionsList),
            "fleet.capabilities.list" => Ok(Self::CapabilitiesList),
            "fleet.environments.list" => Ok(Self::EnvironmentsList),
            "fleet.resources.list" => Ok(Self::ResourcesList),
            "fleet.commands.list" => Ok(Self::CommandsList),
            "fleet.audit.list" => Ok(Self::AuditList),
            "fleet.leases.list" => Ok(Self::LeasesList),
            "fleet.metrics.get" => Ok(Self::MetricsGet),
            "fleet.snapshot.get" => Ok(Self::SnapshotGet),
            "fleet.selector.preview" => Ok(Self::SelectorPreview),
            _ => Err(serde::de::Error::custom("unsupported Fleet operation")),
        }
    }
}

impl Request {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        let operation = value
            .get("operation")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "fleet.targets.list"
                        | "fleet.targets.put"
                        | "fleet.targets.remove"
                        | "fleet.topology.get"
                        | "fleet.commands.submit"
                        | "fleet.commands.submit.node"
                        | "fleet.commands.begin"
                        | "fleet.commands.accept"
                        | "fleet.commands.reject"
                        | "fleet.commands.unknown"
                        | "fleet.commands.replay"
                        | "fleet.connections.upsert"
                        | "fleet.connections.remove"
                        | "fleet.environments.register"
                        | "fleet.resources.register"
                        | "fleet.nodes.upsert"
                        | "fleet.agents.upsert"
                        | "fleet.agents.revoke"
                        | "fleet.runtimes.upsert"
                        | "fleet.endpoints.upsert"
                        | "fleet.connections.probe.begin"
                        | "fleet.connections.probe.complete"
                        | "fleet.environments.deploy.begin"
                        | "fleet.environments.deploy.complete"
                        | "fleet.environments.deploy.fail"
                        | "fleet.environments.delete.begin"
                        | "fleet.environments.delete.complete"
                        | "fleet.environments.delete.fail"
                        | "fleet.resources.provision.begin"
                        | "fleet.resources.provision.complete"
                        | "fleet.resources.delete.begin"
                        | "fleet.resources.delete.complete"
                        | "fleet.resources.delete.fail"
                        | "fleet.nodes.retire"
                        | "fleet.runtimes.start.begin"
                        | "fleet.runtimes.start.complete"
                        | "fleet.runtimes.stop.begin"
                        | "fleet.runtimes.stop.complete"
                        | "fleet.runtimes.retire"
                        | "fleet.endpoints.drain"
                        | "fleet.endpoints.retire"
                        | "fleet.endpoints.probe.begin"
                        | "fleet.capabilities.sync.begin"
                        | "fleet.capabilities.sync.complete"
                        | "fleet.terminals.open"
                        | "fleet.terminals.reconnect"
                        | "fleet.terminals.close.begin"
                        | "fleet.terminals.close.complete"
                        | "fleet.terminals.close"
                        | "fleet.terminals.list"
                        | "fleet.connections.list"
                        | "fleet.capabilities.list"
                        | "fleet.environments.list"
                        | "fleet.resources.list"
                        | "fleet.commands.list"
                        | "fleet.audit.list"
                        | "fleet.leases.list"
                        | "fleet.metrics.get"
                        | "fleet.snapshot.get"
                        | "fleet.selector.preview"
                )
            })
            .ok_or(DecodeError::Invalid)?;
        let scope = if matches!(
            operation,
            "fleet.targets.put"
                | "fleet.targets.remove"
                | "fleet.commands.submit"
                | "fleet.commands.submit.node"
                | "fleet.commands.begin"
                | "fleet.commands.accept"
                | "fleet.commands.reject"
                | "fleet.commands.unknown"
                | "fleet.commands.replay"
                | "fleet.connections.upsert"
                | "fleet.connections.remove"
                | "fleet.environments.register"
                | "fleet.resources.register"
                | "fleet.nodes.upsert"
                | "fleet.agents.upsert"
                | "fleet.agents.revoke"
                | "fleet.runtimes.upsert"
                | "fleet.endpoints.upsert"
                | "fleet.connections.probe.begin"
                | "fleet.connections.probe.complete"
                | "fleet.environments.deploy.begin"
                | "fleet.environments.deploy.complete"
                | "fleet.environments.deploy.fail"
                | "fleet.environments.delete.begin"
                | "fleet.environments.delete.complete"
                | "fleet.environments.delete.fail"
                | "fleet.resources.provision.begin"
                | "fleet.resources.provision.complete"
                | "fleet.resources.delete.begin"
                | "fleet.resources.delete.complete"
                | "fleet.resources.delete.fail"
                | "fleet.nodes.retire"
                | "fleet.runtimes.start.begin"
                | "fleet.runtimes.start.complete"
                | "fleet.runtimes.stop.begin"
                | "fleet.runtimes.stop.complete"
                | "fleet.runtimes.retire"
                | "fleet.endpoints.drain"
                | "fleet.endpoints.retire"
                | "fleet.endpoints.probe.begin"
                | "fleet.capabilities.sync.begin"
                | "fleet.capabilities.sync.complete"
                | "fleet.terminals.open"
                | "fleet.terminals.reconnect"
                | "fleet.terminals.close.begin"
                | "fleet.terminals.close.complete"
                | "fleet.terminals.close"
        ) {
            MUTATION_AUTHORIZATION_SCOPE
        } else {
            AUTHORIZATION_SCOPE
        };
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                scope,
                operation,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| DecodeError::Invalid)?;
        let valid = matches!(
            (&request.operation, &request.input),
            (Operation::TargetsList, Input::List)
                | (Operation::TargetPut, Input::TargetPut { .. })
                | (Operation::TargetRemove, Input::TargetRemove { .. })
                | (Operation::CommandSubmit, Input::CommandSubmit { .. })
                | (
                    Operation::NodeCommandSubmit,
                    Input::NodeCommandSubmit { .. }
                )
                | (Operation::CommandBegin, Input::CommandBegin { .. })
                | (Operation::CommandAccept, Input::CommandAccept { .. })
                | (Operation::CommandReject, Input::CommandReject { .. })
                | (Operation::CommandUnknown, Input::CommandUnknown { .. })
                | (Operation::CommandReplay, Input::CommandReplay { .. })
                | (Operation::ConnectionUpsert, Input::ConnectionUpsert { .. })
                | (Operation::ConnectionRemove, Input::ConnectionRemove { .. })
                | (
                    Operation::EnvironmentRegister,
                    Input::EnvironmentRegister { .. }
                )
                | (Operation::ResourceRegister, Input::ResourceRegister { .. })
                | (Operation::NodeUpsert, Input::NodeUpsert { .. })
                | (Operation::AgentUpsert, Input::AgentUpsert { .. })
                | (Operation::AgentRevoke, Input::AgentRevoke { .. })
                | (Operation::RuntimeUpsert, Input::RuntimeUpsert { .. })
                | (Operation::EndpointUpsert, Input::EndpointUpsert { .. })
                | (
                    Operation::ConnectionProbeBegin,
                    Input::ConnectionProbeBegin { .. }
                )
                | (
                    Operation::ConnectionProbeComplete,
                    Input::ConnectionProbeComplete { .. }
                )
                | (
                    Operation::EnvironmentDeployBegin,
                    Input::EnvironmentDeployBegin { .. }
                )
                | (
                    Operation::EnvironmentDeployComplete,
                    Input::EnvironmentDeployComplete { .. }
                )
                | (
                    Operation::EnvironmentDeployFail,
                    Input::EnvironmentDeployFail { .. }
                )
                | (
                    Operation::EnvironmentDeleteBegin,
                    Input::EnvironmentDeleteBegin { .. }
                )
                | (
                    Operation::EnvironmentDeleteComplete,
                    Input::EnvironmentDeleteComplete { .. }
                )
                | (
                    Operation::EnvironmentDeleteFail,
                    Input::EnvironmentDeleteFail { .. }
                )
                | (
                    Operation::ResourceProvisionBegin,
                    Input::ResourceProvisionBegin { .. }
                )
                | (
                    Operation::ResourceProvisionComplete,
                    Input::ResourceProvisionComplete { .. }
                )
                | (
                    Operation::ResourceDeleteBegin,
                    Input::ResourceDeleteBegin { .. }
                )
                | (
                    Operation::ResourceDeleteComplete,
                    Input::ResourceDeleteComplete { .. }
                )
                | (
                    Operation::ResourceDeleteFail,
                    Input::ResourceDeleteFail { .. }
                )
                | (Operation::NodeRetire, Input::NodeRetire { .. })
                | (
                    Operation::RuntimeStartBegin,
                    Input::RuntimeStartBegin { .. }
                )
                | (
                    Operation::RuntimeStartComplete,
                    Input::RuntimeStartComplete { .. }
                )
                | (Operation::RuntimeStopBegin, Input::RuntimeStopBegin { .. })
                | (
                    Operation::RuntimeStopComplete,
                    Input::RuntimeStopComplete { .. }
                )
                | (Operation::RuntimeRetire, Input::RuntimeRetire { .. })
                | (Operation::EndpointDrain, Input::EndpointDrain { .. })
                | (Operation::EndpointRetire, Input::EndpointRetire { .. })
                | (
                    Operation::EndpointProbeBegin,
                    Input::EndpointProbeBegin { .. }
                )
                | (
                    Operation::CapabilitySyncBegin,
                    Input::CapabilitySyncBegin { .. }
                )
                | (
                    Operation::CapabilitySyncComplete,
                    Input::CapabilitySyncComplete { .. }
                )
                | (Operation::TerminalOpen, Input::TerminalOpen { .. })
                | (
                    Operation::TerminalReconnect,
                    Input::TerminalReconnect { .. }
                )
                | (
                    Operation::TerminalBeginClose,
                    Input::TerminalBeginClose { .. }
                )
                | (
                    Operation::TerminalFinishClose,
                    Input::TerminalFinishClose { .. }
                )
                | (Operation::TerminalClose, Input::TerminalClose { .. })
                | (Operation::TerminalList, Input::TerminalList)
                | (Operation::TopologyGet, Input::Topology)
                | (Operation::ConnectionsList, Input::Connections)
                | (Operation::CapabilitiesList, Input::Capabilities)
                | (Operation::EnvironmentsList, Input::Environments)
                | (Operation::ResourcesList, Input::Resources)
                | (Operation::CommandsList, Input::Commands)
                | (Operation::AuditList, Input::Audit)
                | (Operation::LeasesList, Input::Leases)
                | (Operation::MetricsGet, Input::Metrics)
                | (Operation::SnapshotGet, Input::Snapshot { .. })
                | (Operation::SelectorPreview, Input::SelectorPreview { .. })
        );
        valid.then_some(request).ok_or(DecodeError::Invalid)
    }
}

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

enum QueryValue<T> {
    Value(T),
    Unavailable,
}

enum QueryOption<T> {
    Some(T),
    None,
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
                json!({"success":false,"error":"Fleet selector constraints are invalid"})
            }
            Self::Unavailable => json!({
                "success": false,
                "error": "Fleet data is unavailable",
            }),
        }
    }
}

fn query_value<T>(
    result: Result<Result<T, fleet::FleetDeliveryError>, crate::RequestAdmissionClosed>,
) -> QueryValue<T> {
    match result {
        Ok(Ok(value)) => QueryValue::Value(value),
        Ok(Err(_)) | Err(_) => QueryValue::Unavailable,
    }
}

fn query_option<T>(
    result: Result<Result<Option<T>, fleet::FleetDeliveryError>, crate::RequestAdmissionClosed>,
) -> QueryOption<T> {
    match result {
        Ok(Ok(Some(value))) => QueryOption::Some(value),
        Ok(Ok(None)) => QueryOption::None,
        Ok(Err(_)) | Err(_) => QueryOption::Unavailable,
    }
}

fn query_delivery<T>(
    result: Result<Result<T, fleet::FleetDeliveryError>, crate::RequestAdmissionClosed>,
    ok: impl FnOnce(T) -> Delivery,
) -> Delivery {
    match query_value(result) {
        QueryValue::Value(value) => ok(value),
        QueryValue::Unavailable => Delivery::Unavailable,
    }
}

pub(crate) async fn read(owner: &FleetHandle, request: Request) -> Delivery {
    match request.operation {
        Operation::TargetPut => match request.input {
            Input::TargetPut { payload } => match parse_target_put(payload) {
                Ok((id, config)) => owner.put_target(id, config).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|target| json!({"outcome":"targetUpdated","target":{"id":target.id().as_str(),"revision":target.revision(),"kind":target_kind_name(target.kind())}})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TargetRemove => match request.input {
            Input::TargetRemove { payload } => match TargetId::try_new(payload.id) {
                Ok(id) => owner.remove_target(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"targetRemoved"})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionUpsert => match request.input {
            Input::ConnectionUpsert { payload } => match parse_connection(payload) {
                Ok(record) => owner.upsert_connection(record).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"connectionUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionRemove => match request.input {
            Input::ConnectionRemove { payload } => match ConnectionId::try_new(payload.id) {
                Ok(id) => owner.delete_connection(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"connectionRemoved"})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EnvironmentRegister => match request.input {
            Input::EnvironmentRegister { payload } => match parse_environment(payload) {
                Ok(record) => owner.register_environment(record).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"environmentRegistered"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ResourceRegister => match request.input {
            Input::ResourceRegister { payload } => match parse_resource(payload) {
                Ok(request) => owner.register_resource(request).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"resourceRegistered"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::NodeUpsert => match request.input {
            Input::NodeUpsert { payload } => match parse_node(payload) {
                Ok(observation) => owner.upsert_node(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"nodeUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::AgentUpsert => match request.input {
            Input::AgentUpsert { payload } => match parse_agent(payload) {
                Ok(observation) => owner.upsert_agent(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"agentUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::AgentRevoke => match request.input {
            Input::AgentRevoke { payload } => match NativeAgentId::try_new(payload.id) {
                Ok(id) => owner.revoke_agent(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"agentRevoked"})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::RuntimeUpsert => match request.input {
            Input::RuntimeUpsert { payload } => match parse_runtime(payload) {
                Ok(observation) => owner.upsert_runtime(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"runtimeUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EndpointUpsert => match request.input {
            Input::EndpointUpsert { payload } => match parse_endpoint(payload) {
                Ok(observation) => owner.upsert_endpoint(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"endpointUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionProbeBegin => match request.input {
            Input::ConnectionProbeBegin { payload } => match (ConnectionId::try_new(payload.id), CommandId::try_new(payload.command_id)) {
                (Ok(id), Ok(command_id)) => owner
                    .run_connection_probe(id, command_id)
                    .await
                    .map_or(Delivery::Unavailable, |result| {
                        mutation_result(result.map(|outcome| match outcome {
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Ready(_) => json!({"outcome":"probeCompleted","state":"ready"}),
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Unhealthy(_) => json!({"outcome":"probeCompleted","state":"unhealthy"}),
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Unknown(message) => json!({"outcome":"probeUnknown","message": message}),
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Rejected(message) => json!({"outcome":"probeRejected","message": message}),
                        }))
                    }),
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionProbeComplete => match request.input {
            Input::ConnectionProbeComplete { payload } => {
                let outcome = match payload.outcome.as_str() { "ready" => fleet::connection::ProbeOutcome::Ready, "unhealthy" => fleet::connection::ProbeOutcome::Unhealthy, _ => return Delivery::Mutation(json!({"outcome":"error"})) };
                match (ConnectionId::try_new(payload.id), CommandId::try_new(payload.command_id)) {
                    (Ok(id), Ok(command_id)) => owner.complete_connection_probe(id, command_id, outcome, payload.message).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"probeCompleted"})))),
                    _ => Delivery::Mutation(json!({"outcome":"error"})),
                }
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EnvironmentDeployBegin | Operation::EnvironmentDeployComplete | Operation::EnvironmentDeployFail => {
            match request.input {
                Input::EnvironmentDeployBegin { payload } => lifecycle_environment_deploy(owner, payload, 0).await,
                Input::EnvironmentDeployComplete { payload } => lifecycle_environment_deploy(owner, payload, 1).await,
                Input::EnvironmentDeployFail { payload } => lifecycle_environment_deploy_fail(owner, payload).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::EnvironmentDeleteBegin | Operation::EnvironmentDeleteComplete | Operation::EnvironmentDeleteFail => {
            match request.input {
                Input::EnvironmentDeleteBegin { payload } => lifecycle_environment_delete(owner, payload, 0).await,
                Input::EnvironmentDeleteComplete { payload } => lifecycle_environment_delete(owner, payload, 1).await,
                Input::EnvironmentDeleteFail { payload } => lifecycle_environment_delete_fail(owner, payload).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::ResourceProvisionBegin | Operation::ResourceProvisionComplete => {
            match request.input {
                Input::ResourceProvisionBegin { payload } => lifecycle_resource_provision(owner, payload, 0).await,
                Input::ResourceProvisionComplete { payload } => lifecycle_resource_provision(owner, payload, 1).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::ResourceDeleteBegin | Operation::ResourceDeleteComplete | Operation::ResourceDeleteFail => {
            match request.input {
                Input::ResourceDeleteBegin { payload } => lifecycle_resource_delete(owner, payload, 0).await,
                Input::ResourceDeleteComplete { payload } => lifecycle_resource_delete(owner, payload, 1).await,
                Input::ResourceDeleteFail { payload } => lifecycle_resource_delete_fail(owner, payload).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::NodeRetire => match request.input {
            Input::NodeRetire { payload } => match NodeId::try_new(payload.id) { Ok(id) => owner.retire_node(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"nodeRetired"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::RuntimeStartBegin | Operation::RuntimeStartComplete | Operation::RuntimeStopBegin | Operation::RuntimeStopComplete => {
            match request.input {
                Input::RuntimeStartBegin { payload } => lifecycle_runtime(owner, payload, 0).await,
                Input::RuntimeStartComplete { payload } => lifecycle_runtime(owner, payload, 1).await,
                Input::RuntimeStopBegin { payload } => lifecycle_runtime(owner, payload, 2).await,
                Input::RuntimeStopComplete { payload } => lifecycle_runtime(owner, payload, 3).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::RuntimeRetire => match request.input {
            Input::RuntimeRetire { payload } => match RuntimeId::try_new(payload.id) { Ok(id) => owner.retire_runtime(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"runtimeRetired"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EndpointDrain | Operation::EndpointRetire => match request.input {
            Input::EndpointDrain { payload } => match EndpointId::try_new(payload.id) { Ok(id) => owner.drain_endpoint(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"endpointDrained"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            Input::EndpointRetire { payload } => match EndpointId::try_new(payload.id) { Ok(id) => owner.retire_endpoint(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"endpointRetired"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EndpointProbeBegin => match request.input {
            Input::EndpointProbeBegin { payload } => match (EndpointId::try_new(payload.id), CommandId::try_new(payload.command_id)) { (Ok(id), Ok(command_id)) => owner.begin_endpoint_probe(id, command_id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"probeStarted"})))), _ => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CapabilitySyncBegin => match request.input {
            Input::CapabilitySyncBegin { payload } => match (EndpointId::try_new(payload.id), CommandId::try_new(payload.command_id)) {
                (Ok(id), Ok(command_id)) => owner.begin_capability_sync(id, command_id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"capabilitySyncStarted"})))),
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CapabilitySyncComplete => match request.input {
            Input::CapabilitySyncComplete { payload } => match (CommandId::try_new(payload.command_id.clone()), EndpointId::try_new(payload.id.clone()), parse_capability_sync(payload)) {
                (Ok(command_id), Ok(id), Ok(sync)) => owner.complete_capability_sync(id, command_id, sync).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"capabilitySyncCompleted"})))),
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalOpen => match request.input {
            Input::TerminalOpen { payload } => terminal_open_delivery(owner, payload).await,
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalReconnect => match request.input {
            Input::TerminalReconnect { payload } => terminal_reconnect_delivery(owner, payload).await,
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalBeginClose => match request.input { Input::TerminalBeginClose { payload } => match fleet::terminal::SessionId::try_new(payload.session_id) { Ok(session) => owner.terminal_begin_close(session).await.map_or(Delivery::Unavailable, |result| result.map_or(Delivery::Mutation(json!({"outcome":"error"})), |_| Delivery::Mutation(json!({"outcome":"terminalClosing"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) }, _ => Delivery::Mutation(json!({"outcome":"error"})) },
        Operation::TerminalFinishClose => match request.input { Input::TerminalFinishClose { payload } => match fleet::terminal::SessionId::try_new(payload.session_id) { Ok(session) => owner.terminal_finish_close(session).await.map_or(Delivery::Unavailable, |result| result.map_or(Delivery::Mutation(json!({"outcome":"error"})), |_| Delivery::Mutation(json!({"outcome":"terminalClosed"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) }, _ => Delivery::Mutation(json!({"outcome":"error"})) },
        Operation::TerminalClose => match request.input { Input::TerminalClose { payload } => match fleet::terminal::SessionId::try_new(payload.session_id) { Ok(session) => owner.terminal_close(session).await.map_or(Delivery::Unavailable, |result| result.map_or(Delivery::Mutation(json!({"outcome":"error"})), |_| Delivery::Mutation(json!({"outcome":"terminalClosed"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) }, _ => Delivery::Mutation(json!({"outcome":"error"})) },
        Operation::TerminalList => owner.terminal_list().await.map(|sessions| Delivery::Mutation(json!({"sessions": sessions.iter().map(|session| json!({"id":session.id().as_str(),"targetId":session.target().as_str(),"provider":session.provider().as_str(),"generation":session.generation().get(),"status":format!("{:?}", session.status()),"expiresAt":timestamp(session.expires_at())})).collect::<Vec<_>>()}))).map_or(Delivery::Unavailable, |delivery| delivery),
        Operation::CommandSubmit => match request.input {
            Input::CommandSubmit { payload } => {
                let target_id = match TargetId::try_new(payload.selector.target_id.clone()) { Ok(id) => id, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) };
                let kind = match payload.selector.expected_kind.as_str() { "docker" => TargetKind::Docker, "kubernetes" => TargetKind::Kubernetes, "ssh" => TargetKind::Ssh, "custom" => TargetKind::Custom, _ => return Delivery::Mutation(json!({"outcome":"error"})) };
                let selector = match query_option(owner.target_selector(target_id, payload.selector.revision, kind).await) {
                    QueryOption::Some(selector) => selector,
                    QueryOption::None => return Delivery::Mutation(json!({"outcome":"error"})),
                    QueryOption::Unavailable => return Delivery::Unavailable,
                };
                match parse_submit(payload, selector) {
                    Ok(request) => owner.submit(request).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|outcome| json!({"outcome": match outcome { fleet::FleetSubmitOutcome::Submitted => "submitted", fleet::FleetSubmitOutcome::AlreadySubmitted => "alreadySubmitted" }})))),
                    Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
                }
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::NodeCommandSubmit => match request.input {
            Input::NodeCommandSubmit { payload } => match parse_node_command_submit(payload) {
                Ok(request) => match owner.node_command_request(request).await {
                    Ok(Ok(resolution)) => {
                        let dispatch_id = resolution.dispatch_id.clone();
                        let target = selector_target_json(&resolution.selector);
                        match owner.submit(resolution.request).await {
                            Ok(Ok(fleet::FleetSubmitOutcome::Submitted)) => owner.begin_dispatch(dispatch_id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|dispatch| json!({"outcome": match dispatch.outcome { crate::fleet::executor::FleetExecutionOutcome::Completed => "completed", crate::fleet::executor::FleetExecutionOutcome::Rejected => "rejected", crate::fleet::executor::FleetExecutionOutcome::Unknown => "outcomeUnknown", crate::fleet::executor::FleetExecutionOutcome::Accepted => "accepted" }, "dispatchId": dispatch.dispatch_id.as_str(), "attempt": dispatch.attempt.sequence(), "target": target})))),
                            Ok(Ok(fleet::FleetSubmitOutcome::AlreadySubmitted)) => Delivery::Mutation(json!({"outcome":"alreadySubmitted","dispatchId":dispatch_id.as_str(),"target":target})),
                            Ok(Err(_)) => Delivery::Mutation(json!({"outcome":"error"})),
                            Err(_) => Delivery::Unavailable,
                        }
                    }
                    Ok(Err(_)) => Delivery::Mutation(json!({"outcome":"error"})),
                    Err(_) => Delivery::Unavailable,
                },
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CommandBegin => match request.input {
            Input::CommandBegin { payload } => match DispatchId::try_new(payload.dispatch_id) {
                Ok(dispatch) => owner.begin_dispatch(dispatch).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|dispatch| json!({"outcome": match dispatch.outcome { crate::fleet::executor::FleetExecutionOutcome::Completed => "completed", crate::fleet::executor::FleetExecutionOutcome::Rejected => "rejected", crate::fleet::executor::FleetExecutionOutcome::Unknown => "outcomeUnknown", crate::fleet::executor::FleetExecutionOutcome::Accepted => "accepted" },"dispatchId":dispatch.dispatch_id.as_str(),"attempt":dispatch.attempt.sequence()})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CommandAccept | Operation::CommandReject | Operation::CommandUnknown => {
            let (payload, operation) = match request.input { Input::CommandAccept { payload } => (payload, 0), Input::CommandReject { payload } => (payload, 1), Input::CommandUnknown { payload } => (payload, 2), _ => return Delivery::Mutation(json!({"outcome":"error"})) };
            let dispatch = match DispatchId::try_new(payload.dispatch_id) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) };
            let attempt = match DispatchAttempt::try_new(payload.attempt) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) };
            let result = match operation { 0 => owner.accept_dispatch(dispatch, attempt).await, 1 => owner.reject_dispatch(dispatch, attempt).await, _ => owner.mark_dispatch_unknown(dispatch, attempt).await };
            result.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|outcome| delivery_outcome_json(outcome, operation))))
        }
        Operation::CommandReplay => match request.input {
            Input::CommandReplay { payload } => { let command = match CommandId::try_new(payload.command_id) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) }; let dispatch = match DispatchId::try_new(payload.dispatch_id) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) }; owner.authorize_replay(command, dispatch).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"replayAuthorized"})))) }
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },

        Operation::SelectorPreview => match request.input {
            Input::SelectorPreview { payload } => {
                let constraints = match fleet::query::SelectorConstraints::try_new(
                    payload.endpoint_ids,
                    payload.node_ids,
                    payload.runtime_ids,
                    payload.labels,
                    payload.operation_ids,
                ) {
                    Ok(constraints) => constraints,
                    Err(_) => return Delivery::Invalid,
                };
                query_delivery(owner.selector_preview(constraints, SystemTime::now()).await, Delivery::SelectorPreview)
            }
            _ => Delivery::Unavailable,
        },
        Operation::TargetsList => query_delivery(owner.target_summaries().await, Delivery::Targets),
        Operation::TopologyGet => query_delivery(owner.topology_summary().await, Delivery::Topology),
        Operation::SnapshotGet => query_delivery(owner.snapshot(SystemTime::now()).await, Delivery::Snapshot),
        Operation::ConnectionsList
        | Operation::CapabilitiesList
        | Operation::EnvironmentsList
        | Operation::ResourcesList
        | Operation::CommandsList
        | Operation::AuditList
        | Operation::LeasesList
        | Operation::MetricsGet => {
            let snapshot = match query_value(owner.query_snapshot(SystemTime::now()).await) {
                QueryValue::Value(snapshot) => snapshot,
                QueryValue::Unavailable => return Delivery::Unavailable,
            };
            match request.operation {
                Operation::ConnectionsList => {
                    Delivery::Connections(snapshot.connections().to_vec())
                }
                        Operation::CapabilitiesList => {
                    Delivery::Capabilities(snapshot.capabilities().to_vec())
                }
                Operation::EnvironmentsList => {
                    Delivery::Environments(snapshot.environments().to_vec())
                }
                Operation::ResourcesList => Delivery::Resources(snapshot.resources().to_vec()),
                Operation::CommandsList => Delivery::Commands(snapshot.commands().to_vec()),
                Operation::AuditList => Delivery::Audit(snapshot.audit().to_vec()),
                Operation::LeasesList => Delivery::Leases(snapshot.leases().to_vec()),
                Operation::MetricsGet => Delivery::Metrics(snapshot),
                _ => unreachable!(),
            }
        }
    }
}

fn parse_terminal_open(
    payload: TerminalOpenPayload,
) -> Result<
    (
        crate::fleet::owner::FleetTerminalTargetSelector,
        fleet::terminal::Dimensions,
    ),
    (),
> {
    let selector = match (payload.node_id, payload.runtime_id, payload.endpoint_id) {
        (Some(node_id), None, None) => crate::fleet::owner::FleetTerminalTargetSelector::Node(
            NodeId::try_new(node_id).map_err(|_| ())?,
        ),
        (None, Some(runtime_id), None) => {
            crate::fleet::owner::FleetTerminalTargetSelector::Runtime(
                RuntimeId::try_new(runtime_id).map_err(|_| ())?,
            )
        }
        (None, None, Some(endpoint_id)) => {
            crate::fleet::owner::FleetTerminalTargetSelector::Endpoint(
                EndpointId::try_new(endpoint_id).map_err(|_| ())?,
            )
        }
        _ => return Err(()),
    };
    let dimensions = payload
        .size
        .map_or_else(
            || fleet::terminal::Dimensions::try_new(24, 80),
            |size| fleet::terminal::Dimensions::try_new(size.rows, size.cols),
        )
        .map_err(|_| ())?;
    Ok((selector, dimensions))
}

async fn terminal_open_delivery(owner: &FleetHandle, payload: TerminalOpenPayload) -> Delivery {
    let (selector, dimensions) = match parse_terminal_open(payload) {
        Ok(value) => value,
        Err(()) => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    match owner.terminal_open_allocated(selector, dimensions).await {
        Err(_) => Delivery::Unavailable,
        Ok(Err(_)) => Delivery::Mutation(json!({"outcome":"error"})),
        Ok(Ok(opened)) => Delivery::Mutation(terminal_session_json(
            "terminalOpened",
            &opened.opened,
            &opened.context,
        )),
    }
}

async fn terminal_reconnect_delivery(
    owner: &FleetHandle,
    payload: TerminalSessionPayload,
) -> Delivery {
    let session = match fleet::terminal::SessionId::try_new(payload.session_id) {
        Ok(session) => session,
        Err(_) => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let opened = match owner.terminal_reconnect(session).await {
        Err(_) => return Delivery::Unavailable,
        Ok(Err(_)) => return Delivery::Mutation(json!({"outcome":"error"})),
        Ok(Ok(opened)) => opened,
    };
    let context = match owner.terminal_context(opened.session.clone()).await {
        Err(_) | Ok(Err(_)) => {
            let _ = owner
                .terminal_close_fenced(opened.session.id().clone(), opened.session.generation())
                .await;
            return Delivery::Unavailable;
        }
        Ok(Ok(None)) => {
            let _ = owner
                .terminal_close_fenced(opened.session.id().clone(), opened.session.generation())
                .await;
            return Delivery::Mutation(json!({"outcome":"error"}));
        }
        Ok(Ok(Some(context))) => context,
    };
    Delivery::Mutation(terminal_session_json(
        "terminalReconnected",
        &opened,
        &context,
    ))
}

fn terminal_session_json(
    outcome: &str,
    opened: &fleet::terminal::OpenedSession,
    context: &crate::transport::fleet_terminal::TerminalContext,
) -> Value {
    json!({
        "outcome": outcome,
        "session": {
            "id": opened.session.id().as_str(),
            "nodeId": context.node.as_str(),
            "endpointId": context.endpoint.as_str(),
            "status": snapshot_session_status_name(opened.session.status()),
            "createdAt": timestamp(opened.session.created_at()),
            "updatedAt": timestamp(opened.session.updated_at()),
            "expiresAt": timestamp(opened.session.expires_at()),
        },
        "terminalConnection": {
            "sessionId": opened.session.id().as_str(),
            "ticket": base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(opened.ticket.as_bytes()),
            "websocketPath": "/api/remote-fleet/terminal/stream",
            "expiresAt": timestamp(opened.session.expires_at()),
        },
    })
}

async fn lifecycle_environment_deploy(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.run_environment_deployment(id, command_id, phase).await.map(|result| result.map(|outcome| json!({"outcome": match outcome { crate::fleet::lifecycle::FleetLifecycleOutcome::Completed | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "deploymentCompleted", crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "deploymentFailed", crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "deploymentUnknown" }}))),
        _ => owner.complete_environment_deployment(id, command_id, phase).await.map(|result| result.map(|_| json!({"outcome":"deploymentCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, |result| {
        result.map_or(Delivery::Mutation(json!({"outcome":"error"})), |value| {
            Delivery::Mutation(value)
        })
    })
}

async fn lifecycle_environment_deploy_fail(
    owner: &FleetHandle,
    payload: CommandFailurePayload,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .fail_environment_deployment(id, command_id, phase, payload.message)
        .await
        .map_or(Delivery::Unavailable, |result| {
            mutation_result(result.map(|_| json!({"outcome":"deploymentFailed"})))
        })
}

async fn lifecycle_environment_delete(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner
            .run_environment_deletion(id, command_id, phase)
            .await
            .map(|result| {
                result.map(|outcome| {
                    json!({"outcome": match outcome {
                        crate::fleet::lifecycle::FleetLifecycleOutcome::Completed
                        | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "deletionCompleted",
                        crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "deletionFailed",
                        crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "deletionUnknown",
                    }})
                })
            }),
        _ => owner
            .complete_environment_deletion(id, command_id, phase)
            .await
            .map(|result| result.map(|_| json!({"outcome":"deletionCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, mutation_result)
}

async fn lifecycle_environment_delete_fail(
    owner: &FleetHandle,
    payload: CommandFailurePayload,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .fail_environment_deletion(id, command_id, phase, payload.message)
        .await
        .map_or(Delivery::Unavailable, |result| {
            mutation_result(result.map(|_| json!({"outcome":"deletionFailed"})))
        })
}

async fn lifecycle_resource_provision(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        ManagedResourceId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.run_resource_provisioning(id, command_id, phase).await.map(|result| result.map(|outcome| json!({"outcome": match outcome { crate::fleet::lifecycle::FleetLifecycleOutcome::Completed | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "provisioningCompleted", crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "provisioningFailed", crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "provisioningUnknown" }}))),
        _ => owner.complete_resource_provisioning(id, command_id, phase).await.map(|result| result.map(|_| json!({"outcome":"provisioningCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, mutation_result)
}

async fn lifecycle_resource_delete(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        ManagedResourceId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.run_resource_deletion(id, command_id, phase).await.map(|result| result.map(|outcome| json!({"outcome": match outcome { crate::fleet::lifecycle::FleetLifecycleOutcome::Completed | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "deletionCompleted", crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "deletionFailed", crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "deletionUnknown" }}))),
        _ => owner.complete_resource_deletion(id, command_id, phase).await.map(|result| result.map(|_| json!({"outcome":"deletionCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, mutation_result)
}

async fn lifecycle_resource_delete_fail(
    owner: &FleetHandle,
    payload: CommandFailurePayload,
) -> Delivery {
    let (id, command_id, phase) = match (
        ManagedResourceId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .fail_resource_deletion(id, command_id, phase, payload.message)
        .await
        .map_or(Delivery::Unavailable, |result| {
            mutation_result(result.map(|_| json!({"outcome":"deletionFailed"})))
        })
}

async fn lifecycle_runtime(owner: &FleetHandle, payload: CommandIdPayload, step: u8) -> Delivery {
    let (id, command_id) = match (
        RuntimeId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
    ) {
        (Ok(id), Ok(command_id)) => (id, command_id),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.begin_runtime_start(id, command_id).await,
        1 => owner.complete_runtime_start(id, command_id).await,
        2 => owner.begin_runtime_stop(id, command_id).await,
        _ => owner.complete_runtime_stop(id, command_id).await,
    };
    result.map_or(Delivery::Unavailable, |result| {
        mutation_result(result.map(|_| json!({"outcome":"runtimeLifecycleUpdated"})))
    })
}

fn mutation_result(result: Result<Value, fleet::FleetDeliveryError>) -> Delivery {
    Delivery::Mutation(result.unwrap_or_else(|_| json!({"outcome":"error"})))
}

fn parse_connection(payload: ConnectionUpsertPayload) -> Result<ConnectionRecord, ()> {
    let id = ConnectionId::try_new(payload.id).map_err(|_| ())?;
    let kind = match payload.kind.as_str() {
        "sshHost" => ConnectionKind::SshHost,
        "container" => ConnectionKind::Container,
        "vm" => ConnectionKind::Vm,
        "kubernetesPod" => ConnectionKind::KubernetesPod,
        "custom" => ConnectionKind::Custom,
        _ => return Err(()),
    };
    let secret_refs = payload
        .secret_refs
        .into_iter()
        .map(|(name, value)| {
            fleet::FleetSecretRef::parse(&value)
                .map(|reference| (name, reference))
                .map_err(|_| ())
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    ConnectionRecord::register(
        id,
        kind,
        payload.display_name,
        payload.endpoint,
        payload.labels,
        payload.enabled,
        payload.public_config,
        secret_refs,
        SystemTime::now(),
    )
    .map_err(|_| ())
}

fn parse_environment(payload: EnvironmentRegisterPayload) -> Result<EnvironmentRecord, ()> {
    let id = EnvironmentId::try_new(payload.id).map_err(|_| ())?;
    let connection_id = ConnectionId::try_new(payload.connection_id).map_err(|_| ())?;
    let kind = match payload.kind.as_str() {
        "sshWorkdir" => EnvironmentKind::SshWorkdir,
        "dockerContainer" => EnvironmentKind::DockerContainer,
        "kubernetesWorkload" => EnvironmentKind::KubernetesWorkload,
        "vmWorkdir" => EnvironmentKind::VmWorkdir,
        "custom" => EnvironmentKind::Custom,
        _ => return Err(()),
    };
    let secret_refs = payload
        .secret_refs
        .into_iter()
        .map(|(name, value)| {
            fleet::FleetSecretRef::parse(&value)
                .map(|reference| (name, reference))
                .map_err(|_| ())
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    EnvironmentRecord::register(
        id,
        connection_id,
        payload.display_name,
        kind,
        payload.labels,
        payload.enabled,
        payload.public_config,
        secret_refs,
        SystemTime::now(),
    )
    .map_err(|_| ())
}

fn parse_resource(
    payload: ResourceRegisterPayload,
) -> Result<ManagedResourceRegistrationRequest, ()> {
    let requested_id = payload.id;
    ManagedResourceId::try_new(requested_id.clone()).map_err(|_| ())?;
    let connection_id = ConnectionId::try_new(payload.connection_id).map_err(|_| ())?;
    let environment_id = EnvironmentId::try_new(payload.environment_id).map_err(|_| ())?;
    let provider = match payload.provider.as_str() {
        "docker" => ManagedResourceProvider::Docker,
        "kubernetes" => ManagedResourceProvider::Kubernetes,
        "ssh" => ManagedResourceProvider::Ssh,
        "vm" => ManagedResourceProvider::Vm,
        "custom" => ManagedResourceProvider::Custom,
        _ => return Err(()),
    };
    let kind = match payload.kind.as_str() {
        "dockerContainer" => ManagedResourceKind::DockerContainer,
        "kubernetesWorkload" => ManagedResourceKind::KubernetesWorkload,
        "kubernetesDeployment" => ManagedResourceKind::KubernetesDeployment,
        "kubernetesService" => ManagedResourceKind::KubernetesService,
        "kubernetesSecret" => ManagedResourceKind::KubernetesSecret,
        "sshAgentInstallation" => ManagedResourceKind::SshAgentInstallation,
        "vmAgentInstallation" => ManagedResourceKind::VmAgentInstallation,
        "custom" => ManagedResourceKind::Custom,
        _ => return Err(()),
    };
    let ownership = match payload.ownership.as_str() {
        "matchaManaged" => Ownership::MatchaManaged,
        "unverified" => Ownership::Unverified,
        "external" => Ownership::External,
        _ => return Err(()),
    };
    let cleanup_policy = match payload.cleanup_policy.as_str() {
        "deleteOnEnvironmentDelete" => CleanupPolicy::DeleteOnEnvironmentDelete,
        "uninstallAgentOnly" => CleanupPolicy::UninstallAgentOnly,
        "orphan" => CleanupPolicy::Orphan,
        "none" => CleanupPolicy::None,
        _ => return Err(()),
    };
    Ok(ManagedResourceRegistrationRequest {
        requested_id,
        connection_id,
        environment_id,
        provider,
        kind,
        remote_resource_id: payload.remote_resource_id,
        ownership,
        cleanup_policy,
    })
}

fn parse_capability_sync(
    payload: CapabilitySyncPayload,
) -> Result<fleet::topology::CapabilitySync, ()> {
    let metadata = ObservationMetadata::new(
        match payload.metadata.source.as_str() {
            "discovery" => ObservationSource::Discovery,
            "healthProbe" => ObservationSource::HealthProbe,
            "runtimeAgent" => ObservationSource::RuntimeAgent,
            _ => return Err(()),
        },
        parse_timestamp(&payload.metadata.observed_at).ok_or(())?,
        match payload.metadata.freshness.as_str() {
            "current" => ObservationFreshness::Current,
            "stale" => ObservationFreshness::Stale,
            "unknown" => ObservationFreshness::Unknown,
            "pruned" => ObservationFreshness::Pruned,
            _ => return Err(()),
        },
    );
    let mut capabilities = Vec::with_capacity(payload.capabilities.len());
    let mut availability = Vec::with_capacity(payload.capabilities.len());
    for item in payload.capabilities {
        let id = CapabilityId::try_new(item.id).map_err(|_| ())?;
        let scope = match item.scope.as_str() {
            "endpoint" => CapabilityScope::Endpoint,
            "agent" => CapabilityScope::Agent,
            "session" => CapabilityScope::Session,
            _ => return Err(()),
        };
        capabilities.push(SupportedCapability::new(id, scope));
        availability.push(match item.availability.as_str() {
            "available" => CapabilityAvailability::Available,
            "unavailable" => CapabilityAvailability::Unavailable,
            "unknown" => CapabilityAvailability::Unknown,
            _ => return Err(()),
        });
    }
    Ok(fleet::topology::CapabilitySync {
        capabilities,
        availability,
        metadata,
    })
}

fn parse_timestamp(value: &str) -> Option<SystemTime> {
    let millis = value.strip_prefix("unix:")?.parse::<u64>().ok()?;
    Some(UNIX_EPOCH + std::time::Duration::from_millis(millis))
}

fn observation_metadata() -> ObservationMetadata {
    ObservationMetadata::new(
        ObservationSource::HealthProbe,
        SystemTime::now(),
        ObservationFreshness::Current,
    )
}

fn parse_topology_association(
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
) -> Result<fleet::topology::TopologyAssociation, ()> {
    Ok(fleet::topology::TopologyAssociation::new(
        connection_id
            .map(ConnectionId::try_new)
            .transpose()
            .map_err(|_| ())?,
        environment_id
            .map(EnvironmentId::try_new)
            .transpose()
            .map_err(|_| ())?,
        managed_resource_id
            .map(ManagedResourceId::try_new)
            .transpose()
            .map_err(|_| ())?,
    ))
}

fn parse_node(payload: NodeUpsertPayload) -> Result<NodeObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = NodeId::try_new(payload.id).map_err(|_| ())?;
    let health = match payload.health.as_str() {
        "unknown" => NodeHealth::Unknown,
        "online" => NodeHealth::Online {
            last_seen_at: SystemTime::now(),
        },
        "offline" => NodeHealth::Offline {
            last_seen_at: Some(SystemTime::now()),
        },
        "disabled" => NodeHealth::Disabled,
        "error" => NodeHealth::Error,
        _ => return Err(()),
    };
    Ok(NodeObservation::with_association(
        id,
        association,
        health,
        observation_metadata(),
    ))
}

fn parse_agent(payload: AgentUpsertPayload) -> Result<AgentObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = NativeAgentId::try_new(payload.id).map_err(|_| ())?;
    let node_id = NodeId::try_new(payload.node_id).map_err(|_| ())?;
    Ok(AgentObservation::with_association(
        id,
        node_id,
        association,
        observation_metadata(),
    ))
}

fn parse_runtime(payload: RuntimeUpsertPayload) -> Result<RuntimeObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = RuntimeId::try_new(payload.id).map_err(|_| ())?;
    let node_id = NodeId::try_new(payload.node_id).map_err(|_| ())?;
    let agent_id = payload
        .agent_id
        .map(|value| NativeAgentId::try_new(value).map_err(|_| ()))
        .transpose()?;
    let kind = match payload.kind.as_str() {
        "openClaw" => RuntimeKind::OpenClaw,
        "matchaAgent" => RuntimeKind::MatchaAgent,
        "plugin" => RuntimeKind::Plugin,
        _ => return Err(()),
    };
    let state = match payload.state.as_str() {
        "discovered" => RuntimeState::Discovered,
        "running" => RuntimeState::Running {
            started_at: SystemTime::now(),
        },
        "stopped" => RuntimeState::Stopped {
            stopped_at: Some(SystemTime::now()),
        },
        "degraded" => RuntimeState::Degraded,
        "retired" => RuntimeState::Retired {
            retired_at: SystemTime::now(),
        },
        _ => return Err(()),
    };
    Ok(RuntimeObservation::with_association(
        id,
        node_id,
        agent_id,
        association,
        kind,
        state,
        observation_metadata(),
    ))
}

fn parse_endpoint(payload: EndpointUpsertPayload) -> Result<EndpointObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = EndpointId::try_new(payload.id).map_err(|_| ())?;
    let node_id = NodeId::try_new(payload.node_id).map_err(|_| ())?;
    let runtime_id = RuntimeId::try_new(payload.runtime_id).map_err(|_| ())?;
    let health = match payload.health.as_str() {
        "unknown" => EndpointHealth::Unknown,
        "ready" => EndpointHealth::Ready,
        "busy" => EndpointHealth::Busy,
        "draining" => EndpointHealth::Draining,
        "unhealthy" => EndpointHealth::Unhealthy,
        "retired" => EndpointHealth::Retired,
        _ => return Err(()),
    };
    Ok(EndpointObservation::with_association(
        id,
        node_id,
        runtime_id,
        association,
        health,
        Vec::new(),
        Vec::new(),
        observation_metadata(),
    ))
}

fn parse_secret(value: Option<String>) -> Result<Option<fleet::FleetSecretRef>, ()> {
    value
        .map(|value| fleet::FleetSecretRef::parse(&value).map_err(|_| ()))
        .transpose()
}

fn parse_target_put(payload: TargetPutPayload) -> Result<(TargetId, FleetTargetConfig), ()> {
    let id = TargetId::try_new(payload.id).map_err(|_| ())?;
    let config = match payload.target {
        TargetConfigPayload::Docker {
            endpoint,
            container_name,
            image,
            secret_ref,
        } => FleetTargetConfig::Docker(
            DockerTargetConfig::try_new(endpoint, container_name, image, parse_secret(secret_ref)?)
                .map_err(|_| ())?,
        ),
        TargetConfigPayload::Kubernetes {
            api_server,
            namespace,
            deployment_name,
            service_name,
            image,
            secret_ref,
        } => FleetTargetConfig::Kubernetes(
            KubernetesTargetConfig::try_new(
                api_server,
                namespace,
                deployment_name,
                service_name,
                image,
                fleet::FleetSecretRef::parse(&secret_ref).map_err(|_| ())?,
            )
            .map_err(|_| ())?,
        ),
        TargetConfigPayload::Ssh {
            host,
            port,
            username,
            auth_kind,
            secret_ref,
            install_command,
        } => {
            let secret = fleet::FleetSecretRef::parse(&secret_ref).map_err(|_| ())?;
            let authentication = match auth_kind.as_str() {
                "privateKey" => SshAuthentication::PrivateKey(secret),
                "password" => SshAuthentication::Password(secret),
                _ => return Err(()),
            };
            FleetTargetConfig::Ssh(
                SshTargetConfig::try_new(host, port, username, authentication, install_command)
                    .map_err(|_| ())?,
            )
        }
        TargetConfigPayload::Custom {
            endpoint,
            secret_ref,
        } => FleetTargetConfig::Custom(
            CustomTargetConfig::try_new(endpoint, parse_secret(secret_ref)?).map_err(|_| ())?,
        ),
    };
    Ok((id, config))
}

fn parse_node_command_submit(
    payload: NodeCommandSubmitPayload,
) -> Result<crate::fleet::owner::FleetNodeCommandRequest, ()> {
    let kind = match payload.kind.as_str() {
        "probeNode" => CommandKind::ProbeNode,
        "installAgent" => CommandKind::InstallAgent,
        _ => return Err(()),
    };
    Ok(crate::fleet::owner::FleetNodeCommandRequest {
        node_id: NodeId::try_new(payload.node_id).map_err(|_| ())?,
        command_id: CommandId::try_new(payload.command_id).map_err(|_| ())?,
        idempotency_key: IdempotencyKey::try_new(payload.idempotency_key).map_err(|_| ())?,
        dispatch_id: DispatchId::try_new(payload.dispatch_id).map_err(|_| ())?,
        kind,
    })
}

fn parse_submit(
    payload: CommandSubmitPayload,
    selector: FleetTargetSelector,
) -> Result<fleet::FleetDeliveryRequest, ()> {
    let command_id = CommandId::try_new(payload.command_id).map_err(|_| ())?;
    let key = IdempotencyKey::try_new(payload.idempotency_key).map_err(|_| ())?;
    let target = match payload.target {
        CommandTargetPayload::Node { node_id } => {
            CommandTarget::Node(fleet::topology::NodeId::try_new(node_id).map_err(|_| ())?)
        }
        CommandTargetPayload::Runtime {
            node_id,
            runtime_id,
        } => CommandTarget::Runtime {
            node_id: fleet::topology::NodeId::try_new(node_id).map_err(|_| ())?,
            runtime_id: fleet::topology::RuntimeId::try_new(runtime_id).map_err(|_| ())?,
        },
        CommandTargetPayload::Endpoint {
            node_id,
            runtime_id,
            endpoint_id,
        } => CommandTarget::Endpoint {
            node_id: fleet::topology::NodeId::try_new(node_id).map_err(|_| ())?,
            runtime_id: fleet::topology::RuntimeId::try_new(runtime_id).map_err(|_| ())?,
            endpoint_id: EndpointId::try_new(endpoint_id).map_err(|_| ())?,
        },
    };
    let kind = match payload.kind.as_str() {
        "probeNode" => CommandKind::ProbeNode,
        "installAgent" => CommandKind::InstallAgent,
        "startRuntime" => CommandKind::StartRuntime,
        "stopRuntime" => CommandKind::StopRuntime,
        "syncCapabilities" => CommandKind::SyncCapabilities,
        "upgradeAgent" => CommandKind::UpgradeAgent,
        "mountWorkspace" => CommandKind::MountWorkspace,
        "exposePort" => CommandKind::ExposePort,
        _ => return Err(()),
    };
    let agent = NativeAgentId::try_new(payload.agent_id).map_err(|_| ())?;
    let dispatch_id = DispatchId::try_new(payload.dispatch_id).map_err(|_| ())?;
    let command = CommandIntent::new(command_id.clone(), key, target, kind, SystemTime::now());
    let dispatch = DispatchIntent::for_target(dispatch_id, command_id, agent, selector);
    fleet::FleetDeliveryRequest::try_new(command, dispatch).map_err(|_| ())
}

fn execution_outcome_json(outcome: crate::fleet::executor::FleetExecutionOutcome) -> Value {
    json!({"outcome": match outcome {
        crate::fleet::executor::FleetExecutionOutcome::Accepted => "accepted",
        crate::fleet::executor::FleetExecutionOutcome::Completed => "completed",
        crate::fleet::executor::FleetExecutionOutcome::Rejected => "rejected",
        crate::fleet::executor::FleetExecutionOutcome::Unknown => "outcomeUnknown",
    }})
}

fn delivery_outcome_json(outcome: fleet::FleetDeliveryOutcome, operation: u8) -> Value {
    json!({"outcome": match (outcome, operation) { (fleet::FleetDeliveryOutcome::Recorded, 0) => "accepted", (fleet::FleetDeliveryOutcome::Recorded, 1) => "rejected", (fleet::FleetDeliveryOutcome::Recorded, _) => "outcomeUnknown", (fleet::FleetDeliveryOutcome::AlreadyRecorded, _) => "alreadyRecorded", (fleet::FleetDeliveryOutcome::Replayed, _) => "replayed" }})
}

fn fleet_snapshot_json(snapshot: &crate::fleet::owner::FleetSnapshot) -> Value {
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
        "displayName": metadata.map(|value| value.display_name()),
        "status": snapshot_resource_status_name(item.state()),
        "ownership": ownership_name(item.ownership()),
        "cleanupPolicy": cleanup_policy_name(item.cleanup_policy()),
        "labels": metadata.map(|value| value.labels().iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>()),
        "createdAt": timestamp(item.created_at()),
        "updatedAt": timestamp(item.updated_at()),
        "lastObservedAt": metadata.map(|value| timestamp(value.observed_at())),
    })
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

fn snapshot_session_status_name(status: fleet::terminal::SessionStatus) -> &'static str {
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

fn selector_target_json(selector: &FleetTargetSelector) -> Value {
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
        "displayName": metadata.map(|value| value.display_name()),
        "ownership": ownership_name(item.ownership()),
        "cleanupPolicy": cleanup_policy_name(item.cleanup_policy()),
        "labels": metadata.map(|value| value.labels().iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>()),
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

fn command_state_json(state: &CommandSummaryState) -> Value {
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

fn target_kind_name(kind: fleet::TargetKind) -> &'static str {
    match kind {
        fleet::TargetKind::Docker => "docker",
        fleet::TargetKind::Kubernetes => "kubernetes",
        fleet::TargetKind::Ssh => "ssh",
        fleet::TargetKind::Custom => "custom",
    }
}

fn connection_kind_name(kind: fleet::connection::ConnectionKind) -> &'static str {
    match kind {
        fleet::connection::ConnectionKind::SshHost => "sshHost",
        fleet::connection::ConnectionKind::Container => "container",
        fleet::connection::ConnectionKind::Vm => "vm",
        fleet::connection::ConnectionKind::KubernetesPod => "kubernetesPod",
        fleet::connection::ConnectionKind::Custom => "custom",
    }
}

fn environment_kind_name(kind: fleet::environment::EnvironmentKind) -> &'static str {
    match kind {
        fleet::environment::EnvironmentKind::SshWorkdir => "sshWorkdir",
        fleet::environment::EnvironmentKind::DockerContainer => "dockerContainer",
        fleet::environment::EnvironmentKind::KubernetesWorkload => "kubernetesWorkload",
        fleet::environment::EnvironmentKind::VmWorkdir => "vmWorkdir",
        fleet::environment::EnvironmentKind::Custom => "custom",
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

fn timestamp(value: SystemTime) -> String {
    let millis = value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix:{millis}")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet},
        time::Duration,
    };

    use super::*;
    use crate::fleet::owner::FleetSnapshot;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use fleet::{
        audit::{FleetAuditEntry, FleetAuditEvent, FleetAuditEventInput, FleetAuditValue},
        command::{CommandIntent, CommandRecord, CommandTarget},
        environment::{EnvironmentState, ManagedResourceRecord},
        lease::{Lease, LeaseOwner, LeaseOwnerKind, LeaseState},
        store::{FleetFacts, FleetFactsRestoreInput},
        terminal::{
            Dimensions as TerminalDimensions, ProviderId as TerminalProviderId,
            SessionId as TerminalSessionId, TargetId as TerminalTargetId, TerminalSessionOwner,
        },
        topology::TopologyAssociation,
    };
    use platform::capability::{CapabilityId, CapabilityScope, SupportedCapability};
    use platform::endpoint::NativeAgentId;

    #[test]
    fn request_is_strict_and_operation_input_must_match() {
        let valid = json!({"operation":"fleet.connections.list","input":{"kind":"connections"}});
        let mut checked_verifier = verifier();
        assert!(
            Request::decode(
                valid,
                &decision("fleet.connections.list"),
                &mut checked_verifier,
                1
            )
            .is_ok()
        );

        for invalid in [
            json!({"operation":"fleet.connections.list","input":{"kind":"connections"},"id":"fleet"}),
            json!({"operation":"fleet.connections.list","input":{"kind":"resources"}}),
            json!({"operation":"fleet.unknown","input":{"kind":"connections"}}),
        ] {
            let mut verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision("fleet.connections.list"),
                    &mut verifier,
                    1
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn non_selector_read_operations_have_exact_input_kinds() {
        for (operation, kind) in [
            ("fleet.targets.list", "list"),
            ("fleet.topology.get", "topology"),
            ("fleet.connections.list", "connections"),
            ("fleet.capabilities.list", "capabilities"),
            ("fleet.environments.list", "environments"),
            ("fleet.resources.list", "resources"),
            ("fleet.commands.list", "commands"),
            ("fleet.audit.list", "audit"),
            ("fleet.leases.list", "leases"),
            ("fleet.metrics.get", "metrics"),
            ("fleet.snapshot.get", "snapshot"),
        ] {
            let mut verifier = verifier();
            assert!(
                Request::decode(
                    json!({"operation":operation,"input":{"kind":kind}}),
                    &decision(operation),
                    &mut verifier,
                    1
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn snapshot_read_requires_exact_capability_and_read_scope() {
        let request = json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot"}});
        let mut valid_verifier = verifier();
        assert!(
            Request::decode(
                request.clone(),
                &decision("fleet.snapshot.get"),
                &mut valid_verifier,
                1,
            )
            .is_ok()
        );

        for invalid in [
            json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot","extra":true}}),
            json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot"},"extra":true}),
            json!({"operation":"fleet.snapshot.get","input":{"kind":"metrics"}}),
        ] {
            let mut invalid_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision("fleet.snapshot.get"),
                    &mut invalid_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }

        let mut wrong_capability_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision("fleet.metrics.get"),
                &mut wrong_capability_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        let mut write_scope_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request,
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.snapshot.get",
                ),
                &mut write_scope_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn selector_preview_operation_requires_strict_selector_input() {
        let valid = json!({
            "operation": "fleet.selector.preview",
            "input": {"kind": "selectorPreview", "payload": {
                "endpointIds": ["endpoint-1"], "nodeIds": [], "runtimeIds": [],
                "labels": ["production"], "operationIds": []
            }}
        });
        let mut valid_verifier = verifier();
        assert!(
            Request::decode(
                valid,
                &decision("fleet.selector.preview"),
                &mut valid_verifier,
                1
            )
            .is_ok()
        );

        let mut invalid_verifier = verifier();
        assert!(matches!(
            Request::decode(
                json!({"operation":"fleet.selector.preview","input":{"kind":"selectorPreview","payload":{"endpointIds":[],"nodeIds":[],"runtimeIds":[],"labels":[],"operationIds":[],"extra":true}}}),
                &decision("fleet.selector.preview"),
                &mut invalid_verifier,
                1
            ),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn authorization_is_bound_to_route_scope_operation_and_subject() {
        let mut verifier = verifier();
        let error = Request::decode(
            json!({"operation":"fleet.connections.list","input":{"kind":"connections"}}),
            &decision_for("/api/other", "fleet:read", "fleet.connections.list"),
            &mut verifier,
            1,
        );
        assert!(matches!(error, Err(DecodeError::Unauthorized)));
    }

    #[test]
    fn mutation_operations_require_write_scope_and_reject_queued_at() {
        let input = json!({
            "operation":"fleet.commands.begin",
            "input":{"kind":"commandBegin","payload":{"dispatchId":"dispatch-1"}}
        });
        let mut read_verifier = verifier();
        assert!(matches!(
            Request::decode(
                input.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    AUTHORIZATION_SCOPE,
                    "fleet.commands.begin"
                ),
                &mut read_verifier,
                1
            ),
            Err(DecodeError::Unauthorized)
        ));

        let mut write_verifier = verifier();
        assert!(
            Request::decode(
                input,
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.commands.begin"
                ),
                &mut write_verifier,
                1
            )
            .is_ok()
        );

        let mut queued_at_verifier = verifier();
        assert!(matches!(
            Request::decode(
                json!({
                    "operation":"fleet.commands.begin",
                    "input":{"kind":"commandBegin","payload":{"dispatchId":"dispatch-1","queuedAt":1}}
                }),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.commands.begin"
                ),
                &mut queued_at_verifier,
                1
            ),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn connection_probe_operations_require_write_scope() {
        for (operation, input) in [
            (
                "fleet.connections.probe.begin",
                json!({
                    "operation": "fleet.connections.probe.begin",
                    "input": {
                        "kind": "connectionProbeBegin",
                        "payload": {"id": "connection-1", "commandId": "command-1"}
                    }
                }),
            ),
            (
                "fleet.connections.probe.complete",
                json!({
                    "operation": "fleet.connections.probe.complete",
                    "input": {
                        "kind": "connectionProbeComplete",
                        "payload": {
                            "id": "connection-1",
                            "commandId": "command-1",
                            "outcome": "ready"
                        }
                    }
                }),
            ),
        ] {
            let mut read_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    input.clone(),
                    &decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, operation),
                    &mut read_verifier,
                    1,
                ),
                Err(DecodeError::Unauthorized)
            ));

            let mut write_verifier = verifier();
            assert!(
                Request::decode(
                    input,
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        operation,
                    ),
                    &mut write_verifier,
                    1,
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn runtime_and_capability_begin_operations_require_write_scope_and_exact_signed_binding() {
        for (operation, kind, mismatched_kind, expected_operation) in [
            (
                "fleet.runtimes.start.begin",
                "runtimeStartBegin",
                "runtimeStopBegin",
                Operation::RuntimeStartBegin,
            ),
            (
                "fleet.runtimes.stop.begin",
                "runtimeStopBegin",
                "runtimeStartBegin",
                Operation::RuntimeStopBegin,
            ),
            (
                "fleet.capabilities.sync.begin",
                "capabilitySyncBegin",
                "runtimeStartBegin",
                Operation::CapabilitySyncBegin,
            ),
        ] {
            let request = json!({
                "operation": operation,
                "input": {
                    "kind": kind,
                    "payload": {"id": "runtime-1", "commandId": "command-1"}
                }
            });
            let mut valid_verifier = verifier();
            let decoded = Request::decode(
                request.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    operation,
                ),
                &mut valid_verifier,
                1,
            )
            .expect("write-scoped Fleet begin request should decode");
            assert_eq!(decoded.operation, expected_operation);

            for authorization in [
                decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, operation),
                decision_for(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    "fleet.commands.begin",
                ),
                decision_for("/api/other", MUTATION_AUTHORIZATION_SCOPE, operation),
                decision_for_subject(
                    AUTHORIZATION_ENDPOINT,
                    MUTATION_AUTHORIZATION_SCOPE,
                    operation,
                    "not-fleet",
                ),
            ] {
                let mut rejected_verifier = verifier();
                assert!(matches!(
                    Request::decode(request.clone(), &authorization, &mut rejected_verifier, 1),
                    Err(DecodeError::Unauthorized)
                ));
            }

            let mut mismatched_input_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    json!({
                        "operation": operation,
                        "input": {
                            "kind": mismatched_kind,
                            "payload": {"id": "runtime-1", "commandId": "command-1"}
                        }
                    }),
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        operation,
                    ),
                    &mut mismatched_input_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn terminal_close_requires_exact_write_contract() {
        let request = json!({
            "operation": "fleet.terminals.close",
            "input": {
                "kind": "terminalClose",
                "payload": {"sessionId": "session-1"}
            }
        });
        let mut valid_verifier = verifier();
        let decoded = Request::decode(
            request.clone(),
            &decision_for(
                AUTHORIZATION_ENDPOINT,
                MUTATION_AUTHORIZATION_SCOPE,
                "fleet.terminals.close",
            ),
            &mut valid_verifier,
            1,
        )
        .expect("single terminal close request should decode");
        assert!(matches!(decoded.operation, Operation::TerminalClose));
        assert!(matches!(
            decoded.input,
            Input::TerminalClose { payload } if payload.session_id == "session-1"
        ));

        let mut read_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    AUTHORIZATION_SCOPE,
                    "fleet.terminals.close",
                ),
                &mut read_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        let mut wrong_capability_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision("fleet.terminals.close.complete"),
                &mut wrong_capability_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        for invalid in [
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalClose",
                    "payload": {"sessionId": "session-1", "reason": "done"}
                }
            }),
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalClose",
                    "payload": {"sessionId": "session-1"},
                    "extra": true
                }
            }),
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalClose",
                    "payload": {"sessionId": "session-1"}
                },
                "extra": true
            }),
            json!({
                "operation": "fleet.terminals.close",
                "input": {
                    "kind": "terminalBeginClose",
                    "payload": {"sessionId": "session-1"}
                }
            }),
        ] {
            let mut invalid_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        "fleet.terminals.close",
                    ),
                    &mut invalid_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }

    #[test]
    fn terminal_close_delivery_is_sealed_and_uses_public_failures() {
        let success = Delivery::Mutation(json!({"outcome":"terminalClosed"}));
        assert_eq!(success.status_code(), 200);
        assert_eq!(success.body(), json!({"outcome":"terminalClosed"}));

        let failure = Delivery::Mutation(json!({"outcome":"error"}));
        assert_eq!(failure.status_code(), 200);
        assert_eq!(failure.body(), json!({"outcome":"error"}));

        let unavailable = Delivery::Unavailable;
        assert_eq!(unavailable.status_code(), 503);
        assert_eq!(
            unavailable.body(),
            json!({"success":false,"error":"Fleet data is unavailable"})
        );
    }

    #[test]
    fn terminal_session_projection_uses_public_websocket_path() {
        let mut owner = TerminalSessionOwner::default();
        let opened = owner
            .open(
                TerminalSessionId::try_new("session-1").unwrap(),
                TerminalTargetId::try_new("target-1").unwrap(),
                TerminalProviderId::try_new("docker").unwrap(),
                TerminalDimensions::try_new(24, 80).unwrap(),
                SystemTime::UNIX_EPOCH + Duration::from_secs(1),
            )
            .unwrap();
        let context = crate::transport::fleet_terminal::TerminalContext {
            session: opened.session.id().clone(),
            target: opened.session.target().clone(),
            provider: opened.session.provider().clone(),
            generation: opened.session.generation(),
            node: NodeId::try_new("node-1").unwrap(),
            endpoint: EndpointId::try_new("endpoint-1").unwrap(),
            rows: 24,
            cols: 80,
        };

        let value = terminal_session_json("terminalOpened", &opened, &context);

        assert_eq!(
            value["terminalConnection"]["websocketPath"],
            json!("/api/remote-fleet/terminal/stream")
        );
        assert_ne!(
            value["terminalConnection"]["websocketPath"],
            json!("/api/fleet/terminal")
        );
    }

    #[test]
    fn sensitive_fields_are_not_present_in_safe_command_projection() {
        let state = CommandSummaryState::Failed {
            completed_at: SystemTime::UNIX_EPOCH,
            failure: fleet::command::CommandFailure::ExecutionFailed,
        };
        let value = command_state_json(&state);
        assert_eq!(
            value,
            json!({
                "kind":"failed",
                "completedAt":"unix:0",
                "failure":"executionFailed"
            })
        );
    }

    #[test]
    fn fleet_snapshot_is_source_backed_and_sealed_field_by_field() {
        let snapshot = snapshot_fixture();
        let value = fleet_snapshot_json(&snapshot);

        assert_exact_keys(
            &value,
            [
                "connections",
                "environments",
                "managedResources",
                "nodes",
                "agents",
                "runtimes",
                "endpoints",
                "capabilities",
                "commands",
                "leases",
                "sessions",
                "auditEvents",
                "updatedAt",
            ],
        );
        assert_eq!(value["updatedAt"], json!("unix:9000"));

        let connection = record_by_id(&value["connections"], "connection-1");
        assert_exact_keys(
            connection,
            [
                "id",
                "displayName",
                "connectionKind",
                "status",
                "labels",
                "enabled",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_eq!(connection["status"], json!("unknown"));
        assert!(!connection.as_object().unwrap().contains_key("endpoint"));
        assert!(!connection.as_object().unwrap().contains_key("publicConfig"));
        assert!(!connection.as_object().unwrap().contains_key("secretRefs"));

        let environment = record_by_id(&value["environments"], "environment-1");
        assert_exact_keys(
            environment,
            [
                "id",
                "connectionId",
                "displayName",
                "environmentKind",
                "status",
                "labels",
                "enabled",
                "createdAt",
                "updatedAt",
            ],
        );
        assert_eq!(environment["status"], json!("ready"));
        assert!(
            !environment
                .as_object()
                .unwrap()
                .contains_key("publicConfig")
        );
        assert!(!environment.as_object().unwrap().contains_key("secretRefs"));

        let resource = record_by_id(&value["managedResources"], "resource-1");
        assert_exact_keys(
            resource,
            [
                "id",
                "connectionId",
                "environmentId",
                "nodeId",
                "providerKind",
                "resourceKind",
                "remoteResourceId",
                "displayName",
                "status",
                "ownership",
                "cleanupPolicy",
                "labels",
                "createdAt",
                "updatedAt",
                "lastObservedAt",
            ],
        );

        let node = record_by_id(&value["nodes"], "node-1");
        assert_exact_keys(
            node,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "status",
                "lastSeenAt",
            ],
        );
        let agent = record_by_id(&value["agents"], "agent-1");
        assert_exact_keys(
            agent,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
            ],
        );
        let runtime = record_by_id(&value["runtimes"], "runtime-1");
        assert_exact_keys(
            runtime,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "agentId",
                "status",
                "startedAt",
            ],
        );
        assert_eq!(runtime["startedAt"], json!("unix:2000"));
        let stopped_runtime = record_by_id(&value["runtimes"], "runtime-stopped");
        assert_exact_keys(
            stopped_runtime,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "agentId",
                "status",
                "startedAt",
            ],
        );
        assert_eq!(stopped_runtime["status"], json!("stopped"));
        assert_eq!(stopped_runtime["startedAt"], Value::Null);
        let endpoint = record_by_id(&value["endpoints"], "endpoint-1");
        assert_exact_keys(
            endpoint,
            [
                "id",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "runtimeId",
                "status",
                "lastProbeAt",
            ],
        );
        let capability = record_by_id(&value["capabilities"], "session.prompt");
        assert_exact_keys(
            &capability,
            ["id", "endpointId", "nodeId", "runtimeId", "status"],
        );
        assert_eq!(capability["status"], json!("current"));

        for (id, expected_keys) in [
            (
                "command-node",
                vec![
                    "id",
                    "command",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "nodeId",
                ],
            ),
            (
                "command-runtime",
                vec![
                    "id",
                    "command",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "nodeId",
                    "runtimeId",
                ],
            ),
            (
                "command-endpoint",
                vec![
                    "id",
                    "command",
                    "status",
                    "createdAt",
                    "updatedAt",
                    "nodeId",
                    "runtimeId",
                    "endpointId",
                ],
            ),
        ] {
            let command = record_by_id(&value["commands"], id);
            assert_exact_keys(command, expected_keys);
            for forbidden in [
                "idempotencyKey",
                "input",
                "payload",
                "effect",
                "error",
                "stdout",
                "stderr",
                "log",
            ] {
                assert!(!command.as_object().unwrap().contains_key(forbidden));
            }
        }

        for lease_id in ["lease-released", "lease-expired"] {
            let lease = record_by_id(&value["leases"], lease_id);
            assert_exact_keys(
                lease,
                [
                    "id",
                    "endpointId",
                    "ownerKind",
                    "ownerId",
                    "status",
                    "expiresAt",
                ],
            );
            assert_eq!(lease["expiresAt"], Value::Null);
        }

        let session = record_by_id(&value["sessions"], "session-1");
        assert_exact_keys(
            session,
            [
                "id",
                "nodeId",
                "status",
                "createdAt",
                "updatedAt",
                "expiresAt",
            ],
        );
        assert_eq!(session["nodeId"], json!("node-1"));
        for forbidden in ["targetId", "provider", "dimensions", "generation", "ticket"] {
            assert!(!session.as_object().unwrap().contains_key(forbidden));
        }

        let audit = record_by_id(&value["auditEvents"], "audit:1");
        assert_exact_keys(
            audit,
            [
                "id",
                "eventName",
                "occurredAt",
                "connectionId",
                "environmentId",
                "managedResourceId",
                "nodeId",
                "agentId",
                "runtimeId",
                "endpointId",
                "commandId",
            ],
        );
        for forbidden in ["message", "metadata", "stdout", "stderr", "log"] {
            assert!(!audit.as_object().unwrap().contains_key(forbidden));
        }
    }

    fn snapshot_fixture() -> FleetSnapshot {
        let created_at = UNIX_EPOCH + Duration::from_millis(1000);
        let observed_at = UNIX_EPOCH + Duration::from_millis(2000);
        let snapshot_at = UNIX_EPOCH + Duration::from_millis(9000);
        let connection_id = fleet::connection::ConnectionId::try_new("connection-1").unwrap();
        let environment_id = fleet::environment::EnvironmentId::try_new("environment-1").unwrap();
        let resource_id = fleet::environment::ManagedResourceId::try_new("resource-1").unwrap();
        let node_id = fleet::topology::NodeId::try_new("node-1").unwrap();
        let runtime_id = fleet::topology::RuntimeId::try_new("runtime-1").unwrap();
        let endpoint_id = EndpointId::try_new("endpoint-1").unwrap();
        let agent_id = NativeAgentId::try_new("agent-1").unwrap();
        let association = TopologyAssociation::new(
            Some(connection_id.clone()),
            Some(environment_id.clone()),
            Some(resource_id.clone()),
        );
        let metadata = fleet::topology::ObservationMetadata::new(
            fleet::topology::ObservationSource::RuntimeAgent,
            observed_at,
            fleet::topology::ObservationFreshness::Current,
        );
        let topology = fleet::topology::FleetTopologyFacts::restore(
            vec![fleet::topology::NodeObservation::with_association(
                node_id.clone(),
                association.clone(),
                fleet::topology::NodeHealth::Online {
                    last_seen_at: observed_at,
                },
                metadata,
            )],
            vec![fleet::topology::AgentObservation::with_association(
                agent_id.clone(),
                node_id.clone(),
                association.clone(),
                metadata,
            )],
            vec![
                fleet::topology::RuntimeObservation::with_association(
                    runtime_id.clone(),
                    node_id.clone(),
                    Some(agent_id.clone()),
                    association.clone(),
                    fleet::topology::RuntimeKind::OpenClaw,
                    fleet::topology::RuntimeState::Running {
                        started_at: observed_at,
                    },
                    metadata,
                ),
                fleet::topology::RuntimeObservation::with_association(
                    fleet::topology::RuntimeId::try_new("runtime-stopped").unwrap(),
                    node_id.clone(),
                    Some(agent_id.clone()),
                    association.clone(),
                    fleet::topology::RuntimeKind::OpenClaw,
                    fleet::topology::RuntimeState::Stopped {
                        stopped_at: Some(snapshot_at),
                    },
                    metadata,
                ),
            ],
            vec![fleet::topology::EndpointObservation::with_association(
                endpoint_id.clone(),
                node_id.clone(),
                runtime_id.clone(),
                association.clone(),
                fleet::topology::EndpointHealth::Ready,
                vec![SupportedCapability::new(
                    CapabilityId::try_new("session.prompt").unwrap(),
                    CapabilityScope::Session,
                )],
                vec![CapabilityAvailability::Available],
                metadata,
            )],
        )
        .unwrap();
        let connection = ConnectionRecord::register(
            connection_id.clone(),
            ConnectionKind::SshHost,
            "SSH connection".to_owned(),
            Some("ssh://internal.example".to_owned()),
            vec!["production".to_owned()],
            true,
            BTreeMap::from([(String::from("region"), String::from("private-region"))]),
            BTreeMap::new(),
            created_at,
        )
        .unwrap();
        let environment = EnvironmentRecord::restore(
            environment_id.clone(),
            connection_id.clone(),
            "Workspace".to_owned(),
            EnvironmentKind::SshWorkdir,
            vec!["production".to_owned()],
            true,
            BTreeMap::from([(String::from("root"), String::from("private-root"))]),
            BTreeMap::new(),
            EnvironmentState::Ready {
                ready_at: observed_at,
            },
            vec![resource_id.clone()],
            created_at,
            observed_at,
        )
        .unwrap();
        let resource = ManagedResourceRecord::new(
            resource_id.clone(),
            connection_id.clone(),
            environment_id.clone(),
            ManagedResourceProvider::Ssh,
            ManagedResourceKind::SshAgentInstallation,
            "remote-agent-1".to_owned(),
            Ownership::MatchaManaged,
            CleanupPolicy::UninstallAgentOnly,
            created_at,
        );
        let commands = vec![
            CommandRecord::queued(CommandIntent::new(
                CommandId::try_new("command-node").unwrap(),
                IdempotencyKey::try_new("key-node").unwrap(),
                CommandTarget::Node(node_id.clone()),
                CommandKind::ProbeNode,
                created_at,
            )),
            CommandRecord::queued(CommandIntent::new(
                CommandId::try_new("command-runtime").unwrap(),
                IdempotencyKey::try_new("key-runtime").unwrap(),
                CommandTarget::Runtime {
                    node_id: node_id.clone(),
                    runtime_id: runtime_id.clone(),
                },
                CommandKind::StartRuntime,
                created_at,
            )),
            CommandRecord::queued(CommandIntent::new(
                CommandId::try_new("command-endpoint").unwrap(),
                IdempotencyKey::try_new("key-endpoint").unwrap(),
                CommandTarget::Endpoint {
                    node_id: node_id.clone(),
                    runtime_id: runtime_id.clone(),
                    endpoint_id: endpoint_id.clone(),
                },
                CommandKind::SyncCapabilities,
                created_at,
            )),
        ];
        let relations = fleet::audit::FleetAuditRelations::new(
            Some(String::from("actor-1")),
            Some(connection_id.as_str().to_owned()),
            Some(environment_id.as_str().to_owned()),
            Some(resource_id.as_str().to_owned()),
            Some(node_id.as_str().to_owned()),
            Some(agent_id.as_str().to_owned()),
            Some(runtime_id.as_str().to_owned()),
            Some(endpoint_id.as_str().to_owned()),
            Some(String::from("command-node")),
        )
        .unwrap();
        let audit = FleetAuditEntry::try_new(
            1,
            FleetAuditEvent::new(FleetAuditEventInput {
                event_name: String::from("command.queued"),
                occurred_at: observed_at,
                message: Some(String::from("internal execution detail")),
                metadata: BTreeMap::from([(
                    String::from("internal"),
                    FleetAuditValue::Text(String::from("private detail")),
                )]),
                relations,
            })
            .unwrap(),
        )
        .unwrap();
        let owner = LeaseOwner::try_new(LeaseOwnerKind::Session, "session-1").unwrap();
        let leases = vec![
            Lease::restore(
                fleet::lease::LeaseId::try_new("lease-released").unwrap(),
                endpoint_id.clone(),
                owner.clone(),
                created_at,
                LeaseState::Released {
                    released_at: observed_at,
                },
            )
            .unwrap(),
            Lease::restore(
                fleet::lease::LeaseId::try_new("lease-expired").unwrap(),
                endpoint_id.clone(),
                owner,
                created_at,
                LeaseState::Expired {
                    expired_at: observed_at,
                },
            )
            .unwrap(),
        ];
        let facts = FleetFacts::restore(FleetFactsRestoreInput {
            commands,
            dispatches: Vec::new(),
            secret_references: Vec::new(),
            audit_entries: vec![audit],
            topology,
            enrollments: Vec::new(),
            ingress_credentials: Vec::new(),
            targets: Vec::new(),
            connections: vec![connection],
            environments: vec![environment],
            managed_resources: vec![resource],
            effects: Vec::new(),
            runtime_agents: Vec::new(),
            runtime_agent_reachability: Vec::new(),
            leases,
            bindings: Vec::new(),
        })
        .unwrap();
        let query = FleetQuerySnapshot::from_facts(&facts, facts.leases(), snapshot_at);
        let mut terminal = TerminalSessionOwner::default();
        let session = terminal
            .open(
                TerminalSessionId::try_new("session-1").unwrap(),
                TerminalTargetId::try_new("node-1").unwrap(),
                TerminalProviderId::try_new("ssh").unwrap(),
                TerminalDimensions::try_new(24, 80).unwrap(),
                created_at,
            )
            .unwrap()
            .session;
        FleetSnapshot {
            query,
            topology: FleetTopologySummary {
                nodes: facts.topology().nodes().to_vec(),
                agents: facts.topology().agents().to_vec(),
                runtimes: facts.topology().runtimes().to_vec(),
                endpoints: facts.topology().endpoints().to_vec(),
            },
            sessions: vec![session],
            updated_at: snapshot_at,
        }
    }

    fn record_by_id<'a>(value: &'a Value, id: &str) -> &'a Value {
        value
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record.get("id") == Some(&json!(id)))
            .unwrap_or_else(|| panic!("missing record {id}"))
    }

    fn assert_exact_keys<I>(value: &Value, expected: I)
    where
        I: IntoIterator<Item = &'static str>,
    {
        let actual = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let expected = expected.into_iter().collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[41; 32])
    }
    fn verifier() -> CapabilityDecisionVerifier {
        CapabilityDecisionVerifier::try_new(&verification_key()).unwrap()
    }
    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }
    fn decision(operation: &str) -> String {
        decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, operation)
    }
    fn decision_for(endpoint: &str, scope: &str, operation: &str) -> String {
        decision_for_subject(endpoint, scope, operation, AUTHORIZATION_SUBJECT)
    }
    fn decision_for_subject(endpoint: &str, scope: &str, operation: &str, subject: &str) -> String {
        let payload = json!({"version":1,"principal":"test","endpoint":endpoint,"scope":scope,"capability":operation,"subject":subject,"expiresAt":60_000,"correlation":format!("fleet-{operation}"),"revision":"test"});
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
