use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::ActualImpact, definitions::{Definition, DefinitionBody, Scope}, evaluation::{EvaluationArm, SuiteRef},
    expression::{ExpressionIr, Parameter}, ids::*, query::{QueryArgument, QueryFailure, QueryIr, QueryRequest, ReadMode},
    releases::{BranchRef, Release}, time::Timestamp, value::Cell,
};
use crate::{authorization::Admission, evaluation::{FrozenArmModel, FrozenArmPlan}, extensions::invocation::CallBudget,
    sources::sync::BranchCapture, store::{WorldSnapshot, WorldTransaction}};
use super::{QueryError, branch};

/// A durable locator and exact digest seal, never an execution capability.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FrozenRead {
    evaluation: EvaluationId, suite: SuiteRef, suite_digest: Digest, artifact_digest: Digest, model_digest: Digest,
}
impl FrozenRead {
    fn new(model: &FrozenArmModel) -> Self {
        Self { evaluation: model.evaluation().clone(), suite: model.suite().clone(), suite_digest: model.suite_digest().clone(),
            artifact_digest: model.artifact_digest().clone(), model_digest: model.model_digest().clone() }
    }
}
fn failure(error: crate::evaluation::Error) -> QueryError {
    let error = crate::owner::Error::from(error);
    let failure = match &error.safe_failure().details {
        world_protocol::api::ApiFailure::Query(value) => world_protocol::process::HostFailure::Query(value.clone()),
        world_protocol::api::ApiFailure::Authorization(value) => world_protocol::process::HostFailure::Authorization(value.clone()),
        world_protocol::api::ApiFailure::Operation(value) => world_protocol::process::HostFailure::Operation(value.clone()),
        _ => world_protocol::process::HostFailure::InternalFault,
    };
    QueryError::Invocation { failure, cause: Box::new(error) }
}
async fn release(
    tx: &WorldTransaction<'_>, reference: &BranchRef, definitions: &[Definition<DefinitionBody>], scopes: &[Scope], lock: &ActivationLockId,
) -> Result<Release, QueryError> {
    if reference.world != *tx.world() { return Err(QueryFailure::BasisChanged.into()); }
    let branch = crate::releases::read_branch_revision(tx, reference).await?.ok_or(QueryFailure::BasisChanged)?;
    let mut release = crate::releases::read_release(tx, &branch.basis.release_id).await?.ok_or(QueryFailure::BasisChanged)?;
    install(&mut release, reference, definitions, scopes, lock);
    Ok(release)
}
fn install(release: &mut Release, reference: &BranchRef, definitions: &[Definition<DefinitionBody>], scopes: &[Scope], lock: &ActivationLockId) {
    release.definitions = definitions.to_vec(); release.scopes = scopes.to_vec();
    release.artifact.activation_lock_id = lock.clone(); release.source_branch = Some(reference.clone());
}
pub(super) async fn model(tx: &WorldTransaction<'_>, model: &FrozenArmModel) -> Result<Release, QueryError> {
    release(tx, model.branch(), model.definitions(), model.scopes(), &model.conditions().tool_lock).await
}
pub(crate) async fn preview_model(tx: &WorldTransaction<'_>, model: &FrozenArmPlan) -> Result<Release, QueryError> {
    release(tx, model.branch(), model.definitions(), model.scopes(), &model.conditions().tool_lock).await
}
async fn sealed_plan(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, seal: &FrozenRead) -> Result<FrozenArmPlan, QueryError> {
    let current = crate::evaluation::frozen_arm_plan(tx, &seal.evaluation, branch, arm).await.map_err(failure)?;
    if current.suite() != &seal.suite || current.suite_digest() != &seal.suite_digest || current.artifact_digest() != &seal.artifact_digest || current.model_digest() != &seal.model_digest { return Err(QueryFailure::BasisChanged.into()); }
    Ok(current)
}
pub(super) async fn reload_plan(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, seal: &FrozenRead) -> Result<Release, QueryError> {
    preview_model(tx, &sealed_plan(tx, branch, arm, seal).await?).await
}
pub(super) async fn inline_definitions(tx: &WorldTransaction<'_>, branch: &BranchRef, arm: &EvaluationArm, seal: &FrozenRead) -> Result<Vec<DefinitionRef>, QueryError> {
    crate::evaluation::frozen_inline_definitions(tx, &sealed_plan(tx, branch, arm, seal).await?).await.map_err(failure)
}
pub(super) async fn reload_plan_snapshot(snapshot: &WorldSnapshot<'_>, branch: &BranchRef, arm: &EvaluationArm, seal: &FrozenRead) -> Result<Release, QueryError> {
    let current = crate::evaluation::frozen_arm_plan_snapshot(snapshot, &seal.evaluation, branch, arm).await.map_err(failure)?;
    if current.suite() != &seal.suite || current.suite_digest() != &seal.suite_digest || current.artifact_digest() != &seal.artifact_digest || current.model_digest() != &seal.model_digest { return Err(QueryFailure::BasisChanged.into()); }
    let branch_record = crate::releases::read_branch_revision_snapshot(snapshot, branch).await?.ok_or(QueryFailure::BasisChanged)?;
    let mut release = crate::releases::read_release_snapshot(snapshot, &branch_record.basis.release_id).await?.ok_or(QueryFailure::BasisChanged)?;
    install(&mut release, branch, current.definitions(), current.scopes(), &current.conditions().tool_lock);
    Ok(release)
}

pub(crate) async fn preview_query_impact(tx: &WorldTransaction<'_>, model: &FrozenArmPlan, query: &QueryIr, _arguments: &[QueryArgument], scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let release = preview_model(tx, model).await?; branch::query_impact_in_model(tx, model.branch(), &release, query, scope).await
}
pub(crate) async fn preview_query_captures(tx: &WorldTransaction<'_>, model: &FrozenArmPlan, query: &QueryIr) -> Result<Vec<BranchCapture>, QueryError> {
    let release = preview_model(tx, model).await?; branch::query_captures_in_model(tx, model.branch(), &release, query).await
}
pub(crate) async fn preview_expression_impact(tx: &WorldTransaction<'_>, model: &FrozenArmPlan, declarations: &[Parameter], expressions: &[&ExpressionIr], scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let release = preview_model(tx, model).await?; branch::expression_impact_in_model(tx, model.branch(), &release, declarations, expressions, scope).await
}
pub(crate) async fn preview_expression_captures(tx: &WorldTransaction<'_>, model: &FrozenArmPlan, declarations: &[Parameter], expressions: &[&ExpressionIr]) -> Result<Vec<BranchCapture>, QueryError> {
    let release = preview_model(tx, model).await?; branch::expression_captures_in_model(tx, model.branch(), &release, declarations, expressions).await
}
pub(crate) async fn preview_action_impact(tx: &WorldTransaction<'_>, model: &FrozenArmPlan, contract: &DefinitionRef, scope: &ScopeId) -> Result<ActualImpact, QueryError> {
    let release = preview_model(tx, model).await?;
    let (declarations, expressions) = branch::action_inputs(&release, contract)?;
    branch::expression_impact_in_model(tx, model.branch(), &release, declarations, &expressions, scope).await
}
pub(crate) async fn preview_action_captures(tx: &WorldTransaction<'_>, model: &FrozenArmPlan, contract: &DefinitionRef) -> Result<Vec<BranchCapture>, QueryError> {
    let release = preview_model(tx, model).await?;
    let (declarations, expressions) = branch::action_inputs(&release, contract)?;
    branch::expression_captures_in_model(tx, model.branch(), &release, declarations, &expressions).await
}
pub(crate) async fn frozen_query(tx: &WorldTransaction<'_>, admission: &Admission, model: &FrozenArmModel, request: &QueryRequest, scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp) -> Result<super::PreparedQuery, QueryError> {
    branch::execute_in_model(tx, admission, model.branch(), model.arm(), self::model(tx, model).await?, Some(FrozenRead::new(model)), request, scope, budget, cancel, at).await
}
pub(crate) async fn frozen_expression_context_cells(tx: &WorldTransaction<'_>, admission: &Admission, model: &FrozenArmModel, declarations: &[Parameter], parameters: &std::collections::BTreeMap<ParameterId, Cell>, expressions: &[&ExpressionIr], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<super::current::CurrentEvaluation, QueryError> {
    branch::expression_context_in_model(tx, admission, model.branch(), model.arm(), self::model(tx, model).await?, Some(FrozenRead::new(model)), None, declarations, parameters, expressions, scope, budget, cancel, at, read_mode, known_at).await
}
pub(crate) async fn frozen_action_dry_run(tx: &WorldTransaction<'_>, admission: &Admission, model: &FrozenArmModel, contract: &DefinitionRef, arguments: &[QueryArgument], scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken, at: &Timestamp, read_mode: &ReadMode, known_at: Option<&Timestamp>) -> Result<branch::BranchActionPreview, QueryError> {
    branch::action_in_model(tx, admission, model.branch(), model.arm(), self::model(tx, model).await?, Some(FrozenRead::new(model)), contract, arguments, scope, budget, cancel, at, read_mode, known_at).await
}
