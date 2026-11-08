use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use platform::state_dir::CanonicalStateDir;
use serde_json::{Value, json};

use crate::{native_config::config_store::OpenClawConfigStore, session::protocol::AgentId};

use super::{MAX_DOCUMENT_BYTES, MAX_ITEMS, file_evidence, io_status, label, version};

pub(super) struct Configuration {
    pub summary: Value,
    pub agents: Vec<AgentDatabase>,
}

pub(super) struct AgentDatabase {
    pub id: String,
    pub path: Option<PathBuf>,
    pub reason: Option<&'static str>,
}

pub(super) fn inspect(state_dir: &CanonicalStateDir, gateway_cwd: &Path) -> Configuration {
    let mut summary = file_evidence(&state_dir.as_path().join("openclaw.json"));
    summary["coverage"] = json!({
        "parser": "hostStrictJsonObject",
        "maxBytes": MAX_DOCUMENT_BYTES,
        "includes": "notExpanded",
        "environmentSubstitution": "notExpanded",
        "nativeSchemaValidation": "notPerformed",
        "summary": "allowlistedFieldsOnly",
        "agentPaths": "canonicalIdsAndLiteralAgentDirOnly",
        "sessionStore": "notResolved; mayUseSeparateOwnedOrSuffixedDatabases"
    });
    if summary["status"] != "present" && summary["status"] != "missing" {
        summary["parse"] = json!({"status": "notRead"});
        return Configuration {
            summary,
            agents: Vec::new(),
        };
    }
    if summary["status"] == "present" {
        if let Err(error) = std::fs::File::open(state_dir.as_path().join("openclaw.json")) {
            summary["parse"] = json!({"status": io_status(&error)});
            return Configuration {
                summary,
                agents: Vec::new(),
            };
        }
    }
    if summary["sizeBytes"]
        .as_u64()
        .is_some_and(|size| size > MAX_DOCUMENT_BYTES)
    {
        summary["parse"] = json!({"status": "tooLarge"});
        return Configuration {
            summary,
            agents: Vec::new(),
        };
    }
    // The native store retains and zeroizes private fields; only the projection below escapes.
    let document = match OpenClawConfigStore::new(state_dir.clone()).read_private() {
        Ok(document) => document,
        Err(error) => {
            summary["parse"] = json!({"status": match error {
                crate::native_config::config_store::OpenClawConfigStoreError::InvalidDocument => "invalidJsonOrNotObject",
                crate::native_config::config_store::OpenClawConfigStoreError::StateDirectoryRejected => "stateDirectoryRejected",
                _ => "readFailed"
            }});
            return Configuration {
                summary,
                agents: Vec::new(),
            };
        }
    };
    summary["parse"] =
        json!({"status": if summary["exists"] == false { "missingDocument" } else { "parsed" }});
    summary["lastTouchedVersion"] = json!(
        document
            .get("meta")
            .and_then(|meta| meta.get("lastTouchedVersion"))
            .and_then(version)
    );
    let gateway = document.get("gateway");
    summary["gateway"] = json!({
        "shape": shape(gateway),
        "mode": identifier(gateway.and_then(|value| value.get("mode"))),
        "bind": identifier(gateway.and_then(|value| value.get("bind"))),
        "configuredPort": gateway.and_then(|value| value.get("port")).and_then(Value::as_u64),
        "authMode": identifier(gateway.and_then(|value| value.pointer("/auth/mode"))),
        "remoteConfigured": gateway.and_then(|value| value.get("remote")).is_some(),
        "tlsEnabled": gateway.and_then(|value| value.pointer("/tls/enabled")).and_then(Value::as_bool),
        "note": "launchPortAndAuthenticationAreDriverOwned"
    });
    let agents = document.get("agents");
    let defaults = agents.and_then(|value| value.get("defaults"));
    summary["models"] = json!({
        "providerKeys": keys(document.get("models").and_then(|value| value.get("providers"))),
        "defaultModel": model(defaults.and_then(|value| value.get("model"))),
        "defaultModelKeys": keys(defaults.and_then(|value| value.get("models")))
    });
    summary["plugins"] = keys(
        document
            .get("plugins")
            .and_then(|value| value.get("entries")),
    );
    summary["channels"] = keys(document.get("channels"));
    summary["sessionStore"] = json!({
        "shape": shape(document.get("session").and_then(|value| value.get("store"))),
        "resolution": "notPerformed"
    });
    let includes = document.get("$include").is_some()
        || [
            "agents", "session", "gateway", "models", "plugins", "channels",
        ]
        .iter()
        .any(|key| document.get(key).is_some_and(has_include));
    summary["coverage"]["includeDirectiveObservedInInspectedSections"] = json!(includes);
    let root_include = document.get("$include").is_some();
    let roster_includes = root_include || agents.is_some_and(has_include);
    let (roster, databases) = roster(agents, state_dir.as_path(), gateway_cwd, roster_includes);
    summary["roster"] = roster;
    Configuration {
        summary,
        agents: databases,
    }
}

fn roster(
    agents: Option<&Value>,
    state_dir: &Path,
    gateway_cwd: &Path,
    unresolved_includes: bool,
) -> (Value, Vec<AgentDatabase>) {
    // Native readAgentRosterProperty chooses the owned entries property even if malformed.
    let (source, entries): (&str, Option<Vec<(&str, &Value)>>) = match agents {
        Some(value) if value.get("entries").is_some() => (
            "entries",
            value
                .get("entries")
                .and_then(Value::as_object)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|(id, value)| (id.as_str(), value))
                        .collect()
                }),
        ),
        Some(value) if value.get("list").is_some() => (
            "list",
            value.get("list").and_then(Value::as_array).map(|entries| {
                entries
                    .iter()
                    .map(|entry| (entry.get("id").and_then(Value::as_str).unwrap_or(""), entry))
                    .collect()
            }),
        ),
        Some(value) if !value.is_object() => ("invalidAgents", None),
        _ if unresolved_includes => ("unresolvedIncludes", None),
        _ => {
            return (
                json!({"source": "nativeImplicitMain", "count": 1}),
                vec![AgentDatabase {
                    id: "main".into(),
                    path: Some(state_dir.join("agents/main/agent/openclaw-agent.sqlite")),
                    reason: None,
                }],
            );
        }
    };
    let Some(entries) = entries else {
        return (
            json!({"source": source, "status": "unresolvedOrInvalidShape"}),
            Vec::new(),
        );
    };
    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    for (id, _) in &entries {
        let normalized = id.trim().to_ascii_lowercase();
        if !seen.insert(normalized.clone()) {
            duplicates.insert(normalized);
        }
    }
    let mut summaries = Vec::new();
    let mut databases = Vec::new();
    for (id, entry) in entries.iter().take(MAX_ITEMS) {
        let normalized = id.trim().to_ascii_lowercase();
        let canonical = AgentId::try_new(normalized.clone()).is_ok();
        let duplicate = duplicates.contains(&normalized);
        let reason = if !entry.is_object() {
            Some("invalidEntryShape")
        } else if !canonical {
            Some("nonCanonicalAgentIdNotResolved")
        } else if duplicate {
            Some("duplicateNormalizedAgentId")
        } else if unresolved_includes {
            Some("unexpandedIncludesMayAffectAgentPath")
        } else {
            None
        };
        let configured_dir = entry.get("agentDir");
        let path = if reason.is_some() {
            Err(reason.unwrap())
        } else {
            agent_directory(configured_dir, state_dir, gateway_cwd, &normalized)
        };
        summaries.push(json!({
            "id": label(id), "normalizedId": canonical.then_some(&normalized),
            "shape": shape(Some(entry)),
            "model": model(entry.get("model")),
            "agentDirShape": shape(configured_dir),
            "databasePathCoverage": path.as_ref().map(|_| "resolvedLiteralPath").unwrap_or_else(|reason| reason)
        }));
        databases.push(AgentDatabase {
            id: normalized,
            path: path.as_ref().ok().cloned(),
            reason: path.err(),
        });
    }
    (
        json!({
            "source": source, "count": entries.len(), "entries": summaries,
            "truncated": entries.len() > MAX_ITEMS, "limit": MAX_ITEMS,
            "bothPresent": agents.is_some_and(|value| value.get("entries").is_some() && value.get("list").is_some()),
            "precedence": "ownedEntriesBeforeList",
            "coverage": "noNativeNormalizationOfInvalidIdsOrIncludeExpansion"
        }),
        databases,
    )
}

fn agent_directory(
    configured: Option<&Value>,
    state_dir: &Path,
    gateway_cwd: &Path,
    id: &str,
) -> Result<PathBuf, &'static str> {
    let Some(configured) = configured else {
        return Ok(state_dir
            .join("agents")
            .join(id)
            .join("agent/openclaw-agent.sqlite"));
    };
    let Some(directory) = configured.as_str() else {
        return Err("invalidAgentDirShape");
    };
    let directory = directory.trim();
    if directory.is_empty() {
        return Ok(state_dir
            .join("agents")
            .join(id)
            .join("agent/openclaw-agent.sqlite"));
    }
    if directory.starts_with('~') || directory.contains("${") {
        return Err("homeOrEnvironmentPathNotExpanded");
    }
    if directory.contains('\0') || directory.len() > 4096 {
        return Err("invalidOrOversizedAgentDir");
    }
    let directory = Path::new(directory);
    // A drive-relative Windows path needs native resolution; never anchor it to a guessed cwd.
    if !directory.is_absolute()
        && directory.components().any(|part| {
            matches!(
                part,
                std::path::Component::Prefix(_) | std::path::Component::RootDir
            )
        })
    {
        return Err("platformRelativePathNotResolved");
    }
    Ok(gateway_cwd.join(directory).join("openclaw-agent.sqlite"))
}

fn keys(value: Option<&Value>) -> Value {
    let Some(object) = value.and_then(Value::as_object) else {
        return json!({"shape": shape(value)});
    };
    json!({"shape": "object", "count": object.len(), "keys": object.keys().take(MAX_ITEMS).map(|key| label(key)).collect::<Vec<_>>(), "truncated": object.len() > MAX_ITEMS})
}

fn model(value: Option<&Value>) -> Value {
    json!({
        "shape": shape(value),
        "primary": identifier(value.and_then(|model| if model.is_string() { Some(model) } else { model.get("primary") })),
        "fallbackCount": value.and_then(|model| model.get("fallbacks")).and_then(Value::as_array).map(Vec::len)
    })
}

fn identifier(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map(label)
        .unwrap_or(Value::Null)
}

fn has_include(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object.contains_key("$include") || object.values().any(has_include)
        }
        Value::Array(values) => values.iter().any(has_include),
        _ => false,
    }
}

fn shape(value: Option<&Value>) -> &'static str {
    match value {
        None => "absent",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
