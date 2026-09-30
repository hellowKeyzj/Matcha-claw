use std::path::PathBuf;

use crate::{
    archive::{self, ArchiveError},
    domain::{
        WikiArchiveExportInput, WikiArchiveImportInput, WikiFailure, WikiOpenProjectInput,
        WikiProjectSelector, WikiProjectsReceipt, WikiRebuildIndexReceipt,
    },
};

use super::actor::{
    WikiShared, WikiState, open_project, project_root, selected_project, write_file_snapshot,
};

pub(crate) fn export_archive(
    state: &WikiState,
    input: WikiArchiveExportInput,
) -> Result<(), WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    archive::export_project_archive(project_root(project), input.destination)
        .map_err(archive_failure)
}

pub(crate) async fn import_archive(
    shared: &WikiShared,
    input: WikiArchiveImportInput,
) -> Result<WikiProjectsReceipt, WikiFailure> {
    let root: PathBuf = tokio::task::spawn_blocking(move || {
        archive::import_project_archive(input.archive_path, input.destination)
            .map_err(archive_failure)
    })
    .await
    .map_err(|_| WikiFailure::state("Wiki project import task failed"))??;
    open_project(
        shared,
        WikiOpenProjectInput {
            root_path: root.to_string_lossy().into_owned(),
            title: None,
        },
    )
    .await
    .map_err(|_| WikiFailure::state("Imported Wiki project could not be registered"))
}

pub(crate) fn rebuild_index(
    state: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiRebuildIndexReceipt, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    crate::history::record(root, "wiki/index.md", "baseline", "before.ui.rebuild_index")?;
    let result = archive::rebuild_wiki_index(root).map_err(archive_failure)?;
    if crate::history::record(root, "wiki/index.md", "human", "ui.rebuild_index").is_err() {
        eprintln!("[wiki] index rebuilt; history recording failed");
    }
    write_file_snapshot(root).map_err(|_| {
        WikiFailure::state("Wiki index was rebuilt but its snapshot could not be refreshed")
    })?;
    Ok(WikiRebuildIndexReceipt {
        project_id: project.project_id().to_owned(),
        pages: result.pages,
        groups: result.groups,
    })
}

fn archive_failure(error: ArchiveError) -> WikiFailure {
    match error {
        ArchiveError::InvalidProjectRoot { reason, .. } => {
            WikiFailure::invalid_input("archive", reason)
        }
        ArchiveError::InvalidPath(message) => WikiFailure::invalid_input("path", message),
        ArchiveError::ExportDestinationInsideProject => WikiFailure::invalid_input(
            "destination",
            "Export destination must be outside the project directory",
        ),
        ArchiveError::ImportDestinationNotEmpty(_) => {
            WikiFailure::invalid_input("destination", "Import destination must be empty")
        }
        ArchiveError::UnsafeArchivePath(_) => {
            WikiFailure::invalid_input("archive", "Archive contains an unsafe path")
        }
        ArchiveError::UnsupportedArchiveEntry(_) => {
            WikiFailure::invalid_input("archive", "Archive contains an unsupported entry")
        }
        ArchiveError::ArchiveTooLarge => {
            WikiFailure::invalid_input("archive", "Project archive exceeds the 4 GB expanded limit")
        }
        ArchiveError::TooManyArchiveEntries => {
            WikiFailure::invalid_input("archive", "Project archive contains too many entries")
        }
        ArchiveError::Io { action, .. } => {
            WikiFailure::state(format!("Wiki maintenance could not {action}"))
        }
        ArchiveError::Zip(_) => {
            WikiFailure::invalid_input("archive", "Project ZIP archive could not be processed")
        }
    }
}
