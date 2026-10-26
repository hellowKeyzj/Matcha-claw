use world_protocol::{
    abstraction::WorldView,
    api::PeerResponse,
    authorization::{PolicyObligation, PolicyRef},
    compiler::{CompileDependency, CompileDiagnostic, CompileRequest, DependencyTarget, TypedIr},
    definitions::{Definition, DefinitionBody},
    failure::FailureStage,
    identity::{IdentityProposal, SubjectRef},
    ids::*,
    process::{CallResult, HostFailure},
    provenance::ReadDependency,
    slots::SlotResponse,
    sources::{RecordCell, SourceBinding},
};

use super::{CompositionFailure, CompositionOutcome};
use crate::{owner::Error, store::RetentionRoots};

impl CompositionOutcome {
    /// Typed historical references only; retained bytes are never decoded into authority.
    pub(crate) fn retained_roots(&self, world: &WorldRef) -> Result<RetentionRoots, Error> {
        let mut roots = RetentionRoots::default();
        result(world, &self.result, &mut roots)?;
        for node in &self.nodes {
            result(world, &node.result, &mut roots)?;
            if let Some(proposal) = &node.proposal {
                slot(world, proposal, &mut roots)?;
            }
            for error in &node.host_failures {
                let failure = error.safe_failure();
                host(world, failure.details, failure.stage, &mut roots)?;
            }
            if let Some(process) = &node.process {
                if let Some(outcome) = &process.outcome {
                    if let Some(result) = &outcome.result {
                        call(world, result, &mut roots)?;
                    }
                    if let Some(error) = &outcome.host_failure {
                        let failure = error.safe_failure();
                        host(world, failure.details, failure.stage, &mut roots)?;
                    }
                }
                if let Some(result) = &process.received_result {
                    call(world, result, &mut roots)?;
                }
                if let Some(error) = &process.cleanup {
                    host(world, error.host_failure(), FailureStage::Stop, &mut roots)?;
                }
            }
        }
        roots
            .definitions
            .retain(|reference| reference.world == *world);
        roots.evidence.retain(|reference| reference.world == *world);
        roots
            .source_versions
            .retain(|reference| reference.world == *world);
        roots.schemas.retain(|reference| reference.world == *world);
        roots.mappings.retain(|reference| reference.world == *world);
        roots.branches.retain(|reference| reference.world == *world);
        roots.sources.retain(|source| {
            source.binding.world == *world
                && source.schema.world == *world
                && source.identity_rule.world == *world
                && source
                    .field_definitions
                    .iter()
                    .all(|field| field.world == *world)
        });
        roots.dependencies.retain(|dependency| match dependency {
            ReadDependency::Assertion { reference } => reference.world == *world,
            ReadDependency::Evidence { reference } => reference.world == *world,
            ReadDependency::Definition { reference }
            | ReadDependency::Source {
                binding: reference, ..
            } => reference.world == *world,
            ReadDependency::SourceMapping {
                binding,
                mapping,
                identity_rule,
                ..
            } => {
                binding.world == *world && mapping.world == *world && identity_rule.world == *world
            }
            ReadDependency::SourceField { schema, .. } => schema.world == *world,
            _ => true,
        });
        roots.scopes.sort();
        roots.scopes.dedup();
        roots.resources.sort();
        roots.resources.dedup();
        roots.definitions.sort();
        roots.definitions.dedup();
        roots.evidence.sort();
        roots.evidence.dedup();
        roots.releases.sort();
        roots.releases.dedup();
        roots.branches.sort_by(|left, right| {
            (&left.world, &left.id, left.revision).cmp(&(&right.world, &right.id, right.revision))
        });
        roots.branches.dedup();
        roots.source_versions.sort_by(|left, right| {
            (&left.world, &left.source_id, &left.version_id).cmp(&(
                &right.world,
                &right.source_id,
                &right.version_id,
            ))
        });
        roots.source_versions.dedup();
        roots.parse_artifacts.sort();
        roots.parse_artifacts.dedup();
        roots.schemas.sort();
        roots.schemas.dedup();
        roots.mappings.sort();
        roots.mappings.dedup();
        Ok(roots)
    }
}

fn host(
    world: &WorldRef,
    failure: HostFailure,
    stage: FailureStage,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    let failure = Error::from_host_failure(failure, stage)
        .operation_failure()
        .expect("host failure has canonical operation projection");
    crate::owner::operation_failure_roots(world, &failure.details, roots)
}

fn result(
    world: &WorldRef,
    value: &Result<SlotResponse, CompositionFailure>,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    match value {
        Ok(value) => slot(world, value, roots),
        Err(error) => host(world, error.host_failure(), FailureStage::Execute, roots),
    }
}

fn call(world: &WorldRef, value: &CallResult, roots: &mut RetentionRoots) -> Result<(), Error> {
    match &value.result {
        Ok(value) => slot(world, value, roots)?,
        Err(failure) => host(
            world,
            HostFailure::Slot(failure.details.clone()),
            failure.stage,
            roots,
        )?,
    }
    for receipt in &value.effects {
        crate::actions::source_receipt_retention_roots(roots, receipt.clone());
    }
    Ok(())
}

fn slot(world: &WorldRef, value: &SlotResponse, roots: &mut RetentionRoots) -> Result<(), Error> {
    match value {
        SlotResponse::Connector(page) => {
            if page.basis.binding.world != *world {
                return Ok(());
            }
            roots.sources.push(page.basis.clone());
            for row in &page.rows {
                for field in &row.fields {
                    if let RecordCell::Known { value } = &field.value {
                        value_roots(roots, value);
                    }
                    if let Some(value) = field
                        .formula
                        .as_ref()
                        .and_then(|formula| formula.cached.as_ref())
                    {
                        value_roots(roots, value);
                    }
                }
            }
        }
        SlotResponse::ConnectorDiscover(observation) => {
            for field in &observation.fields {
                value_type(roots, &field.value_type);
            }
        }
        SlotResponse::Identity(proposal) => match proposal {
            IdentityProposal::Same { target, evidence } => {
                subject(roots, target);
                roots.evidence.extend(evidence.clone());
            }
            IdentityProposal::New { type_ref, evidence } => {
                roots.definitions.push(type_ref.clone());
                roots.evidence.extend(evidence.clone());
            }
            IdentityProposal::Ambiguous {
                candidates,
                evidence,
            } => {
                for target in candidates {
                    subject(roots, target);
                }
                roots.evidence.extend(evidence.clone());
            }
        },
        SlotResponse::Schema(ir) => typed_ir(world, ir, roots),
        SlotResponse::SchemaKind(response) => {
            use world_protocol::definitions::KindResult;
            match &response.result {
                KindResult::Validated | KindResult::LifecycleChecked => {}
                KindResult::Lowered { body: lowered } => {
                    roots.definitions.extend(crate::definitions::definition_references(lowered));
                    roots.resources.extend(crate::definitions::definition_resources(lowered));
                    if let DefinitionBody::SourceBinding(source) = lowered {
                        roots.scopes.push(source.scope.clone());
                        roots.schemas.push(source.schema.clone());
                        roots.mappings.push(source.mapping.clone());
                    }
                    if let DefinitionBody::PolicyBinding(binding) = lowered {
                        roots.scopes.push(binding.scope.clone());
                        policy_roots(roots, &binding.policy);
                    }
                }
                KindResult::Indexed { dependencies } => roots.definitions.extend(dependencies.clone()),
                KindResult::Migrated { definition } | KindResult::Reduced { definition } => {
                    model(world, roots, std::slice::from_ref(definition));
                }
            }
        }
        SlotResponse::Resolver(resolved) => {
            if resolved.page.receipt.world != *world {
                return Ok(());
            }
            crate::query::retain_page(roots, &resolved.page);
            roots
                .dependencies
                .extend(resolved.actual_dependencies.clone());
        }
        SlotResponse::Projection(projected) => {
            for cell in &projected.cells {
                subject(roots, &cell.subject);
                crate::query::retain_field(roots, cell.field.clone());
            }
            roots.dependencies.extend(projected.dependencies.clone());
            diagnostics(roots, &projected.diagnostics);
        }
        SlotResponse::Provenance(delta) => {
            for support in delta
                .upserts
                .iter()
                .filter(|support| support.reference.world == *world)
            {
                crate::facts::support::retain_support(roots, support);
            }
            roots.resources.extend(
                delta
                    .invalidate
                    .iter()
                    .filter(|reference| reference.world == *world)
                    .map(|reference| ResourceRef::Support {
                        id: reference.id.clone(),
                    }),
            );
            roots.resources.extend(
                delta
                    .affected_watches
                    .iter()
                    .cloned()
                    .map(|id| ResourceRef::Watch { id }),
            );
            roots
                .dependencies
                .extend(delta.observed_dependencies.clone());
        }
        SlotResponse::Compiler(compiled) => {
            if compiled.ir.world != *world {
                return Ok(());
            }
            typed_ir(world, &compiled.ir, roots);
            for dependency in &compiled.observed_dependencies {
                compile_dependency(roots, dependency);
            }
            diagnostics(roots, &compiled.diagnostics);
        }
        SlotResponse::Policy(policy) => {
            obligations(roots, &policy.obligations);
            for policy in &policy.policies {
                policy_roots(roots, policy);
            }
        }
        SlotResponse::Action(plan) => {
            roots
                .definitions
                .push(plan.source_operation.binding.clone());
            use world_protocol::actions::SourceMutation;
            let fields = match &plan.source_operation.mutation {
                SourceMutation::Insert { values } => values.iter().collect::<Vec<_>>(),
                SourceMutation::Update {
                    keys,
                    values,
                    expected,
                } => keys.iter().chain(values).chain(expected).collect(),
                SourceMutation::Delete { keys, expected } => keys.iter().chain(expected).collect(),
            };
            for field in fields {
                expression(roots, &field.expression);
            }
            for argument in &plan.arguments {
                value_roots(roots, &argument.value);
            }
            roots.dependencies.extend(plan.dependencies.clone());
            expression(roots, &plan.expected_effect);
        }
        SlotResponse::Reconcile(reconciled) => {
            roots.dependencies.extend(
                reconciled
                    .selected
                    .iter()
                    .cloned()
                    .map(|reference| ReadDependency::Assertion { reference }),
            );
            for cell in &reconciled.conflicts {
                subject(roots, &cell.subject);
                crate::query::retain_field(roots, cell.field.clone());
            }
            for draft in &reconciled.observations {
                crate::facts::assertions::observation_record_retention_roots(draft, roots);
            }
            roots.dependencies.extend(reconciled.dependencies.clone());
        }
        SlotResponse::Abstraction(contract) => {
            crate::abstraction::retain_contract(world, contract, roots)
        }
        SlotResponse::Evaluation(evaluation) => {
            roots.evidence.extend(evaluation.evidence.clone());
            diagnostics(roots, &evaluation.diagnostics);
        }
        SlotResponse::Context(context) => {
            view(world, &context.view, roots)?;
            if context.receipt.world == *world {
                crate::query::retain_read(roots, &context.receipt);
            }
        }
        SlotResponse::AgentBridge(bridge) => peer(world, &bridge.response, roots)?,
        SlotResponse::Storage(stored) => {
            for assertion in &stored.assertions {
                if assertion.reference.world == *world {
                    crate::facts::assertions::assertion_record_retention_roots(assertion, roots);
                }
            }
            model(world, roots, &stored.definitions);
            for evidence in &stored.evidence {
                if evidence.reference.world == *world {
                    roots.evidence.push(evidence.reference.clone());
                    crate::facts::assertions::evidence_retention_roots(evidence, roots);
                }
            }
            roots.resources.extend(
                stored
                    .revisions
                    .iter()
                    .map(|revision| revision.resource.clone()),
            );
        }
    }
    Ok(())
}

fn typed_ir(world: &WorldRef, ir: &TypedIr, roots: &mut RetentionRoots) {
    if ir.world != *world {
        return;
    }
    for definition in ir
        .definitions
        .iter()
        .filter(|definition| definition.reference.world == *world)
    {
        roots.definitions.push(definition.reference.clone());
        roots.scopes.push(definition.scope.clone());
        body(roots, &definition.reference, &definition.body);
        for annotation in &definition.annotations {
            value_type(roots, &annotation.result_type);
        }
        for policy in &definition.policy_refs {
            policy_roots(roots, policy);
        }
        roots.definitions.extend(
            definition
                .source_requirements
                .iter()
                .map(|source| source.binding.clone()),
        );
    }
    for dependency in &ir.dependencies.edges {
        compile_dependency(roots, dependency);
    }
}

fn compile_request(world: &WorldRef, request: &CompileRequest, roots: &mut RetentionRoots) {
    if request.world != *world {
        return;
    }
    roots.releases.push(request.base_release.clone());
    model(world, roots, &request.definitions);
    for scope in &request.scopes {
        roots.scopes.push(scope.id.clone());
        expression(roots, &scope.predicate);
    }
    if request.activation_lock.world == *world {
        for node in &request.activation_lock.nodes {
            roots.resources.push(ResourceRef::Package {
                id: node.implementation.install_id.clone(),
            });
            roots.resources.push(ResourceRef::Binding {
                id: node.binding_id.clone(),
            });
        }
    }
    for external in &request.external_contracts {
        roots.resources.push(ResourceRef::Package {
            id: external.implementation.install_id.clone(),
        });
        match &external.kind {
            world_protocol::compiler::ExternalContractKind::Function { reference }
            | world_protocol::compiler::ExternalContractKind::Source {
                binding: reference,
                ..
            } => roots.definitions.push(reference.clone()),
            world_protocol::compiler::ExternalContractKind::Policy { policy } => {
                policy_roots(roots, policy)
            }
            _ => {}
        }
    }
}

fn model(world: &WorldRef, roots: &mut RetentionRoots, definitions: &[Definition<DefinitionBody>]) {
    for definition in definitions
        .iter()
        .filter(|definition| definition.reference.world == *world)
    {
        let retained =
            crate::releases::definition_model_retention(std::slice::from_ref(definition));
        roots.scopes.extend(retained.scopes);
        roots.resources.extend(retained.resources);
        roots.definitions.extend(retained.definitions);
        roots.evidence.extend(retained.evidence);
        roots.schemas.extend(retained.schemas);
        roots.mappings.extend(retained.schema_mappings);
        for policy in retained.policies {
            policy_roots(roots, &policy);
        }
        if let DefinitionBody::SourceBinding(source) = &definition.body {
            source_binding(roots, &definition.reference, source);
        }
    }
}

fn body(roots: &mut RetentionRoots, reference: &DefinitionRef, body: &DefinitionBody) {
    roots
        .definitions
        .extend(crate::definitions::definition_references(body));
    roots
        .resources
        .extend(crate::definitions::definition_resources(body));
    if let DefinitionBody::SourceBinding(source) = body {
        source_binding(roots, reference, source);
    }
    if let DefinitionBody::PolicyBinding(binding) = body {
        roots.scopes.push(binding.scope.clone());
        policy_roots(roots, &binding.policy);
    }
}

fn source_binding(roots: &mut RetentionRoots, reference: &DefinitionRef, source: &SourceBinding) {
    roots.scopes.push(source.scope.clone());
    roots.schemas.push(source.schema.clone());
    roots.mappings.push(source.mapping.clone());
    roots.resources.push(ResourceRef::Source {
        id: source.source_id.clone(),
    });
    roots.dependencies.push(ReadDependency::SourceMapping {
        binding: reference.clone(),
        mapping: source.mapping.clone(),
        identity_rule: source.identity_rule.clone(),
        authority: source.authority.clone(),
    });
}

fn compile_dependency(roots: &mut RetentionRoots, dependency: &CompileDependency) {
    roots.definitions.push(dependency.dependent.clone());
    match &dependency.target {
        DependencyTarget::Definition(reference) => roots.definitions.push(reference.clone()),
        DependencyTarget::Schema(reference) => roots.schemas.push(reference.clone()),
        DependencyTarget::Policy(policy) => policy_roots(roots, policy),
        DependencyTarget::Implementation(implementation) => {
            roots.resources.push(ResourceRef::Package {
                id: implementation.install_id.clone(),
            })
        }
        DependencyTarget::Contract(_) | DependencyTarget::Config(_) | DependencyTarget::Unit(_) => {
        }
    }
}

fn view(world: &WorldRef, view: &WorldView, roots: &mut RetentionRoots) -> Result<(), Error> {
    if view.world != *world {
        return Ok(());
    }
    roots.scopes.push(view.scope.clone());
    roots.resources.push(ResourceRef::Task {
        id: view.task_id.clone(),
    });
    roots.definitions.extend(view.definitions.clone());
    for expression_value in view.hard_constraints.iter().chain(&view.stop_conditions) {
        expression(roots, expression_value);
    }
    crate::query::retain_views(roots, &view.rows, &view.objects, &view.relations);
    for proposal in &view.actions {
        if proposal.request.world == *world {
            crate::actions::operation_retention_roots(
                world,
                &world_protocol::operation::OperationResult::Proposal(proposal.clone()),
                roots,
            )?;
        }
    }
    for contract in &view.abstractions {
        crate::abstraction::retain_contract(world, contract, roots);
    }
    for receipt in &view.read_receipts {
        if receipt.world == *world {
            crate::query::retain_read(roots, receipt);
        }
    }
    Ok(())
}

fn peer(
    world: &WorldRef,
    response: &PeerResponse,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    use world_protocol::operation::OperationResult;
    match response {
        PeerResponse::Discover(description) => {
            if description.world != *world {
                return Ok(());
            }
            roots
                .releases
                .extend(description.active_release.iter().cloned());
            if let Some(head) = &description.active_release_head {
                roots.releases.push(head.release_id.clone());
            }
            for scope in &description.material_scopes {
                roots.scopes.push(scope.scope.clone());
            }
            if let Some(compile) = &description.editing_context {
                compile_request(world, compile, roots);
            }
        }
        PeerResponse::Query(page) if page.receipt.world == *world => {
            crate::query::retain_page(roots, page)
        }
        PeerResponse::Query(_) => {}
        PeerResponse::Explain(explanation) => {
            if explanation.conclusion.world != *world {
                return Ok(());
            }
            roots.dependencies.push(ReadDependency::Assertion {
                reference: explanation.conclusion.clone(),
            });
            roots.evidence.extend(explanation.visible_evidence.clone());
            for support in explanation
                .supports
                .iter()
                .filter(|support| support.reference.world == *world)
            {
                crate::facts::support::retain_support(roots, support);
            }
        }
        PeerResponse::ActionPropose(proposal) => {
            if proposal.request.world == *world {
                crate::actions::operation_retention_roots(
                    world,
                    &OperationResult::Proposal(proposal.clone()),
                    roots,
                )?;
            }
        }
        PeerResponse::Accepted(operation) => {
            if operation.world == *world {
                roots.resources.push(ResourceRef::Operation {
                    id: operation.operation_id.clone(),
                });
            }
        }
        PeerResponse::ActionStatus(status) => {
            crate::actions::operation_retention_roots(
                world,
                &OperationResult::Action(Box::new(status.clone())),
                roots,
            )?;
            if let Some(commit) = &status.commit {
                if commit.world == *world {
                    roots.resources.extend(
                        commit
                            .revisions
                            .iter()
                            .map(|revision| revision.resource.clone()),
                    );
                }
            }
        }
        PeerResponse::Change(change) => {
            if change.world != *world {
                return Ok(());
            }
            roots.resources.push(ResourceRef::ChangeSet {
                id: change.id.clone(),
            });
            roots.releases.push(change.base_release.clone());
            roots.evidence.extend(change.evidence.clone());
            roots.resources.extend(
                change
                    .cases
                    .iter()
                    .cloned()
                    .map(|id| ResourceRef::Case { id }),
            );
            crate::learning::retain_operations(roots, &change.operations);
        }
    }
    Ok(())
}

fn diagnostics(roots: &mut RetentionRoots, diagnostics: &[CompileDiagnostic]) {
    roots.definitions.extend(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.definition.clone()),
    );
}
fn subject(roots: &mut RetentionRoots, subject: &SubjectRef) {
    roots.resources.push(match subject {
        SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() },
        SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() },
    });
}
fn policy_roots(roots: &mut RetentionRoots, policy: &PolicyRef) {
    obligations(roots, &policy.obligations);
}
fn obligations(roots: &mut RetentionRoots, obligations: &[PolicyObligation]) {
    for obligation in obligations {
        if let PolicyObligation::Redact { fields } = obligation {
            roots.resources.extend(
                fields
                    .iter()
                    .cloned()
                    .map(|id| ResourceRef::Definition { id }),
            );
        }
    }
}
fn expression(roots: &mut RetentionRoots, expression: &world_protocol::expression::ExpressionIr) {
    crate::learning::retain_expression(roots, expression);
}
fn value_roots(roots: &mut RetentionRoots, value: &world_protocol::value::Value) {
    crate::definitions::value_resources(value, &mut roots.resources);
}
fn value_type(roots: &mut RetentionRoots, value_type: &world_protocol::value::ValueType) {
    roots
        .resources
        .extend(crate::definitions::value_type_resources(value_type));
}
