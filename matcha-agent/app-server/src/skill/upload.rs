use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use super::*;

const TTL_MS: u64 = 10 * 60 * 1000;
const MAX_SESSIONS: usize = 8;
const MAX_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    scope: String,
    agent_id: String,
    slug: String,
    size: u64,
    sha256: String,
    force: bool,
    trust: bool,
    idempotency_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chunk {
    scope: String,
    agent_id: String,
    upload_id: String,
    offset: u64,
    bytes_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Commit {
    scope: String,
    agent_id: String,
    upload_id: String,
    sha256: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    slug: String,
    size: u64,
    sha256: String,
    force: bool,
    idempotency_key: Option<String>,
    expires_at: u64,
    phase: String,
    result: Option<Value>,
}

pub(super) async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
) -> rpc::Result<Value> {
    // The same lock covers skill publication and upload receipts; no detached worker owns files.
    let _mutation = MUTATIONS.lock().await;
    match method {
        "skills.upload.begin" => begin(rpc::params(params)?, config).await,
        "skills.upload.chunk" => chunk(rpc::params(params)?, config).await,
        "skills.upload.commit" => commit(rpc::params(params)?, config).await,
        _ => Err(Error::method(method)),
    }
}

async fn root(config: &ConfigStore, scope: &str, agent: &str) -> rpc::Result<(PathBuf, PathBuf)> {
    let skills = skills_root(config, scope, agent, true)
        .await?
        .ok_or_else(|| Error::internal("skill_root_missing"))?;
    let runtime = skills
        .parent()
        .ok_or_else(|| Error::internal("skill_runtime_missing"))?;
    let uploads = directory_under(runtime, Path::new(".skill-uploads"), true)
        .await?
        .ok_or_else(|| Error::internal("skill_upload_root_missing"))?;
    Ok((skills, uploads))
}

async fn begin(request: Begin, config: &ConfigStore) -> rpc::Result<Value> {
    validate_name(&request.slug)?;
    validate_sha(&request.sha256)?;
    if !request.trust {
        return Err(Error::new(
            -32007,
            "skill_trust_required",
            "Skill archive installation requires trust:true",
        ));
    }
    if request.size == 0
        || request.size > archive::MAX_ARCHIVE_BYTES
        || request.idempotency_key.as_ref().is_some_and(|key| {
            key.is_empty() || key.len() > 128 || key.chars().any(char::is_control)
        })
    {
        return Err(Error::invalid(
            "Invalid skill archive size or idempotency key",
        ));
    }
    let (_, uploads) = root(config, &request.scope, &request.agent_id).await?;
    let mut entries = fs::read_dir(&uploads)
        .await
        .map_err(|e| storage("upload_list", e))?;
    let mut count = 0usize;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| storage("upload_list", e))?
    {
        let id = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::internal("skill_upload_name"))?;
        validate_upload_id(&id)?;
        let directory = checked_existing(&uploads, &entry.path()).await?;
        let state = read_state(&directory).await?;
        if state.expires_at <= rpc::now_ms() {
            remove_tree(&uploads, &directory).await?;
            continue;
        }
        count += 1;
        if request.idempotency_key.is_some() && request.idempotency_key == state.idempotency_key {
            if request.slug != state.slug
                || request.size != state.size
                || !request.sha256.eq_ignore_ascii_case(&state.sha256)
                || request.force != state.force
            {
                return Err(Error::conflict(
                    "skill_upload_idempotency_conflict",
                    "The idempotency key belongs to another archive request",
                ));
            }
            let received = if state.result.is_some() {
                state.size
            } else {
                data(&directory).await?.len() as u64
            };
            return Ok(receipt(&id, &state, received));
        }
    }
    if count >= MAX_SESSIONS {
        return Err(Error::unavailable(
            "skill_upload_capacity",
            "This Agent has too many retained archive uploads",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let directory = uploads.join(&id);
    fs::create_dir(&directory)
        .await
        .map_err(|e| storage("upload_create", e))?;
    let state = State {
        slug: request.slug,
        size: request.size,
        sha256: request.sha256.to_ascii_lowercase(),
        force: request.force,
        idempotency_key: request.idempotency_key,
        expires_at: rpc::now_ms() + TTL_MS,
        phase: "receiving".into(),
        result: None,
    };
    let prepared = async {
        atomic_write(&directory.join("archive.zip"), &[]).await?;
        save(&directory, &state).await
    }
    .await;
    if let Err(error) = prepared {
        let cleanup = remove_tree(&uploads, &directory).await;
        return Err(
            error.with_data(json!({"cleanup":if cleanup.is_ok(){"completed"}else{"failed"}}))
        );
    }
    Ok(receipt(&id, &state, 0))
}

async fn load(
    config: &ConfigStore,
    scope: &str,
    agent: &str,
    id: &str,
) -> rpc::Result<(PathBuf, PathBuf, State)> {
    validate_upload_id(id)?;
    let (skills, uploads) = root(config, scope, agent).await?;
    let directory = uploads.join(id);
    if metadata_optional(&directory).await?.is_none() {
        return Err(Error::not_found("Skill upload"));
    }
    checked_existing(&uploads, &directory).await?;
    let state = read_state(&directory).await?;
    if state.expires_at <= rpc::now_ms() {
        remove_tree(&uploads, &directory).await?;
        return Err(Error::not_found("Skill upload"));
    }
    Ok((skills, directory, state))
}

async fn chunk(request: Chunk, config: &ConfigStore) -> rpc::Result<Value> {
    if request.bytes_base64.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(Error::invalid("Skill upload chunk exceeds its limit"));
    }
    let bytes = STANDARD
        .decode(&request.bytes_base64)
        .map_err(|_| Error::invalid("Skill upload chunk is not base64"))?;
    if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
        return Err(Error::invalid("Invalid skill upload chunk size"));
    }
    let (_, directory, state) = load(
        config,
        &request.scope,
        &request.agent_id,
        &request.upload_id,
    )
    .await?;
    if state.phase != "receiving" {
        return Err(Error::conflict(
            "skill_upload_not_receiving",
            "The skill upload no longer accepts chunks",
        ));
    }
    let mut content = data(&directory).await?;
    let received = content.len() as u64;
    let end = request
        .offset
        .checked_add(bytes.len() as u64)
        .filter(|end| *end <= state.size)
        .ok_or_else(|| Error::invalid("Skill upload chunk exceeds declared archive size"))?;
    if request.offset < received {
        if end > received
            || content.get(request.offset as usize..end as usize) != Some(bytes.as_slice())
        {
            return Err(Error::conflict(
                "skill_upload_offset",
                "Chunk does not match received archive bytes",
            ));
        }
    } else if request.offset == received {
        content.extend_from_slice(&bytes);
        atomic_write(&directory.join("archive.zip"), &content).await?;
    } else {
        return Err(Error::conflict(
            "skill_upload_offset",
            "Chunk offset must equal receivedBytes",
        ));
    }
    Ok(receipt(&request.upload_id, &state, content.len() as u64))
}

async fn commit(request: Commit, config: &ConfigStore) -> rpc::Result<Value> {
    if let Some(hash) = &request.sha256 {
        validate_sha(hash)?;
    }
    let (skills, directory, mut state) = load(
        config,
        &request.scope,
        &request.agent_id,
        &request.upload_id,
    )
    .await?;
    if request
        .sha256
        .as_ref()
        .is_some_and(|hash| !hash.eq_ignore_ascii_case(&state.sha256))
    {
        return Err(Error::invalid(
            "Commit digest differs from upload declaration",
        ));
    }
    if let Some(result) = &state.result {
        return Ok(result.clone());
    }
    if state.phase != "receiving" {
        return Err(unconfirmed());
    }
    let bytes = data(&directory).await?;
    if bytes.len() as u64 != state.size || format!("{:x}", Sha256::digest(&bytes)) != state.sha256 {
        return Err(Error::invalid(
            "Skill archive size or SHA-256 does not match",
        ));
    }
    let bundle = archive::decode(bytes, &state.slug)?;
    state.phase = "committing".into();
    save(&directory, &state).await?;
    let mut result = install::publish(&skills, &request.agent_id, &state.slug, bundle, state.force)
        .await
        .map_err(|error| {
            error.with_data(json!({"uploadOutcome":"unconfirmed","changesMayBePartial":true}))
        })?;
    let progress = receipt(&request.upload_id, &state, state.size);
    if let (Some(result), Some(progress)) = (result.as_object_mut(), progress.as_object()) {
        result.extend(progress.clone());
    }
    state.phase = "committed".into();
    state.result = Some(result.clone());
    save(&directory, &state).await.map_err(|_| unconfirmed())?;
    // Receipt survives response loss; payload is no longer needed after durable publication.
    let cleanup_failed = match checked_file(&directory, &directory.join("archive.zip")).await {
        Ok(()) => fs::remove_file(directory.join("archive.zip"))
            .await
            .is_err(),
        Err(_) => true,
    };
    result["uploadCleanupFailed"] = json!(cleanup_failed);
    state.result = Some(result.clone());
    if save(&directory, &state).await.is_err() {
        result["uploadCleanupFailed"] = json!(true);
    }
    Ok(result)
}

async fn data(directory: &Path) -> rpc::Result<Vec<u8>> {
    let path = directory.join("archive.zip");
    checked_file(directory, &path).await?;
    if fs::metadata(&path)
        .await
        .map_err(|e| storage("upload_inspect", e))?
        .len()
        > archive::MAX_ARCHIVE_BYTES
    {
        return Err(Error::invalid("Skill archive exceeds upload limit"));
    }
    fs::read(path).await.map_err(|e| storage("upload_read", e))
}

async fn read_state(directory: &Path) -> rpc::Result<State> {
    let path = directory.join("state.json");
    checked_file(directory, &path).await?;
    if fs::metadata(&path)
        .await
        .map_err(|e| storage("upload_state_inspect", e))?
        .len()
        > 16 * 1024
    {
        return Err(Error::internal("skill_upload_state_size"));
    }
    serde_json::from_slice(
        &fs::read(path)
            .await
            .map_err(|e| storage("upload_state_read", e))?,
    )
    .map_err(|_| Error::internal("skill_upload_state_decode"))
}

async fn save(directory: &Path, state: &State) -> rpc::Result<()> {
    let bytes =
        serde_json::to_vec(state).map_err(|_| Error::internal("skill_upload_state_encode"))?;
    atomic_write(&directory.join("state.json"), &bytes).await
}

fn receipt(id: &str, state: &State, received: u64) -> Value {
    json!({"uploadId":id,"receivedBytes":received,"expiresAt":state.expires_at,"sha256":state.sha256})
}

fn validate_sha(hash: &str) -> rpc::Result<()> {
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(Error::invalid(
            "Skill archive SHA-256 must contain 64 hexadecimal digits",
        ))
    }
}

fn validate_upload_id(id: &str) -> rpc::Result<()> {
    if Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        Err(Error::invalid("Invalid skill upload id"))
    }
}

fn unconfirmed() -> Error {
    Error::new(-32005, "skill_upload_commit_unconfirmed", "Archive publication was interrupted; inspect skills.list/get before starting another installation").with_data(json!({"changesMayBePartial":true,"currentSessions":"notVerified"}))
}
