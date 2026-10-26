use std::{collections::BTreeSet, sync::Arc};

use foundation::pipeline::PipelineContext;
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    ids::{ResourceRef, SourceId},
    materials::{MaterialFailure, SourceVersion, SourceVersionRef},
    operation::{OperationAccepted, OperationResult},
};

use super::{Error, ParsePlan, PreparedDocument, prepare_document, wiki::WikiMaterial};
use crate::{
    authorization::{Admission, actual_impact, recheck},
    content::{BlobPin, Content},
    store::{Committed, WorldStore, WorldTransaction},
};

/// Bytes are delivered by a trusted input owner, never interpreted as a local path or URL.
pub(crate) enum DocumentInput {
    Bytes(Vec<u8>),
    Pinned(Committed<BlobPin>),
    Wiki(WikiMaterial),
}

pub(crate) struct ImportDocument {
    pub source: SourceVersion,
    pub name: String,
    pub plan: ParsePlan,
    pub input: DocumentInput,
}

pub(crate) struct PreparedImport {
    documents: Vec<PreparedDocument>,
}

impl PreparedImport {
    pub(crate) fn documents(&self) -> &[PreparedDocument] {
        &self.documents
    }

    /// No independent transaction/operation owner: all source and parse receipts join the caller's commit.
    /// This is custody + parsing, not a claim that extraction, alignment or publication has completed.
    pub(crate) async fn register_in_transaction(
        &self,
        content: &Content,
        transaction: &WorldTransaction<'_>,
        admission: &Admission,
        accepted: &OperationAccepted,
    ) -> Result<OperationResult, crate::owner::Error> {
        if accepted.world != *transaction.world() || admission.invocation().world != accepted.world
        {
            return Err(crate::owner::Error::internal(
                world_protocol::failure::FailureStage::Admission,
            ));
        }
        let now = transaction.now().await?;
        recheck(transaction, admission, &now).await?;
        for document in &self.documents {
            let source = document.source();
            crate::authorization::require_material_policies(
                transaction,
                admission,
                &source.reference.source_id,
                &source.access,
                &source.retention,
                &now,
            )
            .await?;
        }
        for document in &self.documents {
            let source = document.source();
            let family = crate::content::source_origin_family(transaction, &source.blob, &source.lineage).await.map_err(|error| match error {
                crate::content::SourceOriginError::Content(error) => crate::owner::Error::from(error),
                error @ crate::content::SourceOriginError::ConflictingFamilies { .. } => crate::owner::Error::new(
                    "world.material.origin_family_conflict", world_protocol::failure::FailureStage::Validate,
                    "资料来源家族存在历史冲突，需要人工处理。", world_protocol::api::ApiFailure::RevisionConflict,
                    world_protocol::failure::Recovery::ManualReview,
                ).caused(error),
            })?;
            if family != source.origin_family {
                let mut families = vec![source.origin_family.clone(), family];
                families.sort();
                return Err(crate::owner::Error::new(
                    "world.material.origin_family_conflict", world_protocol::failure::FailureStage::Validate,
                    "资料来源家族与原保存记录不一致，需要人工处理。", world_protocol::api::ApiFailure::RevisionConflict,
                    world_protocol::failure::Recovery::ManualReview,
                ).caused(crate::content::SourceOriginError::ConflictingFamilies { families }));
            }
            let id = &source.reference.source_id;
            require_source_write(admission, id, &source.access.labels)?;
            document
                .register_in_transaction(content, transaction)
                .await
                .map_err(crate::owner::Error::from)?;
        }
        Ok(OperationResult::Materials {
            source_versions: self
                .documents
                .iter()
                .map(|document| document.source().reference.clone())
                .collect(),
            parse_artifacts: self
                .documents
                .iter()
                .map(|document| document.artifact().id.clone())
                .collect(),
            candidates: Vec::new(),
            drafts: Vec::new(),
        })
    }

    pub(crate) fn discard(&self, content: &Content) -> Result<(), Error> {
        let mut failure: Option<Error> = None;
        for document in &self.documents {
            if let Err(error) = document.discard(content) {
                failure = Some(match failure {
                    Some(primary) => primary.with_related(error),
                    None => error,
                });
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(crate) fn refresh(&mut self, content: &Content) -> Result<(), Error> {
        for document in &mut self.documents {
            document.refresh(content)?;
        }
        Ok(())
    }
}

pub(crate) async fn prepare_import<F, Fut>(
    content: Arc<Content>,
    store: &WorldStore,
    inputs: Vec<ImportDocument>,
    pipeline: &PipelineContext,
    mut execute: F,
) -> Result<PreparedImport, crate::owner::Error>
where
    F: FnMut(super::MaterialRequest) -> Fut + Send,
    Fut: std::future::Future<Output = Result<super::MaterialResponse, crate::owner::Error>> + Send,
{
    if inputs.is_empty() {
        return Err(Error::new(MaterialFailure::InputInvalid).into());
    }
    let mut sources = BTreeSet::new();
    let mut artifacts = BTreeSet::new();
    for input in &inputs {
        if input.source.reference.world != *content.world()
            || !sources.insert((
                input.source.reference.source_id.clone(),
                input.source.reference.version_id.clone(),
            ))
            || !artifacts.insert(input.plan.id.clone())
        {
            return Err(Error::new(MaterialFailure::InputInvalid).into());
        }
    }
    let mut prepared = PreparedImport {
        documents: Vec::with_capacity(inputs.len()),
    };
    for input in inputs {
        let result = async {
            let (source, bytes, name, plan) = acquire(&content, store, input, pipeline).await
                .map_err(crate::owner::Error::from)?;
            let response = execute(super::MaterialRequest::Parse {
                source: source.clone(), name, bytes: bytes.clone(), plan: plan.clone(),
            }).await?;
            prepare_document(content.clone(), source, bytes, plan, response, pipeline).await
                .map_err(crate::owner::Error::from)
        }.await;
        match result {
            Ok(document) => prepared.documents.push(document),
            Err(error) => {
                return match prepared.discard(&content) {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(error.with_related(cleanup.into())),
                };
            }
        }
    }
    Ok(prepared)
}

async fn acquire(
    content: &Content,
    store: &WorldStore,
    input: ImportDocument,
    pipeline: &PipelineContext,
) -> Result<(SourceVersion, Vec<u8>, String, ParsePlan), Error> {
    if pipeline.is_cancelled() {
        return Err(Error::new(MaterialFailure::Cancelled));
    }
    if input.name.is_empty() || input.name.len() > 4096 || input.name.chars().any(char::is_control)
    {
        return Err(Error::new(MaterialFailure::InputInvalid));
    }
    let bytes = match input.input {
        DocumentInput::Bytes(bytes) => bytes,
        DocumentInput::Pinned(pin) => {
            if pin.value.reference() != &input.source.blob {
                return Err(Error::new(MaterialFailure::DigestMismatch));
            }
            content.read_pinned(store, &pin).await?
        }
        DocumentInput::Wiki(material) => {
            material.validate_source(&input.source)?;
            material.into_bytes()
        }
    };
    if pipeline.is_cancelled() {
        return Err(Error::new(MaterialFailure::Cancelled));
    }
    Ok((input.source, bytes, input.name, input.plan))
}

fn require_source_write(
    admission: &Admission,
    source: &SourceId,
    labels: &[String],
) -> Result<(), crate::authorization::AuthError> {
    let resource = ResourceRef::Source { id: source.clone() };
    let access = admission
        .impact()
        .access
        .iter()
        .filter(|scope| {
            scope.modes.contains(&AccessMode::Write)
                && (scope.resources.is_empty() || scope.resources.contains(&resource))
        })
        .map(|scope| AccessScope {
            resources: vec![resource.clone()],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            scope: scope.scope.clone(),
            valid_time: scope.valid_time.clone(),
        })
        .collect::<Vec<_>>();
    let impact = actual_impact(
        access,
        Vec::new(),
        labels.to_vec(),
        Vec::new(),
        vec![source.clone()],
    )?;
    admission.require_access(&impact)
}

pub(crate) fn source_references(prepared: &PreparedImport) -> Vec<SourceVersionRef> {
    prepared
        .documents
        .iter()
        .map(|document| document.source().reference.clone())
        .collect()
}
