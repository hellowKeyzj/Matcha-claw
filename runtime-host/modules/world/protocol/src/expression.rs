use crate::{
    ids::*,
    time::{DurationMs, ValidTime},
    value::{Value, ValueType},
};
use serde::{Deserialize, Serialize};

/// Closed, bounded expression language. Calls resolve exact registered function revisions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExpressionIr {
    Literal {
        value: Value,
    },
    Parameter {
        id: ParameterId,
    },
    Field {
        subject: SymbolId,
        property: DefinitionRef,
    },
    Role {
        relation: SymbolId,
        role: RoleId,
    },
    Unary {
        operator: UnaryOperator,
        operand: Box<ExpressionIr>,
    },
    Binary {
        operator: BinaryOperator,
        left: Box<ExpressionIr>,
        right: Box<ExpressionIr>,
    },
    All {
        terms: Vec<ExpressionIr>,
    },
    Any {
        terms: Vec<ExpressionIr>,
    },
    If {
        condition: Box<ExpressionIr>,
        then_value: Box<ExpressionIr>,
        else_value: Box<ExpressionIr>,
    },
    Call {
        function: DefinitionRef,
        arguments: Vec<ExpressionIr>,
    },
    Aggregate {
        operator: AggregateOperator,
        collection: SymbolId,
        expression: Box<ExpressionIr>,
        window: Option<TimeWindow>,
    },
    IsNull {
        operand: Box<ExpressionIr>,
    },
    IsKnown {
        operand: Box<ExpressionIr>,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnaryOperator {
    Not,
    Negate,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
/// Divide is exact under the checked target decimal precision/scale; it never rounds implicitly.
pub enum BinaryOperator {
    Equal,
    NotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    Add,
    Subtract,
    Multiply,
    Divide,
    Contains,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AggregateOperator {
    Count,
    Sum,
    Minimum,
    Maximum,
    Average,
    Any,
    All,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimeWindow {
    Fixed {
        interval: ValidTime,
    },
    Sliding {
        width: DurationMs,
        timestamp_property: DefinitionRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub id: ParameterId,
    pub value_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
}
#[derive(
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Pure,
    SourceRead,
    ClockRead,
    Probabilistic,
    ExternalWrite,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypedExpression {
    pub expression: ExpressionIr,
    pub result_type: ValueType,
    pub nullable: bool,
    pub effects: Vec<Effect>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TruthValue {
    True,
    False,
    Unknown,
    Conflicted,
    SourceUnavailable,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExpressionFailure {
    DivisionByZero {
        field: crate::failure::FieldPath,
    },
    NonTerminatingDecimal {
        field: crate::failure::FieldPath,
    },
    Overflow {
        field: crate::failure::FieldPath,
    },
    PrecisionExceeded {
        field: crate::failure::FieldPath,
        precision: u16,
        scale: u16,
    },
    InvalidOperand {
        field: crate::failure::FieldPath,
    },
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    InternalFault,
}
