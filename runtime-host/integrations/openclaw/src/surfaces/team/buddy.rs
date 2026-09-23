use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

use organization::{RoleId, TeamId};

const AGENTS_FILE: &str = "AGENTS.md";
const MARKER_PREFIX: &str = "<!-- matchaclaw-teamrun:";

pub(crate) struct TeamBuddyMarker {
    marker: String,
}

impl TeamBuddyMarker {
    pub(crate) fn new(team: TeamId, role: RoleId) -> Self {
        Self {
            marker: format!(
                "{MARKER_PREFIX}begin:{}:{} -->\n<!-- matchaclaw-teamrun:end:{}:{} -->",
                team.as_str(),
                role.as_str(),
                team.as_str(),
                role.as_str()
            ),
        }
    }

    pub(crate) fn write(&self, workspace: &Path) -> io::Result<()> {
        let path = workspace.join(AGENTS_FILE);
        let existing = read_if_exists(&path)?;
        let content = remove_marker_block(&existing, &self.marker);
        let content = if content.trim().is_empty() {
            format!("{}\n", self.marker)
        } else {
            format!("{}\n\n{}\n", content.trim_end(), self.marker)
        };
        replace_file(path, content.as_bytes())
    }

    pub(crate) fn recover(&self, workspace: &Path) -> io::Result<bool> {
        Ok(read_if_exists(&workspace.join(AGENTS_FILE))?.contains(&self.marker))
    }

    pub(crate) fn remove(&self, workspace: &Path) -> io::Result<()> {
        let path = workspace.join(AGENTS_FILE);
        let existing = read_if_exists(&path)?;
        let content = remove_marker_block(&existing, &self.marker);
        if content != existing {
            replace_file(path, content.as_bytes())?;
        }
        Ok(())
    }
}

impl fmt::Debug for TeamBuddyMarker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamBuddyMarker([REDACTED])")
    }
}

fn read_if_exists(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn remove_marker_block(content: &str, marker: &str) -> String {
    content
        .replace(marker, "")
        .replace("\n\n\n", "\n\n")
        .trim_end()
        .to_owned()
}

fn replace_file(path: PathBuf, content: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content)?;
    fs::rename(temporary, path)
}
