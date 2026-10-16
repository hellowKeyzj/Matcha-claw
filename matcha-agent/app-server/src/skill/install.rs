use super::*;

pub(super) async fn dispatch(request: Install, config: &ConfigStore) -> rpc::Result<Value> {
    validate_scope(&request.scope)?;
    validate_name(&request.name)?;
    if !request.trust {
        return Err(Error::new(
            -32007,
            "skill_trust_required",
            "Installing skill content requires trust:true; native invocation can run hooks and shell commands",
        ));
    }
    let _mutation = MUTATIONS.lock().await;
    let root = skills_root(config, &request.scope, &request.agent_id, true)
        .await?
        .ok_or_else(|| Error::internal("skill_root_missing"))?;
    let bundle = match request.source {
        Source::Content {
            skill_md,
            resources,
        } => Bundle {
            skill_md,
            resources,
        },
        Source::Local { path } => {
            let source = PathBuf::from(&path);
            if !source.is_absolute() || path.chars().any(char::is_control) {
                return Err(Error::invalid(
                    "Local skill source must be an absolute directory path",
                ));
            }
            let metadata = fs::symlink_metadata(&source)
                .await
                .map_err(|e| storage("source_inspect", e))?;
            if is_link(&metadata) {
                return Err(unsafe_link());
            }
            let source = fs::canonicalize(source)
                .await
                .map_err(|e| storage("source_resolve", e))?;
            read_bundle(&source).await?
        }
    };
    publish(
        &root,
        &request.agent_id,
        &request.name,
        bundle,
        request.replace,
    )
    .await
}

// Caller holds MUTATIONS; staging and retired bundles stay outside native discovery.
pub(super) async fn publish(
    root: &Path,
    agent_id: &str,
    name: &str,
    bundle: Bundle,
    replace: bool,
) -> rpc::Result<Value> {
    validate_name(name)?;
    validate_bundle(&bundle)?;
    let destination = root.join(name);
    let exists = metadata_optional(&destination).await?.is_some();
    if exists {
        if !replace {
            return Err(Error::conflict(
                "skill_exists",
                "The Agent already has this skill directory",
            ));
        }
        let existing = skill_directory(root, name).await?;
        walk_files(&existing).await?;
    }
    let runtime = root
        .parent()
        .ok_or_else(|| Error::internal("skill_runtime_missing"))?;
    let staging = runtime.join(format!(".skill-install-{}", Uuid::new_v4()));
    fs::create_dir(&staging)
        .await
        .map_err(|e| storage("stage_create", e))?;
    let prepared = async {
        write_bundle(&staging, &bundle).await?;
        checked_existing(runtime, &staging).await?;
        checked_existing(runtime, root).await?;
        Ok::<_, Error>(())
    }
    .await;
    if let Err(error) = prepared {
        let cleanup = remove_tree(runtime, &staging).await;
        return Err(error.with_data(
            json!({"stage":"prepare", "cleanup":if cleanup.is_ok(){"completed"}else{"failed"}}),
        ));
    }
    let retired = runtime.join(format!(".skill-replace-{}", Uuid::new_v4()));
    if exists {
        if let Err(error) = fs::rename(&destination, &retired).await {
            let cleanup = remove_tree(runtime, &staging).await;
            return Err(storage("retire", error)
                .with_data(json!({"cleanup":if cleanup.is_ok(){"completed"}else{"failed"}})));
        }
    } else if metadata_optional(&destination).await?.is_some() {
        let cleanup = remove_tree(runtime, &staging).await;
        return Err(
            Error::conflict("skill_exists", "The skill directory already exists")
                .with_data(json!({"cleanup":if cleanup.is_ok(){"completed"}else{"failed"}})),
        );
    }
    if let Err(error) = fs::rename(&staging, &destination).await {
        let restored = !exists || fs::rename(&retired, &destination).await.is_ok();
        let cleanup = remove_tree(runtime, &staging).await;
        return Err(storage("publish", error).with_data(json!({"previousRestored":restored,"changesMayBePartial":!restored,"cleanup":if cleanup.is_ok(){"completed"}else{"failed"},"currentSessions":"notVerified"})));
    }
    let cleanup_failed = exists && remove_tree(runtime, &retired).await.is_err();
    Ok(
        json!({"skill":description(agent_id,name),"materialized":true,"replaced":exists,"cleanupFailed":cleanup_failed,"application":application()}),
    )
}
