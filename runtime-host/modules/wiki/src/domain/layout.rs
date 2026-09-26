use std::path::Path;

use chrono::Local;

use super::{
    model::WikiLayoutStatus,
    templates::{DEFAULT_PROJECT_TEMPLATE_ID, WikiProjectTemplate, project_template},
};

pub const RAW_SOURCES_DIR: &str = "raw/sources";
pub const RAW_ASSETS_DIR: &str = "raw/assets";
pub const WIKI_ENTITIES_DIR: &str = "wiki/entities";
pub const WIKI_CONCEPTS_DIR: &str = "wiki/concepts";
pub const WIKI_SOURCES_DIR: &str = "wiki/sources";
pub const WIKI_QUERIES_DIR: &str = "wiki/queries";
pub const WIKI_COMPARISONS_DIR: &str = "wiki/comparisons";
pub const WIKI_SYNTHESIS_DIR: &str = "wiki/synthesis";
pub const WIKI_MEDIA_DIR: &str = "wiki/media";
pub const LLM_WIKI_DIR: &str = ".llm-wiki";
pub const LANCEDB_DIR: &str = ".llm-wiki/lancedb";
pub const FILE_SNAPSHOT: &str = ".llm-wiki/file-snapshot.json";
pub const FILE_CHANGE_QUEUE: &str = ".llm-wiki/file-change-queue.json";
pub const EMBEDDING_REVISIONS_DIR: &str = ".llm-wiki/embedding-revisions";

const SCHEMA_FILE: &str = "schema.md";
const PURPOSE_FILE: &str = "purpose.md";
const WIKI_INDEX_FILE: &str = "wiki/index.md";
const WIKI_LOG_FILE: &str = "wiki/log.md";
const WIKI_OVERVIEW_FILE: &str = "wiki/overview.md";

const DIRECTORIES: &[&str] = &[
    RAW_SOURCES_DIR,
    RAW_ASSETS_DIR,
    WIKI_ENTITIES_DIR,
    WIKI_CONCEPTS_DIR,
    WIKI_SOURCES_DIR,
    WIKI_QUERIES_DIR,
    WIKI_COMPARISONS_DIR,
    WIKI_SYNTHESIS_DIR,
    WIKI_MEDIA_DIR,
    LANCEDB_DIR,
    EMBEDDING_REVISIONS_DIR,
];

pub fn ensure_project_layout(root: &Path) -> std::io::Result<()> {
    ensure_project_layout_for_template(root, project_template(DEFAULT_PROJECT_TEMPLATE_ID))
}

pub fn ensure_project_layout_for_template(
    root: &Path,
    template: Option<&WikiProjectTemplate>,
) -> std::io::Result<()> {
    for directory in DIRECTORIES {
        std::fs::create_dir_all(root.join(directory))?;
    }
    if let Some(template) = template {
        for directory in template.extra_dirs() {
            std::fs::create_dir_all(root.join(directory))?;
        }
        ensure_text_file(root.join(SCHEMA_FILE), template.schema())?;
        ensure_text_file(root.join(PURPOSE_FILE), template.purpose())?;
    }
    ensure_text_file(root.join(WIKI_INDEX_FILE), "# Wiki Index\n")?;
    ensure_text_file(root.join(WIKI_LOG_FILE), &initial_log_content())?;
    ensure_text_file(root.join(WIKI_OVERVIEW_FILE), "# Overview\n")?;
    ensure_json_file(root.join(FILE_SNAPSHOT), "{\"entries\":{}}")?;
    ensure_json_file(root.join(FILE_CHANGE_QUEUE), "[]")?;
    Ok(())
}

pub fn layout_status(root: &Path) -> WikiLayoutStatus {
    WikiLayoutStatus::new(
        root.join(RAW_SOURCES_DIR).is_dir(),
        root.join(RAW_ASSETS_DIR).is_dir(),
        root.join(WIKI_ENTITIES_DIR).is_dir(),
        root.join(WIKI_CONCEPTS_DIR).is_dir(),
        root.join(WIKI_SOURCES_DIR).is_dir(),
        root.join(WIKI_QUERIES_DIR).is_dir(),
        root.join(WIKI_COMPARISONS_DIR).is_dir(),
        root.join(WIKI_SYNTHESIS_DIR).is_dir(),
        root.join(WIKI_MEDIA_DIR).is_dir(),
        root.join(LLM_WIKI_DIR).is_dir(),
        root.join(LANCEDB_DIR).is_dir(),
        root.join(FILE_SNAPSHOT).is_file(),
        root.join(FILE_CHANGE_QUEUE).is_file(),
        root.join(EMBEDDING_REVISIONS_DIR).is_dir(),
    )
}

fn ensure_text_file(path: impl AsRef<Path>, initial_content: &str) -> std::io::Result<()> {
    let path = path.as_ref();
    if !path.exists() {
        std::fs::write(path, initial_content)?;
    }
    Ok(())
}

fn ensure_json_file(path: impl AsRef<Path>, initial_content: &str) -> std::io::Result<()> {
    ensure_text_file(path, initial_content)
}

fn initial_log_content() -> String {
    format!(
        "# Wiki Log\n\n## {}\n\n- Project created\n",
        Local::now().format("%Y-%m-%d")
    )
}
