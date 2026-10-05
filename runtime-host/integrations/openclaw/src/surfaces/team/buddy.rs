use std::{
    collections::HashSet,
    fmt, fs, io,
    ops::Range,
    path::{Path, PathBuf},
};

use organization::{RoleId, TeamId};

const AGENTS_FILE: &str = "AGENTS.md";
const MARKER_PREFIX: &str = "<!-- matchaclaw-teamrun:";
const MARKER_SUFFIX: &str = " -->";

pub(crate) struct TeamBuddyMarker {
    label: String,
    content: String,
}

impl TeamBuddyMarker {
    pub(crate) fn new(team: TeamId, role: RoleId) -> Self {
        Self {
            label: format!("{}:{}", team.as_str(), role.as_str()),
            content: String::new(),
        }
    }

    pub(crate) fn with_content(mut self, content: impl Into<String>) -> Self {
        self.content = content.into();
        self
    }

    pub(crate) fn write(&self, workspace: &Path) -> io::Result<()> {
        let path = workspace.join(AGENTS_FILE);
        let mut content = read_if_exists(&path)?;
        let block = self.block()?;
        let existing = teamrun_blocks(&content)?
            .into_iter()
            .find(|(label, _)| *label == self.label);
        if let Some((_, range)) = existing {
            content.replace_range(range, &block);
        } else {
            if !content.is_empty() {
                if !content.ends_with('\n') {
                    content.push('\n');
                }
                if !content.ends_with("\n\n") && !content.ends_with("\r\n\r\n") {
                    content.push('\n');
                }
            }
            content.push_str(&block);
            content.push('\n');
        }
        replace_file(path, content.as_bytes())
    }

    pub(crate) fn recover(&self, workspace: &Path) -> io::Result<bool> {
        let content = read_if_exists(&workspace.join(AGENTS_FILE))?;
        let block = self.block()?;
        Ok(teamrun_blocks(&content)?
            .into_iter()
            .find(|(label, _)| *label == self.label)
            .is_some_and(|(_, range)| content[range] == block))
    }

    pub(crate) fn has_marker(&self, workspace: &Path) -> io::Result<bool> {
        let content = read_if_exists(&workspace.join(AGENTS_FILE))?;
        Ok(teamrun_blocks(&content)?
            .into_iter()
            .any(|(label, _)| label == self.label))
    }

    pub(crate) fn remove(&self, workspace: &Path) -> io::Result<()> {
        let path = workspace.join(AGENTS_FILE);
        let mut content = read_if_exists(&path)?;
        let existing = teamrun_blocks(&content)?
            .into_iter()
            .find(|(label, _)| *label == self.label);
        if let Some((_, range)) = existing {
            content.replace_range(range, "");
            replace_file(path, content.as_bytes())?;
        }
        Ok(())
    }

    fn block(&self) -> io::Result<String> {
        let separator = if self.content.is_empty() || self.content.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let block = format!(
            "{MARKER_PREFIX}begin:{}{MARKER_SUFFIX}\n{}{separator}{MARKER_PREFIX}end:{}{MARKER_SUFFIX}",
            self.label, self.content, self.label
        );
        let blocks = teamrun_blocks(&block)?;
        if blocks.len() != 1 || blocks[0].0 != self.label || blocks[0].1 != (0..block.len()) {
            return Err(invalid_block());
        }
        Ok(block)
    }
}

impl fmt::Debug for TeamBuddyMarker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamBuddyMarker([REDACTED])")
    }
}

pub(crate) fn strip_teamrun_blocks(content: &str) -> io::Result<String> {
    let blocks = teamrun_blocks(content)?;
    let mut stripped = String::with_capacity(content.len());
    let mut offset = 0;
    for (_, range) in blocks {
        stripped.push_str(&content[offset..range.start]);
        offset = range.end;
    }
    stripped.push_str(&content[offset..]);
    Ok(stripped)
}

fn teamrun_blocks(content: &str) -> io::Result<Vec<(&str, Range<usize>)>> {
    let mut blocks = Vec::new();
    let mut labels = HashSet::new();
    let mut pending = None;
    for (start, _) in content.match_indices(MARKER_PREFIX) {
        let tag_start = start + MARKER_PREFIX.len();
        let tag_length = content[tag_start..]
            .find(MARKER_SUFFIX)
            .ok_or_else(invalid_block)?;
        let tag = &content[tag_start..tag_start + tag_length];
        if tag.contains(['\r', '\n']) || tag.contains(MARKER_PREFIX) {
            return Err(invalid_block());
        }
        let (boundary, label) = tag.split_once(':').ok_or_else(invalid_block)?;
        if !label
            .rsplit_once(':')
            .is_some_and(|(team, role)| !team.is_empty() && !role.is_empty())
        {
            return Err(invalid_block());
        }
        match boundary {
            "begin" if pending.is_none() && labels.insert(label) => {
                pending = Some((label, start));
            }
            "end" => {
                let (expected, block_start) = pending.take().ok_or_else(invalid_block)?;
                if label != expected {
                    return Err(invalid_block());
                }
                blocks.push((
                    label,
                    block_start..tag_start + tag_length + MARKER_SUFFIX.len(),
                ));
            }
            _ => return Err(invalid_block()),
        }
    }
    if pending.is_some() {
        return Err(invalid_block());
    }
    Ok(blocks)
}

fn invalid_block() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid TeamRun block boundaries",
    )
}

fn read_if_exists(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn replace_file(path: PathBuf, content: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content)?;
    fs::rename(temporary, path)
}
