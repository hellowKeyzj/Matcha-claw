use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

use tokio_util::sync::CancellationToken;

use crate::{
    domain::{
        WikiFailure, WikiPageLink, WikiPageLinks, extract_search_title, normalize_relative_path,
        search_snippet,
    },
    ports::{WikiIngestLlmMessage, WikiIngestLlmOptions, WikiIngestLlmRequest, WikiIngestLlmRole},
};

struct LinkPage {
    title: String,
    content: String,
    links: Vec<String>,
}

pub(crate) fn read_links(
    root: &Path,
    project_id: &str,
    relative: &str,
    files: Vec<std::path::PathBuf>,
) -> Result<WikiPageLinks, WikiFailure> {
    let mut pages = BTreeMap::new();
    for file in files {
        if pages.len() >= 10_000 {
            break;
        }
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        let path = normalize_relative_path(file.strip_prefix(root).expect("Wiki project file"));
        pages.insert(
            path,
            LinkPage {
                title: extract_search_title(
                    &content,
                    file.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default(),
                ),
                links: crate::domain::wiki_links(&content),
                content,
            },
        );
    }
    let current = pages
        .get(relative)
        .ok_or_else(|| WikiFailure::not_found(relative))?;
    let mut outgoing = Vec::new();
    let mut missing = Vec::new();
    for link in &current.links {
        if let Some((path, target)) = resolve_link(&pages, link) {
            if path == relative {
                continue;
            }
            outgoing.push(WikiPageLink {
                title: target.title.clone(),
                path: Some(path.clone()),
                snippet: None,
            });
        } else {
            missing.push(WikiPageLink {
                title: link.clone(),
                path: None,
                snippet: None,
            });
        }
    }
    let mut backlinks = Vec::new();
    for (path, page) in &pages {
        if path == relative {
            continue;
        }
        if page
            .links
            .iter()
            .any(|link| resolve_link(&pages, link).is_some_and(|(path, _)| path == relative))
        {
            backlinks.push(WikiPageLink {
                title: page.title.clone(),
                path: Some(path.clone()),
                snippet: Some(search_snippet(&page.content, &current.title)),
            });
        }
    }
    outgoing.sort_by(|left, right| {
        left.title
            .cmp(&right.title)
            .then_with(|| left.path.cmp(&right.path))
    });
    outgoing.dedup_by(|left, right| left.path == right.path);
    backlinks.sort_by(|left, right| left.title.cmp(&right.title));
    missing.sort_by(|left, right| left.title.cmp(&right.title));
    missing.dedup_by(|left, right| left.title == right.title);
    Ok(WikiPageLinks {
        project_id: project_id.to_owned(),
        outgoing,
        backlinks,
        missing,
    })
}

fn resolve_link<'a>(
    pages: &'a BTreeMap<String, LinkPage>,
    link: &str,
) -> Option<(&'a String, &'a LinkPage)> {
    let link = link.trim().replace('\\', "/");
    if link.contains('/') {
        return pages.get_key_value(&link);
    }
    let filename = if link.ends_with(".md") {
        link
    } else {
        format!("{link}.md")
    };
    pages.iter().find(|(path, _)| {
        Path::new(path.as_str())
            .file_name()
            .is_some_and(|name| name == filename.as_str())
    })
}

pub(crate) fn normalize_title(title: &str) -> Result<String, WikiFailure> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(WikiFailure::invalid_input(
            "title",
            "Missing-link page title must contain 1 to 200 characters",
        ));
    }
    let title = title
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let title = title.trim();
    if title.is_empty() {
        return Err(WikiFailure::invalid_input(
            "title",
            "Missing-link page title must not be empty",
        ));
    }
    Ok(title.to_owned())
}

pub(crate) fn safe_stem(title: &str) -> String {
    let mut stem = title
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else if character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    while stem.contains("--") {
        stem = stem.replace("--", "-");
    }
    stem = stem.trim_matches([' ', '.', '-']).to_owned();
    if stem.is_empty() {
        stem = "untitled".to_owned();
    }
    let device = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && device.as_bytes()[3].is_ascii_digit()
            && device.as_bytes()[3] != b'0')
    {
        stem = format!("page-{stem}");
    }
    stem.chars().take(120).collect()
}

pub(crate) fn draft_request(
    title: &str,
    linking_content: &str,
    model_ref: Option<String>,
) -> WikiIngestLlmRequest {
    let context = String::from_utf16_lossy(
        &linking_content
            .encode_utf16()
            .take(6_000)
            .collect::<Vec<_>>(),
    );
    WikiIngestLlmRequest {
        model_ref,
        messages: vec![WikiIngestLlmMessage {
            role: WikiIngestLlmRole::User,
            content: [
                "Create a concise standalone Markdown wiki page for an unresolved link.",
                "Return the complete page only. Include YAML frontmatter with type, title, tags, and related, followed by useful content. Do not wrap it in a code fence.",
                &format!("Target title: {title}"),
                "Context from the linking page:",
                &context,
            ].join("\n\n"),
        }],
        options: WikiIngestLlmOptions { temperature: Some(0.3), max_output_tokens: None },
    }
}

pub(crate) fn normalize_draft(content: &str) -> &str {
    let trimmed = content.trim();
    if let Some(fenced) = trimmed.strip_prefix("```") {
        if let Some(open_end) = fenced.find('\n') {
            if let Some(body) = fenced[open_end + 1..].strip_suffix("\n```") {
                return body;
            }
        }
    }
    content
}

pub(crate) struct MissingPagePlan {
    pub(crate) project_id: String,
    pub(crate) input: crate::domain::WikiMissingPageInput,
    pub(crate) run: MissingPageRun,
}

#[derive(Default)]
pub(crate) struct MissingPageRuns {
    cancellations: Mutex<BTreeMap<(String, String), CancellationToken>>,
    lifetime: CancellationToken,
}

impl MissingPageRuns {
    pub(crate) fn begin(
        self: &Arc<Self>,
        project_id: &str,
        task_id: &str,
    ) -> Result<MissingPageRun, WikiFailure> {
        if task_id.trim().is_empty() || task_id.chars().count() > 200 {
            return Err(WikiFailure::invalid_input(
                "taskId",
                "A taskId of 1 to 200 characters is required",
            ));
        }
        if self.lifetime.is_cancelled() {
            return Err(WikiFailure::OwnerUnavailable);
        }
        let key = (project_id.to_owned(), task_id.to_owned());
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        if cancellations.contains_key(&key) {
            return Err(WikiFailure::invalid_input(
                "taskId",
                "Missing-page task is already active",
            ));
        }
        if cancellations.len() >= 32 {
            return Err(WikiFailure::state(
                "Too many active missing-page tasks; retry after one completes",
            ));
        }
        let cancellation = self.lifetime.child_token();
        cancellations.insert(key.clone(), cancellation.clone());
        Ok(MissingPageRun {
            runs: self.clone(),
            key: Some(key),
            cancellation,
        })
    }

    pub(crate) fn cancel(&self, project_id: &str, task_id: &str) -> Result<bool, WikiFailure> {
        let cancellations = self
            .cancellations
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let Some(cancellation) = cancellations.get(&(project_id.to_owned(), task_id.to_owned()))
        else {
            return Ok(false);
        };
        if cancellation.is_cancelled() {
            return Ok(false);
        }
        cancellation.cancel();
        Ok(true)
    }

    pub(crate) fn cancel_all(&self) {
        self.lifetime.cancel();
    }
}

pub(crate) struct MissingPageRun {
    runs: Arc<MissingPageRuns>,
    key: Option<(String, String)>,
    pub(crate) cancellation: CancellationToken,
}

impl MissingPageRun {
    // ponytail: serialize cancellation with <=2 MiB creation; per-project locks if contention is measured.
    pub(crate) fn commit<T>(
        mut self,
        create: impl FnOnce() -> Result<T, WikiFailure>,
    ) -> Result<T, WikiFailure> {
        let mut cancellations = self
            .runs
            .cancellations
            .lock()
            .map_err(|_| WikiFailure::OwnerUnavailable)?;
        let result = if self.cancellation.is_cancelled() {
            Err(WikiFailure::cancelled())
        } else {
            create()
        };
        cancellations.remove(self.key.as_ref().expect("active missing-page run"));
        self.key = None;
        result
    }
}

impl Drop for MissingPageRun {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.cancellation.cancel();
            if let Ok(mut cancellations) = self.runs.cancellations.lock() {
                cancellations.remove(&key);
            }
        }
    }
}
