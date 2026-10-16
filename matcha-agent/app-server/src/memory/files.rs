use crate::{config::ConfigStore, persistence::atomic_write, rpc};
use serde::Serialize;
use serde_json::json;
use std::{
    io,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::fs;

// Shared only by the native memory and instruction-file owners.
pub(crate) struct Root {
    anchor: PathBuf,
    relative: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub path: String,
    pub bytes: u64,
    pub modified_at_ms: Option<u64>,
}

pub(crate) fn relative(path: &str, empty: bool) -> rpc::Result<PathBuf> {
    if path.is_empty() && empty {
        return Ok(PathBuf::new());
    }
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(
                    &stem[3..],
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                );
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || device
        {
            return Err(rpc::Error::invalid(
                "path must be a relative file path with safe components",
            ));
        }
    }
    Ok(PathBuf::from(path))
}

impl Root {
    pub(crate) async fn open(
        config: &ConfigStore,
        agent_id: &str,
        directory: &Path,
    ) -> rpc::Result<Self> {
        crate::config::validate_id(agent_id)?;
        if !config.snapshot().await.agents.contains_key(agent_id) {
            return Err(rpc::Error::not_found("Agent"));
        }
        let relative = directory
            .strip_prefix(config.paths().root())
            .map_err(|_| rpc::Error::internal("native_root_mapping"))?
            .to_path_buf();
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(rpc::Error::internal("native_root_mapping"));
        }
        let anchor = fs::canonicalize(config.paths().root())
            .await
            .map_err(|error| storage("native_root_resolve", error))?;
        Ok(Self { anchor, relative })
    }

    // Resolve every existing component; never follow links, junctions or reparse points.
    // Reads do not materialize missing directories. Writes create checked parents only.
    async fn resolve(&self, path: &str, write: bool) -> rpc::Result<Option<PathBuf>> {
        let target = self.relative.join(relative(path, true)?);
        let mut current = self.anchor.clone();
        let mut parts = target.components().peekable();
        let mut resource_root = None;
        let root_depth = self.relative.components().count();
        let mut depth = 0;
        while let Some(part) = parts.next() {
            depth += 1;
            current.push(part.as_os_str());
            let last = parts.peek().is_none();
            let metadata = match fs::symlink_metadata(&current).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if !write {
                        return Ok(None);
                    }
                    if last {
                        return Ok(Some(current));
                    }
                    match fs::create_dir(&current).await {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(storage("native_parent_create", error)),
                    }
                    fs::symlink_metadata(&current)
                        .await
                        .map_err(|error| storage("native_parent_inspect", error))?
                }
                Err(error) => return Err(storage("native_path_inspect", error)),
            };
            if linked(&metadata) {
                return Err(rpc::Error::new(
                    -32007,
                    "native_path_link",
                    "Native text resources cannot traverse links or reparse points",
                ));
            }
            if !last && !metadata.is_dir() {
                return Err(rpc::Error::conflict(
                    "native_parent_not_directory",
                    "A path parent is not a directory",
                ));
            }
            current = fs::canonicalize(&current)
                .await
                .map_err(|error| storage("native_path_resolve", error))?;
            if !current.starts_with(&self.anchor)
                || resource_root
                    .as_ref()
                    .is_some_and(|root: &PathBuf| !current.starts_with(root))
            {
                return Err(rpc::Error::new(
                    -32007,
                    "native_path_escape",
                    "Native text path escapes its root",
                ));
            }
            if depth == root_depth {
                resource_root = Some(current.clone());
            }
        }
        Ok(Some(current))
    }

    pub(crate) async fn entry(&self, path: &str) -> rpc::Result<Option<Entry>> {
        let Some(resolved) = self.resolve(path, false).await? else {
            return Ok(None);
        };
        let metadata = fs::metadata(resolved)
            .await
            .map_err(|error| storage("native_file_inspect", error))?;
        require_file(&metadata)?;
        Ok(Some(Entry {
            path: path.to_owned(),
            bytes: metadata.len(),
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .and_then(|time| time.as_millis().try_into().ok()),
        }))
    }

    pub(crate) async fn list(&self, directory: &str) -> rpc::Result<Vec<Entry>> {
        let mut pending = vec![directory.to_owned()];
        let mut entries = Vec::new();
        while let Some(directory) = pending.pop() {
            let Some(resolved) = self.resolve(&directory, false).await? else {
                continue;
            };
            let mut children = fs::read_dir(resolved)
                .await
                .map_err(|error| storage("native_directory_read", error))?;
            while let Some(child) = children
                .next_entry()
                .await
                .map_err(|error| storage("native_directory_read", error))?
            {
                let name = child.file_name().into_string().map_err(|_| {
                    rpc::Error::conflict(
                        "native_filename_encoding",
                        "A native filename is not valid UTF-8",
                    )
                })?;
                let path = if directory.is_empty() {
                    name
                } else {
                    format!("{directory}/{name}")
                };
                let kind = child
                    .file_type()
                    .await
                    .map_err(|error| storage("native_file_inspect", error))?;
                if kind.is_dir() || kind.is_symlink() {
                    // resolve also checks Windows junctions before any directory read.
                    self.resolve(&path, false).await?;
                    pending.push(path);
                } else if path.ends_with(".md")
                    && let Some(entry) = self.entry(&path).await?
                {
                    entries.push(entry);
                }
            }
        }
        entries.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    pub(crate) async fn read(&self, path: &str) -> rpc::Result<String> {
        let resolved = self
            .resolve(path, false)
            .await?
            .ok_or_else(|| rpc::Error::not_found("Native text file"))?;
        require_file(
            &fs::metadata(&resolved)
                .await
                .map_err(|error| storage("native_file_inspect", error))?,
        )?;
        let bytes = fs::read(resolved)
            .await
            .map_err(|error| storage("native_file_read", error))?;
        String::from_utf8(bytes).map_err(|_| {
            rpc::Error::conflict(
                "native_text_encoding",
                "Native text file must contain UTF-8 text",
            )
        })
    }

    pub(crate) async fn write(&self, path: &str, content: &str) -> rpc::Result<()> {
        relative(path, false)?;
        let resolved = self
            .resolve(path, true)
            .await?
            .ok_or_else(|| rpc::Error::internal("native_write_path"))?;
        match fs::metadata(&resolved).await {
            Ok(metadata) => require_file(&metadata)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage("native_file_inspect", error)),
        }
        atomic_write(&resolved, content.as_bytes()).await
    }

    pub(crate) async fn remove(&self, path: &str) -> rpc::Result<()> {
        relative(path, false)?;
        let resolved = self
            .resolve(path, false)
            .await?
            .ok_or_else(|| rpc::Error::not_found("Native text file"))?;
        require_file(
            &fs::metadata(&resolved)
                .await
                .map_err(|error| storage("native_file_inspect", error))?,
        )?;
        fs::remove_file(resolved)
            .await
            .map_err(|error| storage("native_file_delete", error))
    }
}

fn linked(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn require_file(metadata: &std::fs::Metadata) -> rpc::Result<()> {
    if metadata.is_file() {
        Ok(())
    } else {
        Err(rpc::Error::conflict(
            "native_not_file",
            "The requested resource is not a regular file",
        ))
    }
}

fn storage(operation: &'static str, source: io::Error) -> rpc::Error {
    let code = match source.kind() {
        io::ErrorKind::NotFound => -32001,
        io::ErrorKind::PermissionDenied => -32007,
        _ => -32005,
    };
    rpc::Error::new(code, operation, "Native text filesystem operation failed")
        .with_data(json!({ "ioKind": format!("{:?}", source.kind()) }))
}
