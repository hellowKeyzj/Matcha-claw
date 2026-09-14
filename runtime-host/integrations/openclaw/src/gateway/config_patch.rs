use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value};

pub(crate) const MAX_REPLACE_PATHS: usize = 256;

pub(crate) fn encode_request(
    request_id: &str,
    raw: &str,
    base_hash: Option<&str>,
    replace_paths: &[String],
) -> Result<String, serde_json::Error> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        raw: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_hash: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        replace_paths: Option<&'a [String]>,
    }
    #[derive(Serialize)]
    struct Frame<'a> {
        r#type: &'static str,
        id: &'a str,
        method: &'static str,
        params: Params<'a>,
    }

    serde_json::to_string(&Frame {
        r#type: "req",
        id: request_id,
        method: "config.patch",
        params: Params {
            raw,
            base_hash,
            replace_paths: (!replace_paths.is_empty()).then_some(replace_paths),
        },
    })
}

pub(crate) fn request_parts_are_valid(
    request_id: &str,
    raw: &[u8],
    base_hash: Option<&[u8]>,
    replace_paths: &[String],
) -> bool {
    !request_id.is_empty()
        && !raw.is_empty()
        && base_hash.is_none_or(|value| !value.is_empty())
        && valid_replace_paths(replace_paths)
}

fn valid_replace_paths(paths: &[String]) -> bool {
    paths.len() <= MAX_REPLACE_PATHS && paths.iter().all(|path| !path.is_empty())
}

pub(crate) fn merge_patch(current: &Value, target: &Value) -> Value {
    let (Some(current), Some(target)) = (current.as_object(), target.as_object()) else {
        return target.clone();
    };
    let mut patch = Map::new();
    for (key, target_value) in target {
        match current.get(key) {
            Some(current_value) if current_value == target_value => {}
            Some(current_value) if current_value.is_object() && target_value.is_object() => {
                let value = merge_patch(current_value, target_value);
                if !empty_object(&value) {
                    patch.insert(key.clone(), value);
                }
            }
            _ => {
                patch.insert(key.clone(), target_value.clone());
            }
        }
    }
    for key in current.keys() {
        if !target.contains_key(key) {
            patch.insert(key.clone(), Value::Null);
        }
    }
    Value::Object(patch)
}

pub(crate) fn destructive_array_replace_paths(current: &Value, target: &Value) -> Vec<String> {
    destructive_array_replace_paths_at(current, target, "")
}

pub(crate) fn destructive_array_replace_paths_for_runtime_guard(
    source_config: &Value,
    runtime_config: &Value,
    target_source_config: &Value,
    source_patch: &Value,
) -> Vec<String> {
    let mut paths = destructive_array_replace_paths(source_config, target_source_config)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let runtime_target = apply_merge_patch(runtime_config, source_patch);
    paths.extend(destructive_array_replace_paths(
        runtime_config,
        &runtime_target,
    ));
    paths.into_iter().collect()
}

pub(crate) fn destructive_array_replace_paths_at(
    current: &Value,
    target: &Value,
    path: &str,
) -> Vec<String> {
    let mut paths = BTreeSet::new();
    collect_destructive_array_replace_paths(current, Some(target), path, &mut paths);
    paths.into_iter().collect()
}

fn apply_merge_patch(base: &Value, patch: &Value) -> Value {
    let Some(patch) = patch.as_object() else {
        return patch.clone();
    };
    let mut result = base.as_object().cloned().unwrap_or_default();
    for (key, value) in patch {
        if value.is_null() {
            result.remove(key);
        } else if value.is_object() {
            let base = result.get(key).unwrap_or(&Value::Null);
            result.insert(key.clone(), apply_merge_patch(base, value));
        } else {
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}

fn collect_destructive_array_replace_paths(
    current: &Value,
    target: Option<&Value>,
    path: &str,
    paths: &mut BTreeSet<String>,
) {
    match current {
        Value::Array(current) => match target {
            Some(Value::Array(target)) => {
                if !target_array_preserves_existing_entries(current, target) {
                    insert_non_empty_path(paths, path);
                    return;
                }
                collect_id_keyed_entry_array_paths(current, target, path, paths);
            }
            Some(_) | None => {
                insert_non_empty_path(paths, path);
            }
        },
        Value::Object(current) => match target.and_then(Value::as_object) {
            Some(target) => {
                for (key, current) in current {
                    let path = child_dot_path(path, key);
                    collect_destructive_array_replace_paths(current, target.get(key), &path, paths);
                }
            }
            None => collect_existing_array_paths(current, path, paths),
        },
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn collect_existing_array_paths(
    current: &Map<String, Value>,
    path: &str,
    paths: &mut BTreeSet<String>,
) {
    for (key, value) in current {
        let path = child_dot_path(path, key);
        match value {
            Value::Array(_) => {
                paths.insert(path);
            }
            Value::Object(value) => collect_existing_array_paths(value, &path, paths),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
}

fn target_array_preserves_existing_entries(current: &[Value], target: &[Value]) -> bool {
    if current.iter().all(object_with_string_id) {
        let target_ids = target.iter().filter_map(string_id).collect::<BTreeSet<_>>();
        return current
            .iter()
            .filter_map(string_id)
            .all(|current_id| target_ids.contains(current_id));
    }

    let mut unmatched_target = target.to_vec();
    for current_entry in current {
        let Some(match_index) = unmatched_target
            .iter()
            .position(|target_entry| target_entry == current_entry)
        else {
            return false;
        };
        unmatched_target.remove(match_index);
    }
    true
}

fn collect_id_keyed_entry_array_paths(
    current: &[Value],
    target: &[Value],
    path: &str,
    paths: &mut BTreeSet<String>,
) {
    if !current.iter().all(object_with_string_id) {
        return;
    }
    let target_by_id = target
        .iter()
        .filter_map(|entry| Some((string_id(entry)?, entry)))
        .collect::<BTreeMap<_, _>>();
    for current_entry in current {
        let Some(current_id) = string_id(current_entry) else {
            continue;
        };
        let Some(target_entry) = target_by_id.get(current_id) else {
            continue;
        };
        collect_destructive_array_replace_paths(
            current_entry,
            Some(*target_entry),
            &format!("{path}[]"),
            paths,
        );
    }
}

fn object_with_string_id(value: &Value) -> bool {
    string_id(value).is_some()
}

fn string_id(value: &Value) -> Option<&str> {
    value
        .as_object()
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn insert_non_empty_path(paths: &mut BTreeSet<String>, path: &str) {
    if !path.is_empty() {
        paths.insert(path.to_owned());
    }
}

fn empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(|object| object.is_empty())
}

fn child_dot_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_owned()
    } else {
        format!("{parent}.{child}")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn runtime_guard_paths_include_runtime_only_arrays_removed_by_source_patch() {
        let source = json!({"models":{"providers":{"opencode-go":{}}}});
        let runtime = json!({"models":{"providers":{"opencode-go":{"models":[{"id":"legacy","input":["text"]}]}}}});
        let target = json!({"models":{"providers":{}}});
        let patch = merge_patch(&source, &target);

        let paths =
            destructive_array_replace_paths_for_runtime_guard(&source, &runtime, &target, &patch);

        assert_eq!(paths, ["models.providers.opencode-go.models"]);
    }
}
