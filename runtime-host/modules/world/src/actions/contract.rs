use super::rejected;
use crate::{authorization, owner::Error, store::WorldTransaction};
use serde::{Deserialize, Serialize};
use world_protocol::{
    actions::{ActionContract, ActionFailure, ActionProposalRequest, SourceMutation},
    api::WorldCommand,
    authorization::{AccessMode, AccessScope, ActualImpact, PolicyRef},
    definitions::{Definition, DefinitionBody},
    expression::Effect,
    failure::{FailureStage, FieldPath, InputFailure},
    identity::{IdentityRecord, SubjectRef},
    ids::*,
    query::{PageRequest, QueryArgument, QueryRequest, ReadMode},
    releases::{BranchRef, Release},
    time::Timestamp,
    value::Value,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Context {
    pub release_id: ReleaseId,
    pub branch: Option<BranchRef>,
    pub scope: ScopeId,
    pub at: Timestamp,
    pub compensation_intent: Option<EffectIntentId>,
}

pub(crate) async fn action(
    tx: &WorldTransaction<'_>,
    reference: &DefinitionRef,
) -> Result<Definition<ActionContract>, Error> {
    let definition = crate::releases::read_definition_exact(tx, reference)
        .await?
        .ok_or_else(|| {
            rejected(
                ActionFailure::ContractMissing {
                    reference: reference.clone(),
                },
                FailureStage::Validate,
            )
        })?;
    let DefinitionBody::ActionContract(body) = definition.body else {
        return Err(input("action"));
    };
    Ok(Definition {
        reference: definition.reference,
        scope: definition.scope,
        valid_time: definition.valid_time,
        body,
        content_digest: definition.content_digest,
        dependencies: definition.dependencies,
        evidence: definition.evidence,
        previous_ref: definition.previous_ref,
        lifecycle: definition.lifecycle,
    })
}

pub(super) async fn release(
    tx: &WorldTransaction<'_>,
    context: &Context,
) -> Result<Release, Error> {
    let mut release = crate::releases::read_release(tx, &context.release_id)
        .await?
        .ok_or_else(|| input("releaseId"))?;
    if let Some(reference) = &context.branch {
        let branch = crate::releases::read_branch_revision(tx, reference)
            .await?
            .ok_or_else(|| input("branch"))?;
        if branch.basis.release_id != release.id {
            return Err(input("branch.basis"));
        }
        release = crate::query::proposed_branch_model(&branch, release, &world_protocol::evaluation::EvaluationArm::Candidate)?;
    }
    Ok(release)
}

pub(super) async fn initial_context(
    tx: &WorldTransaction<'_>,
    request: &ActionProposalRequest,
) -> Result<Context, Error> {
    if request.world != *tx.world() || request.action.world != *tx.world() {
        return Err(input("world"));
    }
    let (release_id, branch) = match &request.branch_id {
        Some(id) => {
            let branch = crate::releases::read_branch(tx, id)
                .await?
                .ok_or_else(|| input("branchId"))?;
            (
                branch.basis.release_id.clone(),
                Some(BranchRef {
                    world: branch.world,
                    id: branch.id,
                    revision: branch.revision,
                }),
            )
        }
        None => (
            crate::releases::read_active_release(tx)
                .await?
                .ok_or_else(|| input("releaseId"))?,
            None,
        ),
    };
    let definition = action(tx, &request.action).await?;
    let context = Context {
        release_id,
        branch,
        scope: definition.scope.clone(),
        at: tx.now().await?,
        compensation_intent: None,
    };
    let release = release(tx, &context).await?;
    if !release.definitions.iter().any(|item| item.reference == request.action && matches!(&item.body, DefinitionBody::ActionContract(body) if body == &definition.body)) {
        return Err(input("action.release"));
    }
    Ok(context)
}

pub(super) async fn command_context(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<(Context, ActionProposalRequest), Error> {
    match command {
        WorldCommand::ActionPropose(request) => {
            Ok((initial_context(tx, request).await?, request.clone()))
        }
        WorldCommand::ActionApprove(request) => {
            let (proposal, context) =
                super::proposal::read_proposal(tx, &request.proposal_id).await?;
            if proposal.digest != request.proposal_digest {
                return Err(rejected(
                    ActionFailure::ProposalDigestMismatch,
                    FailureStage::Validate,
                ));
            }
            Ok((context, proposal.request))
        }
        WorldCommand::ActionSubmit(request) => {
            let (proposal, context) =
                super::proposal::read_proposal(tx, &request.proposal_id).await?;
            if proposal.digest != request.proposal_digest || request.world != *tx.world() {
                return Err(rejected(
                    ActionFailure::ProposalDigestMismatch,
                    FailureStage::Validate,
                ));
            }
            Ok((context, proposal.request))
        }
        WorldCommand::ActionReconcile(key) | WorldCommand::ActionCompensate(key) => {
            let (intent, execution, _) =
                super::intent::read_operation_intent(tx, &key.operation_id).await?;
            let (proposal, _) = super::proposal::read_proposal(tx, &execution.proposal_id).await?;
            if key.world != *tx.world() || proposal.request.action != intent.action {
                return Err(input("operation"));
            }
            Ok((execution.context, proposal.request))
        }
        _ => Err(input("command")),
    }
}

pub(crate) async fn run_basis(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<(ReleaseId, ActivationLockId, world_protocol::budget::Budget), Error> {
    let (context, request) = command_context(tx, command).await?;
    let contract = action(tx, &request.action).await?;
    if matches!(command, WorldCommand::ActionCompensate(_)) {
        let compensation = contract
            .body
            .compensation
            .as_ref()
            .ok_or_else(|| input("compensation"))?;
        let release = crate::releases::read_active_model(tx)
            .await?
            .ok_or_else(|| input("releaseId"))?;
        let target = release
            .definitions
            .iter()
            .find(|definition| definition.reference == compensation.action)
            .ok_or_else(|| input("compensation.action"))?;
        let DefinitionBody::ActionContract(target) = &target.body else {
            return Err(input("compensation.action"));
        };
        return Ok((
            release.id,
            release.artifact.activation_lock_id,
            target.budget.clone(),
        ));
    }
    let release = release(tx, &context).await?;
    Ok((
        release.id,
        release.artifact.activation_lock_id,
        contract.body.budget,
    ))
}

pub(crate) async fn run_branch(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<Option<BranchId>, Error> {
    Ok(command_context(tx, command)
        .await?
        .0
        .branch
        .map(|branch| branch.id))
}

pub(crate) async fn approval(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<Option<world_protocol::authorization::ApprovalBinding>, Error> {
    let WorldCommand::ActionSubmit(request) = command else {
        return Ok(None);
    };
    let (proposal, _) = super::proposal::read_proposal(tx, &request.proposal_id).await?;
    if request.world != *tx.world() || request.proposal_digest != proposal.digest {
        return Err(rejected(
            ActionFailure::ProposalDigestMismatch,
            FailureStage::Admission,
        ));
    }
    if let Some(binding) = &request.approval {
        if binding.action_digest != proposal.digest
            || binding.impact_digest != proposal.impact.digest
            || binding.contract != proposal.request.action
        {
            return Err(
                world_protocol::authorization::AuthorizationFailure::ApprovalDigestMismatch.into(),
            );
        }
    }
    Ok(request.approval.clone())
}

pub(crate) async fn policies(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<Vec<PolicyRef>, Error> {
    let (_, request) = command_context(tx, command).await?;
    Ok(action(tx, &request.action).await?.body.policies)
}

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<ActualImpact, Error> {
    if let WorldCommand::ActionSubmit(request) = command {
        let (proposal, _) = super::read_proposal(tx, &request.proposal_id).await?;
        if proposal.digest != request.proposal_digest || request.world != *tx.world() {
            return Err(rejected(
                ActionFailure::ProposalDigestMismatch,
                FailureStage::Admission,
            ));
        }
        return Ok(proposal.impact);
    }
    if let WorldCommand::ActionApprove(request) = command {
        let (proposal, _) = super::read_proposal(tx, &request.proposal_id).await?;
        if proposal.digest != request.proposal_digest {
            return Err(rejected(
                ActionFailure::ProposalDigestMismatch,
                FailureStage::Admission,
            ));
        }
        let mut access = proposal.impact.access;
        for scope in &mut access {
            scope.modes = vec![AccessMode::Approve];
        }
        return Ok(authorization::actual_impact(
            access,
            proposal.impact.effects,
            proposal.impact.labels,
            proposal.impact.state,
            proposal.impact.source_ids,
        )?);
    }
    if let WorldCommand::ActionCompensate(_) = command {
        let (context, request) = command_context(tx, command).await?;
        return Ok(crate::query::action_impact(
            tx,
            &request.action,
            &context.release_id,
            request.branch_id.as_ref(),
            &request.arguments,
            &context.scope,
            &tx.now().await?,
        )
        .await?);
    }
    current_impact(tx, command).await
}

pub(crate) fn current_impact<'a>(
    tx: &'a WorldTransaction<'_>,
    command: &'a WorldCommand,
) -> crate::store::StoreFuture<'a, ActualImpact, Error> {
    Box::pin(async move {
        let (mut context, request) = command_context(tx, command).await?;
        context.at = tx.now().await?;
        let definition = action(tx, &request.action).await?;
        validate_targets(tx, &definition.body, &request).await?;
        let mut impact = crate::query::action_impact(
            tx,
            &request.action,
            &context.release_id,
            request.branch_id.as_ref(),
            &request.arguments,
            &context.scope,
            &context.at,
        )
        .await?;
        let verifier = verifier_request(&request, &definition.body, &context, &context.at);
        merge(
            &mut impact,
            crate::query::impact_in_transaction(tx, &verifier, &context.scope).await?,
        );
        let model = release(tx, &context).await?;
        let current = crate::releases::read_active_model(tx)
            .await?
            .ok_or_else(|| input("releaseId"))?;
        let source = model
            .definitions
            .iter()
            .find(|item| item.reference == definition.body.source_operation.binding)
            .ok_or_else(|| input("sourceOperation.binding"))?;
        let DefinitionBody::SourceBinding(binding) = &source.body else {
            return Err(input("sourceOperation.binding"));
        };
        if binding.resource != definition.body.source_operation.resource {
            return Err(input("sourceOperation.resource"));
        }
        let mode = if matches!(
            definition.body.source_operation.mutation,
            SourceMutation::Delete { .. }
        ) {
            AccessMode::Delete
        } else {
            AccessMode::Write
        };
        let mut modes = vec![AccessMode::Read, mode];
        if matches!(command, WorldCommand::ActionApprove(_)) {
            modes = vec![AccessMode::Approve];
        }
        impact.access.push(AccessScope {
            resources: vec![ResourceRef::Definition {
                id: request.action.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Execute, AccessMode::Read],
            scope: definition.scope.clone(),
            valid_time: None,
        });
        for scope in [source.scope.clone(), binding.scope.clone()] {
            impact.access.push(AccessScope {
                resources: vec![ResourceRef::Source {
                    id: binding.source_id.clone(),
                }],
                fields: Vec::new(),
                modes: modes.clone(),
                scope,
                valid_time: None,
            });
        }
        for mapping in &binding.field_mapping {
            let exact = model
                .definitions
                .iter()
                .find(|item| item.reference == mapping.property)
                .ok_or_else(|| input("sourceOperation.fields"))?;
            for property in std::iter::once(exact).chain(
                current
                    .definitions
                    .iter()
                    .filter(|item| item.reference.id == mapping.property.id),
            ) {
                let DefinitionBody::Property(body) = &property.body else {
                    return Err(input("sourceOperation.fields"));
                };
                impact.labels.extend(body.access_labels.clone());
                impact.access.push(AccessScope {
                    resources: vec![ResourceRef::Source {
                        id: binding.source_id.clone(),
                    }],
                    fields: vec![mapping.property.clone()],
                    modes: modes.clone(),
                    scope: property.scope.clone(),
                    valid_time: None,
                });
            }
        }
        for target in &request.targets {
            impact.access.push(AccessScope {
                resources: vec![resource(target)],
                fields: definition.body.writes.clone(),
                modes: vec![AccessMode::Read, AccessMode::Write],
                scope: context.scope.clone(),
                valid_time: None,
            });
        }
        impact.source_ids.push(binding.source_id.clone());
        impact.effects.extend(definition.body.effects.clone());
        impact.effects.extend([Effect::Pure, Effect::SourceRead]);
        if matches!(command, WorldCommand::ActionApprove(_)) {
            for scope in &mut impact.access {
                scope.modes = vec![AccessMode::Approve];
            }
        }
        if matches!(command, WorldCommand::ActionPropose(_) | WorldCommand::ActionSubmit(_)) {
            merge(&mut impact, planning_impact(tx, &model, &context.scope).await?);
        }
        if matches!(command, WorldCommand::ActionSubmit(_))
            && let Some(id) = &context.compensation_intent
        {
            let (original, _, _) = super::intent::read_intent(tx, id).await?;
            impact = compensation_impact(tx, impact, &original).await?;
        }
        Ok(authorization::actual_impact(
            impact.access,
            impact.effects,
            impact.labels,
            impact.state,
            impact.source_ids,
        )?)
    })
}

async fn planning_impact(tx: &WorldTransaction<'_>, model: &Release, scope: &ScopeId) -> Result<ActualImpact, Error> {
    use world_protocol::bindings::SlotKind;
    let graph = crate::extensions::bindings::read_graph_in_transaction(tx, &model.artifact.activation_lock_id).await?;
    let mut resources = std::collections::BTreeSet::new();
    for slot in [SlotKind::Policy, SlotKind::Action] {
        let bindings: std::collections::BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == slot)
            .map(|node| node.binding_id.clone()).collect();
        if bindings.len() != 1 { return Err(input("planning.binding")); }
        let root = graph.composition_order(bindings.iter().next().expect("one planning composition"))
            .map_err(crate::extensions::bindings::BindingError::from)?.into_iter()
            .find(|node| graph.node(node).is_ok_and(|node| node.slot == slot)).ok_or_else(|| input("planning.binding"))?;
        for node in graph.closure_nodes(&root).map_err(crate::extensions::bindings::BindingError::from)? {
            resources.insert(ResourceRef::Binding { id: graph.node(&node).map_err(crate::extensions::bindings::BindingError::from)?.binding_id.clone() });
        }
    }
    Ok(authorization::actual_impact(vec![AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(),
        modes: vec![AccessMode::Execute], scope: scope.clone(), valid_time: None }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?)
}

pub(crate) async fn compensation_impact(
    tx: &WorldTransaction<'_>,
    mut impact: ActualImpact,
    original: &world_protocol::actions::EffectIntent,
) -> Result<ActualImpact, Error> {
    let (durable, execution, _) = super::intent::read_intent(tx, &original.id).await?;
    if durable != *original {
        return Err(input("compensation.intent"));
    }
    merge(
        &mut impact,
        crate::query::action_impact(
            tx,
            &original.action,
            &execution.context.release_id,
            None,
            &original.argument_values,
            &execution.context.scope,
            &tx.now().await?,
        )
        .await?,
    );
    Ok(authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )?)
}

pub(crate) fn verifier_request(
    request: &ActionProposalRequest,
    action: &ActionContract,
    context: &Context,
    at: &Timestamp,
) -> QueryRequest {
    QueryRequest {
        world: request.world.clone(),
        branch_id: request.branch_id.clone(),
        release_id: Some(context.release_id.clone()),
        query: action.verifier.query.clone(),
        arguments: request.arguments.clone(),
        read_mode: ReadMode::Authoritative,
        valid_at: Some(at.clone()),
        known_at: None,
        page: PageRequest {
            limit: action.verifier.query.limit,
            cursor: None,
        },
    }
}

pub(crate) async fn targets(
    tx: &WorldTransaction<'_>,
    action_ref: &DefinitionRef,
    arguments: &[QueryArgument],
) -> Result<Vec<SubjectRef>, Error> {
    resolve_targets(tx, &action(tx, action_ref).await?.body, arguments).await
}

async fn validate_targets(
    tx: &WorldTransaction<'_>,
    contract: &ActionContract,
    request: &ActionProposalRequest,
) -> Result<(), Error> {
    let targets = resolve_targets(tx, contract, &request.arguments).await?;
    if targets.iter().collect::<std::collections::BTreeSet<_>>() != request.targets.iter().collect()
        || targets.len() != request.targets.len()
    {
        return Err(input("targets"));
    }
    Ok(())
}

async fn resolve_targets(
    tx: &WorldTransaction<'_>,
    contract: &ActionContract,
    arguments: &[QueryArgument],
) -> Result<Vec<SubjectRef>, Error> {
    let mut targets = std::collections::BTreeSet::new();
    for target in &contract.targets {
        let argument = arguments
            .iter()
            .find(|argument| argument.parameter_id == target.parameter_id)
            .ok_or_else(|| input("targets"))?;
        let subject = match &argument.value {
            Value::Object { id } => SubjectRef::Object { id: id.clone() },
            Value::Relation { id } => SubjectRef::Relation { id: id.clone() },
            _ => return Err(input("targets")),
        };
        let identity = crate::identity::get_in_transaction(tx, &subject)
            .await
            .map_err(|error| Error::from(crate::facts::assertions::Error::from(error)))?
            .ok_or_else(|| input("targets"))?;
        let type_id = match &identity.record {
            IdentityRecord::Object(object) => &object.type_id,
            IdentityRecord::Relation(relation) => &relation.type_id,
        };
        if type_id != &target.type_ref.id || target.type_ref.world != *tx.world() {
            return Err(input("targets.type"));
        }
        targets.insert(subject);
    }
    Ok(targets.into_iter().collect())
}
fn resource(subject: &SubjectRef) -> ResourceRef {
    match subject {
        SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() },
        SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() },
    }
}
pub(super) fn merge(target: &mut ActualImpact, other: ActualImpact) {
    target.access.extend(other.access);
    target.effects.extend(other.effects);
    target.labels.extend(other.labels);
    target.state.extend(other.state);
    target.source_ids.extend(other.source_ids);
}
pub(super) fn input(field: &str) -> Error {
    rejected(
        ActionFailure::Input {
            failure: InputFailure::InvalidValue {
                field: FieldPath(field.split('.').map(str::to_owned).collect()),
            },
        },
        FailureStage::Validate,
    )
}
