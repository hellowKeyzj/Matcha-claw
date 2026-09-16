mod store_schema;

mod model;
mod persistence;
mod secrets;
mod store;
#[cfg(test)]
mod store_tests;

pub use model::{
    Connector, ConnectorCatalog, ConnectorConfig, ConnectorConfigValue, ConnectorError,
    ConnectorInput, ConnectorKind, ConnectorPublicInput, InvalidConnectorConfig, McpProgramSource,
    McpServerProgram, McpTransport,
};

#[cfg(test)]
mod tests;

pub use secrets::{
    ConnectorSecretAuthority, ConnectorSecretRef, ConnectorSecretValue, InvalidConnectorSecretRef,
    InvalidConnectorSecretValue, UnavailableConnectorSecretAuthority,
    unavailable_connector_secret_authority,
};
pub use store::{ConnectorStore, ConnectorStoreError};
