use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata},
    io::{self, BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
};

use chrono::DateTime;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{config::validate_id, persistence::Database, rpc};

pub(super) async fn locate(
    runtime: &Path,
    workspace: &Path,
    session_id: &str,
) -> rpc::Result<Option<PathBuf>> {
    super::validate_uuid(session_id)?;
    let runtime = runtime.to_owned();
    let workspace = workspace.to_owned();
    let session_id = session_id.to_owned();
    tokio::task::spawn_blocking(move || {
        Ok(locate_sync(&runtime, &workspace, &session_id)?.map(|(path, _, _)| path))
    })
    .await
    .map_err(|error| rpc::Error::internal("history_locate_task").with_source(error))?
}

pub(super) async fn read_all(
    runtime: &Path,
    workspace: &Path,
    session_id: &str,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> rpc::Result<Vec<Value>> {
    super::validate_uuid(session_id)?;
    let runtime = runtime.to_owned();
    let workspace = workspace.to_owned();
    let session_id = session_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let Some((_, transcript, chain)) = locate_sync(&runtime, &workspace, &session_id)? else {
            return Ok(Vec::new());
        };
        Ok(chain
            .into_iter()
            .map(|index| transcript.messages[index].value.clone())
            .collect())
    })
    .await
    .map_err(|error| rpc::Error::internal("history_read_task").with_source(error))?
}

pub(super) async fn read(
    database: &Database,
    runtime: &Path,
    workspace: &Path,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> rpc::Result<Value> {
    super::validate_uuid(session_id)?;
    let runtime = runtime.to_owned();
    let workspace = workspace.to_owned();
    let session_id = session_id.to_owned();
    let mut page = tokio::task::spawn_blocking(move || -> rpc::Result<Value> {
        let Some((_, transcript, chain)) = locate_sync(&runtime, &workspace, &session_id)? else {
            return Ok(json!({ "messages": [], "total": 0, "nextOffset": null }));
        };
        let total = chain.len();
        let start = offset.min(total);
        let end = start.saturating_add(limit).min(total);
        let messages: Vec<_> = chain[start..end]
            .iter()
            .map(|&index| &transcript.messages[index].value)
            .collect();
        Ok(json!({
            "messages": messages,
            "total": total,
            "nextOffset": (end < total).then_some(end),
        }))
    })
    .await
    .map_err(|error| rpc::Error::internal("history_read_task").with_source(error))??;
    let candidates = page["messages"]
        .as_array()
        .expect("history page messages")
        .iter()
        .filter(|message| message["type"] == "user" && message["isSidechain"] != true)
        .filter_map(|message| message["uuid"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    page["managedInputMessageIds"] =
        json!(super::record::managed_input_message_ids(database, candidates).await?);
    Ok(page)
}

fn locate_sync(
    runtime: &Path,
    workspace: &Path,
    session_id: &str,
) -> rpc::Result<Option<(PathBuf, Transcript, Vec<usize>)>> {
    let Some((runtime, workspace)) = locations(runtime, workspace)? else {
        return Ok(None);
    };
    let Some(projects) = checked(&runtime, Path::new("projects"))? else {
        return Ok(None);
    };
    let entries =
        fs::read_dir(&projects).map_err(|error| io_error("history_projects_read", error))?;
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(|error| io_error("history_project_entry", error))?;
        let Some(project) = checked(&projects, Path::new(&entry.file_name()))? else {
            continue;
        };
        let metadata =
            fs::metadata(&project).map_err(|error| io_error("history_project_metadata", error))?;
        if !metadata.is_dir() {
            continue;
        }
        let Some(path) = checked(&project, Path::new(&format!("{session_id}.jsonl")))? else {
            continue;
        };
        let metadata =
            fs::metadata(&path).map_err(|error| io_error("history_source_metadata", error))?;
        if !metadata.is_file() {
            return Err(path_error());
        }
        if metadata.len() == 0 {
            continue;
        }
        if found.replace(path).is_some() {
            return Err(rpc::Error::conflict(
                "history_source_ambiguous",
                "Multiple native transcripts have this session identity",
            ));
        }
    }
    let Some(path) = found else {
        return Ok(None);
    };
    let transcript = load(&path)?;
    let chain = transcript.chain(session_id, &workspace)?;
    if chain.is_empty() {
        return Err(rpc::Error::unavailable(
            "history_chain_absent",
            "The native transcript has no conversation chain",
        ));
    }
    Ok(Some((path, transcript, chain)))
}

pub(super) async fn delete(runtime: &Path, workspace: &Path, session_id: &str) -> rpc::Result<()> {
    super::validate_uuid(session_id)?;
    let runtime = runtime.to_owned();
    let workspace = workspace.to_owned();
    let session_id = session_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let Some((runtime, workspace)) = locations(&runtime, &workspace)? else {
            return Ok(());
        };
        let artifacts = artifacts(&runtime, &session_id)?;
        for path in &artifacts {
            if path
                .file_name()
                .is_some_and(|name| name == format!("{session_id}.jsonl").as_str())
            {
                let metadata = fs::metadata(path)
                    .map_err(|error| io_error("history_source_metadata", error))?;
                if !metadata.is_file() {
                    return Err(path_error());
                }
                if metadata.len() != 0 {
                    load(path)?.chain(&session_id, &workspace)?;
                }
            }
        }
        // Validate every tree before unlinking anything. Never traverse a native
        // symlink/reparse point or broaden deletion to its project/workspace.
        for path in &artifacts {
            validate_tree(path)?;
        }
        for path in artifacts {
            remove_tree(&path)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| rpc::Error::internal("history_delete_task").with_source(error))?
}

pub(super) async fn assert_absent(
    runtime: &Path,
    workspace: &Path,
    session_id: &str,
) -> rpc::Result<()> {
    super::validate_uuid(session_id)?;
    let runtime = runtime.to_owned();
    let workspace = workspace.to_owned();
    let session_id = session_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let Some((runtime, _)) = locations(&runtime, &workspace)? else { return Ok(()); };
        if !artifacts(&runtime, &session_id)?.is_empty() {
            return Err(rpc::Error::conflict(
                "retire_native_artifacts_present",
                "Native session artifacts exist without a managed session record; cleanup custody is not established",
            ));
        }
        Ok(())
    }).await.map_err(|error| rpc::Error::internal("history_absence_task").with_source(error))?
}

fn artifacts(runtime: &Path, session_id: &str) -> rpc::Result<Vec<PathBuf>> {
    let mut artifacts = Vec::new();
    if let Some(projects) = checked(runtime, Path::new("projects"))? {
        for entry in
            fs::read_dir(&projects).map_err(|error| io_error("history_projects_read", error))?
        {
            let entry = entry.map_err(|error| io_error("history_project_entry", error))?;
            let Some(project) = checked(&projects, Path::new(&entry.file_name()))? else {
                continue;
            };
            if !fs::metadata(&project)
                .map_err(|error| io_error("history_project_metadata", error))?
                .is_dir()
            {
                continue;
            }
            if let Some(path) = checked(&project, Path::new(&format!("{session_id}.jsonl")))? {
                artifacts.push(path);
            }
            if let Some(path) = checked(&project, Path::new(session_id))? {
                artifacts.push(path);
            }
        }
    }
    for directory in ["file-history", "session-env"] {
        if let Some(path) = checked(runtime, &Path::new(directory).join(session_id))? {
            artifacts.push(path);
        }
    }
    Ok(artifacts)
}

fn validate_tree(path: &Path) -> rpc::Result<()> {
    let root = path.parent().ok_or_else(path_error)?;
    let Some(path) = checked(root, Path::new(path.file_name().ok_or_else(path_error)?))? else {
        return Ok(());
    };
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| io_error("history_delete_metadata", error))?;
    if metadata.is_dir() {
        for entry in
            fs::read_dir(&path).map_err(|error| io_error("history_delete_directory", error))?
        {
            let entry = entry.map_err(|error| io_error("history_delete_entry", error))?;
            validate_tree(&entry.path())?;
        }
    } else if !metadata.is_file() {
        return Err(path_error());
    }
    Ok(())
}

fn remove_tree(path: &Path) -> rpc::Result<()> {
    let root = path.parent().ok_or_else(path_error)?;
    let Some(path) = checked(root, Path::new(path.file_name().ok_or_else(path_error)?))? else {
        return Ok(());
    };
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| io_error("history_delete_metadata", error))?;
    if metadata.is_dir() {
        for entry in
            fs::read_dir(&path).map_err(|error| io_error("history_delete_directory", error))?
        {
            let entry = entry.map_err(|error| io_error("history_delete_entry", error))?;
            remove_tree(&entry.path())?;
        }
        fs::remove_dir(&path).map_err(|error| io_error("history_delete_directory", error))
    } else if metadata.is_file() {
        fs::remove_file(&path).map_err(|error| io_error("history_delete_file", error))
    } else {
        Err(path_error())
    }
}

// The configured home is trusted; every component below it must stay at its assigned location.
fn locations(runtime: &Path, workspace: &Path) -> rpc::Result<Option<(PathBuf, PathBuf)>> {
    let agent = runtime.parent().ok_or_else(path_error)?;
    let agents = agent.parent().ok_or_else(path_error)?;
    let home = agents.parent().ok_or_else(path_error)?;
    if !runtime.is_absolute()
        || runtime.file_name().is_none_or(|name| name != "runtime")
        || workspace != agent.join("workspace")
        || agents.file_name().is_none_or(|name| name != "agents")
    {
        return Err(path_error());
    }
    let agent_id = agent
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(path_error)?;
    validate_id(agent_id).map_err(|_| path_error())?;
    let home = fs::canonicalize(home).map_err(|error| io_error("history_home_resolve", error))?;
    let Some(agent) = checked(&home, &Path::new("agents").join(agent_id))? else {
        return Ok(None);
    };
    let Some(runtime) = checked(&agent, Path::new("runtime"))? else {
        return Ok(None);
    };
    let workspace = checked(&agent, Path::new("workspace"))?
        .ok_or_else(|| rpc::Error::not_found("Agent workspace"))?;
    Ok(Some((runtime, workspace)))
}

fn checked(root: &Path, relative: &Path) -> rpc::Result<Option<PathBuf>> {
    let mut path = root.to_owned();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(path_error());
        };
        path.push(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error("history_path_metadata", error)),
        };
        if redirects(&metadata) {
            return Err(path_error());
        }
        let actual =
            fs::canonicalize(&path).map_err(|error| io_error("history_path_resolve", error))?;
        if actual != path {
            return Err(path_error());
        }
        path = actual;
    }
    Ok(Some(path))
}

fn redirects(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn validate_cwd(cwd: &str, workspace: &Path) -> rpc::Result<()> {
    // Native Windows cwd can be unprefixed while canonicalize returns a verbatim path.
    #[cfg(windows)]
    let (cwd, workspace) = (
        unprefixed(cwd),
        unprefixed(workspace.to_str().ok_or_else(path_error)?),
    );
    #[cfg(not(windows))]
    let (cwd, workspace) = (PathBuf::from(cwd), workspace.to_owned());
    let cwd = cwd.as_path();
    if !cwd.is_absolute()
        || cwd
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(cwd_error());
    }
    let mut parts = cwd.components();
    for expected in workspace.components() {
        let Some(actual) = parts.next() else {
            return Err(cwd_error());
        };
        #[cfg(windows)]
        let equal = actual
            .as_os_str()
            .to_str()
            .zip(expected.as_os_str().to_str())
            .is_some_and(|(actual, expected)| actual.eq_ignore_ascii_case(expected));
        #[cfg(not(windows))]
        let equal = actual == expected;
        if !equal {
            return Err(cwd_error());
        }
    }
    let relative: PathBuf = parts.collect();
    let canonical = fs::canonicalize(&workspace)
        .map_err(|error| io_error("history_workspace_resolve", error))?;
    if checked(&canonical, &relative)?.is_none() {
        return Err(cwd_error());
    }
    Ok(())
}

#[cfg(windows)]
fn unprefixed(path: &str) -> PathBuf {
    PathBuf::from(if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    uuid: String,
    #[serde(default)]
    parent_uuid: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
    session_id: String,
    timestamp: String,
    cwd: String,
}

struct Message {
    header: Header,
    time: i64,
    value: Value,
}

impl Message {
    fn set_parent(&mut self, parent: Option<String>) {
        self.value["parentUuid"] = json!(parent);
        self.header.parent_uuid = parent;
    }

    fn assistant_id(&self) -> Option<&str> {
        (self.value["type"] == "assistant")
            .then(|| self.value["message"]["id"].as_str())
            .flatten()
            .filter(|id| !id.is_empty())
    }

    fn is_user_assistant(&self) -> bool {
        matches!(self.value["type"].as_str(), Some("user" | "assistant"))
    }
}

#[derive(Default)]
struct Transcript {
    messages: Vec<Message>,
    by_uuid: HashMap<String, usize>,
}

impl Transcript {
    fn parent(&self, index: usize) -> Option<usize> {
        self.messages[index]
            .header
            .parent_uuid
            .as_ref()
            .and_then(|uuid| self.by_uuid.get(uuid).copied())
    }

    fn reindex(&mut self) {
        self.by_uuid = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.header.uuid.clone(), index))
            .collect();
    }

    fn chain(&self, session_id: &str, workspace: &Path) -> rpc::Result<Vec<usize>> {
        let parents: HashSet<_> = self
            .messages
            .iter()
            .filter_map(|message| message.header.parent_uuid.as_deref())
            .collect();
        let mut leaves = HashSet::new();
        for (index, message) in self.messages.iter().enumerate() {
            if parents.contains(message.header.uuid.as_str()) {
                continue;
            }
            let mut current = Some(index);
            let mut seen = HashSet::new();
            while let Some(index) = current {
                if !seen.insert(index) {
                    return Err(cycle_error());
                }
                if self.messages[index].is_user_assistant() {
                    leaves.insert(index);
                    break;
                }
                current = self.parent(index);
            }
        }
        let mut latest = None;
        let mut latest_time = 0;
        for (index, message) in self.messages.iter().enumerate() {
            if !message.header.is_sidechain && leaves.contains(&index) && message.time > latest_time
            {
                latest = Some(index);
                latest_time = message.time;
            }
        }
        let Some(tip) = latest else {
            if self.messages.is_empty() {
                return Ok(Vec::new());
            }
            return Err(rpc::Error::unavailable(
                "history_chain_absent",
                "The native transcript has no valid non-sidechain conversation leaf",
            ));
        };
        // Fork roots may retain the source sessionId; the native leaf owns identity.
        if self.messages[tip].header.session_id != session_id {
            return Err(rpc::Error::conflict(
                "history_session_mismatch",
                "The native transcript belongs to another session identity",
            ));
        }
        validate_cwd(&self.messages[tip].header.cwd, workspace)?;
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut current = Some(tip);
        while let Some(index) = current {
            if !seen.insert(index) {
                return Err(cycle_error());
            }
            chain.push(index);
            current = self.parent(index);
        }
        chain.reverse();
        Ok(self.recover_parallel(chain, seen))
    }

    fn recover_parallel(&self, chain: Vec<usize>, mut seen: HashSet<usize>) -> Vec<usize> {
        let mut anchors = HashMap::new();
        for &index in &chain {
            if let Some(id) = self.messages[index].assistant_id() {
                anchors.insert(id, index);
            }
        }
        if anchors.is_empty() {
            return chain;
        }
        let mut siblings: HashMap<&str, Vec<usize>> = HashMap::new();
        let mut results: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, message) in self.messages.iter().enumerate() {
            if let Some(id) = message.assistant_id() {
                siblings.entry(id).or_default().push(index);
            } else if message.value["type"] == "user"
                && message.value["message"]["content"]
                    .as_array()
                    .is_some_and(|content| {
                        content.iter().any(|block| block["type"] == "tool_result")
                    })
                && let Some(parent) = message.header.parent_uuid.as_deref()
            {
                results.entry(parent).or_default().push(index);
            }
        }
        let mut processed = HashSet::new();
        let mut inserts = HashMap::new();
        for &index in &chain {
            let Some(id) = self.messages[index].assistant_id() else {
                continue;
            };
            if !processed.insert(id) {
                continue;
            }
            let group = &siblings[id];
            let mut orphaned_siblings: Vec<_> = group
                .iter()
                .copied()
                .filter(|index| !seen.contains(index))
                .collect();
            let mut orphaned_results = Vec::new();
            for &member in group {
                if let Some(results) = results.get(self.messages[member].header.uuid.as_str()) {
                    orphaned_results.extend(
                        results
                            .iter()
                            .copied()
                            .filter(|index| !seen.contains(index)),
                    );
                }
            }
            orphaned_siblings.sort_by(|&left, &right| {
                self.messages[left]
                    .header
                    .timestamp
                    .cmp(&self.messages[right].header.timestamp)
            });
            orphaned_results.sort_by(|&left, &right| {
                self.messages[left]
                    .header
                    .timestamp
                    .cmp(&self.messages[right].header.timestamp)
            });
            orphaned_siblings.extend(orphaned_results);
            seen.extend(orphaned_siblings.iter().copied());
            inserts.insert(anchors[id], orphaned_siblings);
        }
        let mut result = Vec::with_capacity(seen.len());
        for index in chain {
            result.push(index);
            if let Some(recovered) = inserts.remove(&index) {
                result.extend(recovered);
            }
        }
        result
    }
}

fn load(path: &Path) -> rpc::Result<Transcript> {
    let file = File::open(path).map_err(|error| io_error("history_source_open", error))?;
    let before = file
        .metadata()
        .map_err(|error| io_error("history_source_metadata", error))?;
    if !before.is_file() {
        return Err(path_error());
    }
    let modified = before
        .modified()
        .map_err(|error| io_error("history_source_timestamp", error))?;
    let mut reader = BufReader::new((&file).take(before.len()));
    let mut line = Vec::new();
    let mut transcript = Transcript::default();
    let mut progress: HashMap<String, Option<String>> = HashMap::new();
    let mut first_parse_error = None;
    loop {
        line.clear();
        if reader
            .read_until(b'\n', &mut line)
            .map_err(|error| io_error("history_source_read", error))?
            == 0
        {
            break;
        }
        let bytes = line.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&line);
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut value: Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            // Native JSONL recovery skips malformed lines, including an unfinished tail.
            Err(error) => {
                first_parse_error.get_or_insert(error);
                continue;
            }
        };
        let kind = value["type"].as_str().unwrap_or_default();
        if kind == "progress" {
            if let Some(uuid) = value["uuid"].as_str() {
                let parent = value["parentUuid"].as_str().map(str::to_owned);
                let parent = parent
                    .as_ref()
                    .and_then(|uuid| progress.get(uuid))
                    .cloned()
                    .unwrap_or(parent);
                progress.insert(uuid.to_owned(), parent);
            }
            continue;
        }
        if !matches!(kind, "user" | "assistant" | "system" | "attachment") {
            continue;
        }
        if let Some(parent) = value["parentUuid"]
            .as_str()
            .and_then(|uuid| progress.get(uuid))
        {
            value["parentUuid"] = json!(parent);
        }
        let header =
            Header::deserialize(&value).map_err(|error| schema_error().with_source(error))?;
        for id in [&header.uuid, &header.session_id]
            .into_iter()
            .chain(header.parent_uuid.iter())
        {
            uuid::Uuid::parse_str(id).map_err(|error| schema_error().with_source(error))?;
        }
        let time = DateTime::parse_from_rfc3339(&header.timestamp)
            .map_err(|error| {
                rpc::Error::unavailable(
                    "history_timestamp",
                    "The native transcript timestamp is invalid",
                )
                .with_source(error)
            })?
            .timestamp_millis();
        let index = transcript
            .by_uuid
            .entry(header.uuid.clone())
            .or_insert(transcript.messages.len());
        let message = Message {
            header,
            time,
            value,
        };
        // JavaScript Map.set is last-wins without changing the UUID's insertion order.
        if *index == transcript.messages.len() {
            transcript.messages.push(message);
        } else {
            transcript.messages[*index] = message;
        }
    }
    let remaining = reader.into_inner().limit();
    let after = file
        .metadata()
        .map_err(|error| io_error("history_source_metadata", error))?;
    if remaining != 0
        || before.len() != after.len()
        || modified
            != after
                .modified()
                .map_err(|error| io_error("history_source_timestamp", error))?
    {
        return Err(rpc::Error::conflict(
            "history_source_changed",
            "The native transcript changed while reading; retry the request",
        ));
    }
    if transcript.messages.is_empty()
        && let Some(error) = first_parse_error
    {
        return Err(rpc::Error::unavailable(
            "history_jsonl_invalid",
            "The native transcript has no readable messages",
        )
        .with_source(error));
    }
    apply_preserved_segments(&mut transcript)?;
    apply_snips(&mut transcript)?;
    Ok(transcript)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreservedSegment {
    head_uuid: String,
    tail_uuid: String,
    anchor_uuid: String,
}

fn apply_preserved_segments(transcript: &mut Transcript) -> rpc::Result<()> {
    let mut boundary = None;
    let mut segment = None;
    for (index, message) in transcript.messages.iter().enumerate() {
        if message.value["type"] == "system" && message.value["subtype"] == "compact_boundary" {
            boundary = Some(index);
            if let Some(value) = message.value["compactMetadata"]
                .get("preservedSegment")
                .filter(|value| !value.is_null())
            {
                let value: PreservedSegment = serde_json::from_value(value.clone())
                    .map_err(|error| schema_error().with_source(error))?;
                segment = Some((index, value));
            }
        }
    }
    let Some((segment_index, segment)) = segment else {
        return Ok(());
    };
    let boundary = boundary.expect("a preserved segment belongs to a compact boundary");
    let mut preserved = HashSet::new();
    if segment_index == boundary {
        let mut current = transcript.by_uuid.get(&segment.tail_uuid).copied();
        let mut reached_head = false;
        while let Some(index) = current {
            if !preserved.insert(index) {
                break;
            }
            if transcript.messages[index].header.uuid == segment.head_uuid {
                reached_head = true;
                break;
            }
            current = transcript.parent(index);
        }
        // Native recovery leaves the full map untouched when the preserved walk is broken.
        if !reached_head {
            return Ok(());
        }
        if let Some(&head) = transcript.by_uuid.get(&segment.head_uuid) {
            transcript.messages[head].set_parent(Some(segment.anchor_uuid.clone()));
        }
        for (index, message) in transcript.messages.iter_mut().enumerate() {
            if message.header.parent_uuid.as_ref() == Some(&segment.anchor_uuid)
                && message.header.uuid != segment.head_uuid
            {
                message.set_parent(Some(segment.tail_uuid.clone()));
            }
            if preserved.contains(&index) && message.value["type"] == "assistant" {
                let native = message.value["message"]
                    .as_object_mut()
                    .ok_or_else(schema_error)?;
                let usage = native.entry("usage").or_insert_with(|| json!({}));
                if usage.is_null() {
                    *usage = json!({});
                }
                let usage = usage.as_object_mut().ok_or_else(schema_error)?;
                for key in [
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                ] {
                    usage.insert(key.to_owned(), json!(0));
                }
            }
        }
    }
    let mut index = 0;
    transcript.messages.retain(|_| {
        let keep = index >= boundary || preserved.contains(&index);
        index += 1;
        keep
    });
    transcript.reindex();
    Ok(())
}

fn apply_snips(transcript: &mut Transcript) -> rpc::Result<()> {
    let mut removed = HashSet::new();
    for message in &transcript.messages {
        if let Some(uuids) = message.value["snipMetadata"].get("removedUuids") {
            let uuids: Vec<String> = serde_json::from_value(uuids.clone())
                .map_err(|error| schema_error().with_source(error))?;
            removed.extend(uuids);
        }
    }
    if removed.is_empty() {
        return Ok(());
    }
    let mut parents: HashMap<_, _> = transcript
        .messages
        .iter()
        .filter(|message| removed.contains(&message.header.uuid))
        .map(|message| {
            (
                message.header.uuid.clone(),
                message.header.parent_uuid.clone(),
            )
        })
        .collect();
    transcript
        .messages
        .retain(|message| !removed.contains(&message.header.uuid));
    transcript.reindex();
    for message in &mut transcript.messages {
        if !message
            .header
            .parent_uuid
            .as_ref()
            .is_some_and(|parent| removed.contains(parent))
        {
            continue;
        }
        let mut current = message.header.parent_uuid.clone();
        let mut path = HashSet::new();
        while let Some(uuid) = current.as_ref().filter(|uuid| removed.contains(*uuid)) {
            if !path.insert(uuid.clone()) {
                return Err(cycle_error());
            }
            current = parents.get(uuid).cloned().flatten();
        }
        for uuid in path {
            parents.insert(uuid, current.clone());
        }
        message.set_parent(current);
    }
    Ok(())
}

fn path_error() -> rpc::Error {
    rpc::Error::unavailable(
        "history_path_escape",
        "The native transcript path redirects or is outside its Agent location",
    )
}

fn cwd_error() -> rpc::Error {
    rpc::Error::conflict(
        "history_workspace_mismatch",
        "The native transcript cwd does not resolve inside this Agent workspace",
    )
}

fn schema_error() -> rpc::Error {
    rpc::Error::unavailable(
        "history_native_schema",
        "The native transcript does not match its supported schema",
    )
}

fn cycle_error() -> rpc::Error {
    rpc::Error::unavailable(
        "history_parent_cycle",
        "The native transcript contains a parent chain cycle",
    )
}

fn io_error(kind: &str, error: io::Error) -> rpc::Error {
    rpc::Error::new(-32005, kind, "Native session history could not be read")
        .with_data(json!({ "ioKind": format!("{:?}", error.kind()) }))
        .with_source(error)
}
