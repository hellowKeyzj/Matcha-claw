use platform::call::CallDetail;
use serde::Serialize;

use crate::{ConfigurationOutcome, Operation, OperationOutcome};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Outcome {
    Configured,
    Rejected,
    Unknown,
}

impl From<ConfigurationOutcome> for Outcome {
    fn from(outcome: ConfigurationOutcome) -> Self {
        match outcome {
            ConfigurationOutcome::Configured => Self::Configured,
            ConfigurationOutcome::Rejected => Self::Rejected,
            ConfigurationOutcome::Unknown => Self::Unknown,
        }
    }
}

impl From<OperationOutcome> for Outcome {
    fn from(outcome: OperationOutcome) -> Self {
        match outcome {
            OperationOutcome::Configured => Self::Configured,
            OperationOutcome::Rejected => Self::Rejected,
            OperationOutcome::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Detail {
    Catalog {
        plugin_count: Option<usize>,
        installed_count: Option<usize>,
        enabled_count: Option<usize>,
    },
    Runtime {
        plugin_count: Option<usize>,
        enabled_count: Option<usize>,
        running_count: Option<usize>,
    },
    Configuration {
        plugin_id: Option<String>,
        enabled: bool,
        outcome: Option<Outcome>,
    },
    Operation {
        plugin_id: Option<String>,
        operation: Operation,
        outcome: Option<Outcome>,
    },
}

impl CallDetail for Detail {
    const MODULE: &'static str = "plugins";
}

pub(crate) fn plugin_identity(plugin_id: &str) -> Option<String> {
    // Native identity only; never audit package paths, URLs, or arbitrary request text.
    (!plugin_id.is_empty()
        && plugin_id.len() <= 128
        && plugin_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')))
    .then(|| plugin_id.to_owned())
}
