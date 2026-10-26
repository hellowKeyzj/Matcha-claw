use super::*;

variant!(world_protocol::evaluation::EvaluationFailure, EvaluationFailure; units [OracleUnavailable, BasisChanged, EpochChanged, Cancelled, ExecutionFailed, InternalFault]; tuples []; records [BadCase { test_case_id } => EvaluationFailureBadCase, SchemaMismatch { expected } => EvaluationFailureSchemaMismatch, SourceMissing { source_id } => EvaluationFailureSourceMissing, BudgetExhausted { dimension } => EvaluationFailureBudgetExhausted, Commit { failure } => EvaluationFailureCommit]);
variant!(world_protocol::evaluation::EvaluationSummaryFailure, EvaluationSummaryFailure; units [BadCase, OracleUnavailable, SchemaMismatch, SourceMissing, BasisChanged, EpochChanged, Cancelled, ExecutionFailed, Commit, InternalFault]; tuples []; records [BudgetExhausted { dimension } => EvaluationSummaryFailureBudgetExhausted]);

record!(world_protocol::evaluation::SuiteRef, SuiteRef; world, id, revision);
record!(world_protocol::evaluation::TestBranch, TestBranch; branch, suite, budget);
