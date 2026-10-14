use platform::mcp::arguments::{optional_string, require_exact_keys, required_string};
use platform::mcp::{ToolCallError, ToolCallFuture, ToolCallOutcome, ToolProvider};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::application::commands::IngestMode;
use crate::domain::{
    WikiApplyGeneratedPagesInput, WikiDeleteSourceInput, WikiGeneratedPageInput,
    WikiImportFolderInput, WikiImportSourceInput,
};
use crate::{
    WikiFailure, WikiFilesInput, WikiHandle, WikiPathSelector, WikiProjectSelector, WikiReadInput,
    WikiRetrieveContextInput, WikiSearchInput,
};

pub struct WikiMcpFacade {
    call: Box<dyn for<'a> Fn(&'a str, &'a Map<String, Value>) -> ToolCallFuture<'a> + Send + Sync>,
}

impl WikiMcpFacade {
    pub fn new(
        call: impl for<'a> Fn(&'a str, &'a Map<String, Value>) -> ToolCallFuture<'a> + Send + Sync + 'static,
    ) -> Self {
        Self {
            call: Box::new(call),
        }
    }
}

pub fn is_wiki_tool(name: &str) -> bool {
    matches!(
        name,
        "wiki_status"
            | "wiki_projects"
            | "wiki_files"
            | "wiki_read_file"
            | "wiki_search"
            | "wiki_graph"
            | "wiki_rescan_sources"
            | "wiki_import_source"
            | "wiki_import_folder"
            | "wiki_refresh_sources"
            | "wiki_apply_generated_pages"
            | "wiki_delete_source"
            | "wiki_source_tasks"
            | "wiki_embed_page"
            | "wiki_retrieve_context"
    )
}

impl ToolProvider for WikiMcpFacade {
    fn tools(&self) -> Vec<Value> {
        vec![
            wiki_status_tool(),
            wiki_projects_tool(),
            wiki_files_tool(),
            wiki_read_file_tool(),
            wiki_search_tool(),
            wiki_graph_tool(),
            wiki_rescan_sources_tool(),
            wiki_import_source_tool(),
            wiki_import_folder_tool(),
            wiki_refresh_sources_tool(),
            wiki_apply_generated_pages_tool(),
            wiki_delete_source_tool(),
            wiki_source_tasks_tool(),
            wiki_embed_page_tool(),
            wiki_retrieve_context_tool(),
        ]
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> Option<ToolCallFuture<'a>> {
        is_wiki_tool(name).then(|| (self.call)(name, arguments))
    }
}

impl WikiHandle {
    pub async fn execute_mcp(&self, name: &str, arguments: &Map<String, Value>) -> ToolCallOutcome {
        match name {
            "wiki_status" => {
                require_exact_keys(arguments, &[]).map_err(|_| ToolCallError::InvalidParams)?;
                result(self.status().await)
            }
            "wiki_projects" => {
                require_exact_keys(arguments, &[]).map_err(|_| ToolCallError::InvalidParams)?;
                result(self.projects().await)
            }
            "wiki_files" => result(self.files(parse_files(arguments)?).await),
            "wiki_read_file" => result(self.read(parse_read(arguments)?).await),
            "wiki_search" => result(self.search(parse_search(arguments, 20)?).await),
            "wiki_graph" => result(self.graph(parse_project_selector(arguments)?).await),
            "wiki_rescan_sources" => result(self.rescan(parse_project_selector(arguments)?).await),
            "wiki_import_source" => result(
                self.import_source_with_ingest(
                    parse_import_source(arguments)?,
                    IngestMode::SourceOnly,
                )
                .await,
            ),
            "wiki_import_folder" => result(
                self.import_folder_with_ingest(
                    parse_import_folder(arguments)?,
                    IngestMode::SourceOnly,
                )
                .await,
            ),
            "wiki_refresh_sources" => result(
                self.refresh_sources_with_ingest(
                    parse_project_selector(arguments)?,
                    IngestMode::SourceOnly,
                )
                .await,
            ),
            "wiki_apply_generated_pages" => result(
                self.apply_generated_pages(parse_apply_generated_pages(arguments)?)
                    .await,
            ),
            "wiki_delete_source" => {
                result(self.delete_source(parse_delete_source(arguments)?).await)
            }
            "wiki_source_tasks" => {
                result(self.source_tasks(parse_project_selector(arguments)?).await)
            }
            "wiki_embed_page" => self
                .embed_page(parse_path_selector(arguments)?)
                .await
                .map(|()| json!({ "success": true }))
                .map_err(map_wiki_error),
            "wiki_retrieve_context" => {
                result(self.retrieve_context(parse_retrieve(arguments, 8)?).await)
            }
            _ => Err(ToolCallError::InvalidParams),
        }
    }
}

fn result<T: Serialize>(value: Result<T, WikiFailure>) -> ToolCallOutcome {
    value
        .map_err(map_wiki_error)
        .and_then(|value| serde_json::to_value(value).map_err(|_| ToolCallError::Internal))
}

fn parse_project_selector(
    arguments: &Map<String, Value>,
) -> Result<WikiProjectSelector, ToolCallError> {
    require_exact_keys(arguments, &[]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiProjectSelector { project_id: None })
}

fn parse_files(arguments: &Map<String, Value>) -> Result<WikiFilesInput, ToolCallError> {
    require_exact_keys(arguments, &["directory"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiFilesInput {
        project_id: None,
        directory: optional_string(arguments, "directory")
            .map_err(|_| ToolCallError::InvalidParams)?
            .unwrap_or_default(),
    })
}

fn parse_read(arguments: &Map<String, Value>) -> Result<WikiReadInput, ToolCallError> {
    require_exact_keys(arguments, &["relativePath", "limit"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiReadInput {
        project_id: None,
        relative_path: required_string(arguments, "relativePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        limit: optional_limit(arguments, "limit", 0)?,
    })
}

fn parse_path_selector(arguments: &Map<String, Value>) -> Result<WikiPathSelector, ToolCallError> {
    require_exact_keys(arguments, &["relativePath"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiPathSelector {
        project_id: None,
        relative_path: required_string(arguments, "relativePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
    })
}

fn parse_import_source(
    arguments: &Map<String, Value>,
) -> Result<WikiImportSourceInput, ToolCallError> {
    require_exact_keys(arguments, &["sourcePath"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiImportSourceInput {
        project_id: None,
        source_path: required_string(arguments, "sourcePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
    })
}

fn parse_import_folder(
    arguments: &Map<String, Value>,
) -> Result<WikiImportFolderInput, ToolCallError> {
    require_exact_keys(arguments, &["folderPath"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiImportFolderInput {
        project_id: None,
        folder_path: required_string(arguments, "folderPath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
    })
}

fn parse_delete_source(
    arguments: &Map<String, Value>,
) -> Result<WikiDeleteSourceInput, ToolCallError> {
    require_exact_keys(arguments, &["sourcePath", "fileAlreadyDeleted"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiDeleteSourceInput {
        project_id: None,
        source_path: required_string(arguments, "sourcePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        file_already_deleted: optional_bool(arguments, "fileAlreadyDeleted")?,
    })
}

fn parse_apply_generated_pages(
    arguments: &Map<String, Value>,
) -> Result<WikiApplyGeneratedPagesInput, ToolCallError> {
    require_exact_keys(arguments, &["sourcePath", "files"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    let files = arguments
        .get("files")
        .and_then(Value::as_array)
        .ok_or(ToolCallError::InvalidParams)?
        .iter()
        .map(parse_generated_page)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WikiApplyGeneratedPagesInput {
        project_id: None,
        source_path: required_string(arguments, "sourcePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        files,
        reviews: Vec::new(),
    })
}

fn parse_generated_page(value: &Value) -> Result<WikiGeneratedPageInput, ToolCallError> {
    let object = value.as_object().ok_or(ToolCallError::InvalidParams)?;
    require_exact_keys(object, &["path", "content"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiGeneratedPageInput {
        path: required_string(object, "path")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        content: required_string_value(object, "content")?.to_owned(),
    })
}

fn optional_bool(arguments: &Map<String, Value>, key: &str) -> Result<bool, ToolCallError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(ToolCallError::InvalidParams),
    }
}

fn required_string_value<'a>(
    arguments: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ToolCallError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .ok_or(ToolCallError::InvalidParams)
}

fn parse_search(
    arguments: &Map<String, Value>,
    default_limit: usize,
) -> Result<WikiSearchInput, ToolCallError> {
    require_exact_keys(arguments, &["query", "limit"]).map_err(|_| ToolCallError::InvalidParams)?;
    let query = required_query(arguments)?;
    Ok(WikiSearchInput {
        project_id: None,
        query,
        limit: optional_limit(arguments, "limit", default_limit)?,
    })
}

fn parse_retrieve(
    arguments: &Map<String, Value>,
    default_limit: usize,
) -> Result<WikiRetrieveContextInput, ToolCallError> {
    require_exact_keys(arguments, &["query", "limit"]).map_err(|_| ToolCallError::InvalidParams)?;
    let query = required_query(arguments)?;
    Ok(WikiRetrieveContextInput {
        project_id: None,
        query,
        limit: optional_limit(arguments, "limit", default_limit)?,
    })
}

fn required_query(arguments: &Map<String, Value>) -> Result<String, ToolCallError> {
    let query = required_string(arguments, "query").map_err(|_| ToolCallError::InvalidParams)?;
    (!query.trim().is_empty())
        .then(|| query.to_owned())
        .ok_or(ToolCallError::InvalidParams)
}

fn optional_limit(
    arguments: &Map<String, Value>,
    key: &str,
    default: usize,
) -> Result<usize, ToolCallError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(ToolCallError::InvalidParams),
        _ => Err(ToolCallError::InvalidParams),
    }
}

fn map_wiki_error(error: WikiFailure) -> ToolCallError {
    match error {
        WikiFailure::CurrentProjectUnset
        | WikiFailure::ProjectNotFound { .. }
        | WikiFailure::InvalidInput { .. }
        | WikiFailure::InvalidPath { .. }
        | WikiFailure::PathOutsideProject { .. }
        | WikiFailure::NotFound { .. }
        | WikiFailure::IsDirectory { .. }
        | WikiFailure::NotText { .. } => ToolCallError::InvalidParams,
        WikiFailure::Cancelled
        | WikiFailure::OwnerUnavailable
        | WikiFailure::StateUnavailable { .. }
        | WikiFailure::Io { .. }
        | WikiFailure::IndexUnavailable { .. } => ToolCallError::Internal,
    }
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    })
}

fn limit_property(default: usize) -> Value {
    json!({ "type": ["integer", "null"], "minimum": 0, "default": default })
}

fn wiki_status_tool() -> Value {
    json!({
        "name": "wiki_status",
        "description": "Return wiki owner status and the current project summary.",
        "inputSchema": schema(json!({}), &[]),
    })
}

fn wiki_projects_tool() -> Value {
    json!({
        "name": "wiki_projects",
        "description": "List registered wiki projects.",
        "inputSchema": schema(json!({}), &[]),
    })
}

fn wiki_files_tool() -> Value {
    json!({
        "name": "wiki_files",
        "description": "List files under a wiki project directory.",
        "inputSchema": schema(json!({
            "directory": { "type": ["string", "null"], "default": "" }
        }), &[]),
    })
}

fn wiki_read_file_tool() -> Value {
    json!({
        "name": "wiki_read_file",
        "description": "Read a text file from the current wiki project.",
        "inputSchema": schema(json!({
            "relativePath": { "type": "string", "minLength": 1 },
            "limit": limit_property(0)
        }), &["relativePath"]),
    })
}

fn wiki_search_tool() -> Value {
    json!({
        "name": "wiki_search",
        "description": "Run keyword search over wiki project markdown.",
        "inputSchema": schema(json!({
            "query": { "type": "string", "minLength": 1 },
            "limit": limit_property(20)
        }), &["query"]),
    })
}

fn wiki_graph_tool() -> Value {
    json!({
        "name": "wiki_graph",
        "description": "Return the wiki link graph for the current project.",
        "inputSchema": schema(json!({}), &[]),
    })
}

fn wiki_rescan_sources_tool() -> Value {
    json!({
        "name": "wiki_rescan_sources",
        "description": "Rescan wiki project files and update the change queue.",
        "inputSchema": schema(json!({}), &[]),
    })
}

fn wiki_import_source_tool() -> Value {
    json!({
        "name": "wiki_import_source",
        "description": "Import a source file into the current wiki project.",
        "inputSchema": schema(json!({
            "sourcePath": { "type": "string", "minLength": 1 }
        }), &["sourcePath"]),
    })
}

fn wiki_import_folder_tool() -> Value {
    json!({
        "name": "wiki_import_folder",
        "description": "Import source files from a folder into the current wiki project.",
        "inputSchema": schema(json!({
            "folderPath": { "type": "string", "minLength": 1 }
        }), &["folderPath"]),
    })
}

fn wiki_refresh_sources_tool() -> Value {
    json!({
        "name": "wiki_refresh_sources",
        "description": "Refresh imported wiki sources for the current project.",
        "inputSchema": schema(json!({}), &[]),
    })
}

fn wiki_apply_generated_pages_tool() -> Value {
    json!({
        "name": "wiki_apply_generated_pages",
        "description": "Apply generated wiki pages for a source file.",
        "inputSchema": schema(json!({
            "sourcePath": { "type": "string", "minLength": 1 },
            "files": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "path": { "type": "string", "minLength": 1 },
                        "content": { "type": "string" }
                    },
                    "required": ["path", "content"]
                }
            }
        }), &["sourcePath", "files"]),
    })
}

fn wiki_delete_source_tool() -> Value {
    json!({
        "name": "wiki_delete_source",
        "description": "Delete an imported wiki source and its generated pages.",
        "inputSchema": schema(json!({
            "sourcePath": { "type": "string", "minLength": 1 },
            "fileAlreadyDeleted": { "type": ["boolean", "null"], "default": false }
        }), &["sourcePath"]),
    })
}

fn wiki_source_tasks_tool() -> Value {
    json!({
        "name": "wiki_source_tasks",
        "description": "List wiki source import and generation tasks.",
        "inputSchema": schema(json!({}), &[]),
    })
}

fn wiki_embed_page_tool() -> Value {
    json!({
        "name": "wiki_embed_page",
        "description": "Embed one wiki page into the local vector index.",
        "inputSchema": schema(json!({
            "relativePath": { "type": "string", "minLength": 1 }
        }), &["relativePath"]),
    })
}

fn wiki_retrieve_context_tool() -> Value {
    json!({
        "name": "wiki_retrieve_context",
        "description": "Retrieve relevant wiki context for a query.",
        "inputSchema": schema(json!({
            "query": { "type": "string", "minLength": 1 },
            "limit": limit_property(8)
        }), &["query"]),
    })
}
