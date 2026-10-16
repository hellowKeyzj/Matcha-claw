mod access;
mod media;

pub use media::{Media, MediaReceipt, MediaUpload};
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{config::ConfigStore, rpc};
use access::{Directory, RelativePath};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathParams {
    agent_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: String,
    #[serde(default)]
    path: String,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Encoding {
    #[default]
    Utf8,
    Bytes,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadParams {
    agent_id: String,
    path: String,
    #[serde(default)]
    encoding: Encoding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteParams {
    agent_id: String,
    path: String,
    #[serde(default)]
    encoding: Encoding,
    content: Content,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stat {
    name: String,
    kind: Kind,
    size: u64,
    mtime_ms: u64,
}

fn stat_metadata(name: String, kind: Kind, metadata: std::fs::Metadata) -> rpc::Result<Stat> {
    if kind == Kind::Symlink {
        return Err(access::denied());
    }
    if !matches!(kind, Kind::File | Kind::Directory) {
        return Err(rpc::Error::conflict(
            "workspace_special_file",
            "Only regular files and directories may be inspected",
        ));
    }
    let modified = metadata
        .modified()
        .map_err(|error| access::io_error("modified", error))?;
    let mtime_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| {
            rpc::Error::conflict(
                "workspace_timestamp_out_of_range",
                "The modification time predates the supported Unix timestamp range",
            )
            .with_source(error)
        })?
        .as_millis()
        .try_into()
        .map_err(|error| {
            rpc::Error::conflict(
                "workspace_timestamp_out_of_range",
                "The modification time exceeds the supported timestamp range",
            )
            .with_source(error)
        })?;
    Ok(Stat {
        name,
        kind,
        size: metadata.len(),
        mtime_ms,
    })
}

struct Location {
    root: PathBuf,
    workspace: PathBuf,
    relative: RelativePath,
}

impl Location {
    async fn prepare(config: &ConfigStore, agent_id: &str, path: &str) -> rpc::Result<Self> {
        crate::config::validate_id(agent_id)?;
        let relative = RelativePath::parse(path)?;
        let snapshot = config.snapshot().await;
        if !snapshot.agents.contains_key(agent_id) {
            return Err(rpc::Error::not_found("Agent"));
        }
        Ok(Self {
            root: config.paths().root().to_owned(),
            workspace: config.paths().workspace(agent_id)?,
            relative,
        })
    }

    fn directory(&self, parents_only: bool) -> rpc::Result<Directory> {
        let mut directory = Directory::open(&self.root, &self.workspace)?;
        let count = if parents_only {
            self.relative.segments.len().checked_sub(1).ok_or_else(|| {
                rpc::Error::invalid("The workspace root is not a file or removable directory")
            })?
        } else {
            self.relative.segments.len()
        };
        for name in &self.relative.segments[..count] {
            directory.descend(name)?;
        }
        Ok(directory)
    }

    fn leaf(&self) -> rpc::Result<&str> {
        self.relative
            .segments
            .last()
            .map(String::as_str)
            .ok_or_else(|| rpc::Error::invalid("A non-empty workspace-relative path is required"))
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> rpc::Result<T> + Send + 'static,
) -> rpc::Result<T> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|source| {
            rpc::Error::new(
                -32006,
                "workspace_worker_outcome_unknown",
                "The workspace worker stopped without a result; inspect the entry before retrying",
            )
            .with_source(source)
        })?
}

/// Raw bytes for the authenticated HTTP file route; never performs lossy UTF-8 conversion.
pub async fn read_file(config: &ConfigStore, agent_id: &str, path: &str) -> rpc::Result<Vec<u8>> {
    let location = Location::prepare(config, agent_id, path).await?;
    blocking(move || location.directory(true)?.read(location.leaf()?)).await
}

/// Atomic replacement in an existing, verified parent directory. Missing parents are not created.
pub async fn write_file(
    config: &ConfigStore,
    agent_id: &str,
    path: &str,
    bytes: &[u8],
) -> rpc::Result<()> {
    let location = Location::prepare(config, agent_id, path).await?;
    let (directory, name) = blocking(move || {
        let directory = location.directory(true)?;
        let name = location.leaf()?.to_owned();
        directory.observe_write(&name)?;
        Ok((directory, name))
    })
    .await?;
    let bytes = bytes.to_owned();
    // Keep directory custody until commit/cleanup finishes, even if the HTTP/RPC future is dropped.
    tokio::spawn(async move {
        let result = directory.write(&name, &bytes).await;
        drop(directory);
        result
    })
    .await
    .map_err(|source| {
        rpc::Error::new(
            -32006,
            "workspace_write_outcome_unknown",
            "The workspace write stopped without a result; inspect the file before retrying",
        )
        .with_source(source)
    })?
}

pub async fn dispatch(method: &str, params: Value, config: &ConfigStore) -> rpc::Result<Value> {
    match method {
        "workspace.list" => {
            let params: ListParams = rpc::params(params)?;
            let location = Location::prepare(config, &params.agent_id, &params.path).await?;
            blocking(move || {
                let entries = location.directory(false)?.list(&location.relative.path)?;
                Ok(json!({ "agentId": params.agent_id, "path": params.path, "entries": entries }))
            })
            .await
        }
        "workspace.stat" => {
            let params: PathParams = rpc::params(params)?;
            let location = Location::prepare(config, &params.agent_id, &params.path).await?;
            blocking(move || {
                let stat = if location.relative.segments.is_empty() {
                    location.directory(false)?.stat(None)?
                } else {
                    location.directory(true)?.stat(Some(location.leaf()?))?
                };
                Ok(json!({ "agentId": params.agent_id, "path": params.path,
                    "name": stat.name, "kind": stat.kind, "size": stat.size, "mtimeMs": stat.mtime_ms }))
            }).await
        }
        "workspace.read" => {
            let params: ReadParams = rpc::params(params)?;
            let bytes = read_file(config, &params.agent_id, &params.path).await?;
            blocking(move || {
                let content = match params.encoding {
                    Encoding::Bytes => Content::Bytes(bytes),
                    Encoding::Utf8 => Content::Text(String::from_utf8(bytes).map_err(|_| {
                        rpc::Error::conflict(
                            "workspace_not_utf8",
                            "The file is not valid UTF-8; request encoding bytes or use HTTP GET",
                        )
                    })?),
                };
                Ok(json!({
                    "agentId": params.agent_id, "path": params.path,
                    "encoding": params.encoding, "content": content
                }))
            })
            .await
        }
        "workspace.write" => {
            let params: WriteParams = rpc::params(params)?;
            let bytes = match (params.encoding, params.content) {
                (Encoding::Utf8, Content::Text(text)) => text.into_bytes(),
                (Encoding::Bytes, Content::Bytes(bytes)) => bytes,
                _ => {
                    return Err(rpc::Error::invalid(
                        "Content must match the requested encoding",
                    ));
                }
            };
            write_file(config, &params.agent_id, &params.path, &bytes).await?;
            Ok(json!({ "agentId": params.agent_id, "path": params.path, "size": bytes.len() }))
        }
        "workspace.mkdir" | "workspace.remove" => {
            let params: PathParams = rpc::params(params)?;
            let location = Location::prepare(config, &params.agent_id, &params.path).await?;
            let remove = method == "workspace.remove";
            let kind = blocking(move || {
                let directory = location.directory(true)?;
                if remove {
                    directory.remove(location.leaf()?)
                } else {
                    directory.mkdir(location.leaf()?)?;
                    Ok(Kind::Directory)
                }
            })
            .await?;
            Ok(json!({ "agentId": params.agent_id, "path": params.path, "kind": kind }))
        }
        _ => Err(rpc::Error::method(method)),
    }
}
