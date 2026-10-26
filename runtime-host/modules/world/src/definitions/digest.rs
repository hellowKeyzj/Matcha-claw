use serde::Serialize;
use sha2::{Digest as _, Sha256};
use world_protocol::{
    definitions::{Definition, DefinitionBody, DefinitionFailure},
    ids::Digest,
};

pub(crate) fn content_digest(
    definition: &Definition<DefinitionBody>,
) -> Result<Digest, DefinitionFailure> {
    let mut dependencies = definition.dependencies.clone();
    dependencies.sort_unstable();
    dependencies.dedup();
    canonical_digest(&(
        "world.definition.v1",
        &definition.reference,
        &definition.scope,
        &definition.valid_time,
        &definition.body,
        dependencies,
        &definition.previous_ref,
        &definition.lifecycle,
    ))
}

pub(crate) fn canonical_digest(value: &impl Serialize) -> Result<Digest, DefinitionFailure> {
    let value = serde_json::to_value(value).map_err(|_| DefinitionFailure::InternalFault)?;
    let bytes =
        serde_json::to_vec(&canonical(value)).map_err(|_| DefinitionFailure::InternalFault)?;
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|_| DefinitionFailure::InternalFault)
}

fn canonical(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(fields) => {
            let sorted: std::collections::BTreeMap<_, _> = fields.into_iter().collect();
            serde_json::Value::Object(
                sorted
                    .into_iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect(),
            )
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(canonical).collect())
        }
        value => value,
    }
}
