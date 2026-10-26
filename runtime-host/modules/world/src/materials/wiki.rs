use std::{future::Future, pin::Pin};

use tokio_util::sync::CancellationToken;
use world_protocol::{ids::Digest, materials::MaterialFailure};

/// Private composition receipt: the Wiki owner selected and verified these immutable bytes.
/// It is not accepted from a public material request and must never be reconstructed from current files.
pub struct WikiVersion {
    pub relative_path: String,
    pub version: String,
    pub digest: Digest,
    pub captured_at_ms: u64,
    pub bytes: Vec<u8>,
}

pub struct WikiExportError {
    reason: MaterialFailure,
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl WikiExportError {
    pub fn new(reason: MaterialFailure) -> Self {
        Self {
            reason,
            cause: None,
        }
    }
    pub fn caused(
        reason: MaterialFailure,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            reason,
            cause: Some(Box::new(cause)),
        }
    }
}
impl std::fmt::Debug for WikiExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WikiExportError")
            .field("reason", &self.reason)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for WikiExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Wiki exact version export failed")
    }
}
impl std::error::Error for WikiExportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}

pub type WikiExportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<WikiVersion>, WikiExportError>> + Send + 'a>>;

/// Host bridges the existing Wiki owner; world owns no Wiki store or mutable project path.
/// None means VersionContentUnavailable, including an old binary without a real retained snapshot.
pub trait WorldWiki: Send + Sync {
    fn export_exact<'a>(
        &'a self,
        project_id: &'a str,
        relative_path: &'a str,
        version: &'a str,
        cancellation: CancellationToken,
    ) -> WikiExportFuture<'a>;
}

pub(crate) enum WikiSelection {
    Source {
        project_id: String,
        source_id: String,
        version: String,
    },
    Page {
        project_id: String,
        page_id: String,
        version: String,
    },
}

pub(crate) struct WikiMaterial {
    selection: WikiSelection,
    content: WikiVersion,
}

impl WikiMaterial {
    pub(crate) fn content(&self) -> &WikiVersion {
        &self.content
    }

    pub(super) fn into_bytes(self) -> Vec<u8> {
        self.content.bytes
    }

    pub(super) fn validate_source(
        &self,
        source: &world_protocol::materials::SourceVersion,
    ) -> Result<(), super::Error> {
        use world_protocol::materials::SourceLineage;
        let matches = source
            .lineage
            .iter()
            .any(|lineage| match (&self.selection, lineage) {
                (
                    WikiSelection::Source {
                        project_id,
                        source_id,
                        version,
                    },
                    SourceLineage::WikiSource {
                        project_id: project,
                        source_id: path,
                        version: revision,
                    },
                ) => project_id == project && source_id == path && version == revision,
                (
                    WikiSelection::Page {
                        project_id,
                        page_id,
                        version,
                    },
                    SourceLineage::WikiPage {
                        project_id: project,
                        page_id: path,
                        version: revision,
                        source_versions,
                    },
                ) => {
                    project_id == project
                        && page_id == path
                        && version == revision
                        && source_versions.is_empty()
                }
                _ => false,
            });
        if !matches
            || source.blob.digest != self.content.digest
            || source.blob.byte_size != self.content.bytes.len() as u64
            || source.captured_at.unix_millis() < 0
            || source.captured_at.unix_millis() as u64 != self.content.captured_at_ms
        {
            return Err(super::Error::new(MaterialFailure::InputInvalid));
        }
        Ok(())
    }
}

/// Reads exactly the requested Wiki version; the content receipt cannot be fabricated by public input.
pub(crate) async fn acquire_wiki(
    wiki: &dyn WorldWiki,
    selection: WikiSelection,
    reference: &world_protocol::materials::SourceVersionRef,
    cancellation: CancellationToken,
) -> Result<WikiMaterial, super::Error> {
    let (project, path, version, is_page) = match &selection {
        WikiSelection::Source {
            project_id,
            source_id,
            version,
        } => (project_id, source_id, version, false),
        WikiSelection::Page {
            project_id,
            page_id,
            version,
        } => (project_id, page_id, version, true),
    };
    if project.is_empty()
        || version.is_empty()
        || !(if is_page {
            path.starts_with("wiki/") && path.ends_with(".md")
        } else {
            path.starts_with("raw/sources/")
        })
        || path.starts_with("wiki/media/")
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.contains('\\')
        || path.contains(':')
    {
        return Err(super::Error::new(MaterialFailure::InputInvalid));
    }
    if cancellation.is_cancelled() {
        return Err(super::Error::new(MaterialFailure::Cancelled));
    }
    let content = wiki
        .export_exact(project, path, version, cancellation.clone())
        .await?
        .ok_or_else(|| {
            super::Error::new(MaterialFailure::VersionContentUnavailable {
                reference: reference.clone(),
            })
        })?;
    if cancellation.is_cancelled() {
        return Err(super::Error::new(MaterialFailure::Cancelled));
    }
    if content.relative_path != *path
        || content.version != *version
        || content.digest
            != super::convert::digest(&format!(
                "{:x}",
                <sha2::Sha256 as sha2::Digest>::digest(&content.bytes)
            ))?
    {
        return Err(super::Error::new(MaterialFailure::DigestMismatch));
    }
    Ok(WikiMaterial { selection, content })
}

impl From<WikiExportError> for super::Error {
    fn from(error: WikiExportError) -> Self {
        Self::caused(error.reason.clone(), error)
    }
}
