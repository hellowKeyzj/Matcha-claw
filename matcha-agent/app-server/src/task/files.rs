use std::{
    fs::{self, File, Metadata},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{rpc, session::NativeFiles};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Context {
    pub list_id: String,
    pub todo_v2: bool,
}

impl Context {
    pub(super) fn parse(value: Value) -> rpc::Result<Self> {
        let context: Self = serde_json::from_value(value)
            .map_err(|error| super::native_invalid().with_source(error))?;
        if !safe_component(&context.list_id) {
            return Err(super::native_invalid());
        }
        Ok(context)
    }
}

pub(super) fn context(files: &NativeFiles) -> rpc::Result<Option<Context>> {
    let Some(root) = runtime(files)? else {
        return Ok(None);
    };
    let relative = Path::new("session-env")
        .join(&files.session_id)
        .join("task-context.json");
    let Some(path) = checked(&root, &relative)? else {
        return Ok(None);
    };
    Context::parse(read_json(&path)?.0).map(Some)
}

pub(super) fn tasks(files: &NativeFiles, list_id: &str, id: Option<&str>) -> rpc::Result<Value> {
    let root = ensure_runtime(files)?;
    let tasks = ensure_directory(&root, "tasks")?;
    let directory = ensure_directory(&tasks, list_id)?;
    let lock = super::lock::Lock::acquire(&directory)?;
    let result = read_list(&directory, id);
    // Verify and release even when parsing fails; a compromised lease is never an empty list.
    lock.release()?;
    result
}

fn read_list(directory: &Path, id: Option<&str>) -> rpc::Result<Value> {
    let before = entries(directory)?;
    let selected = if let Some(id) = id {
        vec![format!("{id}.json")]
    } else {
        before.clone()
    };
    let mut tasks = Vec::with_capacity(selected.len());
    let mut stamps = Vec::with_capacity(selected.len());
    for name in selected {
        let id = name.strip_suffix(".json").expect("native task file suffix");
        if !safe_component(id) {
            return Err(super::native_invalid());
        }
        let Some(path) = checked(directory, Path::new(&name))? else {
            return Err(if before.contains(&name) {
                changed()
            } else {
                rpc::Error::not_found("Native task")
            });
        };
        let (value, stamp) = read_json(&path)?;
        let mut task = task(value, id)?;
        task["createdAt"] = json!(timestamp(
            stamp
                .created()
                .map_err(|error| io_error("task_io", error))?
        )?);
        task["updatedAt"] = json!(timestamp(
            stamp
                .modified()
                .map_err(|error| io_error("task_io", error))?
        )?);
        tasks.push(task);
        stamps.push((path, stamp));
    }
    if entries(directory)? != before {
        return Err(changed());
    }
    for (path, before) in stamps {
        let after = metadata(&path)?.ok_or_else(changed)?;
        if !same(&before, &after)? {
            return Err(changed());
        }
    }
    Ok(if id.is_some() {
        json!({"task": tasks.pop().expect("requested task")})
    } else {
        json!({"tasks": tasks})
    })
}

fn task(value: Value, id: &str) -> rpc::Result<Value> {
    let object = value.as_object().ok_or_else(super::native_invalid)?;
    let mut result = Map::new();
    for key in ["id", "subject", "description", "status"] {
        let value = object
            .get(key)
            .filter(|value| value.is_string())
            .ok_or_else(super::native_invalid)?;
        result.insert(key.into(), value.clone());
    }
    if result["id"] != id
        || !matches!(
            result["status"].as_str(),
            Some("pending" | "in_progress" | "completed")
        )
    {
        return Err(super::native_invalid());
    }
    for key in ["activeForm", "owner", "metadata"] {
        if let Some(value) = object.get(key) {
            if if key == "metadata" {
                !value.is_object()
            } else {
                !value.is_string()
            } {
                return Err(super::native_invalid());
            }
            result.insert(key.into(), value.clone());
        }
    }
    for key in ["blocks", "blockedBy"] {
        let value = object
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(super::native_invalid)?;
        if !value
            .iter()
            .all(|id| id.as_str().is_some_and(safe_component))
        {
            return Err(super::native_invalid());
        }
        result.insert(key.into(), json!(value));
    }
    Ok(Value::Object(result))
}

fn entries(directory: &Path) -> rpc::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| io_error("task_io", error))? {
        let name = entry
            .map_err(|error| io_error("task_io", error))?
            .file_name()
            .into_string()
            .map_err(|_| super::native_invalid())?;
        if name.ends_with(".json") && !name.starts_with('.') {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn read_json(path: &Path) -> rpc::Result<(Value, Metadata)> {
    let expected = metadata(path)?.ok_or_else(changed)?;
    let mut file = File::open(path).map_err(|error| io_error("task_io", error))?;
    let before = file
        .metadata()
        .map_err(|error| io_error("task_io", error))?;
    if !before.is_file() || redirects(&before) {
        return Err(super::native_invalid());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error("task_io", error))?;
    let after = file
        .metadata()
        .map_err(|error| io_error("task_io", error))?;
    if !same(&expected, &before)?
        || !same(&before, &after)?
        || !same(&before, &metadata(path)?.ok_or_else(changed)?)?
        || before.len() != bytes.len() as u64
    {
        return Err(changed());
    }
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| super::native_invalid().with_source(error))?;
    Ok((value, before))
}

fn same(before: &Metadata, after: &Metadata) -> rpc::Result<bool> {
    Ok(before.len() == after.len()
        && before
            .modified()
            .map_err(|error| io_error("task_io", error))?
            == after
                .modified()
                .map_err(|error| io_error("task_io", error))?
        && before
            .created()
            .map_err(|error| io_error("task_io", error))?
            == after
                .created()
                .map_err(|error| io_error("task_io", error))?)
}

fn timestamp(time: SystemTime) -> rpc::Result<u64> {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if millis > 9_007_199_254_740_991 {
        return Err(super::native_invalid());
    }
    Ok(millis as u64)
}

fn runtime(files: &NativeFiles) -> rpc::Result<Option<PathBuf>> {
    let agent = files.runtime.parent().ok_or_else(super::native_invalid)?;
    let agents = agent.parent().ok_or_else(super::native_invalid)?;
    let home = agents.parent().ok_or_else(super::native_invalid)?;
    if files.runtime != agent.join("runtime")
        || files.workspace != agent.join("workspace")
        || agent
            .file_name()
            .is_none_or(|name| name != files.agent_id.as_str())
        || agents.file_name().is_none_or(|name| name != "agents")
    {
        return Err(super::native_invalid());
    }
    let home = fs::canonicalize(home).map_err(|error| io_error("task_io", error))?;
    checked(
        &home,
        &Path::new("agents").join(&files.agent_id).join("runtime"),
    )
}

fn ensure_runtime(files: &NativeFiles) -> rpc::Result<PathBuf> {
    if let Some(root) = runtime(files)? {
        return Ok(root);
    }
    let agent = files.runtime.parent().ok_or_else(super::native_invalid)?;
    let home = agent
        .parent()
        .and_then(Path::parent)
        .ok_or_else(super::native_invalid)?;
    let home = fs::canonicalize(home).map_err(|error| io_error("task_io", error))?;
    let agents = ensure_directory(&home, "agents")?;
    let agent = ensure_directory(&agents, &files.agent_id)?;
    ensure_directory(&agent, "runtime")
}

fn ensure_directory(root: &Path, name: &str) -> rpc::Result<PathBuf> {
    if !safe_component(name) {
        return Err(super::native_invalid());
    }
    let path = root.join(name);
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io_error("task_io", error)),
    }
    checked(root, Path::new(name))?.ok_or_else(changed)
}

fn checked(root: &Path, relative: &Path) -> rpc::Result<Option<PathBuf>> {
    let mut path = root.to_owned();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(super::native_invalid());
        };
        path.push(name);
        let Some(_) = metadata(&path)? else {
            return Ok(None);
        };
        let actual = fs::canonicalize(&path).map_err(|error| io_error("task_io", error))?;
        if actual != path {
            return Err(super::native_invalid());
        }
        path = actual;
    }
    Ok(Some(path))
}

pub(super) fn metadata(path: &Path) -> rpc::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if redirects(&metadata) => Err(super::native_invalid()),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("task_io", error)),
    }
}

pub(super) fn redirects(metadata: &Metadata) -> bool {
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

pub(super) fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(super) fn io_error(kind: &str, error: io::Error) -> rpc::Error {
    rpc::Error::new(-32005, kind, "Native task files could not be read")
        .with_data(json!({"ioKind": format!("{:?}", error.kind())}))
        .with_source(error)
}

fn changed() -> rpc::Error {
    rpc::Error::conflict(
        "task_lock_conflict",
        "The native task files changed while holding the list lock; retry the request",
    )
}
