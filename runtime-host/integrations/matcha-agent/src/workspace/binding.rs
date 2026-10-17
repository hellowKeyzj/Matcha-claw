use serde::Deserialize;
use serde_json::json;
use workspace_module::{
    WorkspaceBinaryFailure, WorkspaceBinaryReceipt, WorkspaceDirectoryEntry,
    WorkspaceDirectoryReceipt, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure, WorkspaceWriteReceipt, ports::WorkspaceFuture,
};

use super::media;
use crate::client::{Client, Delivery};

pub(super) struct Binding {
    pub client: Client,
    pub agent_id: String,
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stat {
    name: String,
    kind: String,
    size: u64,
    mtime_ms: u64,
}

#[derive(Deserialize)]
struct Listing {
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
}

impl Binding {
    pub fn new(client: Client, agent_id: String, session_id: Option<String>) -> Self {
        Self {
            client,
            agent_id,
            session_id,
        }
    }

    pub async fn bytes(&self, path: &str) -> Result<Vec<u8>, WorkspaceMediaFailure> {
        let path = path.replace('\\', "/");
        self.client
            .read_file(&self.agent_id, &path)
            .await
            .map_err(media::failure)
    }
}

impl workspace_module::WorkspaceBinding for Binding {
    fn resource_key(&self) -> Option<&str> {
        Some(&self.agent_id)
    }

    fn read_text<'a>(
        &'a self,
        relative_path: &'a str,
        limit: usize,
    ) -> WorkspaceFuture<'a, WorkspaceTextReceipt, WorkspaceReadFailure> {
        Box::pin(async move {
            let path = relative_path.replace('\\', "/");
            let bytes = self
                .client
                .read_file(&self.agent_id, &path)
                .await
                .map_err(|error| match error.kind() {
                    "invalid_params"
                    | "workspace_link_forbidden"
                    | "workspace_hardlink_forbidden" => WorkspaceReadFailure::InvalidPath,
                    "workspace_not_file" => WorkspaceReadFailure::NotFile,
                    _ => WorkspaceReadFailure::Unavailable,
                })?;
            if bytes.len() > limit {
                return Err(WorkspaceReadFailure::TooLarge);
            }
            if bytes.contains(&0) {
                return Err(WorkspaceReadFailure::Binary);
            }
            let size = bytes.len() as u64;
            let content = String::from_utf8(bytes).map_err(|_| WorkspaceReadFailure::Binary)?;
            Ok(WorkspaceTextReceipt::new(name(&path), content, size))
        })
    }

    fn read_binary<'a>(
        &'a self,
        relative_path: &'a str,
        limit: usize,
    ) -> WorkspaceFuture<'a, WorkspaceBinaryReceipt, WorkspaceBinaryFailure> {
        Box::pin(async move {
            let path = relative_path.replace('\\', "/");
            let bytes = self
                .client
                .read_file(&self.agent_id, &path)
                .await
                .map_err(|error| match error.kind() {
                    "invalid_params"
                    | "workspace_link_forbidden"
                    | "workspace_hardlink_forbidden" => WorkspaceBinaryFailure::InvalidPath,
                    "workspace_not_file" => WorkspaceBinaryFailure::NotFile,
                    _ => WorkspaceBinaryFailure::Unavailable,
                })?;
            if bytes.len() > limit {
                return Err(WorkspaceBinaryFailure::TooLarge);
            }
            let size = bytes.len() as u64;
            Ok(WorkspaceBinaryReceipt::new(name(&path), bytes, size))
        })
    }

    fn stat_file<'a>(
        &'a self,
        relative_path: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceStatReceipt, WorkspaceStatFailure> {
        Box::pin(async move {
            let path = relative_path.replace('\\', "/");
            let value = self
                .client
                .call(
                    "workspace.stat",
                    json!({ "agentId": self.agent_id, "path": path }),
                )
                .await
                .map_err(|error| match error.kind() {
                    "invalid_params" | "workspace_link_forbidden" => {
                        WorkspaceStatFailure::InvalidPath
                    }
                    _ => WorkspaceStatFailure::Unavailable,
                })?;
            let stat: Stat =
                serde_json::from_value(value).map_err(|_| WorkspaceStatFailure::Unavailable)?;
            if !matches!(stat.kind.as_str(), "file" | "directory") {
                return Err(WorkspaceStatFailure::Unavailable);
            }
            Ok(WorkspaceStatReceipt::new(
                stat.name,
                stat.kind == "directory",
                stat.size,
                stat.mtime_ms,
            ))
        })
    }

    fn list_directory<'a>(
        &'a self,
        relative_path: &'a str,
        include_hidden: bool,
    ) -> WorkspaceFuture<'a, WorkspaceDirectoryReceipt, WorkspaceListFailure> {
        Box::pin(async move {
            let path = relative_path.replace('\\', "/");
            let value = self
                .client
                .call(
                    "workspace.list",
                    json!({ "agentId": self.agent_id, "path": path }),
                )
                .await
                .map_err(|error| match error.kind() {
                    "invalid_params" | "workspace_link_forbidden" => {
                        WorkspaceListFailure::InvalidPath
                    }
                    "workspace_not_directory" => WorkspaceListFailure::NotDirectory,
                    _ => WorkspaceListFailure::Unavailable,
                })?;
            let listing: Listing =
                serde_json::from_value(value).map_err(|_| WorkspaceListFailure::Unavailable)?;
            let mut entries = listing
                .entries
                .into_iter()
                .filter(|entry| {
                    (include_hidden || !entry.name.starts_with('.'))
                        && matches!(entry.kind.as_str(), "file" | "directory")
                })
                .map(|entry| {
                    let directory = entry.kind == "directory";
                    let size = if directory {
                        0
                    } else {
                        entry.size.ok_or(WorkspaceListFailure::Unavailable)?
                    };
                    Ok(WorkspaceDirectoryEntry::new(
                        entry.path, entry.name, directory, size,
                    ))
                })
                .collect::<Result<Vec<_>, WorkspaceListFailure>>()?;
            entries.sort_by(|left, right| {
                right
                    .is_directory()
                    .cmp(&left.is_directory())
                    .then_with(|| {
                        left.display()
                            .to_lowercase()
                            .cmp(&right.display().to_lowercase())
                    })
            });
            Ok(WorkspaceDirectoryReceipt::new(entries))
        })
    }

    fn write_text<'a>(
        &'a self,
        relative_path: &'a str,
        content: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceWriteReceipt, WorkspaceWriteFailure> {
        Box::pin(async move {
            let path = relative_path.replace('\\', "/");
            self.client
                .write_file(&self.agent_id, &path, content.as_bytes())
                .await
                .map_err(|error| {
                    if error.delivery() == Delivery::Unknown || error.code() == Some(-32006) {
                        WorkspaceWriteFailure::OutcomeUnknown
                    } else {
                        match error.kind() {
                            "invalid_params" | "workspace_link_forbidden" => {
                                WorkspaceWriteFailure::InvalidPath
                            }
                            "workspace_not_file" => WorkspaceWriteFailure::NotFile,
                            _ => WorkspaceWriteFailure::Unavailable,
                        }
                    }
                })?;
            Ok(WorkspaceWriteReceipt::new(
                name(&path),
                content.len() as u64,
            ))
        })
    }

    fn prepare_media<'a>(
        &'a self,
        _session_key: &'a str,
        relative_path: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaReceipt, WorkspaceMediaFailure> {
        Box::pin(async move {
            let session_id = self
                .session_id
                .as_deref()
                .ok_or(WorkspaceMediaFailure::Unavailable)?;
            let bytes = self.bytes(relative_path).await?;
            media::stage(
                &self.client,
                &self.agent_id,
                session_id,
                bytes,
                &name(relative_path),
                mime_type,
            )
            .await
        })
    }

    fn thumbnail_media<'a>(
        &'a self,
        relative_path: &'a str,
        mime_type: &'a str,
    ) -> WorkspaceFuture<'a, WorkspaceMediaThumbnail, WorkspaceMediaFailure> {
        Box::pin(async move {
            let bytes = self.bytes(relative_path).await?;
            media::thumbnail(bytes, relative_path, mime_type).await
        })
    }

    fn thumbnails_media<'a>(
        &'a self,
        _session_key: &'a str,
        paths: &'a [WorkspaceMediaPath],
    ) -> WorkspaceFuture<'a, Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure> {
        Box::pin(async move {
            let mut entries = Vec::with_capacity(paths.len());
            for path in paths {
                // Batch thumbnail errors remain soft, as in the existing product contract.
                let thumbnail = match path {
                    WorkspaceMediaPath::Relative {
                        relative_path,
                        mime_type,
                        ..
                    } => match self.bytes(relative_path).await {
                        Ok(bytes) => media::thumbnail(bytes, relative_path, mime_type).await,
                        Err(error) => Err(error),
                    },
                    WorkspaceMediaPath::Gateway { .. } => Err(WorkspaceMediaFailure::InvalidPath),
                }
                .unwrap_or_else(|_| WorkspaceMediaThumbnail::new(None, 0));
                entries.push(WorkspaceMediaThumbnailEntry::new(
                    path.key().to_owned(),
                    thumbnail,
                ));
            }
            Ok(entries)
        })
    }

    fn stage_paths_media<'a>(
        &'a self,
        _session_key: &'a str,
        paths: &'a [WorkspaceMediaPath],
    ) -> WorkspaceFuture<'a, Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure> {
        Box::pin(async move {
            let session_id = self
                .session_id
                .as_deref()
                .ok_or(WorkspaceMediaFailure::Unavailable)?;
            let mut prepared = Vec::with_capacity(paths.len());
            for path in paths {
                let WorkspaceMediaPath::Relative {
                    relative_path,
                    mime_type,
                    ..
                } = path
                else {
                    return Err(WorkspaceMediaFailure::InvalidPath);
                };
                prepared.push((
                    self.bytes(relative_path).await?,
                    name(relative_path),
                    mime_type,
                ));
            }
            let mut receipts = Vec::with_capacity(prepared.len());
            for (bytes, name, mime_type) in prepared {
                receipts.push(
                    media::stage(
                        &self.client,
                        &self.agent_id,
                        session_id,
                        bytes,
                        &name,
                        mime_type,
                    )
                    .await?,
                );
            }
            Ok(receipts)
        })
    }
}

fn name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_owned()
}
