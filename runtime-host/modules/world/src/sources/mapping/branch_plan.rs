use super::{MappingError, compile_plan};
use crate::store::{WorldSnapshot, WorldTransaction};
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    facts::SourceAuthority,
    ids::DefinitionRef,
    releases::{BranchRef, WorldBranch},
    sources::{
        CompileSourceRequest, CompiledSourcePlan, MappingFailure, SchemaDiscovery, SchemaMapping,
    },
};

pub(crate) async fn compile_branch_binding(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
    reference: &DefinitionRef,
) -> Result<CompiledSourcePlan, MappingError> {
    let model = crate::releases::read_branch_revision(tx, branch)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let binding = source_binding(&model, reference)?;
    let schema = super::read_schema(tx, &binding.body.schema)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let mapping = super::read_mapping(tx, &binding.body.mapping)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let authority = super::read_branch_authority(tx, branch, reference, &binding.body.authority)
        .await?
        .ok_or(MappingFailure::AuthorityMismatch)?;
    compile(&model, binding, schema, mapping, authority)
}

pub(crate) async fn compile_branch_binding_snapshot(
    snapshot: &WorldSnapshot<'_>,
    branch: &BranchRef,
    reference: &DefinitionRef,
) -> Result<CompiledSourcePlan, MappingError> {
    let model = crate::releases::read_branch_revision_snapshot(snapshot, branch)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let binding = source_binding(&model, reference)?;
    let schema = super::read_schema_snapshot(snapshot, &binding.body.schema)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let mapping = super::read_mapping_snapshot(snapshot, &binding.body.mapping)
        .await?
        .ok_or(MappingFailure::RevisionMismatch)?;
    let authority =
        super::read_branch_authority_snapshot(snapshot, branch, reference, &binding.body.authority)
            .await?
            .ok_or(MappingFailure::AuthorityMismatch)?;
    compile(&model, binding, schema, mapping, authority)
}

fn typed<T: Clone>(definition: &Definition<DefinitionBody>, body: &T) -> Definition<T> {
    Definition {
        reference: definition.reference.clone(),
        scope: definition.scope.clone(),
        valid_time: definition.valid_time.clone(),
        body: body.clone(),
        content_digest: definition.content_digest.clone(),
        dependencies: definition.dependencies.clone(),
        evidence: definition.evidence.clone(),
        previous_ref: definition.previous_ref.clone(),
        lifecycle: definition.lifecycle.clone(),
    }
}
pub(super) fn source_binding(
    model: &WorldBranch,
    reference: &DefinitionRef,
) -> Result<Definition<world_protocol::sources::SourceBinding>, MappingError> {
    if reference.world != model.world {
        return Err(MappingFailure::CrossWorld.into());
    }
    let definition = model
        .compile
        .definitions
        .iter()
        .find(|definition| definition.reference == *reference)
        .ok_or(MappingFailure::RevisionMismatch)?;
    let DefinitionBody::SourceBinding(body) = &definition.body else {
        return Err(MappingFailure::RevisionMismatch.into());
    };
    Ok(typed(definition, body))
}
fn compile(
    model: &WorldBranch,
    binding: Definition<world_protocol::sources::SourceBinding>,
    schema: SchemaDiscovery,
    mapping: SchemaMapping,
    authority: SourceAuthority,
) -> Result<CompiledSourcePlan, MappingError> {
    let mut field_definitions = Vec::new();
    for field in &mapping.fields {
        if field_definitions.iter().any(
            |definition: &Definition<world_protocol::definitions::Property>| {
                definition.reference == field.property
            },
        ) {
            continue;
        }
        let definition = model
            .compile
            .definitions
            .iter()
            .find(|definition| definition.reference == field.property)
            .ok_or(MappingFailure::RevisionMismatch)?;
        let DefinitionBody::Property(body) = &definition.body else {
            return Err(MappingFailure::RevisionMismatch.into());
        };
        field_definitions.push(typed(definition, body));
    }
    let mut relation_definitions = Vec::new();
    for relation in &mapping.relations {
        let definition = model
            .compile
            .definitions
            .iter()
            .find(|definition| definition.reference == relation.relation_type)
            .ok_or(MappingFailure::RevisionMismatch)?;
        let DefinitionBody::RelationType(body) = &definition.body else {
            return Err(MappingFailure::RevisionMismatch.into());
        };
        relation_definitions.push(typed(definition, body));
    }
    Ok(compile_plan(CompileSourceRequest {
        binding,
        schema,
        mapping,
        authority,
        field_definitions,
        relation_definitions,
    })?)
}
