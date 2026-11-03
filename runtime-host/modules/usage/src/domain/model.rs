#[derive(Clone, Debug, PartialEq)]
pub struct UsageEntry {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageHistory {
    pub entries: Vec<UsageEntry>,
    pub coverage: UsageCoverage,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UsageCoverage {
    Reported,
    Observed {
        #[serde(rename = "hasMore")]
        has_more: bool,
        #[serde(rename = "nativeOutcomeUnknown")]
        native_outcome_unknown: bool,
        #[serde(rename = "unknownEntries")]
        unknown_entries: Vec<UsageUnknownEntry>,
    },
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageUnknownEntry {
    pub session_id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub reason: UsageUnknownReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageUnknownReason {
    NativeResultSessionMismatch,
    NativeResultIdentityMissing,
    NativeExecutionErrorPlaceholder,
    NativeUsageScopeUnknown,
    NativeUsageMissingOrInvalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageReadError {
    Unavailable,
}
