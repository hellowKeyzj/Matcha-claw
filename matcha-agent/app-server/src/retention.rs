//! Explicit retention for the diagnostics store only; no events, sessions or
//! native transcripts are deleted. Gateway forwards the method params unchanged.
//!
//! retention.status {} -> { scope: "diagnostics", diagnostics: <owner status>,
//! nativeTranscriptDeletion: false, automaticPrune: false }
//! retention.prune { beforeMs: u64 } -> Diagnostics::prune's receipt unchanged.
//! A future cutoff is invalid. Diagnostics owns deletion, counts and storage errors.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    config::ConfigStore,
    diagnostics::Diagnostics,
    rpc::{self, Error},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PruneParams {
    before_ms: u64,
}

pub async fn dispatch(
    method: &str,
    params: Value,
    _config: &ConfigStore,
    diagnostics: &Diagnostics,
) -> rpc::Result<Value> {
    match method {
        "retention.status" => {
            let _: StatusParams = rpc::params(params)?;
            Ok(json!({
                "scope": "diagnostics",
                "diagnostics": diagnostics.retention_status().await?,
                "nativeTranscriptDeletion": false,
                "automaticPrune": false,
            }))
        }
        "retention.prune" => {
            let params: PruneParams = rpc::params(params)?;
            if params.before_ms > rpc::now_ms() {
                return Err(Error::invalid("beforeMs must not be in the future"));
            }
            diagnostics.prune(params.before_ms).await
        }
        _ => Err(Error::method(method)),
    }
}
