use crate::{
    owner::{self, Error},
    sources::{
        mapping,
        sync::{self, SyncError},
    },
    store::WorldTransaction,
};
use world_protocol::{
    api::WorldCommand, failure::FailureStage, operation::OperationResult, sources::MappingFailure,
};

pub(crate) async fn operation_retention_roots(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
    result: Option<&OperationResult>,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    match command {
        WorldCommand::ConfigureConnection(input) if input.connection.world == *tx.world() => {
            roots.scopes.push(input.connection.scope.clone());
        }
        WorldCommand::DiscoverSchema(input) if input.target_schema.world == *tx.world() => {
            roots.schemas.push(input.target_schema.clone());
            roots.schemas.extend(input.expected_schema.clone());
            if let Some(branch) = &input.branch {
                retain_branch(tx, branch, roots).await?;
            }
        }
        WorldCommand::SetBranchMapping(input) => {
            retain_branch(tx, &input.branch, roots).await?;
            roots.definitions.push(input.binding.clone());
            roots.mappings.push(input.mapping.reference.clone());
            roots.schemas.push(input.mapping.schema.clone());
            roots.definitions.push(input.mapping.type_ref.clone());
            roots.definitions.extend(
                input
                    .mapping
                    .fields
                    .iter()
                    .map(|field| field.property.clone()),
            );
            roots.definitions.extend(
                input
                    .mapping
                    .relations
                    .iter()
                    .map(|relation| relation.relation_type.clone()),
            );
        }
        WorldCommand::ApproveBranchSourceAuthority(input) => {
            retain_branch(tx, &input.branch, roots).await?;
            retain_authority(tx, &input.authority, roots)?;
        }
        WorldCommand::SetMapping(input) if input.binding.world == *tx.world() => {
            mapping::binding_retention_roots(tx, &input.binding, roots)
                .await
                .map_err(SyncError::Mapping)?;
            roots.mappings.push(input.mapping.reference.clone());
            roots.schemas.push(input.mapping.schema.clone());
            roots.definitions.push(input.mapping.type_ref.clone());
            roots.definitions.extend(
                input
                    .mapping
                    .fields
                    .iter()
                    .map(|field| field.property.clone()),
            );
            roots.definitions.extend(
                input
                    .mapping
                    .relations
                    .iter()
                    .map(|relation| relation.relation_type.clone()),
            );
        }
        WorldCommand::StartSync(input) | WorldCommand::StopSync(input)
            if input.binding.world == *tx.world() =>
        {
            mapping::binding_retention_roots(tx, &input.binding, roots)
                .await
                .map_err(SyncError::Mapping)?;
        }
        _ => {}
    }
    match result {
        Some(OperationResult::Schema(schema)) if schema.reference.world == *tx.world() => {
            roots.schemas.push(schema.reference.clone());
        }
        Some(OperationResult::Mapping {
            binding,
            mapping: reference,
        }) if binding.world == *tx.world() => {
            if matches!(command, WorldCommand::SetBranchMapping(_)) {
                roots.definitions.push(binding.clone());
            } else {
                mapping::binding_retention_roots(tx, binding, roots)
                    .await
                    .map_err(SyncError::Mapping)?;
            }
            roots.mappings.push(reference.clone());
        }
        Some(OperationResult::BranchSourceAuthority { branch, authority }) => {
            retain_branch(tx, branch, roots).await?;
            retain_authority(tx, authority, roots)?;
        }
        Some(OperationResult::Sync {
            binding,
            checkpoint,
        }) if binding.world == *tx.world() => {
            mapping::binding_retention_roots(tx, binding, roots)
                .await
                .map_err(SyncError::Mapping)?;
            retain_checkpoint(tx, checkpoint, roots).await?;
        }
        Some(OperationResult::Reconciled { checkpoints }) => {
            for checkpoint in checkpoints {
                if checkpoint.binding.world == *tx.world() {
                    retain_checkpoint(tx, checkpoint, roots).await?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

async fn retain_branch(
    tx: &WorldTransaction<'_>,
    reference: &world_protocol::releases::BranchRef,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if &reference.world != tx.world() {
        return Err(SyncError::from(MappingFailure::CrossWorld).into());
    }
    let branch = crate::releases::read_branch_revision(tx, reference)
        .await?
        .ok_or_else(|| Error::from(SyncError::from(MappingFailure::RevisionMismatch)))?;
    roots.branches.push(reference.clone());
    roots.releases.push(branch.basis.release_id);
    for definition in branch.compile.definitions {
        roots.definitions.push(definition.reference);
        roots.definitions.extend(definition.dependencies);
        roots.scopes.push(definition.scope);
        roots.evidence.extend(definition.evidence);
        if let world_protocol::definitions::DefinitionBody::SourceBinding(binding) = definition.body
        {
            roots.schemas.push(binding.schema);
            roots.mappings.push(binding.mapping);
        }
    }
    Ok(())
}

fn retain_authority(
    tx: &WorldTransaction<'_>,
    authority: &world_protocol::facts::SourceAuthority,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if &authority.world != tx.world() || authority.binding.world != authority.world {
        return Err(SyncError::from(MappingFailure::CrossWorld).into());
    }
    roots.definitions.push(authority.binding.clone());
    roots.scopes.push(authority.scope.clone());
    roots
        .resources
        .push(world_protocol::ids::ResourceRef::Source {
            id: authority.source_id.clone(),
        });
    match &authority.ownership {
        world_protocol::facts::AuthorityOwnership::Properties { properties } => {
            roots.definitions.extend(properties.clone())
        }
        world_protocol::facts::AuthorityOwnership::RelationRoles { relation_type, .. } => {
            roots.definitions.push(relation_type.clone())
        }
    }
    Ok(())
}

async fn retain_checkpoint(
    tx: &WorldTransaction<'_>,
    checkpoint: &world_protocol::sources::SourceCheckpoint,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    mapping::binding_retention_roots(tx, &checkpoint.binding, roots)
        .await
        .map_err(SyncError::Mapping)?;
    for position in [
        &checkpoint.captured,
        &checkpoint.applied,
        &checkpoint.acknowledged,
        &checkpoint.projected,
    ]
    .into_iter()
    .flatten()
    {
        roots
            .dependencies
            .push(world_protocol::provenance::ReadDependency::Source {
                position: position.clone(),
                binding: checkpoint.binding.clone(),
            });
    }
    Ok(())
}

pub(crate) async fn step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &owner::StepRecord,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if step.kind == "sources.service" {
        let segment: sync::SourceSegment = serde_json::from_value(step.checkpoint.clone())
            .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
        let parent = &segment.parent;
        let assignment = &parent.assignment;
        if assignment.world != *tx.world()
            || assignment.binding.world != assignment.world
            || assignment.mapping.world != assignment.world
            || assignment.schema.world != assignment.world
            || assignment.identity_rule.world != assignment.world
            || parent.request.binding != assignment.binding
            || parent.request.expected_revision != assignment.binding.revision
            || segment.run_id != step.run_id
            || segment.run_id == parent.owner_run
            || segment.budget.deadline.is_none()
            || crate::definitions::canonical_digest(&segment)? != step.input_digest
        {
            return Err(Error::internal(FailureStage::Read));
        }
        let original = owner::read_run(tx, &parent.owner_run).await?;
        let operation = owner::ledger::read(tx, &original.operation.operation_id).await?;
        if original.operation.world != *tx.world()
            || operation.receipt.progress.run_id.as_ref() != Some(&parent.owner_run)
            || !matches!(operation.input.command()?, WorldCommand::StartSync(request) if request == &parent.request)
        {
            return Err(Error::internal(FailureStage::Read));
        }
        roots.definitions.push(assignment.binding.clone());
        roots.mappings.push(assignment.mapping.clone());
        roots.schemas.push(assignment.schema.clone());
        roots.scopes.push(assignment.scope.clone());
        roots.releases.extend(original.release_id);
        roots
            .resources
            .push(world_protocol::ids::ResourceRef::Source {
                id: assignment.source_id.clone(),
            });
        if let Some(result) = &step.result {
            let checkpoint: sync::Checkpoint = serde_json::from_value(result.clone())
                .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
            if checkpoint.source.binding != assignment.binding
                || [
                    &checkpoint.source.captured,
                    &checkpoint.source.applied,
                    &checkpoint.source.acknowledged,
                    &checkpoint.source.projected,
                ]
                .into_iter()
                .flatten()
                .any(|position| {
                    position.source_id != assignment.source_id
                        || position.partition != assignment.partition
                })
            {
                return Err(Error::internal(FailureStage::Read));
            }
            retain_checkpoint(tx, &checkpoint.source, roots).await?;
        }
        return Ok(());
    }
    if step.kind != "sources.discover" {
        return Err(Error::internal(FailureStage::Read));
    }
    if let Some(result) = &step.result {
        let schema: world_protocol::sources::SchemaDiscovery =
            serde_json::from_value(result.clone())
                .map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?;
        if schema.reference.world != *tx.world() {
            return Err(Error::internal(FailureStage::Read));
        }
        roots.schemas.push(schema.reference);
    }
    Ok(())
}
