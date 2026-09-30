use std::path::Path;

use reqwest::Client;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::WikiFailure;
use crate::search_config::AnyTxtConfig;

use super::{ResearchSource, request_json, trim_text};

pub(super) async fn search(
    client: &Client,
    query: &str,
    config: &AnyTxtConfig,
    max_results: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<ResearchSource>, WikiFailure> {
    if cancellation.is_cancelled() {
        return Err(WikiFailure::cancelled());
    }
    let query = query.trim();
    if query.is_empty() || !config.enabled {
        return Ok(Vec::new());
    }
    let raw = config.endpoint.trim().trim_end_matches('/');
    let raw = if raw.is_empty() {
        "http://127.0.0.1:9920"
    } else {
        raw
    };
    let endpoint = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let limit = max_results.clamp(1, 100).min(config.limit.clamp(1, 100));
    let filter_ext = if config.filter_ext.trim().is_empty() {
        "*"
    } else {
        config.filter_ext.trim()
    };
    let mut input = json!({
        "pattern": query, "filterExt": filter_ext,
        "lastModifyBegin": 0, "lastModifyEnd": 2_147_483_647_i64,
        "limit": limit.to_string(), "offset": 0, "order": 0,
    });
    if !config.filter_dir.trim().is_empty() {
        input["filterDir"] = json!(config.filter_dir);
    }
    let value = rpc(client, &endpoint, 1, "GetResult", input, cancellation).await?;
    let mut results = Vec::new();
    for item in extract_items(&value).into_iter().take(limit) {
        let fragment = if item.fid.is_empty() {
            String::new()
        } else {
            match rpc(
                client,
                &endpoint,
                2,
                "GetFragment",
                json!({"fid": item.fid, "pattern": query}),
                cancellation,
            )
            .await
            {
                Ok(value) => fragment_text(value.get("result").unwrap_or(&Value::Null)),
                Err(error) if error.is_cancelled() => return Err(error),
                Err(_) => String::new(),
            }
        };
        let snippet = if fragment.trim().is_empty() {
            &item.snippet
        } else {
            &fragment
        };
        results.push(ResearchSource {
            title: item.title,
            url: file_url_for_path(&item.path),
            snippet: trim_text(snippet, 1200),
            source: "AnyTXT".into(),
        });
    }
    Ok(results)
}

async fn rpc(
    client: &Client,
    endpoint: &str,
    id: usize,
    method: &str,
    input: Value,
    cancellation: &CancellationToken,
) -> Result<Value, WikiFailure> {
    let value = request_json(
        client
            .post(endpoint)
            .header("Accept", "application/json")
            .json(&json!({
                "id": id, "jsonrpc": "2.0", "method": format!("ATRpcServer.Searcher.V1.{method}"),
                "params": { "input": input },
            })),
        "AnyTXT search",
        cancellation,
    )
    .await?;
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return Err(WikiFailure::state(
            "AnyTXT returned an RPC error; check the service and search configuration",
        ));
    }
    Ok(value)
}

struct AnyTxtItem {
    fid: String,
    title: String,
    path: String,
    snippet: String,
}

fn extract_items(value: &Value) -> Vec<AnyTxtItem> {
    let result = value.get("result").unwrap_or(value);
    let candidates = first_array(
        result,
        &[
            &[],
            &["items"],
            &["files"],
            &["results"],
            &["list"],
            &["value"],
            &["data"],
            &["output"],
            &["output", "items"],
            &["output", "files"],
            &["output", "results"],
            &["output", "list"],
            &["output", "value"],
            &["output", "data"],
            &["data", "items"],
            &["data", "files"],
            &["data", "results"],
            &["data", "list"],
            &["data", "value"],
            &["data", "output"],
            &["data", "output", "items"],
            &["data", "output", "files"],
            &["data", "output", "results"],
            &["data", "output", "list"],
            &["data", "output", "value"],
        ],
    );
    let fields = [
        &["field"][..],
        &["fields"],
        &["output", "field"],
        &["output", "fields"],
        &["data", "field"],
        &["data", "fields"],
        &["data", "output", "field"],
        &["data", "output", "fields"],
    ]
    .iter()
    .filter_map(|path| at_path(result, path).and_then(Value::as_array))
    .map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    })
    .find(|items| !items.is_empty())
    .unwrap_or_default();
    candidates
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let record = match item {
                Value::Object(object) => object.clone(),
                Value::Array(row) if !fields.is_empty() => {
                    fields.iter().cloned().zip(row.iter().cloned()).collect()
                }
                other => Map::from_iter([("text".into(), other.clone())]),
            };
            let fid = string_field(&record, &["fid", "id", "fileId", "file_id"]);
            let raw_path = string_field(
                &record,
                &[
                    "path",
                    "file",
                    "filePath",
                    "file_path",
                    "fullPath",
                    "full_path",
                    "filename",
                    "fileName",
                    "name",
                ],
            );
            let path = if raw_path.is_empty() && !fid.is_empty() {
                format!("anytxt://{fid}")
            } else {
                raw_path
            };
            let title = string_field(&record, &["title", "name", "fileName", "filename"]);
            let title = if title.is_empty() {
                Path::new(&path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("AnyTXT result")
                    .to_owned()
            } else {
                title
            };
            let snippet = string_field(
                &record,
                &[
                    "snippet",
                    "fragment",
                    "content",
                    "contents",
                    "text",
                    "summary",
                    "highlight",
                    "hitText",
                    "hit_text",
                ],
            );
            if path.is_empty() && snippet.is_empty() {
                None
            } else {
                Some(AnyTxtItem {
                    fid,
                    title,
                    path,
                    snippet,
                })
            }
        })
        .collect()
}

fn first_array<'a>(value: &'a Value, paths: &[&[&str]]) -> Option<&'a Vec<Value>> {
    paths
        .iter()
        .find_map(|path| at_path(value, path).and_then(Value::as_array))
}

fn at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

fn string_field(record: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        let Some(value) = record.get(*key) else {
            continue;
        };
        if let Some(value) = value.as_str().filter(|value| !value.trim().is_empty()) {
            return value.trim().to_owned();
        }
        if let Some(value) = value.as_i64() {
            return value.to_string();
        }
        if let Some(value) = value.as_u64() {
            return value.to_string();
        }
    }
    String::new()
}

fn fragment_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(fragment_text)
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    for key in ["text", "fragment", "content", "snippet", "html"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            return text.to_owned();
        }
    }
    for key in ["output", "result", "data", "fragments", "items", "list"] {
        if let Some(value) = value.get(key) {
            let text = fragment_text(value);
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn file_url_for_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.contains("://") {
        return normalized;
    }
    if normalized.starts_with("//") {
        return format!("file:{normalized}");
    }
    let encoded = || {
        normalized
            .split('/')
            .map(|segment| {
                let mut output = String::new();
                for byte in segment.as_bytes() {
                    if byte.is_ascii_alphanumeric()
                        || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b':')
                    {
                        output.push(*byte as char);
                    } else {
                        output.push_str(&format!("%{byte:02X}"));
                    }
                }
                output
            })
            .collect::<Vec<_>>()
            .join("/")
    };
    if normalized.len() >= 3
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
        && normalized.as_bytes()[0].is_ascii_alphabetic()
    {
        return format!("file:///{}", encoded());
    }
    if normalized.starts_with('/') {
        return format!("file://{}", encoded());
    }
    normalized
}
