use std::path::Path;

use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

use super::actor::{WikiShared, WikiState, embed_page, project_root, selected_project, write_file};
use crate::{
    WikiFailure,
    domain::{
        WikiPathSelector, WikiWriteInput,
        model::{
            WikiQuestionInput, WikiQuestionSaveReceipt, WikiQuestionStatus, WikiQuestionTask,
            WikiQuestionTaskReceipt, WikiQuestionTaskSelector,
        },
    },
    qa::{QuestionPlan, prompts},
};

pub(crate) async fn stage_question(
    shared: &WikiShared,
    state: &WikiState,
    mut input: WikiQuestionInput,
    cancellation: CancellationToken,
) -> Result<QuestionPlan, WikiFailure> {
    input.task_id = input.task_id.trim().to_owned();
    input.model_ref = input.model_ref.trim().to_owned();
    input.question = input.question.trim().to_owned();
    if input.task_id.is_empty() || input.task_id.chars().count() > 200 {
        return Err(WikiFailure::invalid_input(
            "taskId",
            "A unique taskId of 1 to 200 characters is required",
        ));
    }
    if input.model_ref.is_empty() || input.model_ref == "auto" {
        return Err(WikiFailure::invalid_input(
            "modelRef",
            "Choose an explicit Wiki question model; auto is not supported",
        ));
    }
    if input.question.is_empty() {
        return Err(WikiFailure::invalid_input(
            "question",
            "Question must not be empty",
        ));
    }
    let llm = shared.ingest_llm.clone().ok_or_else(|| {
        WikiFailure::state(
            "Wiki question generation is unavailable. Configure a Wiki model and retry.",
        )
    })?;
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let task = WikiQuestionTask {
        id: input.task_id,
        project_id: project.project_id().to_owned(),
        question: input.question,
        model_ref: input.model_ref,
        status: WikiQuestionStatus::Queued,
        answer: String::new(),
        references: Vec::new(),
        error: None,
        saved_path: None,
        revision: 1,
    };
    let history_start = input.history.len().saturating_sub(10);
    let history = input.history.drain(history_start..).collect();
    let overview = read_optional(&root.join("overview.md"))?
        .or(read_optional(&root.join("wiki/overview.md"))?)
        .unwrap_or_default();
    let schema = read_optional(&root.join("schema.md"))?
        .or(read_optional(&root.join("wiki/schema.md"))?)
        .unwrap_or_default();
    shared
        .question_tasks
        .stage(root, task.clone(), cancellation.clone())
        .await?;
    Ok(QuestionPlan {
        project_root: root.to_path_buf(),
        project_id: project.project_id().to_owned(),
        task,
        history,
        overview: prompts::trim_chars(&overview, 8_000),
        schema: prompts::trim_chars(&schema, 6_000),
        tasks: shared.question_tasks.clone(),
        llm,
        cancellation,
    })
}

pub(crate) async fn question_task(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiQuestionTaskSelector,
) -> Result<WikiQuestionTaskReceipt, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let task = shared
        .question_tasks
        .get(project_root(project), project.project_id(), &input.task_id)
        .await?;
    Ok(WikiQuestionTaskReceipt {
        project_id: project.project_id().to_owned(),
        task,
    })
}

pub(crate) async fn cancel_question(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiQuestionTaskSelector,
) -> Result<WikiQuestionTaskReceipt, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let task = shared
        .question_tasks
        .cancel(project_root(project), project.project_id(), &input.task_id)
        .await?;
    Ok(WikiQuestionTaskReceipt {
        project_id: project.project_id().to_owned(),
        task,
    })
}

pub(crate) async fn save_question(
    shared: &WikiShared,
    state: &WikiState,
    input: WikiQuestionTaskSelector,
) -> Result<WikiQuestionSaveReceipt, WikiFailure> {
    let project = selected_project(state, input.project_id.as_deref())?;
    let root = project_root(project);
    let project_id = project.project_id();
    let task = shared
        .question_tasks
        .get(root, project_id, &input.task_id)
        .await?;
    if task.status != WikiQuestionStatus::Done {
        return Err(WikiFailure::invalid_input(
            "taskId",
            "Only a completed Wiki answer can be saved",
        ));
    }
    if let Some(saved_path) = task.saved_path {
        return Ok(WikiQuestionSaveReceipt {
            project_id: project_id.to_owned(),
            saved_path,
        });
    }
    let body = prompts::clean_for_save(&task.answer);
    if body.is_empty() {
        return Err(WikiFailure::state(
            "This answer contains no visible content to save",
        ));
    }
    let title = prompts::title(&body);
    let slug = query_slug(&title);
    let identity = crate::domain::stable_content_hash(task.id.as_bytes());
    let file_name = format!("{slug}-{identity}.md");
    let saved_path = format!("wiki/queries/{file_name}");
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let existing = read_optional(&root.join(&saved_path))?;
    let date = existing
        .as_deref()
        .and_then(|content| {
            content
                .lines()
                .find_map(|line| line.strip_prefix("created: "))
        })
        .unwrap_or(&date)
        .to_owned();
    let mut content = format!(
        "---\ntype: query\ntitle: {}\ncreated: {date}\ntags: []\n---\n\n{body}",
        serde_json::to_string(&title).expect("string encodes")
    );
    if !task.references.is_empty() {
        content.push_str("\n\n## References\n\n");
        for (index, reference) in task.references.iter().enumerate() {
            let target = reference
                .path
                .strip_prefix("wiki/")
                .unwrap_or(&reference.path)
                .trim_end_matches(".md");
            content.push_str(&format!(
                "{}. [[{target}|{}]]\n",
                index + 1,
                reference.title
            ));
            if !reference.snippet.is_empty() {
                content.push_str(&format!("\n{}\n", reference.snippet));
            }
            if !reference.graph_related_to.is_empty() {
                content.push_str(&format!(
                    "\nGraph neighbors of: {}\n",
                    reference.graph_related_to.join(", ")
                ));
            }
        }
    }
    content.push('\n');
    let link_target = file_name.trim_end_matches(".md");
    let entry = format!("- [[queries/{link_target}|{title}]]");
    let index = read_optional(&root.join("wiki/index.md"))?
        .unwrap_or_else(|| "# Wiki Index\n\n## Queries\n".to_owned());
    let index = if index.contains(&format!("[[queries/{link_target}|"))
        || index.contains(&format!("[[queries/{link_target}]]"))
    {
        index
    } else if let Some(position) = index.find("## Queries\n") {
        let position = position + "## Queries\n".len();
        format!("{}{}\n{}", &index[..position], entry, &index[position..])
    } else {
        format!("{}\n\n## Queries\n{entry}\n", index.trim_end())
    };
    let log =
        read_optional(&root.join("wiki/log.md"))?.unwrap_or_else(|| "# Wiki Log\n\n".to_owned());
    let log = if log
        .lines()
        .any(|line| line.ends_with(&format!("Saved query page `{file_name}`")))
    {
        log
    } else {
        format!(
            "{}\n- {date}: Saved query page `{file_name}`\n",
            log.trim_end()
        )
    };
    for (relative_path, content) in [
        (saved_path.clone(), content),
        ("wiki/index.md".to_owned(), index),
        ("wiki/log.md".to_owned(), log),
    ] {
        write_file(
            state,
            WikiWriteInput {
                project_id: Some(project_id.to_owned()),
                relative_path,
                content,
            },
        )?;
    }
    shared
        .question_tasks
        .update(root, project_id, &task.id, |task| {
            task.saved_path = Some(saved_path.clone());
            task.error = None;
        })
        .await?;
    if embed_page(
        shared,
        state,
        WikiPathSelector {
            project_id: Some(project_id.to_owned()),
            relative_path: saved_path.clone(),
        },
    )
    .await
    .is_err()
    {
        eprintln!("[wiki] saved question embedding failed; query page preserved");
    }
    Ok(WikiQuestionSaveReceipt {
        project_id: project_id.to_owned(),
        saved_path,
    })
}

fn read_optional(path: &Path) -> Result<Option<String>, WikiFailure> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(WikiFailure::io(path.to_string_lossy(), error)),
    }
}

fn query_slug(title: &str) -> String {
    let mut slug = String::new();
    for character in title.nfkc().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            slug.push(character);
        } else if (character.is_whitespace() || character == '-') && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').chars().take(50).collect::<String>();
    if slug.is_empty() {
        "query".to_owned()
    } else {
        slug
    }
}
