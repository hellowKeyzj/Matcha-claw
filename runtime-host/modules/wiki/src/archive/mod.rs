use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use zip::write::SimpleFileOptions;

pub const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 100_000;

const PROJECT_SCHEMA: &str = "schema.md";
const PROJECT_WIKI_DIR: &str = "wiki";

#[derive(Debug)]
pub enum ArchiveError {
    InvalidProjectRoot {
        path: PathBuf,
        reason: &'static str,
    },
    InvalidPath(&'static str),
    ExportDestinationInsideProject,
    ImportDestinationNotEmpty(PathBuf),
    UnsafeArchivePath(String),
    UnsupportedArchiveEntry(String),
    ArchiveTooLarge,
    TooManyArchiveEntries,
    Io {
        action: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    Zip(String),
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProjectRoot { path, reason } => {
                write!(
                    formatter,
                    "invalid wiki project root {}: {reason}",
                    path.display()
                )
            }
            Self::InvalidPath(message) => formatter.write_str(message),
            Self::ExportDestinationInsideProject => {
                formatter.write_str("export destination must be outside the project directory")
            }
            Self::ImportDestinationNotEmpty(path) => {
                write!(
                    formatter,
                    "import destination must be empty: {}",
                    path.display()
                )
            }
            Self::UnsafeArchivePath(path) => write!(formatter, "unsafe archive path: {path}"),
            Self::UnsupportedArchiveEntry(path) => {
                write!(formatter, "unsupported archive entry: {path}")
            }
            Self::ArchiveTooLarge => formatter.write_str("project archive exceeds 4 GB limit"),
            Self::TooManyArchiveEntries => {
                formatter.write_str("project archive contains too many entries")
            }
            Self::Io {
                action,
                path,
                source,
            } => {
                write!(formatter, "failed to {action} {}: {source}", path.display())
            }
            Self::Zip(message) => write!(formatter, "invalid project archive: {message}"),
        }
    }
}

impl std::error::Error for ArchiveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WikiIndexRebuild {
    pub pages: usize,
    pub groups: usize,
}

pub fn export_project_archive(
    project_path: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<(), ArchiveError> {
    require_absolute(project_path.as_ref(), "project path must be absolute")?;
    require_absolute(destination.as_ref(), "export destination must be absolute")?;
    let root = canonicalize(project_path.as_ref(), "resolve project root")?;
    let output = resolve_export_destination(&root, destination.as_ref())?;
    let parent = output.parent().ok_or(ArchiveError::InvalidPath(
        "export destination must have a parent directory",
    ))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|source| ArchiveError::Io {
            action: "create temporary archive",
            path: output.clone(),
            source,
        })?;
    {
        let mut archive = zip::ZipWriter::new(temporary.as_file_mut());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut writer = ArchiveWriter::new(&root, &mut archive, options);
        writer.write_directory_children(&root)?;
        drop(writer);
        archive
            .finish()
            .map_err(|error| ArchiveError::Zip(error.to_string()))?
            .sync_all()
            .map_err(|source| ArchiveError::Io {
                action: "sync project archive",
                path: output.clone(),
                source,
            })?;
    }
    temporary
        .persist(&output)
        .map_err(|error| ArchiveError::Io {
            action: "publish project archive",
            path: output,
            source: error.error,
        })?;
    Ok(())
}

pub fn import_project_archive(
    archive_path: impl AsRef<Path>,
    destination_root: impl AsRef<Path>,
) -> Result<PathBuf, ArchiveError> {
    let archive_path = archive_path.as_ref();
    require_absolute(archive_path, "archive path must be absolute")?;
    require_absolute(
        destination_root.as_ref(),
        "import destination must be absolute",
    )?;
    let file = File::open(archive_path).map_err(|source| ArchiveError::Io {
        action: "open archive",
        path: archive_path.to_path_buf(),
        source,
    })?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| ArchiveError::Zip(error.to_string()))?;
    validate_archive(&mut archive)?;

    let destination = destination_root.as_ref();
    ensure_empty_destination(destination)?;
    let root = if destination.exists() {
        canonicalize(destination, "resolve import destination")?
    } else {
        let parent = destination.parent().ok_or(ArchiveError::InvalidPath(
            "import destination must have a parent directory",
        ))?;
        let filename = destination.file_name().ok_or(ArchiveError::InvalidPath(
            "import destination must be a directory path",
        ))?;
        fs::create_dir_all(parent).map_err(|source| ArchiveError::Io {
            action: "create import destination parent",
            path: parent.to_path_buf(),
            source,
        })?;
        canonicalize(parent, "resolve import destination parent")?.join(filename)
    };
    let parent = root.parent().ok_or(ArchiveError::InvalidPath(
        "import destination must have a parent directory",
    ))?;
    let staging = tempfile::tempdir_in(parent).map_err(|source| ArchiveError::Io {
        action: "create import staging directory",
        path: root.clone(),
        source,
    })?;
    extract_archive(&mut archive, staging.path())?;
    publish_import(staging.path(), &root)?;
    Ok(root)
}

pub fn update_recent_wiki_index(
    project_path: impl AsRef<Path>,
    written_paths: &[String],
) -> Result<bool, ArchiveError> {
    let root = canonicalize(project_path.as_ref(), "resolve project root")?;
    validate_project_root(&root)?;
    let wiki = root.join(PROJECT_WIKI_DIR);
    let candidates = written_paths
        .iter()
        .map(|path| path.replace('\\', "/"))
        .filter(|path| {
            path.starts_with("wiki/")
                && path.ends_with(".md")
                && !matches!(
                    path.as_str(),
                    "wiki/index.md" | "wiki/overview.md" | "wiki/log.md"
                )
        })
        .collect::<BTreeSet<_>>();
    if candidates.is_empty() {
        return Ok(false);
    }

    let index_path = wiki.join("index.md");
    let index = fs::read_to_string(&index_path).unwrap_or_else(|_| "# Wiki Index\n".to_owned());
    let known = index_wikilink_targets(&index);
    let mut additions = Vec::new();
    for path in candidates {
        let target = path
            .strip_prefix("wiki/")
            .unwrap_or(&path)
            .trim_end_matches(".md")
            .to_owned();
        if known.contains(&normalize_index_target(&target)) {
            continue;
        }
        let content_path = root.join(&path);
        let content = fs::read_to_string(&content_path).unwrap_or_default();
        let title = frontmatter_value(&content, "title").unwrap_or_else(|| {
            Path::new(&path)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&target)
                .to_owned()
        });
        additions.push(format!("- [[{target}]] — {title}"));
    }
    if additions.is_empty() {
        return Ok(false);
    }

    let next = update_bounded_recent_index_section(&index, additions);
    let temporary_path = wiki.join(".index.md.recent.tmp");
    write_rebuilt_index(&temporary_path, &index_path, next.as_bytes())?;
    Ok(true)
}

pub fn rebuild_wiki_index(
    project_path: impl AsRef<Path>,
) -> Result<WikiIndexRebuild, ArchiveError> {
    require_absolute(project_path.as_ref(), "project path must be absolute")?;
    let root = canonicalize(project_path.as_ref(), "resolve project root")?;
    let wiki = canonicalize(&root.join(PROJECT_WIKI_DIR), "resolve wiki directory")?;
    if !wiki.starts_with(&root) {
        return Err(ArchiveError::InvalidPath(
            "wiki directory escaped project root",
        ));
    }
    let mut groups: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    collect_wiki_pages(&wiki, &wiki, &mut groups)?;
    for pages in groups.values_mut() {
        pages.sort_by(|left, right| left.1.to_lowercase().cmp(&right.1.to_lowercase()));
    }

    let pages = groups.values().map(Vec::len).sum();
    let mut output = String::from("# Wiki Index\n\n");
    for (kind, entries) in &groups {
        output.push_str("## ");
        output.push_str(kind);
        output.push_str("\n\n");
        for (slug, title) in entries {
            output.push_str("- [[");
            output.push_str(slug);
            output.push('|');
            output.push_str(title);
            output.push_str("]]\n");
        }
        output.push('\n');
    }

    let index_path = wiki.join("index.md");
    let temporary_path = wiki.join(".index.md.rebuild.tmp");
    write_rebuilt_index(&temporary_path, &index_path, output.as_bytes())?;
    Ok(WikiIndexRebuild {
        pages,
        groups: groups.len(),
    })
}

struct ArchiveWriter<'archive, W: Write + std::io::Seek> {
    root: &'archive Path,
    archive: &'archive mut zip::ZipWriter<W>,
    options: SimpleFileOptions,
    entries: usize,
    bytes: u64,
}

impl<'archive, W: Write + std::io::Seek> ArchiveWriter<'archive, W> {
    fn new(
        root: &'archive Path,
        archive: &'archive mut zip::ZipWriter<W>,
        options: SimpleFileOptions,
    ) -> Self {
        Self {
            root,
            archive,
            options,
            entries: 0,
            bytes: 0,
        }
    }

    fn write_directory_children(&mut self, directory: &Path) -> Result<(), ArchiveError> {
        let mut children = read_sorted_directory(directory)?;
        for child in children.drain(..) {
            let path = child.path();
            let file_type = child.file_type().map_err(|source| ArchiveError::Io {
                action: "inspect project entry",
                path: path.clone(),
                source,
            })?;
            if file_type.is_symlink() {
                continue;
            }
            let relative = path
                .strip_prefix(self.root)
                .map_err(|_| ArchiveError::InvalidPath("project entry escaped root"))?;
            let archive_name = archive_name(relative)?;
            self.admit_entry(0)?;
            if file_type.is_dir() {
                self.archive
                    .add_directory(format!("{archive_name}/"), self.options)
                    .map_err(|error| ArchiveError::Zip(error.to_string()))?;
                self.write_directory_children(&path)?;
            } else if file_type.is_file() {
                let metadata = child.metadata().map_err(|source| ArchiveError::Io {
                    action: "inspect project file",
                    path: path.clone(),
                    source,
                })?;
                self.bytes = self
                    .bytes
                    .checked_add(metadata.len())
                    .ok_or(ArchiveError::ArchiveTooLarge)?;
                if self.bytes > MAX_ARCHIVE_BYTES {
                    return Err(ArchiveError::ArchiveTooLarge);
                }
                self.archive
                    .start_file(archive_name, self.options)
                    .map_err(|error| ArchiveError::Zip(error.to_string()))?;
                let mut source = File::open(&path).map_err(|source| ArchiveError::Io {
                    action: "open project file",
                    path: path.clone(),
                    source,
                })?;
                std::io::copy(&mut source, &mut *self.archive).map_err(|source| {
                    ArchiveError::Io {
                        action: "write archive entry",
                        path: path.clone(),
                        source,
                    }
                })?;
            }
        }
        Ok(())
    }

    fn admit_entry(&mut self, bytes: u64) -> Result<(), ArchiveError> {
        self.entries += 1;
        if self.entries > MAX_ARCHIVE_ENTRIES {
            return Err(ArchiveError::TooManyArchiveEntries);
        }
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(ArchiveError::ArchiveTooLarge)?;
        if self.bytes > MAX_ARCHIVE_BYTES {
            return Err(ArchiveError::ArchiveTooLarge);
        }
        Ok(())
    }
}

fn validate_project_root(root: &Path) -> Result<(), ArchiveError> {
    if !root.join(PROJECT_SCHEMA).is_file() {
        return Err(ArchiveError::InvalidProjectRoot {
            path: root.to_path_buf(),
            reason: "schema.md is missing",
        });
    }
    if !root.join(PROJECT_WIKI_DIR).is_dir() {
        return Err(ArchiveError::InvalidProjectRoot {
            path: root.to_path_buf(),
            reason: "wiki directory is missing",
        });
    }
    Ok(())
}

fn validate_archive<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(), ArchiveError> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::TooManyArchiveEntries);
    }

    let mut expanded = 0_u64;
    let mut has_project_index = false;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| ArchiveError::Zip(error.to_string()))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(ArchiveError::UnsupportedArchiveEntry(
                entry.name().to_owned(),
            ));
        }
        let relative = archive_relative_path(entry.name())?;
        has_project_index |= relative == Path::new("wiki/index.md") && !entry.is_dir();
        expanded = expanded
            .checked_add(entry.size())
            .ok_or(ArchiveError::ArchiveTooLarge)?;
        if expanded > MAX_ARCHIVE_BYTES {
            return Err(ArchiveError::ArchiveTooLarge);
        }
    }

    if !has_project_index {
        return Err(ArchiveError::InvalidProjectRoot {
            path: PathBuf::from("archive"),
            reason: "wiki/index.md is missing",
        });
    }
    Ok(())
}

fn extract_archive<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    root: &Path,
) -> Result<(), ArchiveError> {
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| ArchiveError::Zip(error.to_string()))?;
        let relative = archive_relative_path(entry.name())?;
        let target = root.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|source| ArchiveError::Io {
                action: "create archive directory",
                path: target,
                source,
            })?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|source| ArchiveError::Io {
                action: "create archive entry parent",
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let mut output = create_file(&target)?;
        std::io::copy(&mut entry, &mut output).map_err(|source| ArchiveError::Io {
            action: "extract archive entry",
            path: target,
            source,
        })?;
    }
    Ok(())
}

fn publish_import(staging: &Path, root: &Path) -> Result<(), ArchiveError> {
    ensure_empty_destination(root)?;
    if !root.exists() {
        return fs::rename(staging, root).map_err(|source| ArchiveError::Io {
            action: "publish imported project",
            path: root.to_path_buf(),
            source,
        });
    }
    let mut published = Vec::<PathBuf>::new();
    for entry in read_sorted_directory(staging)? {
        let source_path = entry.path();
        let destination = root.join(entry.file_name());
        if let Err(source) = fs::rename(&source_path, &destination) {
            let mut rollback_failed = false;
            for path in published.iter().rev() {
                if fs::rename(path, staging.join(path.file_name().unwrap())).is_err() {
                    rollback_failed = true;
                }
            }
            return Err(ArchiveError::Io {
                action: if rollback_failed {
                    "publish imported project; some imported entries remain in destination"
                } else {
                    "publish imported project"
                },
                path: root.to_path_buf(),
                source,
            });
        }
        published.push(destination);
    }
    Ok(())
}

fn ensure_empty_destination(root: &Path) -> Result<(), ArchiveError> {
    if root.exists() {
        if !root.is_dir()
            || fs::read_dir(root)
                .map_err(|source| ArchiveError::Io {
                    action: "read import destination",
                    path: root.to_path_buf(),
                    source,
                })?
                .next()
                .is_some()
        {
            return Err(ArchiveError::ImportDestinationNotEmpty(root.to_path_buf()));
        }
    }
    Ok(())
}

fn resolve_export_destination(root: &Path, output: &Path) -> Result<PathBuf, ArchiveError> {
    let resolved = if output.exists() {
        canonicalize(output, "resolve export destination")?
    } else {
        let parent = output.parent().ok_or(ArchiveError::InvalidPath(
            "export destination must have a parent directory",
        ))?;
        let filename = output.file_name().ok_or(ArchiveError::InvalidPath(
            "export destination must be a file path",
        ))?;
        canonicalize(parent, "resolve export destination parent")?.join(filename)
    };
    if resolved.starts_with(root) {
        return Err(ArchiveError::ExportDestinationInsideProject);
    }
    Ok(resolved)
}

fn collect_wiki_pages(
    wiki: &Path,
    directory: &Path,
    groups: &mut BTreeMap<String, Vec<(String, String)>>,
) -> Result<(), ArchiveError> {
    for child in read_sorted_directory(directory)? {
        let path = child.path();
        let file_type = child.file_type().map_err(|source| ArchiveError::Io {
            action: "inspect wiki entry",
            path: path.clone(),
            source,
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_wiki_pages(wiki, &path, groups)?;
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if matches!(
            stem.to_ascii_lowercase().as_str(),
            "index" | "overview" | "log"
        ) {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|source| ArchiveError::Io {
            action: "read wiki page",
            path: path.clone(),
            source,
        })?;
        let kind = frontmatter_value(&content, "type").unwrap_or_else(|| "other".to_owned());
        let title = frontmatter_value(&content, "title").unwrap_or_else(|| stem.to_owned());
        let target = path
            .strip_prefix(wiki)
            .map_err(|_| ArchiveError::InvalidPath("wiki page escaped root"))?
            .with_extension("");
        groups
            .entry(kind)
            .or_default()
            .push((archive_name(&target)?, title));
    }
    Ok(())
}

fn index_wikilink_targets(content: &str) -> BTreeSet<String> {
    let mut targets = BTreeSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("]]") else {
            break;
        };
        let target = after_open[..end]
            .split(['|', '#'])
            .next()
            .unwrap_or_default();
        targets.insert(normalize_index_target(target));
        rest = &after_open[end + 2..];
    }
    targets
}

fn update_bounded_recent_index_section(index: &str, additions: Vec<String>) -> String {
    const SECTION: &str = "## Recently Updated";
    const LIMIT: usize = 200;

    let lines = index.trim_end().lines().collect::<Vec<_>>();
    let start = lines.iter().position(|line| line.trim() == SECTION);
    let prefix = start.map_or_else(|| lines.clone(), |index| lines[..index].to_vec());
    let section_end = start.and_then(|start| {
        lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim_start().starts_with("## "))
            .map(|(index, _)| index)
    });
    let existing = start
        .map(|start| {
            lines[start + 1..section_end.unwrap_or(lines.len())]
                .iter()
                .filter(|line| line.trim_start().starts_with("- "))
                .map(|line| (*line).to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let suffix = section_end
        .map(|index| lines[index..].to_vec())
        .unwrap_or_default();

    let mut seen = BTreeSet::new();
    let recent = additions
        .into_iter()
        .chain(existing)
        .filter(|line| seen.insert(line.clone()))
        .take(LIMIT)
        .collect::<Vec<_>>();

    let mut out = prefix
        .iter()
        .map(|line| (*line).to_owned())
        .collect::<Vec<_>>();
    out.push(String::new());
    out.push(SECTION.to_owned());
    out.extend(recent);
    if !suffix.is_empty() {
        out.push(String::new());
        out.extend(suffix.iter().map(|line| (*line).to_owned()));
    }
    out.push(String::new());
    out.join("\n")
}

fn normalize_index_target(target: &str) -> String {
    let target = target.trim().replace('\\', "/");
    let target = target.strip_prefix("wiki/").unwrap_or(&target);
    target
        .strip_suffix(".md")
        .or_else(|| target.strip_suffix(".MD"))
        .unwrap_or(target)
        .to_ascii_lowercase()
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let normalized = content.replace("\r\n", "\n");
    let body = normalized.strip_prefix("---\n")?.split_once("\n---")?.0;
    body.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == key).then(|| value.trim().trim_matches(['\"', '\'']).to_owned())
        })
        .filter(|value| !value.is_empty())
}

fn write_rebuilt_index(
    temporary_path: &Path,
    index_path: &Path,
    content: &[u8],
) -> Result<(), ArchiveError> {
    reject_symlink(temporary_path)?;
    reject_symlink(index_path)?;
    let mut file = create_file(temporary_path)?;
    file.write_all(content).map_err(|source| ArchiveError::Io {
        action: "write rebuilt wiki index",
        path: temporary_path.to_path_buf(),
        source,
    })?;
    file.sync_all().map_err(|source| ArchiveError::Io {
        action: "sync rebuilt wiki index",
        path: temporary_path.to_path_buf(),
        source,
    })?;
    drop(file);
    #[cfg(windows)]
    if index_path.exists() {
        fs::remove_file(index_path).map_err(|source| ArchiveError::Io {
            action: "replace wiki index",
            path: index_path.to_path_buf(),
            source,
        })?;
    }
    fs::rename(temporary_path, index_path).map_err(|source| ArchiveError::Io {
        action: "publish rebuilt wiki index",
        path: index_path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn archive_relative_path(name: &str) -> Result<PathBuf, ArchiveError> {
    if name.contains(['\\', '\0', ':']) {
        return Err(ArchiveError::UnsafeArchivePath(name.to_owned()));
    }
    let name = name.strip_suffix('/').unwrap_or(name);
    if name.is_empty() {
        return Err(ArchiveError::UnsafeArchivePath(name.to_owned()));
    }
    let path = Path::new(name);
    if !safe_relative(path) {
        return Err(ArchiveError::UnsafeArchivePath(name.to_owned()));
    }
    Ok(path.to_path_buf())
}

fn safe_relative(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn archive_name(path: &Path) -> Result<String, ArchiveError> {
    if !safe_relative(path) {
        return Err(ArchiveError::UnsafeArchivePath(path.display().to_string()));
    }
    Ok(path.to_string_lossy().replace('\\', "/"))
}

fn require_absolute(path: &Path, message: &'static str) -> Result<(), ArchiveError> {
    if !path.is_absolute() {
        return Err(ArchiveError::InvalidPath(message));
    }
    Ok(())
}

fn canonicalize(path: &Path, action: &'static str) -> Result<PathBuf, ArchiveError> {
    path.canonicalize().map_err(|source| ArchiveError::Io {
        action,
        path: path.to_path_buf(),
        source,
    })
}

fn reject_symlink(path: &Path) -> Result<(), ArchiveError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ArchiveError::UnsafeArchivePath(path.display().to_string()))
        }
        Ok(_) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(ArchiveError::Io {
            action: "inspect index destination",
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn create_file(path: &Path) -> Result<File, ArchiveError> {
    File::create(path).map_err(|source| ArchiveError::Io {
        action: "create file",
        path: path.to_path_buf(),
        source,
    })
}

fn read_sorted_directory(directory: &Path) -> Result<Vec<fs::DirEntry>, ArchiveError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|source| ArchiveError::Io {
            action: "read directory",
            path: directory.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| ArchiveError::Io {
            action: "read directory entry",
            path: directory.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "wiki-archive-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(PROJECT_WIKI_DIR)).unwrap();
        fs::write(root.join(PROJECT_SCHEMA), "# Schema\n").unwrap();
        root
    }

    #[test]
    fn updates_bounded_recent_index_without_full_rebuild() {
        let root = test_root("recent");
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::write(
            root.join("wiki/index.md"),
            "# Wiki Index\n\n## Concepts\n\n- [[old|Old]]\n",
        )
        .unwrap();
        fs::write(
            root.join("wiki/concepts/new.md"),
            "---\ntitle: New Page\n---\n# New",
        )
        .unwrap();

        assert!(update_recent_wiki_index(&root, &["wiki/concepts/new.md".to_owned()]).unwrap());
        let index = fs::read_to_string(root.join("wiki/index.md")).unwrap();
        assert!(index.contains("## Concepts\n\n- [[old|Old]]"));
        assert!(index.contains("## Recently Updated"));
        assert!(index.contains("- [[concepts/new]] — New Page"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recent_index_target_normalization_is_case_insensitive_for_md_suffix() {
        assert_eq!(normalize_index_target("wiki/Foo.MD"), "foo");
        assert_eq!(normalize_index_target("wiki/Foo.md"), "foo");
    }
}
