use std::{
    collections::BTreeSet,
    fmt,
    path::{Component, Path},
};

const MAX_BUNDLES: usize = 32;
const MAX_FILES_PER_BUNDLE: usize = 64;
const MAX_FILE_BYTES: usize = 48 * 1024;
const MAX_BUNDLE_BYTES: usize = 48 * 1024;
const MAX_TOTAL_BYTES: usize = 48 * 1024;
const MAX_PATH_BYTES: usize = 240;
const MAX_SKILL_KEY_BYTES: usize = 96;
const SKILL_MANIFEST: &str = "SKILL.md";
const MANAGED_MARKER: &str = ".matchaclaw-managed";

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct Bundle {
    skill_key: String,
    files: Vec<BundleFile>,
}

impl Bundle {
    pub(crate) fn try_new(skill_key: String, files: Vec<BundleFile>) -> Result<Self, ()> {
        let skill_key = normalize_skill_key(skill_key)?;
        validate_files(&files)?;
        Ok(Self { skill_key, files })
    }

    pub(crate) fn skill_key(&self) -> &str {
        &self.skill_key
    }

    pub(crate) fn files(&self) -> &[BundleFile] {
        &self.files
    }
}

impl fmt::Debug for Bundle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Bundle")
            .field("skill_key", &self.skill_key)
            .field("files", &self.files)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct BundleFile {
    path: String,
    content: String,
}

impl fmt::Debug for BundleFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BundleFile")
            .field("path", &self.path)
            .field("content", &"[REDACTED]")
            .finish()
    }
}

impl BundleFile {
    pub(crate) fn try_new(path: String, content: String) -> Result<Self, ()> {
        validate_file_path(&path)?;
        if content.len() > MAX_FILE_BYTES || content.contains('\0') {
            return Err(());
        }
        Ok(Self { path, content })
    }

    pub(crate) fn path(&self) -> &str {
        &self.path
    }

    pub(crate) fn content(&self) -> &str {
        &self.content
    }
}

pub(crate) fn validate_batch(bundles: &[Bundle]) -> Result<(), ()> {
    if bundles.len() > MAX_BUNDLES {
        return Err(());
    }

    let mut skill_keys = BTreeSet::new();
    let mut total_bytes = 0usize;
    for bundle in bundles {
        if !skill_keys.insert(bundle.skill_key.clone()) {
            return Err(());
        }
        let bundle_bytes = bundle
            .files
            .iter()
            .try_fold(0usize, |total, file| total.checked_add(file.content.len()))
            .ok_or(())?;
        total_bytes = total_bytes.checked_add(bundle_bytes).ok_or(())?;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(());
        }
    }
    Ok(())
}

pub(crate) enum Command {
    Export { skill_keys: Vec<String> },
    Import { bundles: Vec<Bundle> },
}

pub(crate) enum Outcome {
    Exported(Vec<Bundle>),
    Accepted,
    Rejected,
    Unknown,
}

fn validate_files(files: &[BundleFile]) -> Result<(), ()> {
    if files.is_empty() || files.len() > MAX_FILES_PER_BUNDLE {
        return Err(());
    }

    let mut paths = BTreeSet::new();
    let mut total_bytes = 0usize;
    for file in files {
        if !paths.insert(file.path.clone()) || file.path == MANAGED_MARKER {
            return Err(());
        }
        total_bytes = total_bytes.checked_add(file.content.len()).ok_or(())?;
        if total_bytes > MAX_BUNDLE_BYTES {
            return Err(());
        }
    }
    if !paths.contains(SKILL_MANIFEST) || !has_valid_manifest(files) {
        return Err(());
    }
    Ok(())
}

fn normalize_skill_key(value: String) -> Result<String, ()> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty()
        || value.len() > MAX_SKILL_KEY_BYTES
        || value.ends_with('-')
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'))
    {
        return Err(());
    }
    Ok(value)
}

fn validate_file_path(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.contains('\\')
        || value.contains('\0')
        || value.starts_with('/')
        || Path::new(value).is_absolute()
        || value
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.split('/').next().is_some_and(|component| {
            let bytes = component.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        })
    {
        return Err(());
    }
    Ok(())
}

fn has_valid_manifest(files: &[BundleFile]) -> bool {
    let Some(manifest) = files.iter().find(|file| file.path == SKILL_MANIFEST) else {
        return false;
    };
    let Some(frontmatter) = manifest
        .content
        .strip_prefix("---\n")
        .or_else(|| manifest.content.strip_prefix("---\r\n"))
        .and_then(|content| {
            content
                .split_once("\n---")
                .or_else(|| content.split_once("\r\n---"))
        })
        .map(|(frontmatter, _)| frontmatter)
    else {
        return false;
    };
    let has_name = frontmatter.lines().any(|line| nonempty_field(line, "name"));
    let has_description = frontmatter
        .lines()
        .any(|line| nonempty_field(line, "description"));
    has_name && has_description
}

fn nonempty_field(line: &str, field: &str) -> bool {
    line.strip_prefix(field)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|value| !value.trim().trim_matches(['\'', '"']).is_empty())
}
