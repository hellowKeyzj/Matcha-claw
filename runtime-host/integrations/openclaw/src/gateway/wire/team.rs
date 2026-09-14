use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::gateway::config_patch::{
    encode_request as encode_config_patch_request, request_parts_are_valid,
};

use super::{
    GatewayResponse, RpcRequest, WireError, rpc_request, success_payload, valid_optional_string,
    valid_string, valid_strings,
};

#[derive(Serialize)]
struct AgentsCreateParams {
    name: String,
    workspace: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentsUpdateParams {
    agent_id: String,
    name: String,
    workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

pub(crate) fn agents_create_request(
    request_id: String,
    name: String,
    workspace: String,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) || !valid_string(&name) || !valid_string(&workspace) {
        return Err(WireError::InvalidAgentsCreateRequest);
    }
    let params = serde_json::to_value(AgentsCreateParams { name, workspace })
        .map_err(|_| WireError::InvalidAgentsCreateRequest)?;
    rpc_request(request_id, "agents.create", Some(params))
        .map_err(|_| WireError::InvalidAgentsCreateRequest)
}

pub(crate) fn agents_update_request(
    request_id: String,
    agent_id: String,
    name: String,
    workspace: String,
    model: Option<String>,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id)
        || !valid_string(&agent_id)
        || !valid_string(&name)
        || !valid_string(&workspace)
        || !valid_optional_string(&model)
    {
        return Err(WireError::InvalidAgentsUpdateRequest);
    }
    let params = serde_json::to_value(AgentsUpdateParams {
        agent_id,
        name,
        workspace,
        model,
    })
    .map_err(|_| WireError::InvalidAgentsUpdateRequest)?;
    rpc_request(request_id, "agents.update", Some(params))
        .map_err(|_| WireError::InvalidAgentsUpdateRequest)
}

pub(crate) fn agents_delete_request(
    request_id: String,
    agent_id: String,
) -> Result<RpcRequest, WireError> {
    super::agents::delete_request(
        request_id,
        super::agents::AgentDelete::try_new(agent_id, true)?,
    )
}

pub(crate) fn config_get_request(request_id: String) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) {
        return Err(WireError::InvalidConfigGetRequest);
    }
    rpc_request(
        request_id,
        "config.get",
        Some(Value::Object(Default::default())),
    )
    .map_err(|_| WireError::InvalidConfigGetRequest)
}

pub(crate) struct ConfigDocument(Vec<u8>);

impl ConfigDocument {
    pub(crate) fn new(raw: String) -> Result<Self, WireError> {
        if !valid_string(&raw) {
            return Err(WireError::InvalidConfigSetRequest);
        }
        Ok(Self(raw.into_bytes()))
    }

    pub(crate) fn into_bytes(mut self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(std::mem::take(&mut self.0))
    }

    fn as_str(&self) -> Result<&str, WireError> {
        std::str::from_utf8(&self.0).map_err(|_| WireError::EncodeRequest)
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for ConfigDocument {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub(crate) struct ConfigBaseHash(Vec<u8>);

impl ConfigBaseHash {
    fn from_response(hash: String) -> Self {
        Self(hash.into_bytes())
    }

    fn as_str(&self) -> Result<&str, WireError> {
        std::str::from_utf8(&self.0).map_err(|_| WireError::EncodeRequest)
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for ConfigBaseHash {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub(crate) struct ConfigSetRequest {
    request_id: String,
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
}

impl ConfigSetRequest {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn encode(&self) -> Result<String, WireError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params<'a> {
            raw: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            base_hash: Option<&'a str>,
        }
        #[derive(Serialize)]
        struct Frame<'a> {
            r#type: &'static str,
            id: &'a str,
            method: &'static str,
            params: Params<'a>,
        }

        let raw = self.raw.as_str()?;
        let base_hash = self
            .base_hash
            .as_ref()
            .map(ConfigBaseHash::as_str)
            .transpose()?;
        serde_json::to_string(&Frame {
            r#type: "req",
            id: &self.request_id,
            method: "config.set",
            params: Params { raw, base_hash },
        })
        .map_err(|_| WireError::EncodeRequest)
    }
}

impl fmt::Debug for ConfigSetRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigSetRequest")
            .field("request_id", &"[REDACTED]")
            .field("raw", &"[REDACTED]")
            .field("base_hash", &self.base_hash.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

fn next_restore_request_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn config_set_request(
    request_id: String,
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
) -> Result<ConfigSetRequest, WireError> {
    if !valid_string(&request_id)
        || raw.is_empty()
        || base_hash.as_ref().is_some_and(ConfigBaseHash::is_empty)
    {
        return Err(WireError::InvalidConfigSetRequest);
    }
    Ok(ConfigSetRequest {
        request_id,
        raw,
        base_hash,
    })
}

pub(crate) struct ConfigPatchRequest {
    request_id: String,
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
    replace_paths: Vec<String>,
}

impl ConfigPatchRequest {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn encode(&self) -> Result<String, WireError> {
        encode_config_patch_request(
            &self.request_id,
            self.raw.as_str()?,
            self.base_hash
                .as_ref()
                .map(ConfigBaseHash::as_str)
                .transpose()?,
            &self.replace_paths,
        )
        .map_err(|_| WireError::EncodeRequest)
    }
}

impl fmt::Debug for ConfigPatchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigPatchRequest")
            .field("request_id", &"[REDACTED]")
            .field("raw", &"[REDACTED]")
            .field("base_hash", &self.base_hash.as_ref().map(|_| "[REDACTED]"))
            .field("replace_paths", &self.replace_paths.len())
            .finish()
    }
}

pub(crate) fn config_patch_request(
    request_id: String,
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
    replace_paths: Vec<String>,
) -> Result<ConfigPatchRequest, WireError> {
    if !request_parts_are_valid(
        &request_id,
        &raw.0,
        base_hash.as_ref().map(|hash| hash.0.as_slice()),
        &replace_paths,
    ) {
        return Err(WireError::InvalidConfigPatchRequest);
    }
    Ok(ConfigPatchRequest {
        request_id,
        raw,
        base_hash,
        replace_paths,
    })
}

pub(crate) struct ConfigApplyRequest {
    request_id: String,
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
}

impl ConfigApplyRequest {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn encode(&self) -> Result<String, WireError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Params<'a> {
            raw: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            base_hash: Option<&'a str>,
        }
        #[derive(Serialize)]
        struct Frame<'a> {
            r#type: &'static str,
            id: &'a str,
            method: &'static str,
            params: Params<'a>,
        }

        let raw = self.raw.as_str()?;
        let base_hash = self
            .base_hash
            .as_ref()
            .map(ConfigBaseHash::as_str)
            .transpose()?;
        serde_json::to_string(&Frame {
            r#type: "req",
            id: &self.request_id,
            method: "config.apply",
            params: Params { raw, base_hash },
        })
        .map_err(|_| WireError::EncodeRequest)
    }
}

impl fmt::Debug for ConfigApplyRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigApplyRequest")
            .field("request_id", &"[REDACTED]")
            .field("raw", &"[REDACTED]")
            .field("base_hash", &self.base_hash.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

pub(crate) fn config_apply_request(
    request_id: String,
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
) -> Result<ConfigApplyRequest, WireError> {
    if !valid_string(&request_id)
        || raw.is_empty()
        || base_hash.as_ref().is_some_and(ConfigBaseHash::is_empty)
    {
        return Err(WireError::InvalidConfigApplyRequest);
    }
    Ok(ConfigApplyRequest {
        request_id,
        raw,
        base_hash,
    })
}

pub(crate) struct AgentCreated {
    pub(crate) agent_id: String,
    pub(crate) name: String,
    pub(crate) workspace: String,
}

pub(crate) struct AgentUpdated {
    pub(crate) agent_id: String,
}

pub(crate) struct AgentDeleted {
    pub(crate) agent_id: String,
}

pub(crate) struct ConfigSnapshot {
    raw: Option<ConfigDocument>,
    base_hash: Option<ConfigBaseHash>,
    source_config: Value,
    config: Value,
}

impl ConfigSnapshot {
    pub(crate) fn into_parts(self) -> (Option<ConfigDocument>, Option<ConfigBaseHash>) {
        (self.raw, self.base_hash)
    }

    pub(crate) fn into_source_config_parts(self) -> (Value, Option<ConfigBaseHash>) {
        (self.source_config, self.base_hash)
    }

    pub(crate) fn into_config_parts(self) -> (Value, Option<ConfigBaseHash>) {
        (self.config, self.base_hash)
    }

    pub(crate) fn into_source_and_runtime_config_parts(
        self,
    ) -> (Value, Value, Option<ConfigBaseHash>) {
        (self.source_config, self.config, self.base_hash)
    }

    pub(crate) fn patch_agents(
        self,
        patches: Vec<ConfigAgentPatch>,
    ) -> Result<ConfigPatch, WireError> {
        let (Some(raw), base_hash) = self.into_parts() else {
            return Err(WireError::InvalidConfigSetRequest);
        };
        let raw = raw.as_str()?;
        let mut document: Value =
            serde_json::from_str(raw).map_err(|_| WireError::InvalidConfigSetRequest)?;
        let root = document
            .as_object_mut()
            .ok_or(WireError::InvalidConfigSetRequest)?;
        let agents = root
            .entry("agents")
            .or_insert_with(|| Value::Object(Default::default()))
            .as_object_mut()
            .ok_or(WireError::InvalidConfigSetRequest)?;
        let list = agents
            .entry("list")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or(WireError::InvalidConfigSetRequest)?;
        let mut entry_patches = Vec::with_capacity(patches.len());
        let mut restore_facts = Vec::with_capacity(patches.len());
        for patch in patches {
            let (entry_patch, restore_fact) = patch.apply(list)?;
            entry_patches.push(entry_patch);
            restore_facts.push(restore_fact);
        }
        let raw = serde_json::to_string(&serde_json::json!({
            "agents": {"list": entry_patches}
        }))
        .map_err(|_| WireError::InvalidConfigSetRequest)?;
        Ok(ConfigPatch {
            raw: ConfigDocument::new(raw)?,
            base_hash,
            restore_facts: ConfigRestoreFacts(restore_facts),
            replace_paths: Vec::new(),
        })
    }

    pub(crate) fn prepare_restore(
        self,
        facts: ConfigRestoreFacts,
    ) -> Result<ConfigRestorePreparation, WireError> {
        let (Some(raw), Some(base_hash)) = self.into_parts() else {
            return Ok(ConfigRestorePreparation::Fenced);
        };
        let raw = raw.as_str()?;
        let mut document: Value =
            serde_json::from_str(raw).map_err(|_| WireError::InvalidConfigGet)?;
        let Some(list) = document
            .get_mut("agents")
            .and_then(Value::as_object_mut)
            .and_then(|agents| agents.get_mut("list"))
            .and_then(Value::as_array_mut)
        else {
            return Ok(ConfigRestorePreparation::Fenced);
        };

        let mut replacements = Vec::new();
        let mut removals = Vec::new();
        let mut fenced = false;
        for fact in facts.0 {
            let matching = list
                .iter()
                .enumerate()
                .filter(|(_, entry)| {
                    entry
                        .as_object()
                        .and_then(|entry| entry.get("id"))
                        .and_then(Value::as_str)
                        == Some(fact.agent_id.as_str())
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let [index] = matching.as_slice() else {
                fenced = true;
                continue;
            };
            if list[*index] != fact.expected_entry {
                fenced = true;
                continue;
            }
            match fact.prior_entry {
                Some(prior_entry) => replacements.push((*index, prior_entry)),
                None => removals.push(*index),
            }
        }
        if replacements.is_empty() && removals.is_empty() {
            return Ok(ConfigRestorePreparation::Fenced);
        }
        for (index, prior_entry) in replacements {
            list[index] = prior_entry;
        }
        removals.sort_unstable_by(|left, right| right.cmp(left));
        for index in removals {
            list.remove(index);
        }
        let restored_list = list.clone();
        let raw = serde_json::to_string(&serde_json::json!({
            "agents": {"list": restored_list}
        }))
        .map_err(|_| WireError::InvalidConfigSetRequest)?;
        let raw = ConfigDocument::new(raw)?;
        let request_id = format!("team-config-restore-{}", next_restore_request_id());
        let request =
            config_patch_request(request_id, raw, Some(base_hash), vec!["agents.list".into()])?;
        Ok(ConfigRestorePreparation::Ready { request, fenced })
    }
}

pub(crate) struct ConfigAgentPatch {
    agent_id: String,
    name: String,
    workspace: String,
}

impl ConfigAgentPatch {
    pub(crate) fn new(agent_id: String, name: String, workspace: String) -> Self {
        Self {
            agent_id,
            name,
            workspace,
        }
    }

    fn apply(self, list: &mut Vec<Value>) -> Result<(Value, ConfigRestoreFact), WireError> {
        if !valid_string(&self.agent_id)
            || !valid_string(&self.name)
            || !valid_string(&self.workspace)
        {
            return Err(WireError::InvalidConfigSetRequest);
        }
        let agent_id = self.agent_id;
        let matching = list
            .iter()
            .enumerate()
            .filter(|(_, current)| {
                current
                    .as_object()
                    .and_then(|current| current.get("id"))
                    .and_then(Value::as_str)
                    == Some(agent_id.as_str())
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let prior_entry = match matching.as_slice() {
            [] => None,
            [index] => Some(list[*index].clone()),
            _ => return Err(WireError::InvalidConfigSetRequest),
        };
        let mut entry = prior_entry
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let name = self.name;
        let workspace = self.workspace;
        entry.insert("id".into(), Value::String(agent_id.clone()));
        entry.insert("name".into(), Value::String(name.clone()));
        entry.insert("workspace".into(), Value::String(workspace.clone()));
        let expected_entry = Value::Object(entry);
        let entry_patch = serde_json::json!({
            "id": agent_id.clone(),
            "name": name,
            "workspace": workspace
        });
        match matching.as_slice() {
            [] => list.push(expected_entry.clone()),
            [index] => list[*index] = expected_entry.clone(),
            _ => unreachable!("duplicate config agent IDs were rejected"),
        }
        Ok((
            entry_patch,
            ConfigRestoreFact {
                agent_id,
                expected_entry,
                prior_entry,
            },
        ))
    }
}

impl fmt::Debug for ConfigAgentPatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConfigAgentPatch([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ConfigSetApplied;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ConfigPatchApplied;

pub(crate) struct ConfigApplyApplied;

pub(crate) struct ConfigPatch {
    raw: ConfigDocument,
    base_hash: Option<ConfigBaseHash>,
    restore_facts: ConfigRestoreFacts,
    replace_paths: Vec<String>,
}

impl ConfigPatch {
    pub(crate) fn into_parts(
        self,
    ) -> (
        ConfigDocument,
        Option<ConfigBaseHash>,
        ConfigRestoreFacts,
        Vec<String>,
    ) {
        (
            self.raw,
            self.base_hash,
            self.restore_facts,
            self.replace_paths,
        )
    }
}

pub(crate) struct ConfigRestoreFacts(Vec<ConfigRestoreFact>);

struct ConfigRestoreFact {
    agent_id: String,
    expected_entry: Value,
    prior_entry: Option<Value>,
}

pub(crate) enum ConfigRestorePreparation {
    Ready {
        request: ConfigPatchRequest,
        fenced: bool,
    },
    Fenced,
}

pub(crate) fn decode_agents_create(response: GatewayResponse) -> Result<AgentCreated, WireError> {
    let payload = success_payload(response, WireError::InvalidAgentsCreate)?;
    let payload: AgentsCreateWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidAgentsCreate)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidAgentsCreate);
    }
    Ok(AgentCreated {
        agent_id: payload.agent_id,
        name: payload.name,
        workspace: payload.workspace,
    })
}

pub(crate) fn decode_agents_update(response: GatewayResponse) -> Result<AgentUpdated, WireError> {
    let payload = success_payload(response, WireError::InvalidAgentsUpdate)?;
    let payload: AgentsUpdateWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidAgentsUpdate)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidAgentsUpdate);
    }
    Ok(AgentUpdated {
        agent_id: payload.agent_id,
    })
}

pub(crate) fn decode_agents_delete(response: GatewayResponse) -> Result<AgentDeleted, WireError> {
    super::agents::decode_delete(response).map(|deleted| AgentDeleted {
        agent_id: deleted.agent_id,
    })
}

pub(crate) fn decode_config_get(response: GatewayResponse) -> Result<ConfigSnapshot, WireError> {
    let payload = success_payload(response, WireError::InvalidConfigGet)?;
    let payload: ConfigSnapshotWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidConfigGet)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidConfigGet);
    }
    Ok(ConfigSnapshot {
        raw: payload
            .raw
            .into_option()
            .map(|raw| ConfigDocument(raw.into_bytes())),
        base_hash: payload.hash.map(ConfigBaseHash::from_response),
        source_config: payload.source_config,
        config: payload.config,
    })
}

pub(crate) fn decode_config_set(response: GatewayResponse) -> Result<ConfigSetApplied, WireError> {
    let payload = success_payload(response, WireError::InvalidConfigSet)?;
    let payload: ConfigSetWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidConfigSet)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidConfigSet);
    }
    Ok(ConfigSetApplied)
}

pub(crate) fn decode_config_patch(
    response: GatewayResponse,
) -> Result<ConfigPatchApplied, WireError> {
    let payload = success_payload(response, WireError::InvalidConfigPatch)?;
    let payload: ConfigSetWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidConfigPatch)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidConfigPatch);
    }
    Ok(ConfigPatchApplied)
}

pub(crate) fn decode_config_apply(
    response: GatewayResponse,
) -> Result<ConfigApplyApplied, WireError> {
    let payload = success_payload(response, WireError::InvalidConfigApply)?;
    let payload: ConfigSetWire =
        serde_json::from_value(payload).map_err(|_| WireError::InvalidConfigApply)?;
    if !payload.is_valid() {
        return Err(WireError::InvalidConfigApply);
    }
    Ok(ConfigApplyApplied)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AgentsCreateWire {
    ok: bool,
    agent_id: String,
    name: String,
    workspace: String,
    model: Option<String>,
}

impl AgentsCreateWire {
    fn is_valid(&self) -> bool {
        self.ok
            && valid_string(&self.agent_id)
            && valid_string(&self.name)
            && valid_string(&self.workspace)
            && valid_optional_string(&self.model)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AgentsUpdateWire {
    ok: bool,
    agent_id: String,
}

impl AgentsUpdateWire {
    fn is_valid(&self) -> bool {
        self.ok && valid_string(&self.agent_id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSnapshotWire {
    path: String,
    exists: bool,
    raw: NullableString,
    valid: bool,
    source_config: Value,
    config: Value,
    hash: Option<String>,
    #[serde(default)]
    issues: Vec<ConfigIssueWire>,
    #[serde(default)]
    warnings: Vec<ConfigIssueWire>,
    #[serde(default)]
    legacy_issues: Vec<LegacyConfigIssueWire>,
}

impl ConfigSnapshotWire {
    fn is_valid(&self) -> bool {
        let _ = self.valid;
        valid_string(&self.path)
            && self.raw.is_valid()
            && self.source_config.is_object()
            && self.config.is_object()
            && valid_optional_string(&self.hash)
            && self.issues.iter().all(ConfigIssueWire::is_valid)
            && self.warnings.iter().all(ConfigIssueWire::is_valid)
            && self
                .legacy_issues
                .iter()
                .all(LegacyConfigIssueWire::is_valid)
            && (self.exists || self.raw.is_null())
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NullableString {
    String(String),
    Null(()),
}

impl NullableString {
    fn into_option(self) -> Option<String> {
        match self {
            Self::String(value) => Some(value),
            Self::Null(()) => None,
        }
    }

    fn is_valid(&self) -> bool {
        match self {
            Self::String(value) => valid_string(value),
            Self::Null(()) => true,
        }
    }

    fn is_null(&self) -> bool {
        matches!(self, Self::Null(()))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigIssueWire {
    path: String,
    message: String,
    allowed_values: Option<Vec<String>>,
    allowed_values_hidden_count: Option<u64>,
}

impl ConfigIssueWire {
    fn is_valid(&self) -> bool {
        let _ = self.allowed_values_hidden_count;
        valid_string(&self.path)
            && valid_string(&self.message)
            && self
                .allowed_values
                .as_ref()
                .is_none_or(|values| valid_strings(values))
    }
}

#[derive(Deserialize)]
struct LegacyConfigIssueWire {
    path: String,
    message: String,
}

impl LegacyConfigIssueWire {
    fn is_valid(&self) -> bool {
        valid_string(&self.path) && valid_string(&self.message)
    }
}

#[derive(Deserialize)]
struct ConfigSetWire {
    ok: bool,
    path: String,
    config: OpaqueObject,
}

impl ConfigSetWire {
    fn is_valid(&self) -> bool {
        let _ = &self.config;
        self.ok && valid_string(&self.path)
    }
}

struct OpaqueObject;

impl<'de> Deserialize<'de> for OpaqueObject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ObjectVisitor;

        impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
            type Value = OpaqueObject;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                while map
                    .next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?
                    .is_some()
                {}
                Ok(OpaqueObject)
            }
        }

        deserializer.deserialize_map(ObjectVisitor)
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::{Debug, Display};

    use serde::Serialize;
    use serde_json::json;

    use super::super::decode_response;
    use super::*;

    fn response(id: &str, payload: Value) -> GatewayResponse {
        decode_response(
            &json!({"type": "res", "id": id, "ok": true, "payload": payload}).to_string(),
            id,
        )
        .unwrap()
        .unwrap()
    }

    fn config_snapshot_with_raw(raw: String, hash: &str) -> Value {
        json!({
            "path": "config-path-canary",
            "exists": true,
            "raw": raw,
            "parsed": {"parsed": true},
            "sourceConfig": {"source": "source-canary"},
            "resolved": {"resolved": "resolved-canary"},
            "valid": true,
            "runtimeConfig": {"runtime": "runtime-canary"},
            "config": {"config": "config-canary"},
            "hash": hash,
            "issues": [{
                "path": "issue-path-canary",
                "message": "issue-message-canary",
                "allowedValues": ["allowed-value-canary"],
                "allowedValuesHiddenCount": 1
            }],
            "warnings": [],
            "legacyIssues": [{
                "path": "legacy-path-canary",
                "message": "legacy-message-canary"
            }]
        })
    }

    fn config_snapshot() -> Value {
        config_snapshot_with_raw("config-raw-canary".into(), "base-hash-canary")
    }

    #[test]
    fn requests_match_gateway_golden_frames() {
        let create = agents_create_request(
            "agents-create-1".into(),
            "team-agent-1".into(),
            "workspace-path-canary".into(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&create.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "agents-create-1", "method": "agents.create",
                "params": {"name": "team-agent-1", "workspace": "workspace-path-canary"}
            })
        );

        let update = agents_update_request(
            "agents-update-1".into(),
            "agent-1".into(),
            "team-agent-1".into(),
            "workspace-path-canary".into(),
            Some("provider/model-1".into()),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&update.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "agents-update-1", "method": "agents.update",
                "params": {
                    "agentId": "agent-1", "name": "team-agent-1", "workspace": "workspace-path-canary",
                    "model": "provider/model-1"
                }
            })
        );

        let update_without_model = agents_update_request(
            "agents-update-2".into(),
            "agent-1".into(),
            "team-agent-1".into(),
            "workspace-path-canary".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&update_without_model.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "agents-update-2", "method": "agents.update",
                "params": {
                    "agentId": "agent-1", "name": "team-agent-1", "workspace": "workspace-path-canary"
                }
            })
        );

        let delete = agents_delete_request("agents-delete-1".into(), "agent-1".into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&delete.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "agents-delete-1", "method": "agents.delete",
                "params": {"agentId": "agent-1", "deleteFiles": true}
            })
        );

        let get = config_get_request("config-get-1".into()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&get.encode().unwrap()).unwrap(),
            json!({"type": "req", "id": "config-get-1", "method": "config.get", "params": {}})
        );

        let (raw, base_hash) = decode_config_get(response("config-get-1", config_snapshot()))
            .unwrap()
            .into_parts();
        let set = config_set_request("config-set-1".into(), raw.unwrap(), base_hash).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&set.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "config-set-1", "method": "config.set",
                "params": {"raw": "config-raw-canary", "baseHash": "base-hash-canary"}
            })
        );

        let set = config_set_request(
            "config-set-2".into(),
            ConfigDocument::new("config-raw-canary".into()).unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&set.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "config-set-2", "method": "config.set",
                "params": {"raw": "config-raw-canary"}
            })
        );

        let (_, base_hash) = decode_config_get(response("config-get-2", config_snapshot()))
            .unwrap()
            .into_parts();
        let patch = config_patch_request(
            "config-patch-1".into(),
            ConfigDocument::new("{\"models\":{}}".into()).unwrap(),
            base_hash,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&patch.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "config-patch-1", "method": "config.patch",
                "params": {"raw": "{\"models\":{}}", "baseHash": "base-hash-canary"}
            })
        );

        let patch_with_replace_paths = config_patch_request(
            "config-patch-2".into(),
            ConfigDocument::new("{\"agents\":{\"list\":[]}}".into()).unwrap(),
            None,
            vec!["agents.list".into(), "mcp.servers".into()],
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&patch_with_replace_paths.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "config-patch-2", "method": "config.patch",
                "params": {
                    "raw": "{\"agents\":{\"list\":[]}}",
                    "replacePaths": ["agents.list", "mcp.servers"]
                }
            })
        );

        let (_, base_hash) = decode_config_get(response("config-get-3", config_snapshot()))
            .unwrap()
            .into_parts();
        let apply = config_apply_request(
            "config-apply-1".into(),
            ConfigDocument::new("{\"models\":{}}".into()).unwrap(),
            base_hash,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&apply.encode().unwrap()).unwrap(),
            json!({
                "type": "req", "id": "config-apply-1", "method": "config.apply",
                "params": {"raw": "{\"models\":{}}", "baseHash": "base-hash-canary"}
            })
        );
    }

    #[test]
    fn requests_reject_invalid_required_values() {
        assert_eq!(
            agents_create_request("id".into(), String::new(), "workspace".into()).unwrap_err(),
            WireError::InvalidAgentsCreateRequest
        );
        assert_eq!(
            agents_update_request(
                "id".into(),
                "agent".into(),
                "name".into(),
                "workspace".into(),
                Some(String::new()),
            )
            .unwrap_err(),
            WireError::InvalidAgentsUpdateRequest
        );
        assert_eq!(
            agents_delete_request("id".into(), String::new()).unwrap_err(),
            WireError::InvalidAgentsDeleteRequest
        );
        assert_eq!(
            config_get_request(String::new()).unwrap_err(),
            WireError::InvalidConfigGetRequest
        );
        assert!(ConfigDocument::new(String::new()).is_err());
        assert_eq!(
            config_set_request(
                String::new(),
                ConfigDocument::new("raw".into()).unwrap(),
                None,
            )
            .unwrap_err(),
            WireError::InvalidConfigSetRequest
        );
        assert_eq!(
            config_patch_request(
                String::new(),
                ConfigDocument::new("raw".into()).unwrap(),
                None,
                Vec::new(),
            )
            .unwrap_err(),
            WireError::InvalidConfigPatchRequest
        );
        assert_eq!(
            config_patch_request(
                "id".into(),
                ConfigDocument::new("raw".into()).unwrap(),
                None,
                vec![String::new()],
            )
            .unwrap_err(),
            WireError::InvalidConfigPatchRequest
        );
        assert_eq!(
            config_apply_request(
                String::new(),
                ConfigDocument::new("raw".into()).unwrap(),
                None,
            )
            .unwrap_err(),
            WireError::InvalidConfigApplyRequest
        );
    }

    #[test]
    fn config_get_accepts_snapshot_extensions_and_null_raw() {
        let snapshot = decode_config_get(response(
            "config-get-null",
            json!({
                "path": "config-path-canary",
                "exists": false,
                "raw": null,
                "valid": true,
                "sourceConfig": {},
                "config": {},
                "hash": "base-hash-canary",
                "issues": [],
                "warnings": [],
                "legacyIssues": [],
                "futureField": {"ignored": true}
            }),
        ))
        .unwrap();
        let (config, base_hash) = snapshot.into_config_parts();
        assert_eq!(config, json!({}));
        let patch = config_patch_request(
            "config-patch-null".into(),
            ConfigDocument::new("{\"models\":{}}".into()).unwrap(),
            base_hash,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&patch.encode().unwrap()).unwrap()["params"]["baseHash"],
            json!("base-hash-canary")
        );
    }

    #[test]
    fn materialize_agents_patch_keeps_raw_local_to_managed_fields() {
        let initial = json!({
            "agents": {
                "list": [{
                    "id": "managed-first",
                    "name": "old-first",
                    "workspace": "old-workspace",
                    "model": {"primary": "provider/model-canary"},
                    "tools": ["tool-canary"]
                }]
            },
            "models": {"leak": "must-not-appear"}
        });
        let snapshot = decode_config_get(response(
            "config-get-1",
            config_snapshot_with_raw(initial.to_string(), "patch-base-hash"),
        ))
        .unwrap();
        let patch = snapshot
            .patch_agents(vec![ConfigAgentPatch::new(
                "managed-first".into(),
                "new-first".into(),
                "workspace-first".into(),
            )])
            .unwrap();
        let (raw, _, facts, replace_paths) = patch.into_parts();
        assert!(replace_paths.is_empty());
        assert_eq!(
            serde_json::from_str::<Value>(raw.as_str().unwrap()).unwrap(),
            json!({
                "agents": {
                    "list": [{
                        "id": "managed-first",
                        "name": "new-first",
                        "workspace": "workspace-first"
                    }]
                }
            })
        );

        let restored_snapshot = decode_config_get(response(
            "config-get-2",
            config_snapshot_with_raw(
                json!({
                    "agents": {
                        "list": [{
                            "id": "managed-first",
                            "name": "new-first",
                            "workspace": "workspace-first",
                            "model": {"primary": "provider/model-canary"},
                            "tools": ["tool-canary"]
                        }]
                    },
                    "models": {"keep": "outside-restore-patch"}
                })
                .to_string(),
                "restore-base-hash",
            ),
        ))
        .unwrap();
        let ConfigRestorePreparation::Ready { request, fenced } =
            restored_snapshot.prepare_restore(facts).unwrap()
        else {
            panic!("matching entry with preserved fields must prepare a restore");
        };
        assert!(!fenced);
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], "config.patch");
        assert_eq!(encoded["params"]["replacePaths"], json!(["agents.list"]));
        assert_eq!(
            serde_json::from_str::<Value>(encoded["params"]["raw"].as_str().unwrap()).unwrap(),
            json!({
                "agents": {
                    "list": [{
                        "id": "managed-first",
                        "name": "old-first",
                        "workspace": "old-workspace",
                        "model": {"primary": "provider/model-canary"},
                        "tools": ["tool-canary"]
                    }]
                }
            })
        );
    }

    #[test]
    fn restore_removes_reordered_matching_entries_without_touching_other_entries() {
        let initial = json!({
            "agents": {
                "list": [{"id": "unrelated", "value": "keep"}]
            }
        });
        let snapshot = decode_config_get(response(
            "config-get-1",
            config_snapshot_with_raw(initial.to_string(), "patch-base-hash"),
        ))
        .unwrap();
        let patch = snapshot
            .patch_agents(vec![
                ConfigAgentPatch::new(
                    "managed-first".into(),
                    "new-first".into(),
                    "workspace-first".into(),
                ),
                ConfigAgentPatch::new(
                    "managed-second".into(),
                    "new-second".into(),
                    "workspace-second".into(),
                ),
            ])
            .unwrap();
        let (raw, base_hash, facts, replace_paths) = patch.into_parts();
        assert_eq!(base_hash.unwrap().as_str().unwrap(), "patch-base-hash");
        assert!(replace_paths.is_empty());
        assert_eq!(
            serde_json::from_str::<Value>(raw.as_str().unwrap()).unwrap(),
            json!({
                "agents": {
                    "list": [
                        {
                            "id": "managed-first",
                            "name": "new-first",
                            "workspace": "workspace-first"
                        },
                        {
                            "id": "managed-second",
                            "name": "new-second",
                            "workspace": "workspace-second"
                        }
                    ]
                }
            })
        );

        let reordered = json!({
            "agents": {
                "list": [
                    {
                        "id": "managed-second",
                        "name": "new-second",
                        "workspace": "workspace-second"
                    },
                    {"id": "unrelated", "value": "keep"},
                    {
                        "id": "managed-first",
                        "name": "new-first",
                        "workspace": "workspace-first"
                    }
                ]
            }
        });
        let restored_snapshot = decode_config_get(response(
            "config-get-2",
            config_snapshot_with_raw(reordered.to_string(), "restore-base-hash"),
        ))
        .unwrap();
        let ConfigRestorePreparation::Ready { request, fenced } =
            restored_snapshot.prepare_restore(facts).unwrap()
        else {
            panic!("matching reordered entries must prepare a restore");
        };
        assert!(!fenced);
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], "config.patch");
        assert_eq!(encoded["params"]["baseHash"], "restore-base-hash");
        assert_eq!(encoded["params"]["replacePaths"], json!(["agents.list"]));
        let restored: Value =
            serde_json::from_str(encoded["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            restored,
            json!({"agents": {"list": [{"id": "unrelated", "value": "keep"}]}})
        );
    }

    #[test]
    fn decoders_project_only_the_required_private_values() {
        let created = decode_agents_create(response(
            "agents-create-1",
            json!({
                "ok": true,
                "agentId": "agent-1",
                "name": "team-agent-1",
                "workspace": "workspace-path-canary"
            }),
        ))
        .unwrap();
        assert_eq!(created.agent_id, "agent-1");
        assert_eq!(created.name, "team-agent-1");
        assert_eq!(created.workspace, "workspace-path-canary");

        let updated = decode_agents_update(response(
            "agents-update-1",
            json!({"ok": true, "agentId": "agent-1"}),
        ))
        .unwrap();
        assert_eq!(updated.agent_id, "agent-1");

        let deleted = decode_agents_delete(response(
            "agents-delete-1",
            json!({"ok": true, "agentId": "agent-1", "removedBindings": 2}),
        ))
        .unwrap();
        assert_eq!(deleted.agent_id, "agent-1");

        assert_eq!(
            decode_config_set(response(
                "config-set-1",
                json!({"ok": true, "path": "config-path-canary", "config": {"model": "provider/model-1"}}),
            ))
            .unwrap(),
            ConfigSetApplied
        );
    }

    #[test]
    fn decoders_fail_closed_on_schema_drift_or_gateway_failures() {
        assert!(matches!(
            decode_agents_create(response(
                "agents-create-1",
                json!({"ok": true, "agentId": "agent-1", "name": "name", "workspace": "workspace", "future": true}),
            )),
            Err(WireError::InvalidAgentsCreate)
        ));
        assert!(matches!(
            decode_agents_update(response(
                "agents-update-1",
                json!({"ok": false, "agentId": "agent-1"}),
            )),
            Err(WireError::InvalidAgentsUpdate)
        ));
        assert!(matches!(
            decode_agents_delete(response(
                "agents-delete-1",
                json!({"ok": true, "agentId": "agent-1", "removedBindings": "0"}),
            )),
            Err(WireError::InvalidAgentsDelete)
        ));

        let mut missing_raw = config_snapshot();
        missing_raw.as_object_mut().unwrap().remove("raw");
        assert!(matches!(
            decode_config_get(response("config-get-1", missing_raw)),
            Err(WireError::InvalidConfigGet)
        ));

        let mut nullable_raw = config_snapshot();
        nullable_raw["raw"] = Value::Null;
        let (raw, _) = decode_config_get(response("config-get-1", nullable_raw))
            .unwrap()
            .into_parts();
        assert!(raw.is_none());

        assert!(matches!(
            decode_config_set(response(
                "config-set-1",
                json!({"ok": true, "path": "config-path-canary", "config": "not-an-object"}),
            )),
            Err(WireError::InvalidConfigSet)
        ));

        let failed = decode_response(
            r#"{"type":"res","id":"agents-create-1","ok":false,"error":{"code":"DENIED","message":"gateway-failure-canary"}}"#,
            "agents-create-1",
        )
        .unwrap()
        .unwrap();
        let error = match decode_agents_create(failed) {
            Err(error) => error,
            Ok(_) => panic!("expected rejected gateway response"),
        };
        assert_eq!(error, WireError::InvalidAgentsCreate);
        assert!(!error.to_string().contains("gateway-failure-canary"));
        assert!(!format!("{error:?}").contains("gateway-failure-canary"));
    }

    trait AmbiguousIfClone<A> {}
    impl<T> AmbiguousIfClone<()> for T {}
    impl<T: Clone> AmbiguousIfClone<u8> for T {}
    trait AmbiguousIfDebug<A> {}
    impl<T> AmbiguousIfDebug<()> for T {}
    impl<T: Debug> AmbiguousIfDebug<u8> for T {}
    trait AmbiguousIfDisplay<A> {}
    impl<T> AmbiguousIfDisplay<()> for T {}
    impl<T: Display> AmbiguousIfDisplay<u8> for T {}
    trait AmbiguousIfSerialize<A> {}
    impl<T> AmbiguousIfSerialize<()> for T {}
    impl<T: Serialize> AmbiguousIfSerialize<u8> for T {}
    fn assert_not_clone<T: AmbiguousIfClone<A>, A>() {}
    fn assert_not_debug<T: AmbiguousIfDebug<A>, A>() {}
    fn assert_not_display<T: AmbiguousIfDisplay<A>, A>() {}
    fn assert_not_serialize<T: AmbiguousIfSerialize<A>, A>() {}

    fn assert_debug_redacts(value: &impl Debug, canaries: &[&str]) {
        let debug = format!("{value:?}");
        for canary in canaries {
            assert!(!debug.contains(canary));
        }
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn private_values_cannot_expose_paths_or_config() {
        let request = agents_create_request(
            "request-id-canary".into(),
            "agent-name-canary".into(),
            "workspace-path-canary".into(),
        )
        .unwrap();
        assert_debug_redacts(
            &request,
            &[
                "request-id-canary",
                "agent-name-canary",
                "workspace-path-canary",
            ],
        );

        let (raw, base_hash) = decode_config_get(response("config-get-1", config_snapshot()))
            .unwrap()
            .into_parts();
        let request =
            config_set_request("request-id-canary".into(), raw.unwrap(), base_hash).unwrap();
        assert_debug_redacts(
            &request,
            &["request-id-canary", "config-raw-canary", "base-hash-canary"],
        );

        let (_, base_hash) = decode_config_get(response("config-get-2", config_snapshot()))
            .unwrap()
            .into_parts();
        let request = config_patch_request(
            "request-id-canary".into(),
            ConfigDocument::new("config-raw-canary".into()).unwrap(),
            base_hash,
            vec!["replace-path-canary".into()],
        )
        .unwrap();
        assert_debug_redacts(
            &request,
            &[
                "request-id-canary",
                "config-raw-canary",
                "base-hash-canary",
                "replace-path-canary",
            ],
        );
        assert!(format!("{request:?}").contains("replace_paths: 1"));

        assert_not_clone::<ConfigDocument, _>();
        assert_not_debug::<ConfigDocument, _>();
        assert_not_display::<ConfigDocument, _>();
        assert_not_serialize::<ConfigDocument, _>();
        assert_not_clone::<ConfigBaseHash, _>();
        assert_not_debug::<ConfigBaseHash, _>();
        assert_not_display::<ConfigBaseHash, _>();
        assert_not_serialize::<ConfigBaseHash, _>();
        assert_not_clone::<ConfigPatch, _>();
        assert_not_debug::<ConfigPatch, _>();
        assert_not_display::<ConfigPatch, _>();
        assert_not_serialize::<ConfigPatch, _>();
        assert_not_clone::<ConfigRestoreFacts, _>();
        assert_not_debug::<ConfigRestoreFacts, _>();
        assert_not_display::<ConfigRestoreFacts, _>();
        assert_not_serialize::<ConfigRestoreFacts, _>();
        assert_not_debug::<ConfigRestorePreparation, _>();
        assert_not_debug::<ConfigSnapshot, _>();
        assert_not_debug::<AgentCreated, _>();
        assert_not_debug::<AgentUpdated, _>();
        assert_not_debug::<AgentDeleted, _>();
    }
}
