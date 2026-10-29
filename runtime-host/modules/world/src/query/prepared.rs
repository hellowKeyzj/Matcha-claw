use std::collections::BTreeSet;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    package::PackageLimits,
    slots::{self, ResolveQueryRequest, ResolveQueryResult},
};

use crate::{
    extensions::{
        invocation::{InvocationContext, NativePrepareFailure, NativeProof},
        package::ArtifactLease,
    },
    owner::{Error, ResolverExecution},
};

pub(crate) struct PreparedProjection { proof: NativeProof }
pub(crate) struct PreparedReconcile { proof: NativeProof }

impl PreparedProjection {
    pub(crate) fn prepare(node: &BindingNode, config: PackageConfigView, artifact: ArtifactLease) -> Result<Self, NativePrepareFailure> {
        let contract = slots::projection_contract().map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) { return Err(NativePrepareFailure::Entrypoint); }
        Ok(Self { proof: NativeProof::prepare(node, config, artifact, slots::PROJECTION_REGISTRATION, SlotKind::Projection)? })
    }
    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }
    pub(crate) fn project(&self, request: &slots::ProjectionRequest, budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken) -> Result<slots::ProjectionResult, slots::ProjectionFailure> {
        let cells = project_cells(request, budget, cancel)?;
        Ok(slots::ProjectionResult { cells, dependencies: request.dependencies.clone(), diagnostics: Vec::new() })
    }
}

impl PreparedReconcile {
    pub(crate) fn prepare(node: &BindingNode, config: PackageConfigView, artifact: ArtifactLease) -> Result<Self, NativePrepareFailure> {
        let contract = slots::reconcile_contract().map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) { return Err(NativePrepareFailure::Entrypoint); }
        Ok(Self { proof: NativeProof::prepare(node, config, artifact, slots::RECONCILE_REGISTRATION, SlotKind::Reconcile)? })
    }
    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }
    pub(crate) fn reconcile(&self, request: &slots::ReconcileRequest, budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken) -> Result<slots::ReconcileResult, slots::ReconcileFailure> {
        let mut selected = BTreeSet::new();
        for assertion in &request.assertions {
            if cancel.is_cancelled() { return Err(slots::ReconcileFailure::Cancelled); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| slots::ReconcileFailure::BudgetExceeded)?;
            if assertion.status != world_protocol::facts::AssertionStatus::Accepted { return Err(slots::ReconcileFailure::BasisChanged); }
            selected.insert(assertion.reference.clone());
        }
        let mut conflicts = Vec::new();
        for cell in &request.cells {
            if cancel.is_cancelled() { return Err(slots::ReconcileFailure::Cancelled); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| slots::ReconcileFailure::BudgetExceeded)?;
            if matches!(cell.field.cell, world_protocol::value::Cell::Conflicted { .. }) { conflicts.push(cell.clone()); }
        }
        Ok(slots::ReconcileResult { selected: selected.into_iter().collect(), conflicts, observations: Vec::new(), dependencies: request.dependencies.clone() })
    }
}

fn project_cells(request: &slots::ProjectionRequest, budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken) -> Result<Vec<slots::ProjectedCell>, slots::ProjectionFailure> {
    use world_protocol::{definitions::DefinitionBody, facts::{Claim, Polarity}, value::{Cell, DirtyState, Value}};
    let mut result = Vec::with_capacity(request.cells.len());
    for cell in &request.cells {
        if cancel.is_cancelled() { return Err(slots::ProjectionFailure::Cancelled); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| slots::ProjectionFailure::BudgetExceeded)?;
        let definition = request.definitions.iter().find(|definition| definition.reference == cell.field.property)
            .ok_or(slots::ProjectionFailure::BasisChanged)?;
        let DefinitionBody::Property(property) = &definition.body else { return Err(slots::ProjectionFailure::BasisChanged); };
        let candidates = request.assertions.iter().filter(|assertion| matches!(&assertion.claim, Claim::Attribute(claim)
            if claim.subject == cell.subject && claim.property == cell.field.property)).collect::<Vec<_>>();
        let sources = request.sources.iter().filter(|source| source.cell.subject == cell.subject
            && source.cell.field.property == cell.field.property).collect::<Vec<_>>();
        let mut values = Vec::new();
        let mut evidence = cell.field.evidence.iter().cloned().collect::<BTreeSet<_>>();
        for assertion in &candidates {
            if cancel.is_cancelled() { return Err(slots::ProjectionFailure::Cancelled); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| slots::ProjectionFailure::BudgetExceeded)?;
            evidence.extend(assertion.evidence.iter().cloned());
            if let Claim::Attribute(claim) = &assertion.claim {
                if assertion.polarity == Polarity::Positive && !values.contains(&claim.value) { values.push(claim.value.clone()); }
            }
        }
        for source in &sources {
            if cancel.is_cancelled() { return Err(slots::ProjectionFailure::Cancelled); }
            budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(|_| slots::ProjectionFailure::BudgetExceeded)?;
            evidence.extend(source.cell.field.evidence.iter().cloned());
            if let Cell::Known { value } = &source.cell.field.cell {
                let incoming = if property.cardinality.maximum == Some(1) { std::slice::from_ref(value) }
                    else if let Value::List { items } = value { items.as_slice() }
                    else { return Err(slots::ProjectionFailure::BasisChanged); };
                for value in incoming { if !values.contains(value) { values.push(value.clone()); } }
            }
        }
        let mut projected = cell.clone();
        if let Some(fixed) = request.fixed.iter().find(|fixed| fixed.subject == cell.subject && fixed.field.property == cell.field.property) {
            projected.field.cell = fixed.field.cell.clone();
        } else if values.is_empty() {
            projected.field.cell = sources.first().map(|source| source.cell.field.cell.clone()).unwrap_or_else(|| cell.field.cell.clone());
        } else {
            let pending = match &cell.field.dirty { DirtyState::Clean => None, DirtyState::Dirty { generation, .. } => Some(*generation) };
            projected.field.cell = super::projection::reconcile_cell(property, values, &candidates, pending);
        }
        projected.field.evidence = evidence.into_iter().collect();
        result.push(projected);
    }
    Ok(result)
}

pub(crate) struct PreparedResolver {
    proof: NativeProof,
}

impl PreparedResolver {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Resolver)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        let proof = NativeProof::prepare(
            node,
            config,
            artifact,
            slots::RESOLVER_REGISTRATION,
            SlotKind::Resolver,
        )?;
        Ok(Self { proof })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        self.proof.implementation()
    }
    pub fn config(&self) -> &PackageConfigView {
        self.proof.config()
    }
    pub fn limits(&self) -> &PackageLimits {
        self.proof.limits()
    }
    pub(crate) async fn resolve(
        &self,
        context: &InvocationContext,
        request: &ResolveQueryRequest,
        execution: &ResolverExecution,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<ResolveQueryResult, Error> {
        execution.execute(context, request, &cancel, deadline).await
    }
}
