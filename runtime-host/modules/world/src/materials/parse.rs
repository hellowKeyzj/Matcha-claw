use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use document_parser::ParseOptions;
use foundation::pipeline::{PipelineContext, ProgressEvent};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{Digest, ParseArtifactId, RunId},
    materials::{MaterialFailure, ParseArtifact, SourceVersion},
};

use super::{Error, convert};
use crate::{
    content::{Content, PreparedBlob, PreparedParse},
    store::WorldTransaction,
};

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParsePlan {
    pub id: ParseArtifactId,
    pub parse_run: RunId,
    pub parser_fingerprint: Digest,
    pub dependency_fingerprints: Vec<Digest>,
    pub options: ParseOptions,
}

pub(crate) struct PreparedDocument {
    source: SourceVersion,
    original: PreparedBlob,
    parsed: PreparedParse,
    assets: Vec<PreparedBlob>,
    // Causes remain private and are not serialized into a document or a public receipt.
    diagnostics: Vec<super::worker::ParserDiagnostic>,
}

impl PreparedDocument {
    pub(crate) fn source(&self) -> &SourceVersion {
        &self.source
    }
    pub(crate) fn artifact(&self) -> &ParseArtifact {
        self.parsed.artifact()
    }
    pub(crate) fn diagnostics(&self) -> &[super::worker::ParserDiagnostic] {
        &self.diagnostics
    }

    /// Caller owns admission and commit identity; original, manifest and assets share its transaction.
    pub(crate) async fn register_in_transaction(
        &self,
        content: &Content,
        transaction: &WorldTransaction<'_>,
    ) -> Result<(), Error> {
        content
            .register_source_version(transaction, &self.original, &self.source)
            .await?;
        content
            .register_parse_artifact(transaction, &self.parsed, &self.assets)
            .await?;
        Ok(())
    }

    /// Only after a known rejection/cancellation, never after an indeterminate commit.
    pub(crate) fn discard(&self, content: &Content) -> Result<(), Error> {
        let mut error = Error::new(MaterialFailure::CleanupFailed);
        let mut failed = false;
        for result in std::iter::once(content.discard_prepared_parse(&self.parsed))
            .chain(
                self.assets
                    .iter()
                    .map(|asset| content.discard_prepared(asset)),
            )
            .chain(std::iter::once(content.discard_prepared(&self.original)))
        {
            failed |= result.is_err();
            error.cleanup(result);
        }
        if failed { Err(error) } else { Ok(()) }
    }

    /// Revalidate outside SQL after a confirmed NotCommitted concurrent-publisher conflict.
    pub(crate) fn refresh(&mut self, content: &Content) -> Result<(), Error> {
        content.refresh_prepared(&mut self.original)?;
        for asset in &mut self.assets {
            content.refresh_prepared(asset)?;
        }
        content.refresh_prepared_parse(&mut self.parsed)?;
        Ok(())
    }
}

/// The owner must retain this future in its tracked work. Cancellation signals the parser and
/// then joins the same blocking task; a native parser is never reported stopped while still running.
pub(crate) async fn prepare_document(
    content: Arc<Content>,
    source: SourceVersion,
    bytes: Vec<u8>,
    plan: ParsePlan,
    response: super::MaterialResponse,
    pipeline: &PipelineContext,
) -> Result<PreparedDocument, Error> {
    if pipeline.run_id() != plan.parse_run.as_str() || &source.reference.world != content.world() {
        return Err(Error::new(MaterialFailure::InputInvalid));
    }
    let cancellation = pipeline.cancellation();
    if cancellation.is_cancelled() {
        return Err(Error::new(MaterialFailure::Cancelled));
    }
    let flag = Arc::new(AtomicBool::new(false));
    let worker_flag = flag.clone();
    let worker_cancel = cancellation.clone();
    let worker_content = content.clone();
    pipeline.emit_progress(ProgressEvent::started(pipeline.run_id(), "document.parse"));
    let mut worker = tokio::task::spawn_blocking(move || {
        prepare(
            &worker_content,
            source,
            &bytes,
            plan,
            response,
            &worker_flag,
            &worker_cancel,
        )
    });
    let result = tokio::select! {
        result = &mut worker => result,
        _ = cancellation.cancelled() => {
            flag.store(true, Ordering::Release);
            worker.await
        }
    }
    .map_err(|cause| Error::caused(MaterialFailure::InternalFault, cause));
    let result = match result {
        Ok(Ok(prepared)) if cancellation.is_cancelled() => {
            let mut error = Error::new(MaterialFailure::Cancelled);
            if let Err(cleanup) = prepared.discard(&content) {
                error = error.with_related(cleanup);
            }
            Err(error)
        }
        Ok(result) => result,
        Err(error) => Err(error),
    };
    let event = match &result {
        Ok(_) => ProgressEvent::completed(pipeline.run_id(), "document.parse"),
        Err(error) if matches!(error.reason(), MaterialFailure::Cancelled) => {
            ProgressEvent::cancelled(pipeline.run_id(), "document.parse")
        }
        Err(error) => ProgressEvent::failed(pipeline.run_id(), "document.parse", error.to_string()),
    };
    pipeline.emit_progress(event);
    result
}

fn prepare(
    content: &Content,
    source: SourceVersion,
    bytes: &[u8],
    plan: ParsePlan,
    response: super::MaterialResponse,
    flag: &AtomicBool,
    cancellation: &CancellationToken,
) -> Result<PreparedDocument, Error> {
    let super::MaterialResponse::Parse { projection, asset_bytes, diagnostics } = response else {
        return Err(Error::new(MaterialFailure::InputInvalid));
    };
    let options = serde_json::to_vec(&plan.options)
        .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))?;
    if source.blob.byte_size != bytes.len() as u64
        || source.blob.digest != convert::digest(&format!("{:x}", Sha256::digest(bytes)))?
        || projection.world != source.reference.world
        || projection.source_version != source.reference
        || projection.id != plan.id
        || projection.parse_run != plan.parse_run
        || projection.parser_fingerprint != plan.parser_fingerprint
        || projection.options_digest != convert::digest(&format!("{:x}", Sha256::digest(&options)))?
        || projection.dependency_fingerprints != plan.dependency_fingerprints
        || projection.assets.len() != asset_bytes.len()
    {
        return Err(Error::new(MaterialFailure::DigestMismatch));
    }
    if flag.load(Ordering::Acquire) || cancellation.is_cancelled() {
        return Err(Error::new(MaterialFailure::Cancelled));
    }
    let original = content.prepare_blob(&mut &*bytes, Some(&source.blob.digest), cancellation)?;
    let mut assets = Vec::with_capacity(asset_bytes.len());
    for (asset, bytes) in projection.assets.iter().zip(&asset_bytes) {
        let result = if asset.blob.byte_size != bytes.len() as u64 {
            Err(Error::new(MaterialFailure::DigestMismatch))
        } else {
            content.prepare_blob(&mut bytes.as_slice(), Some(&asset.blob.digest), cancellation).map_err(Into::into)
        };
        match result {
            Ok(prepared) => assets.push(prepared),
            Err(mut error) => {
                cleanup(&mut error, content, &original, &assets);
                return Err(error);
            }
        }
    }
    let parsed = content.prepare_parse(projection, cancellation).map_err(Error::from);
    match parsed {
        Ok(parsed) => Ok(PreparedDocument {
            source,
            original,
            parsed,
            assets,
            diagnostics,
        }),
        Err(mut error) => {
            cleanup(&mut error, content, &original, &assets);
            Err(error)
        }
    }
}

fn cleanup(error: &mut Error, content: &Content, original: &PreparedBlob, assets: &[PreparedBlob]) {
    for asset in assets {
        error.cleanup(content.discard_prepared(asset));
    }
    error.cleanup(content.discard_prepared(original));
}

pub(super) fn extension(name: &str, media_type: &str) -> Result<String, Error> {
    if let Some((_, extension)) = name.rsplit('/').next().unwrap_or(name).rsplit_once('.') {
        if !extension.is_empty() && extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Ok(extension.to_ascii_lowercase());
        }
    }
    let extension = match media_type.split(';').next().unwrap_or(media_type).trim() {
        "application/pdf" => "pdf",
        "application/json" => "json",
        "text/html" => "html",
        "text/csv" => "csv",
        "text/tab-separated-values" => "tsv",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/org" => "org",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/msword" => "doc",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/epub+zip" => "epub",
        "application/vnd.amazon.ebook" | "application/x-mobipocket-ebook" => "mobi",
        "application/vnd.oasis.opendocument.text" => "odt",
        "application/vnd.oasis.opendocument.spreadsheet" => "ods",
        "application/vnd.oasis.opendocument.presentation" => "odp",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => return Err(Error::new(MaterialFailure::UnsupportedFormat)),
    };
    Ok(extension.to_owned())
}
