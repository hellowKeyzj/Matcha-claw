use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

use regex::Regex;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

use super::{LintRunPlan, LintRuns, WikiLintPhase};
use crate::domain::{WikiFailure, normalize_relative_path};

pub(crate) struct Page {
    pub path: String,
    pub title: String,
    pub content: String,
    pub links: Vec<String>,
}

pub(crate) fn links_regex() -> &'static Regex {
    static LINKS: OnceLock<Regex> = OnceLock::new();
    LINKS.get_or_init(|| Regex::new(r"\[\[([^\]|]+?)(\|[^\]]+?)?\]\]").unwrap())
}

pub(crate) fn normalize_target(target: &str) -> String {
    link_target(target).to_lowercase()
}

pub(crate) fn link_target(target: &str) -> String {
    let target = target.replace('\\', "/");
    let target = if target
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("wiki/"))
    {
        &target[5..]
    } else {
        &target
    };
    let target = if target
        .get(target.len().saturating_sub(3)..)
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".md"))
    {
        &target[..target.len() - 3]
    } else {
        target
    };
    target.trim().to_owned()
}

pub(crate) fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub(crate) fn utf16_prefix(text: &str, limit: usize) -> String {
    let mut count = 0;
    text.chars()
        .take_while(|character| {
            count += character.len_utf16();
            count <= limit
        })
        .collect()
}

pub(crate) fn tokens(text: &str) -> std::collections::BTreeSet<String> {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    let normalized = text.nfkc().collect::<String>().to_lowercase();
    let mut tokens = std::collections::BTreeSet::new();
    for word in WORDS
        .get_or_init(|| Regex::new(r"[\p{L}\p{N}]+").unwrap())
        .find_iter(&normalized)
    {
        let token = word.as_str();
        if token.encode_utf16().count() >= 2 {
            tokens.insert(token.to_owned());
        }
        if token
            .chars()
            .any(|character| ('\u{3400}'..='\u{9fff}').contains(&character))
        {
            tokens.extend(token.chars().map(|character| character.to_string()));
        }
    }
    tokens
}

fn collect(
    directory: &Path,
    depth: usize,
    paths: &mut Vec<PathBuf>,
    cancellation: &CancellationToken,
) -> Result<(), WikiFailure> {
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    if depth >= 30 {
        return Ok(());
    }
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| WikiFailure::io(directory.to_string_lossy(), error))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| !name.starts_with('.'))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .path()
            .is_dir()
            .cmp(&left.path().is_dir())
            .then(left.file_name().cmp(&right.file_name()))
    });
    for entry in entries {
        if cancellation.is_cancelled() {
            return Err(WikiFailure::cancelled());
        }
        let path = entry.path();
        if path.is_dir() {
            collect(&path, depth + 1, paths, cancellation)?;
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".md"))
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn title(content: &str, path: &str) -> String {
    static FRONTMATTER: OnceLock<Regex> = OnceLock::new();
    static TITLE: OnceLock<Regex> = OnceLock::new();
    static HEADING: OnceLock<Regex> = OnceLock::new();
    if let Some(frontmatter) = FRONTMATTER
        .get_or_init(|| Regex::new(r"^---\s*\n([\s\S]*?)\n---").unwrap())
        .captures(content)
    {
        if let Some(title) = TITLE
            .get_or_init(|| Regex::new(r#"(?m)^title:\s*["']?(.+?)["']?\s*$"#).unwrap())
            .captures(&frontmatter[1])
        {
            if !title[1].trim().is_empty() {
                return title[1].trim().to_owned();
            }
        }
    }
    if let Some(heading) = HEADING
        .get_or_init(|| Regex::new(r"(?m)^#\s+(.+)$").unwrap())
        .captures(content)
    {
        if !heading[1].trim().is_empty() {
            return heading[1].trim().to_owned();
        }
    }
    basename(path)
        .strip_suffix(".md")
        .unwrap_or(basename(path))
        .replace(['-', '_'], " ")
}

pub(crate) fn load_for_run(plan: &LintRunPlan, runs: &LintRuns) -> Result<Vec<Page>, WikiFailure> {
    load(&plan.root, &plan.cancellation, Some((plan, runs)))
}

fn load(
    root: &Path,
    cancellation: &CancellationToken,
    progress: Option<(&LintRunPlan, &LintRuns)>,
) -> Result<Vec<Page>, WikiFailure> {
    let mut paths = Vec::new();
    collect(&root.join("wiki"), 0, &mut paths, cancellation)?;
    let structural_count = paths
        .iter()
        .filter(|path| {
            !matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("index.md" | "log.md")
            )
        })
        .count();
    let mut completed = 0;
    let mut pages = Vec::new();
    for path in paths {
        if cancellation.is_cancelled() {
            return Err(WikiFailure::cancelled());
        }
        let structural = !matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some("index.md" | "log.md")
        );
        if let Ok(content) = std::fs::read_to_string(&path) {
            let relative = normalize_relative_path(path.strip_prefix(&root.join("wiki")).unwrap());
            let links = links_regex()
                .captures_iter(&content)
                .map(|capture| capture[1].trim().to_owned())
                .collect();
            pages.push(Page {
                title: title(&content, &relative),
                path: relative,
                content,
                links,
            });
        }
        if structural {
            completed += 1;
            if let Some((plan, runs)) = progress {
                runs.progress(
                    plan,
                    WikiLintPhase::Reading,
                    completed,
                    structural_count * 2,
                );
            }
        }
    }
    Ok(pages)
}
