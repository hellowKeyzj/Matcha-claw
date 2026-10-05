use serde_json::{Map, Value};

use super::config_store::OpenClawConfigDocument;

const DEFAULT_OWNER_AGENT_ID: &str = "main";
const AGENT_ID_FIELD: &str = "agentId";
const SYSTEM_AGENT_FIELD: &str = "systemAgent";
const SESSION_STORE_FIELD: &str = "sessionStore";
const BOOTSTRAP_MAX_CHARS: u64 = 32_000;
const BOOTSTRAP_TOTAL_MAX_CHARS: u64 = 100_000;
const STARTUP_TOOL_DENY: &[&str] = &[
    "skill_workshop",
    "gateway",
    "nodes",
    "progress_card",
    "suggest_task",
    "dismiss_task",
];

pub(crate) fn apply_gateway_startup_defaults(document: &mut OpenClawConfigDocument) -> bool {
    let agent_defaults_changed = apply_agent_defaults(document);
    let tool_defaults_changed = apply_tool_defaults(document);
    agent_defaults_changed || tool_defaults_changed
}

fn apply_agent_defaults(document: &mut OpenClawConfigDocument) -> bool {
    let mut agents = object(document.get("agents"));
    let agent_id = owner_agent_id(&agents);
    let mut defaults = object(agents.get("defaults"));
    let mut changed = false;
    changed |= ensure_owner(&mut defaults, SYSTEM_AGENT_FIELD, &agent_id);
    changed |= ensure_owner(&mut defaults, SESSION_STORE_FIELD, &agent_id);
    changed |= ensure_min_u64(&mut defaults, "bootstrapMaxChars", BOOTSTRAP_MAX_CHARS);
    changed |= ensure_min_u64(
        &mut defaults,
        "bootstrapTotalMaxChars",
        BOOTSTRAP_TOTAL_MAX_CHARS,
    );
    changed |= replace(&mut defaults, "skipBootstrap", Value::Bool(true));
    changed |= ensure_compaction_defaults(&mut defaults);
    changed |= ensure_heartbeat_defaults(&mut defaults);
    if !changed {
        return false;
    }
    agents.insert("defaults".into(), Value::Object(defaults));
    document.insert("agents".into(), Value::Object(agents));
    true
}

fn apply_tool_defaults(document: &mut OpenClawConfigDocument) -> bool {
    let mut tools = object(document.get("tools"));
    let mut sessions = object(tools.get("sessions"));
    let mut changed = replace(&mut tools, "profile", Value::String("full".into()));
    if replace(&mut sessions, "visibility", Value::String("all".into())) {
        tools.insert("sessions".into(), Value::Object(sessions));
        changed = true;
    }
    changed |= ensure_tool_denies(&mut tools);
    if !changed {
        return false;
    }
    document.insert("tools".into(), Value::Object(tools));
    true
}

fn owner_agent_id(agents: &Map<String, Value>) -> String {
    configured_owner_agent_id(agents, SYSTEM_AGENT_FIELD)
        .or_else(|| configured_owner_agent_id(agents, SESSION_STORE_FIELD))
        .or_else(|| marked_default_agent_id(agents))
        .or_else(|| sole_agent_id(agents))
        .unwrap_or_else(|| DEFAULT_OWNER_AGENT_ID.to_owned())
}

fn ensure_owner(defaults: &mut Map<String, Value>, field: &str, agent_id: &str) -> bool {
    let mut owner = object(defaults.get(field));
    if owner
        .get(AGENT_ID_FIELD)
        .and_then(Value::as_str)
        .and_then(canonical_agent_id)
        .is_some()
    {
        return false;
    }
    owner.insert(AGENT_ID_FIELD.into(), Value::String(agent_id.to_owned()));
    defaults.insert(field.into(), Value::Object(owner));
    true
}

fn ensure_min_u64(target: &mut Map<String, Value>, field: &str, minimum: u64) -> bool {
    if target
        .get(field)
        .and_then(Value::as_u64)
        .is_some_and(|current| current >= minimum)
    {
        return false;
    }
    target.insert(field.into(), Value::from(minimum));
    true
}

fn ensure_compaction_defaults(defaults: &mut Map<String, Value>) -> bool {
    match defaults.get_mut("compaction") {
        Some(Value::Object(compaction)) => {
            let changed = ensure_string_if_missing(compaction, "mode", "safeguard");
            changed | ensure_mid_turn_precheck(compaction)
        }
        Some(_) => false,
        None => {
            defaults.insert(
                "compaction".into(),
                Value::Object(Map::from_iter([
                    ("mode".into(), Value::String("safeguard".into())),
                    (
                        "midTurnPrecheck".into(),
                        Value::Object(Map::from_iter([("enabled".into(), Value::Bool(true))])),
                    ),
                ])),
            );
            true
        }
    }
}

fn ensure_heartbeat_defaults(defaults: &mut Map<String, Value>) -> bool {
    match defaults.get_mut("heartbeat") {
        Some(Value::Object(heartbeat)) => {
            let changed = ensure_string_if_missing(heartbeat, "target", "none");
            changed | ensure_string_if_missing(heartbeat, "every", "0m")
        }
        Some(_) => false,
        None => {
            defaults.insert(
                "heartbeat".into(),
                Value::Object(Map::from_iter([
                    ("target".into(), Value::String("none".into())),
                    ("every".into(), Value::String("0m".into())),
                ])),
            );
            true
        }
    }
}

fn ensure_string_if_missing(target: &mut Map<String, Value>, field: &str, value: &str) -> bool {
    if target.contains_key(field) {
        return false;
    }
    target.insert(field.into(), Value::String(value.into()));
    true
}

fn ensure_mid_turn_precheck(compaction: &mut Map<String, Value>) -> bool {
    match compaction.get_mut("midTurnPrecheck") {
        Some(Value::Object(precheck)) if !precheck.contains_key("enabled") => {
            precheck.insert("enabled".into(), Value::Bool(true));
            true
        }
        Some(_) => false,
        None => {
            compaction.insert(
                "midTurnPrecheck".into(),
                Value::Object(Map::from_iter([("enabled".into(), Value::Bool(true))])),
            );
            true
        }
    }
}

fn ensure_tool_denies(tools: &mut Map<String, Value>) -> bool {
    let existing = tools.get("deny");
    let mut deny: Vec<Value> = existing
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(|text| Value::String(text.into())))
        .collect();
    for tool in STARTUP_TOOL_DENY {
        if !deny.iter().any(|value| value.as_str() == Some(tool)) {
            deny.push(Value::String((*tool).into()));
        }
    }
    let next = Value::Array(deny);
    if existing == Some(&next) {
        return false;
    }
    tools.insert("deny".into(), next);
    true
}

fn configured_owner_agent_id(agents: &Map<String, Value>, field: &str) -> Option<String> {
    agents
        .get("defaults")
        .and_then(Value::as_object)
        .and_then(|defaults| defaults.get(field))
        .and_then(Value::as_object)
        .and_then(|owner| owner.get(AGENT_ID_FIELD))
        .and_then(Value::as_str)
        .and_then(canonical_agent_id)
}

fn marked_default_agent_id(agents: &Map<String, Value>) -> Option<String> {
    let mut selected = None;
    let mut count = 0;
    for (agent_id, entry) in agent_entries(agents) {
        if entry
            .get("default")
            .or_else(|| entry.get("isDefault"))
            .and_then(Value::as_bool)
            .is_some_and(|value| value)
            && let Some(agent_id) = canonical_agent_id(&agent_id)
        {
            selected = Some(agent_id);
            count += 1;
        }
    }
    (count == 1).then_some(selected).flatten()
}

fn sole_agent_id(agents: &Map<String, Value>) -> Option<String> {
    let mut selected = None;
    let mut count = 0;
    for (agent_id, _) in agent_entries(agents) {
        let Some(agent_id) = canonical_agent_id(&agent_id) else {
            continue;
        };
        if selected.as_ref() != Some(&agent_id) {
            selected = Some(agent_id);
            count += 1;
        }
    }
    (count == 1).then_some(selected).flatten()
}

fn agent_entries(agents: &Map<String, Value>) -> Vec<(String, Map<String, Value>)> {
    if let Some(entries) = agents.get("entries").and_then(Value::as_object) {
        return entries
            .iter()
            .filter_map(|(id, entry)| Some((id.clone(), entry.as_object()?.clone())))
            .collect();
    }
    agents
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|entry| Some((entry.get("id")?.as_str()?.to_owned(), entry.clone())))
        .collect()
}

fn canonical_agent_id(value: &str) -> Option<String> {
    let value = value.trim();
    let mut bytes = value.bytes();
    let first = bytes.next()?;
    if value.len() > 64 || !first.is_ascii_alphanumeric() {
        return None;
    }
    bytes
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        .then(|| value.to_ascii_lowercase())
}

fn replace(target: &mut Map<String, Value>, key: &str, value: Value) -> bool {
    if target.get(key) == Some(&value) {
        return false;
    }
    target.insert(key.into(), value);
    true
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
