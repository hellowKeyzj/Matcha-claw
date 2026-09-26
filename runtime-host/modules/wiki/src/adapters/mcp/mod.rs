use std::{future::Future, path::Path, sync::Arc};

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::mcp::arguments::{optional_string, require_exact_keys, required_string};
use platform::mcp::{ToolCallError, ToolCallOutcome, ToolProvider};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::runtime::Runtime;

use crate::domain::{
    WikiApplyGeneratedPagesInput, WikiDeleteSourceInput, WikiGeneratedPageInput,
    WikiImportFolderInput, WikiImportSourceInput,
};
use crate::{
    WikiFailure, WikiFilesInput, WikiHandle, WikiPathSelector, WikiProjectSelector, WikiReadInput,
    WikiRetrieveContextInput, WikiSearchInput, index, spawn_owner,
};

pub(crate) struct WikiMcpFacade {
    wiki: WikiHandle,
    _owner_task: OwnedTask<()>,
    _owner_runtime_system: OwnerRuntimeSystem,
    runtime: Runtime,
}

impl WikiMcpFacade {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, WikiFailure> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                WikiFailure::state(format!("wiki MCP runtime unavailable: {error}"))
            })?;
        let (wiki, _owner_task, _owner_runtime_system) = {
            let _guard = runtime.enter();
            let owner_runtime_system = OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::default());
            let vector_index = index::LocalWikiVectorIndex::load_default()
                .map(|index| Arc::new(index) as Arc<dyn index::WikiVectorIndex>)
                .ok();
            let (module, owner_task) = spawn_owner(
                &owner_runtime_system,
                crate::WikiOwnerInput::new(state_dir.to_path_buf()).with_vector_index(vector_index),
            )?;
            (module.handle().clone(), owner_task, owner_runtime_system)
        };
        Ok(Self {
            wiki,
            _owner_task,
            _owner_runtime_system,
            runtime,
        })
    }

    fn run<T>(&self, future: impl Future<Output = Result<T, WikiFailure>>) -> ToolCallOutcome
    where
        T: Serialize,
    {
        self.runtime
            .block_on(future)
            .map_err(map_wiki_error)
            .and_then(|value| serde_json::to_value(value).map_err(|_| ToolCallError::Internal))
    }

    fn run_unit(&self, future: impl Future<Output = Result<(), WikiFailure>>) -> ToolCallOutcome {
        self.runtime
            .block_on(future)
            .map(|()| json!({ "success": true }))
            .map_err(map_wiki_error)
    }
}

impl ToolProvider for WikiMcpFacade {
    fn tools(&self) -> Vec<Value> {
        vec![
            wiki_status_tool(),
            wiki_projects_tool(),
            wiki_set_project_tool(),
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

    fn call(&mut self, name: &str, arguments: &Map<String, Value>) -> Option<ToolCallOutcome> {
        Some(match name {
            "wiki_status" => {
                if require_exact_keys(arguments, &[]).is_err() {
                    return Some(Err(ToolCallError::InvalidParams));
                }
                self.run(self.wiki.status())
            }
            "wiki_projects" => {
                if require_exact_keys(arguments, &[]).is_err() {
                    return Some(Err(ToolCallError::InvalidParams));
                }
                self.run(self.wiki.projects())
            }
            "wiki_set_project" => parse_set_project(arguments)
                .map(|input| self.run(self.wiki.set_current_project(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_files" => parse_files(arguments)
                .map(|input| self.run(self.wiki.files(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_read_file" => parse_read(arguments)
                .map(|input| self.run(self.wiki.read(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_search" => parse_search(arguments, 20)
                .map(|input| self.run(self.wiki.search(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_graph" => parse_project_selector(arguments)
                .map(|input| self.run(self.wiki.graph(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_rescan_sources" => parse_project_selector(arguments)
                .map(|input| self.run(self.wiki.rescan(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_import_source" => parse_import_source(arguments)
                .map(|input| self.run(self.wiki.import_source(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_import_folder" => parse_import_folder(arguments)
                .map(|input| self.run(self.wiki.import_folder(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_refresh_sources" => parse_project_selector(arguments)
                .map(|input| self.run(self.wiki.refresh_sources(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_apply_generated_pages" => parse_apply_generated_pages(arguments)
                .map(|input| self.run(self.wiki.apply_generated_pages(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_delete_source" => parse_delete_source(arguments)
                .map(|input| self.run(self.wiki.delete_source(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_source_tasks" => parse_project_selector(arguments)
                .map(|input| self.run(self.wiki.source_tasks(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_embed_page" => parse_path_selector(arguments)
                .map(|input| self.run_unit(self.wiki.embed_page(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            "wiki_retrieve_context" => parse_retrieve(arguments, 8)
                .map(|input| self.run(self.wiki.retrieve_context(input)))
                .unwrap_or(Err(ToolCallError::InvalidParams)),
            _ => return None,
        })
    }
}

fn parse_project_selector(
    arguments: &Map<String, Value>,
) -> Result<WikiProjectSelector, ToolCallError> {
    require_exact_keys(arguments, &["projectId"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiProjectSelector {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
    })
}

fn parse_set_project(arguments: &Map<String, Value>) -> Result<WikiProjectSelector, ToolCallError> {
    require_exact_keys(arguments, &["projectId"]).map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiProjectSelector {
        project_id: Some(
            required_string(arguments, "projectId")
                .map_err(|_| ToolCallError::InvalidParams)?
                .to_owned(),
        ),
    })
}

fn parse_files(arguments: &Map<String, Value>) -> Result<WikiFilesInput, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "directory"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiFilesInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        directory: optional_string(arguments, "directory")
            .map_err(|_| ToolCallError::InvalidParams)?
            .unwrap_or_default(),
    })
}

fn parse_read(arguments: &Map<String, Value>) -> Result<WikiReadInput, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "relativePath", "limit"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiReadInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        relative_path: required_string(arguments, "relativePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        limit: optional_limit(arguments, "limit", 0)?,
    })
}

fn parse_path_selector(arguments: &Map<String, Value>) -> Result<WikiPathSelector, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "relativePath"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiPathSelector {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        relative_path: required_string(arguments, "relativePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
    })
}

fn parse_import_source(
    arguments: &Map<String, Value>,
) -> Result<WikiImportSourceInput, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "sourcePath"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiImportSourceInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        source_path: required_string(arguments, "sourcePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
    })
}

fn parse_import_folder(
    arguments: &Map<String, Value>,
) -> Result<WikiImportFolderInput, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "folderPath"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiImportFolderInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        folder_path: required_string(arguments, "folderPath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
    })
}

fn parse_delete_source(
    arguments: &Map<String, Value>,
) -> Result<WikiDeleteSourceInput, ToolCallError> {
    require_exact_keys(
        arguments,
        &["projectId", "sourcePath", "fileAlreadyDeleted"],
    )
    .map_err(|_| ToolCallError::InvalidParams)?;
    Ok(WikiDeleteSourceInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        source_path: required_string(arguments, "sourcePath")
            .map_err(|_| ToolCallError::InvalidParams)?
            .to_owned(),
        file_already_deleted: optional_bool(arguments, "fileAlreadyDeleted")?,
    })
}

fn parse_apply_generated_pages(
    arguments: &Map<String, Value>,
) -> Result<WikiApplyGeneratedPagesInput, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "sourcePath", "files"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    let files = arguments
        .get("files")
        .and_then(Value::as_array)
        .ok_or(ToolCallError::InvalidParams)?
        .iter()
        .map(parse_generated_page)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WikiApplyGeneratedPagesInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
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
    require_exact_keys(arguments, &["projectId", "query", "limit"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    let query = required_query(arguments)?;
    Ok(WikiSearchInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
        query,
        limit: optional_limit(arguments, "limit", default_limit)?,
    })
}

fn parse_retrieve(
    arguments: &Map<String, Value>,
    default_limit: usize,
) -> Result<WikiRetrieveContextInput, ToolCallError> {
    require_exact_keys(arguments, &["projectId", "query", "limit"])
        .map_err(|_| ToolCallError::InvalidParams)?;
    let query = required_query(arguments)?;
    Ok(WikiRetrieveContextInput {
        project_id: optional_string(arguments, "projectId")
            .map_err(|_| ToolCallError::InvalidParams)?,
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

fn project_id_property() -> Value {
    json!({ "type": ["string", "null"], "minLength": 1 })
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

fn wiki_set_project_tool() -> Value {
    json!({
        "name": "wiki_set_project",
        "description": "Set the current wiki project by project id.",
        "inputSchema": schema(json!({
            "projectId": { "type": "string", "minLength": 1 }
        }), &["projectId"]),
    })
}

fn wiki_files_tool() -> Value {
    json!({
        "name": "wiki_files",
        "description": "List files under a wiki project directory.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
            "directory": { "type": ["string", "null"], "default": "" }
        }), &[]),
    })
}

fn wiki_read_file_tool() -> Value {
    json!({
        "name": "wiki_read_file",
        "description": "Read a text file from the current or selected wiki project.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
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
            "projectId": project_id_property(),
            "query": { "type": "string", "minLength": 1 },
            "limit": limit_property(20)
        }), &["query"]),
    })
}

fn wiki_graph_tool() -> Value {
    json!({
        "name": "wiki_graph",
        "description": "Return the wiki link graph for the current or selected project.",
        "inputSchema": schema(json!({
            "projectId": project_id_property()
        }), &[]),
    })
}

fn wiki_rescan_sources_tool() -> Value {
    json!({
        "name": "wiki_rescan_sources",
        "description": "Rescan wiki project files and update the change queue.",
        "inputSchema": schema(json!({
            "projectId": project_id_property()
        }), &[]),
    })
}

fn wiki_import_source_tool() -> Value {
    json!({
        "name": "wiki_import_source",
        "description": "Import a source file into the current or selected wiki project.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
            "sourcePath": { "type": "string", "minLength": 1 }
        }), &["sourcePath"]),
    })
}

fn wiki_import_folder_tool() -> Value {
    json!({
        "name": "wiki_import_folder",
        "description": "Import source files from a folder into the current or selected wiki project.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
            "folderPath": { "type": "string", "minLength": 1 }
        }), &["folderPath"]),
    })
}

fn wiki_refresh_sources_tool() -> Value {
    json!({
        "name": "wiki_refresh_sources",
        "description": "Refresh imported wiki sources for the current or selected project.",
        "inputSchema": schema(json!({
            "projectId": project_id_property()
        }), &[]),
    })
}

fn wiki_apply_generated_pages_tool() -> Value {
    json!({
        "name": "wiki_apply_generated_pages",
        "description": "Apply generated wiki pages for a source file.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
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
            "projectId": project_id_property(),
            "sourcePath": { "type": "string", "minLength": 1 },
            "fileAlreadyDeleted": { "type": ["boolean", "null"], "default": false }
        }), &["sourcePath"]),
    })
}

fn wiki_source_tasks_tool() -> Value {
    json!({
        "name": "wiki_source_tasks",
        "description": "List wiki source import and generation tasks.",
        "inputSchema": schema(json!({
            "projectId": project_id_property()
        }), &[]),
    })
}

fn wiki_embed_page_tool() -> Value {
    json!({
        "name": "wiki_embed_page",
        "description": "Embed one wiki page into the local vector index.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
            "relativePath": { "type": "string", "minLength": 1 }
        }), &["relativePath"]),
    })
}

fn wiki_retrieve_context_tool() -> Value {
    json!({
        "name": "wiki_retrieve_context",
        "description": "Retrieve relevant wiki context for a query.",
        "inputSchema": schema(json!({
            "projectId": project_id_property(),
            "query": { "type": "string", "minLength": 1 },
            "limit": limit_property(8)
        }), &["query"]),
    })
}
