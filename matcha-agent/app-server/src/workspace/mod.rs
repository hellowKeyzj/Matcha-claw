mod access;
mod media;

pub use media::{Media, MediaReceipt, MediaUpload};
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    config::{ConfigStore, Paths},
    rpc,
    session::Sessions,
};
use access::{Directory, RelativePath};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathParams {
    agent_id: String,
    session_id: Option<String>,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: String,
    session_id: Option<String>,
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
    session_id: Option<String>,
    path: String,
    #[serde(default)]
    encoding: Encoding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteParams {
    agent_id: String,
    session_id: Option<String>,
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

pub(crate) fn native_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return path;
        };
        let mut ordinary = match prefix.kind() {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", char::from(drive))),
            Prefix::VerbatimUNC(server, share) => {
                let mut root = std::ffi::OsString::from(r"\\");
                root.push(server);
                root.push(r"\");
                root.push(share);
                PathBuf::from(root)
            }
            _ => return path,
        };
        ordinary.extend(components);
        ordinary
    }
    #[cfg(not(windows))]
    {
        path
    }
}

pub(crate) fn checked_directory(path: &Path) -> rpc::Result<PathBuf> {
    Directory::open(path).map(|(_, canonical)| canonical)
}

pub(crate) async fn canonical_directory(path: &Path) -> rpc::Result<PathBuf> {
    let path = path.to_owned();
    blocking(move || checked_directory(&path)).await
}

// The authenticated native management RPC grants Session execution custody, not Agent data custody.
pub(crate) async fn session_directory(
    paths: &Paths,
    agent_id: &str,
    path: &Path,
) -> rpc::Result<PathBuf> {
    let canonical = canonical_directory(path).await?;
    let workspace = native_path(paths.workspace(agent_id)?);
    let home = native_path(paths.root().to_owned());
    if (canonical.starts_with(&home) && !canonical.starts_with(&workspace))
        || home.starts_with(&canonical)
    {
        return Err(rpc::Error::new(
            -32007,
            "session_workspace_forbidden",
            "Session execution cannot expose private Agent or server data",
        ));
    }
    Ok(canonical)
}

struct Location {
    root: Directory,
    workspace: PathBuf,
    relative: RelativePath,
}

impl Location {
    async fn prepare(config: &ConfigStore, agent_id: &str, path: &str) -> rpc::Result<Self> {
        crate::config::validate_id(agent_id)?;
        if !config.snapshot().await.agents.contains_key(agent_id) {
            return Err(rpc::Error::not_found("Agent"));
        }
        Self::open(config.paths().workspace(agent_id)?, path).await
    }

    async fn scoped(
        config: &ConfigStore,
        sessions: &Sessions,
        agent_id: &str,
        session_id: Option<&str>,
        path: &str,
    ) -> rpc::Result<Self> {
        let Some(session_id) = session_id else {
            return Self::prepare(config, agent_id, path).await;
        };
        crate::config::validate_id(agent_id)?;
        if !config.snapshot().await.agents.contains_key(agent_id) {
            return Err(rpc::Error::not_found("Agent"));
        }
        let files = sessions.native_files(session_id).await?;
        if files.agent_id != agent_id {
            return Err(rpc::Error::conflict(
                "session_agent_mismatch",
                "This Session belongs to another Agent",
            ));
        }
        Self::open(files.workspace, path).await
    }

    async fn open(workspace: PathBuf, path: &str) -> rpc::Result<Self> {
        let relative = RelativePath::parse(path)?;
        blocking(move || {
            let (root, workspace) = Directory::open(&workspace)?;
            Ok(Self {
                root,
                workspace,
                relative,
            })
        })
        .await
    }

    fn directory(self, parents_only: bool) -> rpc::Result<Directory> {
        let mut directory = self.root;
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
    read_location(Location::prepare(config, agent_id, path).await?).await
}

pub(crate) async fn read_session_file(
    config: &ConfigStore,
    sessions: &Sessions,
    agent_id: &str,
    session_id: Option<&str>,
    path: &str,
) -> rpc::Result<Vec<u8>> {
    read_location(Location::scoped(config, sessions, agent_id, session_id, path).await?).await
}

async fn read_location(location: Location) -> rpc::Result<Vec<u8>> {
    blocking(move || {
        let name = location.leaf()?.to_owned();
        location.directory(true)?.read(&name)
    })
    .await
}

/// Atomic replacement in an existing, verified parent directory. Missing parents are not created.
pub async fn write_file(
    config: &ConfigStore,
    agent_id: &str,
    path: &str,
    bytes: &[u8],
) -> rpc::Result<()> {
    write_location(Location::prepare(config, agent_id, path).await?, bytes).await
}

pub(crate) async fn write_session_file(
    config: &ConfigStore,
    sessions: &Sessions,
    agent_id: &str,
    session_id: Option<&str>,
    path: &str,
    bytes: &[u8],
) -> rpc::Result<()> {
    write_location(
        Location::scoped(config, sessions, agent_id, session_id, path).await?,
        bytes,
    )
    .await
}

async fn write_location(location: Location, bytes: &[u8]) -> rpc::Result<()> {
    let (directory, name) = blocking(move || {
        let name = location.leaf()?.to_owned();
        let directory = location.directory(true)?;
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

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "workspace.list" => {
            let params: ListParams = rpc::params(params)?;
            let location = Location::scoped(
                config,
                sessions,
                &params.agent_id,
                params.session_id.as_deref(),
                &params.path,
            )
            .await?;
            blocking(move || {
                let path = location.relative.path.clone();
                let entries = location.directory(false)?.list(&path)?;
                Ok(json!({ "agentId": params.agent_id, "sessionId": params.session_id, "path": params.path, "entries": entries }))
            })
            .await
        }
        "workspace.stat" => {
            let params: PathParams = rpc::params(params)?;
            let location = Location::scoped(
                config,
                sessions,
                &params.agent_id,
                params.session_id.as_deref(),
                &params.path,
            )
            .await?;
            blocking(move || {
                let root = location.workspace.clone();
                let stat = if location.relative.segments.is_empty() {
                    location.directory(false)?.stat(None)?
                } else {
                    let name = location.leaf()?.to_owned();
                    location.directory(true)?.stat(Some(&name))?
                };
                Ok(json!({ "agentId": params.agent_id, "sessionId": params.session_id, "path": params.path, "root": root,
                    "name": stat.name, "kind": stat.kind, "size": stat.size, "mtimeMs": stat.mtime_ms }))
            }).await
        }
        "workspace.read" => {
            let params: ReadParams = rpc::params(params)?;
            let bytes = read_session_file(
                config,
                sessions,
                &params.agent_id,
                params.session_id.as_deref(),
                &params.path,
            )
            .await?;
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
            write_session_file(
                config,
                sessions,
                &params.agent_id,
                params.session_id.as_deref(),
                &params.path,
                &bytes,
            )
            .await?;
            Ok(json!({ "agentId": params.agent_id, "path": params.path, "size": bytes.len() }))
        }
        "workspace.mkdir" | "workspace.remove" => {
            let params: PathParams = rpc::params(params)?;
            let location = Location::scoped(
                config,
                sessions,
                &params.agent_id,
                params.session_id.as_deref(),
                &params.path,
            )
            .await?;
            let remove = method == "workspace.remove";
            let kind = blocking(move || {
                let name = location.leaf()?.to_owned();
                let directory = location.directory(true)?;
                if remove {
                    directory.remove(&name)
                } else {
                    directory.mkdir(&name)?;
                    Ok(Kind::Directory)
                }
            })
            .await?;
            Ok(json!({ "agentId": params.agent_id, "path": params.path, "kind": kind }))
        }
        _ => Err(rpc::Error::method(method)),
    }
}
