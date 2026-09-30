use platform::call::{CallDetail, CallStatus};
use serde::Serialize;

use super::receipts::{Outcome, Settlement};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SettingsOperation {
    ReadCurrent,
    ReplaceDesired,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SettingsCallFailure {
    InvalidRequest,
    Unauthorized,
    OwnerUnavailable,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsCallDetail {
    pub operation: SettingsOperation,
    pub settlement: Option<Settlement>,
    pub launch_at_startup: Option<bool>,
    pub failure: Option<SettingsCallFailure>,
}

impl CallDetail for SettingsCallDetail {
    const MODULE: &'static str = "settings";
}

impl SettingsCallDetail {
    pub fn new(operation: SettingsOperation) -> Self {
        Self {
            operation,
            settlement: None,
            launch_at_startup: None,
            failure: None,
        }
    }

    pub fn settled(settlement: Settlement, launch_at_startup: bool) -> Self {
        Self {
            operation: SettingsOperation::ReplaceDesired,
            settlement: Some(settlement),
            launch_at_startup: Some(launch_at_startup),
            failure: None,
        }
    }
}

pub(crate) fn settlement_status(settlement: Settlement) -> CallStatus {
    match settlement.outcome {
        Outcome::Confirmed => CallStatus::Succeeded,
        Outcome::Rejected => CallStatus::Rejected,
        Outcome::Unknown => CallStatus::Unknown,
    }
}
