use serde::Serialize;
use sha2::{Digest as _, Sha256};
use world_protocol::{
    compiler::{ActionIr, ActionManifestArtifact, CompileFailure, CompileRequest, CompileTarget, GeneratedArtifact, QueryPlanArtifact, ToolCatalogArtifact, TypedIr, ValidatorArtifact},
    definitions::DefinitionBody,
    failure::FieldPath,
    ids::Digest,
};

use super::sdk;

pub(super) fn generate(
    request: &CompileRequest, ir: &TypedIr, previous: Option<(&TypedIr, &[GeneratedArtifact])>,
) -> Result<Vec<GeneratedArtifact>, CompileFailure> {
    if let Some((_, outputs)) = previous { validate(outputs)?; }
    let mut outputs = Vec::new();
    for target in &request.targets {
        if let Some((old, artifacts)) = previous {
            if unchanged(*target, old, ir) {
                if let Some(artifact) = artifacts.iter().find(|artifact| artifact.kind == *target) {
                    outputs.push(artifact.clone());
                    continue;
                }
            }
        }
        let (_, path, bytes) = match target {
            CompileTarget::QueryPlan => ("query-plan", "query-plan.json", json(&QueryPlanArtifact { ir_version: ir.ir_version.clone(), ir: ir.clone() })?),
            CompileTarget::Validator => ("validator", "validators.json", json(&ValidatorArtifact { ir_version: ir.ir_version.clone(), definitions: ir.definitions.clone() })?),
            CompileTarget::ActionManifest => {
                let actions: Vec<_> = ir.definitions.iter().filter_map(|definition| match &definition.body {
                    DefinitionBody::ActionContract(contract) => Some(ActionIr {
                        reference: definition.reference.clone(), contract: contract.clone(), checked_parameters: contract.parameters.clone(),
                        checked_result: contract.result_type.clone(), policies: definition.policy_refs.clone(),
                    }), _ => None,
                }).collect();
                ("action-manifest", "actions.json", json(&ActionManifestArtifact { ir_version: ir.ir_version.clone(), actions })?)
            }
            CompileTarget::ToolCatalog => {
                let tools: Vec<_> = ir.definitions.iter().filter(|definition| matches!(definition.body,
                    DefinitionBody::ConceptView(_) | DefinitionBody::Function(_) | DefinitionBody::ActionContract(_))).cloned().collect();
                ("tool-catalog", "tools.json", json(&ToolCatalogArtifact { ir_version: ir.ir_version.clone(), tools })?)
            }
            CompileTarget::TypeScriptSdk => ("typescript-sdk", "world.ts", sdk::typescript(ir)?.into_bytes()),
            CompileTarget::RustSdk => ("rust-sdk", "world.rs", sdk::rust(ir)?.into_bytes()),
        };
        let contract = world_protocol::compiler::artifact_contract(*target).map_err(|_| CompileFailure::ArtifactInvalid { field: FieldPath(vec!["contract".into()]) })?;
        outputs.push(GeneratedArtifact {
            kind: *target, definition: None, schema_digest: contract.schema_digest.clone(), contract,
            relative_path: Some(path.into()), content_digest: hash(&bytes)?, bytes,
        });
    }
    validate(&outputs)?;
    Ok(outputs)
}

/// Compare each artifact's actual input, not the entire compilation cache identity.
fn unchanged(target: CompileTarget, old: &TypedIr, current: &TypedIr) -> bool {
    if old.ir_version != current.ir_version || old.world != current.world { return false; }
    match target {
        CompileTarget::QueryPlan => old == current,
        CompileTarget::Validator => old.definitions == current.definitions,
        CompileTarget::ActionManifest => {
            let actions = |ir: &TypedIr| ir.definitions.iter().filter_map(|definition| match &definition.body {
                DefinitionBody::ActionContract(contract) => Some(ActionIr {
                    reference: definition.reference.clone(), contract: contract.clone(), checked_parameters: contract.parameters.clone(),
                    checked_result: contract.result_type.clone(), policies: definition.policy_refs.clone(),
                }), _ => None,
            }).collect::<Vec<_>>();
            actions(old) == actions(current)
        }
        CompileTarget::ToolCatalog => old.definitions.iter().filter(|definition| matches!(definition.body,
            DefinitionBody::ConceptView(_) | DefinitionBody::Function(_) | DefinitionBody::ActionContract(_)))
            .eq(current.definitions.iter().filter(|definition| matches!(definition.body,
                DefinitionBody::ConceptView(_) | DefinitionBody::Function(_) | DefinitionBody::ActionContract(_)))),
        CompileTarget::TypeScriptSdk | CompileTarget::RustSdk => old.definitions.iter().map(|definition| (&definition.reference, &definition.body))
            .eq(current.definitions.iter().map(|definition| (&definition.reference, &definition.body))),
    }
}

pub(super) fn json(value: &impl Serialize) -> Result<Vec<u8>, CompileFailure> {
    serde_json::to_vec(value).map_err(|_| CompileFailure::ArtifactInvalid { field: FieldPath(vec!["serialization".into()]) })
}

pub(super) fn hash(bytes: &[u8]) -> Result<Digest, CompileFailure> {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).map_err(|_| CompileFailure::InternalFault)
}

pub(crate) fn validate(outputs: &[GeneratedArtifact]) -> Result<(), CompileFailure> {
    let mut paths = std::collections::BTreeSet::new();
    for (index, output) in outputs.iter().enumerate() {
        let field = FieldPath(vec!["outputs".into(), index.to_string()]);
        let expected_contract = world_protocol::compiler::artifact_contract(output.kind).map_err(|_| CompileFailure::ArtifactInvalid { field: field.clone() })?;
        if output.bytes.is_empty() || hash(&output.bytes)? != output.content_digest || output.contract != expected_contract || output.contract.schema_digest != output.schema_digest {
            return Err(CompileFailure::ArtifactInvalid { field });
        }
        if let Some(path) = &output.relative_path {
            if path.is_empty() || path.contains('\\') || path.starts_with('/') || path.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
                || !paths.insert(path) { return Err(CompileFailure::ArtifactInvalid { field }); }
        }
        match output.kind {
            CompileTarget::QueryPlan => {
                let payload: QueryPlanArtifact = decode(output, field.clone())?;
                if payload.ir_version != super::IR_VERSION || payload.ir.ir_version != payload.ir_version { return Err(CompileFailure::ArtifactInvalid { field }); }
            }
            CompileTarget::Validator => {
                let payload: ValidatorArtifact = decode(output, field.clone())?;
                if payload.ir_version != super::IR_VERSION { return Err(CompileFailure::ArtifactInvalid { field }); }
            }
            CompileTarget::ToolCatalog => {
                let payload: ToolCatalogArtifact = decode(output, field.clone())?;
                if payload.ir_version != super::IR_VERSION { return Err(CompileFailure::ArtifactInvalid { field }); }
            }
            CompileTarget::ActionManifest => {
                let payload: ActionManifestArtifact = decode(output, field.clone())?;
                if payload.ir_version != super::IR_VERSION { return Err(CompileFailure::ArtifactInvalid { field }); }
            }
            CompileTarget::TypeScriptSdk | CompileTarget::RustSdk => {
                if std::str::from_utf8(&output.bytes).is_err() { return Err(CompileFailure::GeneratedSdkInvalid { target: output.kind, field }); }
            }
        }
    }
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(output: &GeneratedArtifact, field: FieldPath) -> Result<T, CompileFailure> {
    world_protocol::wire::decode(&output.bytes, output.bytes.len()).map_err(|_| CompileFailure::ArtifactInvalid { field })
}
