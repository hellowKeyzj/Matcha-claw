use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::config_store::OpenClawConfigDocument;
use crate::driver::search::{SearchConfig, SearchError};
use platform::state_dir::CanonicalStateDir;

pub(crate) fn link_plugin(
    state: &CanonicalStateDir,
    openclaw_root: &std::path::Path,
) -> Result<(), SearchError> {
    if super::plugins::link_search_plugin(state, openclaw_root).map_err(|_| SearchError::Config)? {
        Ok(())
    } else {
        Err(SearchError::Config)
    }
}

const BACKUP: &str = "search-native-selection.json";
const MAX_BACKUP: usize = 65_536;
const PATHS: &[&str] = &[
    "/tools/web/search/provider",
    "/tools/web/search/enabled",
    "/plugins/entries/searxng/enabled",
    "/plugins/entries/searxng/config/webSearch/baseUrl",
    "/plugins/entries/searxng/config/webSearch/categories",
    "/plugins/entries/searxng/config/webSearch/language",
    "/plugins/entries/searxng/config/webSearch/engines",
    "/plugins/entries/searxng/config/webSearch/safeSearch",
    "/plugins/entries/searxng/config/webSearch/resultCount",
    "/plugins/entries/searxng/config/webSearch/revision",
];

#[derive(Serialize, Deserialize)]
struct Selection {
    previous: Vec<Option<Value>>,
    applied: Vec<Option<Value>>,
}

pub(crate) fn validate(config: &SearchConfig) -> Result<(), SearchError> {
    let url = reqwest::Url::parse(&config.base_url).map_err(|_| SearchError::InvalidInput)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || config.safe_search > 2
        || !(1..=10).contains(&config.result_count)
        || config.revision.is_empty()
        || config.revision.len() > 256
        || config.categories.len() > 4096
        || config.language.len() > 128
        || config
            .engines
            .as_ref()
            .is_some_and(|v| v.trim().is_empty() || v.len() > 4096)
    {
        return Err(SearchError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn check_policy(document: &Value) -> Result<(), SearchError> {
    let listed = |key: &str| {
        document
            .pointer(key)
            .and_then(Value::as_array)
            .map(|ids| ids.iter().any(|id| id.as_str() == Some("searxng")))
            .unwrap_or(false)
    };
    let restricted = document
        .pointer("/plugins/allow")
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty());
    let reason = if document
        .pointer("/plugins/enabled")
        .and_then(Value::as_bool)
        == Some(false)
    {
        Some("plugins_disabled")
    } else if listed("/plugins/deny") {
        Some("plugin_denied")
    } else if restricted && !listed("/plugins/allow") {
        Some("not_allowlisted")
    } else {
        None
    };
    if let Some(reason) = reason {
        platform::trace::runtime_trace(
            "runtime.search.openclaw.policy-denied",
            || json!({"reason": reason}),
        );
        return Err(SearchError::PolicyDenied);
    }
    Ok(())
}

pub(crate) fn apply(
    state: &CanonicalStateDir,
    document: &mut OpenClawConfigDocument,
    config: Option<&SearchConfig>,
    authorize: bool,
) -> Result<bool, SearchError> {
    let current = document.as_value();
    let saved = state
        .read_regular_file_bounded(BACKUP, MAX_BACKUP)
        .map_err(|_| SearchError::Config)?
        .map(|bytes| serde_json::from_slice::<Selection>(&bytes).map_err(|_| SearchError::Config))
        .transpose()?;
    if saved
        .as_ref()
        .is_some_and(|s| s.previous.len() != PATHS.len() || s.applied.len() != PATHS.len())
    {
        return Err(SearchError::Config);
    }
    let mut target = current.clone();
    if let Some(config) = config {
        if authorize
            && let Some(allow) = target
                .pointer_mut("/plugins/allow")
                .and_then(Value::as_array_mut)
            && !allow.is_empty()
            && !allow.iter().any(|id| id.as_str() == Some("searxng"))
        {
            allow.push(json!("searxng"));
            platform::trace::runtime_trace(
                "runtime.search.openclaw.allow-staged",
                || json!({"reason": "not_allowlisted", "authorized": authorize}),
            );
        }
        check_policy(&target)?;
        let values = vec![
            Some(json!("searxng")),
            Some(json!(true)),
            Some(json!(true)),
            Some(json!(config.base_url)),
            Some(json!(config.categories)),
            Some(json!(config.language)),
            config.engines.as_ref().map(|v| json!(v)),
            Some(json!(config.safe_search)),
            Some(json!(config.result_count)),
            Some(json!(config.revision)),
        ];
        let fresh = PATHS
            .iter()
            .map(|path| current.pointer(path).cloned())
            .collect::<Vec<_>>();
        let previous = match saved {
            Some(saved)
                if current
                    .pointer("/tools/web/search/provider")
                    .and_then(Value::as_str)
                    == Some("searxng")
                    && fresh != saved.previous =>
            {
                saved.previous
            }
            _ => fresh,
        };
        for (path, value) in PATHS.iter().zip(&values) {
            set(
                &mut target,
                &path[1..].split('/').collect::<Vec<_>>(),
                value.clone(),
            )?;
        }
        let saved = serde_json::to_vec(&Selection {
            previous,
            applied: values,
        })
        .map_err(|_| SearchError::Config)?;
        if state
            .read_regular_file_bounded(BACKUP, MAX_BACKUP)
            .map_err(|_| SearchError::Config)?
            .as_deref()
            != Some(saved.as_slice())
        {
            state
                .replace_regular_file_bounded(BACKUP, &saved, MAX_BACKUP)
                .map_err(|_| SearchError::Config)?;
        }
    } else if let Some(saved) = saved {
        for ((path, applied), previous) in PATHS.iter().zip(saved.applied).zip(saved.previous) {
            if current.pointer(path) == applied.as_ref() {
                set(
                    &mut target,
                    &path[1..].split('/').collect::<Vec<_>>(),
                    previous,
                )?;
            }
        }
    }
    let changed = current != target;
    if changed {
        *document = OpenClawConfigDocument::from_value(target).map_err(|_| SearchError::Config)?;
    }
    Ok(changed)
}

fn set(root: &mut Value, path: &[&str], value: Option<Value>) -> Result<(), SearchError> {
    let object = root.as_object_mut().ok_or(SearchError::Config)?;
    if path.len() == 1 {
        if let Some(value) = value {
            object.insert(path[0].into(), value);
        } else {
            object.remove(path[0]);
        }
    } else {
        if !object.contains_key(path[0]) {
            if value.is_none() {
                return Ok(());
            }
            object.insert(path[0].into(), Value::Object(Map::new()));
        }
        let child = object.get_mut(path[0]).ok_or(SearchError::Config)?;
        set(child, &path[1..], value)?;
        if child.as_object().is_some_and(Map::is_empty) {
            object.remove(path[0]);
        }
    }
    Ok(())
}
