use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

const CATALOG_FILE: &str = "catalog.json";
const TEMPLATE_FILES: [TemplateFile; 5] = [
    TemplateFile::Agents,
    TemplateFile::Soul,
    TemplateFile::Tools,
    TemplateFile::Identity,
    TemplateFile::User,
];

#[derive(Clone, Eq, PartialEq)]
pub struct SubagentTemplateDirectory(PathBuf);

impl SubagentTemplateDirectory {
    pub fn try_new(path: PathBuf) -> Result<Self, SubagentTemplateError> {
        if !absolute_path(&path) {
            return Err(SubagentTemplateError::Unavailable);
        }
        Ok(Self(path))
    }

    fn inspect(&self) -> Result<&Path, SubagentTemplateError> {
        let metadata =
            fs::symlink_metadata(&self.0).map_err(|_| SubagentTemplateError::Unavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(SubagentTemplateError::Unavailable);
        }
        Ok(&self.0)
    }
}

impl std::fmt::Debug for SubagentTemplateDirectory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SubagentTemplateDirectory(<redacted>)")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    categories: Vec<Category>,
    templates: Vec<Summary>,
}

impl Catalog {
    pub fn categories(&self) -> &[Category] {
        &self.categories
    }

    pub fn templates(&self) -> &[Summary] {
        &self.templates
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    template: Template,
}

impl Detail {
    pub fn template(&self) -> &Template {
        &self.template
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subcategory_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
    files: Vec<TemplateFile>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    #[serde(flatten)]
    summary: Summary,
    file_contents: BTreeMap<TemplateFile, String>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum TemplateFile {
    #[serde(rename = "AGENTS.md")]
    Agents,
    #[serde(rename = "SOUL.md")]
    Soul,
    #[serde(rename = "TOOLS.md")]
    Tools,
    #[serde(rename = "IDENTITY.md")]
    Identity,
    #[serde(rename = "USER.md")]
    User,
}

impl TemplateFile {
    fn file_name(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Soul => "SOUL.md",
            Self::Tools => "TOOLS.md",
            Self::Identity => "IDENTITY.md",
            Self::User => "USER.md",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubagentTemplateError {
    Unavailable,
    NotFound,
}

impl std::fmt::Display for SubagentTemplateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Subagent templates are unavailable",
            Self::NotFound => "Subagent template was not found",
        })
    }
}

impl std::error::Error for SubagentTemplateError {}

pub struct SubagentTemplateCatalog;

impl SubagentTemplateCatalog {
    pub fn list(directory: &SubagentTemplateDirectory) -> Result<Catalog, SubagentTemplateError> {
        let root = directory.inspect()?;
        let metadata = read_metadata(root)?;
        let mut templates = Vec::new();
        for entry in fs::read_dir(root).map_err(|_| SubagentTemplateError::Unavailable)? {
            let entry = entry.map_err(|_| SubagentTemplateError::Unavailable)?;
            let file_type = entry
                .file_type()
                .map_err(|_| SubagentTemplateError::Unavailable)?;
            if file_type.is_symlink() || !file_type.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !template_id(&id) {
                continue;
            }
            let path = entry.path();
            let files = present_files(&path)?;
            if files.is_empty() {
                continue;
            }
            let identity = read_regular(&path.join(TemplateFile::Identity.file_name()))?;
            let agents = read_regular(&path.join(TemplateFile::Agents.file_name()))?;
            let (name, summary) = identity_metadata(identity.as_deref(), &id, agents.as_deref());
            let meta = metadata.templates.get(&id);
            templates.push(Summary {
                id,
                name,
                summary,
                category_id: meta.and_then(|value| value.category_id.clone()),
                subcategory_id: meta.and_then(|value| value.subcategory_id.clone()),
                order: meta.and_then(|value| value.order),
                files,
            });
        }
        templates.sort_by(|left, right| {
            left.order
                .unwrap_or(i64::MAX)
                .cmp(&right.order.unwrap_or(i64::MAX))
                .then_with(|| left.id.cmp(&right.id))
        });
        let used = templates
            .iter()
            .filter_map(|template| template.category_id.as_deref())
            .collect::<BTreeSet<_>>();
        let mut categories = metadata
            .categories
            .into_iter()
            .filter(|category| used.contains(category.id.as_str()))
            .collect::<Vec<_>>();
        let known = categories
            .iter()
            .map(|category| category.id.clone())
            .collect::<BTreeSet<_>>();
        categories.extend(
            used.into_iter()
                .filter(|id| !known.contains(*id))
                .map(|id| Category {
                    id: id.to_owned(),
                    order: None,
                }),
        );
        categories.sort_by(|left, right| {
            left.order
                .unwrap_or(i64::MAX)
                .cmp(&right.order.unwrap_or(i64::MAX))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(Catalog {
            categories,
            templates,
        })
    }

    pub fn detail(
        directory: &SubagentTemplateDirectory,
        id: &str,
    ) -> Result<Detail, SubagentTemplateError> {
        let id = id.trim();
        if !template_id(id) {
            return Err(SubagentTemplateError::NotFound);
        }
        let catalog = Self::list(directory)?;
        let summary = catalog
            .templates
            .into_iter()
            .find(|template| template.id == id)
            .ok_or(SubagentTemplateError::NotFound)?;
        let root = directory.inspect()?;
        let template_directory = root.join(id);
        let mut file_contents = BTreeMap::new();
        for file in TEMPLATE_FILES {
            if let Some(content) = read_regular(&template_directory.join(file.file_name()))? {
                file_contents.insert(file, content);
            }
        }
        Ok(Detail {
            template: Template {
                summary,
                file_contents,
            },
        })
    }
}

fn absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
}

fn template_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn present_files(path: &Path) -> Result<Vec<TemplateFile>, SubagentTemplateError> {
    TEMPLATE_FILES
        .into_iter()
        .filter_map(|file| match read_regular(&path.join(file.file_name())) {
            Ok(Some(_)) => Some(Ok(file)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn read_regular(path: &Path) -> Result<Option<String>, SubagentTemplateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(SubagentTemplateError::Unavailable)
        }
        Ok(_) => fs::read_to_string(path)
            .map(Some)
            .map_err(|_| SubagentTemplateError::Unavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SubagentTemplateError::Unavailable),
    }
}

#[derive(Default)]
struct Metadata {
    categories: Vec<Category>,
    templates: BTreeMap<String, TemplateMetadata>,
}

#[derive(Clone)]
struct TemplateMetadata {
    category_id: Option<String>,
    subcategory_id: Option<String>,
    order: Option<i64>,
}

#[derive(Deserialize)]
struct RawCatalog {
    #[serde(default)]
    categories: Vec<RawCategory>,
    #[serde(default)]
    templates: Vec<RawTemplate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCategory {
    id: Option<String>,
    order: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTemplate {
    id: Option<String>,
    category_id: Option<String>,
    subcategory_id: Option<String>,
    order: Option<i64>,
}

fn read_metadata(root: &Path) -> Result<Metadata, SubagentTemplateError> {
    let Some(raw) = read_regular(&root.join(CATALOG_FILE))? else {
        return Ok(Metadata::default());
    };
    let Ok(raw) = serde_json::from_str::<RawCatalog>(&raw) else {
        return Ok(Metadata::default());
    };
    let mut categories = raw
        .categories
        .into_iter()
        .filter_map(|category| {
            non_empty(category.id).map(|id| Category {
                id,
                order: category.order,
            })
        })
        .collect::<Vec<_>>();
    categories.sort_by(|left, right| {
        left.order
            .unwrap_or(i64::MAX)
            .cmp(&right.order.unwrap_or(i64::MAX))
            .then_with(|| left.id.cmp(&right.id))
    });
    let templates = raw
        .templates
        .into_iter()
        .filter_map(|template| {
            non_empty(template.id).map(|id| {
                (
                    id,
                    TemplateMetadata {
                        category_id: non_empty(template.category_id),
                        subcategory_id: non_empty(template.subcategory_id),
                        order: template.order,
                    },
                )
            })
        })
        .collect();
    Ok(Metadata {
        categories,
        templates,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn identity_metadata(
    identity: Option<&str>,
    fallback: &str,
    agents: Option<&str>,
) -> (String, Option<String>) {
    let fallback = title(fallback);
    let Some(identity) = identity else {
        return (fallback, first_content_line(agents));
    };
    let mut heading = None;
    let mut summary = None;
    for line in identity
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(value) = line
            .strip_prefix('#')
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            heading = Some(value);
            continue;
        }
        if summary.is_none() {
            summary = Some(line.to_owned());
        }
    }
    let name = heading
        .map(|value| {
            value
                .split_whitespace()
                .filter(|part| !pictographic(part))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    (name, summary.or_else(|| first_content_line(agents)))
}

fn first_content_line(content: Option<&str>) -> Option<String> {
    content.and_then(|content| {
        content
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .map(str::to_owned)
    })
}

fn pictographic(value: &str) -> bool {
    value
        .chars()
        .any(|character| !character.is_ascii() && !character.is_alphabetic())
}

fn title(value: &str) -> String {
    value
        .split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
#[path = "subagent_templates_tests.rs"]
mod subagent_templates_tests;
