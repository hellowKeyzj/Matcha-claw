use std::sync::OnceLock;

use regex::{Captures, Regex};
use unicode_normalization::UnicodeNormalization;

use super::pages::{basename, link_target, links_regex, normalize_target};

pub(crate) fn append_wikilink(content: &str, target: &str) -> String {
    let target = link_target(target);
    if links_regex()
        .captures_iter(content)
        .any(|capture| normalize_target(&capture[1]) == normalize_target(&target))
    {
        return content.to_owned();
    }
    let line = format!("- [[{target}]]");
    static RELATED: OnceLock<Regex> = OnceLock::new();
    if let Some(heading) = RELATED
        .get_or_init(|| Regex::new(r"(?im)^##\s+Related\s*$").unwrap())
        .find(content)
    {
        return format!(
            "{}\n{line}{}",
            &content[..heading.end()],
            &content[heading.end()..]
        );
    }
    format!("{}\n\n## Related\n{line}\n", content.trim_end())
}

pub(crate) fn rewrite_wikilink_target(content: &str, broken: &str, suggested: &str) -> String {
    let broken = normalize_target(broken);
    let replacement = link_target(suggested);
    links_regex()
        .replace_all(content, |capture: &Captures<'_>| {
            if normalize_target(&capture[1]) == broken {
                format!(
                    "[[{replacement}{}]]",
                    capture.get(2).map_or("", |alias| alias.as_str())
                )
            } else {
                capture[0].to_owned()
            }
        })
        .into_owned()
}

fn slug(title: &str) -> String {
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    let normalized = title.nfkc().collect::<String>();
    let normalized = normalized
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    let safe = UNSAFE
        .get_or_init(|| Regex::new(r"[^\p{L}\p{N}-]").unwrap())
        .replace_all(&normalized, "");
    let slug = safe
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
        .chars()
        .take(50)
        .collect::<String>();
    if slug.is_empty() {
        "query".to_owned()
    } else {
        slug
    }
}

pub(crate) fn stub(target: &str) -> (String, String) {
    let target = link_target(target);
    let parts = target.split('/').map(slug).collect::<Vec<_>>();
    let relative = if parts.len() > 1 {
        parts.join("/")
    } else {
        format!(
            "queries/{}",
            parts.first().map_or("missing-page", String::as_str)
        )
    };
    let path = format!("wiki/{relative}.md");
    let title = basename(&target).replace(['-', '_'], " ").trim().to_owned();
    let title = if title.is_empty() {
        "Missing Page"
    } else {
        &title
    };
    let date = chrono::Utc::now().format("%Y-%m-%d");
    let content = format!(
        "---\ntype: query\ntitle: \"{}\"\ncreated: {date}\nupdated: {date}\ntags: [stub, lint]\nrelated: []\nsources: []\n---\n\n# {title}\n\nCreated by Wiki Lint as a placeholder for a missing wikilink target.\n",
        title.replace('"', "\\\"")
    );
    (path, content)
}
