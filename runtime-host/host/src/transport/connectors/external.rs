use std::collections::BTreeMap;

use environment::connectors::{Connector, ConnectorPublicInput, McpProgramSource};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::runtime::external_connectors::{
    CatalogOutcome, ConnectorObservation, ConnectorProjectionEffect, ConnectorReadModel,
    GetOutcome, ListOutcome, MutationOutcome, SessionConnectorStatus, SessionIdentity,
    SessionMcpServerEnabledOutcome, SessionMcpServerEnabledTarget, SessionStatusTarget,
};
use crate::transport::common::authorization::CapabilityDecisionVerifier;

pub(crate) const ENDPOINT: &str = "/api/external-connectors";
const CAPABILITY_ID: &str = "external.connectors";
const SCOPE: &str = "environment:external-connectors";
const SUBJECT: &str = "external-connectors";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    id: String,
    operation_id: String,
    scope: Kind,
    target: Kind,
    input: Input,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Kind {
    kind: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    List {},
    Catalog {},
    Status {},
    SessionStatus {
        session_identity: SessionIdentity,
    },
    SessionMcpServerEnabled {
        session_identity: SessionIdentity,
        server_id: String,
        enabled: bool,
    },
    Probe {
        connector_id: String,
    },
    Get {
        connector_id: String,
    },
    Upsert {
        #[serde(deserialize_with = "deserialize_public_connector")]
        connector: Box<Connector>,
    },
    Remove {
        connector_id: String,
    },
}

fn deserialize_public_connector<'de, D>(deserializer: D) -> Result<Box<Connector>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    ConnectorPublicInput::deserialize(deserializer)?
        .into_connector()
        .map(Box::new)
        .map_err(|_| serde::de::Error::custom("invalid connector"))
}

fn catalog_program_json(
    program: &crate::runtime::external_connectors::ExternalMcpProgram,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("id".into(), json!(&program.id));
    object.insert("source".into(), json!(mcp_program_source(&program.source)));
    object.insert("displayName".into(), json!(&program.display_name));
    object.insert(
        "connectorKinds".into(),
        Value::Array(
            program
                .connector_kinds
                .iter()
                .map(|kind| json!(connector_kind(kind)))
                .collect(),
        ),
    );
    if let Some(transport) = program.transport.as_ref() {
        object.insert("transport".into(), json!(mcp_transport(transport)));
    }
    Value::Object(object)
}

fn public_connector_json(connector: &ConnectorReadModel) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("id".into(), json!(&connector.id));
    object.insert("kind".into(), json!(connector_kind(&connector.kind)));
    if let Some(display_name) = connector.display_name.as_ref() {
        object.insert("displayName".into(), json!(display_name));
    }
    if let Some(description) = connector.description.as_ref() {
        object.insert("description".into(), json!(description));
    }
    if let Some(enabled) = connector.enabled {
        object.insert("enabled".into(), json!(enabled));
    }
    if let Some(workspace_id) = connector.workspace_id.as_ref() {
        object.insert("workspaceId".into(), json!(workspace_id));
    }
    if let Some(source_id) = connector.source_id.as_ref() {
        object.insert("sourceId".into(), json!(source_id));
    }
    if let Some(mcp_server_program) = connector.mcp_server_program.as_ref() {
        object.insert(
            "mcpServerProgram".into(),
            mcp_server_program_json(mcp_server_program),
        );
    }
    if let Some(tags) = connector.tags.as_ref() {
        object.insert("tags".into(), json!(tags));
    }
    if let Some(url) = connector.url.as_ref() {
        object.insert("url".into(), json!(url));
    }
    if let Some(transport) = connector.transport.as_ref() {
        object.insert("transport".into(), json!(mcp_transport(transport)));
    }
    if let Some(connection_timeout_ms) = connector.connection_timeout_ms {
        object.insert("connectionTimeoutMs".into(), json!(connection_timeout_ms));
    }
    if let Some(base_url) = connector.base_url.as_ref() {
        object.insert("baseUrl".into(), json!(base_url));
    }
    if let Some(provider) = connector.provider.as_ref() {
        object.insert("provider".into(), json!(provider));
    }
    if let Some(package_name) = connector.package_name.as_ref() {
        object.insert("packageName".into(), json!(package_name));
    }
    insert_secret_reference_map(&mut object, "secretEnv", connector.secret_env.as_ref());
    insert_secret_reference_map(
        &mut object,
        "secretHeaders",
        connector.secret_headers.as_ref(),
    );
    insert_secret_reference_map(
        &mut object,
        "secretConfigRefs",
        connector.secret_config_refs.as_ref(),
    );
    Value::Object(object)
}

fn connector_kind(kind: &crate::runtime::external_connectors::ConnectorKind) -> &'static str {
    match kind {
        crate::runtime::external_connectors::ConnectorKind::McpStdio => "mcp-stdio",
        crate::runtime::external_connectors::ConnectorKind::McpHttp => "mcp-http",
        crate::runtime::external_connectors::ConnectorKind::Cli => "cli",
        crate::runtime::external_connectors::ConnectorKind::Sdk => "sdk",
        crate::runtime::external_connectors::ConnectorKind::Http => "http",
    }
}

fn mcp_transport(transport: &crate::runtime::external_connectors::McpTransport) -> &'static str {
    match transport {
        crate::runtime::external_connectors::McpTransport::StreamableHttp => "streamable-http",
        crate::runtime::external_connectors::McpTransport::Sse => "sse",
    }
}

fn mcp_program_source(
    source: &crate::runtime::external_connectors::McpProgramSource,
) -> &'static str {
    match source {
        crate::runtime::external_connectors::McpProgramSource::SystemRuntime => "system-runtime",
        crate::runtime::external_connectors::McpProgramSource::ExternalCommand => {
            "external-command"
        }
        crate::runtime::external_connectors::McpProgramSource::ExternalUrl => "external-url",
        crate::runtime::external_connectors::McpProgramSource::BundledPlugin => "bundled-plugin",
        crate::runtime::external_connectors::McpProgramSource::BundledMcpApp => "bundled-mcp-app",
        crate::runtime::external_connectors::McpProgramSource::ManagedLocal => "managed-local",
    }
}

fn mcp_server_program_json(
    program: &crate::runtime::external_connectors::McpServerProgram,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("source".into(), json!(mcp_program_source(&program.source)));
    if let Some(program_id) = program.program_id.as_ref() {
        object.insert("programId".into(), json!(program_id));
    }
    Value::Object(object)
}

fn insert_secret_reference_map(
    object: &mut serde_json::Map<String, Value>,
    field: &str,
    references: Option<
        &BTreeMap<String, crate::runtime::external_connectors::ConnectorSecretReference>,
    >,
) {
    let Some(references) = references else {
        return;
    };
    let references = references
        .iter()
        .map(|(key, reference)| {
            (
                key.to_owned(),
                json!({ "kind": "secret-ref", "ref": reference.reference }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    if !references.is_empty() {
        object.insert(field.into(), Value::Object(references));
    }
}

pub(crate) enum Command {
    List,
    Catalog,
    Status,
    SessionStatus(SessionStatusTarget),
    SessionMcpServerEnabled(SessionMcpServerEnabledTarget),
    Probe(String),
    Get(String),
    Upsert(Box<Connector>),
    Remove(String),
}

impl Request {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, RequestError> {
        let operation = value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|operation| operation_name(operation).is_some())
            .ok_or(RequestError::Invalid)?;
        verifier
            .verify(authorization, now, ENDPOINT, SCOPE, operation, SUBJECT)
            .map_err(|_| RequestError::Unauthorized)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request
            .valid()
            .then_some(request)
            .ok_or(RequestError::Invalid)
    }

    fn valid(&self) -> bool {
        self.id == CAPABILITY_ID
            && self.scope.kind == "external-connector-catalog"
            && self.target.kind == "external-connectors"
            && operation_name(&self.operation_id).is_some_and(|kind| match (&self.input, kind) {
                (Input::List {}, "list")
                | (Input::Catalog {}, "catalog")
                | (Input::Status {}, "status") => true,
                (Input::SessionStatus { session_identity }, "sessionStatus") => {
                    SessionStatusTarget {
                        session_identity: session_identity.clone(),
                    }
                    .is_valid()
                }
                (
                    Input::SessionMcpServerEnabled {
                        session_identity,
                        server_id,
                        enabled,
                    },
                    "sessionMcpServerEnabled",
                ) => SessionMcpServerEnabledTarget {
                    session_identity: session_identity.clone(),
                    server_id: server_id.clone(),
                    enabled: *enabled,
                }
                .is_valid(),
                (Input::Probe { connector_id }, "probe")
                | (Input::Get { connector_id }, "get")
                | (Input::Remove { connector_id }, "remove") => valid_id(connector_id),
                (Input::Upsert { connector }, "upsert") => {
                    connector.validate().is_ok() && !is_private_system_runtime_connector(connector)
                }
                _ => false,
            })
    }

    pub(crate) fn into_command(self) -> Command {
        match self.input {
            Input::List {} => Command::List,
            Input::Catalog {} => Command::Catalog,
            Input::Status {} => Command::Status,
            Input::SessionStatus { session_identity } => {
                Command::SessionStatus(SessionStatusTarget { session_identity })
            }
            Input::SessionMcpServerEnabled {
                session_identity,
                server_id,
                enabled,
            } => Command::SessionMcpServerEnabled(SessionMcpServerEnabledTarget {
                session_identity,
                server_id,
                enabled,
            }),
            Input::Probe { connector_id } => Command::Probe(connector_id),
            Input::Get { connector_id } => Command::Get(connector_id),
            Input::Upsert { connector } => Command::Upsert(connector),
            Input::Remove { connector_id } => Command::Remove(connector_id),
        }
    }
}

fn operation_name(operation: &str) -> Option<&'static str> {
    match operation {
        "externalConnectors.list" => Some("list"),
        "externalConnectors.catalog" => Some("catalog"),
        "externalConnectors.status" => Some("status"),
        "externalConnectors.sessionStatus" => Some("sessionStatus"),
        "externalConnectors.sessionMcpServerEnabled" => Some("sessionMcpServerEnabled"),
        "externalConnectors.probe" => Some("probe"),
        "externalConnectors.get" => Some("get"),
        "externalConnectors.upsert" => Some("upsert"),
        "externalConnectors.remove" => Some("remove"),
        _ => None,
    }
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 128
}

fn is_private_system_runtime_connector(connector: &Connector) -> bool {
    connector
        .mcp_server_program()
        .is_some_and(|program| matches!(program.source(), McpProgramSource::SystemRuntime))
}

pub(crate) enum Delivery {
    List(ListOutcome),
    Catalog(CatalogOutcome),
    Status(Vec<(String, ConnectorObservation)>),
    SessionStatus(Vec<SessionConnectorStatus>),
    SessionMcpServerEnabled(SessionMcpServerEnabledOutcome),
    Probe(String, ConnectorObservation),
    Missing,
    Get(GetOutcome),
    Mutation(MutationOutcome),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::List(ListOutcome::Available(_))
            | Self::Catalog(CatalogOutcome::Available(_))
            | Self::Status(_)
            | Self::SessionStatus(_)
            | Self::SessionMcpServerEnabled(SessionMcpServerEnabledOutcome::Applied)
            | Self::Probe(..)
            | Self::Get(GetOutcome::Found(_))
            | Self::Mutation(MutationOutcome::Stored { .. } | MutationOutcome::Removed { .. }) => {
                200
            }
            Self::Missing
            | Self::Get(GetOutcome::Missing)
            | Self::Mutation(MutationOutcome::Missing) => 404,
            Self::Mutation(MutationOutcome::Rejected) => 422,
            Self::Mutation(MutationOutcome::Unknown) => 409,
            Self::Catalog(CatalogOutcome::Unavailable)
            | Self::List(ListOutcome::Unavailable)
            | Self::Get(GetOutcome::Unavailable)
            | Self::Mutation(MutationOutcome::Unavailable)
            | Self::SessionMcpServerEnabled(SessionMcpServerEnabledOutcome::Unavailable)
            | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::List(ListOutcome::Available(connectors)) => {
                json!({ "connectors": connectors.iter().map(public_connector_json).collect::<Vec<_>>() })
            }
            Self::Catalog(CatalogOutcome::Available(programs)) => {
                json!({ "programs": programs.iter().map(catalog_program_json).collect::<Vec<_>>() })
            }
            Self::Status(statuses) => {
                json!({ "statuses": statuses.iter().map(|(id, result)| status_json(id, result)).collect::<Vec<_>>() })
            }
            Self::SessionStatus(statuses) => json!({ "statuses": statuses }),
            Self::SessionMcpServerEnabled(SessionMcpServerEnabledOutcome::Applied) => {
                json!({ "success": true, "effectiveNextRun": true })
            }
            Self::SessionMcpServerEnabled(SessionMcpServerEnabledOutcome::Unavailable) => {
                error("External connectors are unavailable")
            }
            Self::Probe(id, result) => json!({ "status": status_json(id, result) }),
            Self::Get(GetOutcome::Found(connector)) => {
                json!({ "connector": public_connector_json(connector) })
            }
            Self::Mutation(MutationOutcome::Stored {
                connector,
                created,
                revision,
                configuration,
            }) => json!({
                "success": true,
                "connector": public_connector_json(connector),
                "resultType": if *created { "created" } else { "updated" },
                "desired": { "status": "stored", "revision": revision },
                "applied": configuration_json(*configuration),
                "observed": { "status": "not-observed" },
            }),
            Self::Mutation(MutationOutcome::Removed {
                revision,
                configuration,
            }) => json!({
                "success": true,
                "desired": { "status": "removed", "revision": revision },
                "applied": configuration_json(*configuration),
                "observed": { "status": "not-observed" },
            }),
            Self::Missing
            | Self::Get(GetOutcome::Missing)
            | Self::Mutation(MutationOutcome::Missing) => error("External connector is unknown"),
            Self::Mutation(MutationOutcome::Rejected) => {
                error("External connector request was rejected")
            }
            Self::Mutation(MutationOutcome::Unknown) => {
                error("External connector mutation outcome is unknown; reopen before retrying")
            }
            Self::Catalog(CatalogOutcome::Unavailable)
            | Self::List(ListOutcome::Unavailable)
            | Self::Get(GetOutcome::Unavailable)
            | Self::Mutation(MutationOutcome::Unavailable)
            | Self::Unavailable => error("External connectors are unavailable"),
        }
    }
}

fn status_json(id: &str, observation: &ConnectorObservation) -> Value {
    match observation {
        ConnectorObservation::Connected => json!({
            "connectorId": id,
            "resultType": "connected",
            "reason": "MCP probe succeeded",
            "safeProbe": true,
        }),
        ConnectorObservation::Disconnected => json!({
            "connectorId": id,
            "resultType": "disconnected",
            "reason": "MCP probe failed",
            "safeProbe": true,
        }),
        ConnectorObservation::Disabled => {
            json!({ "connectorId": id, "resultType": "disabled", "reason": "connector is disabled", "safeProbe": false })
        }
        ConnectorObservation::Unsupported => json!({
            "connectorId": id,
            "resultType": "unsupported",
            "reason": "connector has no source-backed runtime status producer",
            "safeProbe": false,
        }),
        ConnectorObservation::Unknown => json!({
            "connectorId": id,
            "resultType": "unknown",
            "reason": "OpenClaw native MCP session status is unavailable",
            "safeProbe": false,
        }),
    }
}

fn configuration_json(effect: ConnectorProjectionEffect) -> Value {
    match effect {
        ConnectorProjectionEffect::Written { changed } => {
            json!({ "status": "written", "changed": changed })
        }
        ConnectorProjectionEffect::Unknown => json!({ "status": "unknown" }),
        ConnectorProjectionEffect::Unavailable => json!({ "status": "unavailable" }),
    }
}

fn error(message: &'static str) -> Value {
    json!({ "success": false, "error": message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_variant_rejects_unknown_fields() {
        let request = serde_json::from_value::<Request>(json!({
            "id": "external.connectors",
            "operationId": "externalConnectors.list",
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": { "kind": "list" }
        }))
        .expect("public list request");
        assert!(request.valid());

        let invalid = serde_json::from_value::<Request>(json!({
            "id": "external.connectors",
            "operationId": "externalConnectors.list",
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": { "kind": "list", "bogus": 1 }
        }));
        assert!(invalid.is_err());
    }

    #[test]
    fn opaque_secret_references_are_accepted_but_resolved_values_are_not() {
        let request = serde_json::from_value::<Request>(json!({
            "id": "external.connectors",
            "operationId": "externalConnectors.upsert",
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": {
                "kind": "upsert",
                "connector": {
                    "id": "remote",
                    "kind": "mcp-http",
                    "url": "https://example.test/mcp",
                    "secretHeaders": {
                        "Authorization": { "kind": "secret-ref", "ref": "credential:v1:opaque" }
                    }
                }
            }
        }))
        .expect("opaque secret reference request");
        assert!(request.valid());

        let request = serde_json::from_value::<Request>(json!({
            "id": "external.connectors",
            "operationId": "externalConnectors.upsert",
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": {
                "kind": "upsert",
                "connector": {
                    "id": "remote",
                    "kind": "mcp-http",
                    "url": "https://example.test/mcp",
                    "headers": { "Authorization": "resolved-secret-value" }
                }
            }
        }))
        .expect("resolved-value request decodes");
        assert!(!request.valid());
    }

    #[test]
    fn public_probe_request_decodes_camel_case_connector_id() {
        let request = serde_json::from_value::<Request>(json!({
            "id": "external.connectors",
            "operationId": "externalConnectors.probe",
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": { "kind": "probe", "connectorId": "remote" }
        }))
        .expect("public probe request");

        assert!(request.valid());
        assert!(matches!(request.into_command(), Command::Probe(id) if id == "remote"));
    }

    #[test]
    fn session_mcp_server_enabled_request_decodes_to_next_run_receipt() {
        let request = serde_json::from_value::<Request>(json!({
            "id": "external.connectors",
            "operationId": "externalConnectors.sessionMcpServerEnabled",
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": {
                "kind": "sessionMcpServerEnabled",
                "sessionIdentity": {
                    "endpoint": {
                        "kind": "native-runtime",
                        "runtimeAdapterId": "openclaw",
                        "runtimeInstanceId": "main"
                    },
                    "agentId": "main",
                    "sessionKey": "agent:main:session-1"
                },
                "serverId": "remote",
                "enabled": false
            }
        }))
        .expect("session MCP enablement request");

        assert!(request.valid());
        match request.into_command() {
            Command::SessionMcpServerEnabled(target) => {
                assert_eq!(target.server_id, "remote");
                assert!(!target.enabled);
                assert_eq!(target.session_identity.session_key, "agent:main:session-1");
            }
            _ => panic!("expected session MCP enablement command"),
        }

        let delivery = Delivery::SessionMcpServerEnabled(SessionMcpServerEnabledOutcome::Applied);
        assert_eq!(delivery.status_code(), 200);
        assert_eq!(
            delivery.body(),
            json!({ "success": true, "effectiveNextRun": true })
        );
    }

    #[test]
    fn catalog_unavailability_is_not_projected_as_an_empty_program_list() {
        let delivery = Delivery::Catalog(CatalogOutcome::Unavailable);
        assert_eq!(delivery.status_code(), 503);
        assert_eq!(
            delivery.body(),
            error("External connectors are unavailable")
        );
    }

    #[test]
    fn mutation_receipt_separates_desired_applied_and_observed_planes() {
        let body = Delivery::Mutation(MutationOutcome::Stored {
            connector: Box::new(system_runtime_connector_read_model()),
            created: true,
            revision: 1,
            configuration: ConnectorProjectionEffect::Unknown,
        })
        .body();

        assert_eq!(
            body["desired"],
            json!({ "status": "stored", "revision": 1 })
        );
        assert_eq!(body["applied"], json!({ "status": "unknown" }));
        assert_eq!(body["observed"], json!({ "status": "not-observed" }));
    }

    #[test]
    fn public_upserts_reject_the_private_matcha_system_runtime_connector() {
        let connector = crate::connectors::system_runtime_connector();
        let request = Request {
            id: CAPABILITY_ID.into(),
            operation_id: "externalConnectors.upsert".into(),
            scope: Kind {
                kind: "external-connector-catalog".into(),
            },
            target: Kind {
                kind: "external-connectors".into(),
            },
            input: Input::Upsert {
                connector: Box::new(connector),
            },
        };
        assert!(!request.valid());
    }

    #[test]
    fn observation_without_native_openclaw_session_facts_stays_unknown() {
        assert_eq!(
            status_json("remote", &ConnectorObservation::Unknown),
            json!({
                "connectorId": "remote",
                "resultType": "unknown",
                "reason": "OpenClaw native MCP session status is unavailable",
                "safeProbe": false,
            })
        );
    }

    #[test]
    fn disabled_connector_status_is_typed_and_not_probeable() {
        assert_eq!(
            status_json("disabled", &ConnectorObservation::Disabled),
            json!({
                "connectorId": "disabled",
                "resultType": "disabled",
                "reason": "connector is disabled",
                "safeProbe": false,
            })
        );
    }

    #[test]
    fn unsupported_connector_status_is_typed_and_not_probeable() {
        assert_eq!(
            status_json("stdio", &ConnectorObservation::Unsupported),
            json!({
                "connectorId": "stdio",
                "resultType": "unsupported",
                "reason": "connector has no source-backed runtime status producer",
                "safeProbe": false,
            })
        );
    }

    #[test]
    fn status_mapping_never_contains_connector_private_material() {
        let observation = status_json("remote", &ConnectorObservation::Unknown);
        let encoded = observation.to_string();
        for secret in [
            "Authorization",
            "bearer secret-token",
            "https://private.example/mcp",
            "private-command",
        ] {
            assert!(!encoded.contains(secret));
        }
    }

    fn system_runtime_connector_read_model() -> ConnectorReadModel {
        ConnectorReadModel {
            id: "system-runtime".into(),
            kind: crate::runtime::external_connectors::ConnectorKind::McpStdio,
            display_name: Some("System Runtime".into()),
            description: None,
            enabled: Some(true),
            workspace_id: None,
            source_id: None,
            mcp_server_program: Some(crate::runtime::external_connectors::McpServerProgram {
                source: crate::runtime::external_connectors::McpProgramSource::SystemRuntime,
                program_id: None,
            }),
            tags: None,
            command: None,
            args: None,
            cwd: None,
            env: None,
            url: None,
            transport: None,
            connection_timeout_ms: None,
            headers: None,
            base_url: None,
            provider: None,
            package_name: None,
            config: None,
            secret_env: None,
            secret_headers: None,
            secret_config_refs: None,
        }
    }

    #[test]
    fn public_connector_json_keeps_opaque_secret_metadata_without_values() {
        let mut secret_headers = BTreeMap::new();
        secret_headers.insert(
            "Authorization".into(),
            crate::runtime::external_connectors::ConnectorSecretReference {
                kind: crate::runtime::external_connectors::ConnectorSecretReferenceKind::SecretRef,
                reference: "credential:v1:opaque".into(),
            },
        );
        let connector = ConnectorReadModel {
            id: "remote".into(),
            kind: crate::runtime::external_connectors::ConnectorKind::McpHttp,
            display_name: None,
            description: None,
            enabled: None,
            workspace_id: None,
            source_id: None,
            mcp_server_program: None,
            tags: None,
            command: Some("private-command".into()),
            args: Some(vec!["private-argument".into()]),
            cwd: Some("C:/private/runtime".into()),
            env: Some(BTreeMap::from([(
                "PRIVATE_ENV".into(),
                "private-value".into(),
            )])),
            url: Some("https://example.test/mcp".into()),
            transport: None,
            connection_timeout_ms: None,
            headers: Some(BTreeMap::from([(
                "X-Private".into(),
                "private-value".into(),
            )])),
            base_url: None,
            provider: None,
            package_name: None,
            config: Some(BTreeMap::from([(
                "privateConfig".into(),
                serde_json::Value::String("private-value".into()),
            )])),
            secret_env: None,
            secret_headers: Some(secret_headers),
            secret_config_refs: None,
        };
        let output = public_connector_json(&connector).to_string();
        assert!(output.contains("secretHeaders"));
        assert!(output.contains("credential:v1:opaque"));
        for private_field in [
            "private-command",
            "private-argument",
            "C:/private/runtime",
            "PRIVATE_ENV",
            "X-Private",
            "privateConfig",
            "command",
            "args",
            "cwd",
            "env",
            "headers",
            "config",
            "resolved-secret-value",
        ] {
            assert!(!output.contains(private_field));
        }
    }
}
