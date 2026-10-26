use super::*;

record!(world_protocol::expression::Parameter, Parameter; id, value_type, nullable, optional);
unit_enum!(world_protocol::expression::Effect, Effect; Pure, SourceRead, ClockRead, Probabilistic, ExternalWrite);
unit_enum!(world_protocol::expression::TruthValue, TruthValue; True, False, Unknown, Conflicted, SourceUnavailable);
variant!(world_protocol::expression::ExpressionFailure, ExpressionFailure; units [Cancelled, InternalFault]; tuples []; records [DivisionByZero { field } => ExpressionFailureDivisionByZero, NonTerminatingDecimal { field } => ExpressionFailureNonTerminatingDecimal, Overflow { field } => ExpressionFailureOverflow, PrecisionExceeded { field, precision, scale } => ExpressionFailurePrecisionExceeded, InvalidOperand { field } => ExpressionFailureInvalidOperand, BudgetExceeded { dimension } => ExpressionFailureBudgetExceeded]);
