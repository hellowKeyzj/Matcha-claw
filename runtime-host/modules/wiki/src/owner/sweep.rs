use super::{
    actor::{WikiShared, WikiState, project_root, read_source_watch_config, selected_project},
    review_lifecycle::{resolve_pending_reviews, reviews},
    source_lifecycle::{source_tasks, wiki_markdown_files},
};
use crate::{
    domain::{WikiFailure, WikiProjectSelector, WikiSourceTaskStatus},
    ingest::write::parse_frontmatter_scalar,
    sweep::{PageSummary, ReviewSweepPlan, SourceWork, resolved_by_rules},
};

pub(super) fn begin(
    shared: &WikiShared,
    state: &WikiState,
    project_id: String,
) -> Result<SourceWork, WikiFailure> {
    selected_project(state, Some(&project_id))?;
    shared.review_sweeps.begin(project_id)
}

pub(super) fn stage(
    shared: &WikiShared,
    state: &WikiState,
    project_id: String,
) -> Result<Option<ReviewSweepPlan>, WikiFailure> {
    let project = selected_project(state, Some(&project_id))?;
    let root = project_root(project);
    if has_pending_sources(root, &project_id)? {
        return Ok(None);
    }
    let Some(cancellation) = shared.review_sweeps.claim(&project_id) else {
        return Ok(None);
    };
    let pending = reviews(root)
        .items()
        .iter()
        .filter(|review| !review.resolved)
        .cloned()
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(None);
    }
    let mut files = wiki_markdown_files(root)?;
    files.sort();
    let mut pages = Vec::new();
    for file in files {
        let id = file
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_lowercase();
        let title = std::fs::read_to_string(&file)
            .ok()
            .and_then(|content| parse_frontmatter_scalar(&content, "title"))
            .map(|title| title.trim().to_owned())
            .filter(|title| !title.is_empty());
        pages.push(PageSummary { id, title });
    }
    if cancellation.is_cancelled() {
        return Ok(None);
    }
    let resolved = resolved_by_rules(&pending, &pages);
    resolve_pending_reviews(root, &resolved, "auto-resolved")?;
    let pending = pending
        .into_iter()
        .filter(|review| !resolved.contains(&review.id))
        .collect();
    let model_ref = read_source_watch_config(root)?
        .generation_model_ref()
        .map(str::to_owned);
    Ok(Some(ReviewSweepPlan {
        project_id,
        root: root.to_path_buf(),
        pending,
        pages,
        llm: shared.ingest_llm.clone(),
        model_ref,
        cancellation,
    }))
}

pub(super) fn complete(
    _shared: &WikiShared,
    state: &WikiState,
    plan: ReviewSweepPlan,
    resolved_ids: Vec<String>,
) -> Result<(), WikiFailure> {
    if plan.cancellation.is_cancelled() {
        return Ok(());
    }
    let project = selected_project(state, Some(&plan.project_id))?;
    let root = project_root(project);
    if root != plan.root || has_pending_sources(root, &plan.project_id)? {
        return Ok(());
    }
    let current = reviews(root);
    let ids = resolved_ids
        .into_iter()
        .filter(|id| {
            plan.pending
                .iter()
                .any(|review| review.id == *id && current.items().contains(review))
        })
        .collect::<Vec<_>>();
    if !plan.cancellation.is_cancelled() {
        resolve_pending_reviews(root, &ids, "llm-judged")?;
    }
    Ok(())
}

fn has_pending_sources(root: &std::path::Path, project_id: &str) -> Result<bool, WikiFailure> {
    Ok(source_tasks(
        root,
        WikiProjectSelector {
            project_id: Some(project_id.to_owned()),
        },
    )?
    .tasks()
    .iter()
    .any(|task| {
        matches!(
            task.status(),
            WikiSourceTaskStatus::Pending | WikiSourceTaskStatus::Running
        )
    }))
}
