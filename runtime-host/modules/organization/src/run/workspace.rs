use std::{fmt, path::{Path, PathBuf}};

use crate::RoleSessionReceipt;

#[derive(Clone, Eq, PartialEq)]
pub struct RunWorkspace {
    root: PathBuf,
    prepared: bool,
}

impl RunWorkspace {
    pub fn try_new(root: PathBuf, prepared: bool) -> Result<Self, InvalidRunWorkspace> {
        if !root.is_absolute() || root.components().any(|component| matches!(component, std::path::Component::ParentDir | std::path::Component::CurDir)) {
            return Err(InvalidRunWorkspace);
        }
        Ok(Self { root, prepared })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_prepared(&self) -> bool {
        self.prepared
    }

    pub(crate) fn mark_prepared(&mut self) {
        self.prepared = true;
    }
}

impl fmt::Debug for RunWorkspace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("RunWorkspace")
            .field("prepared", &self.prepared)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidRunWorkspace;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunWorkspaceAccess {
    Read,
    Write,
}

#[derive(Clone, Debug)]
pub struct RunWorkspaceBinding {
    pub workspace: RunWorkspace,
    pub binding: RoleSessionReceipt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RunFileValidationPlan {
    pub binding: RoleSessionReceipt,
    pub workspace: RunWorkspace,
    pub paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunFileValidationError {
    InvalidPath,
    MissingFile,
    Unavailable,
}

pub(crate) fn directory_name(name: &str) -> String {
    let mut name = name.chars().map(|character| {
        if character.is_control() || "<>:\"/\\|?*".contains(character) { '_' } else { character }
    }).collect::<String>();
    name = name.trim().trim_end_matches(['.', ' ']).to_owned();
    let mut byte_len = 0;
    let mut utf16_len = 0;
    for character in name.chars() {
        if byte_len + character.len_utf8() > 180 || utf16_len + character.len_utf16() > 180 { break; }
        byte_len += character.len_utf8();
        utf16_len += character.len_utf16();
    }
    name.truncate(byte_len);
    name = name.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() { name.push_str("Team"); }
    if reserved_name(&name) { name.insert(0, '_'); }
    name
}

fn reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ').to_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix).is_some_and(|number| {
            matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        }))
}

pub(crate) fn valid_directory_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.ends_with(['.', ' '])
        && !name.chars().any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
        && !reserved_name(name) && name.encode_utf16().count() <= 255 && name.len() <= 255
}
