use crate::{
    config::{ConfigStore, validate_id},
    rpc,
    session::Sessions,
    workspace,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Source,
    Run,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: String,
    kind: Kind,
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    agent_id: String,
    kind: Kind,
    session_id: Option<String>,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    schema_version: u64,
    run: Value,
}

#[derive(Deserialize)]
struct DirectoryEntry {
    name: String,
    kind: String,
}

#[derive(Deserialize)]
struct DirectoryEntries {
    entries: Vec<DirectoryEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

const EXTENSIONS: [&str; 3] = [".ts", ".js", ".mjs"];

pub fn capabilities() -> Value {
    json!({
        "methods": ["workflows.list", "workflows.get", "workflows.capabilities"],
        "kinds": {
            "source": {"source": "agent.workspace/.claude/workflows/<name>.ts|js|mjs", "execution": false},
            "run": {"source": "agent.workspace/.claude/workflow-runs/<id>/{state.json,journal.jsonl,script.js}"}
        },
        "readOnly": true, "nativeAvailability": "unverified",
        "limitations": [
            "WORKFLOW_SCRIPTS构建feature及当前工具可用性未由initialize响应证明。",
            "只观察当前Agent workspace中原生source/state/journal与实际SDK工作流任务，不重写Workflow engine。",
            "原生journal记录Agent调用结果而非完整运行终态；缺state.json不表示运行成功、失败或仍活动。",
            "journal resume不是任意执行点pause/resume，也不承诺外部副作用exactly-once。",
            "resumeFromRunId可能与新task_id不同，不凭相同名称或时间猜测映射。",
            "没有确定性外部create/start/update/delete/resume入口，不用prompt伪造。",
            "不扫描任意scriptPath或workspace外项目根；仅返回指定Agent受控目录的实际资料。"
        ]
    })
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    let (agent_id, kind, session_id, id) = match method {
        "workflows.capabilities" => {
            let _: Empty = rpc::params(params)?;
            return Ok(capabilities());
        }
        "workflows.list" => {
            let params: ListParams = rpc::params(params)?;
            (params.agent_id, params.kind, params.session_id, None)
        }
        "workflows.get" => {
            let params: GetParams = rpc::params(params)?;
            validate_component(&params.id)?;
            (
                params.agent_id,
                params.kind,
                params.session_id,
                Some(params.id),
            )
        }
        _ => return Err(rpc::Error::method(method)),
    };
    validate_id(&agent_id)?;
    if !config.snapshot().await.agents.contains_key(&agent_id) {
        return Err(rpc::Error::not_found("Agent"));
    }
    let native = observation(sessions, &agent_id, session_id.as_deref()).await?;
    let directory = match kind {
        Kind::Source => ".claude/workflows",
        Kind::Run => ".claude/workflow-runs",
    };
    let entries = entries(config, &agent_id, directory).await?;
    let mut response = json!({
        "agentId": agent_id, "kind": match kind {Kind::Source => "source", Kind::Run => "run"},
        "availability": if entries.is_some() {"observed"} else {"absent"}, "readOnly": true,
        "nativeAvailability": "unverified", "nativeObservation": native
    });
    let entries = entries.unwrap_or_default();
    match kind {
        Kind::Source => {
            let sources = sources(entries)?;
            if let Some(id) = id {
                let extension = sources
                    .get(&id)
                    .ok_or_else(|| rpc::Error::not_found("Named workflow source"))?;
                let filename = format!("{id}{extension}");
                let bytes =
                    workspace::read_file(config, &agent_id, &format!("{directory}/{filename}"))
                        .await?;
                let source = String::from_utf8(bytes).map_err(|_| native_invalid())?;
                response["workflow"] = json!({"id": id, "file": filename, "source": source});
            } else {
                response["workflows"] = Value::Array(
                    sources
                        .into_iter()
                        .map(
                            |(id, extension)| json!({"file": format!("{id}{extension}"), "id": id}),
                        )
                        .collect(),
                );
            }
        }
        Kind::Run => {
            if let Some(id) = id {
                response["workflow"] = read_run(config, &agent_id, &id, true)
                    .await?
                    .ok_or_else(|| rpc::Error::not_found("Native workflow run"))?;
            } else {
                let mut runs = Vec::new();
                for entry in entries
                    .into_iter()
                    .filter(|entry| entry.kind == "directory")
                {
                    validate_component(&entry.name).map_err(|_| native_invalid())?;
                    if let Some(run) = read_run(config, &agent_id, &entry.name, false).await? {
                        runs.push(run);
                    }
                }
                response["workflows"] = Value::Array(runs);
            }
        }
    }
    Ok(response)
}

async fn observation(
    sessions: &Sessions,
    agent_id: &str,
    session_id: Option<&str>,
) -> rpc::Result<Value> {
    let Some(session_id) = session_id else {
        return Ok(Value::Null);
    };
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| rpc::Error::invalid("sessionId must be a UUID"))?;
    let snapshot = sessions.native_snapshot(session_id).await?;
    if snapshot["agentId"].as_str() != Some(agent_id)
        || snapshot["sessionId"].as_str() != Some(session_id)
    {
        return Err(rpc::Error::not_found("Agent session"));
    }
    let tasks = snapshot["tasks"].as_array().ok_or_else(native_invalid)?;
    let tasks: Vec<_> = tasks
        .iter()
        .filter(|task| task["task_type"] == "local_workflow")
        .map(|task| json!({"id": task["task_id"], "native": task}))
        .collect();
    Ok(json!({
        "sessionId": session_id, "instanceId": snapshot["instanceId"],
        "initializeObserved": !snapshot["initialize"].is_null(), "workflowTools": "unverified", "tasks": tasks
    }))
}

fn sources(entries: Vec<DirectoryEntry>) -> rpc::Result<BTreeMap<String, &'static str>> {
    let mut sources = BTreeMap::new();
    // Native resolver prefers .ts, then .js, then .mjs for the same name.
    for extension in EXTENSIONS {
        for entry in entries.iter().filter(|entry| entry.kind == "file") {
            if let Some(name) = entry.name.strip_suffix(extension) {
                validate_component(name).map_err(|_| native_invalid())?;
                sources.entry(name.to_owned()).or_insert(extension);
            }
        }
    }
    Ok(sources)
}

async fn read_run(
    config: &ConfigStore,
    agent_id: &str,
    id: &str,
    detail: bool,
) -> rpc::Result<Option<Value>> {
    let directory = format!(".claude/workflow-runs/{id}");
    if entries(config, agent_id, &directory).await?.is_none() {
        return Ok(None);
    }
    let state = if let Some(bytes) =
        read_optional(config, agent_id, &format!("{directory}/state.json")).await?
    {
        let state: StateFile = serde_json::from_slice(&bytes).map_err(|_| native_invalid())?;
        if state.schema_version != 1
            || state.run["runId"].as_str() != Some(id)
            || !matches!(
                state.run["status"].as_str(),
                Some("running" | "completed" | "failed" | "killed")
            )
            || !state.run["workflowName"].is_string()
        {
            return Err(native_invalid());
        }
        Some(state.run)
    } else {
        None
    };
    let journal = if let Some(bytes) =
        read_optional(config, agent_id, &format!("{directory}/journal.jsonl")).await?
    {
        let text = String::from_utf8(bytes).map_err(|_| native_invalid())?;
        let mut entries = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let entry: Value = serde_json::from_str(line).map_err(|_| native_invalid())?;
            let key = entry["key"].as_str().ok_or_else(native_invalid)?;
            if key.len() != 64
                || !key.bytes().all(|c| c.is_ascii_hexdigit())
                || entry.get("seq").is_some_and(|seq| !seq.is_u64())
                || !matches!(
                    entry["result"]["kind"].as_str(),
                    Some("ok" | "skipped" | "dead")
                )
            {
                return Err(native_invalid());
            }
            if entry["result"]["kind"] == "ok"
                && (entry["result"].get("output").is_none()
                    || entry["result"]["usage"]["outputTokens"].as_u64().is_none())
            {
                return Err(native_invalid());
            }
            entries.push(entry);
        }
        // Native journal reader gives old entries without seq a sorting value of zero.
        entries.sort_by_key(|entry| entry["seq"].as_u64().unwrap_or(0));
        Some(entries)
    } else {
        None
    };
    let script = read_optional(config, agent_id, &format!("{directory}/script.js")).await?;
    if state.is_none() && journal.is_none() && script.is_none() {
        return Ok(None);
    }
    let mut run = json!({
        "id": id, "state": state,
        "journal": {"availability": if journal.is_some() {"observed"} else {"absent"}, "entryCount": journal.as_ref().map(Vec::len)},
        "inlineSource": if script.is_some() {"observed"} else {"absent"}
    });
    if detail {
        run["journal"]["entries"] = json!(journal);
        if let Some(bytes) = script {
            run["source"] = Value::String(String::from_utf8(bytes).map_err(|_| native_invalid())?);
        }
    }
    Ok(Some(run))
}

async fn entries(
    config: &ConfigStore,
    agent_id: &str,
    path: &str,
) -> rpc::Result<Option<Vec<DirectoryEntry>>> {
    let value = match workspace::dispatch(
        "workspace.list",
        json!({"agentId": agent_id, "path": path}),
        config,
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error.code == -32001 => return Ok(None),
        Err(error) => return Err(error),
    };
    let entries: DirectoryEntries = serde_json::from_value(value).map_err(|_| native_invalid())?;
    if entries.entries.iter().any(|entry| entry.kind == "symlink") {
        return Err(rpc::Error::unavailable(
            "workflow_path_escape",
            "Native workflow entries must not traverse symbolic links or reparse points",
        ));
    }
    Ok(Some(entries.entries))
}

async fn read_optional(
    config: &ConfigStore,
    agent_id: &str,
    path: &str,
) -> rpc::Result<Option<Vec<u8>>> {
    match workspace::read_file(config, agent_id, path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.code == -32001 => Ok(None),
        Err(error) => Err(error),
    }
}

fn validate_component(id: &str) -> rpc::Result<()> {
    if id.is_empty()
        || matches!(id, "." | "..")
        || id.ends_with(['.', ' '])
        || id.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(rpc::Error::invalid(
            "id must be a native resource name, not a path",
        ));
    }
    Ok(())
}

fn native_invalid() -> rpc::Error {
    rpc::Error::unavailable(
        "workflow_native_schema",
        "Native workflow data does not match its resource identity or supported schema",
    )
}
