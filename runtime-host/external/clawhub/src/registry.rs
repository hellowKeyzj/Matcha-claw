use std::{path::PathBuf, time::Duration};

use reqwest::{Client, Url, header};
use serde_json::Value;

const PRIMARY_REGISTRY: &str = "https://cn.clawhub-mirror.com";
const BACKUP_REGISTRY: &str = "https://mirror-cn.clawhub.com";
const SEARCH_PATH: &str = "/api/v1/search";
const SETTINGS_FILE: &str = "matchaclaw-settings.json";
const CLAWHUB_TOKEN_FIELD: &str = "clawHubToken";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct ClawHubRegistryClient {
    http: Client,
    registries: Vec<String>,
    settings_file: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClawHubSearchResult {
    slug: String,
    name: String,
    description: String,
    version: String,
    author: Option<String>,
    downloads: Option<u64>,
    stars: Option<u64>,
}

impl ClawHubSearchResult {
    pub fn new(slug: String, name: String, description: String, version: String) -> Self {
        Self {
            slug,
            name,
            description,
            version,
            author: None,
            downloads: None,
            stars: None,
        }
    }

    pub fn with_marketplace_stats(
        mut self,
        author: Option<String>,
        downloads: Option<u64>,
        stars: Option<u64>,
    ) -> Self {
        self.author = author;
        self.downloads = downloads;
        self.stars = stars;
        self
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn author(&self) -> Option<&str> {
        self.author.as_deref()
    }

    pub fn downloads(&self) -> Option<u64> {
        self.downloads
    }

    pub fn stars(&self) -> Option<u64> {
        self.stars
    }
}

impl ClawHubRegistryClient {
    pub fn new(runtime_data_dir: PathBuf) -> Self {
        let settings_file = std::env::var_os("MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_data_dir.join(SETTINGS_FILE));
        let http = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            http,
            registries: resolve_registry_bases(),
            settings_file,
        }
    }

    pub async fn search(
        &self,
        query: Option<&str>,
        limit: u16,
    ) -> Result<Vec<ClawHubSearchResult>, ()> {
        let token = read_token(&self.settings_file);
        let mut failed = false;
        for registry in &self.registries {
            match self.fetch(registry, query, limit, token.as_deref()).await {
                Ok(mut results) => {
                    if query.is_none() {
                        results.sort_by(|left, right| {
                            right
                                .score
                                .partial_cmp(&left.score)
                                .unwrap_or(std::cmp::Ordering::Equal)
                                .then_with(|| left.item.name.cmp(&right.item.name))
                        });
                    }
                    return Ok(results.into_iter().map(|result| result.item).collect());
                }
                Err(()) => failed = true,
            }
        }
        if failed { Err(()) } else { Ok(Vec::new()) }
    }

    pub fn registry_bases(&self) -> &[String] {
        &self.registries
    }

    async fn fetch(
        &self,
        registry: &str,
        query: Option<&str>,
        limit: u16,
        token: Option<&str>,
    ) -> Result<Vec<ScoredSearchResult>, ()> {
        let mut url = Url::parse(&format!("{}/", registry.trim_end_matches('/')))
            .map_err(|_| ())?
            .join(SEARCH_PATH.trim_start_matches('/'))
            .map_err(|_| ())?;
        {
            let mut pairs = url.query_pairs_mut();
            if let Some(query) = query {
                pairs.append_pair("q", query);
            }
            pairs.append_pair("limit", &limit.to_string());
        }

        let mut request = self
            .http
            .get(url)
            .header(header::ACCEPT, "application/json");
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = request.send().await.map_err(|_| ())?;
        let status = response.status();
        let text = response.text().await.map_err(|_| ())?;
        if !status.is_success() {
            return Err(());
        }
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let payload = serde_json::from_str::<Value>(&text).map_err(|_| ())?;
        Ok(map_search_results(&payload))
    }
}

#[derive(Debug)]
struct ScoredSearchResult {
    item: ClawHubSearchResult,
    score: f64,
}

fn resolve_registry_bases() -> Vec<String> {
    if let Some(value) = std::env::var_os("CLAWHUB_REGISTRY") {
        let value = value
            .to_string_lossy()
            .trim()
            .trim_end_matches('/')
            .to_owned();
        if !value.is_empty() {
            return vec![value];
        }
    }
    vec![PRIMARY_REGISTRY.to_owned(), BACKUP_REGISTRY.to_owned()]
}

fn read_token(path: &PathBuf) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let settings = serde_json::from_str::<Value>(&text).ok()?;
    let value = settings.get(CLAWHUB_TOKEN_FIELD)?.as_str()?.trim();
    let value = strip_bearer(value).trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn strip_bearer(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() > 6
        && bytes[..6].eq_ignore_ascii_case(b"bearer")
        && bytes[6].is_ascii_whitespace()
    {
        &value[6..]
    } else {
        value
    }
}

fn map_search_results(payload: &Value) -> Vec<ScoredSearchResult> {
    let Some(rows) = payload.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|value| {
            let row = value.as_object()?;
            let slug = text(row.get("slug"))?;
            if slug.is_empty() {
                return None;
            }
            let name = text(row.get("displayName"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| slug.clone());
            let description = skill_manifest_description(row)?;
            let version = text(row.get("version"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "latest".to_owned());
            let author = row
                .get("metaContent")
                .and_then(Value::as_object)
                .and_then(|meta| text(meta.get("owner")))
                .filter(|value| !value.is_empty())
                .or_else(|| text(row.get("author")).filter(|value| !value.is_empty()));
            let stats = row.get("stats").and_then(Value::as_object);
            let score = row.get("score").and_then(Value::as_f64).unwrap_or(0.0);
            Some(ScoredSearchResult {
                item: ClawHubSearchResult {
                    slug,
                    name,
                    description,
                    version,
                    author,
                    downloads: stats
                        .and_then(|stats| stats.get("downloads"))
                        .and_then(optional_count),
                    stars: stats
                        .and_then(|stats| stats.get("stars"))
                        .and_then(optional_count),
                },
                score,
            })
        })
        .collect()
}

fn skill_manifest_description(row: &serde_json::Map<String, Value>) -> Option<String> {
    row.get("metaContent")
        .and_then(Value::as_object)
        .and_then(|meta| text(meta.get("skillMd")))
        .and_then(|markdown| frontmatter_description(&markdown))
}

fn frontmatter_description(markdown: &str) -> Option<String> {
    let frontmatter = frontmatter(markdown)?;
    let normalized = normalize_inline_block_scalars(frontmatter);
    let parsed = serde_yaml::from_str::<Value>(&normalized).ok()?;
    text(parsed.get("description"))
}

fn frontmatter(markdown: &str) -> Option<&str> {
    let markdown = markdown.strip_prefix("---")?;
    let end = markdown.find("\n---")?;
    Some(&markdown[..end])
}

fn normalize_inline_block_scalars(frontmatter: &str) -> String {
    let mut normalized = String::with_capacity(frontmatter.len() + 4);
    for line in frontmatter.lines() {
        if let Some((prefix, body)) = inline_block_scalar(line) {
            normalized.push_str(prefix);
            normalized.push('\n');
            normalized.push_str("  ");
            normalized.push_str(body);
            normalized.push('\n');
        } else {
            normalized.push_str(line);
            normalized.push('\n');
        }
    }
    normalized
}

fn inline_block_scalar(line: &str) -> Option<(&str, &str)> {
    let marker = line.find(": |-").or_else(|| line.find(": >-"))?;
    let body_start = marker + 4;
    let body = line.get(body_start..)?.trim();
    (!body.is_empty()).then(|| (&line[..body_start], body))
}

fn optional_count(value: &Value) -> Option<u64> {
    match value {
        Value::Number(value) => value.as_u64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value?.as_str().map(str::trim).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_clawhub_registry_metadata_from_skill_markdown() {
        let results = map_search_results(&json!({
            "results": [{
                "slug": "windylamdatahive",
                "displayName": "windylam",
                "summary": "[object Object]",
                "version": "1.0.0",
                "score": 4.0,
                "stats": { "downloads": 12, "stars": "3" },
                "metaContent": {
                    "owner": "windylam1986",
                    "DisplayDescription": "当前该技能的功能说明存在异常",
                    "skillMd": "---\nname: windylam\ndescription: 当前该技能的功能说明存在异常\n---\n# windylam\n"
                }
            }]
        }));
        let result = &results[0].item;

        assert_eq!(result.slug(), "windylamdatahive");
        assert_eq!(result.name(), "windylam");
        assert_eq!(result.description(), "当前该技能的功能说明存在异常");
        assert_eq!(result.version(), "1.0.0");
        assert_eq!(result.author(), Some("windylam1986"));
        assert_eq!(result.downloads(), Some(12));
        assert_eq!(result.stars(), Some(3));
    }

    #[test]
    fn parses_standard_skill_markdown_block_description() {
        let results = map_search_results(&json!({
            "results": [{
                "slug": "calendar-pro",
                "displayName": "日历管理工具专业版",
                "version": "1.0.0",
                "metaContent": {
                    "owner": "thcjp",
                    "skillMd": "---\nname: calendar-pro\ndescription: |-\n  核心能力：日程管理。\n  支持会议、提醒和排期。\n---\n# 日历管理\n"
                }
            }]
        }));

        assert_eq!(
            results[0].item.description(),
            "核心能力：日程管理。\n支持会议、提醒和排期。"
        );
    }

    #[test]
    fn parses_standard_skill_markdown_folded_description() {
        let results = map_search_results(&json!({
            "results": [{
                "slug": "calendar-pro",
                "displayName": "日历管理工具专业版",
                "version": "1.0.0",
                "metaContent": {
                    "owner": "thcjp",
                    "skillMd": "---\nname: calendar-pro\ndescription: >-\n  核心能力：日程管理。\n  支持会议、提醒和排期。\n---\n# 日历管理\n"
                }
            }]
        }));

        assert_eq!(
            results[0].item.description(),
            "核心能力：日程管理。 支持会议、提醒和排期。"
        );
    }

    #[test]
    fn skips_marketplace_rows_without_skill_markdown_description() {
        let results = map_search_results(&json!({
            "results": [{
                "slug": "windylamdatahive",
                "displayName": "windylam",
                "summary": "Indexed summary",
                "version": "1.0.0",
                "metaContent": { "DisplayDescription": "Indexed display description" }
            }]
        }));

        assert!(results.is_empty());
    }

    #[test]
    fn parses_skill_markdown_block_description_when_indexed_summary_is_a_block_marker() {
        let results = map_search_results(&json!({
            "results": [{
                "slug": "dlazy-gen-tool-pro",
                "displayName": "综合生成工具-专业版",
                "summary": "|- 功能涵盖: dlazy, gen。",
                "version": "1.0.0",
                "metaContent": {
                    "owner": "thcjp",
                    "DisplayDescription": "可靠筛选各种AI绘画和日常内容处理的图像工具。",
                    "skillMd": "---\r\nslug: dlazy-gen-tool-pro\r\nname: \"dlazy-gen-tool-pro\"\r\nsummary: \"全模态生成引擎，覆盖40+模型，支持图片/视频/音频生成与管道链接批量工作流。\"\r\ndescription: |- 功能涵盖: dlazy, gen。\r\n  综合生成工具专业版。\r\n  - 40+ 模型全覆盖。\r\n  - 高质量图片生成。\r\n---\r\n# 综合生成工具\r\n"
                }
            }]
        }));

        assert_eq!(
            results[0].item.description(),
            "功能涵盖: dlazy, gen。\n综合生成工具专业版。\n- 40+ 模型全覆盖。\n- 高质量图片生成。"
        );
    }
}
