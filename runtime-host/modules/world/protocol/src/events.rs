use crate::ids::*;
use serde::{Deserialize, Serialize};
/// Invalidation hints only. Re-read authorized canonical snapshots after either hint.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorldHint {
    Changed {
        world: WorldRef,
        incarnation: Generation,
        resource: ResourceRef,
        revision: Revision,
    },
    ResyncRequired {
        world: WorldRef,
        incarnation: Generation,
    },
}
