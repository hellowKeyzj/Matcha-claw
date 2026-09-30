use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use serde::{Serialize, de::DeserializeOwned};
use tokio_util::sync::CancellationToken;

use crate::{
    domain::{
        WikiFailure, WikiReviewItem, WikiReviewOption, WikiReviewType, WikiWriteReceipt,
        normalize_relative_path, resolve_project_path, stable_content_hash,
    },
    lint::{
        LintAction, LintRun, LintRunPlan, LintRuns, WikiLintActionInput, WikiLintCancelInput,
        WikiLintConfig, WikiLintConfigInput, WikiLintFinding, WikiLintFixFailure,
        WikiLintFixReceipt, WikiLintPhase, WikiLintRunInput, WikiLintState, WikiLintType,
        append_wikilink, public_failure, rewrite_wikilink_target, stub,
    },
};

const ITEMS: &str = ".llm-wiki/lint.json";
const CONFIG: &str = ".llm-wiki/lint-config.json";

fn read<T: DeserializeOwned + Default>(root: &Path, relative: &str) -> Result<T, WikiFailure> {
    match std::fs::read_to_string(root.join(relative)) {
        Ok(raw) => {
            serde_json::from_str(&raw).map_err(|_| WikiFailure::state("Wiki lint state is invalid"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(WikiFailure::io(relative, error)),
    }
}

fn persist<T: Serialize>(root: &Path, relative: &str, value: &T) -> Result<(), WikiFailure> {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|error| WikiFailure::io(relative, error))?;
    let raw = serde_json::to_vec_pretty(value)
        .map_err(|_| WikiFailure::state("Wiki lint state encode failed"))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, raw).map_err(|error| WikiFailure::io(relative, error))?;
    std::fs::rename(&temporary, &path).map_err(|error| WikiFailure::io(relative, error))
}

pub(super) fn config(root: &Path) -> Result<WikiLintConfig, WikiFailure> {
    Ok(read::<WikiLintConfig>(root, CONFIG)?.normalize())
}

pub(super) fn update_config(
    root: &Path,
    input: WikiLintConfigInput,
) -> Result<WikiLintConfig, WikiFailure> {
    let config = input.into_config();
    persist(root, CONFIG, &config)?;
    Ok(config)
}

pub(super) fn state(
    root: &Path,
    project_id: &str,
    runs: &LintRuns,
) -> Result<WikiLintState, WikiFailure> {
    if let Some(run) = runs.runs.lock().unwrap().get(project_id) {
        return Ok(run.state.clone());
    }
    Ok(WikiLintState {
        project_id: project_id.to_owned(),
        task_id: None,
        phase: WikiLintPhase::Idle,
        completed: 0,
        total: 0,
        items: read(root, ITEMS)?,
        error: None,
    })
}

pub(super) fn stage(
    root: &Path,
    project_id: &str,
    runs: &std::sync::Arc<LintRuns>,
    mut input: WikiLintRunInput,
    task_id: String,
    llm: Option<std::sync::Arc<dyn crate::ports::WikiIngestLlm>>,
) -> Result<LintRunPlan, WikiFailure> {
    if input.semantic {
        let model = input
            .model_ref
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty() && *model != "auto")
            .ok_or_else(|| {
                WikiFailure::invalid_input("modelRef", "semantic lint requires explicit modelRef")
            })?;
        input.model_ref = Some(model.to_owned());
    }
    let mut active = runs.runs.lock().unwrap();
    if active.get(project_id).is_some_and(|run| {
        matches!(
            run.state.phase,
            WikiLintPhase::Reading | WikiLintPhase::Structural | WikiLintPhase::Semantic
        )
    }) {
        return Err(WikiFailure::invalid_input(
            "projectId",
            "Wiki lint is already running",
        ));
    }
    input.config = Some(input.config.unwrap_or(config(root)?).normalize());
    let items = read(root, ITEMS)?;
    let cancellation = CancellationToken::new();
    active.insert(
        project_id.to_owned(),
        LintRun {
            state: WikiLintState {
                project_id: project_id.to_owned(),
                task_id: Some(task_id.clone()),
                phase: WikiLintPhase::Reading,
                completed: 0,
                total: 0,
                items,
                error: None,
            },
            cancellation: cancellation.clone(),
        },
    );
    Ok(LintRunPlan {
        project_id: project_id.to_owned(),
        root: root.to_path_buf(),
        input,
        task_id,
        cancellation,
        llm,
        runs: runs.clone(),
    })
}

pub(super) fn begin(root: &Path, runs: &LintRuns, plan: &LintRunPlan) -> Result<(), WikiFailure> {
    let mut active = runs.runs.lock().unwrap();
    let run = active
        .get_mut(&plan.project_id)
        .filter(|run| run.state.task_id.as_deref() == Some(&plan.task_id))
        .ok_or(WikiFailure::OwnerUnavailable)?;
    if plan.cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    persist(root, ITEMS, &Vec::<WikiLintFinding>::new())?;
    run.state.items.clear();
    Ok(())
}

pub(super) fn complete(
    root: &Path,
    runs: &LintRuns,
    plan: LintRunPlan,
    result: Result<Vec<WikiLintFinding>, WikiFailure>,
) -> Result<WikiLintState, WikiFailure> {
    let mut active = runs.runs.lock().unwrap();
    let run = active
        .get_mut(&plan.project_id)
        .filter(|run| run.state.task_id.as_deref() == Some(&plan.task_id))
        .ok_or(WikiFailure::OwnerUnavailable)?;
    match result {
        Ok(items) if !plan.cancellation.is_cancelled() => {
            if let Err(failure) = persist(root, ITEMS, &items) {
                run.state.phase = WikiLintPhase::Error;
                run.state.error = Some(public_failure(&failure));
                return Err(failure);
            }
            run.state.items = items;
            run.state.phase = WikiLintPhase::Done;
        }
        Ok(_) | Err(WikiFailure::Cancelled) => run.state.phase = WikiLintPhase::Cancelled,
        Err(failure) => {
            run.state.phase = WikiLintPhase::Error;
            run.state.error = Some(public_failure(&failure));
        }
    }
    Ok(run.state.clone())
}

pub(super) fn cancel(
    root: &Path,
    project_id: &str,
    runs: &LintRuns,
    input: WikiLintCancelInput,
) -> Result<WikiLintState, WikiFailure> {
    {
        let active = runs.runs.lock().unwrap();
        let run = active
            .get(project_id)
            .filter(|run| run.state.task_id.as_deref() == Some(&input.task_id))
            .ok_or_else(|| WikiFailure::not_found("Wiki lint task"))?;
        run.cancellation.cancel();
    }
    state(root, project_id, runs)
}

pub(super) fn dismiss(
    root: &Path,
    project_id: &str,
    runs: &LintRuns,
    input: WikiLintActionInput,
) -> Result<WikiLintState, WikiFailure> {
    let mut current = state(root, project_id, runs)?;
    current
        .items
        .retain(|finding| !input.ids.contains(&finding.id));
    persist(root, ITEMS, &current.items)?;
    if let Some(run) = runs.runs.lock().unwrap().get_mut(project_id) {
        run.state.items = current.items.clone();
    }
    Ok(current)
}

fn wiki_path(root: &Path, relative: &str) -> Result<std::path::PathBuf, WikiFailure> {
    if !relative.starts_with("wiki/") || !relative.ends_with(".md") {
        return Err(WikiFailure::invalid_path(relative));
    }
    let path = resolve_project_path(root, relative)?;
    if path.exists() {
        let canonical = path
            .canonicalize()
            .map_err(|error| WikiFailure::io(relative, error))?;
        let canonical_root = root
            .join("wiki")
            .canonicalize()
            .map_err(|error| WikiFailure::io("wiki", error))?;
        if !canonical.starts_with(canonical_root) {
            return Err(WikiFailure::invalid_path(relative));
        }
    } else {
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if directory.exists() {
                let canonical = directory
                    .canonicalize()
                    .map_err(|error| WikiFailure::io(relative, error))?;
                let canonical_root = root
                    .canonicalize()
                    .map_err(|error| WikiFailure::io("project", error))?;
                if !canonical.starts_with(canonical_root) {
                    return Err(WikiFailure::invalid_path(relative));
                }
                break;
            }
            parent = directory.parent();
        }
    }
    Ok(path)
}

fn review(finding: &WikiLintFinding) -> WikiReviewItem {
    let suggestion = matches!(
        finding.finding_type,
        WikiLintType::Orphan | WikiLintType::NoOutlinks
    );
    let title = match finding.finding_type {
        WikiLintType::BrokenLink => format!("Fix broken link in {}", finding.page),
        WikiLintType::Orphan | WikiLintType::NoOutlinks => {
            format!("Add cross-references for {}", finding.page)
        }
        WikiLintType::Semantic => finding.detail.chars().take(80).collect(),
    };
    let affected = if finding.finding_type == WikiLintType::Semantic {
        finding.affected_pages.clone()
    } else {
        vec![finding.page.clone()]
    };
    let mut options = affected
        .first()
        .map(|page| WikiReviewOption::new("Open to edit".into(), format!("open:{page}")))
        .into_iter()
        .collect::<Vec<_>>();
    options.push(WikiReviewOption::new("Skip".into(), "Skip".into()));
    WikiReviewItem {
        id: format!("review-{}", finding.id),
        review_type: if suggestion {
            WikiReviewType::Suggestion
        } else {
            WikiReviewType::Confirm
        },
        title,
        description: finding.detail.clone(),
        source_path: None,
        affected_pages: affected,
        search_queries: Vec::new(),
        options,
        resolved: false,
        resolved_action: None,
        created_at: crate::domain::now_ms(),
    }
}

pub(super) async fn action(
    root: &Path,
    project_id: &str,
    runs: &LintRuns,
    input: WikiLintActionInput,
    action: LintAction,
    mut write: impl FnMut(String, String) -> Result<WikiWriteReceipt, WikiFailure>,
) -> Result<WikiLintFixReceipt, WikiFailure> {
    let current = state(root, project_id, runs)?;
    let mut receipt = WikiLintFixReceipt {
        project_id: project_id.to_owned(),
        ..Default::default()
    };
    let mut edits = BTreeMap::<String, (String, Vec<String>)>::new();
    let mut stubs = BTreeSet::new();
    let mut stub_dependencies = BTreeMap::new();
    let mut reviews = Vec::new();
    for id in &input.ids {
        let Some(finding) = current.items.iter().find(|finding| &finding.id == id) else {
            receipt.failures.push(WikiLintFixFailure {
                id: id.clone(),
                message: "Wiki lint finding no longer exists.".into(),
            });
            continue;
        };
        if matches!(action, LintAction::Review) {
            reviews.push(review(finding));
            receipt.reviewed_ids.push(id.clone());
            continue;
        }
        if matches!(action, LintAction::Delete) {
            if finding.finding_type != WikiLintType::Orphan {
                receipt.failures.push(WikiLintFixFailure {
                    id: id.clone(),
                    message: "Only orphan findings support explicit deletion.".into(),
                });
                continue;
            }
            match delete(root, finding, &mut write, &mut receipt).await {
                Ok(()) => receipt.fixed_ids.push(id.clone()),
                Err(failure) => receipt.failures.push(WikiLintFixFailure {
                    id: id.clone(),
                    message: public_failure(&failure),
                }),
            }
            continue;
        }
        let target = match finding.finding_type {
            WikiLintType::Orphan => finding
                .suggested_source
                .as_ref()
                .map(|source| (source.clone(), None, finding.page.clone())),
            WikiLintType::NoOutlinks => finding
                .suggested_target
                .as_ref()
                .map(|target| (finding.page.clone(), None, target.clone())),
            WikiLintType::BrokenLink => finding.broken_target.as_ref().map(|broken| {
                (
                    finding.page.clone(),
                    Some(broken.clone()),
                    finding.suggested_target.clone().unwrap_or_default(),
                )
            }),
            WikiLintType::Semantic => None,
        };
        let Some((path, broken, mut target)) = target else {
            reviews.push(review(finding));
            receipt.reviewed_ids.push(id.clone());
            continue;
        };
        let update = (|| -> Result<(), WikiFailure> {
            let full = wiki_path(root, &path)?;
            if !edits.contains_key(&path) {
                let content = std::fs::read_to_string(&full)
                    .map_err(|error| WikiFailure::io(&path, error))?;
                edits.insert(path.clone(), (content, Vec::new()));
            }
            if let Some(broken) = &broken {
                if target.is_empty() {
                    let (stub_path, content) = stub(broken);
                    let full = wiki_path(root, &stub_path)?;
                    if !full.exists() {
                        if !edits.contains_key(&stub_path) {
                            edits.insert(stub_path.clone(), (content, Vec::new()));
                        }
                        stubs.insert(stub_path.clone());
                        stub_dependencies.insert(id.clone(), stub_path.clone());
                    }
                    target = stub_path;
                } else if !wiki_path(root, &target)?.is_file() {
                    return Err(WikiFailure::not_found("Wiki lint target"));
                }
            } else if !wiki_path(root, &target)?.is_file() {
                return Err(WikiFailure::not_found("Wiki lint target"));
            }
            let (content, ids) = edits.get_mut(&path).unwrap();
            *content = if let Some(broken) = &broken {
                rewrite_wikilink_target(content, broken, &target)
            } else {
                append_wikilink(content, &target)
            };
            ids.push(id.clone());
            Ok(())
        })();
        if let Err(failure) = update {
            receipt.failures.push(WikiLintFixFailure {
                id: id.clone(),
                message: public_failure(&failure),
            });
        }
    }
    if !reviews.is_empty() {
        match super::review_lifecycle::append_review_items(root, reviews) {
            Ok(()) => {}
            Err(failure) => {
                for id in receipt.reviewed_ids.drain(..) {
                    receipt.failures.push(WikiLintFixFailure {
                        id,
                        message: public_failure(&failure),
                    });
                }
            }
        }
    }
    // Stubs precede rewrites so a failed stub write never redirects a page to a nonexistent target.
    let mut failed_stubs = BTreeSet::new();
    for path in stubs {
        let (content, ids) = edits.remove(&path).unwrap();
        match write(path.clone(), content) {
            Ok(_) => {
                receipt.written_pages.push(path);
                receipt.fixed_ids.extend(ids);
            }
            Err(failure) => {
                failed_stubs.insert(path);
                for id in ids {
                    receipt.failures.push(WikiLintFixFailure {
                        id,
                        message: public_failure(&failure),
                    });
                }
            }
        }
    }
    for (path, (content, ids)) in edits.into_iter().filter(|(_, (_, ids))| !ids.is_empty()) {
        let failed = ids.iter().any(|id| {
            stub_dependencies
                .get(id)
                .is_some_and(|path| failed_stubs.contains(path))
        });
        if failed {
            for id in ids {
                receipt.failures.push(WikiLintFixFailure {
                    id,
                    message: "Missing-page placeholder could not be saved.".into(),
                });
            }
            continue;
        }
        match write(path.clone(), content) {
            Ok(_) => {
                receipt.written_pages.push(path);
                receipt.fixed_ids.extend(ids);
            }
            Err(failure) => {
                for id in ids {
                    receipt.failures.push(WikiLintFixFailure {
                        id,
                        message: public_failure(&failure),
                    });
                }
            }
        }
    }
    let removed = receipt
        .fixed_ids
        .iter()
        .chain(&receipt.reviewed_ids)
        .cloned()
        .collect();
    dismiss(
        root,
        project_id,
        runs,
        WikiLintActionInput {
            project_id: Some(project_id.to_owned()),
            ids: removed,
        },
    )?;
    receipt.written_pages.sort();
    receipt.written_pages.dedup();
    Ok(receipt)
}

async fn delete(
    root: &Path,
    finding: &WikiLintFinding,
    write: &mut impl FnMut(String, String) -> Result<WikiWriteReceipt, WikiFailure>,
    receipt: &mut WikiLintFixReceipt,
) -> Result<(), WikiFailure> {
    use super::source_lifecycle::{
        clean_index_listing, normalize_wiki_ref_key, strip_deleted_wikilinks, wiki_markdown_files,
    };
    use crate::ingest::write::{
        parse_frontmatter_array, parse_frontmatter_scalar, write_frontmatter_array,
    };
    let page = wiki_path(root, &finding.page)?;
    let content = match std::fs::read_to_string(&page) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(WikiFailure::io(&finding.page, error)),
    };
    let slug = page
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let mut keys = BTreeSet::from([normalize_wiki_ref_key(slug)]);
    if let Some(title) = parse_frontmatter_scalar(&content, "title") {
        keys.insert(normalize_wiki_ref_key(&title));
    }
    match std::fs::remove_file(&page) {
        Ok(()) => receipt.deleted_pages.push(finding.page.clone()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(WikiFailure::io(&finding.page, error)),
    }
    super::source_lifecycle::refresh_file_snapshot(root, &[&finding.page])?;
    crate::vector::delete_page(root, &stable_content_hash(finding.page.as_bytes()))
        .await
        .map_err(|_| WikiFailure::state("Wiki lint index cleanup failed"))?;
    if finding.page.starts_with("wiki/sources/") && !slug.is_empty() && !slug.starts_with('.') {
        let media = root.join("wiki/media").join(slug);
        match std::fs::remove_dir_all(media) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(WikiFailure::io("wiki/media", error)),
        }
    }
    for path in wiki_markdown_files(root)? {
        let relative = normalize_relative_path(path.strip_prefix(root).unwrap());
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut updated = if path.file_name().and_then(|name| name.to_str()) == Some("index.md") {
            clean_index_listing(&content, &keys)
        } else {
            content.clone()
        };
        updated = strip_deleted_wikilinks(&updated, &keys);
        let related = parse_frontmatter_array(&updated, "related");
        let survivors = related
            .iter()
            .filter(|reference| !keys.contains(&normalize_wiki_ref_key(reference)))
            .cloned()
            .collect::<Vec<_>>();
        if survivors.len() != related.len() {
            updated = write_frontmatter_array(&updated, "related", &survivors);
        }
        if updated != content {
            write(relative.clone(), updated)?;
            receipt.written_pages.push(relative);
        }
    }
    Ok(())
}
