use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    application::commands::WikiStagedImportSource,
    domain::{
        WikiArtifactFileReceipt, WikiArtifactInput, WikiArtifactProcessingState as Processing,
        WikiArtifactReceipt, WikiArtifactSaveState, WikiArtifactSelector, WikiFailure,
        WikiProjectSelector, WikiSourceTaskKind, WikiSourceTaskStatus,
    },
};

use super::{
    actor::{WikiState, project_root, selected_project, write_json},
    source_lifecycle,
};

const ARCHIVES: &str = "raw/sources/.artifacts";
const MANIFEST: &str = "manifest.json";
const MAX_BYTES: usize = 6 * 1024 * 1024;
const MAX_FILES: usize = 128;

pub(crate) struct ArtifactUpload {
    pub selector: WikiArtifactSelector,
    title: String,
    source_url: Option<String>,
    fingerprint: String,
    files: Vec<ArtifactFile>,
}

struct ArtifactFile {
    relative_path: String,
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    plugin_id: String,
    project_id: String,
    request_key: String,
    title: String,
    source_url: Option<String>,
    fingerprint: String,
    call_id: platform::call::CallId,
    files: Vec<ManifestFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    relative_path: String,
    mime_type: String,
    byte_length: usize,
    content_hash: String,
    task_id: Option<String>,
}

pub(crate) struct ArtifactPlan {
    pub receipt: WikiArtifactReceipt,
    pub imports: Vec<WikiStagedImportSource>,
}

pub(crate) fn prepare(input: WikiArtifactInput) -> Result<ArtifactUpload, WikiFailure> {
    let selector = WikiArtifactSelector {
        plugin_id: input.plugin_id,
        project_id: input.project_id,
        request_key: input.request_key,
    };
    validate_selector(&selector)?;
    bounded_text("title", &input.title, 512)?;
    if let Some(url) = &input.source_url {
        bounded_text("sourceUrl", url, 4096)?;
    }
    if input.attachments.len() >= MAX_FILES {
        return Err(WikiFailure::invalid_input(
            "attachments",
            "at most 128 files are allowed",
        ));
    }
    let mut files = Vec::with_capacity(input.attachments.len() + 1);
    let mut paths = BTreeSet::new();
    let mut total = 0usize;
    for file in std::iter::once(input.main_file).chain(input.attachments) {
        validate_path(&file.relative_path)?;
        let folded = file.relative_path.to_lowercase();
        if paths.iter().any(|path: &String| {
            path == &folded
                || path.starts_with(&format!("{folded}/"))
                || folded.starts_with(&format!("{path}/"))
        }) {
            return Err(WikiFailure::invalid_input(
                "relativePath",
                "file paths overlap or repeat",
            ));
        }
        paths.insert(folded);
        let valid_mime = file
            .mime_type
            .split(';')
            .next()
            .and_then(|mime| mime.split_once('/'))
            .is_some_and(|(kind, subtype)| {
                [kind, subtype].into_iter().all(|part| {
                    !part.is_empty()
                        && part.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte)
                        })
                })
            });
        if file.mime_type.len() > 255 || !valid_mime || file.mime_type.chars().any(char::is_control)
        {
            return Err(WikiFailure::invalid_input(
                "mimeType",
                "a valid MIME type is required",
            ));
        }
        if file.content_base64.len() > MAX_BYTES * 4 / 3 {
            return Err(WikiFailure::invalid_input(
                "contentBase64",
                "total file bytes exceed 6 MiB",
            ));
        }
        let bytes = STANDARD
            .decode(&file.content_base64)
            .map_err(|_| WikiFailure::invalid_input("contentBase64", "invalid base64"))?;
        total = total
            .checked_add(bytes.len())
            .filter(|total| *total <= MAX_BYTES)
            .ok_or_else(|| {
                WikiFailure::invalid_input("contentBase64", "total file bytes exceed 6 MiB")
            })?;
        files.push(ArtifactFile {
            relative_path: file.relative_path,
            mime_type: file.mime_type,
            bytes,
        });
    }
    // Include roles and metadata, but not attachment order or base64 spelling, in content identity.
    let mut identity = files
        .iter()
        .enumerate()
        .map(|(index, file)| {
            (
                index == 0,
                file.relative_path.as_str(),
                file.mime_type.as_str(),
                hash(&file.bytes),
            )
        })
        .collect::<Vec<_>>();
    identity.sort();
    let fingerprint = hash(
        &serde_json::to_vec(&(&input.title, &input.source_url, identity))
            .map_err(|_| WikiFailure::state("Artifact identity is unavailable"))?,
    );
    Ok(ArtifactUpload {
        selector,
        title: input.title,
        source_url: input.source_url,
        fingerprint,
        files,
    })
}

pub(crate) fn stage(
    state: &WikiState,
    upload: ArtifactUpload,
    call_id: platform::call::CallId,
) -> Result<ArtifactPlan, WikiFailure> {
    let root = project_root(selected_project(state, Some(&upload.selector.project_id))?);
    let archive_id = archive_id(&upload.selector);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| WikiFailure::state("Artifact project is unavailable"))?;
    let mut parent = canonical_root.clone();
    for part in ARCHIVES.split('/') {
        parent.push(part);
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(WikiFailure::state(
                    "Artifact storage must be a real project directory",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&parent)
                    .map_err(|_| WikiFailure::state("Artifact storage is unavailable"))?;
            }
            Err(_) => return Err(WikiFailure::state("Artifact storage is unavailable")),
        }
        if !parent
            .canonicalize()
            .map_err(|_| WikiFailure::state("Artifact storage is unavailable"))?
            .starts_with(&canonical_root)
        {
            return Err(WikiFailure::state(
                "Artifact storage must remain inside the project",
            ));
        }
    }
    let destination = parent.join(&archive_id);
    match read_manifest(root, &archive_id)? {
        Some(manifest) => {
            if manifest.fingerprint != upload.fingerprint
                || !matches_selector(&manifest, &upload.selector)
            {
                return Err(conflict());
            }
            return Ok(ArtifactPlan {
                receipt: receipt(root, &archive_id, manifest)?,
                imports: Vec::new(),
            });
        }
        None => {}
    }
    let temporary = tempfile::Builder::new()
        .prefix(".upload-")
        .tempdir_in(&parent)
        .map_err(|_| WikiFailure::state("Artifact storage is unavailable"))?;
    let mut manifest = Manifest {
        plugin_id: upload.selector.plugin_id,
        project_id: upload.selector.project_id,
        request_key: upload.selector.request_key,
        title: upload.title,
        source_url: upload.source_url,
        fingerprint: upload.fingerprint,
        call_id,
        files: Vec::with_capacity(upload.files.len()),
    };
    for file in upload.files {
        let path = temporary.path().join("files").join(&file.relative_path);
        fs::create_dir_all(path.parent().expect("validated artifact parent"))
            .map_err(|_| WikiFailure::state("Artifact file could not be saved"))?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| WikiFailure::state("Artifact file could not be saved"))?;
        output
            .write_all(&file.bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| WikiFailure::state("Artifact file could not be saved"))?;
        manifest.files.push(ManifestFile {
            relative_path: file.relative_path,
            mime_type: file.mime_type,
            byte_length: file.bytes.len(),
            content_hash: hash(&file.bytes),
            task_id: None,
        });
    }
    write_json(temporary.path().join(MANIFEST), &manifest)
        .map_err(|_| WikiFailure::state("Artifact metadata could not be saved"))?;
    fs::rename(temporary.path(), &destination)
        .map_err(|_| WikiFailure::state("Artifact could not be published"))?;
    let mut imports = Vec::new();
    for file in &manifest.files {
        let relative = source_path(&archive_id, &file.relative_path);
        if source_lifecycle::is_ingestable_source_path(&relative, false) {
            imports.push(source_lifecycle::staged_raw_source(
                &manifest.project_id,
                root,
                root.join(&relative),
                relative,
                WikiSourceTaskKind::Imported,
            )?);
        }
    }
    // The bytes are already durable. Later staging failures leave the original archive queryable.
    source_lifecycle::append_source_tasks(root, &manifest.project_id, &mut imports, true)?;
    for staged in &imports {
        manifest
            .files
            .iter_mut()
            .find(|file| {
                source_path(&archive_id, &file.relative_path) == staged.source_relative_path
            })
            .expect("artifact source belongs to manifest")
            .task_id = Some(staged.task_id.clone());
    }
    write_json(destination.join(MANIFEST), &manifest)
        .map_err(|_| WikiFailure::state("Artifact task identity could not be saved"))?;
    let paths = imports
        .iter()
        .map(|staged| staged.source_relative_path.as_str())
        .collect::<Vec<_>>();
    source_lifecycle::refresh_file_snapshot(root, &paths)?;
    for staged in &imports {
        if let Some(execution) = &staged.execution {
            execution.published();
        }
    }
    Ok(ArtifactPlan {
        receipt: receipt(root, &archive_id, manifest)?,
        imports,
    })
}

pub(crate) fn status(
    state: &WikiState,
    selector: WikiArtifactSelector,
) -> Result<WikiArtifactReceipt, WikiFailure> {
    validate_selector(&selector)?;
    let root = project_root(selected_project(state, Some(&selector.project_id))?);
    let archive_id = archive_id(&selector);
    let manifest = read_manifest(root, &archive_id)?
        .filter(|manifest| matches_selector(manifest, &selector))
        .ok_or_else(|| WikiFailure::not_found("artifact"))?;
    receipt(root, &archive_id, manifest)
}

fn receipt(
    root: &Path,
    archive_id: &str,
    manifest: Manifest,
) -> Result<WikiArtifactReceipt, WikiFailure> {
    let tasks = source_lifecycle::source_tasks(
        root,
        WikiProjectSelector {
            project_id: Some(manifest.project_id.clone()),
        },
    )?;
    let files = manifest
        .files
        .into_iter()
        .map(|file| {
            let source_path = source_path(archive_id, &file.relative_path);
            let task = tasks.tasks().iter().find(|task| {
                Some(task.id()) == file.task_id.as_deref()
                    && task.project_id() == manifest.project_id
                    && task.source_path() == source_path
                    && task.kind() == &WikiSourceTaskKind::Imported
            });
            let (parse_state, index_state) = match task {
                Some(task) => processing(task),
                None if !source_lifecycle::is_ingestable_source_path(&source_path, false) => {
                    (Processing::Unsupported, Processing::Unsupported)
                }
                None => (Processing::Unknown, Processing::Unknown),
            };
            WikiArtifactFileReceipt {
                relative_path: file.relative_path,
                mime_type: file.mime_type,
                byte_length: file.byte_length,
                source_path,
                task_id: file.task_id,
                parse_state,
                index_state,
            }
        })
        .collect();
    Ok(WikiArtifactReceipt {
        archive_id: archive_id.to_owned(),
        project_id: manifest.project_id,
        request_key: manifest.request_key,
        title: manifest.title,
        source_url: manifest.source_url,
        call_id: manifest.call_id,
        accepted: true,
        save_state: WikiArtifactSaveState::Saved,
        files,
    })
}

fn processing(task: &crate::WikiSourceTask) -> (Processing, Processing) {
    let parsed = matches!(
        task.stage(),
        Some(
            "commit"
                | "caption"
                | "analyze"
                | "generate"
                | "repair"
                | "review"
                | "write"
                | "index"
                | "embed"
                | "done"
        )
    );
    match task.status() {
        WikiSourceTaskStatus::Done => (Processing::Completed, Processing::Completed),
        WikiSourceTaskStatus::Cancelled => (
            if parsed {
                Processing::Completed
            } else {
                Processing::Cancelled
            },
            Processing::Cancelled,
        ),
        WikiSourceTaskStatus::Failed => (
            if parsed {
                Processing::Completed
            } else {
                Processing::Failed
            },
            Processing::Failed,
        ),
        WikiSourceTaskStatus::Pending => (Processing::Pending, Processing::Pending),
        WikiSourceTaskStatus::Running => (
            if parsed {
                Processing::Completed
            } else {
                Processing::Running
            },
            if matches!(task.stage(), Some("index" | "embed")) {
                Processing::Running
            } else {
                Processing::Pending
            },
        ),
    }
}

fn read_manifest(root: &Path, archive_id: &str) -> Result<Option<Manifest>, WikiFailure> {
    let root = root
        .canonicalize()
        .map_err(|_| WikiFailure::state("Artifact project is unavailable"))?;
    let mut path = root.clone();
    for part in ARCHIVES.split('/').chain([archive_id, MANIFEST]) {
        path.push(part);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && part != MANIFEST => {
                return Ok(None);
            }
            Err(_) => return Err(WikiFailure::state("Artifact metadata is unavailable")),
        };
        if metadata.file_type().is_symlink()
            || if part == MANIFEST {
                !metadata.is_file() || metadata.len() > 256 * 1024
            } else {
                !metadata.is_dir()
            }
            || !path
                .canonicalize()
                .map_err(|_| WikiFailure::state("Artifact metadata is unavailable"))?
                .starts_with(&root)
        {
            return Err(WikiFailure::state("Artifact metadata is unavailable"));
        }
    }
    let bytes =
        fs::read(path).map_err(|_| WikiFailure::state("Artifact metadata is unavailable"))?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| WikiFailure::state("Artifact metadata is invalid"))?;
    if manifest.files.is_empty()
        || manifest.files.len() > MAX_FILES
        || manifest
            .files
            .iter()
            .any(|file| validate_path(&file.relative_path).is_err())
    {
        return Err(WikiFailure::state("Artifact metadata is invalid"));
    }
    Ok(Some(manifest))
}

fn matches_selector(manifest: &Manifest, selector: &WikiArtifactSelector) -> bool {
    manifest.plugin_id == selector.plugin_id
        && manifest.project_id == selector.project_id
        && manifest.request_key == selector.request_key
}

fn archive_id(selector: &WikiArtifactSelector) -> String {
    hash(
        &serde_json::to_vec(&(
            &selector.plugin_id,
            &selector.project_id,
            &selector.request_key,
        ))
        .expect("artifact identity serializes"),
    )
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn source_path(archive_id: &str, relative_path: &str) -> String {
    format!("{ARCHIVES}/{archive_id}/files/{relative_path}")
}

fn validate_selector(selector: &WikiArtifactSelector) -> Result<(), WikiFailure> {
    bounded_text("pluginId", &selector.plugin_id, 128)?;
    bounded_text("projectId", &selector.project_id, 256)?;
    bounded_text("requestKey", &selector.request_key, 256)
}

fn bounded_text(field: &str, text: &str, max: usize) -> Result<(), WikiFailure> {
    if text.trim().is_empty() || text.len() > max || text.chars().any(char::is_control) {
        return Err(WikiFailure::invalid_input(
            field,
            "value is empty, too long, or contains control characters",
        ));
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), WikiFailure> {
    let safe = crate::domain::safe_relative_path(path).map_err(|_| {
        WikiFailure::invalid_input("relativePath", "a safe relative file path is required")
    })?;
    if path.is_empty()
        || path.len() > 512
        || safe != PathBuf::from(path)
        || path.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|character| character.is_control() || "\\<>:\"|?*".contains(character))
                || matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
    {
        return Err(WikiFailure::invalid_input(
            "relativePath",
            "a safe relative file path is required",
        ));
    }
    Ok(())
}

fn conflict() -> WikiFailure {
    WikiFailure::RequestKeyConflict
}

pub(crate) fn public_failure(error: WikiFailure) -> WikiFailure {
    match error {
        WikiFailure::InvalidInput { .. }
        | WikiFailure::ProjectNotFound { .. }
        | WikiFailure::RequestKeyConflict
        | WikiFailure::OwnerUnavailable
        | WikiFailure::NotFound { .. } => error,
        _ => WikiFailure::state(
            "Artifact operation could not be confirmed; query its request key before submitting again",
        ),
    }
}

// Artifact Markdown may reference its own attachments, never arbitrary local files.
pub(super) fn allows_local_image(source_dir: &Path, source: &Path) -> bool {
    let Some(files_root) = source_dir.ancestors().find(|path| {
        path.file_name().is_some_and(|name| name == "files")
            && path
                .parent()
                .and_then(Path::parent)
                .is_some_and(|parent| parent.file_name().is_some_and(|name| name == ".artifacts"))
    }) else {
        return true;
    };
    source
        .canonicalize()
        .ok()
        .zip(files_root.canonicalize().ok())
        .is_some_and(|(source, root)| source.starts_with(root))
}
