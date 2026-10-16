use crate::{
    config::{AgentConfig, DEFAULT_AGENT_ID, Paths},
    persistence::atomic_write,
    rpc,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io,
    path::{Path, PathBuf},
};
use tokio::fs;

const CUSTODY: &str = ".matcha-agent-custody";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Custody {
    agent_id: String,
    #[serde(deserialize_with = "required_owner")]
    owner: Option<String>,
    token: String,
}

fn required_owner<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::deserialize(deserializer)
}

pub(super) async fn prepare_default(paths: &Paths, agent: &AgentConfig) -> rpc::Result<()> {
    let parent = paths.root().join("agents");
    match fs::create_dir(&parent).await {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(storage(error, "agentParent")),
    }
    checked_directory(&parent).await?;
    let mut entries = fs::read_dir(&parent)
        .await
        .map_err(|error| storage(error, "inspectParent"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| storage(error, "inspectParent"))?
    {
        if let Some(name) = entry.file_name().to_str()
            && name != DEFAULT_AGENT_ID
            && name.eq_ignore_ascii_case(DEFAULT_AGENT_ID)
        {
            return Err(rpc::Error::conflict(
                "agent_id_case_conflict",
                "A case alias of the default Agent directory already exists",
            ));
        }
    }
    let root = paths.agent_dir(DEFAULT_AGENT_ID)?;
    if agent.custody.is_some() {
        check_custody(
            paths,
            DEFAULT_AGENT_ID,
            agent.custody.as_deref(),
            agent.owner.as_deref(),
        )
        .await?;
    } else {
        match fs::create_dir(&root).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(storage(error, "agent")),
        }
        checked_directory(&root).await?;
        match fs::symlink_metadata(root.join(CUSTODY)).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage(error, "custody")),
            Ok(_) => {
                return Err(rpc::Error::conflict(
                    "agent_custody_changed",
                    "The default Agent directory already has managed custody",
                ));
            }
        }
    }
    for (role, path) in [
        ("workspace", paths.workspace(DEFAULT_AGENT_ID)?),
        ("runtime", paths.runtime(DEFAULT_AGENT_ID)?),
        ("state", paths.state(DEFAULT_AGENT_ID)?),
    ] {
        match fs::create_dir(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(storage(error, role)),
        }
        checked_directory(&path).await?;
    }
    Ok(())
}

pub(super) async fn create(
    paths: &Paths,
    agent_id: &str,
    token: &str,
    owner: Option<&str>,
) -> rpc::Result<Vec<(&'static str, PathBuf)>> {
    let parent = paths.root().join("agents");
    match fs::create_dir(&parent).await {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(storage(error, "agentParent")),
    }
    checked_directory(&parent).await?;
    let root = paths.agent_dir(agent_id)?;
    fs::create_dir(&root).await.map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            rpc::Error::conflict("agent_data_exists", "Agent data already exists; choose another Agent ID or explicitly relocate retained data")
        } else { storage(error, "agent") }
    })?;
    let mut created = vec![("agent", root.clone())];
    let result = async {
        let marker = Custody {
            agent_id: agent_id.to_owned(),
            owner: owner.map(str::to_owned),
            token: token.to_owned(),
        };
        let bytes = serde_json::to_vec(&marker)
            .map_err(|error| rpc::Error::internal("agent_custody_encode").with_source(error))?;
        atomic_write(&root.join(CUSTODY), &bytes).await?;
        for (role, path) in [
            ("workspace", paths.workspace(agent_id)?),
            ("runtime", paths.runtime(agent_id)?),
            ("state", paths.state(agent_id)?),
        ] {
            fs::create_dir(&path)
                .await
                .map_err(|error| storage(error, role))?;
            created.push((role, path));
        }
        Ok::<(), rpc::Error>(())
    }
    .await;
    if let Err(error) = result {
        let failures = rollback(&created, agent_id, token, owner).await;
        return Err(error.with_data(json!({
            "agentId": agent_id, "configurationEffect": "unchanged",
            "cleanup": if failures.is_empty() { "complete" } else { "incomplete" },
            "cleanupFailures": failures,
        })));
    }
    Ok(created)
}

pub(super) async fn rollback(
    created: &[(&str, PathBuf)],
    agent_id: &str,
    token: &str,
    owner: Option<&str>,
) -> Vec<Value> {
    let mut failures = Vec::new();
    // Never recurse during compensation: another writer may have populated a directory.
    for (role, path) in created.iter().skip(1).rev() {
        if let Err(error) = fs::remove_dir(path).await
            && error.kind() != io::ErrorKind::NotFound
        {
            failures.push(json!({"directory":role, "ioKind":format!("{:?}",error.kind())}));
        }
    }
    if !failures.is_empty() {
        return failures;
    }
    let Some((_, root)) = created.first() else {
        return failures;
    };
    let result = async {
        checked_directory(root).await?;
        let mut entries = fs::read_dir(root)
            .await
            .map_err(|error| storage(error, "rollbackInspect"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| storage(error, "rollbackInspect"))?
        {
            if entry.file_name() != CUSTODY {
                return Err(rpc::Error::conflict(
                    "agent_data_exists",
                    "Agent data was retained during compensation",
                ));
            }
        }
        match fs::symlink_metadata(root.join(CUSTODY)).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage(error, "custody")),
            Ok(_) => {
                let marker = read_marker(root).await?;
                check_marker(&marker, agent_id, token, owner)?;
                fs::remove_file(root.join(CUSTODY))
                    .await
                    .map_err(|error| storage(error, "rollbackCustody"))?;
            }
        }
        fs::remove_dir(root)
            .await
            .map_err(|error| storage(error, "rollbackRoot"))
    }
    .await;
    if let Err(error) = result {
        failures.push(json!({"directory":"agent", "code":error.code, "detail":error.data}));
    }
    failures
}

pub(super) async fn root_absent(paths: &Paths, agent_id: &str) -> rpc::Result<bool> {
    let parent = paths.root().join("agents");
    match fs::symlink_metadata(&parent).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(storage(error, "inspectParent")),
        Ok(_) => checked_directory(&parent).await?,
    }
    let root = paths.agent_dir(agent_id)?;
    match fs::symlink_metadata(&root).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(storage(error, "inspect")),
        Ok(_) => {
            checked_directory(&root).await?;
            Ok(false)
        }
    }
}

pub(super) async fn orphan_custody(
    paths: &Paths,
    agent_id: &str,
    owner: &str,
) -> rpc::Result<Option<String>> {
    if root_absent(paths, agent_id).await? {
        return Ok(None);
    }
    let root = paths.agent_dir(agent_id)?;
    let marker = read_marker(&root).await?;
    if marker.agent_id != agent_id || marker.owner.as_deref() != Some(owner) {
        return Err(rpc::Error::conflict(
            "agent_custody_changed",
            "The Agent directory belongs to another owner",
        ));
    }
    check_custody(paths, agent_id, Some(&marker.token), Some(owner)).await?;
    Ok(Some(marker.token))
}

async fn read_marker(root: &Path) -> rpc::Result<Custody> {
    let path = root.join(CUSTODY);
    let metadata = fs::symlink_metadata(&path).await.map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            rpc::Error::new(
                -32006,
                "agent_custody_unknown",
                "The Agent directory has no provable managed custody",
            )
            .with_data(json!({"cleanupComplete":false}))
        } else {
            storage(error, "custody")
        }
    })?;
    if linked(&metadata) || !metadata.is_file() {
        return Err(rpc::Error::new(
            -32007,
            "agent_data_not_owned",
            "The Agent custody marker must be a regular file",
        ));
    }
    let bytes = fs::read(path)
        .await
        .map_err(|error| storage(error, "custody"))?;
    let marker: Custody = serde_json::from_slice(&bytes).map_err(|error| {
        rpc::Error::new(
            -32007,
            "agent_data_not_owned",
            "The Agent custody marker is invalid",
        )
        .with_source(error)
    })?;
    if marker.token.is_empty() || marker.token.contains('\0') {
        return Err(rpc::Error::new(
            -32007,
            "agent_data_not_owned",
            "The Agent custody token is invalid",
        ));
    }
    Ok(marker)
}

fn check_marker(
    marker: &Custody,
    agent_id: &str,
    token: &str,
    owner: Option<&str>,
) -> rpc::Result<()> {
    if marker.agent_id != agent_id || marker.token != token || marker.owner.as_deref() != owner {
        return Err(rpc::Error::new(
            -32007,
            "agent_data_not_owned",
            "The Agent directory custody could not be verified",
        ));
    }
    Ok(())
}

pub(super) async fn check_custody(
    paths: &Paths,
    agent_id: &str,
    token: Option<&str>,
    owner: Option<&str>,
) -> rpc::Result<PathBuf> {
    let token = token.ok_or_else(|| {
        rpc::Error::new(
            -32007,
            "agent_data_not_owned",
            "Deleting Agent data requires native managed custody",
        )
    })?;
    checked_directory(&paths.root().join("agents")).await?;
    let root = paths.agent_dir(agent_id)?;
    checked_directory(&root).await?;
    check_marker(&read_marker(&root).await?, agent_id, token, owner)?;
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(directory)
            .await
            .map_err(|error| storage(error, "inspect"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| storage(error, "inspect"))?
        {
            let metadata = fs::symlink_metadata(entry.path())
                .await
                .map_err(|error| storage(error, "inspect"))?;
            if linked(&metadata) || !metadata.is_dir() && !metadata.is_file() {
                return Err(rpc::Error::new(
                    -32007,
                    "agent_data_link_rejected",
                    "Agent deletion cannot traverse links, reparse points or special files",
                ));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(root)
}

pub(super) async fn remove(
    paths: &Paths,
    agent_id: &str,
    token: &str,
    owner: Option<&str>,
) -> rpc::Result<()> {
    if root_absent(paths, agent_id).await? {
        return Ok(());
    }
    let root = paths.agent_dir(agent_id)?;
    let marker = root.join(CUSTODY);
    match fs::symlink_metadata(&marker).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Only an empty root is safe after a crash between marker and directory removal.
            return fs::remove_dir(root)
                .await
                .map_err(|error| storage(error, "deleteEmpty"));
        }
        Err(error) => return Err(storage(error, "custody")),
        Ok(_) => {
            check_custody(paths, agent_id, Some(token), owner).await?;
        }
    }
    let mut entries = fs::read_dir(&root)
        .await
        .map_err(|error| storage(error, "inspect"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| storage(error, "inspect"))?
    {
        if entry.file_name() == CUSTODY {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .await
            .map_err(|error| storage(error, "inspect"))?;
        if linked(&metadata) || !metadata.is_dir() && !metadata.is_file() {
            return Err(rpc::Error::new(
                -32007,
                "agent_data_link_rejected",
                "Agent deletion cannot traverse links or special files",
            ));
        }
        if metadata.is_dir() {
            fs::remove_dir_all(entry.path()).await
        } else {
            fs::remove_file(entry.path()).await
        }
        .map_err(|error| storage(error, "delete"))?;
    }
    // Keep custody through partial purge failures; remove it only after every data child.
    fs::remove_file(marker)
        .await
        .map_err(|error| storage(error, "deleteCustody"))?;
    fs::remove_dir(root)
        .await
        .map_err(|error| storage(error, "delete"))
}

async fn checked_directory(path: &Path) -> rpc::Result<()> {
    let metadata = fs::symlink_metadata(path)
        .await
        .map_err(|error| storage(error, "inspect"))?;
    if linked(&metadata) || !metadata.is_dir() {
        return Err(rpc::Error::new(
            -32007,
            "agent_directory_rejected",
            "Agent directories must not be links or reparse points",
        ));
    }
    Ok(())
}

fn linked(metadata: &std::fs::Metadata) -> bool {
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

fn storage(error: io::Error, phase: &str) -> rpc::Error {
    rpc::Error::new(-32005, "agent_storage", "Agent filesystem operation failed")
        .with_data(json!({"phase":phase,"ioKind":format!("{:?}",error.kind())}))
        .with_source(error)
}
