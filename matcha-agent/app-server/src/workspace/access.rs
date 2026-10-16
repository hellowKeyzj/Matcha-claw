use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

#[cfg(windows)]
use std::fs::Metadata;

use crate::rpc;

#[cfg(unix)]
use super::unix as platform;
#[cfg(windows)]
use super::windows as platform;
use super::{Entry, Kind, Stat};

pub(super) struct RelativePath {
    pub path: String,
    pub segments: Vec<String>,
}

impl RelativePath {
    pub fn parse(path: &str) -> rpc::Result<Self> {
        let segments = if path.is_empty() {
            Vec::new()
        } else {
            path.split('/')
                .map(|name| {
                    validate_segment(name)?;
                    Ok(name.to_owned())
                })
                .collect::<rpc::Result<Vec<_>>>()?
        };
        Ok(Self {
            path: path.to_owned(),
            segments,
        })
    }
}

pub(super) fn validate_segment(name: &str) -> rpc::Result<()> {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(*prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|ch| ch.is_control() || "\\/:<>\"|?*".contains(ch))
        || reserved
    {
        return Err(rpc::Error::invalid(
            "Path must contain ordinary slash-separated relative components without dot segments or device names",
        ));
    }
    Ok(())
}

pub(super) struct Directory(platform::Directory);

impl Directory {
    pub fn open(root: &Path, workspace: &Path) -> rpc::Result<Self> {
        // These paths come only from ConfigStore; the request contributes no absolute path.
        let relative = workspace.strip_prefix(root).map_err(|_| denied())?;
        let canonical = fs::canonicalize(root).map_err(|error| io_error("root", error))?;
        let mut directory = platform::Directory::open(&canonical)?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(denied());
            };
            directory.descend(name)?;
        }
        let observed = fs::canonicalize(workspace).map_err(|error| io_error("root", error))?;
        directory.verify_canonical(&observed)?;
        Ok(Self(directory))
    }

    pub fn descend(&mut self, name: &str) -> rpc::Result<()> {
        self.0.descend(name.as_ref())
    }

    pub fn stat(&self, name: Option<&str>) -> rpc::Result<Stat> {
        self.0.stat_entry(name.map(std::ffi::OsStr::new))
    }

    pub fn read(&self, name: &str) -> rpc::Result<Vec<u8>> {
        self.0.read(name.as_ref())
    }

    pub fn list(&self, relative: &str) -> rpc::Result<Vec<Entry>> {
        let mut entries = self.0.list()?;
        for entry in &mut entries {
            entry.path = if relative.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative}/{}", entry.name)
            };
        }
        entries.sort_unstable_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }

    pub fn observe_write(&self, name: &str) -> rpc::Result<()> {
        match self.0.kind(name.as_ref())? {
            None | Some(Kind::File) => Ok(()),
            Some(Kind::Symlink) => Err(denied()),
            Some(_) => Err(rpc::Error::conflict(
                "workspace_not_file",
                "Only a regular file may be replaced",
            )),
        }
    }

    pub async fn write(&self, name: &str, bytes: &[u8]) -> rpc::Result<()> {
        self.0.write(name.as_ref(), bytes).await
    }

    pub fn mkdir(&self, name: &str) -> rpc::Result<()> {
        if self.0.kind(name.as_ref())?.is_some() {
            return Err(rpc::Error::conflict(
                "workspace_exists",
                "The destination already exists",
            ));
        }
        self.0.mkdir(name.as_ref())
    }

    pub fn remove(&self, name: &str) -> rpc::Result<Kind> {
        let kind = self
            .0
            .kind(name.as_ref())?
            .ok_or_else(|| rpc::Error::not_found("Workspace entry"))?;
        match kind {
            Kind::File | Kind::Directory => self.0.remove(name.as_ref(), kind)?,
            Kind::Symlink => return Err(denied()),
            Kind::Other => {
                return Err(rpc::Error::conflict(
                    "workspace_special_file",
                    "Only regular files or empty directories may be removed",
                ));
            }
        }
        Ok(kind)
    }
}

#[cfg(windows)]
pub(super) fn entry(name: String, metadata: &Metadata) -> Entry {
    let kind = metadata_kind(metadata);
    Entry {
        name,
        path: String::new(),
        kind,
        size: (kind == Kind::File).then_some(metadata.len()),
    }
}

#[cfg(windows)]
pub(super) fn metadata_kind(metadata: &Metadata) -> Kind {
    if is_link(metadata) {
        Kind::Symlink
    } else if metadata.is_file() {
        Kind::File
    } else if metadata.is_dir() {
        Kind::Directory
    } else {
        Kind::Other
    }
}

#[cfg(windows)]
fn is_link(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

pub(super) fn denied() -> rpc::Error {
    rpc::Error::new(
        -32007,
        "workspace_link_forbidden",
        "Workspace paths must not traverse symbolic links, junctions, or reparse points",
    )
}

pub(super) fn io_error(operation: &'static str, error: io::Error) -> rpc::Error {
    let (code, kind, message) = match error.kind() {
        io::ErrorKind::NotFound => (
            -32001,
            "workspace_not_found",
            "Workspace entry was not found",
        ),
        io::ErrorKind::PermissionDenied => (
            -32007,
            "workspace_access_denied",
            "Workspace access was denied",
        ),
        io::ErrorKind::AlreadyExists => {
            (-32002, "workspace_exists", "The destination already exists")
        }
        io::ErrorKind::DirectoryNotEmpty => (
            -32002,
            "workspace_not_empty",
            "The directory is not empty; recursive removal is not supported",
        ),
        io::ErrorKind::NotADirectory => (
            -32002,
            "workspace_not_directory",
            "A path component is not a directory",
        ),
        io::ErrorKind::IsADirectory => (
            -32002,
            "workspace_not_file",
            "The requested entry is a directory",
        ),
        _ => (
            -32005,
            "workspace_io",
            "The workspace filesystem operation failed",
        ),
    };
    rpc::Error::new(code, kind, message)
        .with_data(serde_json::json!({
            "operation": operation,
            "ioKind": format!("{:?}", error.kind()),
            "osCode": error.raw_os_error(),
        }))
        .with_source(error)
}

pub(super) fn name_string(name: &std::ffi::OsStr) -> rpc::Result<String> {
    name.to_str().map(str::to_owned).ok_or_else(|| {
        rpc::Error::conflict(
            "workspace_name_not_unicode",
            "A directory entry name cannot be represented by the JSON path protocol",
        )
    })
}

pub(super) fn absolute_components(path: &Path) -> rpc::Result<(PathBuf, Vec<&std::ffi::OsStr>)> {
    if !path.is_absolute() {
        return Err(rpc::Error::invalid(
            "The configured workspace root must be absolute",
        ));
    }
    let mut root = PathBuf::new();
    let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => root.push(prefix.as_os_str()),
            Component::RootDir => root.push(component.as_os_str()),
            Component::Normal(name) => names.push(name),
            _ => return Err(denied()),
        }
    }
    Ok((root, names))
}
