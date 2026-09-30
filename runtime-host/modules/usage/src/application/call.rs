use platform::call::{CallContext, CallDetail, CallStatus};
use serde::Serialize;

use crate::domain::model::{UsageEntry, UsageReadError};

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum UsageCallDetail {
    Recent {
        period: UsagePeriod,
        limit: u64,
        #[serde(rename = "entryCount")]
        entry_count: Option<u64>,
        failure: Option<CallFailure>,
    },
    SessionTimeseries {
        period: UsagePeriod,
        #[serde(rename = "entryCount")]
        entry_count: Option<u64>,
        failure: Option<CallFailure>,
    },
}

impl CallDetail for UsageCallDetail {
    const MODULE: &'static str = "usage";
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UsagePeriod {
    All,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CallFailure {
    AdmissionClosed,
    OwnerUnavailable,
    RecordingUnavailable,
    RuntimeUnavailable,
}

impl UsageCallDetail {
    pub(crate) fn recent(limit: usize) -> Self {
        Self::Recent {
            period: UsagePeriod::All,
            limit: safe_count(limit),
            entry_count: None,
            failure: None,
        }
    }

    pub(crate) fn session_timeseries() -> Self {
        Self::SessionTimeseries {
            period: UsagePeriod::All,
            entry_count: None,
            failure: None,
        }
    }

    pub(crate) fn failed(mut self, category: CallFailure) -> Self {
        match &mut self {
            Self::Recent { failure, .. } | Self::SessionTimeseries { failure, .. } => {
                *failure = Some(category);
            }
        }
        self
    }

    pub(crate) fn observed(mut self, result: &Result<Vec<UsageEntry>, UsageReadError>) -> Self {
        match result {
            Ok(entries) => {
                match &mut self {
                    Self::Recent { entry_count, .. }
                    | Self::SessionTimeseries { entry_count, .. } => {
                        *entry_count = Some(safe_count(entries.len()));
                    }
                }
                self
            }
            Err(UsageReadError::Unavailable) => self.failed(CallFailure::RuntimeUnavailable),
        }
    }
}

fn safe_count(count: usize) -> u64 {
    (count as u64).min(9_007_199_254_740_991)
}

pub(crate) async fn finish(
    context: Option<&CallContext<UsageCallDetail>>,
    status: CallStatus,
    detail: &UsageCallDetail,
) {
    if let Some(context) = context {
        if let Err(error) = context.finish(status, detail).await {
            eprintln!(
                "[usage:call] terminal record failed call_id={} error={error}",
                context.id().as_str(),
            );
        }
    }
}
