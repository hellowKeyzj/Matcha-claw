use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use foundation::pipeline::PipelineContext;

use serde::{Deserialize, Serialize};
use world_protocol::{
    abstraction::AbstractionContract,
    authorization::{AccessMode, AccessScope},
    budget::BudgetDimension,
    compiler::ExpressionAnnotation,
    definitions::{Definition, DefinitionBody, Scope},
    evaluation::{BranchBasis, EvaluationArm, EvaluationFailure},
    expression::{ExpressionIr, Parameter, TruthValue},
    failure::{FailureStage, FieldPath},
    ids::{
        CandidateId, CaseId, DefinitionRef, Digest, EvaluationId, ParameterId, ResourceRef,
        Revision, TestCaseId,
    },
    learning::{
        Case, CaseInconclusive, CaseOrigin, CaseOutcome, StopReason,
        StrategyOperation, StrategyStep, TaskRef,
    },
    materials::BlobRef,
    releases::{BranchRef, WorldBranch},
    value::{Cell, Value, ValueType},
};

use super::{CandidateInput, ConstraintFailure, Error, records};
use crate::{
    authorization::{self, Admission, EvaluationAuthority, EvaluationBinding},
    content::{Content, ContentOwner},
    extensions::{
        invocation::{CallBudget, InvocationContext, invoke_composition},
        lifecycle::LiveExtensions,
    },
    store::{CommitRequest, StoreFuture, WorldStore, WorldTransaction},
};
pub(crate) use world_protocol::evaluation::{PlanReference, PlanSelection};
use crate::abstraction::strategy::{ActionPreview, OperationExecution, StepObservation, StepOutput, StrategyBackend, StrategyFuture};

/// Only the execution producer in this module can mint this value. Deserialization
/// is for the evaluation owner's immutable accepted-result records, not ingress.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionWitness {
    evaluation_id: EvaluationId,
    candidate_id: CandidateId,
    task: TaskRef,
    branch: BranchRef,
    compile_digest: Digest,
    model_digest: Digest,
    basis_digest: Digest,
    requested_plan_digest: Digest,
    plan_digest: Digest,
    expansion: Option<crate::abstraction::ConcreteWitness>,
    test_id: TestCaseId,
    test_revision: Revision,
    fixture: BlobRef,
    run_id: world_protocol::ids::RunId,
    step_id: world_protocol::ids::StepId,
    input_digest: Digest,
    arm: EvaluationArm,
    observed: BlobRef,
    case_id: CaseId,
    case_digest: Digest,
    captures: Vec<(DefinitionRef, Digest)>,
    source_versions: Vec<world_protocol::materials::SourceVersionRef>,
    authority: ArmAuthority,
}

impl ExecutionWitness {
    fn mint(
        input: &CandidateInput<'_>,
        basis: &BranchBasis,
        arm: &EvaluationArm,
        requested_plan_digest: Digest,
        plan_digest: Digest,
        expansion: Option<crate::abstraction::ConcreteWitness>,
        observed: &BlobRef,
        case: &Case,
        captures: Vec<(DefinitionRef, Digest)>,
        source_versions: Vec<world_protocol::materials::SourceVersionRef>,
        authority: ArmAuthority,
    ) -> Result<Self, Error> {
        Ok(Self {
            evaluation_id: input.evaluation_id.clone(),
            candidate_id: input.candidate_id.clone(),
            task: TaskRef {
                world: input.world.clone(),
                id: input.task_id.clone(),
                revision: input.task_revision,
            },
            branch: input.branch.clone(),
            compile_digest: input.compile_digest.clone(),
            model_digest: input.model_digest.clone(),
            basis_digest: records::digest(basis)?,
            requested_plan_digest,
            plan_digest,
            expansion,
            test_id: input.test_id.clone(),
            test_revision: input.test_revision,
            fixture: input.fixture.clone(),
            run_id: input.run_id.clone(),
            step_id: input.step_id.clone(),
            input_digest: records::digest(input.input)?,
            arm: arm.clone(),
            observed: observed.clone(),
            case_id: case.id.clone(),
            case_digest: records::digest(case)?,
            captures,
            source_versions,
            authority,
        })
    }

    pub(crate) fn validate(
        &self,
        input: &CandidateInput<'_>,
        basis: &BranchBasis,
        arm: &EvaluationArm,
        observed: &BlobRef,
        case: &Case,
    ) -> Result<(), Error> {
        if self.evaluation_id != *input.evaluation_id
            || self.candidate_id != *input.candidate_id
            || self.task.world != *input.world
            || self.task.id != *input.task_id
            || self.task.revision != input.task_revision
            || self.branch != *input.branch
            || self.compile_digest != *input.compile_digest
            || self.model_digest != *input.model_digest
            || self.basis_digest != records::digest(basis)?
            || self.test_id != *input.test_id
            || self.test_revision != input.test_revision
            || self.fixture != *input.fixture
            || self.run_id != *input.run_id
            || self.step_id != *input.step_id
            || self.input_digest != records::digest(input.input)?
            || self.arm != *arm
            || self.observed != *observed
            || self.case_id != case.id
            || self.case_digest != records::digest(case)?
            || match &self.expansion {
                None => self.requested_plan_digest != self.plan_digest,
                Some(expansion) => expansion.plan_digest != self.plan_digest || expansion.reason == TruthValue::True
                    || expansion.task_digest != records::digest(&(&self.task, input.goal, input.input_type, input.hard_constraints, input.allowed_effects, input.stop_conditions, input.budget))?
                    || expansion.read_receipts.iter().any(|receipt| !case.read_receipts.contains(receipt)),
            }
            || case.world != *input.world
            || case.task_id != *input.task_id
            || case.task_revision != input.task_revision
            || case.input != *input.input
            || case.origin_family != *input.origin_family
            || case.release_id != basis.release_id
            || case.activation_lock_id != basis.activation_lock_id
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(())
    }

    pub(crate) fn matches_plan(&self, plan: &Digest) -> bool {
        self.expansion.is_none() && &self.plan_digest == plan && &self.requested_plan_digest == plan
    }

    pub(super) fn require_frozen_plan(&self, plan: &super::FrozenArmPlan) -> Result<(), Error> {
        if &self.evaluation_id != plan.evaluation() || &self.branch != plan.branch() || &self.arm != plan.arm()
            || &self.authority.suite != plan.suite() || &self.authority.suite_digest != plan.suite_digest()
            || &self.authority.artifact_digest != plan.artifact_digest() || &self.authority.model_digest != plan.model_digest()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(())
    }
}

/// Assurance and report IDs are deliberately excluded: verifying a plan must not
/// change its identity merely by attaching the resulting evaluation report.
pub(crate) fn abstraction_plan_digest(contract: &AbstractionContract) -> Result<Digest, Error> {
    records::digest(&(
        "world.abstraction.execution-plan.v1",
        &contract.world,
        &contract.candidate_id,
        &contract.branch,
        (&contract.task_id, contract.task_revision),
        &contract.base_release,
        &contract.scope,
        &contract.original_definitions,
        &contract.strategy,
        &contract.applicable_actions,
        &contract.parameters,
        &contract.forward_plan,
        &contract.guard,
        (
            &contract.assumptions,
            &contract.preserved_invariants,
            &contract.slots,
            &contract.binding_map,
            &contract.read_dependencies,
            &contract.fallback,
        ),
    ))
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct ArmAuthority {
    suite: world_protocol::evaluation::SuiteRef,
    suite_digest: Digest,
    artifact_digest: Digest,
    model_digest: Digest,
}

impl ArmAuthority {
    fn require(&self, model: &super::FrozenArmModel) -> Result<(), Error> {
        if &self.suite != model.suite() || &self.suite_digest != model.suite_digest()
            || &self.artifact_digest != model.artifact_digest() || &self.model_digest != model.model_digest()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Plan {
    arm: EvaluationArm,
    source: PlanReference,
    authority: ArmAuthority,
    digest: Digest,
    owner: DefinitionRef,
    parameters: Vec<Parameter>,
    steps: Vec<StrategyStep>,
    guards: Vec<(ExpressionIr, Vec<String>)>,
    annotations: Vec<ExpressionAnnotation>,
    definitions: Vec<Definition<DefinitionBody>>,
    scopes: Vec<Scope>,
    budget: Option<world_protocol::budget::Budget>,
    abstraction: Option<AbstractionContract>,
    concrete: Option<crate::abstraction::ConcreteStrategy>,
}

pub(super) async fn validate_suite_plans(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    suite: &world_protocol::evaluation::FrozenSuite,
    task_scope: &world_protocol::ids::ScopeId,
) -> Result<(), Error> {
    super::frozen_plan::require_common_tools(&suite.plans, &branch.compile)?;
    for selection in &suite.plans {
        prepare_plan(tx, branch, suite, selection.clone(), task_scope).await?;
    }
    Ok(())
}

async fn prepare_plan(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    suite: &world_protocol::evaluation::FrozenSuite,
    selection: PlanSelection,
    task_scope: &world_protocol::ids::ScopeId,
) -> Result<Plan, Error> {
    let baseline = !matches!(
        &selection.arm,
        EvaluationArm::Candidate | EvaluationArm::Ablation { .. }
    );
    let (mut model, model_scopes) = match &selection.plan {
        PlanReference::Frozen(plan) => {
            super::frozen_plan::validate_shape(tx.world(), &selection.arm, plan)?;
            (plan.definitions.clone(), plan.scopes.clone())
        }
        _ if !baseline => (branch.compile.definitions.clone(), branch.compile.scopes.clone()),
        _ => return Err(super::invalid("plan.baseline.frozen").into()),
    };
    let scopes = model_scopes.as_slice();
    let source = selection.plan.clone();
    if let EvaluationArm::Ablation {
        disabled_definitions,
    } = &selection.arm
    {
        if disabled_definitions.iter().any(|reference| {
            !model
                .iter()
                .any(|definition| &definition.reference == reference)
        }) {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        model.retain(|definition| !disabled_definitions.contains(&definition.reference));
    }
    let definitions = &model;
    let mut abstraction = None;
    let (owner, parameters, steps, guards, plan_digest, budget) = match selection.plan {
        PlanReference::Frozen(plan) => {
            let owner = definitions.iter().find(|definition| definition.reference == plan.strategy)
                .ok_or(EvaluationFailure::BasisChanged)?;
            let DefinitionBody::Strategy(strategy) = &owner.body else {
                return Err(super::invalid("plan.strategy").into());
            };
            (
                owner,
                strategy.parameters.clone(),
                strategy.steps.clone(),
                vec![(strategy.guard.clone(), vec!["guard".into()])],
                records::digest(&("world.frozen-strategy.execution-plan.v1", &plan, &suite.conditions))?,
                Some(strategy.budget.clone()),
            )
        }
        PlanReference::Strategy(reference) => {
            let owner = definitions
                .iter()
                .find(|definition| definition.reference == reference)
                .ok_or(EvaluationFailure::BasisChanged)?;
            let DefinitionBody::Strategy(strategy) = &owner.body else {
                return Err(super::invalid("plan.strategy").into());
            };
            (
                owner,
                strategy.parameters.clone(),
                strategy.steps.clone(),
                vec![(strategy.guard.clone(), vec!["guard".into()])],
                records::digest(&(
                    "world.strategy.execution-plan.v1",
                    &owner.reference,
                    &owner.content_digest,
                    &owner.body,
                ))?,
                Some(strategy.budget.clone()),
            )
        }
        PlanReference::Abstraction { id, revision } => {
            if baseline {
                return Err(super::invalid("plan.baseline.abstraction").into());
            }
            let contract = crate::abstraction::read(tx, &id, revision)
                .await?
                .ok_or(EvaluationFailure::BasisChanged)?;
            if &contract.scope != task_scope {
                return Err(EvaluationFailure::BasisChanged.into());
            }
            crate::abstraction::require_branch(tx, &contract, branch).await?;
            let checked = crate::abstraction::check_contract(&contract, definitions, scopes)?;
            let owner = definitions.iter().find(|definition| definition.reference == checked.owner)
                .ok_or(EvaluationFailure::BasisChanged)?;
            let mut guards = vec![(contract.guard.clone(), vec!["guard".into()])];
            for (name, items) in [
                ("assumptions", &contract.assumptions),
                ("preservedInvariants", &contract.preserved_invariants),
            ] {
                guards.extend(items.iter().enumerate().map(|(index, expression)| {
                    (expression.clone(), vec![name.into(), index.to_string()])
                }));
            }
            let digest = abstraction_plan_digest(&contract)?;
            abstraction = Some(contract.clone());
            (
                owner,
                contract.parameters,
                contract.forward_plan,
                guards,
                digest,
                None,
            )
        }
    };
    let mut annotations =
        crate::compiler::check_plan(&steps, owner, definitions, scopes, &parameters)
            .map_err(Error::Compile)?;
    for (guard, path) in &guards {
        annotations.extend(
            crate::compiler::check_guard(
                guard,
                owner,
                definitions,
                scopes,
                &parameters,
                &world_protocol::failure::FieldPath(path.clone()),
            )
            .map_err(Error::Compile)?,
        );
    }
    let mut compile = branch.compile.clone();
    compile.definitions = definitions.clone();
    compile.scopes = scopes.to_vec();
    crate::compiler::validate_structure(&compile).map_err(Error::Compile)?;
    Ok(Plan {
        arm: selection.arm,
        authority: ArmAuthority {
            suite: world_protocol::evaluation::SuiteRef { world: suite.world.clone(), id: suite.id.clone(), revision: suite.revision },
            suite_digest: records::digest(suite)?,
            artifact_digest: records::digest(&("world.frozen-arm.v1", &source, &suite.conditions))?,
            model_digest: crate::compiler::model_digest(&compile).map_err(Error::Compile)?,
        },
        source,
        digest: plan_digest,
        owner: owner.reference.clone(),
        parameters,
        steps,
        guards,
        annotations,
        definitions: definitions.clone(),
        scopes: scopes.to_vec(),
        budget,
        concrete: abstraction.as_ref().map(|contract| crate::abstraction::concrete_strategy(contract, definitions, scopes)).transpose()?.flatten(),
        abstraction,
    })
}

impl Plan {
    fn require_preview(&self, model: &super::FrozenArmPlan) -> Result<(), Error> {
        if &self.authority.suite != model.suite() || &self.authority.suite_digest != model.suite_digest()
            || &self.authority.artifact_digest != model.artifact_digest() || &self.authority.model_digest != model.model_digest()
            || &self.arm != model.arm() || &self.source != model.plan()
            || self.definitions != model.definitions() || self.scopes != model.scopes()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(())
    }

    fn require_model(&self, model: &super::FrozenArmModel) -> Result<(), Error> {
        self.authority.require(model)?;
        if &self.arm != model.arm() || &self.source != model.plan()
            || self.definitions != model.definitions() || self.scopes != model.scopes()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(())
    }

    fn concrete_plan(&self, strategy: &crate::abstraction::ConcreteStrategy) -> Self {
        Self {
            arm: self.arm.clone(), source: self.source.clone(), authority: self.authority.clone(),
            digest: strategy.digest.clone(), owner: strategy.owner.clone(),
            parameters: strategy.parameters.clone(), steps: strategy.steps.clone(), guards: strategy.guards.clone(),
            annotations: strategy.annotations.clone(), definitions: self.definitions.clone(), scopes: self.scopes.clone(),
            budget: Some(strategy.budget.clone()), abstraction: None, concrete: None,
        }
    }
}

pub(crate) struct FiniteBranchExecution {
    store: Arc<WorldStore>,
    content: Arc<Content>,
    authority: EvaluationAuthority,
    commits: CommitRequest,
    live: Arc<LiveExtensions>,
    services: crate::owner::InvocationServiceSeed,
    generation: Arc<dyn crate::generation::WorldGeneration>,
    root: CallBudget,
    oracle_invocations: Mutex<BTreeSet<world_protocol::ids::InvocationId>>,
    access: world_protocol::materials::AccessPolicyRef,
    retention: world_protocol::sources::RetentionPolicy,
    evaluation_id: EvaluationId,
    candidate_id: CandidateId,
    task: TaskRef,
    scope: world_protocol::ids::ScopeId,
    suite_id: world_protocol::ids::SuiteId,
    suite_revision: Revision,
    run_id: world_protocol::ids::RunId,
    branch: WorldBranch,
    branch_ref: BranchRef,
    compile_digest: Digest,
    model_digest: Digest,
    conditions: world_protocol::evaluation::EvaluationConditions,
    plans: Vec<Plan>,
}

/// Frozen preparation is part of the transaction result, so replay reconstructs
/// the same adapter without exporting live capabilities through a side channel.
#[derive(Serialize, Deserialize)]
pub(crate) struct PreparedExecution {
    oracle_invocations: BTreeSet<world_protocol::ids::InvocationId>,
    evaluation_id: EvaluationId,
    candidate_id: CandidateId,
    task: TaskRef,
    scope: world_protocol::ids::ScopeId,
    suite_id: world_protocol::ids::SuiteId,
    suite_revision: Revision,
    run_id: world_protocol::ids::RunId,
    branch: WorldBranch,
    branch_ref: BranchRef,
    compile_digest: Digest,
    model_digest: Digest,
    conditions: world_protocol::evaluation::EvaluationConditions,
    plans: Vec<Plan>,
}

impl FiniteBranchExecution {
    pub(crate) async fn prepare(
        tx: &WorldTransaction<'_>,
        state: &super::EvaluationRun,
    ) -> Result<PreparedExecution, Error> {
        let branch = crate::releases::read_branch_revision(tx, &state.branch)
            .await
            .map_err(|error| Error::Release(Box::new(error)))?
            .ok_or(EvaluationFailure::BasisChanged)?;
        if tx.world() != &state.request.world
            || branch.candidate_id != state.request.candidate_id
            || branch.basis != state.request.basis
            || branch.status != world_protocol::learning::ChangeStatus::Testing
            || state.compile_digest != records::digest(&branch.compile)?
            || state.model_digest
                != crate::compiler::model_digest(&branch.compile).map_err(Error::Compile)?
            || state.request.suite.plans.len() != state.request.suite.arms.len()
            || state.request.suite.plans.iter().any(|selection| {
                state
                    .request
                    .suite
                    .plans
                    .iter()
                    .filter(|other| other.arm == selection.arm)
                    .count()
                    != 1
                    || !state.request.suite.arms.contains(&selection.arm)
            })
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let task = records::task(
            tx,
            &state.request.suite.task_id,
            state.request.suite.task_revision,
        )
        .await?;
        let mut plans = Vec::new();
        for selection in &state.request.suite.plans {
            let plan = prepare_plan(tx, &branch, &state.request.suite, selection.clone(), &task.scope).await?;
            plans.push(plan);
        }
        let mut oracle_invocations = BTreeSet::new();
        for row in tx.query("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='world.evaluation.oracle_custody' ORDER BY ordinal", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &state.run.id.as_str()]).await? {
            let step: crate::owner::StepRecord = serde_json::from_value(row.get("body"))
                .map_err(|error| Error::Owner(crate::owner::Error::internal(FailureStage::Read).caused(error)))?;
            let invocation = oracle_invocation(tx, &step).await?;
            if invocation.binding.run_id != state.run.id || invocation.binding.evaluation_id != state.request.id
                || invocation.binding.branch != state.branch || invocation.binding.task.world != *tx.world() {
                return Err(EvaluationFailure::BasisChanged.into());
            }
            oracle_invocations.insert(invocation.invocation_id);
        }
        Ok(PreparedExecution {
            oracle_invocations,
            evaluation_id: state.request.id.clone(),
            candidate_id: state.request.candidate_id.clone(),
            task: TaskRef {
                world: task.world,
                id: task.id,
                revision: task.revision,
            },
            scope: task.scope,
            suite_id: state.request.suite.id.clone(),
            suite_revision: state.request.suite.revision,
            run_id: state.run.id.clone(),
            branch,
            branch_ref: state.branch.clone(),
            compile_digest: state.compile_digest.clone(),
            model_digest: state.model_digest.clone(),
            conditions: state.request.suite.conditions.clone(),
            plans,
        })
    }

    pub(crate) fn new(
        prepared: PreparedExecution,
        store: Arc<WorldStore>,
        content: Arc<Content>,
        authority: EvaluationAuthority,
        commits: CommitRequest,
        live: Arc<LiveExtensions>,
        services: crate::owner::InvocationServiceSeed,
        generation: Arc<dyn crate::generation::WorldGeneration>,
        root: CallBudget,
    ) -> Result<Self, Error> {
        if content.world() != &prepared.task.world
            || authority.world() != &prepared.task.world
            || commits.world != prepared.task.world
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let (access, retention) = authority.case_policies();
        let (access, retention) = (access.clone(), retention.clone());
        Ok(Self {
            store,
            content,
            authority,
            commits,
            live,
            services,
            generation,
            root,
            oracle_invocations: Mutex::new(prepared.oracle_invocations),
            access,
            retention,
            evaluation_id: prepared.evaluation_id,
            candidate_id: prepared.candidate_id,
            task: prepared.task,
            scope: prepared.scope,
            suite_id: prepared.suite_id,
            suite_revision: prepared.suite_revision,
            run_id: prepared.run_id,
            branch: prepared.branch,
            branch_ref: prepared.branch_ref,
            compile_digest: prepared.compile_digest,
            model_digest: prepared.model_digest,
            conditions: prepared.conditions,
            plans: prepared.plans,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trace {
    requested_plan: Digest,
    plan: Digest,
    expansion: Option<crate::abstraction::ConcreteWitness>,
    branch: BranchRef,
    compile_digest: Digest,
    model_digest: Digest,
    authority: ArmAuthority,
    arm: EvaluationArm,
    steps: Vec<StepObservation>,
    constraints: Vec<(
        world_protocol::failure::FieldPath,
        world_protocol::expression::TruthValue,
    )>,
    stop: Option<world_protocol::learning::StopReason>,
    read_receipts: Vec<world_protocol::query::ReadReceipt>,
    bindings: Option<crate::abstraction::BindingExecution>,
    expanded_bindings: Option<crate::abstraction::BindingExecution>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OracleInvocation {
    binding: EvaluationBinding,
    oracle: world_protocol::learning::OracleSpec,
    observed: BlobRef,
    fixture: BlobRef,
    scope: world_protocol::ids::ScopeId,
    activation_lock: world_protocol::ids::ActivationLockId,
    graph_digest: Digest,
    invocation_id: world_protocol::ids::InvocationId,
    root: world_protocol::ids::NodeId,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OracleCustody {
    invocation: OracleInvocation,
    retained: BlobRef,
    roots: crate::store::RetentionRoots,
}

/// A record field is mapped only to an explicitly declared ParameterId with the
/// exact schema. No scalar-to-first-parameter or slot-name convention exists.
fn fixture_parameters(
    input: &CandidateInput<'_>,
    parameters: &[Parameter],
) -> Result<BTreeMap<ParameterId, Cell>, Error> {
    let (Value::Record { fields: values }, ValueType::Record { fields: schema }) =
        (input.input, input.input_type)
    else {
        return Err(super::invalid("fixture.input.record").into());
    };
    crate::definitions::validate_value(input.input_type, false, input.input)
        .map_err(|failure| ConstraintFailure::Definition { failure })?;
    let mut seen = BTreeSet::new();
    let mut result = BTreeMap::new();
    for parameter in parameters {
        if !seen.insert(&parameter.id) {
            return Err(ConstraintFailure::Duplicate.into());
        }
        let field = schema
            .iter()
            .find(|field| field.name == parameter.id.as_str())
            .ok_or_else(|| super::invalid("fixture.parameter.schema"))?;
        if field.value_type != parameter.value_type
            || field.nullable != parameter.nullable
            || field.optional != parameter.optional
        {
            return Err(super::invalid("fixture.parameter.schema").into());
        }
        let cell = match values.get(parameter.id.as_str()) {
            Some(value) => Cell::Known {
                value: value.clone(),
            },
            None if parameter.optional => Cell::Unknown {
                reason: world_protocol::value::UnknownReason::NotObserved,
            },
            None => return Err(super::invalid("fixture.parameter.required").into()),
        };
        result.insert(parameter.id.clone(), cell);
    }
    Ok(result)
}

fn fixture_concrete(
    input: &CandidateInput<'_>,
    parameters: &[Parameter],
) -> Result<BTreeMap<ParameterId, Cell>, Error> {
    let (Value::Record { fields: values }, ValueType::Record { fields: schema }) =
        (input.input, input.input_type)
    else {
        return Err(super::invalid("fixture.input.record").into());
    };
    crate::definitions::validate_value(input.input_type, false, input.input)
        .map_err(|failure| ConstraintFailure::Definition { failure })?;
    let mut concrete = BTreeMap::new();
    for parameter in parameters {
        let Some(field) = schema
            .iter()
            .find(|field| field.name == parameter.id.as_str())
        else {
            continue;
        };
        if field.value_type != parameter.value_type
            || field.nullable != parameter.nullable
            || field.optional != parameter.optional
        {
            return Err(super::invalid("fixture.parameter.schema").into());
        }
        let cell = match values.get(parameter.id.as_str()) {
            Some(value) => Cell::Known {
                value: value.clone(),
            },
            None if parameter.optional => Cell::Unknown {
                reason: world_protocol::value::UnknownReason::NotObserved,
            },
            None => return Err(super::invalid("fixture.parameter.required").into()),
        };
        concrete.insert(parameter.id.clone(), cell);
    }
    Ok(concrete)
}

fn query_arguments(
    query: &world_protocol::query::QueryIr,
    declarations: &[Parameter],
    parameters: &BTreeMap<ParameterId, Cell>,
) -> Result<Vec<world_protocol::query::QueryArgument>, Error> {
    let mut selected = BTreeMap::new();
    for parameter in &query.parameters {
        if !declarations.iter().any(|declared| declared == parameter) {
            return Err(super::invalid("plan.query.parameters").into());
        }
        let cell = parameters
            .get(&parameter.id)
            .ok_or_else(|| super::invalid("plan.query.parameters"))?;
        if !matches!(cell, Cell::Known { .. }) && !parameter.optional {
            return Err(super::invalid("plan.query.parameter.unavailable").into());
        }
        selected.insert(parameter.id.clone(), cell.clone());
    }
    Ok(fixture_arguments(&selected))
}

fn fixture_arguments(
    parameters: &BTreeMap<ParameterId, Cell>,
) -> Vec<world_protocol::query::QueryArgument> {
    parameters
        .iter()
        .filter_map(|(id, cell)| match cell {
            Cell::Known { value } => Some(world_protocol::query::QueryArgument {
                parameter_id: id.clone(),
                value: value.clone(),
            }),
            _ => None,
        })
        .collect()
}

fn execution_expressions(plan: &Plan, input: &CandidateInput<'_>) -> Vec<ExpressionIr> {
    plan_expressions(plan, input.hard_constraints, input.stop_conditions)
}

fn plan_expressions(plan: &Plan, hard_constraints: &[ExpressionIr], stop_conditions: &[ExpressionIr]) -> Vec<ExpressionIr> {
    let mut expressions: Vec<_> = plan
        .guards
        .iter()
        .map(|(expression, _)| expression.clone())
        .collect();
    if let Some(contract) = &plan.abstraction {
        expressions.extend(
            crate::abstraction::binding_expressions(contract)
                .into_iter()
                .cloned(),
        );
    }
    expressions.extend_from_slice(hard_constraints);
    expressions.extend_from_slice(stop_conditions);
    for step in &plan.steps {
        expressions.push(step.guard.clone());
        if let StrategyOperation::Function {
            function,
            arguments,
        } = &step.operation
        {
            expressions.push(ExpressionIr::Call {
                function: function.clone(),
                arguments: arguments.clone(),
            });
        }
    }
    expressions
}

fn require_epochs(
    admission: &Admission,
    conditions: &world_protocol::evaluation::EvaluationConditions,
) -> Result<(), Error> {
    if admission.decision().policy_epoch != conditions.policy_epoch
        || admission.decision().grant_epoch != conditions.grant_epoch
    {
        return Err(EvaluationFailure::EpochChanged.into());
    }
    Ok(())
}

fn budget_failure(error: crate::extensions::invocation::BudgetFailure) -> Error {
    EvaluationFailure::BudgetExhausted {
        dimension: error.dimension,
    }
    .into()
}

impl FiniteBranchExecution {
    fn binding(
        &self,
        input: &CandidateInput<'_>,
        arm: &EvaluationArm,
    ) -> Result<EvaluationBinding, Error> {
        let test = world_protocol::evaluation::TestRevision {
            id: input.test_id.clone(),
            revision: input.test_revision,
        };
        Ok(EvaluationBinding {
            evaluation_id: self.evaluation_id.clone(),
            candidate_id: self.candidate_id.clone(),
            branch: self.branch_ref.clone(),
            task: self.task.clone(),
            arm: arm.clone(),
            case_id: super::execution_case_id(input.world, input.evaluation_id, &test, arm)?,
            test,
            run_id: input.run_id.clone(),
            step_id: input.step_id.clone(),
        })
    }

    fn commit(&self, binding: &EvaluationBinding, stage: &str) -> Result<CommitRequest, Error> {
        let mut request = self.commits.clone();
        let digest = records::digest(&(&self.commits.commit_id, binding, stage))?;
        request.commit_id =
            world_protocol::ids::CommitId::try_new(format!("eval-{}", &digest.as_str()[7..]))
                .map_err(|_| EvaluationFailure::InternalFault)?;
        request.input_digest = records::digest(&(binding, stage))?;
        Ok(request)
    }

    fn admit_execution<'f>(
        &'f self,
        binding: &'f EvaluationBinding,
        plan: &'f Plan,
        input: &'f CandidateInput<'_>,
    ) -> StoreFuture<'f, (Admission, CallBudget, Vec<(DefinitionRef, Digest)>), Error> {
        Box::pin(async move {
            let mut admitted_plan = plan.clone();
            if let Some(concrete) = &plan.concrete {
                admitted_plan.steps.extend(concrete.steps.clone());
                admitted_plan.guards.extend(concrete.guards.clone());
            }
            let plan = &admitted_plan;
            let request = self.commit(binding, "execution.admit")?;
            let authority = self.authority.clone();
            let binding = binding.clone();
            let scope = self.scope.clone();
            let owner = plan.owner.clone();
            let definitions = plan.definitions.clone();
            let frozen_plan = plan.clone();
            let branch = self.branch_ref.clone();
            let arm = plan.arm.clone();
            let declarations = plan.parameters.clone();
            let abstraction = plan.abstraction.clone();
            let branch_expressions = execution_expressions(plan, input);
            let queries = plan
                .steps
                .iter()
                .filter_map(|step| match &step.operation {
                    StrategyOperation::Query { query } => Some(query.clone()),
                    _ => None,
                })
                .map(|query| {
                    let arguments = if abstraction.is_some() {
                        Vec::new()
                    } else {
                        fixture_arguments(&fixture_parameters(input, &query.parameters)?)
                    };
                    Ok((query, arguments))
                })
                .collect::<Result<Vec<_>, Error>>()?;
            let actions: Vec<_> = plan
                .steps
                .iter()
                .filter_map(|step| match &step.operation {
                    StrategyOperation::Action { action, .. } => Some(action.clone()),
                    _ => None,
                })
                .collect();
            let conditions = self.conditions.clone();
            let mut needed = vec![owner.clone()];
            let concrete_owner = plan.concrete.as_ref().map(|strategy| strategy.owner.clone());
            needed.extend(concrete_owner.iter().cloned());
            if let Some(contract) = &abstraction {
                needed.extend(contract.original_definitions.clone());
                needed.extend(contract.applicable_actions.clone());
                for binding in &contract.binding_map.bindings {
                    if let world_protocol::abstraction::BindingTarget::Property { definition }
                    | world_protocol::abstraction::BindingTarget::Action { definition } =
                        &binding.target
                    {
                        needed.push(definition.clone());
                    }
                }
                for expression in crate::abstraction::binding_expressions(contract) {
                    needed.extend(crate::definitions::expression_references(expression));
                }
            }
            let mut expressions: Vec<_> = plan
                .guards
                .iter()
                .map(|(expression, _)| expression)
                .collect();
            expressions.extend(input.hard_constraints);
            expressions.extend(input.stop_conditions);
            for step in &plan.steps {
                expressions.push(&step.guard);
                match &step.operation {
                    StrategyOperation::Function {
                        function,
                        arguments,
                    } => {
                        needed.push(function.clone());
                        expressions.extend(arguments);
                    }
                    StrategyOperation::Query { query } => {
                        needed.extend(crate::definitions::query_references(query))
                    }
                    StrategyOperation::Action { action, .. } => needed.push(action.clone()),
                    StrategyOperation::Stop { .. } => {}
                }
            }
            for expression in expressions {
                needed.extend(crate::definitions::expression_references(expression));
            }
            needed.sort();
            needed.dedup();
            let outcome = authorization::commit_admission(&self.store, request.prepare()?, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    let bounds = super::require_execution_binding(tx, &binding, &now).await?;
                    let preview = super::frozen_arm_plan(tx, &binding.evaluation_id, &branch, &arm).await?;
                    frozen_plan.require_preview(&preview)?;
                    let mut cursor = 0;
                    while cursor < needed.len() {
                        let definition = definitions
                            .iter()
                            .find(|definition| definition.reference == needed[cursor])
                            .ok_or(EvaluationFailure::BasisChanged)?;
                        for reference in definition
                            .dependencies
                            .iter()
                            .chain(&crate::definitions::definition_references(&definition.body))
                        {
                            if !needed.contains(reference) {
                                needed.push(reference.clone());
                            }
                        }
                        cursor += 1;
                    }
                    let mut access = vec![AccessScope {
                        resources: vec![ResourceRef::Branch {
                            id: binding.branch.id.clone(),
                        }],
                        fields: Vec::new(),
                        modes: vec![AccessMode::Read],
                        scope: scope.clone(),
                        valid_time: None,
                    }];
                    let mut labels = Vec::new();
                    let current = crate::releases::read_active_model(tx)
                        .await?
                        .ok_or(EvaluationFailure::BasisChanged)?;
                    for reference in needed {
                        let definition = definitions
                            .iter()
                            .find(|definition| definition.reference == reference)
                            .ok_or(EvaluationFailure::BasisChanged)?;
                        for item in std::iter::once(definition).chain(
                            current
                                .definitions
                                .iter()
                                .filter(|item| item.reference.id == reference.id),
                        ) {
                            if let DefinitionBody::Property(property) = &item.body {
                                labels.extend(property.access_labels.clone());
                            }
                            access.push(AccessScope {
                                resources: vec![ResourceRef::Definition {
                                    id: reference.id.clone(),
                                }],
                                fields: Vec::new(),
                                modes: vec![AccessMode::Read],
                                scope: item.scope.clone(),
                                valid_time: None,
                            });
                        }
                    }
                    access.push(AccessScope {
                        resources: vec![ResourceRef::Definition { id: owner.id }],
                        fields: Vec::new(),
                        modes: vec![AccessMode::Execute],
                        scope: scope.clone(),
                        valid_time: None,
                    });
                    if let Some(concrete) = concrete_owner {
                        access.push(AccessScope { resources: vec![ResourceRef::Definition { id: concrete.id }], fields: Vec::new(), modes: vec![AccessMode::Execute], scope: scope.clone(), valid_time: None });
                    }
                    let refs: Vec<_> = branch_expressions.iter().collect();
                    let mut captures = crate::query::preview_expression_captures(
                        tx, &preview, &declarations, &refs,
                    ).await?;
                    let mut impacts = vec![
                        super::frozen_model_impact(tx, &binding.evaluation_id, &branch, &arm).await?,
                        crate::query::preview_expression_impact(
                            tx, &preview, &declarations, &refs, &scope,
                        ).await?,
                    ];
                    for (query, arguments) in &queries {
                        captures.extend(
                            crate::query::preview_query_captures(tx, &preview, query).await?,
                        );
                        impacts.push(
                            crate::query::preview_query_impact(
                                tx, &preview, query, arguments, &scope,
                            ).await?,
                        );
                    }
                    for action in &actions {
                        captures.extend(
                            crate::query::preview_action_captures(tx, &preview, action).await?,
                        );
                        impacts.push(
                            crate::query::preview_action_impact(tx, &preview, action, &scope).await?,
                        );
                    }
                    if let Some(contract) = &abstraction {
                        let (impact, required) = crate::abstraction::branch_binding_impact(
                            tx, &branch, &arm, contract, &now,
                        )
                        .await?;
                        impacts.push(impact);
                        captures.extend(required);
                    }
                    for impact in &impacts {
                        access.extend(impact.access.clone());
                        labels.extend(impact.labels.clone());
                    }
                    let impact = authorization::actual_impact(
                        access,
                        vec![world_protocol::expression::Effect::Pure],
                        labels,
                        impacts
                            .iter()
                            .flat_map(|impact| impact.state.clone())
                            .collect(),
                        impacts
                            .iter()
                            .flat_map(|impact| impact.source_ids.clone())
                            .collect(),
                    )?;
                    let admission = authority.execution(tx, &binding, &impact, &now).await?;
                    require_epochs(&admission, &conditions)?;
                    let frozen = super::frozen_arm_model(tx, &admission, &binding.evaluation_id, &branch, &arm).await?;
                    frozen_plan.require_model(&frozen)?;
                    let captures: BTreeSet<_> = captures
                        .iter()
                        .map(|capture| {
                            (
                                capture.capture().binding.clone(),
                                capture.capture().digest.clone(),
                            )
                        })
                        .collect();
                    Ok::<_, Error>((
                        (bounds.budget, now, captures.into_iter().collect::<Vec<_>>()),
                        admission,
                    ))
                })
            })
            .await;
            match admission_result(outcome)? {
                ((limit, now, captures), admission) => {
                    self.root.restrict(&limit, &now).map_err(budget_failure)?;
                    Ok((admission, self.root.clone(), captures))
                }
            }
        })
    }

    fn verify_captures<'f>(
        &'f self,
        admission: &'f Admission,
        captures: &'f [(DefinitionRef, Digest)],
        budget: &'f CallBudget,
        cancellation: &'f tokio_util::sync::CancellationToken,
    ) -> StoreFuture<'f, Vec<world_protocol::materials::SourceVersionRef>, Error> {
        Box::pin(async move {
            let mut versions = Vec::new();
            for (binding, digest) in captures {
                let branch = self.branch_ref.clone();
                let binding = binding.clone();
                let auth = admission.clone();
                let capture = self
                    .store
                    .snapshot(self.task.world.clone(), move |snapshot| {
                        Box::pin(async move {
                            authorization::recheck_read(snapshot, &auth, &snapshot.now().await?)
                                .await?;
                            crate::sources::sync::read_branch_capture_snapshot(
                                snapshot, &branch, &binding,
                            )
                            .await
                            .map_err(|error| Error::Owner(error.into()))?
                            .ok_or_else(|| Error::from(EvaluationFailure::BasisChanged))
                        })
                    })
                    .await?;
                if &capture.capture().digest != digest {
                    return Err(EvaluationFailure::BasisChanged.into());
                }
                crate::sources::sync::verify_branch_capture(
                    &self.store,
                    &self.content,
                    admission,
                    &capture,
                    budget,
                    cancellation,
                )
                .await
                .map_err(|error| Error::Owner(error.into()))?;
                if !versions.contains(&capture.capture().source_version) {
                    versions.push(capture.capture().source_version.clone());
                }
            }
            Ok(versions)
        })
    }

    async fn current(&self, admission: &Admission) -> Result<(), Error> {
        let admission = admission.clone();
        self.store
            .snapshot(self.task.world.clone(), move |snapshot| {
                Box::pin(async move {
                    authorization::recheck_read(snapshot, &admission, &snapshot.now().await?)
                        .await?;
                    Ok::<_, Error>(())
                })
            })
            .await
    }

    async fn retain_trace(
        &self,
        binding: &EvaluationBinding,
        bytes: &[u8],
        execution: &Admission,
        pipeline: &PipelineContext,
    ) -> Result<(BlobRef, Admission), Error> {
        if execution
            .impact()
            .labels
            .iter()
            .any(|label| !self.access.labels.contains(label))
        {
            return Err(crate::authorization::AuthError::from(
                world_protocol::authorization::AuthorizationFailure::InsufficientScope,
            )
            .into());
        }
        let mut request = self.commit(binding, "execution.trace")?;
        request.input_digest =
            records::digest(&(binding, "execution.trace", raw_digest(bytes)?, bytes.len()))?;
        let batch = request.prepare()?;
        let execution = execution.clone();
        let conditions = self.conditions.clone();
        let prepared = Arc::new(self.content.prepare_blob(
            &mut std::io::Cursor::new(bytes),
            None,
            &pipeline.cancellation(),
        )?);
        let blob = prepared.reference().clone();
        let content = self.content.clone();
        let retained = prepared.clone();
        let authority = self.authority.clone();
        let binding_for_record = binding.clone();
        let scope = self.scope.clone();
        let labels = self.access.labels.clone();
        let result = authorization::commit_admission(&self.store, batch, move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                authorization::check_admitted_output(tx, &execution, execution.impact(), 1, &now)
                    .await?;
                let impact = authorization::actual_impact(
                    vec![AccessScope {
                        resources: vec![ResourceRef::Case {
                            id: binding_for_record.case_id.clone(),
                        }],
                        fields: Vec::new(),
                        modes: vec![AccessMode::Write],
                        scope,
                        valid_time: None,
                    }],
                    Vec::new(),
                    labels,
                    Vec::new(),
                    Vec::new(),
                )?;
                let recording = authority
                    .recording(tx, &binding_for_record, &impact, &now)
                    .await?;
                require_epochs(&recording, &conditions)?;
                content
                    .retain_prepared(
                        tx,
                        &retained,
                        ContentOwner::Case {
                            id: binding_for_record.case_id,
                        },
                    )
                    .await?;
                Ok::<_, Error>(((), recording))
            })
        })
        .await;
        // The private stage can be removed even after an indeterminate COMMIT;
        // the content owner only discards this stage, never the shared blob.
        let discarded = self
            .content
            .discard_prepared(&prepared)
            .map_err(Error::from);
        let (_, recording) = preserve_cleanup(admission_result(result), discarded)?;
        Ok((blob, recording))
    }
}

fn preserve_cleanup<T>(primary: Result<T, Error>, cleanup: Result<(), Error>) -> Result<T, Error> {
    match (primary, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(cleanup)) => Err(Error::Owner(
            crate::owner::Error::from(primary).with_related(cleanup.into()),
        )),
    }
}

fn admission_result<T>(
    result: Result<authorization::AdmissionCommit<T>, crate::store::TransactionError<Error>>,
) -> Result<(T, Admission), Error> {
    match result {
        Ok(authorization::AdmissionCommit::Committed { outcome, admission }) => {
            Ok((outcome.value, admission))
        }
        // A durable claim/admission cannot be replayed into another execution.
        Ok(authorization::AdmissionCommit::Replayed(_)) => {
            Err(EvaluationFailure::ExecutionFailed.into())
        }
        Err(crate::store::TransactionError::NotCommitted {
            error,
            cleanup: None,
        }) => Err(error),
        Err(crate::store::TransactionError::NotCommitted {
            error,
            cleanup: Some(cleanup),
        }) => Err(Error::Rollback {
            error: Box::new(error),
            cleanup,
        }),
        Err(crate::store::TransactionError::Indeterminate(error)) => Err(error.into()),
    }
}

struct FiniteStrategyBackend<'a, 'tx> {
    tx: &'a mut WorldTransaction<'tx>,
    admission: &'a Admission,
    model: &'a super::FrozenArmModel,
    branch: &'a BranchRef,
    scope: &'a world_protocol::ids::ScopeId,
    budget: &'a CallBudget,
    cancellation: &'a tokio_util::sync::CancellationToken,
    context: &'a crate::query::BranchExpressionContext,
    queries: &'a BTreeMap<usize, Vec<world_protocol::query::QueryArgument>>,
    at: &'a world_protocol::time::Timestamp,
    read_mode: &'a world_protocol::query::ReadMode,
    known_at: &'a world_protocol::time::Timestamp,
}

impl StrategyBackend for FiniteStrategyBackend<'_, '_> {
    fn value(&mut self, expression: &ExpressionIr, path: &FieldPath) -> Result<Cell, Error> {
        Ok(self.context.value(expression, &path.0, self.at)?)
    }

    fn current(&mut self) -> StrategyFuture<'_, Vec<world_protocol::query::ReadReceipt>> {
        Box::pin(async move {
            authorization::recheck(self.tx, self.admission, &self.tx.now().await?).await?;
            Ok(Vec::new())
        })
    }

    fn operation<'a>(&'a mut self, index: usize, step: &'a StrategyStep) -> StrategyFuture<'a, OperationExecution> {
        Box::pin(async move {
            let mut read_receipts = Vec::new();
            let mut used_definitions = Vec::new();
            let output = match &step.operation {
                StrategyOperation::Function { function, arguments } => {
                    let expression = ExpressionIr::Call { function: function.clone(), arguments: arguments.clone() };
                    used_definitions.extend(crate::definitions::expression_references(&expression));
                    StepOutput::Function(self.value(&expression, &FieldPath(vec!["steps".into(), index.to_string(), "operation".into()]))?)
                }
                StrategyOperation::Stop { reason } => StepOutput::Stop(*reason),
                StrategyOperation::Query { query } => {
                    let request = world_protocol::query::QueryRequest {
                        world: self.branch.world.clone(), branch_id: Some(self.branch.id.clone()), release_id: None,
                        query: query.clone(), arguments: self.queries.get(&index).cloned().ok_or(EvaluationFailure::InternalFault)?,
                        read_mode: self.read_mode.clone(), valid_at: Some(self.at.clone()), known_at: Some(self.known_at.clone()),
                        page: world_protocol::query::PageRequest { limit: query.limit.min(world_protocol::api::MAX_PAGE_ITEMS), cursor: None },
                    };
                    let prepared = crate::query::frozen_query(self.tx, self.admission, self.model, &request,
                        self.scope, self.budget, self.cancellation, self.at).await?;
                    let page = crate::query::commit_read(self.tx, self.admission, prepared).await?;
                    used_definitions.extend(crate::definitions::query_references(query));
                    read_receipts.push(page.receipt.clone());
                    StepOutput::Query(page)
                }
                StrategyOperation::Action { action, arguments } => {
                    let preview = crate::query::frozen_action_dry_run(self.tx, self.admission, self.model,
                        action, arguments, self.scope, self.budget, self.cancellation, self.at, self.read_mode, Some(self.known_at)).await?;
                    used_definitions.push(action.clone());
                    read_receipts.extend(preview.read_receipt);
                    StepOutput::ActionDryRun(ActionPreview { action: preview.action, operation: preview.operation,
                        preconditions: preview.preconditions, keys: preview.keys, values: preview.values, expected: preview.expected })
                }
            };
            Ok(OperationExecution { output, read_receipts, used_definitions, outcome: None, completed: true })
        })
    }
}

impl FiniteBranchExecution {
    async fn execute_arm(
        &self,
        input: CandidateInput<'_>,
        basis: &BranchBasis,
        arm: &EvaluationArm,
        conditions: &world_protocol::evaluation::EvaluationConditions,
        pipeline: &PipelineContext,
    ) -> Result<super::ExecutedCase, Error> {
        let started = std::time::Instant::now();
        if input.world != &self.task.world
            || input.evaluation_id != &self.evaluation_id
            || input.candidate_id != &self.candidate_id
            || input.task_id != &self.task.id
            || input.task_revision != self.task.revision
            || input.run_id != &self.run_id
            || input.branch != &self.branch_ref
            || input.compile_digest != &self.compile_digest
            || input.model_digest != &self.model_digest
            || basis != &self.branch.basis
            || conditions != &self.conditions
            || pipeline.run_id() != self.run_id.as_str()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let plan = self
            .plans
            .iter()
            .find(|plan| &plan.arm == arm)
            .ok_or(EvaluationFailure::BasisChanged)?;
        let owner = plan
            .definitions
            .iter()
            .find(|definition| definition.reference == plan.owner)
            .ok_or(EvaluationFailure::BasisChanged)?;
        let mut annotations = plan.annotations.clone();
        for (name, expressions) in [
            ("hardConstraints", input.hard_constraints),
            ("stopConditions", input.stop_conditions),
        ] {
            for (index, expression) in expressions.iter().enumerate() {
                annotations.extend(
                    crate::compiler::check_guard(
                        expression,
                        owner,
                        &plan.definitions,
                        &plan.scopes,
                        &plan.parameters,
                        &FieldPath(vec![name.into(), index.to_string()]),
                    )
                    .map_err(Error::Compile)?,
                );
            }
        }
        let parameters = if plan.abstraction.is_some() {
            fixture_concrete(&input, &plan.parameters)?
        } else {
            fixture_parameters(&input, &plan.parameters)?
        };
        let binding = self.binding(&input, arm)?;
        let (admission, root, captures) = self.admit_execution(&binding, plan, &input).await?;
        let now = super::accounting::now();
        let budget = root.scoped(input.budget, &now).map_err(budget_failure)?;
        if let Some(limit) = &plan.budget {
            budget.restrict(limit, &now).map_err(budget_failure)?;
        }
        let source_versions = self
            .verify_captures(&admission, &captures, &budget, &pipeline.cancellation())
            .await?;
        let mut fixture_queries = BTreeMap::new();
        if plan.abstraction.is_none() {
            for (index, step) in plan.steps.iter().enumerate() {
                if let StrategyOperation::Query { query } = &step.operation {
                    fixture_queries.insert(index, fixture_arguments(&fixture_parameters(&input, &query.parameters)?));
                }
            }
        }
        let expressions = execution_expressions(plan, &input);
        let goal = input.goal.to_owned();
        let input_type = input.input_type.clone();
        let allowed_effects = input.allowed_effects.to_vec();
        let task_budget = input.budget.clone();
        let hard_constraints = input.hard_constraints.to_vec();
        let stop_conditions = input.stop_conditions.to_vec();
        let invariants = plan.abstraction.as_ref().map(|contract| contract.preserved_invariants.clone()).unwrap_or_default();
        let plan = plan.clone();
        let branch = self.branch_ref.clone();
        let scope = self.scope.clone();
        let compile_digest = self.compile_digest.clone();
        let model_digest = self.model_digest.clone();
        let transaction_binding = binding.clone();
        let execution_admission = admission.clone();
        let execution_budget = budget.clone();
        let cancellation = pipeline.cancellation();
        let valid_at = conditions.valid_at.clone();
        let known_at = conditions.known_at.clone();
        let read_mode = conditions.read_mode.clone();
        let request = self.commit(&binding, "execution.plan")?;
        let committed = self
            .store
            .transact(request.prepare()?, move |tx| {
                Box::pin(async move {
                    let binding = transaction_binding;
                    let admission = execution_admission;
                    let budget = execution_budget;
                    super::require_execution_binding(tx, &binding, &tx.now().await?).await?;
                    let frozen = super::frozen_arm_model(
                        tx, &admission, &binding.evaluation_id, &branch, &plan.arm,
                    ).await?;
                    plan.require_model(&frozen)?;
                    let requested_plan = plan.digest.clone();
                    let requested_owner = plan.owner.clone();
                    let mut plan = plan;
                    let mut bindings = if let Some(contract) = &plan.abstraction {
                        Some(
                            crate::abstraction::execute_bindings(
                                tx,
                                &admission,
                                &branch,
                                &plan.arm,
                                contract,
                                &parameters,
                                &budget,
                                &cancellation,
                                &valid_at,
                                &read_mode,
                                Some(&known_at),
                            )
                            .await?,
                        )
                    } else {
                        None
                    };
                    let fixture = parameters;
                    let mut parameters = bindings.as_ref().map_or_else(|| fixture.clone(), |mapping| {
                        if mapping.reason == TruthValue::True { mapping.parameters.clone() } else { mapping.concrete_parameters.clone() }
                    });
                    let refs: Vec<_> = expressions.iter().collect();
                    let mut context = crate::query::frozen_expression_context_cells(
                        tx, &admission, &frozen, &plan.parameters, &parameters, &refs,
                        &scope, &budget, &cancellation, &valid_at, &read_mode, Some(&known_at),
                    ).await?;
                    context.annotations = annotations;
                    let mut read_receipts: Vec<_> = context.read_receipt.take().into_iter().collect();
                    let mut constraints = Vec::new();
                    let mut expansion = None;
                    let mut expanded_bindings = None;
                    let mut fallback_outcome = None;
                    let abstraction_guards_checked = plan.abstraction.is_some();
                    if let Some(contract) = plan.abstraction.clone() {
                        let mut reason = bindings.as_ref().ok_or(EvaluationFailure::InternalFault)?.reason;
                        if reason == TruthValue::True {
                            for (expression, path) in &plan.guards {
                                let truth = crate::query::truth_value(&context.value(expression, path, &valid_at)?)?;
                                constraints.push((FieldPath(path.clone()), truth));
                                if truth != TruthValue::True { reason = truth; break; }
                            }
                        }
                        if reason != TruthValue::True {
                            let mapping = bindings.as_mut().ok_or(EvaluationFailure::InternalFault)?;
                            mapping.reason = reason;
                            mapping.fallback = Some(contract.fallback.clone());
                            match &contract.fallback {
                                world_protocol::abstraction::Fallback::ExpandConcrete { .. } => {
                                    authorization::recheck(tx, &admission, &tx.now().await?).await?;
                                    let mut fresh = crate::abstraction::execute_bindings(
                                        tx, &admission, &branch, &plan.arm, &contract, &fixture,
                                        &budget, &cancellation, &valid_at, &read_mode, Some(&known_at),
                                    ).await?;
                                    let concrete = plan.concrete.as_ref().ok_or(EvaluationFailure::BasisChanged)?;
                                    let concrete_plan = plan.concrete_plan(concrete);
                                    let expressions = plan_expressions(&concrete_plan, &hard_constraints, &stop_conditions);
                                    let refs: Vec<_> = expressions.iter().collect();
                                    parameters = fresh.concrete_parameters.clone();
                                    context = crate::query::frozen_expression_context_cells(
                                        tx, &admission, &frozen, &concrete_plan.parameters, &parameters,
                                        &refs, &scope, &budget, &cancellation, &valid_at, &read_mode, Some(&known_at),
                                    ).await?;
                                    let mut fresh_receipts = std::mem::take(&mut fresh.read_receipts);
                                    fresh_receipts.extend(context.read_receipt.take());
                                    let checked = crate::abstraction::replan_concrete(
                                        &contract,
                                        &crate::abstraction::ConcreteTask { reference: binding.task.clone(), goal: &goal, input_type: &input_type,
                                            hard_constraints: &hard_constraints, allowed_effects: &allowed_effects, stop_conditions: &stop_conditions, budget: &task_budget },
                                        &plan.definitions, &plan.scopes, &context, fresh_receipts.clone(), reason,
                                        &tx.now().await?, &budget, &cancellation,
                                    )?;
                                    context.annotations = checked.strategy.annotations.clone();
                                    plan = plan.concrete_plan(&checked.strategy);
                                    read_receipts.extend(fresh_receipts);
                                    expansion = Some(checked.witness);
                                    expanded_bindings = Some(fresh);
                                }
                                world_protocol::abstraction::Fallback::RequestEvidence { .. } => {
                                    fallback_outcome = Some(CaseOutcome::Inconclusive { reason: CaseInconclusive::Stopped {
                                        field: FieldPath(vec!["fallback".into()]), reason: StopReason::EvidenceRequired,
                                    }});
                                }
                                world_protocol::abstraction::Fallback::Stop => {
                                    fallback_outcome = Some(CaseOutcome::Inconclusive { reason: CaseInconclusive::GuardNotSatisfied {
                                        field: FieldPath(vec!["fallback".into()]), truth: reason,
                                    }});
                                }
                            }
                        }
                    }
                    let mut queries = BTreeMap::new();
                    if fallback_outcome.is_none() {
                        for (index, step) in plan.steps.iter().enumerate() {
                            if let StrategyOperation::Query { query } = &step.operation {
                                queries.insert(index, match fixture_queries.get(&index) {
                                    Some(arguments) => arguments.clone(),
                                    None => query_arguments(query, &plan.parameters, &parameters)?,
                                });
                            }
                        }
                    }
                    let mut trace = Trace {
                        requested_plan,
                        plan: plan.digest.clone(),
                        expansion,
                        branch: branch.clone(),
                        compile_digest,
                        model_digest,
                        authority: plan.authority.clone(),
                        arm: plan.arm.clone(),
                        steps: Vec::new(),
                        constraints,
                        stop: match &fallback_outcome {
                            Some(CaseOutcome::Inconclusive { reason: CaseInconclusive::Stopped { reason, .. } }) => Some(*reason),
                            _ => None,
                        },
                        read_receipts,
                        bindings,
                        expanded_bindings,
                    };
                    if let Some(mapping) = &mut trace.bindings {
                        trace.read_receipts.append(&mut mapping.read_receipts);
                    }
                    let mut used = BTreeSet::from([requested_owner, plan.owner.clone()]);
                    for receipt in &trace.read_receipts { used.extend(receipt.actual_dependencies.iter().filter_map(|dependency| match dependency {
                        world_protocol::provenance::ReadDependency::Definition { reference } => Some(reference.clone()), _ => None,
                    })); }
                    let mut execution = crate::abstraction::strategy::StrategyExecution::new(std::mem::take(&mut trace.read_receipts));
                    execution.constraints = std::mem::take(&mut trace.constraints);
                    execution.stop = trace.stop;
                    execution.outcome = fallback_outcome;
                    let guards = if !abstraction_guards_checked || trace.expansion.is_some() { plan.guards.as_slice() } else { &[] };
                    let execution = crate::abstraction::strategy::execute(
                        &mut FiniteStrategyBackend { tx, admission: &admission, model: &frozen, branch: &branch,
                            scope: &scope, budget: &budget, cancellation: &cancellation, context: &context,
                            queries: &queries, at: &valid_at, read_mode: &read_mode, known_at: &known_at },
                        crate::abstraction::strategy::StrategyPlan { steps: &plan.steps, guards, hard_constraints: &hard_constraints,
                            stop_conditions: &stop_conditions, invariants: &invariants, run_id: &binding.run_id, step_id: &binding.step_id },
                        execution, &budget, &cancellation,
                    ).await?;
                    trace.steps = execution.steps;
                    trace.constraints = execution.constraints;
                    trace.stop = execution.stop;
                    trace.read_receipts = execution.read_receipts;
                    let outcome = execution.outcome;
                    let checks = execution.hard_checks;
                    used.extend(execution.used_definitions);
                    let mut used: Vec<_> = used.into_iter().collect();
                    let mut cursor = 0;
                    while cursor < used.len() {
                        let definition = plan
                            .definitions
                            .iter()
                            .find(|definition| definition.reference == used[cursor])
                            .ok_or(EvaluationFailure::BasisChanged)?;
                        for reference in definition
                            .dependencies
                            .iter()
                            .chain(&crate::definitions::definition_references(&definition.body))
                        {
                            if !used.contains(reference) {
                                used.push(reference.clone());
                            }
                        }
                        cursor += 1;
                    }
                    used.sort();
                    authorization::check_admitted_output(
                        tx,
                        &admission,
                        admission.impact(),
                        trace.steps.len() as u64,
                        &tx.now().await?,
                    )
                    .await?;
                    super::require_execution_binding(tx, &binding, &tx.now().await?).await?;
                    Ok::<_, Error>((
                        trace,
                        outcome.ok_or(EvaluationFailure::InternalFault)?,
                        checks,
                        used,
                    ))
                })
            })
            .await;
        let committed = match committed {
            Ok(committed) if !committed.replayed => committed,
            Ok(_) => return Err(EvaluationFailure::ExecutionFailed.into()),
            Err(crate::store::TransactionError::NotCommitted {
                error,
                cleanup: None,
            }) => return Err(error),
            Err(crate::store::TransactionError::NotCommitted {
                error,
                cleanup: Some(cleanup),
            }) => {
                return Err(Error::Rollback {
                    error: Box::new(error),
                    cleanup,
                });
            }
            Err(crate::store::TransactionError::Indeterminate(error)) => return Err(error.into()),
        };
        let (trace, outcome, checks, used_definitions) = committed.value;
        let maximum = usize::try_from(
            budget
                .remaining(BudgetDimension::Bytes)
                .map_err(budget_failure)?,
        )
        .unwrap_or(usize::MAX);
        let bytes = world_protocol::wire::encode(&trace, maximum).map_err(wire_failure)?;
        budget
            .charge(BudgetDimension::Bytes, bytes.len() as u64)
            .map_err(budget_failure)?;
        self.current(&admission).await?;
        let (observed, recording) = self
            .retain_trace(&binding, &bytes, &admission, pipeline)
            .await?;
        let case = Case {
            origin: match input.parent_case_id {
                Some(id) => CaseOrigin::Replay {
                    parent_case_id: id.clone(),
                    basis: basis.clone(),
                },
                None => CaseOrigin::Fixture,
            },
            used_definitions,
            world: input.world.clone(),
            id: binding.case_id.clone(),
            task_id: self.task.id.clone(),
            task_revision: self.task.revision,
            input: input.input.clone(),
            observable_trace: observed.clone(),
            release_id: basis.release_id.clone(),
            activation_lock_id: basis.activation_lock_id.clone(),
            model_binding: conditions.model_binding.clone(),
            read_receipts: trace.read_receipts.clone(),
            source_receipts: Vec::new(),
            evidence: Vec::new(),
            outcome,
            origin_family: input.origin_family.clone(),
            occurred_at: super::accounting::now(),
            access: self.access.clone(),
            retention: self.retention.clone(),
        };
        let witness = ExecutionWitness::mint(
            &input,
            basis,
            arm,
            trace.requested_plan.clone(),
            trace.plan.clone(),
            trace.expansion.clone(),
            &observed,
            &case,
            captures,
            source_versions,
            trace.authority.clone(),
        )?;
        let mut usage = budget.scope_usage();
        usage.elapsed = world_protocol::time::DurationMs(
            u64::try_from(started.elapsed().as_millis())
                .map_err(|_| EvaluationFailure::InternalFault)?,
        );
        Ok(super::ExecutedCase {
            case,
            witness,
            observed,
            usage,
            budget: root,
            recording,
            hard_checks: checks,
            business_failure: None,
            implementations: Vec::new(),
            source_verification: None,
        })
    }
}

impl super::BranchExecution for FiniteBranchExecution {
    fn unsettled(&self) -> bool {
        self.oracle_invocations
            .lock()
            .expect("evaluation invocation custody poisoned")
            .iter()
            .any(|id| self.live.invocation_unsettled(&self.task.world, id))
    }

    fn run_arm<'a>(
        &'a self,
        input: CandidateInput<'a>,
        basis: &'a BranchBasis,
        arm: &'a EvaluationArm,
        conditions: &'a world_protocol::evaluation::EvaluationConditions,
        pipeline: &'a PipelineContext,
    ) -> super::EvaluationFuture<'a, super::ExecutedCase> {
        Box::pin(self.execute_arm(input, basis, arm, conditions, pipeline))
    }

    fn check_program<'a>(
        &'a self,
        oracle: &'a world_protocol::learning::OracleSpec,
        expected: &'a [u8],
        observed: &'a super::ExecutedCase,
        task: &'a world_protocol::learning::TaskContract,
        pipeline: &'a PipelineContext,
    ) -> super::EvaluationFuture<'a, super::OracleResult> {
        Box::pin(self.program(oracle, expected, observed, task, pipeline))
    }

    fn check_human<'a>(
        &'a self,
        _oracle: &'a world_protocol::learning::OracleSpec,
        _observed: &'a super::ExecutedCase,
        _pipeline: &'a PipelineContext,
    ) -> super::EvaluationFuture<'a, super::HumanVerification> {
        // An authorization allow decision is not a human's observed-result verdict.
        Box::pin(async { Err(ConstraintFailure::OracleUnverified.into()) })
    }
}

impl FiniteBranchExecution {
    fn observed_binding(&self, observed: &super::ExecutedCase) -> Result<EvaluationBinding, Error> {
        let witness = &observed.witness;
        if witness.evaluation_id != self.evaluation_id
            || witness.candidate_id != self.candidate_id
            || witness.task != self.task
            || witness.branch != self.branch_ref
            || witness.compile_digest != self.compile_digest
            || witness.model_digest != self.model_digest
            || witness.basis_digest != records::digest(&self.branch.basis)?
            || witness.run_id != self.run_id
            || witness.observed != observed.observed
            || witness.case_id != observed.case.id
            || witness.case_digest != records::digest(&observed.case)?
            || !self
                .plans
                .iter()
                .any(|plan| plan.arm == witness.arm && plan.digest == witness.requested_plan_digest
                    && plan.authority == witness.authority
                    && match (&plan.concrete, &witness.expansion) {
                        (_, None) => plan.digest == witness.plan_digest,
                        (Some(concrete), Some(expansion)) => concrete.owner == expansion.strategy && concrete.digest == expansion.plan_digest
                            && concrete.digest == witness.plan_digest && expansion.reason != TruthValue::True
                            && expansion.read_receipts.iter().all(|receipt| observed.case.read_receipts.contains(receipt)),
                        _ => false,
                    })
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        Ok(EvaluationBinding {
            evaluation_id: witness.evaluation_id.clone(),
            candidate_id: witness.candidate_id.clone(),
            branch: witness.branch.clone(),
            task: witness.task.clone(),
            arm: witness.arm.clone(),
            test: world_protocol::evaluation::TestRevision {
                id: witness.test_id.clone(),
                revision: witness.test_revision,
            },
            case_id: witness.case_id.clone(),
            run_id: witness.run_id.clone(),
            step_id: witness.step_id.clone(),
        })
    }

    async fn begin_oracle(
        &self,
        admission: &Admission,
        invocation: &OracleInvocation,
        budget: &CallBudget,
    ) -> Result<crate::owner::StepRecord, Error> {
        budget
            .charge(BudgetDimension::Steps, 1)
            .map_err(budget_failure)?;
        let input_digest = records::digest(invocation)?;
        let step_id = world_protocol::ids::StepId::try_new(format!(
            "oracle-{}",
            &records::digest(&invocation.binding)?.as_str()[7..]
        ))
        .map_err(|_| EvaluationFailure::InternalFault)?;
        let mut request = self.commit(&invocation.binding, "oracle.claim")?;
        request.input_digest = input_digest.clone();
        let conditions = self.conditions.clone();
        let invocation = invocation.clone();
        let auth = admission.clone();
        let suite = self.suite_id.clone();
        let suite_revision = self.suite_revision;
        let committed = self
            .store
            .transact(request.prepare()?, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    super::require_execution_binding(tx, &invocation.binding, &now).await?;
                    require_epochs(&auth, &conditions)?;
                    if auth.invocation().id != invocation.invocation_id {
                        return Err(EvaluationFailure::BasisChanged.into());
                    }
                    let frozen = records::suite(tx, &suite, suite_revision).await?;
                    let parent = crate::owner::read_step(
                        tx,
                        &invocation.binding.run_id,
                        &invocation.binding.step_id,
                    )
                    .await?
                    .ok_or(EvaluationFailure::BasisChanged)?;
                    let count = frozen
                        .tests
                        .len()
                        .checked_mul(frozen.arms.len())
                        .and_then(|count| u32::try_from(count).ok())
                        .ok_or(EvaluationFailure::InternalFault)?;
                    let ordinal = parent
                        .ordinal
                        .checked_add(count)
                        .ok_or(EvaluationFailure::InternalFault)?;
                    let run = crate::owner::read_run(tx, &invocation.binding.run_id).await?;
                    if ordinal as u64 >= run.budget.max_steps || ordinal > i32::MAX as u32 {
                        return Err(EvaluationFailure::BudgetExhausted {
                            dimension: BudgetDimension::Steps,
                        }
                        .into());
                    }
                    let step = crate::owner::claim_step(
                        tx,
                        &auth,
                        &run,
                        step_id,
                        ordinal,
                        "world.evaluation.oracle_custody",
                        input_digest,
                        &now,
                    )
                    .await?;
                    let mut next = step.clone();
                    next.checkpoint = serde_json::to_value(&invocation).map_err(|error| {
                        Error::Owner(
                            crate::owner::Error::internal(FailureStage::Commit).caused(error),
                        )
                    })?;
                    Ok::<_, Error>(crate::owner::checkpoint_step(tx, &step, next).await?)
                })
            })
            .await
            .map_err(crate::owner::Error::from)?;
        if committed.replayed {
            return Err(EvaluationFailure::ExecutionFailed.into());
        }
        Ok(committed.value)
    }

    async fn retain_oracle(
        &self,
        admission: &Admission,
        invocation: &OracleInvocation,
        step: &crate::owner::StepRecord,
        bytes: &[u8],
        roots: crate::store::RetentionRoots,
        failure: Option<world_protocol::process::HostFailure>,
        settled: bool,
        pipeline: &PipelineContext,
    ) -> Result<BlobRef, Error> {
        let mut request = self.commit(&invocation.binding, "oracle.custody")?;
        request.input_digest =
            records::digest(&(invocation, &step.id, raw_digest(bytes)?, bytes.len()))?;
        let batch = request.prepare()?;
        let prepared = Arc::new(self.content.prepare_blob(
            &mut std::io::Cursor::new(bytes),
            None,
            &pipeline.cancellation(),
        )?);
        let blob = prepared.reference().clone();
        let custody = OracleCustody {
            invocation: invocation.clone(),
            retained: blob.clone(),
            roots,
        };
        let step = step.clone();
        let auth = admission.clone();
        let conditions = self.conditions.clone();
        let content = self.content.clone();
        let retained = prepared.clone();
        let committed = self
            .store
            .transact(batch, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    super::require_execution_binding(tx, &custody.invocation.binding, &now).await?;
                    authorization::check_admitted_output(tx, &auth, auth.impact(), 1, &now).await?;
                    require_epochs(&auth, &conditions)?;
                    let current = crate::owner::read_step(tx, &step.run_id, &step.id)
                        .await?
                        .ok_or(EvaluationFailure::BasisChanged)?;
                    let checkpoint: OracleInvocation =
                        serde_json::from_value(current.checkpoint.clone()).map_err(|error| {
                            Error::Owner(
                                crate::owner::Error::internal(FailureStage::Read).caused(error),
                            )
                        })?;
                    if checkpoint != custody.invocation
                        || current.input_digest != records::digest(&checkpoint)?
                        || current.revision != step.revision
                        || current.phase != world_protocol::operation::OperationPhase::Running
                        || current.result.is_some()
                        || current.failure.is_some()
                    {
                        return Err(EvaluationFailure::BasisChanged.into());
                    }
                    content
                        .retain_prepared(
                            tx,
                            &retained,
                            ContentOwner::Evaluation {
                                id: custody.invocation.binding.evaluation_id.clone(),
                            },
                        )
                        .await?;
                    let mut next = current.clone();
                    next.phase = if !settled {
                        world_protocol::operation::OperationPhase::Retained
                    } else if failure.is_some() {
                        world_protocol::operation::OperationPhase::Failed
                    } else {
                        world_protocol::operation::OperationPhase::Completed
                    };
                    next.failure = failure
                        .map(|failure| {
                            crate::owner::Error::from_host_failure(failure, FailureStage::Verify)
                        })
                        .map(|error| {
                            error
                                .operation_failure()
                                .ok_or(EvaluationFailure::InternalFault)
                        })
                        .transpose()?;
                    next.result = Some(serde_json::to_value(custody).map_err(|error| {
                        Error::Owner(
                            crate::owner::Error::internal(FailureStage::Commit).caused(error),
                        )
                    })?);
                    crate::owner::checkpoint_step(tx, &current, next).await?;
                    Ok::<_, Error>(())
                })
            })
            .await
            .map_err(|error| Error::Owner(error.into()));
        let cleanup = self
            .content
            .discard_prepared(&prepared)
            .map_err(Error::from);
        preserve_cleanup(committed.map(|_| ()), cleanup)?;
        Ok(blob)
    }

    async fn oracle_blob(
        &self,
        admission: &Admission,
        binding: &EvaluationBinding,
        blob: &BlobRef,
        owner: ContentOwner,
        stage: &str,
    ) -> Result<Vec<u8>, Error> {
        let reference = crate::content::ContentReference::new(owner, blob.clone())?;
        let pin_id = world_protocol::ids::ContentId::try_new(format!(
            "read-{}",
            &records::digest(&(binding, stage, &reference))?.as_str()[7..]
        ))
        .map_err(|_| EvaluationFailure::InternalFault)?;
        let auth = admission.clone();
        let pinned_reference = reference.clone();
        let commits = self.commit(binding, stage)?;
        let pin = super::io::transact(&self.store, &commits, "pin", &reference, move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                authorization::check_admitted_output(tx, &auth, auth.impact(), 1, &now).await?;
                Ok(crate::content::pin(
                    tx,
                    &pinned_reference,
                    pin_id,
                    crate::content::PinKind::Read,
                )
                .await?)
            })
        })
        .await?;
        let bytes = self.content.read_pinned(&self.store, &pin).await;
        let current = pin.value;
        let released =
            super::io::transact(&self.store, &commits, "release", &reference, move |tx| {
                Box::pin(async move {
                    crate::content::release_pin(tx, &current).await?;
                    Ok(())
                })
            })
            .await
            .map(|_| ());
        let bytes = preserve_cleanup(bytes.map_err(Error::from), released)?;
        self.current(admission).await?;
        Ok(bytes)
    }

    async fn program(
        &self,
        oracle: &world_protocol::learning::OracleSpec,
        expected: &[u8],
        observed: &super::ExecutedCase,
        task: &world_protocol::learning::TaskContract,
        pipeline: &PipelineContext,
    ) -> Result<super::OracleResult, Error> {
        let started = std::time::Instant::now();
        use world_protocol::{
            bindings::{PortDirection, SlotKind},
            slots::{SlotRequest, SlotResponse},
        };
        let world_protocol::learning::OracleSpec::Program {
            implementation,
            fixture_schema,
            result_schema,
        } = oracle
        else {
            return Err(ConstraintFailure::OracleUnverified.into());
        };
        if task.world != self.task.world
            || task.id != self.task.id
            || task.revision != self.task.revision
            || task.scope != self.scope
            || pipeline.run_id() != self.run_id.as_str()
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let binding = self.observed_binding(observed)?;
        let lock = self.conditions.tool_lock.clone();
        let auth = observed.recording.clone();
        let (graph, channels) = self
            .store
            .snapshot(self.task.world.clone(), move |snapshot| {
                Box::pin(async move {
                    authorization::recheck_read(snapshot, &auth, &snapshot.now().await?).await?;
                    let graph = crate::extensions::bindings::read_graph(snapshot, &lock).await?;
                    let channels = crate::extensions::bindings::read_channels(snapshot)
                        .await?
                        .into_iter()
                        .map(|(_, channel)| {
                            channel.map_err(|failure| Error::Binding(failure.into()))
                        })
                        .collect::<Result<Vec<_>, Error>>()?;
                    Ok::<_, Error>((graph, channels))
                })
            })
            .await?;
        let nodes: Vec<_> = graph
            .lock()
            .nodes
            .iter()
            .filter(|node| {
                node.slot == SlotKind::Evaluation
                    && &node.implementation == implementation
                    && node.ports.iter().any(|port| {
                        port.direction == PortDirection::Export
                            && &port.request_schema == fixture_schema
                            && &port.result_schema == result_schema
                    })
            })
            .collect();
        if nodes.len() != 1 {
            return Err(ConstraintFailure::OracleNotTrusted.into());
        }
        let node = nodes[0].clone();
        let closure = graph
            .exact_closure(&node.id, &channels)
            .map_err(|failure| Error::Binding(failure.into()))?;
        for id in &closure.nodes {
            let member = graph
                .node(id)
                .map_err(|failure| Error::Binding(failure.into()))?;
            if member.trust == world_protocol::bindings::TrustClass::OrdinaryGuest {
                return Err(ConstraintFailure::OracleNotTrusted.into());
            }
            if observed.implementations.iter().any(|candidate| {
                candidate.artifact_digest == member.implementation.artifact_digest
                    || candidate.package_digest == member.implementation.package_digest
            }) {
                return Err(ConstraintFailure::OracleNotIndependent.into());
            }
        }
        let bindings: Vec<_> = closure
            .affected_bindings
            .iter()
            .cloned()
            .map(|id| ResourceRef::Binding { id })
            .collect();
        let states: Vec<_> = closure
            .nodes
            .iter()
            .filter_map(|id| {
                graph
                    .node(id)
                    .ok()
                    .and_then(|member| member.state.as_ref().map(|state| state.root.clone()))
            })
            .collect();
        let oracle_spec = oracle.clone();
        let oracle_for_admission = oracle.clone();
        let implementation = implementation.clone();
        let observed_digest = observed.observed.digest.clone();
        let fixture = observed.witness.fixture.clone();
        let scope = self.scope.clone();
        let suite = self.suite_id.clone();
        let suite_revision = self.suite_revision;
        let authority = self.authority.clone();
        let binding_for_admission = binding.clone();
        let labels = observed.case.access.labels.clone();
        let captures = observed.witness.captures.clone();
        let conditions = self.conditions.clone();
        let expected_digest = raw_digest(expected)?;
        let expected_size = expected.len() as u64;
        let commits = self.commit(&binding, "oracle.admit")?;
        let admitted =
            authorization::commit_admission(&self.store, commits.prepare()?, move |tx| {
                Box::pin(async move {
                    let now = tx.now().await?;
                    let frozen = records::suite(tx, &suite, suite_revision).await?;
                    let tests =
                        records::tests(tx, std::slice::from_ref(&binding_for_admission.test))
                            .await?;
                    let test = tests.first().ok_or(EvaluationFailure::BasisChanged)?;
                    if !frozen.tests.contains(&binding_for_admission.test)
                        || test.oracle != oracle_for_admission
                        || test.fixture != fixture
                        || test.expected.digest != expected_digest
                        || test.expected.byte_size != expected_size
                    {
                        return Err(EvaluationFailure::BasisChanged.into());
                    }
                    let impact = authorization::actual_impact(
                        vec![
                            AccessScope {
                                resources: vec![
                                    ResourceRef::Case {
                                        id: binding_for_admission.case_id.clone(),
                                    },
                                    ResourceRef::Suite { id: suite },
                                ],
                                fields: Vec::new(),
                                modes: vec![AccessMode::Read],
                                scope: scope.clone(),
                                valid_time: None,
                            },
                            AccessScope {
                                resources: bindings,
                                fields: Vec::new(),
                                modes: vec![AccessMode::Execute],
                                scope: scope.clone(),
                                valid_time: None,
                            },
                            AccessScope {
                                resources: states
                                    .iter()
                                    .map(|reference| ResourceRef::State {
                                        id: reference.id.clone(),
                                    })
                                    .collect(),
                                fields: Vec::new(),
                                modes: vec![AccessMode::Read],
                                scope: scope.clone(),
                                valid_time: None,
                            },
                            AccessScope {
                                resources: vec![ResourceRef::Evaluation {
                                    id: binding_for_admission.evaluation_id.clone(),
                                }],
                                fields: Vec::new(),
                                modes: vec![AccessMode::Write],
                                scope,
                                valid_time: None,
                            },
                        ]
                        .into_iter()
                        .filter(|access| !access.resources.is_empty())
                        .collect(),
                        Vec::new(),
                        labels,
                        states,
                        Vec::new(),
                    )?;
                    let mut access = impact.access;
                    let mut effects = impact.effects;
                    let mut labels = impact.labels;
                    let mut state = impact.state;
                    let mut sources = impact.source_ids;
                    for (reference, digest) in &captures {
                        let capture = crate::sources::sync::read_branch_capture(
                            tx,
                            &binding_for_admission.branch,
                            reference,
                        )
                        .await
                        .map_err(|error| Error::Owner(error.into()))?
                        .ok_or(EvaluationFailure::BasisChanged)?;
                        if &capture.capture().digest != digest {
                            return Err(EvaluationFailure::BasisChanged.into());
                        }
                        let material = capture
                            .read_impact(tx)
                            .await
                            .map_err(|error| Error::Owner(error.into()))?;
                        access.extend(material.access);
                        effects.extend(material.effects);
                        labels.extend(material.labels);
                        state.extend(material.state);
                        sources.extend(material.source_ids);
                    }
                    let impact =
                        authorization::actual_impact(access, effects, labels, state, sources)?;
                    let admission = authority
                        .oracle(
                            tx,
                            &binding_for_admission,
                            &implementation,
                            &observed_digest,
                            &impact,
                            &now,
                        )
                        .await?;
                    require_epochs(&admission, &conditions)?;
                    Ok::<_, Error>(((), admission))
                })
            })
            .await;
        let (_, admission) = admission_result(admitted)?;
        let now = super::accounting::now();
        let budget = observed
            .budget
            .scoped(&task.budget, &now)
            .map_err(budget_failure)?;
        let fixture = self
            .oracle_blob(
                &admission,
                &binding,
                &observed.witness.fixture,
                ContentOwner::Suite {
                    id: self.suite_id.clone(),
                    revision: self.suite_revision,
                },
                "oracle.fixture",
            )
            .await?;
        let bytes = self
            .oracle_blob(
                &admission,
                &binding,
                &observed.observed,
                ContentOwner::Case {
                    id: observed.case.id.clone(),
                },
                "oracle.observed",
            )
            .await?;
        budget
            .charge(
                BudgetDimension::Bytes,
                fixture.len() as u64 + bytes.len() as u64,
            )
            .map_err(budget_failure)?;
        let trace: Trace = world_protocol::wire::decode(
            &bytes,
            budget.limit().max_bytes.min(usize::MAX as u64) as usize,
        )
        .map_err(wire_failure)?;
        if trace.requested_plan != observed.witness.requested_plan_digest
            || trace.plan != observed.witness.plan_digest
            || trace.branch != binding.branch
            || trace.compile_digest != self.compile_digest
            || trace.model_digest != self.model_digest
            || trace.authority != observed.witness.authority
            || trace.arm != binding.arm
            || trace.read_receipts != observed.case.read_receipts
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let queries = trace
            .steps
            .into_iter()
            .filter_map(|step| match step.output {
                Some(StepOutput::Query(page)) => Some(world_protocol::slots::OracleQueryObservation {
                    step_id: step.id,
                    page,
                }),
                _ => None,
            })
            .collect();
        let request = SlotRequest::Evaluation(world_protocol::slots::OracleRequest {
            world: self.task.world.clone(),
            test_case_id: binding.test.id.clone(),
            fixture,
            expected: expected.to_vec(),
            observed: bytes,
            queries,
            budget: budget.limit(),
        });
        let lease = Arc::new(self.live.acquire(
            &self.task.world,
            &self.conditions.tool_lock,
            &node.id,
            admission.invocation().id.clone(),
            now,
        )?);
        let result = async {
            if lease.graph().lock() != graph.lock() || lease.closure() != &closure {
                return Err(EvaluationFailure::BasisChanged.into());
            }
            let context = InvocationContext::new(
                self.store.clone(),
                admission.clone(),
                lease.clone(),
                node.id.clone(),
                pipeline.clone(),
                budget.clone(),
            )?;
            let needs_model = lease.graph().lock().nodes.iter().any(|node| {
                lease.closure().nodes.contains(&node.id)
                    && node.ports.iter().any(|port| {
                        port.direction == PortDirection::Import && port.name == "model.generate"
                    })
            });
            let generation = if needs_model {
                let exact = self.conditions.model_binding.as_ref().ok_or_else(|| {
                    generation_error(crate::generation::GenerationError::rejected(
                        world_protocol::generation::GenerationStage::Binding,
                        world_protocol::generation::GenerationFailureKind::NoSelection,
                    ))
                })?;
                Some(
                    crate::generation::restore_binding(
                        &self.store,
                        &admission,
                        self.generation.as_ref(),
                        exact,
                        pipeline.cancellation(),
                    )
                    .await
                    .map_err(generation_error)?,
                )
            } else {
                None
            };
            let source_versions = self
                .verify_captures(
                    &admission,
                    &observed.witness.captures,
                    &budget,
                    &pipeline.cancellation(),
                )
                .await?;
            if source_versions != observed.witness.source_versions {
                return Err(EvaluationFailure::BasisChanged.into());
            }
            let services = self
                .services
                .for_lease(&lease, generation, source_versions)?;
            let invocation = OracleInvocation {
                binding: binding.clone(),
                oracle: oracle_spec.clone(),
                observed: observed.observed.clone(),
                fixture: observed.witness.fixture.clone(),
                scope: self.scope.clone(),
                activation_lock: self.conditions.tool_lock.clone(),
                graph_digest: graph.lock().digest.clone(),
                invocation_id: admission.invocation().id.clone(),
                root: node.id.clone(),
            };
            let step = self.begin_oracle(&admission, &invocation, &budget).await?;
            self.oracle_invocations
                .lock()
                .expect("evaluation invocation custody poisoned")
                .insert(invocation.invocation_id.clone());
            let outcome = invoke_composition(context, request, services).await;
            lease.finish();
            let settled = !self
                .live
                .invocation_unsettled(&self.task.world, &invocation.invocation_id)
                && outcome.as_ref().is_ok_and(|outcome| {
                    outcome.nodes.iter().all(|node| {
                        node.process.as_ref().is_none_or(|process| {
                            process.cleanup.is_none()
                                && (process.delivery
                                    == crate::extensions::process::Delivery::NotDispatched
                                    || process.outcome.as_ref().is_some_and(|outcome| {
                                        outcome.terminal
                                            != world_protocol::process::TerminalState::Retained
                                    }))
                        })
                    })
                })
                || (outcome.is_err()
                    && !self
                        .live
                        .invocation_unsettled(&self.task.world, &invocation.invocation_id));
            let maximum = usize::try_from(
                budget
                    .remaining(BudgetDimension::Bytes)
                    .map_err(budget_failure)?,
            )
            .unwrap_or(usize::MAX);
            let (bytes, roots, failure, roots_error) = match &outcome {
                Ok(outcome) => {
                    let (roots, error) = match outcome.retained_roots(&self.task.world) {
                        Ok(roots) => (roots, None),
                        Err(error) => (
                            crate::store::RetentionRoots::default(),
                            Some(Error::Owner(error)),
                        ),
                    };
                    let failure = error.as_ref().map(Error::host_failure).or_else(|| {
                        outcome
                            .result
                            .as_ref()
                            .err()
                            .map(|error| error.host_failure())
                    });
                    (
                        world_protocol::wire::encode(&outcome.retained(), maximum)
                            .map_err(wire_failure)?,
                        roots,
                        failure,
                        error,
                    )
                }
                Err(error) => {
                    let failure = error.host_failure();
                    let mut roots = crate::store::RetentionRoots::default();
                    if let Some(failure) = crate::owner::Error::from_host_failure(
                        failure.clone(),
                        FailureStage::Execute,
                    )
                    .operation_failure()
                    {
                        crate::owner::operation_failure_roots(
                            &self.task.world,
                            &failure.details,
                            &mut roots,
                        )?;
                    }
                    (
                        world_protocol::wire::encode(&failure, maximum).map_err(wire_failure)?,
                        roots,
                        Some(failure),
                        None,
                    )
                }
            };
            budget
                .charge(BudgetDimension::Bytes, bytes.len() as u64)
                .map_err(budget_failure)?;
            let retained = self
                .retain_oracle(
                    &admission,
                    &invocation,
                    &step,
                    &bytes,
                    roots,
                    failure,
                    settled && roots_error.is_none(),
                    pipeline,
                )
                .await;
            if let Some(error) = roots_error {
                return preserve_cleanup(Err(error), retained.map(|_| ()));
            }
            let custody = match outcome {
                Ok(outcome) => match outcome.result {
                    Ok(result) => (retained?, result),
                    Err(error) => {
                        return preserve_cleanup(
                            Err(Error::Composition(error)),
                            retained.map(|_| ()),
                        );
                    }
                },
                Err(error) => {
                    return preserve_cleanup(Err(Error::Composition(error)), retained.map(|_| ()));
                }
            };
            let (custody, result) = custody;
            if !settled {
                return Err(EvaluationFailure::OracleUnavailable.into());
            }
            let SlotResponse::Evaluation(result) = result else {
                return Err(ConstraintFailure::OracleUnverified.into());
            };
            if result
                .evidence
                .iter()
                .any(|reference| reference.world != self.task.world)
            {
                return Err(ConstraintFailure::CrossWorld.into());
            }
            if !result.evidence.is_empty() {
                let evidence = result.evidence.clone();
                let auth = admission.clone();
                let scope = self.scope.clone();
                let authority = self.authority.clone();
                let conditions = self.conditions.clone();
                let implementation = node.implementation.clone();
                let observed_digest = observed.observed.digest.clone();
                let evidence_binding = binding.clone();
                let witness = observed.witness.clone();
                let request = self.commit(&binding, "oracle.evidence")?;
                self.store
                    .transact(request.prepare()?, move |tx| {
                        Box::pin(async move {
                            let now = tx.now().await?;
                            authorization::recheck(tx, &auth, &now).await?;
                            super::require_execution_binding(tx, &evidence_binding, &now).await?;
                            let model = super::frozen_arm_plan(
                                tx, &evidence_binding.evaluation_id, &evidence_binding.branch, &evidence_binding.arm,
                            ).await?;
                            witness.require_frozen_plan(&model)?;
                            let release = crate::query::frozen_plan_model(tx, &model).await?;
                            let interval = crate::query::point_interval(&now)?;
                            let dependencies: Vec<_> = evidence
                                .iter()
                                .cloned()
                                .map(|reference| world_protocol::provenance::ReadDependency::Evidence {
                                    reference,
                                })
                                .collect();
                            let impact = crate::facts::support::dependency_impact(
                                tx, &dependencies, &release, &scope, &interval,
                            )
                            .await?
                            .ok_or(EvaluationFailure::BasisChanged)?;
                            if !impact.effects.is_empty()
                                || !impact.state.is_empty()
                                || impact.access.iter().any(|access| {
                                    access.modes != [AccessMode::Read]
                                })
                            {
                                return Err(authorization::AuthError::from(
                                    world_protocol::authorization::AuthorizationFailure::InsufficientScope,
                                )
                                .into());
                            }
                            let read = authority
                                .oracle(
                                    tx,
                                    &evidence_binding,
                                    &implementation,
                                    &observed_digest,
                                    &impact,
                                    &now,
                                )
                                .await?;
                            require_epochs(&read, &conditions)?;
                            crate::facts::assertions::require_evidence(
                                tx,
                                &read,
                                &evidence,
                                &scope,
                                Some(&interval),
                                &now,
                            )
                            .await
                            .map_err(Error::Fact)?;
                            Ok::<_, Error>(())
                        })
                    })
                    .await
                    .map_err(crate::owner::Error::from)?;
            }
            self.current(&admission).await?;
            let mut usage = budget.scope_usage();
            usage.elapsed = world_protocol::time::DurationMs(
                u64::try_from(started.elapsed().as_millis())
                    .map_err(|_| EvaluationFailure::InternalFault)?,
            );
            let measurements = [
                result.evidence_satisfied,
                result.evidence_required,
                result.conflicts_detected,
                result.conflicts_present,
            ]
            .iter()
            .any(Option::is_some)
            .then_some(super::Measurements {
                dangerous_effects: None,
                error_merges: None,
                identity_decisions: None,
                evidence_satisfied: result.evidence_satisfied,
                evidence_required: result.evidence_required,
                conflicts_detected: result.conflicts_detected,
                conflicts_present: result.conflicts_present,
                retraction_lag: None,
                active_complexity: None,
                migration_cost: None,
            });
            Ok(super::OracleResult {
                custody: Some(custody),
                passed: result.passed,
                usage,
                hard_checks: Vec::new(),
                measurements,
            })
        }
        .await;
        lease.finish();
        result
    }
}

async fn oracle_invocation(
    tx: &WorldTransaction<'_>,
    step: &crate::owner::StepRecord,
) -> Result<OracleInvocation, Error> {
    if step.kind != "world.evaluation.oracle_custody" {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let invocation: OracleInvocation =
        serde_json::from_value(step.checkpoint.clone()).map_err(|error| {
            Error::Owner(crate::owner::Error::internal(FailureStage::Read).caused(error))
        })?;
    let binding = &invocation.binding;
    let state = super::run::load(tx, &binding.evaluation_id)
        .await?
        .ok_or(EvaluationFailure::BasisChanged)?;
    let frozen = records::suite(tx, &state.request.suite.id, state.request.suite.revision).await?;
    let task = records::task(tx, &binding.task.id, binding.task.revision).await?;
    let tests = records::tests(tx, &frozen.tests).await?;
    let test_index = tests
        .iter()
        .position(|test| test.id == binding.test.id && test.revision == binding.test.revision)
        .ok_or(EvaluationFailure::BasisChanged)?;
    let arm_index = frozen
        .arms
        .iter()
        .position(|arm| arm == &binding.arm)
        .ok_or(EvaluationFailure::BasisChanged)?;
    let ordinal = tests
        .len()
        .checked_mul(frozen.arms.len())
        .and_then(|count| {
            test_index
                .checked_mul(frozen.arms.len())
                .and_then(|index| index.checked_add(arm_index))
                .and_then(|index| count.checked_add(index))
        })
        .and_then(|ordinal| u32::try_from(ordinal).ok())
        .ok_or(EvaluationFailure::InternalFault)?;
    let expected_id = world_protocol::ids::StepId::try_new(format!(
        "oracle-{}",
        &records::digest(binding)?.as_str()[7..]
    ))
    .map_err(|_| EvaluationFailure::InternalFault)?;
    if binding.task.world != *tx.world()
        || binding.branch.world != *tx.world()
        || step.id != expected_id
        || step.run_id != binding.run_id
        || step.ordinal != ordinal
        || step.input_digest != records::digest(&invocation)?
        || binding.run_id != state.run.id
        || binding.candidate_id != state.request.candidate_id
        || binding.branch != state.branch
        || binding.task.id != frozen.task_id
        || binding.task.revision != frozen.task_revision
        || binding.case_id
            != super::execution_case_id(
                tx.world(),
                &binding.evaluation_id,
                &binding.test,
                &binding.arm,
            )?
        || invocation.scope != task.scope
        || invocation.oracle != tests[test_index].oracle
        || invocation.fixture != tests[test_index].fixture
        || invocation.activation_lock != frozen.conditions.tool_lock
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let graph = crate::extensions::bindings::read_graph_history_in_transaction(
        tx,
        &invocation.activation_lock,
    )
    .await?;
    let node = graph
        .node(&invocation.root)
        .map_err(|failure| Error::Binding(failure.into()))?;
    let world_protocol::learning::OracleSpec::Program {
        implementation,
        fixture_schema,
        result_schema,
    } = &invocation.oracle
    else {
        return Err(ConstraintFailure::OracleUnverified.into());
    };
    if graph.lock().digest != invocation.graph_digest
        || node.slot != world_protocol::bindings::SlotKind::Evaluation
        || &node.implementation != implementation
        || !node.ports.iter().any(|port| {
            port.direction == world_protocol::bindings::PortDirection::Export
                && &port.request_schema == fixture_schema
                && &port.result_schema == result_schema
        })
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    Ok(invocation)
}

pub(crate) async fn oracle_step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &crate::owner::StepRecord,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    let invocation = oracle_invocation(tx, step).await?;
    roots.scopes.push(invocation.scope.clone());
    roots.branches.push(invocation.binding.branch.clone());
    roots.resources.extend([
        ResourceRef::Task {
            id: invocation.binding.task.id.clone(),
        },
        ResourceRef::Case {
            id: invocation.binding.case_id.clone(),
        },
        ResourceRef::TestCase {
            id: invocation.binding.test.id.clone(),
        },
        ResourceRef::Evaluation {
            id: invocation.binding.evaluation_id.clone(),
        },
    ]);
    let graph = crate::extensions::bindings::read_graph_history_in_transaction(
        tx,
        &invocation.activation_lock,
    )
    .await?;
    roots
        .resources
        .extend(graph.lock().nodes.iter().map(|node| ResourceRef::Binding {
            id: node.binding_id.clone(),
        }));
    if let Some(result) = &step.result {
        let custody: OracleCustody = serde_json::from_value(result.clone()).map_err(|error| {
            Error::Owner(crate::owner::Error::internal(FailureStage::Read).caused(error))
        })?;
        if custody.invocation != invocation
            || !crate::content::owner_references(
                tx,
                &ContentOwner::Evaluation {
                    id: invocation.binding.evaluation_id.clone(),
                },
            )
            .await?
            .iter()
            .any(|reference| reference.blob == custody.retained)
        {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        let retained = custody.roots;
        roots.scopes.extend(retained.scopes);
        roots.resources.extend(retained.resources);
        roots.definitions.extend(retained.definitions);
        roots.evidence.extend(retained.evidence);
        roots.dependencies.extend(retained.dependencies);
        roots.sources.extend(retained.sources);
        roots.releases.extend(retained.releases);
        roots.branches.extend(retained.branches);
        roots.source_versions.extend(retained.source_versions);
        roots.parse_artifacts.extend(retained.parse_artifacts);
        roots.schemas.extend(retained.schemas);
        roots.mappings.extend(retained.mappings);
    }
    if let Some(failure) = &step.failure {
        crate::owner::operation_failure_roots(tx.world(), &failure.details, roots)?;
    }
    Ok(())
}

fn wire_failure(error: world_protocol::wire::CodecFailure) -> Error {
    match error {
        world_protocol::wire::CodecFailure::SizeLimit => EvaluationFailure::BudgetExhausted {
            dimension: BudgetDimension::Bytes,
        }
        .into(),
        error => Error::Owner(crate::owner::Error::internal(FailureStage::Execute).caused(error)),
    }
}

fn generation_error(error: crate::generation::GenerationError) -> Error {
    Error::Owner(
        crate::owner::Error::from_host_failure(error.host_failure(), FailureStage::Prepare)
            .caused(error),
    )
}

fn raw_digest(bytes: &[u8]) -> Result<Digest, Error> {
    use sha2::{Digest as _, Sha256};
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|_| EvaluationFailure::InternalFault.into())
}
