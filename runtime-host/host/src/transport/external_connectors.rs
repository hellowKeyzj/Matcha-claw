use serde::Deserialize;
use serde_json::{Value, json};

use crate::external_connectors::{
    CatalogOutcome, GetOutcome, ListOutcome, MutationOutcome, SessionConnectorStatus,
    SessionIdentity,
};
use crate::transport::authorization::CapabilityDecisionVerifier;
use openclaw::projection::connector::external::ConnectorObservation;

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
    List,
    Catalog,
    Status,
    SessionStatus {
        session_identity: SessionIdentity,
    },
    Probe {
        connector_id: String,
    },
    Get {
        connector_id: String,
    },
    Upsert {
        #[serde(deserialize_with = "deserialize_public_connector")]
        connector: Box<environment::Connector>,
    },
    Remove {
        connector_id: String,
    },
}

fn deserialize_public_connector<'de, D>(
    deserializer: D,
) -> Result<Box<environment::Connector>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Box::new(
        environment::ConnectorPublicInput::deserialize(deserializer)?.into_connector(),
    ))
}

pub(crate) enum Command {
    List,
    Catalog,
    Status,
    SessionStatus(SessionIdentity),
    Probe(String),
    Get(String),
    Upsert(Box<environment::Connector>),
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
                (Input::List, "list") | (Input::Catalog, "catalog") | (Input::Status, "status") => {
                    true
                }
                (Input::SessionStatus { session_identity }, "sessionStatus") => {
                    session_identity.is_valid()
                }
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
            Input::List => Command::List,
            Input::Catalog => Command::Catalog,
            Input::Status => Command::Status,
            Input::SessionStatus { session_identity } => Command::SessionStatus(session_identity),
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

fn is_private_system_runtime_connector(connector: &environment::Connector) -> bool {
    connector
        .mcp_server_program
        .as_ref()
        .is_some_and(|program| {
            matches!(program.source, environment::McpProgramSource::SystemRuntime)
        })
}

pub(crate) enum Delivery {
    List(ListOutcome),
    Catalog(CatalogOutcome),
    Status(Vec<(String, ConnectorObservation)>),
    SessionStatus(Vec<SessionConnectorStatus>),
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
            | Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::List(ListOutcome::Available(connectors)) => {
                json!({ "connectors": connectors.iter().map(environment::Connector::public_json).collect::<Vec<_>>() })
            }
            Self::Catalog(CatalogOutcome::Available(programs)) => json!({ "programs": programs }),
            Self::Status(statuses) => {
                json!({ "statuses": statuses.iter().map(|(id, result)| status_json(id, result)).collect::<Vec<_>>() })
            }
            Self::SessionStatus(statuses) => json!({ "statuses": statuses }),
            Self::Probe(id, result) => json!({ "status": status_json(id, result) }),
            Self::Get(GetOutcome::Found(connector)) => {
                json!({ "connector": connector.public_json() })
            }
            Self::Mutation(MutationOutcome::Stored {
                connector,
                created,
                revision,
                configuration,
            }) => json!({
                "success": true,
                "connector": connector.public_json(),
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

fn configuration_json(
    effect: openclaw::projection::connector::external::ConnectorProjectionEffect,
) -> Value {
    match effect {
        openclaw::projection::connector::external::ConnectorProjectionEffect::Written {
            changed,
        } => json!({ "status": "written", "changed": changed }),
        openclaw::projection::connector::external::ConnectorProjectionEffect::Unknown => {
            json!({ "status": "unknown" })
        }
        openclaw::projection::connector::external::ConnectorProjectionEffect::Unavailable => {
            json!({ "status": "unavailable" })
        }
    }
}

fn error(message: &'static str) -> Value {
    json!({ "success": false, "error": message })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let connector = environment::Connector::system_runtime();
        let body = Delivery::Mutation(MutationOutcome::Stored {
            connector: Box::new(connector),
            created: true,
            revision: 1,
            configuration:
                openclaw::projection::connector::external::ConnectorProjectionEffect::Unknown,
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
        let connector = environment::Connector::system_runtime();
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

    #[test]
    fn public_connector_json_keeps_opaque_secret_metadata_without_values() {
        let connector = serde_json::from_value::<environment::Connector>(json!({
            "id": "remote",
            "kind": "mcp-http",
            "url": "https://example.test/mcp",
            "secretHeaders": {
                "Authorization": { "kind": "secret-ref", "ref": "credential:v1:opaque" }
            }
        }))
        .expect("connector");
        let output = connector.public_json().to_string();
        assert!(output.contains("secretHeaders"));
        assert!(output.contains("credential:v1:opaque"));
        assert!(!output.contains("resolved-secret-value"));
    }
}
