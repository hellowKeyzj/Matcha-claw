use environment::{
    Connector, ConnectorCatalog, ConnectorKind, ConnectorStore, ConnectorStoreError,
};
use openclaw::{
    gateway::wire::McpServerStatusList,
    lifecycle::state_dir::CanonicalStateDir,
    projection::connector::{
        catalog::{ExternalMcpProgram, discover_external_mcp_programs},
        external::{ConnectorProjectionEffect, project_external_connectors},
    },
};
use serde::{Deserialize, Serialize};

use crate::composition::Host;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ListOutcome {
    Available(Vec<Connector>),
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GetOutcome {
    Found(Box<Connector>),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Stored {
        connector: Box<Connector>,
        created: bool,
        revision: u64,
        configuration: ConnectorProjectionEffect,
    },
    Removed {
        revision: u64,
        configuration: ConnectorProjectionEffect,
    },
    Missing,
    Rejected,
    Unknown,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProbeOutcome {
    Connector(Box<Connector>),
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogOutcome {
    Available(Vec<ExternalMcpProgram>),
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum SessionEndpoint {
    #[serde(rename = "native-runtime")]
    Native {
        #[serde(rename = "runtimeAdapterId")]
        runtime_adapter_id: String,
        #[serde(rename = "runtimeInstanceId")]
        runtime_instance_id: String,
    },
    #[serde(rename = "protocol-connector")]
    ProtocolConnector {
        #[serde(rename = "protocolId")]
        protocol_id: String,
        #[serde(rename = "connectorId")]
        connector_id: String,
        #[serde(rename = "endpointId")]
        endpoint_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionIdentity {
    pub(crate) endpoint: SessionEndpoint,
    pub(crate) agent_id: String,
    pub(crate) session_key: String,
}

impl SessionIdentity {
    pub(crate) fn is_valid(&self) -> bool {
        valid_session_text(&self.agent_id)
            && valid_session_text(&self.session_key)
            && match &self.endpoint {
                SessionEndpoint::Native {
                    runtime_adapter_id,
                    runtime_instance_id,
                } => {
                    valid_session_text(runtime_adapter_id)
                        && valid_session_text(runtime_instance_id)
                }
                SessionEndpoint::ProtocolConnector {
                    protocol_id,
                    connector_id,
                    endpoint_id,
                } => {
                    valid_session_text(protocol_id)
                        && valid_session_text(connector_id)
                        && valid_session_text(endpoint_id)
                }
            }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionConnectorResultType {
    Connected,
    Disconnected,
    Pending,
    Unsupported,
    Disabled,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionConnectorStatusDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) launch_summary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionConnectorStatus {
    pub(crate) connector_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
    pub(crate) adapter_id: String,
    pub(crate) target_kind: &'static str,
    pub(crate) result_type: SessionConnectorResultType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<SessionConnectorStatusDetails>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionStatusOutcome {
    Available(Vec<SessionConnectorStatus>),
    Unavailable,
}

fn valid_session_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && value.len() <= 512
}

pub(crate) struct Owner {
    store: ConnectorStore,
    state_dir: CanonicalStateDir,
    private_resolver: crate::transport::provider_accounts::private_auth::Resolver,
}
impl Owner {
    pub(crate) fn open(state_dir: CanonicalStateDir) -> Result<Self, ()> {
        let store = ConnectorStore::open(
            state_dir
                .as_path()
                .join("external-connectors")
                .join("connectors.json"),
        )
        .map_err(|_| ())?;
        Ok(Self {
            store,
            state_dir,
            private_resolver: crate::transport::provider_accounts::private_auth::Resolver::disabled(
            ),
        })
    }
    pub(crate) fn set_private_resolver(
        &mut self,
        private_resolver: crate::transport::provider_accounts::private_auth::Resolver,
    ) {
        self.private_resolver = private_resolver;
    }
    fn catalog(&self) -> ConnectorCatalog {
        self.store.catalog().clone()
    }
    fn connectors(&self) -> Vec<Connector> {
        let mut connectors = self
            .catalog()
            .connectors()
            .iter()
            .filter(|connector| connector.id != "matcha")
            .cloned()
            .collect::<Vec<_>>();
        connectors.push(Connector::system_runtime());
        connectors.sort_by(|left, right| left.id.cmp(&right.id));
        connectors
    }
    fn get(&self, id: &str) -> Option<Connector> {
        if id == "matcha" {
            return Some(Connector::system_runtime());
        }
        self.connectors()
            .into_iter()
            .find(|connector| connector.id == id)
    }
    fn upsert(&mut self, connector: Connector) -> MutationOutcome {
        if is_private_system_runtime_connector(&connector) {
            return MutationOutcome::Rejected;
        }
        let mutation = match self.store.upsert(connector.clone()) {
            Ok(mutation) => mutation,
            Err(error) => return mutation_error(error),
        };
        let configuration = project_external_connectors(
            self.state_dir.clone(),
            &self.catalog(),
            &self.private_resolver,
        )
        .map(|(effect, _)| effect)
        .unwrap_or(ConnectorProjectionEffect::Unavailable);
        if matches!(configuration, ConnectorProjectionEffect::Written { .. }) {
            match self.store.record_applied(&connector.id, mutation.revision) {
                Ok(()) => {}
                Err(
                    ConnectorStoreError::CommitOutcomeUnknown(_)
                    | ConnectorStoreError::RecoveryRequired,
                ) => return MutationOutcome::Unknown,
                Err(_) => return MutationOutcome::Unavailable,
            }
        }
        MutationOutcome::Stored {
            connector: Box::new(connector),
            created: mutation.created,
            revision: mutation.revision,
            configuration,
        }
    }
    fn remove(&mut self, id: &str) -> MutationOutcome {
        match self.store.remove(id) {
            Ok(None) => MutationOutcome::Missing,
            Ok(Some(revision)) => {
                let configuration = project_external_connectors(
                    self.state_dir.clone(),
                    &self.catalog(),
                    &self.private_resolver,
                )
                .map(|(effect, _)| effect)
                .unwrap_or(ConnectorProjectionEffect::Unavailable);
                if matches!(configuration, ConnectorProjectionEffect::Written { .. }) {
                    match self.store.record_applied(id, revision) {
                        Ok(()) => {}
                        Err(
                            ConnectorStoreError::CommitOutcomeUnknown(_)
                            | ConnectorStoreError::RecoveryRequired,
                        ) => {
                            return MutationOutcome::Unknown;
                        }
                        Err(_) => return MutationOutcome::Unavailable,
                    }
                }
                MutationOutcome::Removed {
                    revision,
                    configuration,
                }
            }
            Err(error) => mutation_error(error),
        }
    }
}

fn mutation_error(error: ConnectorStoreError) -> MutationOutcome {
    match error {
        ConnectorStoreError::CommitOutcomeUnknown(_) | ConnectorStoreError::RecoveryRequired => {
            MutationOutcome::Unknown
        }
        ConnectorStoreError::Connector(_)
        | ConnectorStoreError::Commit(_)
        | ConnectorStoreError::Decode
        | ConnectorStoreError::Encode
        | ConnectorStoreError::RecordTooLarge
        | ConnectorStoreError::RevisionMismatch
        | ConnectorStoreError::RevisionOverflow
        | ConnectorStoreError::WriterBusy => MutationOutcome::Rejected,
    }
}

fn is_private_system_runtime_connector(connector: &Connector) -> bool {
    connector
        .mcp_server_program
        .as_ref()
        .is_some_and(|program| {
            matches!(program.source, environment::McpProgramSource::SystemRuntime)
                && program.program_id.as_deref() == Some("system-runtime:matcha")
        })
}

impl Host {
    pub(crate) fn list_external_connectors(&self) -> ListOutcome {
        if self.admission.admit_request().is_err() {
            return ListOutcome::Unavailable;
        }
        ListOutcome::Available(self.external_connectors.connectors())
    }
    pub(crate) fn external_connector_catalog(&self) -> CatalogOutcome {
        if self.admission.admit_request().is_err() {
            return CatalogOutcome::Unavailable;
        }
        CatalogOutcome::Available(discover_external_mcp_programs(
            &self.external_connectors.catalog(),
        ))
    }
    pub(crate) fn get_external_connector(&self, id: String) -> GetOutcome {
        if self.admission.admit_request().is_err() {
            return GetOutcome::Unavailable;
        }
        self.external_connectors
            .get(&id)
            .map(|connector| GetOutcome::Found(Box::new(connector)))
            .unwrap_or(GetOutcome::Missing)
    }
    pub(crate) fn upsert_external_connector(&mut self, connector: Connector) -> MutationOutcome {
        if self.admission.admit_request().is_err() {
            return MutationOutcome::Unavailable;
        }
        self.external_connectors.upsert(connector)
    }
    pub(crate) fn remove_external_connector(&mut self, id: String) -> MutationOutcome {
        if self.admission.admit_request().is_err() {
            return MutationOutcome::Unavailable;
        }
        self.external_connectors.remove(&id)
    }
    pub(crate) fn probe_external_connector(&self, id: String) -> ProbeOutcome {
        if self.admission.admit_request().is_err() {
            return ProbeOutcome::Unavailable;
        }
        self.external_connectors
            .get(&id)
            .map(|connector| ProbeOutcome::Connector(Box::new(connector)))
            .unwrap_or(ProbeOutcome::Missing)
    }

    pub(crate) async fn session_connector_status(
        &mut self,
        identity: SessionIdentity,
    ) -> SessionStatusOutcome {
        if self.admission.admit_request().is_err() || !identity.is_valid() {
            return SessionStatusOutcome::Unavailable;
        }
        let is_local_openclaw = matches!(
            &identity.endpoint,
            SessionEndpoint::Native {
                runtime_adapter_id,
                runtime_instance_id,
            } if runtime_adapter_id == "openclaw" && runtime_instance_id == "local"
        );
        if !is_local_openclaw {
            return SessionStatusOutcome::Available(
                self.external_connectors
                    .connectors()
                    .into_iter()
                    .map(|connector| SessionConnectorStatus {
                        connector_id: connector.id,
                        display_name: connector.display_name,
                        adapter_id: "openclaw".into(),
                        target_kind: "session",
                        result_type: SessionConnectorResultType::Unsupported,
                        reason: Some(match &identity.endpoint {
                            SessionEndpoint::ProtocolConnector { .. } => {
                                "protocol connector session status is unsupported by the OpenClaw Gateway"
                            }
                            SessionEndpoint::Native { .. } => {
                                "native runtime endpoint is unsupported by the OpenClaw adapter"
                            }
                        }.into()),
                        details: Some(SessionConnectorStatusDetails {
                            server_id: None,
                            session_key: Some(identity.session_key.clone()),
                            tool_count: None,
                            launch_summary: None,
                        }),
                    })
                    .collect(),
            );
        }

        let connectors = self.external_connectors.connectors();
        let statuses = self
            .observe_open_claw_mcp_server_status(identity.session_key.clone(), None)
            .await;
        let statuses = match statuses {
            Ok(statuses) => statuses,
            Err(_) => {
                return SessionStatusOutcome::Available(unknown_session_statuses(
                    connectors,
                    &identity.session_key,
                ));
            }
        };
        SessionStatusOutcome::Available(
            connectors
                .into_iter()
                .map(|connector| {
                    session_status_for_connector(connector, &identity.session_key, &statuses)
                })
                .collect(),
        )
    }
}

fn unknown_session_statuses(
    connectors: Vec<Connector>,
    session_key: &str,
) -> Vec<SessionConnectorStatus> {
    connectors
        .into_iter()
        .map(|connector| SessionConnectorStatus {
            connector_id: connector.id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Unknown,
            reason: Some("OpenClaw MCP status is unavailable for this session".into()),
            details: Some(SessionConnectorStatusDetails {
                server_id: None,
                session_key: Some(session_key.to_owned()),
                tool_count: None,
                launch_summary: None,
            }),
        })
        .collect()
}

fn session_status_for_connector(
    connector: Connector,
    session_key: &str,
    statuses: &McpServerStatusList,
) -> SessionConnectorStatus {
    let connector_id = connector.id.clone();
    let details = SessionConnectorStatusDetails {
        server_id: Some(connector_id.clone()),
        session_key: Some(session_key.to_owned()),
        tool_count: None,
        launch_summary: None,
    };
    if !connector.enabled() {
        return SessionConnectorStatus {
            connector_id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Disabled,
            reason: Some("connector is disabled".into()),
            details: Some(details),
        };
    }
    if !matches!(
        connector.kind,
        ConnectorKind::McpHttp | ConnectorKind::McpStdio
    ) {
        return SessionConnectorStatus {
            connector_id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Unsupported,
            reason: Some("connector has no OpenClaw MCP session projection".into()),
            details: Some(details),
        };
    }
    let Some(server) = statuses
        .servers
        .iter()
        .find(|server| server.name == connector.id)
    else {
        return SessionConnectorStatus {
            connector_id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Disconnected,
            reason: Some("OpenClaw MCP status did not include the projected connector".into()),
            details: Some(details),
        };
    };
    let available = server.available.unwrap_or(true);
    let details = SessionConnectorStatusDetails {
        server_id: Some(connector.id.clone()),
        session_key: Some(session_key.to_owned()),
        tool_count: server.tool_count,
        launch_summary: server.launch_summary.clone(),
    };
    SessionConnectorStatus {
        connector_id,
        display_name: connector.display_name,
        adapter_id: "openclaw".into(),
        target_kind: "session",
        result_type: if available {
            SessionConnectorResultType::Connected
        } else {
            SessionConnectorResultType::Disconnected
        },
        reason: Some(if available {
            "OpenClaw MCP status reported the server as available".into()
        } else {
            "OpenClaw MCP status reported the server as unavailable".into()
        }),
        details: Some(details),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn private_system_runtime_connector_is_neither_persisted_nor_projected() {
        let fixture = Fixture::new();
        let state_dir = CanonicalStateDir::provision(fixture.root.join("state"))
            .expect("fixture state directory is provisioned");
        let mut owner = Owner::open(state_dir).expect("connector owner opens");

        assert_eq!(
            owner.upsert(Connector::system_runtime()),
            MutationOutcome::Rejected
        );
        assert!(owner.connectors().is_empty());
        assert!(!fixture.root.join("state/openclaw.json").exists());
        assert!(
            !fixture
                .root
                .join("state/external-connectors/connectors.json")
                .exists()
        );
    }

    #[test]
    fn desired_revision_is_applied_only_after_verified_config_readback() {
        let fixture = Fixture::new();
        let state_dir = CanonicalStateDir::provision(fixture.root.join("state"))
            .expect("fixture state directory is provisioned");
        let mut owner = Owner::open(state_dir.clone()).expect("connector owner opens");
        let connector: Connector = serde_json::from_value(serde_json::json!({
            "id": "matcha-external.remote",
            "kind": "mcp-stdio",
            "enabled": true,
            "command": "managed-mcp",
            "args": ["--serve"]
        }))
        .expect("connector fixture decodes");

        assert!(matches!(
            owner.upsert(connector),
            MutationOutcome::Stored {
                revision: 1,
                configuration: ConnectorProjectionEffect::Written { .. },
                ..
            }
        ));
        assert_eq!(
            owner.store.applied_revision("matcha-external.remote"),
            Some(1)
        );
        assert_eq!(
            owner
                .store
                .remove("matcha-external.remote")
                .expect("remove"),
            Some(2)
        );
        assert_eq!(owner.store.applied_revision("matcha-external.remote"), None);
    }

    #[test]
    fn secret_ref_connector_without_private_resolver_is_not_projected_or_applied() {
        let fixture = Fixture::new();
        let state_dir = CanonicalStateDir::provision(fixture.root.join("state"))
            .expect("fixture state directory is provisioned");
        let mut owner = Owner::open(state_dir).expect("connector owner opens");
        let connector: Connector = serde_json::from_value(serde_json::json!({
            "id": "matcha-external.http-secret",
            "kind": "mcp-http",
            "enabled": true,
            "url": "https://example.test/mcp",
            "secretHeaders": {
                "Authorization": { "kind": "secret-ref", "ref": "credential:v1:http-token" }
            }
        }))
        .expect("secret-ref connector decodes");

        assert!(matches!(
            owner.upsert(connector),
            MutationOutcome::Stored {
                revision: 1,
                configuration: ConnectorProjectionEffect::Unavailable,
                ..
            }
        ));
        assert_eq!(
            owner.store.applied_revision("matcha-external.http-secret"),
            None
        );
        assert!(!fixture.root.join("state/openclaw.json").exists());
        let public = owner
            .get("matcha-external.http-secret")
            .expect("connector remains desired")
            .public_json()
            .to_string();
        assert!(public.contains("credential:v1:http-token"));
        assert!(!public.contains("resolved-http-token"));
    }

    struct Fixture {
        root: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let ordinal = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "runtime-host-external-connectors-{ordinal}-{nanos}"
            ));
            fs::create_dir(&root).expect("fixture root is created");
            prepare_state_parent(&root);
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    fn prepare_state_parent(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .expect("fixture root permissions are restricted");
    }

    #[cfg(windows)]
    fn prepare_state_parent(_: &std::path::Path) {}
}
