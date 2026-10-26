use super::{Error, read::invalid};
use crate::{
    authorization::{self, Admission},
    store::{WorldSnapshot, WorldTransaction},
};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    bindings::ActivationLock,
    compiler::CompileRequest,
    definitions::DefinitionBody,
    ids::{ReleaseId, ResourceRef},
    releases::{Release, ReleaseFailure, ReleaseHead},
};

/// Exact sealed compiler context, not a latest-package-config digest or a caller-supplied model.
pub(crate) async fn read_compile_context(
    tx: &WorldTransaction<'_>,
    id: &ReleaseId,
) -> Result<CompileRequest, Error> {
    let release =
        super::read_release(tx, id)
            .await?
            .ok_or_else(|| ReleaseFailure::ReleaseMissing {
                release_id: id.clone(),
            })?;
    let graph = crate::extensions::bindings::read_graph_history_in_transaction(
        tx,
        &release.artifact.activation_lock_id,
    )
    .await?;
    let source = match &release.source_branch {
        Some(reference) => Some(
            super::read_branch_revision(tx, reference)
                .await?
                .ok_or_else(|| invalid("sourceBranch"))?
                .compile,
        ),
        None => None,
    };
    restore(&release, graph.lock(), source)
}

pub(crate) async fn editing_context_impact(
    tx: &WorldTransaction<'_>,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let head = super::read_active_head(tx)
        .await?
        .ok_or_else(|| invalid("activeRelease"))?;
    let release = super::read_release(tx, &head.release_id)
        .await?
        .ok_or_else(|| invalid("release"))?;
    super::model_impact(
        tx,
        &release.definitions,
        head_access(&release, &head),
        &[AccessMode::Read],
    )
    .await
}

pub(crate) async fn read_editing_context_in_transaction(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
) -> Result<Option<(ReleaseHead, CompileRequest)>, Error> {
    let Some(head) = super::read_active_head(tx).await? else {
        return Ok(None);
    };
    let release = super::read_release(tx, &head.release_id)
        .await?
        .ok_or_else(|| invalid("release"))?;
    crate::extensions::bindings::read_graph_in_transaction(
        tx,
        &release.artifact.activation_lock_id,
    )
    .await?;
    let request = read_compile_context(tx, &head.release_id).await?;
    for definition in &release.definitions {
        if let DefinitionBody::SourceBinding(binding) = &definition.body {
            let schema = crate::sources::mapping::read_schema(tx, &binding.schema)
                .await
                .map_err(|error| Error::Fact(error.into()))?
                .ok_or_else(|| invalid("schema"))?;
            let mapping = crate::sources::mapping::read_mapping(tx, &binding.mapping)
                .await
                .map_err(|error| Error::Fact(error.into()))?
                .ok_or_else(|| invalid("mapping"))?;
            check_source(binding, &schema, &mapping)?;
        }
    }
    let impact = super::model_impact(
        tx,
        &release.definitions,
        head_access(&release, &head),
        &[AccessMode::Read],
    )
    .await?;
    authorization::check_admitted_output(tx, admission, &impact, 1, &tx.now().await?).await?;
    Ok(Some((head, request)))
}

/// Definitions are reference material; Learning independently materializes every proposed overlay.
pub(crate) async fn read_editing_context(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
) -> Result<Option<(ReleaseHead, CompileRequest)>, Error> {
    let Some(head) = super::read_active_head_snapshot(snapshot).await? else {
        return Ok(None);
    };
    let release = super::read_release_snapshot(snapshot, &head.release_id)
        .await?
        .ok_or_else(|| invalid("release"))?;
    let graph = crate::extensions::bindings::read_active_graph(
        snapshot,
        &release.artifact.activation_lock_id,
    )
    .await?;
    let source = match &release.source_branch {
        Some(reference) => Some(
            super::read_branch_revision_snapshot(snapshot, reference)
                .await?
                .ok_or_else(|| invalid("sourceBranch"))?
                .compile,
        ),
        None => None,
    };
    let request = restore(&release, graph.lock(), source)?;
    for definition in &release.definitions {
        if let DefinitionBody::SourceBinding(binding) = &definition.body {
            let schema = crate::sources::mapping::read_schema_snapshot(snapshot, &binding.schema)
                .await
                .map_err(|error| Error::Fact(error.into()))?
                .ok_or_else(|| invalid("schema"))?;
            let mapping =
                crate::sources::mapping::read_mapping_snapshot(snapshot, &binding.mapping)
                    .await
                    .map_err(|error| Error::Fact(error.into()))?
                    .ok_or_else(|| invalid("mapping"))?;
            check_source(binding, &schema, &mapping)?;
        }
    }
    let impact = snapshot_impact(snapshot, &release, &head).await?;
    let now = snapshot.now().await?;
    authorization::check_admitted_output_read(snapshot, admission, &impact, 1, &now).await?;
    Ok(Some((head, request)))
}

fn restore(
    release: &Release,
    lock: &ActivationLock,
    source: Option<CompileRequest>,
) -> Result<CompileRequest, Error> {
    let mut request = match source {
        Some(request) => request,
        None if release.parent.is_none()
            && release.definitions.is_empty()
            && release.scopes.len() == 1
            && lock.nodes.is_empty()
            && lock.edges.is_empty()
            && lock.compositions.is_empty()
            && lock.roots.is_empty()
            && lock.trusted_roots.is_empty() =>
        {
            CompileRequest {
                world: release.world.clone(),
                base_release: release.id.clone(),
                activation_lock: lock.clone(),
                definitions: Vec::new(),
                scopes: release.scopes.clone(),
                targets: release.artifact.targets.clone(),
                external_contracts: Vec::new(),
                config_digest: release.artifact.config_digest.clone(),
            }
        }
        None => return Err(invalid("sourceBranch")),
    };
    if lock != &request.activation_lock
        || crate::compiler::model_digest(&request)? != release.artifact.model_digest
        || request.config_digest != release.artifact.config_digest
        || request.targets != release.artifact.targets
    {
        return Err(invalid("compile"));
    }
    request.base_release = release.id.clone();
    Ok(request)
}

fn check_source(
    binding: &world_protocol::sources::SourceBinding,
    schema: &world_protocol::sources::SchemaDiscovery,
    mapping: &world_protocol::sources::SchemaMapping,
) -> Result<(), Error> {
    if schema.reference != binding.schema
        || !schema.complete
        || schema.source_id != binding.source_id
        || schema.incarnation != binding.incarnation
        || schema.namespace != binding.namespace
        || mapping.reference != binding.mapping
        || mapping.schema != binding.schema
        || mapping.identity_rule != binding.identity_rule
        || binding
            .selected_fields
            .iter()
            .any(|field| !schema.fields.iter().any(|actual| actual.id == *field))
    {
        return Err(invalid("sourceContext"));
    }
    Ok(())
}

fn head_access(release: &Release, head: &ReleaseHead) -> Vec<AccessScope> {
    release
        .scopes
        .iter()
        .map(|scope| AccessScope {
            resources: vec![ResourceRef::Head {
                channel: head.channel.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: scope.id.clone(),
            valid_time: None,
        })
        .collect()
}

async fn snapshot_impact(
    snapshot: &WorldSnapshot<'_>,
    release: &Release,
    head: &ReleaseHead,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let mut access: Vec<_> = release
        .scopes
        .iter()
        .map(|scope| AccessScope {
            resources: vec![ResourceRef::Head {
                channel: head.channel.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: scope.id.clone(),
            valid_time: None,
        })
        .collect();
    access.extend(release.definitions.iter().map(|definition| AccessScope {
        resources: vec![ResourceRef::Definition {
            id: definition.reference.id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: definition.scope.clone(),
        valid_time: Some(definition.valid_time.clone()),
    }));
    let mut labels = Vec::new();
    let mut sources = Vec::new();
    for definition in &release.definitions {
        if let DefinitionBody::Property(property) = &definition.body {
            labels.extend(property.access_labels.iter().cloned());
        }
        if let DefinitionBody::SourceBinding(binding) = &definition.body {
            sources.push(binding.source_id.clone());
        }
        for reference in &definition.evidence {
            let evidence = crate::facts::assertions::read_evidence_snapshot(snapshot, reference)
                .await?
                .ok_or_else(|| invalid("evidence"))?;
            let version = crate::content::read_source_version_snapshot(
                snapshot,
                &evidence.locator.source_version,
            )
            .await?;
            let material = authorization::material_read_impact_snapshot(snapshot, &version).await?;
            labels.extend(evidence.access.labels);
            labels.extend(material.labels);
            sources.extend(material.source_ids);
            access.extend(material.access);
            access.push(AccessScope {
                resources: vec![ResourceRef::Evidence {
                    id: reference.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: definition.scope.clone(),
                valid_time: None,
            });
        }
    }
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        labels,
        Vec::new(),
        sources,
    )?)
}
