use super::*;

impl ConfigSnapshot {
    pub(crate) fn patch_agents(
        self,
        patches: Vec<ConfigAgentPatch>,
    ) -> Result<ConfigPatch, WireError> {
        if !self.valid || self.base_hash.is_none() {
            return Err(WireError::InvalidConfigGet);
        }
        let (mut document, base_hash) = self.into_source_config_parts();
        let entries = agent_entries_mut(&mut document)?;
        let mut restore_facts = Vec::with_capacity(patches.len());
        for patch in patches {
            restore_facts.push(patch.apply(entries)?);
        }
        Ok(ConfigPatch {
            raw: config_document(&document)?,
            base_hash,
            restore_facts: ConfigRestoreFacts(restore_facts),
        })
    }

    pub(crate) fn matches_agents(&self, facts: &ConfigRestoreFacts) -> bool {
        let entries = self
            .source_config
            .pointer("/agents/entries")
            .and_then(Value::as_object);
        self.valid
            && facts.0.iter().all(|fact| {
                entries.and_then(|entries| entries.get(&fact.agent_id))
                    == Some(&fact.expected_entry)
            })
    }

    pub(crate) fn prepare_restore(
        self,
        facts: ConfigRestoreFacts,
    ) -> Result<ConfigRestorePreparation, WireError> {
        self.prepare_agent_restore(facts, true)
    }

    pub(crate) fn prepare_external_restore(
        self,
        facts: ConfigRestoreFacts,
    ) -> Result<ConfigRestorePreparation, WireError> {
        self.prepare_agent_restore(facts, false)
    }

    fn prepare_agent_restore(
        self,
        facts: ConfigRestoreFacts,
        expected_fence: bool,
    ) -> Result<ConfigRestorePreparation, WireError> {
        if !self.valid {
            return Err(WireError::InvalidConfigGet);
        }
        let (source_config, runtime_config, Some(base_hash)) =
            self.into_source_and_runtime_config_parts()
        else {
            return Ok(ConfigRestorePreparation::Fenced);
        };
        let mut document = source_config.clone();
        let entries = agent_entries_mut(&mut document)?;
        let mut restored = false;
        let mut removals = serde_json::Map::new();
        for fact in facts.0.into_iter().filter(|fact| fact.external) {
            let current = entries.get(&fact.agent_id);
            if current == fact.prior_entry.as_ref() {
                continue;
            }
            if expected_fence && current != Some(&fact.expected_entry) {
                return Ok(ConfigRestorePreparation::Fenced);
            }
            match fact.prior_entry {
                Some(prior) => {
                    entries.insert(fact.agent_id, prior);
                    restored = true;
                }
                None => {
                    removals.insert(fact.agent_id, Value::Null);
                }
            }
        }
        if !restored && removals.is_empty() {
            return Ok(ConfigRestorePreparation::Restored);
        }
        let request_id = format!("team-config-restore-{}", next_restore_request_id());
        // Native set replaces objects exactly but cannot remove agent IDs. A mixed
        // restore first replaces existing entries, then removes absent entries.
        let request = if restored {
            ConfigRestoreRequest::Set(config_set_request(
                request_id,
                config_document(&document)?,
                Some(base_hash),
            )?)
        } else {
            for agent in removals.keys() {
                agent_entries_mut(&mut document)?.remove(agent);
            }
            let patch = serde_json::json!({"agents": {"entries": removals}});
            let replace_paths =
                crate::gateway::config_patch::destructive_array_replace_paths_for_runtime_guard(
                    &source_config,
                    &runtime_config,
                    &document,
                    &patch,
                );
            ConfigRestoreRequest::Patch(config_patch_request(
                request_id,
                config_document(&patch)?,
                Some(base_hash),
                replace_paths,
            )?)
        };
        Ok(ConfigRestorePreparation::Ready { request })
    }
}

fn config_document(document: &Value) -> Result<ConfigDocument, WireError> {
    ConfigDocument::new(
        serde_json::to_string(document).map_err(|_| WireError::InvalidConfigSetRequest)?,
    )
}

fn agent_entries_mut(
    document: &mut Value,
) -> Result<&mut serde_json::Map<String, Value>, WireError> {
    document
        .as_object_mut()
        .ok_or(WireError::InvalidConfigGet)?
        .entry("agents")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or(WireError::InvalidConfigGet)?
        .entry("entries")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or(WireError::InvalidConfigGet)
}

pub(crate) struct ConfigAgentPatch {
    agent_id: String,
    managed: Option<(String, String)>,
    tools: Vec<String>,
}

impl ConfigAgentPatch {
    pub(crate) fn new(agent_id: String, name: String, workspace: String) -> Self {
        Self {
            agent_id,
            managed: Some((name, workspace)),
            tools: Vec::new(),
        }
    }

    pub(crate) fn external(agent_id: String) -> Self {
        Self {
            agent_id,
            managed: None,
            tools: Vec::new(),
        }
    }

    pub(crate) fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.tools = tools;
        self
    }

    fn apply(
        self,
        entries: &mut serde_json::Map<String, Value>,
    ) -> Result<ConfigRestoreFact, WireError> {
        if !valid_string(&self.agent_id) {
            return Err(WireError::InvalidConfigSetRequest);
        }
        let prior_entry = entries.get(&self.agent_id).cloned();
        let mut entry = match &prior_entry {
            Some(Value::Object(entry)) => entry.clone(),
            None => Default::default(),
            _ => return Err(WireError::InvalidConfigSetRequest),
        };
        let external = self.managed.is_none();
        // Native redaction cannot reconstruct secrets after their subtree is replaced.
        if external
            && ["tools", "sandbox"]
                .iter()
                .filter_map(|key| entry.get(*key))
                .any(contains_redacted_value)
        {
            return Err(WireError::InvalidConfigSetRequest);
        }
        if let Some((name, workspace)) = self.managed {
            if !valid_string(&name) || !valid_string(&workspace) {
                return Err(WireError::InvalidConfigSetRequest);
            }
            entry.insert("name".into(), Value::String(name));
            entry.insert("workspace".into(), Value::String(workspace));
        }
        let mut tools = serde_json::json!({
            "profile": "full", "deny": ["sessions_spawn", "sessions_yield", "subagents"]
        });
        if !self.tools.is_empty() {
            tools["alsoAllow"] = serde_json::json!(self.tools);
        }
        entry.insert("tools".into(), tools);
        entry.insert("sandbox".into(), serde_json::json!({"mode": "off"}));
        let expected_entry = Value::Object(entry);
        entries.insert(self.agent_id.clone(), expected_entry.clone());
        Ok(ConfigRestoreFact {
            agent_id: self.agent_id,
            expected_entry,
            prior_entry,
            external,
        })
    }
}

fn contains_redacted_value(value: &Value) -> bool {
    match value {
        Value::String(value) => value == "__OPENCLAW_REDACTED__",
        Value::Array(values) => values.iter().any(contains_redacted_value),
        Value::Object(values) => values.values().any(contains_redacted_value),
        _ => false,
    }
}

impl fmt::Debug for ConfigAgentPatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConfigAgentPatch([REDACTED])")
    }
}

pub(crate) struct ConfigPatch {
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
    restore_facts: ConfigRestoreFacts,
}

impl ConfigPatch {
    pub(crate) fn into_parts(self) -> (ConfigDocument, Option<ConfigBaseHash>, ConfigRestoreFacts) {
        (self.raw, self.base_hash, self.restore_facts)
    }
}

pub(crate) struct ConfigRestoreFacts(Vec<ConfigRestoreFact>);

#[derive(Serialize, Deserialize)]
struct ConfigRestoreFact {
    agent_id: String,
    expected_entry: Value,
    prior_entry: Option<Value>,
    external: bool,
}

impl ConfigRestoreFacts {
    pub(crate) fn to_private_value(&self) -> Result<Value, WireError> {
        serde_json::to_value(&self.0).map_err(|_| WireError::InvalidConfigSetRequest)
    }

    pub(crate) fn from_private_value(value: Value) -> Result<Self, WireError> {
        serde_json::from_value(value)
            .map(Self)
            .map_err(|_| WireError::InvalidConfigGet)
    }
}

pub(crate) enum ConfigRestoreRequest {
    Set(ConfigSetRequest),
    Patch(ConfigPatchRequest),
}

impl ConfigRestoreRequest {
    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::Set(request) => request.request_id(),
            Self::Patch(request) => request.request_id(),
        }
    }

    pub(crate) fn encode(&self) -> Result<String, WireError> {
        match self {
            Self::Set(request) => request.encode(),
            Self::Patch(request) => request.encode(),
        }
    }
}

pub(crate) enum ConfigRestorePreparation {
    Restored,
    Ready { request: ConfigRestoreRequest },
    Fenced,
}
