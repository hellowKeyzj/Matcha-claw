//! Canonical schemas are derived from the actual shared wire types, never from contract names.
use crate::{
    ids::{ContractId, Digest},
    sources::ContractRef,
};
use schemars::JsonSchema;
use serde::Serialize;
use sha2::{Digest as _, Sha256};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SchemaFailure;
impl std::fmt::Display for SchemaFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("world contract schema could not be encoded")
    }
}
impl std::error::Error for SchemaFailure {}

pub fn bytes<T: JsonSchema>() -> Result<Vec<u8>, SchemaFailure> {
    serde_json::to_vec(&schemars::schema_for!(T)).map_err(|_| SchemaFailure)
}
pub fn digest<T: JsonSchema>() -> Result<Digest, SchemaFailure> {
    hash(&bytes::<T>()?)
}
pub fn hash(bytes: &[u8]) -> Result<Digest, SchemaFailure> {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).map_err(|_| SchemaFailure)
}
pub fn contract<T: JsonSchema>(id: &str) -> Result<ContractRef, SchemaFailure> {
    Ok(ContractRef {
        id: ContractId::try_new(id).map_err(|_| SchemaFailure)?,
        version: "1.0.0".into(),
        schema_digest: digest::<T>()?,
    })
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MethodSchema<Request, Response, Failure> {
    pub request: Request,
    pub response: Response,
    pub failure: Failure,
}
pub fn method<Request: JsonSchema, Response: JsonSchema, Failure: JsonSchema>(
    id: &str,
) -> Result<ContractRef, SchemaFailure> {
    contract::<MethodSchema<Request, Response, Failure>>(id)
}
/// Production export consumed by both runtime validation and generated clients.
pub fn public_api() -> Result<Vec<u8>, SchemaFailure> {
    use crate::{api, operation};
    let mut schemas = std::collections::BTreeMap::new();
    macro_rules! add {
        ($name:literal, $ty:ty) => {
            schemas.insert($name, schemars::schema_for!($ty));
        };
    }
    add!("QueryEnvelope", api::QueryEnvelope);
    add!("WorldQuery", api::WorldQuery);
    add!("QueryResult", api::QueryResult);
    add!("CommandEnvelope", api::CommandEnvelope);
    add!("WorldCommand", api::WorldCommand);
    add!("CommandResult", api::CommandResult);
    add!("OperationRequest", operation::OperationRequest);
    add!("OperationResponse", operation::OperationResponse);
    add!("PeerRequest", api::PeerRequest);
    add!("PeerOperation", api::PeerOperation);
    add!("PeerResponse", api::PeerResponse);
    add!("WorldHint", crate::events::WorldHint);
    add!("ApiFailure", api::ApiFailure);
    add!("Failure", crate::failure::Failure<api::ApiFailure>);
    let operations = std::collections::BTreeMap::from([
        (
            "query",
            api::WorldQuery::OPERATIONS
                .iter()
                .copied()
                .collect::<std::collections::BTreeMap<_, _>>(),
        ),
        (
            "command",
            api::WorldCommand::OPERATIONS.iter().copied().collect(),
        ),
        (
            "operation",
            operation::OperationRequest::OPERATIONS
                .iter()
                .copied()
                .collect(),
        ),
        (
            "peer",
            api::PeerOperation::OPERATIONS.iter().copied().collect(),
        ),
    ]);
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SourceConnector {
        registration: &'static str,
        driver: String,
        read_contract: ContractRef,
    }
    let config_schema = schemars::schema_for!(crate::sources::SourceConnectionConfig);
    let variants = config_schema
        .get("oneOf")
        .and_then(serde_json::Value::as_array)
        .ok_or(SchemaFailure)?;
    let source_connectors = [
        (
            crate::sources::POSTGRES_REGISTRATION,
            crate::sources::PostgresConnectionConfig::schema_name(),
        ),
        (
            crate::sources::HTTP_JSON_REGISTRATION,
            crate::sources::HttpJsonConnectionConfig::schema_name(),
        ),
    ]
    .into_iter()
    .map(|(registration, config)| {
        let reference = format!("#/$defs/{config}");
        let driver = variants
            .iter()
            .find_map(|variant| {
                (variant.pointer("/properties/config/$ref")?.as_str()? == reference).then(|| {
                    variant
                        .pointer("/properties/kind/const")?
                        .as_str()
                        .map(str::to_owned)
                })?
            })
            .ok_or(SchemaFailure)?;
        Ok(SourceConnector {
            registration,
            driver,
            read_contract: crate::sources::read_contract()?,
        })
    })
    .collect::<Result<Vec<_>, SchemaFailure>>()?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Export<S, O, C> {
        format: &'static str,
        schemas: S,
        operations: O,
        source_connectors: C,
    }
    serde_json::to_vec(&Export {
        format: "matcha.world-public-api/1",
        schemas,
        operations,
        source_connectors,
    })
    .map_err(|_| SchemaFailure)
}
