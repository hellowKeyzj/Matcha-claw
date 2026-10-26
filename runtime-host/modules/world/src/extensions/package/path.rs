use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PathIssue {
    Invalid,
    Duplicate,
    CaseCollision,
    FileDirectoryConflict,
}

pub(super) fn validate(path: &str, directory: bool) -> Result<(), PathIssue> {
    let path = if directory {
        path.strip_suffix('/').ok_or(PathIssue::Invalid)?
    } else {
        path
    };
    if path.is_empty() || path.starts_with('/') {
        return Err(PathIssue::Invalid);
    }
    for component in path.split('/') {
        if component.is_empty()
            || matches!(component, "." | "..")
            || component.ends_with(['.', ' '])
            || component
                .chars()
                .any(|character| character.is_control() || "\\<>:\"|?*".contains(character))
            || is_device_name(component)
        {
            return Err(PathIssue::Invalid);
        }
    }
    Ok(())
}

fn is_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let name = stem.to_uppercase();
    if matches!(
        name.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let suffix = name
        .strip_prefix("COM")
        .or_else(|| name.strip_prefix("LPT"));
    suffix.is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    })
}

#[derive(Default)]
pub(super) struct PathIndex {
    entries: BTreeMap<String, Entry>,
}

struct Entry {
    spelling: String,
    directory: bool,
    explicit: bool,
}

impl PathIndex {
    pub(super) fn insert(&mut self, path: &str, directory: bool) -> Result<(), PathIssue> {
        validate(path, directory)?;
        let path = path.trim_end_matches('/');
        let mut boundary = 0;
        for component in path.split('/') {
            boundary += component.len();
            let spelling = &path[..boundary];
            let at_leaf = boundary == path.len();
            let is_directory = !at_leaf || directory;
            let key = spelling.to_uppercase();
            match self.entries.get_mut(&key) {
                Some(entry) if entry.spelling != spelling => return Err(PathIssue::CaseCollision),
                Some(entry) if entry.directory != is_directory => {
                    return Err(PathIssue::FileDirectoryConflict);
                }
                Some(entry) if at_leaf && entry.explicit => return Err(PathIssue::Duplicate),
                Some(entry) if at_leaf => entry.explicit = true,
                Some(_) => {}
                None => {
                    self.entries.insert(
                        key,
                        Entry {
                            spelling: spelling.to_owned(),
                            directory: is_directory,
                            explicit: at_leaf,
                        },
                    );
                }
            }
            boundary += 1;
        }
        Ok(())
    }
}
