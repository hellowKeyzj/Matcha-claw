use crate::{config::ConfigStore, memory::files::Root, rpc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const NAMES: &[&str] = &[
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "MEMORY.md",
    "IDENTITY.md",
    "HEARTBEAT.md",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    agent_id: String,
    name: Option<String>,
    content: Option<String>,
    expected_revision: Option<String>,
}

pub(super) fn validate(files: &BTreeMap<String, String>) -> rpc::Result<()> {
    for name in files.keys() {
        name_allowed(name)?;
    }
    Ok(())
}

fn name_allowed(name: &str) -> rpc::Result<()> {
    if !NAMES.contains(&name) {
        return Err(rpc::Error::invalid(
            "Agent files must use a supported workspace file name",
        ));
    }
    Ok(())
}

async fn root(config: &ConfigStore, agent_id: &str) -> rpc::Result<Root> {
    Root::open(config, agent_id, &config.paths().workspace(agent_id)?).await
}

async fn file(root: &Root, name: &str, content: bool) -> rpc::Result<Value> {
    let entry = root.entry(name).await?;
    let text = if entry.is_some() {
        Some(root.read(name).await?)
    } else {
        None
    };
    let revision = text
        .as_ref()
        .map(|text| format!("{:x}", Sha256::digest(text.as_bytes())))
        .unwrap_or_else(|| "missing".into());
    Ok(json!({
        "name": name, "missing": entry.is_none(),
        "size": entry.as_ref().map(|entry| entry.bytes),
        "updatedAtMs": entry.as_ref().and_then(|entry| entry.modified_at_ms),
        "content": if content { text } else { None }, "revision":revision,
    }))
}

pub(super) async fn initialize(
    config: &ConfigStore,
    agent_id: &str,
    files: &BTreeMap<String, String>,
) -> rpc::Result<()> {
    let root = root(config, agent_id).await?;
    for (name, content) in files {
        root.write(name, content).await?;
    }
    ensure_instructions(&root).await
}

const IMPORTS: &str = "<!-- matcha:agent-files -->\n@AGENTS.md\n@SOUL.md\n@USER.md\n@MEMORY.md\n@IDENTITY.md\n<!-- /matcha:agent-files -->\n";

async fn ensure_instructions(root: &Root) -> rpc::Result<()> {
    // CLI loads CLAUDE.md, not OpenClaw's AGENTS.md. Preserve existing native instructions.
    let mut text = if root.entry("CLAUDE.md").await?.is_some() {
        root.read("CLAUDE.md").await?
    } else {
        String::new()
    };
    if !text.contains(IMPORTS) {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(IMPORTS);
        root.write("CLAUDE.md", &text).await?;
    }
    Ok(())
}

pub(super) async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
) -> rpc::Result<Value> {
    let params: Params = rpc::params(params)?;
    let root = root(config, &params.agent_id).await?;
    match method {
        "agents.files.list" => {
            if params.name.is_some()
                || params.content.is_some()
                || params.expected_revision.is_some()
            {
                return Err(rpc::Error::invalid("File listing accepts only agentId"));
            }
            let mut files = Vec::new();
            for name in &NAMES[..4] {
                files.push(file(&root, name, false).await?);
            }
            Ok(json!({"agentId": params.agent_id, "files": files}))
        }
        "agents.files.get" | "agents.files.set" => {
            let name = params
                .name
                .ok_or_else(|| rpc::Error::invalid("name is required"))?;
            name_allowed(&name)?;
            if method == "agents.files.set" {
                let latest = file(&root, &name, true).await?;
                if params
                    .expected_revision
                    .as_deref()
                    .is_some_and(|expected| latest["revision"].as_str() != Some(expected))
                {
                    return Err(rpc::Error::conflict(
                        "agent_file_revision_stale",
                        "The Agent file changed",
                    )
                    .with_data(json!({"latestView":latest})));
                }
                let content = params
                    .content
                    .ok_or_else(|| rpc::Error::invalid("content is required"))?;
                root.write(&name, &content).await?;
                ensure_instructions(&root).await.map_err(|error| {
                    error.with_data(json!({"fileWritten":true,"instructionsApplied":false}))
                })?;
            } else if params.content.is_some() || params.expected_revision.is_some() {
                return Err(rpc::Error::invalid("File reads do not accept content"));
            }
            let mut result = file(&root, &name, true).await?;
            let imports_present = root.entry("CLAUDE.md").await?.is_some()
                && root.read("CLAUDE.md").await?.contains(IMPORTS);
            result["instructions"] = json!({
                "managedImportsPresent": imports_present,
                "execution": "notObserved",
            });
            Ok(result)
        }
        _ => Err(rpc::Error::method(method)),
    }
}
