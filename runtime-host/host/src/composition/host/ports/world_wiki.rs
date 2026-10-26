use tokio_util::sync::CancellationToken;
use world::{WikiExportError, WikiExportFuture, WikiVersion, WorldWiki};
use world_protocol::{ids::Digest, materials::MaterialFailure};

pub(crate) struct HostWorldWiki(pub(crate) wiki::WikiHandle);

#[derive(Debug)]
struct WikiCause(wiki::WikiFailure);

impl std::fmt::Display for WikiCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Wiki immutable export failed")
    }
}

impl std::error::Error for WikiCause {}

impl WorldWiki for HostWorldWiki {
    fn export_exact<'a>(
        &'a self,
        project_id: &'a str,
        relative_path: &'a str,
        version: &'a str,
        cancellation: CancellationToken,
    ) -> WikiExportFuture<'a> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(WikiExportError::new(MaterialFailure::Cancelled));
            }
            // Admitted Wiki work retains its owner custody; do not race and drop its response.
            let exported = self
                .0
                .export_version(wiki::history::WikiVersionInput {
                    project_id: project_id.to_owned(),
                    relative_path: relative_path.to_owned(),
                    version: version.to_owned(),
                })
                .await;
            if cancellation.is_cancelled() {
                return Err(WikiExportError::new(MaterialFailure::Cancelled));
            }
            let exported = exported.map_err(|cause| {
                let reason = match &cause {
                    wiki::WikiFailure::Cancelled => MaterialFailure::Cancelled,
                    wiki::WikiFailure::InvalidInput { .. }
                    | wiki::WikiFailure::InvalidPath { .. }
                    | wiki::WikiFailure::PathOutsideProject { .. } => MaterialFailure::InputInvalid,
                    _ => MaterialFailure::ReadFailed,
                };
                WikiExportError::caused(reason, WikiCause(cause))
            })?;
            match exported {
                wiki::history::WikiVersionExport::VersionContentUnavailable => Ok(None),
                wiki::history::WikiVersionExport::Available(content) => {
                    let digest = Digest::try_new(format!("sha256:{}", content.digest))
                        .map_err(|_| WikiExportError::new(MaterialFailure::DigestMismatch))?;
                    Ok(Some(WikiVersion {
                        relative_path: content.relative_path,
                        version: content.version,
                        digest,
                        captured_at_ms: content.captured_at_ms,
                        bytes: content.bytes,
                    }))
                }
            }
        })
    }
}
