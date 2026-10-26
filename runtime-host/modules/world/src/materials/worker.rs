use std::{error::Error as StdError, fmt, path::Path, sync::atomic::{AtomicBool, Ordering}};

use serde::{Deserialize, Serialize};
use world_protocol::{
    api::PackageConfigView,
    bindings::ImplementationRef,
    budget::Budget,
    definitions::Scope,
    generation::{GenerationReceipt, GenerationRequest, ModelBinding},
    ids::{RunId, StepId},
    learning::{Candidate, LearningFailure},
    materials::{
        CandidateBatch, DocumentChunkContent, MaterialFailure, ParseArtifact, ReadNeed,
        SemanticExtractRequest, SourceVersion,
    },
    package::PackageFile,
    releases::Release,
};

use super::parse::ParsePlan;
use crate::content::ParseInput;

pub(crate) const MATERIALS_CONTRACT: &str = "world.materials.v1";

pub(crate) fn material_contract() -> Result<world_protocol::sources::ContractRef, world_protocol::schema::SchemaFailure> {
    world_protocol::schema::method::<MaterialRequest, MaterialResponse, WorkerFailure>(MATERIALS_CONTRACT)
}

pub(crate) fn material_method_schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
    world_protocol::schema::bytes::<world_protocol::schema::MethodSchema<MaterialRequest, MaterialResponse, WorkerFailure>>()
}

pub(crate) fn material_request_schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
    world_protocol::schema::bytes::<MaterialRequest>()
}

pub(crate) fn material_result_schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
    world_protocol::schema::bytes::<Result<MaterialResponse, WorkerFailure>>()
}

pub fn export_material_schema() -> Result<Vec<u8>, world_protocol::schema::SchemaFailure> {
    use world_protocol::schema::SchemaFailure;

    let bundle = serde_json::json!({
        "format": "matcha.world-materials-api/1",
        "contract": material_contract()?,
        "method": serde_json::from_slice::<serde_json::Value>(&material_method_schema()?).map_err(|_| SchemaFailure)?,
        "request": serde_json::from_slice::<serde_json::Value>(&material_request_schema()?).map_err(|_| SchemaFailure)?,
        "result": serde_json::from_slice::<serde_json::Value>(&material_result_schema()?).map_err(|_| SchemaFailure)?,
    });
    serde_json::to_vec(&bundle).map_err(|_| SchemaFailure)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialImplementation {
    pub(crate) implementation: ImplementationRef,
    pub(crate) config: PackageConfigView,
    pub(crate) native_files: Vec<PackageFile>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "method",
    content = "input",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MaterialRequest {
    Parse {
        source: SourceVersion,
        name: String,
        bytes: Vec<u8>,
        plan: ParsePlan,
    },
    Chunks {
        source: SourceVersion,
        base: Release,
        scope: Scope,
        budget: Budget,
        binding: ModelBinding,
        run_id: RunId,
        artifact: ParseArtifact,
    },
    Read {
        source: SourceVersion,
        base: Release,
        scope: Scope,
        budget: Budget,
        binding: ModelBinding,
        run_id: RunId,
        artifact: ParseArtifact,
        need: ReadNeed,
    },
    Prepare {
        source: SourceVersion,
        artifact: ParseArtifact,
        request: SemanticExtractRequest,
        binding: ModelBinding,
        run_id: RunId,
        step_id: StepId,
    },
    Finish {
        source: SourceVersion,
        artifact: ParseArtifact,
        request: SemanticExtractRequest,
        generation: GenerationRequest,
        receipt: GenerationReceipt,
    },
    Align {
        base: Release,
        batches: Vec<CandidateBatch>,
        draft: Candidate,
    },
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "method",
    content = "output",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MaterialResponse {
    Parse {
        projection: ParseInput,
        asset_bytes: Vec<Vec<u8>>,
        diagnostics: Vec<ParserDiagnostic>,
    },
    Chunks {
        chunks: Vec<DocumentChunkContent>,
    },
    Read {
        content: DocumentChunkContent,
    },
    Prepare {
        generation: GenerationRequest,
        prompt_bytes: Vec<u8>,
        context_bytes: Vec<Vec<u8>>,
        schema_bytes: Vec<u8>,
    },
    Finish {
        batch: CandidateBatch,
    },
    Align {
        batch: CandidateBatch,
    },
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParserDiagnostic {
    pub(crate) kind: document_parser::FailureKind,
    pub(crate) limit: Option<String>,
    pub(crate) causes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum WorkerFailure {
    Material {
        failure: MaterialFailure,
        causes: Vec<String>,
    },
    Learning {
        failure: LearningFailure,
        causes: Vec<String>,
    },
    Compile {
        failure: world_protocol::compiler::CompileFailure,
        causes: Vec<String>,
    },
}

fn causes(error: &(dyn StdError + 'static)) -> Vec<String> {
    let mut output = vec![format!("{error:?}"), error.to_string()];
    let mut current = error.source();
    while let Some(cause) = current {
        output.push(format!("{cause:?}"));
        output.push(cause.to_string());
        current = cause.source();
    }
    output
}

impl From<super::Error> for WorkerFailure {
    fn from(error: super::Error) -> Self {
        Self::Material { failure: error.reason().clone(), causes: causes(&error) }
    }
}

impl From<super::ExtractionError> for WorkerFailure {
    fn from(error: super::ExtractionError) -> Self {
        Self::Learning { failure: error.failure().clone(), causes: causes(&error) }
    }
}

impl fmt::Display for WorkerFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Material { failure, .. } => write!(f, "material worker rejected: {failure:?}"),
            Self::Learning { failure, .. } => write!(f, "material alignment rejected: {failure:?}"),
            Self::Compile { failure, .. } => write!(f, "material compilation rejected: {failure:?}"),
        }
    }
}
impl StdError for WorkerFailure {}

impl From<WorkerFailure> for crate::owner::Error {
    fn from(error: WorkerFailure) -> Self {
        let failure = match &error {
            WorkerFailure::Material { failure, .. } => Self::from(super::Error::new(failure.clone())),
            WorkerFailure::Learning { failure, .. } => Self::from(crate::learning::Error::from(failure.clone())),
            WorkerFailure::Compile { failure, .. } => Self::from(crate::learning::Error::Compile(failure.clone())),
        };
        failure.caused(error)
    }
}

pub(crate) fn initialize_materials(pdfium: Option<(&Path, &world_protocol::ids::Digest)>) -> Result<(), WorkerFailure> {
    document_parser::set_exact_pdfium(pdfium.map(|(path, digest)| (path, digest.as_str())))
        .map_err(super::Error::from)
        .map_err(WorkerFailure::from)
}

/// No storage, authority, secrets, Provider calls or business acceptance occurs in this process.
pub(crate) fn execute_material(request: MaterialRequest, cancellation: &AtomicBool) -> Result<MaterialResponse, WorkerFailure> {
    check(cancellation)?;
    let response = match request {
        MaterialRequest::Parse { source, name, bytes, plan } => parse(source, name, bytes, plan, cancellation),
        MaterialRequest::Chunks { source, base, scope, budget, binding, run_id, artifact } => {
            let maximum = content_limit(&source, &base, &scope, &budget, &binding, &run_id)?;
            let chunks = super::chunk_document(&artifact, &super::ChunkLimits {
                max_bytes: maximum,
                max_tokens: maximum,
                max_chunks: budget.max_steps,
            }, cancellation).map_err(WorkerFailure::from)?;
            Ok(MaterialResponse::Chunks { chunks })
        }
        MaterialRequest::Read { source, base, scope, budget, binding, run_id, artifact, need } => {
            let maximum = content_limit(&source, &base, &scope, &budget, &binding, &run_id)?;
            let content = super::read_targets(&artifact, &need, maximum, maximum).map_err(WorkerFailure::from)?;
            Ok(MaterialResponse::Read { content })
        }
        MaterialRequest::Prepare { source, artifact, request, binding, run_id, step_id } => {
            super::extract::prepare_output(&source, &artifact, request, &binding, run_id, step_id).map_err(WorkerFailure::from)
        }
        MaterialRequest::Finish { source, artifact, request, generation, receipt } => {
            let batch = super::extract_result::finish_output(&source, &request, &generation, &receipt, &artifact).map_err(WorkerFailure::from)?;
            Ok(MaterialResponse::Finish { batch })
        }
        MaterialRequest::Align { base, batches, draft } => {
            let batch = crate::learning::align(&base, &batches, &draft).map_err(|error| {
                if let crate::learning::Error::Definition(crate::definitions::DefinitionError::Compile(failure))
                    | crate::learning::Error::Compile(failure) = &error
                {
                    return WorkerFailure::Compile { failure: failure.clone(), causes: causes(&error) };
                }
                let failure = match &error {
                    crate::learning::Error::Rejected(failure) => failure.clone(),
                    crate::learning::Error::Definition(crate::definitions::DefinitionError::Rejected(failure)) => LearningFailure::Definition { failure: failure.clone() },
                    _ => LearningFailure::InternalFault,
                };
                WorkerFailure::Learning { failure, causes: causes(&error) }
            })?;
            Ok(MaterialResponse::Align { batch })
        }
    }?;
    check(cancellation)?;
    Ok(response)
}

fn check(cancellation: &AtomicBool) -> Result<(), WorkerFailure> {
    if cancellation.load(Ordering::Acquire) {
        Err(super::Error::new(MaterialFailure::Cancelled).into())
    } else {
        Ok(())
    }
}

fn content_limit(
    source: &SourceVersion,
    base: &Release,
    scope: &Scope,
    budget: &Budget,
    binding: &ModelBinding,
    run_id: &RunId,
) -> Result<u64, WorkerFailure> {
    let overhead = super::extraction_overhead(source, base, scope, budget, run_id)?;
    budget.max_bytes.min(budget.max_input_tokens).min(binding.capabilities.as_ref().map_or(u64::MAX, |capabilities| {
        capabilities.context_tokens.saturating_sub(binding.parameters.maximum_output_tokens)
    })).checked_sub(overhead).filter(|value| *value > 0)
        .ok_or_else(|| super::Error::new(MaterialFailure::SizeLimit).into())
}

fn parse(source: SourceVersion, name: String, bytes: Vec<u8>, plan: ParsePlan, cancellation: &AtomicBool) -> Result<MaterialResponse, WorkerFailure> {
    if source.blob.byte_size != bytes.len() as u64
        || source.blob.digest != world_protocol::schema::hash(&bytes).map_err(|cause| super::Error::caused(MaterialFailure::InternalFault, cause))?
    {
        return Err(super::Error::new(MaterialFailure::DigestMismatch).into());
    }
    let extension = super::parse::extension(&name, &source.media_type)?;
    let options = serde_json::to_vec(&plan.options).map_err(|cause| super::Error::caused(MaterialFailure::InputInvalid, cause))?;
    let mut document = document_parser::parse(document_parser::ParseRequest {
        bytes: &bytes,
        extension: &extension,
        display_name: Some(&name),
        options: &plan.options,
        cancellation: Some(cancellation),
    }).map_err(super::Error::from)?;
    let dependencies = plan.dependency_fingerprints;
    for digest in &document.dependency_fingerprints {
        let digest = super::convert::digest(digest)?;
        if !dependencies.contains(&digest) {
            return Err(super::Error::new(MaterialFailure::DigestMismatch).into());
        }
    }
    let diagnostics = std::mem::take(&mut document.diagnostics).into_iter().map(|error| ParserDiagnostic {
        kind: error.kind,
        limit: error.limit.map(str::to_owned),
        causes: causes(&error),
    }).collect();
    let asset_bytes: Vec<_> = document.assets.iter().map(|asset| asset.bytes.clone()).collect();
    let references = asset_bytes.iter().map(|bytes| Ok(world_protocol::materials::BlobRef {
        digest: world_protocol::schema::hash(bytes).map_err(|cause| super::Error::caused(MaterialFailure::InternalFault, cause))?,
        byte_size: bytes.len() as u64,
    })).collect::<Result<Vec<_>, super::Error>>()?;
    let input = ParseInput {
        world: source.reference.world.clone(),
        id: plan.id,
        source_version: source.reference,
        parse_run: plan.parse_run,
        parser_fingerprint: plan.parser_fingerprint,
        options_digest: world_protocol::schema::hash(&options).map_err(|cause| super::Error::caused(MaterialFailure::InternalFault, cause))?,
        dependency_fingerprints: dependencies,
        blocks: Vec::new(), tables: Vec::new(), assets: Vec::new(), source_map: Vec::new(), coverage: Vec::new(), metadata: Default::default(),
    };
    let projection = super::convert::project(document, input, &references)?;
    Ok(MaterialResponse::Parse { projection, asset_bytes, diagnostics })
}
