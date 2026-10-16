use crate::{
    config::{self, ConfigStore},
    memory::files,
    rpc,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Component, Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentParams {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetPrompt {
    agent_id: String,
    system_prompt: Option<String>,
    append_system_prompt: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    #[default]
    Workspace,
    User,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::User => "user",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Instructions {
    agent_id: String,
    #[serde(default)]
    scope: Scope,
    directory: Option<String>,
    path: Option<String>,
    content: Option<String>,
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &crate::session::Sessions,
) -> rpc::Result<Value> {
    match method {
        "prompts.get" => {
            let params: AgentParams = rpc::params(params)?;
            config::validate_id(&params.agent_id)?;
            let snapshot = config.snapshot().await;
            let agent = snapshot
                .agents
                .get(&params.agent_id)
                .ok_or_else(|| rpc::Error::not_found("Agent"))?;
            Ok(prompt_value(
                &params.agent_id,
                agent.system_prompt.as_deref(),
                agent.append_system_prompt.as_deref(),
            ))
        }
        "prompts.set" => {
            if params.get("systemPrompt").is_none() || params.get("appendSystemPrompt").is_none() {
                return Err(rpc::Error::invalid(
                    "systemPrompt and appendSystemPrompt are both required; use null to clear",
                ));
            }
            let params: SetPrompt = rpc::params(params)?;
            config::validate_id(&params.agent_id)?;
            for text in [&params.system_prompt, &params.append_system_prompt]
                .into_iter()
                .flatten()
            {
                if text.is_empty() || text.contains('\0') {
                    return Err(rpc::Error::invalid(
                        "Prompt text must be nonempty without NUL; use null to clear it",
                    ));
                }
            }
            let response = prompt_value(
                &params.agent_id,
                params.system_prompt.as_deref(),
                params.append_system_prompt.as_deref(),
            );
            config
                .update(move |current| {
                    let agent = current
                        .agents
                        .get_mut(&params.agent_id)
                        .ok_or_else(|| rpc::Error::not_found("Agent"))?;
                    agent.system_prompt = params.system_prompt;
                    agent.append_system_prompt = params.append_system_prompt;
                    Ok(())
                })
                .await?;
            let mut response = response;
            response["persisted"] = json!(true);
            Ok(response)
        }
        "instructions.list" | "instructions.read" | "instructions.write" => {
            let params: Instructions = rpc::params(params)?;
            let _agent_guard =
                if method == "instructions.write" && matches!(params.scope, Scope::Workspace) {
                    config::validate_id(&params.agent_id)?;
                    Some(sessions.agent_guard(&params.agent_id).await)
                } else {
                    None
                };
            instructions(method, params, config).await
        }
        _ => Err(rpc::Error::method(method)),
    }
}

fn prompt_value(agent_id: &str, system: Option<&str>, append: Option<&str>) -> Value {
    json!({
        "agentId": agent_id,
        "systemPrompt": system,
        "appendSystemPrompt": append,
        "defaultSource": "native_builder",
        "executionProjection": "native_initialize",
        "apply": "next_session",
        "liveReload": false,
    })
}

async fn instructions(
    method: &str,
    params: Instructions,
    config: &ConfigStore,
) -> rpc::Result<Value> {
    let directory = params.directory.as_deref().unwrap_or("");
    let is_list = method == "instructions.list";
    if is_list && (params.path.is_some() || params.content.is_some())
        || !is_list && params.directory.is_some()
        || method == "instructions.read" && params.content.is_some()
    {
        return Err(rpc::Error::invalid(
            "Instruction parameters do not match the method",
        ));
    }
    files::relative(directory, true)?;
    if matches!(params.scope, Scope::User) && !directory.is_empty() {
        return Err(rpc::Error::invalid(
            "User instructions do not accept a subdirectory",
        ));
    }
    let path = if is_list {
        None
    } else {
        let path = params
            .path
            .as_deref()
            .ok_or_else(|| rpc::Error::invalid("path is required"))?;
        let relative = files::relative(path, false)?;
        if !instruction_path(&relative, params.scope) {
            return Err(rpc::Error::invalid(
                "path must name a native CLAUDE instruction or Markdown rule file",
            ));
        }
        Some(path)
    };
    let content = if method == "instructions.write" {
        Some(
            params
                .content
                .as_deref()
                .ok_or_else(|| rpc::Error::invalid("content is required"))?,
        )
    } else {
        None
    };
    let directory_root = match params.scope {
        Scope::Workspace => config.paths().workspace(&params.agent_id)?,
        Scope::User => config.paths().runtime(&params.agent_id)?,
    };
    let root = files::Root::open(config, &params.agent_id, &directory_root).await?;
    let mut response = json!({
        "agentId": params.agent_id,
        "scope": params.scope.as_str(),
        "discovery": "managed_candidates_not_loaded_cache",
        "externalIncludes": "not_followed",
        "nativeConsumption": "subject_to_native_settings_and_rule_conditions",
    });
    if is_list {
        let mut entries = Vec::new();
        let candidates: &[&str] = match params.scope {
            Scope::Workspace => &["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"],
            Scope::User => &["CLAUDE.md"],
        };
        for candidate in candidates {
            let path = under(directory, candidate);
            if let Some(entry) = root.entry(&path).await? {
                entries.push(entry);
            }
        }
        let rules = match params.scope {
            Scope::Workspace => ".claude/rules",
            Scope::User => "rules",
        };
        entries.extend(root.list(&under(directory, rules)).await?);
        entries.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        response["directory"] = json!(directory);
        response["files"] = rpc::value(entries)?;
    } else {
        let path = path.expect("validated instruction file method");
        response["path"] = json!(path);
        if let Some(content) = content {
            root.write(path, content).await?;
            response["persisted"] = json!(true);
            response["apply"] = json!("next_session");
            response["liveReload"] = json!(false);
        } else {
            response["content"] = json!(root.read(path).await?);
        }
    }
    Ok(response)
}

fn under(directory: &str, name: &str) -> String {
    if directory.is_empty() {
        name.to_owned()
    } else {
        format!("{directory}/{name}")
    }
}

fn instruction_path(path: &Path, scope: Scope) -> bool {
    match scope {
        Scope::User => {
            path == Path::new("CLAUDE.md")
                || path.starts_with("rules")
                    && path.extension().is_some_and(|extension| extension == "md")
        }
        Scope::Workspace => {
            if matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("CLAUDE.md" | "CLAUDE.local.md")
            ) {
                return true;
            }
            if path.extension().is_none_or(|extension| extension != "md") {
                return false;
            }
            let parts: Vec<_> = path.components().collect();
            parts.windows(2).any(|pair| {
                pair == [
                    Component::Normal(".claude".as_ref()),
                    Component::Normal("rules".as_ref()),
                ]
            })
        }
    }
}
