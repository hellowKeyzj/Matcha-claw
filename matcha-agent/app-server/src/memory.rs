pub(crate) mod files;

use crate::{
    config::{ConfigStore, Paths},
    rpc,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    #[default]
    Auto,
    User,
    Project,
    Local,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::User => "user",
            Self::Project => "project",
            Self::Local => "local",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    agent_id: String,
    #[serde(default)]
    scope: Scope,
    name: Option<String>,
    path: Option<String>,
    content: Option<String>,
}

// cli::projection uses this same path for trusted native autoMemoryDirectory.
// src/memdir/paths.ts:getAutoMemPathSetting consumes it before cwd/git defaults.
pub(crate) fn auto_memory_directory(paths: &Paths, agent_id: &str) -> rpc::Result<PathBuf> {
    Ok(paths.runtime(agent_id)?.join("memory"))
}

pub async fn dispatch(method: &str, params: Value, config: &ConfigStore) -> rpc::Result<Value> {
    if !matches!(
        method,
        "memory.list" | "memory.read" | "memory.write" | "memory.delete"
    ) {
        return Err(rpc::Error::method(method));
    }
    let params: Params = rpc::params(params)?;
    let directory = directory(config.paths(), &params)?;
    let is_list = method == "memory.list";
    if is_list && params.path.is_some() || method != "memory.write" && params.content.is_some() {
        return Err(rpc::Error::invalid(
            "This method does not accept path or content in that position",
        ));
    }
    let path = if is_list {
        None
    } else {
        let path = params
            .path
            .as_deref()
            .ok_or_else(|| rpc::Error::invalid("path is required"))?;
        files::relative(path, false)?;
        if !path.ends_with(".md") {
            return Err(rpc::Error::invalid(
                "Memory resources must be Markdown (.md) files",
            ));
        }
        Some(path)
    };
    let content = if method == "memory.write" {
        Some(
            params
                .content
                .as_deref()
                .ok_or_else(|| rpc::Error::invalid("content is required"))?,
        )
    } else {
        None
    };
    let root = files::Root::open(config, &params.agent_id, &directory).await?;
    let mut response = json!({
        "agentId": params.agent_id,
        "scope": params.scope.as_str(),
        "name": params.name,
        "storage": "native_text_files",
        "entrypoint": "MEMORY.md",
        "indexManaged": false,
        "nativeConsumption": "subject_to_native_settings_and_memory_scope",
    });
    match method {
        "memory.list" => {
            response["files"] = rpc::value(root.list("").await?)?;
        }
        "memory.read" => {
            let path = path.expect("validated file method");
            response["path"] = json!(path);
            response["content"] = json!(root.read(path).await?);
        }
        "memory.write" | "memory.delete" => {
            let path = path.expect("validated file method");
            if let Some(content) = content {
                root.write(path, content).await?;
            } else {
                root.remove(path).await?;
            }
            response["path"] = json!(path);
            response["persisted"] = json!(true);
            response["apply"] = json!("next_session");
            response["liveReload"] = json!(false);
        }
        _ => unreachable!(),
    }
    Ok(response)
}

fn directory(paths: &Paths, params: &Params) -> rpc::Result<PathBuf> {
    if matches!(params.scope, Scope::Auto) {
        if params.name.is_some() {
            return Err(rpc::Error::invalid(
                "name is only accepted for native AgentTool memory scopes",
            ));
        }
        return auto_memory_directory(paths, &params.agent_id);
    }
    let name = params.name.as_deref().ok_or_else(|| {
        rpc::Error::invalid("name is required for native AgentTool memory scopes")
    })?;
    // AgentTool/agentMemory.ts:sanitizeAgentTypeForPath only replaces ':'.
    // Keep native plugin namespaces, but reject any path-bearing type name.
    let name = name.replace(':', "-");
    let relative = files::relative(&name, false)?;
    if relative.components().count() != 1 {
        return Err(rpc::Error::invalid(
            "name must be a single native agent type",
        ));
    }
    Ok(match params.scope {
        Scope::User => paths
            .runtime(&params.agent_id)?
            .join("agent-memory")
            .join(name),
        Scope::Project => paths
            .workspace(&params.agent_id)?
            .join(".claude/agent-memory")
            .join(name),
        Scope::Local => paths
            .workspace(&params.agent_id)?
            .join(".claude/agent-memory-local")
            .join(name),
        Scope::Auto => unreachable!(),
    })
}
