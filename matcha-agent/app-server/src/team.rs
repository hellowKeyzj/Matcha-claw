use crate::{
    config::{ConfigStore, validate_id},
    rpc,
    session::Sessions,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: String,
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    agent_id: String,
    session_id: Option<String>,
    id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Roster {
    name: String,
    description: Option<String>,
    created_at: u64,
    lead_agent_id: String,
    lead_session_id: Option<String>,
    members: Vec<Member>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    agent_id: String,
    name: String,
    agent_type: Option<String>,
    model: Option<String>,
    color: Option<String>,
    joined_at: u64,
    session_id: Option<String>,
    backend_type: Option<String>,
    is_active: Option<bool>,
    mode: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Mail {
    from: String,
    text: String,
    timestamp: String,
    read: bool,
    color: Option<String>,
    summary: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub fn capabilities() -> Value {
    json!({
        "methods": ["teams.list", "teams.get", "teams.capabilities"],
        "source": "agent.runtime/teams/<id>/config.json and native member mailboxes",
        "readOnly": true,
        "nativeAvailability": "unverified",
        "limitations": [
            "原生Team来自roster与mailbox，不是Server顶层会话池。",
            "roster.isActive是原生记录，不证明成员进程当前存活；邮箱查询不标记已读。",
            "CLI initialize响应不能证明Team工具、feature gate或执行backend可用。",
            "Agent私有runtime逐层校验静态路径隔离，不承诺抵抗可信本机用户并发替换目录。",
            "没有确定性外部Team create/delete/member CRUD/send入口，不用prompt冒充，也不改原生ownership。",
            "只读返回已记录的成员身份，不公开成员prompt、cwd、worktree路径或权限路径。"
        ]
    })
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    let (agent_id, session_id, id) = match method {
        "teams.capabilities" => {
            let _: Empty = rpc::params(params)?;
            return Ok(capabilities());
        }
        "teams.list" => {
            let params: ListParams = rpc::params(params)?;
            (params.agent_id, params.session_id, None)
        }
        "teams.get" => {
            let params: GetParams = rpc::params(params)?;
            validate_id(&params.id)?;
            (params.agent_id, params.session_id, Some(params.id))
        }
        _ => return Err(rpc::Error::method(method)),
    };
    validate_id(&agent_id)?;
    if !config.snapshot().await.agents.contains_key(&agent_id) {
        return Err(rpc::Error::not_found("Agent"));
    }
    let observation = observation(sessions, &agent_id, session_id.as_deref()).await?;
    let runtime = config.paths().runtime(&agent_id)?;
    let relative = runtime
        .strip_prefix(config.paths().root())
        .map_err(|_| rpc::Error::internal("team_runtime_mapping"))?
        .to_owned();
    let teams = relative.join("teams");
    let root = config.paths().root();
    if let Some(id) = id {
        let roster = read_roster(root, &teams, &id)
            .await?
            .ok_or_else(|| rpc::Error::not_found("Native Team"))?;
        let mut mailboxes = Vec::new();
        let inboxes = teams.join(mailbox_name(&roster.name)).join("inboxes");
        for member in &roster.members {
            let path = inboxes.join(format!("{}.json", mailbox_name(&member.name)));
            let messages = match checked(root, &path).await? {
                Some(path) => {
                    // Native mailbox reader's own file ceiling, not a Server resource quota.
                    let length = tokio::fs::metadata(&path)
                        .await
                        .map_err(|error| io_error("team_mailbox_stat", error))?
                        .len();
                    if length > 4 * 1024 * 1024 {
                        return Err(rpc::Error::unavailable(
                            "team_mailbox_size",
                            "The native mailbox exceeds its reader's 4 MiB file limit",
                        ));
                    }
                    let bytes = tokio::fs::read(path)
                        .await
                        .map_err(|error| io_error("team_mailbox_read", error))?;
                    Some(
                        serde_json::from_slice::<Vec<Mail>>(&bytes)
                            .map_err(|_| native_invalid())?,
                    )
                }
                None => None,
            };
            mailboxes.push(json!({
                "memberId": member.agent_id, "memberName": member.name,
                "availability": if messages.is_some() {"observed"} else {"absent"},
                "messages": messages
            }));
        }
        Ok(json!({
            "agentId": agent_id, "id": id, "roster": roster, "mailboxes": mailboxes,
            "nativeObservation": observation, "nativeAvailability": "unverified", "readOnly": true
        }))
    } else {
        let present = checked(root, &teams).await?.is_some();
        let mut rosters = Vec::new();
        for id in directories(root, &teams).await? {
            validate_id(&id).map_err(|_| native_invalid())?;
            if let Some(roster) = read_roster(root, &teams, &id).await? {
                rosters.push(json!({"id": id, "roster": roster}));
            }
        }
        Ok(json!({
            "agentId": agent_id, "teams": rosters, "availability": if present {"observed"} else {"absent"},
            "nativeObservation": observation, "nativeAvailability": "unverified", "readOnly": true
        }))
    }
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
    Ok(json!({
        "sessionId": session_id, "instanceId": snapshot["instanceId"],
        "initializeObserved": !snapshot["initialize"].is_null(), "teamTools": "unverified"
    }))
}

async fn read_roster(root: &Path, teams: &Path, id: &str) -> rpc::Result<Option<Roster>> {
    let Some(path) = checked(root, &teams.join(id).join("config.json")).await? else {
        return Ok(None);
    };
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| io_error("team_roster_read", error))?;
    let roster: Roster = serde_json::from_slice(&bytes).map_err(|_| native_invalid())?;
    if roster.name.is_empty()
        || roster_name(&roster.name) != id
        || roster.members.is_empty()
        || roster
            .lead_session_id
            .as_deref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(native_invalid());
    }
    let mut ids = BTreeSet::new();
    let mut inbox_ids = BTreeSet::new();
    for member in &roster.members {
        if member.name.is_empty()
            || member.name.contains('@')
            || member.agent_id != format!("{}@{}", member.name, roster.name)
            || !ids.insert(&member.agent_id)
            || !inbox_ids.insert(mailbox_name(&member.name))
            || member
                .session_id
                .as_deref()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(native_invalid());
        }
    }
    if !ids.contains(&roster.lead_agent_id) {
        return Err(native_invalid());
    }
    Ok(Some(roster))
}

// teamHelpers.sanitizeName and tasks.sanitizePathComponent deliberately differ.
fn roster_name(name: &str) -> String {
    // Native JavaScript regexes replace UTF-16 code units, including each surrogate.
    name.encode_utf16()
        .map(|unit| match unit {
            48..=57 | 65..=90 | 97..=122 => char::from(unit as u8).to_ascii_lowercase(),
            _ => '-',
        })
        .collect()
}

fn mailbox_name(name: &str) -> String {
    name.encode_utf16()
        .map(|unit| match unit {
            45 | 48..=57 | 65..=90 | 95 | 97..=122 => char::from(unit as u8),
            _ => '-',
        })
        .collect()
}

async fn checked(root: &Path, relative: &Path) -> rpc::Result<Option<PathBuf>> {
    let mut path = match tokio::fs::canonicalize(root).await {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error("team_root_resolve", error)),
    };
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(native_invalid());
        };
        let expected = path.join(name);
        let actual = match tokio::fs::canonicalize(&expected).await {
            Ok(path) => path,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error("team_path_resolve", error)),
        };
        if actual != expected {
            return Err(rpc::Error::unavailable(
                "team_path_escape",
                "The native Team path redirects outside its assigned location",
            ));
        }
        path = actual;
    }
    Ok(Some(path))
}

async fn directories(root: &Path, relative: &Path) -> rpc::Result<Vec<String>> {
    let Some(path) = checked(root, relative).await? else {
        return Ok(Vec::new());
    };
    let mut entries = tokio::fs::read_dir(path)
        .await
        .map_err(|error| io_error("team_directory_read", error))?;
    let mut names = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| io_error("team_directory_read", error))?
    {
        let kind = entry
            .file_type()
            .await
            .map_err(|error| io_error("team_entry_read", error))?;
        if kind.is_symlink() {
            return Err(rpc::Error::unavailable(
                "team_path_escape",
                "A native Team entry redirects its assigned location",
            ));
        }
        if kind.is_dir() {
            names.push(
                entry
                    .file_name()
                    .into_string()
                    .map_err(|_| native_invalid())?,
            );
        }
    }
    names.sort();
    Ok(names)
}

fn native_invalid() -> rpc::Error {
    rpc::Error::unavailable(
        "team_native_schema",
        "Native Team data does not match its roster identity or supported schema",
    )
}

fn io_error(kind: &str, error: std::io::Error) -> rpc::Error {
    rpc::Error::new(-32005, kind, "Native Team data could not be read")
        .with_data(json!({"ioKind": format!("{:?}", error.kind())}))
}
