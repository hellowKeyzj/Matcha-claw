use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct Validation {
    pub(crate) success: bool,
    pub(crate) valid: bool,
    pub(crate) errors: Vec<String>,
    pub(crate) warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Validated(Validation),
    TargetRejected,
    Unknown,
}
