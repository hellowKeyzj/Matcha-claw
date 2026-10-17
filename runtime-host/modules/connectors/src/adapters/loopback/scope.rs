use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::{Deserialize, Deserializer};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Scope {
    ExternalConnectorCatalog,
    OpenclawMcpServers,
    RuntimeInstance {
        #[serde(deserialize_with = "endpoint")]
        endpoint: RuntimeEndpoint,
    },
}

impl Scope {
    pub(super) fn endpoint(&self) -> Option<&RuntimeEndpoint> {
        match self {
            Self::RuntimeInstance { endpoint } => Some(endpoint),
            _ => None,
        }
    }

    pub(super) fn into_endpoint(self) -> Option<RuntimeEndpoint> {
        match self {
            Self::RuntimeInstance { endpoint } => Some(endpoint),
            _ => None,
        }
    }
}

fn endpoint<'de, D: Deserializer<'de>>(deserializer: D) -> Result<RuntimeEndpoint, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Endpoint {
        kind: String,
        runtime_adapter_id: String,
        runtime_instance_id: String,
    }
    let value = Endpoint::deserialize(deserializer)?;
    if value.kind != "native-runtime" {
        return Err(serde::de::Error::custom("invalid runtime endpoint"));
    }
    RuntimeEndpoint::try_new(value.runtime_adapter_id, value.runtime_instance_id)
        .map_err(serde::de::Error::custom)
}
