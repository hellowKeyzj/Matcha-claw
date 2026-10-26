use crate::{
    authorization::{self, Admission},
    store::{StoreFuture, WorldSnapshot, WorldTransaction},
};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    definitions::{Definition, DefinitionBody, Scope},
    evaluation::{BranchBasis, EvaluationArm, EvaluationConditions, EvaluationFailure, FrozenSuite, PlanReference, SuiteRef},
    ids::{DefinitionRef, Digest, EvaluationId, ResourceRef, WorldRef},
    releases::{BranchRef, WorldBranch},
};

use super::{Error, records, run};

type Model = Definition<DefinitionBody>;

/// Reconstructed from durable evaluation authority; never serialized as a capability.
pub(crate) struct FrozenArmPlan {
    evaluation: EvaluationId,
    suite: SuiteRef,
    suite_digest: Digest,
    branch: BranchRef,
    arm: EvaluationArm,
    plan: PlanReference,
    artifact_digest: Digest,
    model_digest: Digest,
    definitions: Vec<Model>,
    scopes: Vec<Scope>,
    tools: Vec<DefinitionRef>,
    conditions: EvaluationConditions,
    basis: BranchBasis,
}
impl FrozenArmPlan {
    pub(crate) fn evaluation(&self) -> &EvaluationId { &self.evaluation }
    pub(crate) fn suite(&self) -> &SuiteRef { &self.suite }
    pub(crate) fn suite_digest(&self) -> &Digest { &self.suite_digest }
    pub(crate) fn branch(&self) -> &BranchRef { &self.branch }
    pub(crate) fn arm(&self) -> &EvaluationArm { &self.arm }
    pub(crate) fn plan(&self) -> &PlanReference { &self.plan }
    pub(crate) fn artifact_digest(&self) -> &Digest { &self.artifact_digest }
    pub(crate) fn model_digest(&self) -> &Digest { &self.model_digest }
    pub(crate) fn definitions(&self) -> &[Model] { &self.definitions }
    pub(crate) fn scopes(&self) -> &[Scope] { &self.scopes }
    pub(crate) fn tools(&self) -> &[DefinitionRef] { &self.tools }
    pub(crate) fn conditions(&self) -> &EvaluationConditions { &self.conditions }
    pub(crate) fn basis(&self) -> &BranchBasis { &self.basis }
}

pub(crate) struct FrozenArmModel { plan: FrozenArmPlan }
impl FrozenArmModel {
    pub(crate) fn evaluation(&self) -> &EvaluationId { self.plan.evaluation() }
    pub(crate) fn suite(&self) -> &SuiteRef { self.plan.suite() }
    pub(crate) fn suite_digest(&self) -> &Digest { self.plan.suite_digest() }
    pub(crate) fn branch(&self) -> &BranchRef { self.plan.branch() }
    pub(crate) fn arm(&self) -> &EvaluationArm { self.plan.arm() }
    pub(crate) fn plan(&self) -> &PlanReference { self.plan.plan() }
    pub(crate) fn artifact_digest(&self) -> &Digest { self.plan.artifact_digest() }
    pub(crate) fn model_digest(&self) -> &Digest { self.plan.model_digest() }
    pub(crate) fn definitions(&self) -> &[Model] { self.plan.definitions() }
    pub(crate) fn scopes(&self) -> &[Scope] { self.plan.scopes() }
    pub(crate) fn tools(&self) -> &[DefinitionRef] { self.plan.tools() }
    pub(crate) fn conditions(&self) -> &EvaluationConditions { self.plan.conditions() }
    pub(crate) fn basis(&self) -> &BranchBasis { self.plan.basis() }
}

#[derive(Clone, Copy)]
enum Reader<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>),
    Snapshot(&'a WorldSnapshot<'b>),
}
impl<'a, 'b> Reader<'a, 'b> {
    fn world(self) -> &'a WorldRef {
        match self { Self::Transaction(tx) => tx.world(), Self::Snapshot(snapshot) => snapshot.world() }
    }
    async fn run(self, id: &EvaluationId) -> Result<run::EvaluationRun, Error> {
        match self {
            Self::Transaction(tx) => run::load(tx, id).await?.ok_or_else(|| EvaluationFailure::BasisChanged.into()),
            Self::Snapshot(snapshot) => run::read_snapshot(snapshot, id).await,
        }
    }
    async fn suite(self, reference: &SuiteRef) -> Result<FrozenSuite, Error> {
        match self {
            Self::Transaction(tx) => records::suite(tx, &reference.id, reference.revision).await,
            Self::Snapshot(snapshot) => records::suite_snapshot(snapshot, &reference.id, reference.revision).await,
        }
    }
    async fn branch(self, reference: &BranchRef) -> Result<WorldBranch, Error> {
        match self {
            Self::Transaction(tx) => crate::releases::read_branch_revision(tx, reference).await?,
            Self::Snapshot(snapshot) => crate::releases::read_branch_revision_snapshot(snapshot, reference).await?,
        }.ok_or_else(|| EvaluationFailure::BasisChanged.into())
    }
    async fn impact(self, model: &FrozenArmPlan, branch: &WorldBranch) -> Result<world_protocol::authorization::ActualImpact, Error> {
        let task_scope = match self {
            Self::Transaction(tx) => records::task(tx, &branch.task_id, branch.task_revision).await?.scope,
            Self::Snapshot(snapshot) => records::task_snapshot(snapshot, &branch.task_id, branch.task_revision).await?.scope,
        };
        let mut access = vec![AccessScope {
            resources: vec![ResourceRef::Branch { id: branch.id.clone() }],
            fields: Vec::new(), modes: vec![AccessMode::Read], scope: task_scope, valid_time: None,
        }];
        let current = match self {
            Self::Transaction(tx) => crate::releases::read_active_model(tx).await?,
            Self::Snapshot(snapshot) => match crate::releases::read_active_release_snapshot(snapshot).await? {
                Some(id) => crate::releases::read_release_snapshot(snapshot, &id).await?, None => None,
            },
        };
        let mut labels = Vec::new();
        for definition in &model.definitions {
            access.push(AccessScope { resources: vec![ResourceRef::Definition { id: definition.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: definition.scope.clone(), valid_time: None });
            if let DefinitionBody::Property(property) = &definition.body { labels.extend(property.access_labels.clone()); }
            if let Some(current) = current.as_ref().and_then(|current| current.definitions.iter().find(|current| current.reference.id == definition.reference.id)) {
                access.push(AccessScope { resources: vec![ResourceRef::Definition { id: current.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: current.scope.clone(), valid_time: None });
                if let DefinitionBody::Property(property) = &current.body { labels.extend(property.access_labels.clone()); }
            }
        }
        let mut impact = authorization::actual_impact(access, Vec::new(), labels, Vec::new(), Vec::new())?;
        for definition in &model.definitions {
            let DefinitionBody::SourceBinding(_) = &definition.body else { continue; };
            let capture = match self {
                Self::Transaction(tx) => crate::sources::sync::selected_branch_capture(tx, branch, &definition.reference).await,
                Self::Snapshot(snapshot) => crate::sources::sync::selected_branch_capture_snapshot(snapshot, branch, &definition.reference).await,
            }.map_err(crate::owner::Error::from)?.ok_or(EvaluationFailure::BasisChanged)?;
            if !model.basis.sources.contains(&capture.capture().basis) { return Err(EvaluationFailure::BasisChanged.into()); }
            let actual = match self {
                Self::Transaction(tx) => capture.read_impact(tx).await,
                Self::Snapshot(snapshot) => capture.read_impact_snapshot(snapshot).await,
            }.map_err(crate::owner::Error::from)?;
            merge(&mut impact, actual);
        }
        if let PlanReference::Frozen(plan) = &model.plan {
            if let world_protocol::evaluation::FrozenKnowledge::ToolMemory { snapshot: reference, .. } = &plan.knowledge {
                let version = match self {
                    Self::Transaction(tx) => crate::content::read_source_version_in_transaction(tx, reference).await?,
                    Self::Snapshot(snapshot) => crate::content::read_source_version_snapshot(snapshot, reference).await?,
                };
                let actual = match self {
                    Self::Transaction(tx) => authorization::material_read_impact(tx, &version).await?,
                    Self::Snapshot(snapshot) => authorization::material_read_impact_snapshot(snapshot, &version).await?,
                };
                merge(&mut impact, actual);
            }
        }
        Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
    }
    async fn authorize(self, admission: &Admission, model: &FrozenArmPlan, branch: &WorldBranch) -> Result<(), Error> {
        let impact = self.impact(model, branch).await?;
        admission.require_access(&impact)?;
        let now = match self { Self::Transaction(tx) => tx.now().await?, Self::Snapshot(snapshot) => snapshot.now().await? };
        match self {
            Self::Transaction(tx) => { authorization::recheck(tx, admission, &now).await?; authorization::check_admitted_output(tx, admission, &impact, 1, &now).await?; }
            Self::Snapshot(snapshot) => { authorization::recheck_read(snapshot, admission, &now).await?; authorization::check_admitted_output_read(snapshot, admission, &impact, 1, &now).await?; }
        }
        for definition in &model.definitions {
            let DefinitionBody::SourceBinding(_) = &definition.body else { continue; };
            let capture = match self {
                Self::Transaction(tx) => crate::sources::sync::selected_branch_capture(tx, branch, &definition.reference).await,
                Self::Snapshot(snapshot) => crate::sources::sync::selected_branch_capture_snapshot(snapshot, branch, &definition.reference).await,
            }.map_err(crate::owner::Error::from)?.ok_or(EvaluationFailure::BasisChanged)?;
            match self {
                Self::Transaction(tx) => capture.recheck(tx, admission, &now).await,
                Self::Snapshot(snapshot) => capture.recheck_snapshot(snapshot, admission, &now).await,
            }.map_err(crate::owner::Error::from)?;
        }
        Ok(())
    }
}
fn merge(target: &mut world_protocol::authorization::ActualImpact, source: world_protocol::authorization::ActualImpact) {
    target.access.extend(source.access); target.effects.extend(source.effects); target.labels.extend(source.labels); target.state.extend(source.state); target.source_ids.extend(source.source_ids);
}

pub(crate) fn frozen_arm_model<'a>(
    tx: &'a WorldTransaction<'_>, admission: &'a Admission, evaluation: &'a EvaluationId,
    branch: &'a BranchRef, arm: &'a EvaluationArm,
) -> StoreFuture<'a, FrozenArmModel, Error> {
    read(Reader::Transaction(tx), admission, evaluation, branch, arm)
}

pub(crate) fn frozen_arm_model_snapshot<'a>(
    snapshot: &'a WorldSnapshot<'_>, admission: &'a Admission, evaluation: &'a EvaluationId,
    branch: &'a BranchRef, arm: &'a EvaluationArm,
) -> StoreFuture<'a, FrozenArmModel, Error> {
    read(Reader::Snapshot(snapshot), admission, evaluation, branch, arm)
}

pub(crate) async fn frozen_arm_plan(tx: &WorldTransaction<'_>, evaluation: &EvaluationId, branch: &BranchRef, arm: &EvaluationArm) -> Result<FrozenArmPlan, Error> {
    Ok(resolve(Reader::Transaction(tx), evaluation, branch, arm).await?.0)
}
pub(crate) async fn frozen_arm_plan_snapshot(snapshot: &WorldSnapshot<'_>, evaluation: &EvaluationId, branch: &BranchRef, arm: &EvaluationArm) -> Result<FrozenArmPlan, Error> {
    Ok(resolve(Reader::Snapshot(snapshot), evaluation, branch, arm).await?.0)
}
pub(crate) async fn frozen_model_impact(tx: &WorldTransaction<'_>, evaluation: &EvaluationId, branch: &BranchRef, arm: &EvaluationArm) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let reader = Reader::Transaction(tx);
    let (model, branch) = resolve(reader, evaluation, branch, arm).await?;
    reader.impact(&model, &branch).await
}
fn read<'a>(reader: Reader<'a, '_>, admission: &'a Admission, evaluation: &'a EvaluationId, reference: &'a BranchRef, arm: &'a EvaluationArm) -> StoreFuture<'a, FrozenArmModel, Error> {
    Box::pin(async move {
        let binding = authorization::require_evaluation_execution_model(admission, evaluation, reference, arm)?;
        let now = match reader { Reader::Transaction(tx) => tx.now().await?, Reader::Snapshot(snapshot) => snapshot.now().await? };
        match reader {
            Reader::Transaction(tx) => { super::require_execution_binding(tx, binding, &now).await?; }
            Reader::Snapshot(snapshot) => { super::require_execution_binding_snapshot(snapshot, binding, &now).await?; }
        }
        let (model, branch) = resolve(reader, evaluation, reference, arm).await?;
        if admission.decision().policy_epoch != model.conditions.policy_epoch || admission.decision().grant_epoch != model.conditions.grant_epoch {
            return Err(EvaluationFailure::EpochChanged.into());
        }
        reader.authorize(admission, &model, &branch).await?;
        Ok(FrozenArmModel { plan: model })
    })
}
async fn resolve(reader: Reader<'_, '_>, evaluation: &EvaluationId, reference: &BranchRef, arm: &EvaluationArm) -> Result<(FrozenArmPlan, WorldBranch), Error> {
    if reference.world != *reader.world() { return Err(EvaluationFailure::BasisChanged.into()); }
    let state = reader.run(evaluation).await?;
    let suite_ref = SuiteRef { world: state.request.suite.world.clone(), id: state.request.suite.id.clone(), revision: state.request.suite.revision };
    let suite = reader.suite(&suite_ref).await?;
    let branch = reader.branch(reference).await?;
    if state.request.id != *evaluation || state.request.world != *reader.world() || state.branch != *reference
        || state.request.suite != suite || state.request.candidate_id != branch.candidate_id
        || state.request.branch_id != branch.id || state.request.basis != branch.basis
        || branch.task_id != suite.task_id || branch.task_revision != suite.task_revision
        || branch.compile.activation_lock.id != suite.conditions.tool_lock
        || branch.basis.activation_lock_id != suite.conditions.tool_lock
        || super::data_digest(&branch.basis)? != suite.conditions.data_digest
        || records::digest(&branch.compile)? != state.compile_digest
        || crate::compiler::model_digest(&branch.compile).map_err(Error::Compile)? != state.model_digest
    { return Err(EvaluationFailure::BasisChanged.into()); }
    let mut selections = suite.plans.iter().filter(|selection| &selection.arm == arm);
    let selection = selections.next().ok_or(EvaluationFailure::BasisChanged)?;
    if selections.next().is_some() { return Err(EvaluationFailure::BasisChanged.into()); }
    let (mut definitions, scopes, tools) = match &selection.plan {
        PlanReference::Frozen(plan) => {
            super::frozen_plan::validate_shape(reader.world(), arm, plan)?;
            (plan.definitions.clone(), plan.scopes.clone(), plan.tools.clone())
        }
        _ if matches!(arm, EvaluationArm::Candidate | EvaluationArm::Ablation { .. }) => (branch.compile.definitions.clone(), branch.compile.scopes.clone(), Vec::new()),
        _ => return Err(EvaluationFailure::BasisChanged.into()),
    };
    super::frozen_plan::require_common_tools(&suite.plans, &branch.compile)?;
    if let EvaluationArm::Ablation { disabled_definitions } = arm {
        if disabled_definitions.iter().any(|reference| !definitions.iter().any(|definition| &definition.reference == reference)) { return Err(EvaluationFailure::BasisChanged.into()); }
        definitions.retain(|definition| !disabled_definitions.contains(&definition.reference));
    }
    let mut compile = branch.compile.clone();
    compile.definitions = definitions.clone();
    compile.scopes = scopes.clone();
    crate::compiler::validate_structure(&compile).map_err(Error::Compile)?;
    let model = FrozenArmPlan {
        evaluation: evaluation.clone(), suite: suite_ref, suite_digest: records::digest(&suite)?, branch: reference.clone(), arm: arm.clone(),
        plan: selection.plan.clone(), artifact_digest: records::digest(&("world.frozen-arm.v1", &selection.plan, &suite.conditions))?,
        model_digest: crate::compiler::model_digest(&compile).map_err(Error::Compile)?, definitions, scopes, tools,
        conditions: suite.conditions, basis: branch.basis.clone(),
    };
    Ok((model, branch))
}
