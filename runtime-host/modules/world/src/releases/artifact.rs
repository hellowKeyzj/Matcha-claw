use std::io::Cursor;

use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    compiler::{
        ArtifactManifest, ArtifactOutput, CompileFailure, CompileRequest, CompileTarget,
        DependencyTarget, DependencyUse,
    },
    failure::FieldPath,
    ids::{ArtifactId, ReleaseId},
};

use super::{Error, require_writer};
use crate::{
    authorization::{self, Admission},
    compiler::CompilationCache,
    content::{Content, ContentOwner, PreparedBlob, StagedCommit},
    definitions::canonical_digest,
    extensions::bindings::read_graph_in_transaction,
    store::{CommitRequest, WorldTransaction},
};

/// Constructed only from the mandatory compiler. A caller-supplied draft is not a sealed artifact.
pub(crate) struct PreparedArtifact {
    request: CompileRequest,
    manifest: ArtifactManifest,
    blobs: Vec<PreparedBlob>,
    kinds: Vec<crate::definitions::CheckedKind>,
}
impl PreparedArtifact {
    pub(crate) fn request(&self) -> &CompileRequest {
        &self.request
    }
    pub(crate) fn manifest(&self) -> &ArtifactManifest {
        &self.manifest
    }
    pub(crate) fn kinds(&self) -> &[crate::definitions::CheckedKind] {
        &self.kinds
    }

    pub(crate) fn stage_commit(
        &self,
        content: &Content,
        request: CommitRequest,
    ) -> Result<StagedCommit, Error> {
        Ok(content.stage_commit(request, &self.blobs.iter().collect::<Vec<_>>())?)
    }
}

pub(crate) fn prepare_artifact(
    content: &Content,
    cache: &mut CompilationCache,
    request: &CompileRequest,
    id: ArtifactId,
    release: ReleaseId,
    cancellation: &CancellationToken,
) -> Result<PreparedArtifact, Error> {
    cancelled(cancellation)?;
    if content.world() != &request.world || !required_targets(&request.targets) {
        return Err(invalid("targets").into());
    }
    // Only the empty trusted genesis is prepared before plugin activation exists.
    if !request.definitions.is_empty() || !request.activation_lock.nodes.is_empty() {
        return Err(invalid("genesis").into());
    }
    let result = cache.compile(request)?;
    prepare_outputs(content, request, &result, id, release, cancellation)
}

pub(crate) fn prepare_artifact_from_compilation(
    content: &Content,
    request: &CompileRequest,
    compilation: &crate::compiler::CheckedCompilation,
    id: ArtifactId,
    release: ReleaseId,
    cancellation: &CancellationToken,
) -> Result<PreparedArtifact, Error> {
    if compilation.request() != request {
        return Err(invalid("request").into());
    }
    let mut prepared = prepare_outputs(
        content,
        request,
        compilation.result(),
        id,
        release,
        cancellation,
    )?;
    prepared.kinds = compilation.kinds().to_vec();
    Ok(prepared)
}

fn prepare_outputs(
    content: &Content,
    request: &CompileRequest,
    result: &world_protocol::compiler::CompileResult,
    id: ArtifactId,
    release: ReleaseId,
    cancellation: &CancellationToken,
) -> Result<PreparedArtifact, Error> {
    cancelled(cancellation)?;
    if content.world() != &request.world || !required_targets(&request.targets) {
        return Err(invalid("targets").into());
    }
    crate::compiler::validate_outputs(&result.draft.outputs)?;
    if result.draft.model_digest != crate::compiler::model_digest(request)?
        || result.draft.targets != request.targets
        || result.draft.outputs.len() != request.targets.len()
        || request.targets.iter().any(|target| {
            result
                .draft
                .outputs
                .iter()
                .filter(|output| &output.kind == target)
                .count()
                != 1
        })
    {
        return Err(invalid("draft").into());
    }
    let mut blobs = Vec::new();
    let built = (|| -> Result<ArtifactManifest, Error> {
        let mut outputs = Vec::new();
        for output in &result.draft.outputs {
            cancelled(cancellation)?;
            let blob = content.prepare_blob(
                &mut Cursor::new(&output.bytes),
                Some(&output.content_digest),
                cancellation,
            )?;
            outputs.push(ArtifactOutput {
                kind: output.kind,
                definition: output.definition.clone(),
                contract: output.contract.clone(),
                schema_digest: output.schema_digest.clone(),
                content: blob.reference().clone(),
            });
            blobs.push(blob);
        }
        let digest = canonical_digest(&(
            "world.artifact.v1",
            &request.world,
            &id,
            &release,
            &request.activation_lock.id,
            &request.config_digest,
            &result.draft.model_digest,
            &request.targets,
            crate::compiler::IR_VERSION,
            &outputs,
            &result.draft.dependencies,
        ))?;
        let manifest = ArtifactManifest {
            model_digest: result.draft.model_digest.clone(),
            targets: request.targets.clone(),
            world: request.world.clone(),
            id,
            release_id: release,
            activation_lock_id: request.activation_lock.id.clone(),
            config_digest: request.config_digest.clone(),
            ir_version: crate::compiler::IR_VERSION.into(),
            outputs,
            dependencies: result.draft.dependencies.clone(),
            digest,
        };
        let bytes = serde_json::to_vec(&manifest)?;
        blobs.push(content.prepare_blob(&mut Cursor::new(bytes), None, cancellation)?);
        cancelled(cancellation)?;
        Ok(manifest)
    })();
    match built {
        Ok(manifest) => Ok(PreparedArtifact {
            request: request.clone(),
            manifest,
            blobs,
            kinds: Vec::new(),
        }),
        Err(failure) => Err(cleanup_error(content, &blobs, failure)),
    }
}

/// Retry preparation only after the transaction owner has established NotCommitted.
pub(crate) fn refresh_artifact(
    content: &Content,
    prepared: &mut PreparedArtifact,
) -> Result<(), Error> {
    for blob in &mut prepared.blobs {
        content.refresh_prepared(blob)?;
    }
    Ok(())
}

pub(crate) fn discard_artifact(
    content: &Content,
    prepared: &PreparedArtifact,
) -> Result<(), Error> {
    let cleanup: Vec<_> = prepared
        .blobs
        .iter()
        .filter_map(|blob| content.discard_prepared(blob).err())
        .collect();
    if cleanup.is_empty() {
        Ok(())
    } else {
        Err(Error::Cleanup {
            failure: Box::new(invalid("stage").into()),
            cleanup,
        })
    }
}

/// Publishes only immutable content and its indexes, not a Release or active Head.
pub(crate) async fn store_artifact(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    content: &Content,
    prepared: &PreparedArtifact,
) -> Result<ArtifactManifest, Error> {
    let impact = authorization::actual_impact(
        prepared
            .request
            .definitions
            .iter()
            .map(|definition| AccessScope {
                resources: vec![world_protocol::ids::ResourceRef::Definition {
                    id: definition.reference.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: definition.scope.clone(),
                valid_time: Some(definition.valid_time.clone()),
            })
            .collect(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    persist_artifact(tx, content, prepared).await
}

pub(super) async fn persist_artifact(
    tx: &WorldTransaction<'_>,
    content: &Content,
    prepared: &PreparedArtifact,
) -> Result<ArtifactManifest, Error> {
    require_writer(tx)?;
    let manifest = &prepared.manifest;
    if &manifest.world != tx.world() || content.world() != tx.world() {
        return Err(invalid("world").into());
    }
    let graph = read_graph_in_transaction(tx, &manifest.activation_lock_id).await?;
    if graph.lock() != &prepared.request.activation_lock {
        return Err(invalid("activationLock").into());
    }
    for blob in &prepared.blobs {
        content
            .retain_prepared(
                tx,
                blob,
                ContentOwner::Artifact {
                    id: manifest.id.clone(),
                },
            )
            .await?;
    }
    let world = tx.world();
    let body = serde_json::to_value(manifest)?;
    let inserted = tx.execute(
        "INSERT INTO world_artifact_manifest(tenant_id,world_id,artifact_id,release_id,activation_lock_id,config_digest,ir_version,content_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &manifest.id.as_str(), &manifest.release_id.as_str(),
          &manifest.activation_lock_id.as_str(), &manifest.config_digest.as_str(), &manifest.ir_version, &manifest.digest.as_str(), &body],
    ).await?;
    if inserted == 0 {
        let stored = tx.query_opt("SELECT body FROM world_artifact_manifest WHERE tenant_id=$1 AND world_id=$2 AND artifact_id=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &manifest.id.as_str()]).await?;
        if stored.is_none_or(|row| row.get::<_, serde_json::Value>("body") != body) {
            return Err(invalid("artifactId").into());
        }
        return Ok(manifest.clone());
    }
    for (ordinal, dependency) in manifest.dependencies.edges.iter().enumerate() {
        let (kind, id, revision) = dependency_key(&dependency.target)?;
        let usage = match dependency.usage {
            DependencyUse::Type => "type",
            DependencyUse::Body => "body",
            DependencyUse::Interface => "interface",
            DependencyUse::Schema => "schema",
            DependencyUse::SourceCapability => "source_capability",
            DependencyUse::Policy => "policy",
            DependencyUse::Unit => "unit",
            DependencyUse::Provider => "provider",
            DependencyUse::CompilerPass => "compiler_pass",
            DependencyUse::Config => "config",
        };
        tx.execute("INSERT INTO world_compile_dependency(tenant_id,world_id,artifact_id,dependent_id,dependent_revision,ordinal,target_kind,target_id,target_revision,usage,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &manifest.id.as_str(), &dependency.dependent.id.as_str(),
              &number(dependency.dependent.revision.0)?, &i32::try_from(ordinal).map_err(|_| invalid("dependencies"))?, &kind, &id, &revision,
              &usage, &serde_json::to_value(dependency)?]).await?;
    }
    Ok(manifest.clone())
}

pub(crate) fn validate_manifest(manifest: &ArtifactManifest) -> Result<(), Error> {
    if !required_targets(&manifest.targets)
        || manifest.ir_version != crate::compiler::IR_VERSION
        || manifest.outputs.len() != manifest.targets.len()
    {
        return Err(invalid("manifest").into());
    }
    for target in &manifest.targets {
        let mut outputs = manifest
            .outputs
            .iter()
            .filter(|output| &output.kind == target);
        let output = outputs.next().ok_or_else(|| invalid("outputs"))?;
        let contract = world_protocol::compiler::artifact_contract(*target)
            .map_err(|_| invalid("contract"))?;
        if outputs.next().is_some()
            || output.contract != contract
            || output.schema_digest != contract.schema_digest
            || output.content.byte_size == 0
        {
            return Err(invalid("outputs").into());
        }
    }
    let digest = canonical_digest(&(
        "world.artifact.v1",
        &manifest.world,
        &manifest.id,
        &manifest.release_id,
        &manifest.activation_lock_id,
        &manifest.config_digest,
        &manifest.model_digest,
        &manifest.targets,
        &manifest.ir_version,
        &manifest.outputs,
        &manifest.dependencies,
    ))?;
    if digest != manifest.digest {
        return Err(invalid("digest").into());
    }
    Ok(())
}

fn required_targets(targets: &[CompileTarget]) -> bool {
    [
        CompileTarget::QueryPlan,
        CompileTarget::Validator,
        CompileTarget::ActionManifest,
        CompileTarget::ToolCatalog,
    ]
    .iter()
    .all(|target| targets.contains(target))
        && targets
            .iter()
            .enumerate()
            .all(|(index, target)| !targets[..index].contains(target))
}
fn cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(CompileFailure::Cancelled.into())
    } else {
        Ok(())
    }
}
fn cleanup_error(content: &Content, blobs: &[PreparedBlob], failure: Error) -> Error {
    let cleanup: Vec<_> = blobs
        .iter()
        .filter_map(|blob| content.discard_prepared(blob).err())
        .collect();
    if cleanup.is_empty() {
        failure
    } else {
        Error::Cleanup {
            failure: Box::new(failure),
            cleanup,
        }
    }
}
fn dependency_key(target: &DependencyTarget) -> Result<(&'static str, String, Option<i64>), Error> {
    Ok(match target {
        DependencyTarget::Definition(reference) => (
            "definition",
            reference.id.to_string(),
            Some(number(reference.revision.0)?),
        ),
        DependencyTarget::Contract(contract) => ("contract", contract.id.to_string(), None),
        DependencyTarget::Implementation(implementation) => (
            "implementation",
            canonical_digest(implementation)?.to_string(),
            None,
        ),
        DependencyTarget::Config(digest) => ("config", digest.to_string(), None),
        DependencyTarget::Unit(unit) => ("unit", canonical_digest(unit)?.to_string(), None),
        DependencyTarget::Schema(schema) => (
            "schema",
            schema.id.to_string(),
            Some(number(schema.revision.0)?),
        ),
        DependencyTarget::Policy(policy) => (
            "policy",
            policy.policy_id.to_string(),
            Some(number(policy.revision.0)?),
        ),
    })
}
fn number(value: u64) -> Result<i64, Error> {
    i64::try_from(value).map_err(|_| invalid("revision").into())
}
fn invalid(field: &str) -> CompileFailure {
    CompileFailure::ArtifactInvalid {
        field: FieldPath(vec![field.into()]),
    }
}
