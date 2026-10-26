use std::{future::Future, pin::Pin};

use foundation::pipeline::PipelineContext;
use world_protocol::{
    actions::{ActionFailure, SourceReceipt, VerificationReceipt},
    authorization::Decision,
    budget::Usage,
    evaluation::{BranchBasis, EvaluationArm, EvaluationConditions, EvaluationFailure, HardCheck},
    failure::Failure,
    ids::ActorId,
    learning::{Case, OracleSpec, TaskContract},
    materials::BlobRef,
    time::DurationMs,
    value::Decimal,
};

use super::{CandidateInput, Error};

pub(crate) type EvaluationFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;

/// Implemented by the actual exact-lock/current-authorization execution owner.
/// This boundary has no answer, oracle, Permit, generic payload, or self-reported score.
pub(crate) trait BranchExecution: Send + Sync {
    fn unsettled(&self) -> bool;

    fn run_arm<'a>(
        &'a self,
        input: CandidateInput<'a>,
        basis: &'a BranchBasis,
        arm: &'a EvaluationArm,
        conditions: &'a EvaluationConditions,
        pipeline: &'a PipelineContext,
    ) -> EvaluationFuture<'a, ExecutedCase>;

    /// Separate trusted verifier invocation; only this side receives expected bytes.
    fn check_program<'a>(
        &'a self,
        oracle: &'a OracleSpec,
        expected: &'a [u8],
        observed: &'a ExecutedCase,
        task: &'a TaskContract,
        pipeline: &'a PipelineContext,
    ) -> EvaluationFuture<'a, OracleResult>;

    fn check_human<'a>(
        &'a self,
        oracle: &'a OracleSpec,
        observed: &'a ExecutedCase,
        pipeline: &'a PipelineContext,
    ) -> EvaluationFuture<'a, HumanVerification>;
}

pub(crate) struct ExecutedCase {
    pub case: Case,
    pub witness: super::ExecutionWitness,
    pub observed: BlobRef,
    pub usage: Usage,
    pub budget: crate::extensions::invocation::CallBudget,
    pub recording: crate::authorization::Admission,
    pub hard_checks: Vec<HardCheck>,
    pub business_failure: Option<Failure<ActionFailure>>,
    pub implementations: Vec<world_protocol::bindings::ImplementationRef>,
    pub source_verification: Option<(SourceReceipt, VerificationReceipt)>,
}

pub(crate) struct HumanVerification {
    pub actor: ActorId,
    pub decision: Decision,
    pub passed: bool,
    pub observed_digest: world_protocol::ids::Digest,
}

/// Measurements must be produced by independent verification of observable
/// results. Missing measurements stay unavailable; they are never filled with zero.
pub(crate) struct OracleResult {
    pub custody: Option<BlobRef>,
    pub passed: bool,
    pub usage: Usage,
    pub hard_checks: Vec<HardCheck>,
    pub measurements: Option<Measurements>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Measurements {
    pub dangerous_effects: Option<u64>,
    pub error_merges: Option<u64>,
    pub identity_decisions: Option<u64>,
    pub evidence_satisfied: Option<u64>,
    pub evidence_required: Option<u64>,
    pub conflicts_detected: Option<u64>,
    pub conflicts_present: Option<u64>,
    pub retraction_lag: Option<DurationMs>,
    pub active_complexity: Option<u64>,
    pub migration_cost: Option<Decimal>,
}

pub(crate) fn dependency_missing() -> Error {
    Error::DependencyMissing {
        capability: "branch_execution",
    }
}

impl From<EvaluationFailure> for Error {
    fn from(failure: EvaluationFailure) -> Self {
        Self::Evaluation(failure)
    }
}
