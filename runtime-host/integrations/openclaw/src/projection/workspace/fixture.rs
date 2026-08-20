use std::{
    fs,
    path::{Path, PathBuf},
};

use super::WorkspaceTemplateFile;

pub struct WorkspaceProjectionFixture {
    root: PathBuf,
    openclaw_dir: PathBuf,
}

impl WorkspaceProjectionFixture {
    pub fn install(root: &Path) -> Self {
        Self::install_at(root.join("openclaw"))
    }

    pub fn install_at(openclaw_dir: PathBuf) -> Self {
        let root = openclaw_dir
            .parent()
            .expect("OpenClaw fixture directory must have a parent")
            .to_owned();
        let templates = openclaw_dir.join("docs/reference/templates");
        fs::create_dir_all(&templates).expect("create OpenClaw workspace templates");
        for file in WorkspaceTemplateFile::ALL {
            fs::write(
                templates.join(file.file_name()),
                "test workspace template\n",
            )
            .expect("write OpenClaw workspace template");
        }
        Self { root, openclaw_dir }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn openclaw_dir(&self) -> &Path {
        &self.openclaw_dir
    }
}
