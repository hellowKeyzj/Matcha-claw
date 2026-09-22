use platform::capability::CapabilityDecisionVerifier;

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use super::terminal::{TerminalOpenPayload, TerminalSessionPayload};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]

pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub(super) operation: Operation,
    pub(super) input: Input,
}

// deny_unknown_fields 对 internally-tagged 的 unit variant 不生效
// （属性被 InternallyTaggedUnitVisitor 忽略），必须写成空 struct variant `Unit {}` 才真正拒绝未知键；
// `Unit {}` 与 `Unit` 的序列化输出逐字节相同，因此这个写法不改变 JSON 形状。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Input {
    List {},
    Topology {},
    Connections {},
    Capabilities {},
    Environments {},
    Resources {},
    Commands {},
    Audit {},
    Leases {},
    Metrics {},
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
    TerminalList {},
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TargetPutPayload {
    pub(super) id: String,
    pub(super) target: TargetConfigPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TargetRemovePayload {
    pub(super) id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DispatchPayload {
    pub(super) dispatch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DispatchAttemptPayload {
    pub(super) dispatch_id: String,
    pub(super) attempt: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommandReplayPayload {
    pub(super) command_id: String,
    pub(super) dispatch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConnectionUpsertPayload {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) display_name: String,
    pub(super) endpoint: Option<String>,
    pub(super) labels: Vec<String>,
    pub(super) enabled: bool,
    pub(super) public_config: BTreeMap<String, String>,
    pub(super) secret_refs: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConnectionRemovePayload {
    pub(super) id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EnvironmentRegisterPayload {
    pub(super) id: String,
    pub(super) connection_id: String,
    pub(super) kind: String,
    pub(super) display_name: String,
    pub(super) labels: Vec<String>,
    pub(super) enabled: bool,
    pub(super) public_config: BTreeMap<String, String>,
    pub(super) secret_refs: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResourceRegisterPayload {
    pub(super) id: String,
    pub(super) connection_id: String,
    pub(super) environment_id: String,
    pub(super) provider: String,
    pub(super) kind: String,
    pub(super) remote_resource_id: String,
    pub(super) ownership: String,
    pub(super) cleanup_policy: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NodeUpsertPayload {
    pub(super) id: String,
    pub(super) health: String,
    pub(super) connection_id: Option<String>,
    pub(super) environment_id: Option<String>,
    pub(super) managed_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentUpsertPayload {
    pub(super) id: String,
    pub(super) node_id: String,
    pub(super) connection_id: Option<String>,
    pub(super) environment_id: Option<String>,
    pub(super) managed_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeUpsertPayload {
    pub(super) id: String,
    pub(super) node_id: String,
    pub(super) agent_id: Option<String>,
    pub(super) connection_id: Option<String>,
    pub(super) environment_id: Option<String>,
    pub(super) managed_resource_id: Option<String>,
    pub(super) kind: String,
    pub(super) state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EndpointUpsertPayload {
    pub(super) id: String,
    pub(super) node_id: String,
    pub(super) runtime_id: String,
    pub(super) health: String,
    pub(super) connection_id: Option<String>,
    pub(super) environment_id: Option<String>,
    pub(super) managed_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IdPayload {
    pub(super) id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommandIdPayload {
    pub(super) id: String,
    pub(super) command_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConnectionProbeBeginPayload {
    pub(super) id: String,
    pub(super) command_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConnectionProbeCompletePayload {
    pub(super) id: String,
    pub(super) command_id: String,
    pub(super) outcome: String,
    pub(super) message: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommandPhasePayload {
    pub(super) id: String,
    pub(super) command_id: String,
    pub(super) phase: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommandFailurePayload {
    pub(super) id: String,
    pub(super) command_id: String,
    pub(super) phase: String,
    pub(super) message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapabilitySyncPayload {
    pub(super) id: String,
    pub(super) command_id: String,
    pub(super) capabilities: Vec<CapabilityPayload>,
    pub(super) metadata: ObservationMetadataPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapabilityPayload {
    pub(super) id: String,
    pub(super) scope: String,
    pub(super) availability: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ObservationMetadataPayload {
    pub(super) source: String,
    #[serde(rename = "observedAt")]
    pub(super) observed_at: String,
    pub(super) freshness: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SelectorPayload {
    pub(super) target_id: String,
    pub(super) revision: u64,
    pub(super) expected_kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SelectorPreviewPayload {
    pub(super) endpoint_ids: Vec<String>,
    pub(super) node_ids: Vec<String>,
    pub(super) runtime_ids: Vec<String>,
    pub(super) labels: Vec<String>,
    pub(super) operation_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommandSubmitPayload {
    pub(super) command_id: String,
    pub(super) idempotency_key: String,
    pub(super) agent_id: String,
    pub(super) target: CommandTargetPayload,
    pub(super) kind: String,
    pub(super) dispatch_id: String,
    pub(super) selector: SelectorPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NodeCommandSubmitPayload {
    pub(super) node_id: String,
    pub(super) command_id: String,
    pub(super) idempotency_key: String,
    pub(super) dispatch_id: String,
    pub(super) kind: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum CommandTargetPayload {
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
pub(super) enum TargetConfigPayload {
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
        let operation_name = value
            .get("operation")
            .and_then(Value::as_str)
            .ok_or(DecodeError::Invalid)?;
        let operation =
            serde_json::from_value::<Operation>(Value::String(operation_name.to_owned()))
                .map_err(|_| DecodeError::Invalid)?;
        super::authorization::verify(operation, operation_name, authorization, verifier, now)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| DecodeError::Invalid)?;
        let valid = matches!(
            (&request.operation, &request.input),
            (Operation::TargetsList, Input::List { .. })
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
                | (Operation::TerminalList, Input::TerminalList { .. })
                | (Operation::TopologyGet, Input::Topology { .. })
                | (Operation::ConnectionsList, Input::Connections { .. })
                | (Operation::CapabilitiesList, Input::Capabilities { .. })
                | (Operation::EnvironmentsList, Input::Environments { .. })
                | (Operation::ResourcesList, Input::Resources { .. })
                | (Operation::CommandsList, Input::Commands { .. })
                | (Operation::AuditList, Input::Audit { .. })
                | (Operation::LeasesList, Input::Leases { .. })
                | (Operation::MetricsGet, Input::Metrics { .. })
                | (Operation::SnapshotGet, Input::Snapshot { .. })
                | (Operation::SelectorPreview, Input::SelectorPreview { .. })
        );
        valid.then_some(request).ok_or(DecodeError::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::super::authorization::{
        AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, AUTHORIZATION_SUBJECT,
        MUTATION_AUTHORIZATION_SCOPE,
    };
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    fn verifier() -> CapabilityDecisionVerifier {
        CapabilityDecisionVerifier::try_new(&verification_key()).unwrap()
    }

    fn verification_key() -> String {
        let key = signing_key().verifying_key();
        let mut spki = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        spki.extend_from_slice(&key.to_bytes());
        URL_SAFE_NO_PAD.encode(spki)
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn decision(capability: &str) -> String {
        decision_for(AUTHORIZATION_ENDPOINT, AUTHORIZATION_SCOPE, capability)
    }

    fn decision_for(endpoint: &str, scope: &str, capability: &str) -> String {
        decision_for_subject(endpoint, scope, capability, AUTHORIZATION_SUBJECT)
    }

    fn decision_for_subject(
        endpoint: &str,
        scope: &str,
        capability: &str,
        subject: &str,
    ) -> String {
        let payload = serde_json::json!({
            "version": 1,
            "principal": "desktop-session:fixture",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": 2000,
            "correlation": format!("corr:{endpoint}:{scope}:{capability}:{subject}"),
            "revision": "revision:fixture",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = signing_key().sign(signed.as_bytes());
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

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
    fn snapshot_read_requires_exact_capability_and_read_scope() {
        let request = json!({"operation":"fleet.snapshot.get","input":{"kind":"snapshot"}});
        let mut valid_verifier = verifier();
        assert!(
            Request::decode(
                request.clone(),
                &decision("fleet.snapshot.get"),
                &mut valid_verifier,
                1
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
                    1
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
                1
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
                    "fleet.snapshot.get"
                ),
                &mut write_scope_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));
    }

    #[test]
    fn authorization_is_bound_to_route_scope_operation_and_subject() {
        for authorization in [
            decision_for("/api/other", AUTHORIZATION_SCOPE, "fleet.connections.list"),
            decision_for(
                AUTHORIZATION_ENDPOINT,
                MUTATION_AUTHORIZATION_SCOPE,
                "fleet.connections.list",
            ),
            decision_for(
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                "fleet.metrics.get",
            ),
            decision_for_subject(
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                "fleet.connections.list",
                "not-fleet",
            ),
        ] {
            let mut verifier = verifier();
            assert!(matches!(
                Request::decode(
                    json!({"operation":"fleet.connections.list","input":{"kind":"connections"}}),
                    &authorization,
                    &mut verifier,
                    1,
                ),
                Err(DecodeError::Unauthorized)
            ));
        }
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
                    "fleet.commands.begin"
                ),
                &mut write_verifier,
                1,
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
                1,
            ),
            Err(DecodeError::Invalid)
        ));
    }

    #[test]
    fn terminal_close_requires_exact_write_contract() {
        let request = json!({
            "operation":"fleet.terminals.close",
            "input":{"kind":"terminalClose","payload":{"sessionId":"session-1"}}
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
        .unwrap();
        assert_eq!(decoded.operation, Operation::TerminalClose);
        assert!(
            matches!(decoded.input, Input::TerminalClose { payload } if payload.session_id == "session-1")
        );

        let mut read_verifier = verifier();
        assert!(matches!(
            Request::decode(
                request.clone(),
                &decision_for(
                    AUTHORIZATION_ENDPOINT,
                    AUTHORIZATION_SCOPE,
                    "fleet.terminals.close"
                ),
                &mut read_verifier,
                1,
            ),
            Err(DecodeError::Unauthorized)
        ));

        for invalid in [
            json!({"operation":"fleet.terminals.close","input":{"kind":"terminalClose","payload":{"sessionId":"session-1","reason":"done"}}}),
            json!({"operation":"fleet.terminals.close","input":{"kind":"terminalClose","payload":{"sessionId":"session-1"},"extra":true}}),
            json!({"operation":"fleet.terminals.close","input":{"kind":"terminalClose","payload":{"sessionId":"session-1"}},"extra":true}),
            json!({"operation":"fleet.terminals.close","input":{"kind":"terminalBeginClose","payload":{"sessionId":"session-1"}}}),
        ] {
            let mut invalid_verifier = verifier();
            assert!(matches!(
                Request::decode(
                    invalid,
                    &decision_for(
                        AUTHORIZATION_ENDPOINT,
                        MUTATION_AUTHORIZATION_SCOPE,
                        "fleet.terminals.close"
                    ),
                    &mut invalid_verifier,
                    1,
                ),
                Err(DecodeError::Invalid)
            ));
        }
    }
}
