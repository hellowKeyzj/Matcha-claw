use super::{
    actor::{
        WikiShared, WikiState, embed_page, project_root, read_json, selected_project,
        write_file_with_history, write_json,
    },
    source_lifecycle::refresh_file_snapshot,
};
use crate::{
    dedup::{self, DedupMergePlan, ProjectQueue},
    domain::{
        WikiDedupDetectInput, WikiDedupDetection, WikiDedupExcludeInput, WikiDedupMergeInput,
        WikiDedupState, WikiDedupTask, WikiDedupTaskInput, WikiDedupTaskStatus, WikiFailure,
        WikiPathSelector, WikiProjectSelector, WikiWriteInput, now_ms, resolve_project_path,
        stable_content_hash,
    },
};

const EXCLUSIONS: &str = ".llm-wiki/dedup-not-duplicates.json";

async fn load_queue(
    shared: &WikiShared,
    state: &WikiState,
    project_id: Option<&str>,
) -> Result<String, WikiFailure> {
    let project = selected_project(state, project_id)?;
    let id = project.project_id().to_owned();
    let mut projects = shared.dedup.projects.lock().await;
    if !projects.contains_key(&id) {
        projects.insert(id.clone(), ProjectQueue::load(project_root(project), &id)?);
    }
    Ok(id)
}

pub(crate) async fn stage_detection(
    shared: &WikiShared,
    state: &WikiState,
    mut input: WikiDedupDetectInput,
) -> Result<dedup::DedupDetectionPlan, WikiFailure> {
    dedup::check_cancelled(&shared.dedup.shutdown)?;
    if input.task_id.trim().is_empty() {
        return Err(WikiFailure::invalid_input(
            "taskId",
            "taskId must not be empty",
        ));
    }
    let project = selected_project(state, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    input.project_id = Some(project_id.clone());
    if input
        .model_ref
        .as_deref()
        .is_none_or(|model| model.trim().is_empty())
    {
        input.model_ref = super::actor::read_source_watch_config(project_root(project))?
            .generation_model_ref()
            .map(str::to_owned);
    }
    if input.model_ref.is_none() {
        return Err(WikiFailure::invalid_input(
            "modelRef",
            "Configure the Wiki generation model before detecting duplicates",
        ));
    }
    if shared.ingest_llm.is_none() {
        return Err(WikiFailure::state("Wiki LLM is unavailable"));
    }
    let mut detections = shared
        .dedup
        .detections
        .lock()
        .expect("dedup detection lock");
    let key = (project_id.clone(), input.task_id.clone());
    if detections.len() >= 32 || detections.contains_key(&key) {
        return Err(WikiFailure::state(
            "duplicate scan task is already running or the scan queue is full",
        ));
    }
    let cancellation = shared.dedup.shutdown.child_token();
    detections.insert(key, cancellation.clone());
    Ok(dedup::DedupDetectionPlan {
        project_id,
        input,
        cancellation,
        runs: shared.dedup.clone(),
    })
}

pub(crate) async fn detect(
    shared: &WikiShared,
    state: &WikiState,
    plan: dedup::DedupDetectionPlan,
) -> Result<WikiDedupDetection, WikiFailure> {
    dedup::check_cancelled(&plan.cancellation)?;
    let project = selected_project(state, Some(&plan.project_id))?;
    let root = project_root(project);
    let llm = shared
        .ingest_llm
        .as_ref()
        .ok_or_else(|| WikiFailure::state("Wiki LLM is unavailable"))?;
    let pages = dedup::load_pages(root)?;
    let exclusions = read_json::<Vec<Vec<String>>>(root.join(EXCLUSIONS))?;
    let (embedding, credentials) = crate::search_config::embedding_execution_config(
        root,
        &state.state_root,
        &plan.project_id,
    )?;
    let groups = dedup::detect(
        &pages,
        &exclusions,
        llm,
        plan.input.model_ref.clone(),
        &shared.vector_index,
        &embedding,
        &credentials,
        &plan.cancellation,
    )
    .await?;
    dedup::check_cancelled(&plan.cancellation)?;
    Ok(WikiDedupDetection {
        project_id: plan.project_id.clone(),
        groups,
    })
}

pub(crate) async fn enqueue(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupMergeInput,
    task_id: String,
) -> Result<WikiDedupTaskInput, WikiFailure> {
    dedup::check_cancelled(&shared.dedup.shutdown)?;
    dedup::validate_group(&input.group, &input.canonical_slug)?;
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    let mut projects = shared.dedup.projects.lock().await;
    let queue = projects.get_mut(&project_id).expect("loaded dedup queue");
    let key = dedup::group_key(&input.group.slugs);
    let id = if let Some(task) = queue
        .tasks
        .iter_mut()
        .find(|task| dedup::group_key(&task.group.slugs) == key)
    {
        task.paused = false;
        if task.status == WikiDedupTaskStatus::Failed {
            task.status = WikiDedupTaskStatus::Pending;
            task.error = None;
            task.retry_count = 0;
        }
        task.id.clone()
    } else {
        if queue.tasks.len() >= 256 {
            return Err(WikiFailure::state(
                "dedup merge queue is full; cancel or complete queued tasks",
            ));
        }
        queue.tasks.push(WikiDedupTask {
            id: task_id.clone(),
            project_id: project_id.clone(),
            group: input.group,
            canonical_slug: input.canonical_slug,
            status: WikiDedupTaskStatus::Pending,
            added_at: now_ms(),
            error: None,
            retry_count: 0,
            paused: false,
        });
        task_id
    };
    queue.save()?;
    Ok(WikiDedupTaskInput {
        project_id: Some(project_id),
        task_id: id,
    })
}

pub(crate) async fn prepare(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupTaskInput,
) -> Result<DedupMergePlan, WikiFailure> {
    dedup::check_cancelled(&shared.dedup.shutdown)?;
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    let serial = shared.dedup.serial(&project_id).await?;
    let (root, task, cancellation) = {
        let mut projects = shared.dedup.projects.lock().await;
        let queue = projects.get_mut(&project_id).expect("loaded dedup queue");
        let task = queue
            .tasks
            .iter_mut()
            .find(|task| task.id == input.task_id)
            .ok_or_else(WikiFailure::cancelled)?;
        if task.paused || task.status != WikiDedupTaskStatus::Pending {
            return Err(WikiFailure::cancelled());
        }
        let cancellation = shared.dedup.shutdown.child_token();
        task.status = WikiDedupTaskStatus::Processing;
        let task = task.clone();
        queue
            .cancellations
            .insert(task.id.clone(), cancellation.clone());
        queue.save()?;
        (queue.root.clone(), task, cancellation)
    };
    let llm = shared.ingest_llm.as_ref().ok_or_else(|| {
        WikiFailure::state("Wiki LLM is unavailable; configure a model and retry")
    })?;
    let pages = dedup::load_pages(&root)?;
    let model_ref = super::actor::read_source_watch_config(&root)?
        .generation_model_ref()
        .map(str::to_owned)
        .ok_or_else(|| {
            WikiFailure::invalid_input(
                "generationModelRef",
                "Configure the Wiki generation model before merging duplicate pages",
            )
        })?;
    let (canonical, rewrites, deleted, backup) =
        dedup::compute_merge(&pages, &task, llm, Some(model_ref), &cancellation).await?;
    dedup::check_cancelled(&cancellation)?;
    Ok(DedupMergePlan {
        project_id,
        task_id: task.id,
        root,
        canonical,
        rewrites,
        deleted,
        backup,
        cancellation,
        _serial: serial,
    })
}

pub(crate) async fn complete(
    shared: &WikiShared,
    state: &WikiState,
    plan: DedupMergePlan,
) -> Result<WikiDedupState, WikiFailure> {
    let project_id = plan.project_id.clone();
    let task_id = plan.task_id.clone();
    let mut commit_started = false;
    let result = complete_inner(shared, state, plan, &mut commit_started).await;
    if let Err(failure) = &result {
        if !commit_started {
            return result;
        }
        let mut projects = shared.dedup.projects.lock().await;
        if let Some(queue) = projects.get_mut(&project_id) {
            if let Some(task) = queue
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id && !task.paused)
            {
                task.status = WikiDedupTaskStatus::Failed;
                task.error = Some(failure_message(failure));
                task.retry_count += 1;
            }
            queue.cancellations.remove(&task_id);
            queue.save()?;
        }
    }
    result
}

async fn complete_inner(
    shared: &WikiShared,
    state: &WikiState,
    plan: DedupMergePlan,
    commit_started: &mut bool,
) -> Result<WikiDedupState, WikiFailure> {
    dedup::check_cancelled(&plan.cancellation)?;
    let project = selected_project(state, Some(&plan.project_id))?;
    if project_root(project) != plan.root {
        return Err(WikiFailure::state(
            "Wiki project was relocated during merge; retry against its new root",
        ));
    }
    // Commit revalidates every touched input. The LLM cannot overwrite intervening user edits.
    for page in &plan.backup {
        let path = resolve_project_path(&plan.root, &page.path)?;
        let current = std::fs::read_to_string(&path)
            .map_err(|error| WikiFailure::io(path.to_string_lossy(), error))?;
        if current != page.content {
            return Err(WikiFailure::state(
                "Wiki pages changed during dedup preparation; retry the merge",
            ));
        }
    }
    backup(&plan)?;
    dedup::check_cancelled(&plan.cancellation)?;
    // Non-transactional writes: preserved backups remain available after partial failure/cancellation.
    let write = |page: &dedup::Page| {
        write_file_with_history(
            state,
            WikiWriteInput {
                project_id: Some(plan.project_id.clone()),
                relative_path: page.path.clone(),
                content: page.content.clone(),
            },
            "agent",
            "dedup.merge",
        )
        .map(|_| ())
    };
    *commit_started = true;
    write(&plan.canonical)?;
    for page in plan
        .rewrites
        .iter()
        .filter(|page| page.path != "wiki/index.md")
    {
        dedup::check_cancelled(&plan.cancellation)?;
        write(page)?;
    }
    for relative in &plan.deleted {
        dedup::check_cancelled(&plan.cancellation)?;
        let path = resolve_project_path(&plan.root, relative)?;
        crate::history::record(&plan.root, relative, "baseline", "before.dedup.merge")?;
        if std::fs::remove_file(&path).is_err() {
            eprintln!(
                "[wiki:dedup] merged page deletion failed; preserved backup remains available"
            );
            continue;
        }
        refresh_file_snapshot(&plan.root, &[relative.as_str()])?;
        if crate::vector::delete_page(&plan.root, &stable_content_hash(relative.as_bytes()))
            .await
            .is_err()
        {
            eprintln!("[wiki:dedup] removed page vector cleanup failed; rebuild the vector index");
        }
    }
    for page in plan
        .rewrites
        .iter()
        .filter(|page| page.path == "wiki/index.md")
    {
        write(page)?;
    }
    let paths = std::iter::once(plan.canonical.path.as_str())
        .chain(plan.rewrites.iter().map(|page| page.path.as_str()))
        .chain(plan.deleted.iter().map(String::as_str))
        .collect::<Vec<_>>();
    refresh_file_snapshot(&plan.root, &paths)?;
    let embedding = match crate::search_config::embedding_execution_config(
        &plan.root,
        &state.state_root,
        &plan.project_id,
    ) {
        Ok((embedding, _)) => Some(embedding),
        Err(_) => {
            eprintln!("[wiki:dedup] embedding configuration unavailable; rebuild the vector index");
            None
        }
    };
    for page in std::iter::once(&plan.canonical)
        .chain(plan.rewrites.iter())
        .filter(|page| {
            page.path != "wiki/index.md"
                && page.path != "wiki/log.md"
                && page.path != "wiki/overview.md"
        })
    {
        // Invalidate old facts even when embedding is disabled or the new embedding fails.
        if crate::vector::delete_page(&plan.root, &stable_content_hash(page.path.as_bytes()))
            .await
            .is_err()
        {
            eprintln!(
                "[wiki:dedup] changed page vector invalidation failed; rebuild the vector index"
            );
        }
        if embedding.as_ref().is_some_and(|config| config.is_ready())
            && embed_page(
                shared,
                state,
                WikiPathSelector {
                    project_id: Some(plan.project_id.clone()),
                    relative_path: page.path.clone(),
                },
            )
            .await
            .is_err()
        {
            eprintln!("[wiki:dedup] changed page embedding failed; rebuild the vector index");
        }
    }
    let mut projects = shared.dedup.projects.lock().await;
    let queue = projects
        .get_mut(&plan.project_id)
        .expect("loaded dedup queue");
    queue.tasks.retain(|task| task.id != plan.task_id);
    queue.cancellations.remove(&plan.task_id);
    queue.save()?;
    Ok(WikiDedupState {
        project_id: plan.project_id,
        tasks: queue.tasks.clone(),
    })
}

fn backup(plan: &DedupMergePlan) -> Result<(), WikiFailure> {
    let dir = plan.root.join(".llm-wiki/page-history").join(format!(
        "dedup-{}-{}",
        chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3f"),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).map_err(|error| WikiFailure::io(dir.to_string_lossy(), error))?;
    for page in &plan.backup {
        let path = dir.join(page.path.replace(['/', '\\'], "_"));
        std::fs::write(&path, &page.content)
            .map_err(|error| WikiFailure::io(path.to_string_lossy(), error))?;
    }
    Ok(())
}

pub(crate) async fn fail(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupTaskInput,
    error: WikiFailure,
) -> Result<WikiDedupState, WikiFailure> {
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    let mut projects = shared.dedup.projects.lock().await;
    let queue = projects.get_mut(&project_id).expect("loaded dedup queue");
    if let Some(task) = queue.tasks.iter_mut().find(|task| task.id == input.task_id) {
        if !task.paused && task.status != WikiDedupTaskStatus::Failed {
            task.retry_count += 1;
            task.error = Some(failure_message(&error));
            task.status = if error.is_cancelled() || task.retry_count >= 3 {
                WikiDedupTaskStatus::Failed
            } else {
                WikiDedupTaskStatus::Pending
            };
        }
    }
    queue.cancellations.remove(&input.task_id);
    queue.save()?;
    Ok(WikiDedupState {
        project_id,
        tasks: queue.tasks.clone(),
    })
}

fn failure_message(error: &WikiFailure) -> String {
    match error {
        WikiFailure::Cancelled => "Merge cancelled".to_owned(),
        WikiFailure::InvalidInput {message,..} | WikiFailure::StateUnavailable {message} => message.clone(),
        WikiFailure::IndexUnavailable {..} => "Wiki files may be merged, but vector update failed; inspect the preserved backup and rebuild the index".to_owned(),
        _ => "Wiki merge could not finish; inspect the preserved backup before retrying".to_owned(),
    }
}

pub(crate) async fn state(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiProjectSelector,
) -> Result<WikiDedupState, WikiFailure> {
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    let projects = shared.dedup.projects.lock().await;
    Ok(WikiDedupState {
        tasks: projects
            .get(&project_id)
            .expect("loaded dedup queue")
            .tasks
            .clone(),
        project_id,
    })
}

pub(crate) async fn cancel(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupTaskInput,
) -> Result<WikiDedupState, WikiFailure> {
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    if let Some(cancellation) = shared
        .dedup
        .detections
        .lock()
        .expect("dedup detection lock")
        .get(&(project_id.clone(), input.task_id.clone()))
    {
        cancellation.cancel();
    }
    let mut projects = shared.dedup.projects.lock().await;
    let queue = projects.get_mut(&project_id).expect("loaded dedup queue");
    if let Some(cancellation) = queue.cancellations.remove(&input.task_id) {
        cancellation.cancel();
    }
    queue.tasks.retain(|task| task.id != input.task_id);
    queue.save()?;
    Ok(WikiDedupState {
        project_id,
        tasks: queue.tasks.clone(),
    })
}

pub(crate) async fn retry(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupTaskInput,
) -> Result<WikiDedupTaskInput, WikiFailure> {
    activate(shared, state, input, true).await
}

pub(crate) async fn resume(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupTaskInput,
) -> Result<WikiDedupTaskInput, WikiFailure> {
    activate(shared, state, input, false).await
}

async fn activate(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupTaskInput,
    retry: bool,
) -> Result<WikiDedupTaskInput, WikiFailure> {
    dedup::check_cancelled(&shared.dedup.shutdown)?;
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    let mut projects = shared.dedup.projects.lock().await;
    let queue = projects.get_mut(&project_id).expect("loaded dedup queue");
    let task = queue
        .tasks
        .iter_mut()
        .find(|task| task.id == input.task_id)
        .ok_or_else(|| WikiFailure::invalid_input("taskId", "dedup task is not in this project"))?;
    if task.status == WikiDedupTaskStatus::Processing {
        return Err(WikiFailure::state("dedup task is already processing"));
    }
    if retry {
        task.status = WikiDedupTaskStatus::Pending;
        task.retry_count = 0;
        task.error = None;
    }
    if task.status != WikiDedupTaskStatus::Pending {
        return Err(WikiFailure::state(
            "only pending dedup tasks can be resumed; retry a failed task",
        ));
    }
    task.paused = false;
    queue.save()?;
    Ok(WikiDedupTaskInput {
        project_id: Some(project_id),
        task_id: input.task_id,
    })
}

pub(crate) async fn exclude(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiDedupExcludeInput,
) -> Result<WikiDedupState, WikiFailure> {
    let project_id = load_queue(shared, state, input.project_id.as_deref()).await?;
    if input.slugs.len() < 2
        || input
            .slugs
            .iter()
            .any(|slug| slug.is_empty() || slug.contains(['/', '\\']))
    {
        return Err(WikiFailure::invalid_input(
            "slugs",
            "at least two wiki slugs are required",
        ));
    }
    let projects = shared.dedup.projects.lock().await;
    let queue = projects.get(&project_id).expect("loaded dedup queue");
    let mut exclusions = read_json::<Vec<Vec<String>>>(queue.root.join(EXCLUSIONS))?;
    let key = dedup::group_key(&input.slugs);
    if !exclusions
        .iter()
        .any(|slugs| dedup::group_key(slugs) == key)
    {
        let mut slugs = input.slugs;
        slugs.sort();
        exclusions.push(slugs);
        write_json(queue.root.join(EXCLUSIONS), &exclusions)?;
    }
    Ok(WikiDedupState {
        project_id,
        tasks: queue.tasks.clone(),
    })
}
