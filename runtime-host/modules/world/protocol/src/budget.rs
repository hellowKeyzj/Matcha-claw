use crate::{
    time::{DurationMs, Timestamp},
    value::{Currency, Decimal},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub max_wall_time: DurationMs,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_steps: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_source_reads: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_rows: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_bytes: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_model_calls: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_input_tokens: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_output_tokens: u64,
    pub max_cost: Option<Cost>,
    pub deadline: Option<Timestamp>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cost {
    pub amount: Decimal,
    pub currency: Currency,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub elapsed: DurationMs,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub steps: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub source_reads: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub rows: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub bytes: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub model_calls: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub input_tokens: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub output_tokens: u64,
    pub cost: Option<Cost>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BudgetDimension {
    WallTime,
    Steps,
    SourceReads,
    Rows,
    Bytes,
    ModelCalls,
    InputTokens,
    OutputTokens,
    Cost,
    Deadline,
}
