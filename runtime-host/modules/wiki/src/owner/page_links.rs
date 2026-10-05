use std::{io::Write, path::Path};

use super::{
    actor::{
        WikiShared, WikiState, embed_page, project_root, read_source_watch_config, selected_project,
    },
    lint::wiki_path,
    source_lifecycle::{refresh_file_snapshot, wiki_markdown_files},
};
use crate::{
    domain::{
        WikiFailure, WikiMissingPageCancelInput, WikiMissingPageInput, WikiMissingPageReceipt,
        WikiPageLinks, WikiPathSelector, normalize_relative_path, resolve_project_path,
    },
    page_links,
    ports::{WikiFuture, WikiIngestLlmDeltaSink},
};

const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;

pub(crate) async fn links(
    _shared: &WikiShared,
    state: &WikiState,
    input: WikiPathSelector,
) -> Result<WikiPageLinks, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project).to_path_buf();
    let project_id = project.project_id().to_owned();
    tokio::task::spawn_blocking(move || {
        let path = wiki_path(&root, &input.relative_path)?;
        let relative =
            normalize_relative_path(path.strip_prefix(&root).expect("Wiki project file"));
        let files = wiki_markdown_files(&root)?;
        page_links::read_links(&root, &project_id, &relative, files)
    })
    .await
    .map_err(|_| WikiFailure::state("Wiki page-links worker failed"))?
}

pub(crate) fn stage(
    shared: &WikiShared,
    state: &WikiState,
    mut input: WikiMissingPageInput,
) -> Result<page_links::MissingPagePlan, WikiFailure> {
    input.title = page_links::normalize_title(&input.title)?;
    let project = selected_project(state, input.project_id.as_deref())?;
    let project_id = project.project_id().to_owned();
    input.project_id = Some(project_id.clone());
    if input.draft {
        wiki_path(project_root(project), &input.linking_path)?;
        if shared.ingest_llm.is_none() {
            return Err(WikiFailure::state(
                "Wiki draft generation is unavailable. Configure a model and retry.",
            ));
        }
    }
    let run = shared.missing_pages.begin(&project_id, &input.task_id)?;
    Ok(page_links::MissingPagePlan {
        project_id,
        input,
        run,
    })
}

pub(crate) async fn create(
    shared: &WikiShared,
    state: &WikiState,
    plan: page_links::MissingPagePlan,
) -> Result<WikiMissingPageReceipt, WikiFailure> {
    let page_links::MissingPagePlan {
        input,
        run,
        project_id,
    } = plan;
    if run.cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    let project = selected_project(state, Some(&project_id))?;
    let root = project_root(project);
    let project_id = project.project_id();
    let title = input.title;
    let body = if input.draft {
        let llm = shared.ingest_llm.as_ref().ok_or_else(|| {
            WikiFailure::state("Wiki draft generation is unavailable. Configure a model and retry.")
        })?;
        let linking_path = wiki_path(root, &input.linking_path)?;
        let linking_content = std::fs::read_to_string(linking_path)
            .map_err(|error| WikiFailure::io(&input.linking_path, error))?;
        let mut sink = DraftSink {
            content: String::new(),
        };
        tokio::select! {
            biased;
            _ = run.cancellation.cancelled() => return Err(WikiFailure::cancelled()),
            result = llm.stream_generate_cancellable(
                page_links::draft_request(
                    &title,
                    &linking_content,
                    read_source_watch_config(root)?.generation_model_ref().map(str::to_owned),
                ),
                run.cancellation.clone(),
                &mut sink,
            ) => { result?; }
        }
        let body = page_links::normalize_draft(&sink.content);
        if body.trim().is_empty() {
            return Err(WikiFailure::state(
                "The model returned an empty Wiki draft. Retry generation.",
            ));
        }
        body.to_owned()
    } else {
        let today = chrono::Utc::now().format("%Y-%m-%d");
        format!(
            "---\ntype: concept\ntitle: {}\ncreated: {today}\nupdated: {today}\ntags: []\nrelated: []\n---\n\n# {title}\n",
            serde_json::to_string(&title).expect("string encodes"),
        )
    };
    let path = run.commit(|| create_page(root, &title, &body))?;
    if crate::history::record(root, &path, "agent", "wiki.missing_link.create").is_err() {
        eprintln!("[wiki] missing-link page created; history recording failed");
    }
    let mut changed = vec![path.as_str()];
    // Reuse the owner-maintained recent index without rewriting the model's page content.
    let index_result = (|| {
        wiki_path(root, "wiki/index.md")?;
        let staged = resolve_project_path(root, "wiki/.index.md.recent.tmp")?;
        if std::fs::symlink_metadata(staged).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(WikiFailure::invalid_path("wiki/.index.md.recent.tmp"));
        }
        crate::history::record(
            root,
            "wiki/index.md",
            "baseline",
            "before.wiki.missing_link.create",
        )?;
        crate::archive::update_recent_wiki_index(root, std::slice::from_ref(&path))
            .map_err(|_| WikiFailure::state("Wiki recent index update failed"))
    })();
    match index_result {
        Ok(true) => {
            changed.push("wiki/index.md");
            if crate::history::record(root, "wiki/index.md", "agent", "wiki.missing_link.create")
                .is_err()
            {
                eprintln!("[wiki] missing-link index updated; history recording failed");
            }
        }
        Ok(false) => {}
        Err(_) => eprintln!("[wiki] missing-link page created; recent index update failed"),
    }
    refresh_file_snapshot(root, &changed)?;
    if embed_page(
        shared,
        state,
        WikiPathSelector {
            project_id: Some(project_id.to_owned()),
            relative_path: path.clone(),
        },
    )
    .await
    .is_err()
    {
        eprintln!("[wiki] missing-link page embedding failed; page preserved");
    }
    Ok(WikiMissingPageReceipt {
        project_id: project_id.to_owned(),
        path,
    })
}

pub(crate) async fn cancel(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiMissingPageCancelInput,
) -> Result<bool, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    shared
        .missing_pages
        .cancel(project.project_id(), &input.task_id)
}

fn create_page(root: &Path, title: &str, body: &str) -> Result<String, WikiFailure> {
    if body.len() > MAX_CONTENT_BYTES {
        return Err(WikiFailure::invalid_input(
            "content",
            "Missing-link page content exceeds the 2 MB limit",
        ));
    }
    let stem = page_links::safe_stem(title);
    let directory = resolve_project_path(root, "wiki/concepts")?;
    wiki_path(root, &format!("wiki/concepts/{stem}.md"))?;
    std::fs::create_dir_all(&directory).map_err(|error| WikiFailure::io("wiki/concepts", error))?;
    let canonical = directory
        .canonicalize()
        .map_err(|error| WikiFailure::io("wiki/concepts", error))?;
    let wiki_root = root
        .join("wiki")
        .canonicalize()
        .map_err(|error| WikiFailure::io("wiki", error))?;
    let project_root = root
        .canonicalize()
        .map_err(|error| WikiFailure::io("project", error))?;
    if !canonical.starts_with(wiki_root) || !canonical.starts_with(project_root) {
        return Err(WikiFailure::invalid_path("wiki/concepts"));
    }
    for suffix in 1..=9_999 {
        let filename = if suffix == 1 {
            format!("{stem}.md")
        } else {
            format!("{stem}-{suffix}.md")
        };
        let relative = format!("wiki/concepts/{filename}");
        let target = directory.join(filename);
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(WikiFailure::io(&relative, error)),
        };
        if let Err(error) = file.write_all(body.as_bytes()) {
            drop(file);
            let _ = std::fs::remove_file(target);
            return Err(WikiFailure::io(&relative, error));
        }
        return Ok(relative);
    }
    Err(WikiFailure::state(
        "Could not allocate a unique Wiki page filename",
    ))
}

struct DraftSink {
    content: String,
}

impl WikiIngestLlmDeltaSink for DraftSink {
    fn send<'a>(&'a mut self, delta: String) -> WikiFuture<'a, Result<(), WikiFailure>> {
        Box::pin(async move {
            if self.content.len().saturating_add(delta.len()) > MAX_CONTENT_BYTES {
                return Err(WikiFailure::invalid_input(
                    "content",
                    "Missing-link page content exceeds the 2 MB limit",
                ));
            }
            self.content.push_str(&delta);
            Ok(())
        })
    }
}
