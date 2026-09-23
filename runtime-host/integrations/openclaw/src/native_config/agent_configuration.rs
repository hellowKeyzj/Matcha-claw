use std::{
    collections::BTreeSet,
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::gateway::{
    client::{GatewayClient, GatewayClientError},
    config_patch::{
        destructive_array_replace_paths_at, encode_request as encode_config_patch_request,
        merge_patch, request_parts_are_valid,
    },
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

const CONFIG_GET_METHOD: &str = "config.get";
const CONFIG_PATCH_METHOD: &str = "config.patch";
const SKILLS_STATUS_METHOD: &str = "skills.status";
const TOOLS_CATALOG_METHOD: &str = "tools.catalog";
const CONFIG_READ_METHODS: [&str; 1] = [CONFIG_GET_METHOD];
const CONFIG_WRITE_METHODS: [&str; 1] = [CONFIG_PATCH_METHOD];
const SKILL_STATUS_METHODS: [&str; 1] = [SKILLS_STATUS_METHOD];
const TOOL_CATALOG_METHODS: [&str; 1] = [TOOLS_CATALOG_METHOD];
const AGENT_FACING_INTERNAL_TOOL_DENY: [&str; 5] =
    ["gateway", "nodes", "create_goal", "get_goal", "update_goal"];

fn log_session_trace(stage: &str, trace_id: Option<&str>, payload: Value) {
    if trace_id.is_none() || std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    let mut event = Map::new();
    event.insert("prefix".into(), Value::String("session-trace".into()));
    event.insert("source".into(), Value::String("runtime-host".into()));
    event.insert(
        "traceId".into(),
        Value::String(trace_id.unwrap_or_default().into()),
    );
    event.insert("stage".into(), Value::String(stage.into()));
    event.insert("at".into(), Value::Number(now_millis().into()));
    if let Value::Object(fields) = payload {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

fn id_shape(value: Option<&str>) -> Value {
    match value {
        Some(value) => serde_json::json!({ "present": true, "length": value.len() }),
        None => serde_json::json!({ "present": false, "length": 0 }),
    }
}

fn read_failure_reason(error: ReadFailure) -> &'static str {
    match error {
        ReadFailure::Unavailable => "unavailable",
        ReadFailure::Rejected => "rejected",
        ReadFailure::Protocol => "protocol",
    }
}

fn mutation_outcome_reason(outcome: MutationOutcome) -> &'static str {
    match outcome {
        MutationOutcome::Applied => "applied",
        MutationOutcome::Rejected => "rejected",
        MutationOutcome::OutcomeUnknown => "outcomeUnknown",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub struct AgentConfiguration {
    gateway: Arc<GatewayClient>,
    trace_id: Option<String>,
}

impl AgentConfiguration {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self {
            gateway,
            trace_id: None,
        }
    }

    pub fn with_trace_id(gateway: Arc<GatewayClient>, trace_id: Option<String>) -> Self {
        Self { gateway, trace_id }
    }

    pub async fn display(&self) -> Result<Display, ReadFailure> {
        let snapshot = self.read_snapshot().await?;
        snapshot.display()
    }

    pub async fn set_description(
        &self,
        agent_id: String,
        description: Option<String>,
    ) -> MutationOutcome {
        self.mutate(agent_id, Patch::Description(description)).await
    }

    pub async fn set_model(&self, agent_id: String, model: Option<Model>) -> MutationOutcome {
        self.mutate(agent_id, Patch::Model(model)).await
    }

    pub async fn set_skills(&self, agent_id: String, skills: Vec<String>) -> MutationOutcome {
        let catalog = match self.skill_catalog(&agent_id).await {
            Ok(catalog) => catalog,
            Err(ReadFailure::Rejected) => return MutationOutcome::Rejected,
            Err(ReadFailure::Unavailable | ReadFailure::Protocol) => {
                return MutationOutcome::OutcomeUnknown;
            }
        };
        let skills = match catalog.canonicalize(skills) {
            Ok(skills) => skills,
            Err(_) => return MutationOutcome::Rejected,
        };
        self.mutate(agent_id, Patch::Skills(skills)).await
    }

    pub async fn skill_configuration(&self, agent_id: String) -> SkillConfigurationOutcome {
        log_session_trace(
            "runtime.openclaw.agent-config.skill.request",
            self.trace_id.as_deref(),
            serde_json::json!({ "agentId": id_shape(Some(&agent_id)) }),
        );
        let snapshot = match self.read_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => return SkillConfigurationOutcome::Unavailable(error),
        };
        if !snapshot.has_agent(&agent_id) {
            log_session_trace(
                "runtime.openclaw.agent-config.skill.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "agentNotConfigured" }),
            );
            return SkillConfigurationOutcome::View(snapshot.skill_view_without_catalog(agent_id));
        }
        let catalog = match self.skill_catalog(&agent_id).await {
            Ok(catalog) => catalog,
            Err(error) => return SkillConfigurationOutcome::Unavailable(error),
        };
        match snapshot.skill_view(agent_id, catalog) {
            Ok(view) => {
                log_session_trace(
                    "runtime.openclaw.agent-config.skill.outcome",
                    self.trace_id.as_deref(),
                    serde_json::json!({
                        "result": "view",
                        "optionCount": view.options.len(),
                        "effectiveSkillCount": view.effective_skill_keys.len(),
                    }),
                );
                SkillConfigurationOutcome::View(view)
            }
            Err(()) => {
                log_session_trace(
                    "runtime.openclaw.agent-config.skill.outcome",
                    self.trace_id.as_deref(),
                    serde_json::json!({ "result": "protocol" }),
                );
                SkillConfigurationOutcome::Unavailable(ReadFailure::Protocol)
            }
        }
    }

    pub async fn set_skill_configuration(
        &self,
        agent_id: String,
        revision: String,
        selection: SkillSelection,
    ) -> SkillConfigurationOutcome {
        log_session_trace(
            "runtime.openclaw.agent-config.skill.set-request",
            self.trace_id.as_deref(),
            serde_json::json!({
                "agentId": id_shape(Some(&agent_id)),
                "revision": id_shape(Some(&revision)),
            }),
        );
        let snapshot = match self.read_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => return SkillConfigurationOutcome::Unavailable(error),
        };
        if snapshot.revision() != revision {
            log_session_trace(
                "runtime.openclaw.agent-config.skill.set-outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "staleRevision" }),
            );
            return match self.skill_configuration(agent_id).await {
                SkillConfigurationOutcome::View(view) => SkillConfigurationOutcome::Stale(view),
                SkillConfigurationOutcome::Unavailable(error) => {
                    SkillConfigurationOutcome::Unavailable(error)
                }
                _ => SkillConfigurationOutcome::Unavailable(ReadFailure::Protocol),
            };
        }
        if !snapshot.has_agent(&agent_id) {
            log_session_trace(
                "runtime.openclaw.agent-config.skill.set-outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "agentNotConfigured" }),
            );
            return SkillConfigurationOutcome::Unsupported;
        }
        let catalog = match self.skill_catalog(&agent_id).await {
            Ok(catalog) => catalog,
            Err(error) => return SkillConfigurationOutcome::Unavailable(error),
        };
        let skills = match selection {
            SkillSelection::InheritDefaultSkills => None,
            SkillSelection::ExplicitSkillAllowlist(skills) => match catalog.canonicalize(skills) {
                Ok(skills) => Some(skills),
                Err((unknown_skill_keys, non_canonical_skill_keys)) => {
                    log_session_trace(
                        "runtime.openclaw.agent-config.skill.set-outcome",
                        self.trace_id.as_deref(),
                        serde_json::json!({
                            "result": "invalidSkillKeys",
                            "unknownCount": unknown_skill_keys.len(),
                            "nonCanonicalCount": non_canonical_skill_keys.len(),
                        }),
                    );
                    return SkillConfigurationOutcome::InvalidSkillKeys {
                        unknown_skill_keys,
                        non_canonical_skill_keys,
                    };
                }
            },
        };
        let request =
            match snapshot.patch_existing(agent_id.clone(), Patch::SkillConfiguration(skills)) {
                Ok(request) => request,
                Err(()) => {
                    log_session_trace(
                        "runtime.openclaw.agent-config.skill.set-outcome",
                        self.trace_id.as_deref(),
                        serde_json::json!({ "result": "unsupported" }),
                    );
                    return SkillConfigurationOutcome::Unsupported;
                }
            };
        match self.write(request).await {
            MutationOutcome::Rejected => SkillConfigurationOutcome::Rejected,
            MutationOutcome::OutcomeUnknown => SkillConfigurationOutcome::OutcomeUnknown,
            MutationOutcome::Applied => match self.skill_configuration(agent_id).await {
                SkillConfigurationOutcome::View(view) => SkillConfigurationOutcome::Updated(view),
                outcome => outcome,
            },
        }
    }

    pub async fn tool_configuration(&self, agent_id: String) -> ToolConfigurationOutcome {
        log_session_trace(
            "runtime.openclaw.agent-config.tool.request",
            self.trace_id.as_deref(),
            serde_json::json!({ "agentId": id_shape(Some(&agent_id)) }),
        );
        let snapshot = match self.read_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => return ToolConfigurationOutcome::Unavailable(error),
        };
        if !snapshot.has_agent(&agent_id) {
            log_session_trace(
                "runtime.openclaw.agent-config.tool.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "agentNotConfigured" }),
            );
            return ToolConfigurationOutcome::View(snapshot.tool_view_without_catalog(agent_id));
        }
        let catalog = match self.tool_catalog(&agent_id).await {
            Ok(catalog) => catalog,
            Err(error) => return ToolConfigurationOutcome::Unavailable(error),
        };
        match snapshot.tool_view(agent_id, catalog) {
            Ok(view) => {
                log_session_trace(
                    "runtime.openclaw.agent-config.tool.outcome",
                    self.trace_id.as_deref(),
                    serde_json::json!({
                        "result": "view",
                        "toolProfileCount": view.catalog().profiles().len(),
                        "toolGroupCount": view.catalog().groups().len(),
                        "toolOptionCount": view.catalog().options().len(),
                    }),
                );
                ToolConfigurationOutcome::View(view)
            }
            Err(()) => {
                log_session_trace(
                    "runtime.openclaw.agent-config.tool.outcome",
                    self.trace_id.as_deref(),
                    serde_json::json!({ "result": "protocol" }),
                );
                ToolConfigurationOutcome::Unavailable(ReadFailure::Protocol)
            }
        }
    }

    pub async fn platform_tools_catalog(&self) -> Result<ToolCatalog, ReadFailure> {
        self.tool_catalog("main").await
    }

    pub async fn set_tool_configuration(
        &self,
        agent_id: String,
        revision: String,
        selection: ToolSelection,
    ) -> ToolConfigurationOutcome {
        log_session_trace(
            "runtime.openclaw.agent-config.tool.set-request",
            self.trace_id.as_deref(),
            serde_json::json!({
                "agentId": id_shape(Some(&agent_id)),
                "revision": id_shape(Some(&revision)),
            }),
        );
        let snapshot = match self.read_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) => return ToolConfigurationOutcome::Unavailable(error),
        };
        if snapshot.revision() != revision {
            log_session_trace(
                "runtime.openclaw.agent-config.tool.set-outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "staleRevision" }),
            );
            return match self.tool_configuration(agent_id).await {
                ToolConfigurationOutcome::View(view) => ToolConfigurationOutcome::Stale(view),
                ToolConfigurationOutcome::Unavailable(error) => {
                    ToolConfigurationOutcome::Unavailable(error)
                }
                _ => ToolConfigurationOutcome::Unavailable(ReadFailure::Protocol),
            };
        }
        if !snapshot.has_agent(&agent_id) {
            log_session_trace(
                "runtime.openclaw.agent-config.tool.set-outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "agentNotConfigured" }),
            );
            return ToolConfigurationOutcome::Unsupported;
        }
        let catalog = match self.tool_catalog(&agent_id).await {
            Ok(catalog) => catalog,
            Err(error) => return ToolConfigurationOutcome::Unavailable(error),
        };
        let selection = enforce_agent_facing_internal_tool_deny(selection);
        if let ToolSelection::Policy { allow, deny, .. } = &selection {
            let unknown = unknown_tool_keys(allow, deny, catalog.policy_keys());
            if !unknown.is_empty() {
                log_session_trace(
                    "runtime.openclaw.agent-config.tool.set-outcome",
                    self.trace_id.as_deref(),
                    serde_json::json!({
                        "result": "invalidToolKeys",
                        "unknownCount": unknown.len(),
                    }),
                );
                return ToolConfigurationOutcome::InvalidToolKeys(unknown);
            }
        }
        let request =
            match snapshot.patch_existing(agent_id.clone(), Patch::ToolConfiguration(selection)) {
                Ok(request) => request,
                Err(()) => {
                    log_session_trace(
                        "runtime.openclaw.agent-config.tool.set-outcome",
                        self.trace_id.as_deref(),
                        serde_json::json!({ "result": "unsupported" }),
                    );
                    return ToolConfigurationOutcome::Unsupported;
                }
            };
        match self.write(request).await {
            MutationOutcome::Rejected => ToolConfigurationOutcome::Rejected,
            MutationOutcome::OutcomeUnknown => ToolConfigurationOutcome::OutcomeUnknown,
            MutationOutcome::Applied => match self.tool_configuration(agent_id).await {
                ToolConfigurationOutcome::View(view) => ToolConfigurationOutcome::Updated(view),
                outcome => outcome,
            },
        }
    }

    async fn tool_catalog(&self, agent_id: &str) -> Result<ToolCatalog, ReadFailure> {
        log_session_trace(
            "runtime.openclaw.agent-config.tools-catalog.request",
            self.trace_id.as_deref(),
            serde_json::json!({ "agentId": id_shape(Some(agent_id)) }),
        );
        let request = tool_catalog_request(agent_id).map_err(|_| ReadFailure::Protocol)?;
        let _ = TOOL_CATALOG_METHODS;
        let outcome = match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(ReadFailure::Rejected),
            Ok(response) => ToolCatalog::decode(response).map_err(|_| ReadFailure::Protocol),
            Err(error) => Err(map_read_failure(error)),
        };
        match &outcome {
            Ok(catalog) => log_session_trace(
                "runtime.openclaw.agent-config.tools-catalog.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({
                    "result": "catalog",
                    "toolProfileCount": catalog.profiles().len(),
                    "toolGroupCount": catalog.groups().len(),
                    "toolOptionCount": catalog.options().len(),
                }),
            ),
            Err(error) => log_session_trace(
                "runtime.openclaw.agent-config.tools-catalog.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": read_failure_reason(*error) }),
            ),
        }
        outcome
    }

    async fn skill_catalog(&self, agent_id: &str) -> Result<SkillCatalog, ReadFailure> {
        log_session_trace(
            "runtime.openclaw.agent-config.skills-status.request",
            self.trace_id.as_deref(),
            serde_json::json!({ "agentId": id_shape(Some(agent_id)) }),
        );
        let request = skill_catalog_request(agent_id).map_err(|_| ReadFailure::Protocol)?;
        let _ = SKILL_STATUS_METHODS;
        let outcome = match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(ReadFailure::Rejected),
            Ok(response) => SkillCatalog::decode(response).map_err(|_| ReadFailure::Protocol),
            Err(error) => Err(map_read_failure(error)),
        };
        match &outcome {
            Ok(catalog) => log_session_trace(
                "runtime.openclaw.agent-config.skills-status.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": "catalog", "optionCount": catalog.options().len() }),
            ),
            Err(error) => log_session_trace(
                "runtime.openclaw.agent-config.skills-status.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": read_failure_reason(*error) }),
            ),
        }
        outcome
    }

    async fn mutate(&self, agent_id: String, patch: Patch) -> MutationOutcome {
        if !valid_identifier(&agent_id) || !patch.is_valid() {
            return MutationOutcome::Rejected;
        }
        let snapshot = match self.read_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(ReadFailure::Rejected) => return MutationOutcome::Rejected,
            Err(ReadFailure::Unavailable | ReadFailure::Protocol) => {
                return MutationOutcome::OutcomeUnknown;
            }
        };
        let request = match snapshot.patch(agent_id, patch) {
            Ok(request) => request,
            Err(()) => return MutationOutcome::Rejected,
        };
        self.write(request).await
    }

    async fn read_snapshot(&self) -> Result<Snapshot, ReadFailure> {
        log_session_trace(
            "runtime.openclaw.agent-config.config-get.request",
            self.trace_id.as_deref(),
            serde_json::json!({}),
        );
        let request = wire::operations_request(
            next_request_id("configuration-get"),
            CONFIG_GET_METHOD,
            Value::Object(Map::new()),
        )
        .map_err(|_| ReadFailure::Protocol)?;
        let _ = CONFIG_READ_METHODS;
        let outcome = match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(ReadFailure::Rejected),
            Ok(response) => Snapshot::decode(response).map_err(|_| ReadFailure::Protocol),
            Err(error) => Err(map_read_failure(error)),
        };
        match &outcome {
            Ok(snapshot) => log_session_trace(
                "runtime.openclaw.agent-config.config-get.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({
                    "result": "snapshot",
                    "configBytes": snapshot.document.len(),
                    "hasBaseHash": snapshot.base_hash.is_some(),
                }),
            ),
            Err(error) => log_session_trace(
                "runtime.openclaw.agent-config.config-get.outcome",
                self.trace_id.as_deref(),
                serde_json::json!({ "result": read_failure_reason(*error) }),
            ),
        }
        outcome
    }

    async fn write(&self, request: ConfigPatchRequest) -> MutationOutcome {
        let request_id = request.request_id().to_owned();
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(()) => return MutationOutcome::Rejected,
        };
        log_session_trace(
            "runtime.openclaw.agent-config.config-patch.request",
            self.trace_id.as_deref(),
            serde_json::json!({ "requestBytes": encoded.len() }),
        );
        let _ = CONFIG_WRITE_METHODS;
        let outcome = match self.gateway.rpc_encoded_mutation(request_id, encoded).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. })
            | MutationDelivery::NotWritten(_) => MutationOutcome::Rejected,
            MutationDelivery::Response(response) => {
                if decode_config_patch(response) {
                    MutationOutcome::Applied
                } else {
                    MutationOutcome::OutcomeUnknown
                }
            }
            MutationDelivery::MayHaveReached(_) => MutationOutcome::OutcomeUnknown,
        };
        log_session_trace(
            "runtime.openclaw.agent-config.config-patch.outcome",
            self.trace_id.as_deref(),
            serde_json::json!({ "result": mutation_outcome_reason(outcome) }),
        );
        outcome
    }
}

impl fmt::Debug for AgentConfiguration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentConfiguration")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Display {
    defaults: DisplayDefaults,
    agents: Vec<DisplayAgent>,
}

impl Display {
    pub fn defaults(&self) -> &DisplayDefaults {
        &self.defaults
    }

    pub fn agents(&self) -> &[DisplayAgent] {
        &self.agents
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DisplayDefaults {
    workspace: Option<String>,
    model: Option<Model>,
    skills: Vec<String>,
}

impl DisplayDefaults {
    pub fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }

    pub fn model(&self) -> Option<&Model> {
        self.model.as_ref()
    }

    pub fn skills(&self) -> &[String] {
        &self.skills
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayAgent {
    id: String,
    description: Option<String>,
    workspace: Option<String>,
    model: Option<Model>,
    skills: Option<Vec<String>>,
}

impl DisplayAgent {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }

    pub fn model(&self) -> Option<&Model> {
        self.model.as_ref()
    }

    pub fn skills(&self) -> Option<&[String]> {
        self.skills.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Model {
    primary: Option<String>,
    fallbacks: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelValidationError;

impl Model {
    pub fn try_new(
        primary: Option<String>,
        fallbacks: Vec<String>,
    ) -> Result<Self, ModelValidationError> {
        let primary = primary.and_then(|value| normalize_text(&value));
        let mut normalized = BTreeSet::new();
        for fallback in fallbacks {
            let fallback = normalize_text(&fallback).ok_or(ModelValidationError)?;
            if primary.as_deref() != Some(&fallback) {
                normalized.insert(fallback);
            }
        }
        if primary.is_none() && normalized.is_empty() {
            return Err(ModelValidationError);
        }
        Ok(Self {
            primary,
            fallbacks: normalized.into_iter().collect(),
        })
    }

    pub fn primary(&self) -> Option<&str> {
        self.primary.as_deref()
    }

    pub fn fallbacks(&self) -> &[String] {
        &self.fallbacks
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Applied,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillSelection {
    InheritDefaultSkills,
    ExplicitSkillAllowlist(Vec<String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolSelection {
    InheritDefaultTools,
    Policy {
        profile: String,
        allow: Vec<String>,
        deny: Vec<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillConfigurationOutcome {
    View(SkillConfigurationView),
    Updated(SkillConfigurationView),
    Stale(SkillConfigurationView),
    InvalidSkillKeys {
        unknown_skill_keys: Vec<String>,
        non_canonical_skill_keys: Vec<String>,
    },
    Unsupported,
    Rejected,
    OutcomeUnknown,
    Unavailable(ReadFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolConfigurationOutcome {
    View(ToolConfigurationView),
    Updated(ToolConfigurationView),
    Stale(ToolConfigurationView),
    InvalidToolKeys(Vec<String>),
    Unsupported,
    Rejected,
    OutcomeUnknown,
    Unavailable(ReadFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillConfigurationView {
    agent_id: String,
    configured: bool,
    has_explicit_skill_allowlist: bool,
    explicit_skill_keys: Vec<String>,
    inherited_default_skill_keys: Vec<String>,
    effective_skill_keys: Vec<String>,
    options: Vec<SkillOption>,
    revision: String,
}

impl SkillConfigurationView {
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
    pub fn configured(&self) -> bool {
        self.configured
    }
    pub fn has_explicit_skill_allowlist(&self) -> bool {
        self.has_explicit_skill_allowlist
    }
    pub fn explicit_skill_keys(&self) -> &[String] {
        &self.explicit_skill_keys
    }
    pub fn inherited_default_skill_keys(&self) -> &[String] {
        &self.inherited_default_skill_keys
    }
    pub fn effective_skill_keys(&self) -> &[String] {
        &self.effective_skill_keys
    }
    pub fn options(&self) -> &[SkillOption] {
        &self.options
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillOption {
    key: String,
    display_name: String,
    description: String,
    selectable: bool,
    unavailable_reason: Option<SkillUnavailableReason>,
    missing_requirements: Option<MissingSkillRequirements>,
}

impl SkillOption {
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn description(&self) -> &str {
        &self.description
    }
    pub fn selectable(&self) -> bool {
        self.selectable
    }
    pub fn unavailable_reason(&self) -> Option<SkillUnavailableReason> {
        self.unavailable_reason
    }
    pub fn missing_requirements(&self) -> Option<&MissingSkillRequirements> {
        self.missing_requirements.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SkillUnavailableReason {
    GlobalSkillDisabled,
    BlockedByRuntimeAllowlist,
    MissingRequirements,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MissingSkillRequirements {
    bins: Vec<String>,
    any_bins: Vec<String>,
    env: Vec<String>,
    config: Vec<String>,
    os: Vec<String>,
}

impl MissingSkillRequirements {
    pub fn bins(&self) -> &[String] {
        &self.bins
    }
    pub fn any_bins(&self) -> &[String] {
        &self.any_bins
    }
    pub fn env(&self) -> &[String] {
        &self.env
    }
    pub fn config(&self) -> &[String] {
        &self.config
    }
    pub fn os(&self) -> &[String] {
        &self.os
    }
    fn is_empty(&self) -> bool {
        self.bins.is_empty()
            && self.any_bins.is_empty()
            && self.env.is_empty()
            && self.config.is_empty()
            && self.os.is_empty()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct SkillCatalog {
    options: Vec<SkillOption>,
}

impl SkillCatalog {
    fn decode(response: GatewayResponse) -> Result<Self, ()> {
        let GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } = response
        else {
            return Err(());
        };
        let skills = payload.get("skills").and_then(Value::as_array).ok_or(())?;
        let mut options = skills.iter().filter_map(skill_option).collect::<Vec<_>>();
        options.sort_by(|left, right| left.key.cmp(&right.key));
        options.dedup_by(|left, right| left.key == right.key);
        Ok(Self { options })
    }

    fn options(&self) -> &[SkillOption] {
        &self.options
    }

    fn options_for_allowlist_view(self, selected_skill_keys: &[String]) -> Vec<SkillOption> {
        let selected_skill_keys = selected_skill_keys
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        self.options
            .into_iter()
            .filter(|option| option.selectable || selected_skill_keys.contains(option.key.as_str()))
            .collect()
    }

    fn canonicalize(
        &self,
        requested: Vec<String>,
    ) -> Result<Vec<String>, (Vec<String>, Vec<String>)> {
        let options = self
            .options
            .iter()
            .map(|option| (option.key.as_str(), option))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut canonical = BTreeSet::new();
        let mut unknown = BTreeSet::new();
        let mut non_canonical = BTreeSet::new();
        for key in requested {
            let normalized = canonical_skill(&key);
            let Some(normalized) = normalized else {
                unknown.insert(key);
                continue;
            };
            if normalized != key {
                non_canonical.insert(key);
                continue;
            }
            let Some(option) = options.get(normalized.as_str()) else {
                unknown.insert(normalized);
                continue;
            };
            if !option.selectable {
                unknown.insert(normalized);
                continue;
            }
            canonical.insert(normalized);
        }
        if unknown.is_empty() && non_canonical.is_empty() {
            Ok(canonical.into_iter().collect())
        } else {
            Err((
                unknown.into_iter().collect(),
                non_canonical.into_iter().collect(),
            ))
        }
    }
}

fn skill_option(value: &Value) -> Option<SkillOption> {
    let skill = value.as_object()?;
    let key = skill
        .get("skillKey")
        .and_then(Value::as_str)
        .and_then(canonical_skill)?;
    let missing_requirements = missing_skill_requirements(skill.get("missing"));
    let unavailable_reason = if skill.get("disabled") == Some(&Value::Bool(true)) {
        Some(SkillUnavailableReason::GlobalSkillDisabled)
    } else if skill.get("blockedByAllowlist") == Some(&Value::Bool(true)) {
        Some(SkillUnavailableReason::BlockedByRuntimeAllowlist)
    } else if missing_requirements.is_some() {
        Some(SkillUnavailableReason::MissingRequirements)
    } else {
        None
    };
    Some(SkillOption {
        display_name: skill
            .get("name")
            .and_then(value_text)
            .unwrap_or_else(|| key.clone()),
        description: skill
            .get("description")
            .and_then(value_text)
            .unwrap_or_default(),
        selectable: unavailable_reason.is_none(),
        key,
        unavailable_reason,
        missing_requirements,
    })
}

fn missing_skill_requirements(value: Option<&Value>) -> Option<MissingSkillRequirements> {
    let missing = value?.as_object()?;
    let requirements = MissingSkillRequirements {
        bins: missing.get("bins").map(display_skills).unwrap_or_default(),
        any_bins: missing
            .get("anyBins")
            .map(display_skills)
            .unwrap_or_default(),
        env: missing.get("env").map(display_skills).unwrap_or_default(),
        config: missing
            .get("config")
            .map(display_skills)
            .unwrap_or_default(),
        os: missing.get("os").map(display_skills).unwrap_or_default(),
    };
    (!requirements.is_empty()).then_some(requirements)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolConfigurationView {
    agent_id: String,
    configured: bool,
    policy: Option<ToolPolicy>,
    catalog: ToolCatalog,
    revision: String,
}

impl ToolConfigurationView {
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
    pub fn configured(&self) -> bool {
        self.configured
    }
    pub fn policy(&self) -> Option<&ToolPolicy> {
        self.policy.as_ref()
    }
    pub fn catalog(&self) -> &ToolCatalog {
        &self.catalog
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolPolicy {
    profile: String,
    allow: Vec<String>,
    deny: Vec<String>,
}

impl ToolPolicy {
    pub fn profile(&self) -> &str {
        &self.profile
    }
    pub fn allow(&self) -> &[String] {
        &self.allow
    }
    pub fn deny(&self) -> &[String] {
        &self.deny
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCatalog {
    profiles: Vec<ToolProfile>,
    groups: Vec<ToolGroup>,
    options: Vec<ToolOption>,
    policy_keys: BTreeSet<String>,
}

impl ToolCatalog {
    fn empty() -> Self {
        Self {
            profiles: Vec::new(),
            groups: Vec::new(),
            options: Vec::new(),
            policy_keys: BTreeSet::new(),
        }
    }

    fn decode(response: GatewayResponse) -> Result<Self, ()> {
        let GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } = response
        else {
            return Err(());
        };
        let groups = payload
            .get("groups")
            .and_then(Value::as_array)
            .ok_or(())?
            .iter()
            .filter_map(tool_group)
            .collect::<Vec<_>>();
        if groups.is_empty() {
            return Err(());
        }
        let profiles = payload
            .get("profiles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(tool_profile)
            .collect();
        let mut options = Vec::new();
        let mut policy_keys = BTreeSet::from([
            "*".to_owned(),
            "group:openclaw".to_owned(),
            "group:plugins".to_owned(),
        ]);
        for group in &groups {
            let group_key = if group.source == "core" {
                Some(format!("group:{}", group.key))
            } else {
                group.plugin_id.clone()
            };
            if let Some(key) = group_key {
                policy_keys.insert(key.clone());
                options.push(ToolOption::group(
                    key,
                    format!("{} tools", group.display_name),
                    group.source.clone(),
                    group.plugin_id.clone(),
                ));
            }
            for tool in &group.tools {
                policy_keys.insert(tool.key.clone());
                if let Some(plugin_id) = &tool.plugin_id {
                    policy_keys.insert(plugin_id.clone());
                }
                if let Some((server, _)) = tool.key.split_once("__")
                    && !server.is_empty()
                {
                    policy_keys.insert(format!("{server}__*"));
                }
                options.push(tool.clone());
            }
        }
        options.sort_by(|left, right| left.key.cmp(&right.key));
        options.dedup_by(|left, right| left.key == right.key);
        Ok(Self {
            profiles,
            groups,
            options,
            policy_keys,
        })
    }

    pub fn profiles(&self) -> &[ToolProfile] {
        &self.profiles
    }
    pub fn groups(&self) -> &[ToolGroup] {
        &self.groups
    }
    pub fn options(&self) -> &[ToolOption] {
        &self.options
    }
    fn policy_keys(&self) -> &BTreeSet<String> {
        &self.policy_keys
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolProfile {
    key: String,
    display_name: String,
}
impl ToolProfile {
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolGroup {
    key: String,
    display_name: String,
    source: String,
    plugin_id: Option<String>,
    tools: Vec<ToolOption>,
}
impl ToolGroup {
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn plugin_id(&self) -> Option<&str> {
        self.plugin_id.as_deref()
    }
    pub fn tools(&self) -> &[ToolOption] {
        &self.tools
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolOption {
    key: String,
    display_name: String,
    description: Option<String>,
    source: String,
    plugin_id: Option<String>,
    optional: Option<bool>,
    risk: Option<String>,
    tags: Vec<String>,
    default_profiles: Vec<String>,
    group_key: Option<String>,
    group_display_name: Option<String>,
}
impl ToolOption {
    fn group(key: String, display_name: String, source: String, plugin_id: Option<String>) -> Self {
        Self {
            key,
            display_name,
            description: None,
            source,
            plugin_id,
            optional: None,
            risk: None,
            tags: Vec::new(),
            default_profiles: Vec::new(),
            group_key: None,
            group_display_name: None,
        }
    }
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn plugin_id(&self) -> Option<&str> {
        self.plugin_id.as_deref()
    }
    pub fn optional(&self) -> Option<bool> {
        self.optional
    }
    pub fn risk(&self) -> Option<&str> {
        self.risk.as_deref()
    }
    pub fn tags(&self) -> &[String] {
        &self.tags
    }
    pub fn default_profiles(&self) -> &[String] {
        &self.default_profiles
    }
    pub fn group_key(&self) -> Option<&str> {
        self.group_key.as_deref()
    }
    pub fn group_display_name(&self) -> Option<&str> {
        self.group_display_name.as_deref()
    }
}

fn tool_profile(value: &Value) -> Option<ToolProfile> {
    let value = value.as_object()?;
    let key = value.get("id").and_then(value_text)?;
    Some(ToolProfile {
        display_name: value
            .get("label")
            .and_then(value_text)
            .unwrap_or_else(|| key.clone()),
        key,
    })
}

fn tool_group(value: &Value) -> Option<ToolGroup> {
    let value = value.as_object()?;
    let key = value.get("id").and_then(value_text)?;
    let source = value
        .get("source")
        .and_then(value_text)
        .filter(|source| source == "plugin")
        .unwrap_or_else(|| "core".into());
    let plugin_id = value.get("pluginId").and_then(value_text);
    let display_name = value
        .get("label")
        .and_then(value_text)
        .unwrap_or_else(|| plugin_id.clone().unwrap_or_else(|| key.clone()));
    let tools = value
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let tool = tool.as_object()?;
            let tool_key = tool.get("id").and_then(value_text)?;
            Some(ToolOption {
                display_name: tool
                    .get("label")
                    .and_then(value_text)
                    .unwrap_or_else(|| tool_key.clone()),
                description: tool.get("description").and_then(value_text),
                source: tool
                    .get("source")
                    .and_then(value_text)
                    .filter(|source| source == "plugin")
                    .unwrap_or_else(|| source.clone()),
                plugin_id: tool
                    .get("pluginId")
                    .and_then(value_text)
                    .or_else(|| plugin_id.clone()),
                optional: tool.get("optional").and_then(Value::as_bool),
                risk: tool.get("risk").and_then(catalog_risk),
                tags: value_texts(tool.get("tags")),
                default_profiles: value_texts(tool.get("defaultProfiles")),
                group_key: Some(key.clone()),
                group_display_name: Some(display_name.clone()),
                key: tool_key,
            })
        })
        .collect();
    Some(ToolGroup {
        key,
        display_name,
        source,
        plugin_id,
        tools,
    })
}

fn unknown_tool_keys(allow: &[String], deny: &[String], known: &BTreeSet<String>) -> Vec<String> {
    allow
        .iter()
        .filter(|key| !known.contains(*key))
        .chain(
            deny.iter()
                .filter(|key| !known.contains(*key) && !is_agent_facing_internal_tool_deny(key)),
        )
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn enforce_agent_facing_internal_tool_deny(selection: ToolSelection) -> ToolSelection {
    match selection {
        ToolSelection::InheritDefaultTools => selection,
        ToolSelection::Policy {
            profile,
            allow,
            mut deny,
        } => {
            append_agent_facing_internal_tool_deny(&mut deny);
            ToolSelection::Policy {
                profile,
                allow,
                deny,
            }
        }
    }
}

fn append_agent_facing_internal_tool_deny(deny: &mut Vec<String>) {
    for tool in AGENT_FACING_INTERNAL_TOOL_DENY {
        if !deny.iter().any(|existing| existing == tool) {
            deny.push(tool.to_owned());
        }
    }
}

fn is_agent_facing_internal_tool_deny(value: &str) -> bool {
    AGENT_FACING_INTERNAL_TOOL_DENY.contains(&value)
}

fn skill_catalog_request(agent_id: &str) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        next_request_id("skills-status"),
        SKILLS_STATUS_METHOD,
        serde_json::json!({ "agentId": agent_id }),
    )
}

fn tool_catalog_request(agent_id: &str) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        next_request_id("tools-catalog"),
        TOOLS_CATALOG_METHOD,
        serde_json::json!({ "agentId": agent_id, "includePlugins": true }),
    )
}

enum Patch {
    Description(Option<String>),
    Model(Option<Model>),
    Skills(Vec<String>),
    SkillConfiguration(Option<Vec<String>>),
    ToolConfiguration(ToolSelection),
}

impl Patch {
    fn is_valid(&self) -> bool {
        match self {
            Self::Description(value) => value.as_deref().is_none_or(valid_text),
            Self::Model(value) => value.as_ref().is_none_or(|value| {
                value.primary.as_deref().is_none_or(valid_text)
                    && value.fallbacks.iter().all(|value| valid_text(value))
            }),
            Self::Skills(values) => values.iter().all(|value| valid_text(value)),
            Self::SkillConfiguration(values) => values
                .as_ref()
                .is_none_or(|values| values.iter().all(|value| valid_text(value))),
            Self::ToolConfiguration(ToolSelection::InheritDefaultTools) => true,
            Self::ToolConfiguration(ToolSelection::Policy {
                profile,
                allow,
                deny,
            }) => {
                valid_text(profile)
                    && allow.iter().all(|value| valid_text(value))
                    && deny.iter().all(|value| valid_text(value))
            }
        }
    }

    fn apply(self, entry: &mut Map<String, Value>, default_model_fallbacks: &[String]) {
        match self {
            Self::Description(Some(value)) => {
                entry.insert("description".into(), Value::String(value));
            }
            Self::Description(None) => {
                entry.insert("description".into(), Value::Null);
            }
            Self::Model(Some(model)) => {
                let model = model_for_primary_patch(entry, model, default_model_fallbacks);
                entry.insert("model".into(), model.into_value());
            }
            Self::Model(None) => {
                entry.insert("model".into(), Value::Null);
            }
            Self::Skills(values) if values.is_empty() => {
                entry.insert("skills".into(), Value::Null);
            }
            Self::Skills(values) => {
                entry.insert(
                    "skills".into(),
                    Value::Array(values.into_iter().map(Value::String).collect()),
                );
            }
            Self::SkillConfiguration(None) => {
                entry.insert("skills".into(), Value::Null);
            }
            Self::SkillConfiguration(Some(values)) => {
                entry.insert(
                    "skills".into(),
                    Value::Array(values.into_iter().map(Value::String).collect()),
                );
            }
            Self::ToolConfiguration(ToolSelection::InheritDefaultTools) => {
                entry.insert("tools".into(), Value::Null);
            }
            Self::ToolConfiguration(ToolSelection::Policy {
                profile,
                allow,
                deny,
            }) => {
                entry.insert(
                    "tools".into(),
                    serde_json::json!({ "profile": profile, "allow": allow, "deny": deny }),
                );
            }
        }
    }
}

fn model_for_primary_patch(
    entry: &Map<String, Value>,
    mut model: Model,
    default_model_fallbacks: &[String],
) -> Model {
    if !model.fallbacks.is_empty() {
        return model;
    }
    let fallbacks = entry
        .get("model")
        .and_then(display_model)
        .map(|model| model.fallbacks)
        .filter(|fallbacks| !fallbacks.is_empty())
        .unwrap_or_else(|| default_model_fallbacks.to_vec());
    if let Some(primary) = model.primary.as_deref() {
        model.fallbacks = fallbacks
            .into_iter()
            .filter(|fallback| fallback != primary)
            .collect();
    } else {
        model.fallbacks = fallbacks;
    }
    model
}

impl Model {
    fn into_value(self) -> Value {
        if self.fallbacks.is_empty() {
            return self.primary.map(Value::String).unwrap_or(Value::Null);
        }
        let mut model = Map::new();
        if let Some(primary) = self.primary {
            model.insert("primary".into(), Value::String(primary));
        }
        model.insert(
            "fallbacks".into(),
            Value::Array(self.fallbacks.into_iter().map(Value::String).collect()),
        );
        Value::Object(model)
    }
}

struct Snapshot {
    document: Vec<u8>,
    source_document: Vec<u8>,
    base_hash: Option<Vec<u8>>,
}

impl Snapshot {
    fn decode(response: GatewayResponse) -> Result<Self, ()> {
        let GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } = response
        else {
            return Err(());
        };
        if payload.get("valid") != Some(&Value::Bool(true)) {
            return Err(());
        }
        let config = payload
            .get("config")
            .filter(|value| value.is_object())
            .ok_or(())?;
        let source_config = payload
            .get("sourceConfig")
            .filter(|value| value.is_object())
            .ok_or(())?;
        let document = serde_json::to_vec(config).map_err(|_| ())?;
        let source_document = serde_json::to_vec(source_config).map_err(|_| ())?;
        let base_hash = match payload.get("hash") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.as_bytes().to_vec()),
            _ => return Err(()),
        };
        Ok(Self {
            document,
            source_document,
            base_hash,
        })
    }

    fn display(&self) -> Result<Display, ReadFailure> {
        let document = self.document().map_err(|_| ReadFailure::Protocol)?;
        let agents = document.get("agents");
        let defaults = agents
            .and_then(Value::as_object)
            .and_then(|agents| agents.get("defaults"))
            .and_then(Value::as_object)
            .map(display_defaults)
            .unwrap_or_default();
        let entries = agents
            .and_then(agent_entries)
            .into_iter()
            .flatten()
            .filter_map(display_agent)
            .collect();
        Ok(Display {
            defaults,
            agents: entries,
        })
    }

    fn revision(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(&self.document);
        if let Some(base_hash) = &self.base_hash {
            digest.update(base_hash);
        }
        format!("{:x}", digest.finalize())
    }

    fn has_agent(&self, agent_id: &str) -> bool {
        self.document().ok().is_some_and(|document| {
            document
                .get("agents")
                .and_then(agent_entries)
                .is_some_and(|entries| entries.iter().any(|agent| agent.id() == Some(agent_id)))
        })
    }

    fn skill_view_without_catalog(&self, agent_id: String) -> SkillConfigurationView {
        SkillConfigurationView {
            agent_id,
            configured: false,
            has_explicit_skill_allowlist: false,
            explicit_skill_keys: Vec::new(),
            inherited_default_skill_keys: Vec::new(),
            effective_skill_keys: Vec::new(),
            options: Vec::new(),
            revision: self.revision(),
        }
    }

    fn skill_view(
        &self,
        agent_id: String,
        catalog: SkillCatalog,
    ) -> Result<SkillConfigurationView, ()> {
        let document = self.document()?;
        let configured_defaults = document
            .get("agents")
            .and_then(Value::as_object)
            .and_then(|agents| agents.get("defaults"))
            .and_then(Value::as_object)
            .and_then(|defaults| defaults.get("skills"))
            .map(display_skills)
            .unwrap_or_default();
        let agent = document
            .get("agents")
            .and_then(agent_entries)
            .into_iter()
            .flatten()
            .find(|agent| agent.id() == Some(agent_id.as_str()))
            .and_then(ConfigAgentEntry::fields)
            .ok_or(())?;
        let explicit = agent
            .get("skills")
            .filter(|skills| skills.is_array())
            .map(display_skills);
        let inherited_default_skill_keys = if configured_defaults.is_empty() {
            catalog
                .options()
                .iter()
                .filter(|option| option.selectable())
                .map(|option| option.key().to_owned())
                .collect()
        } else {
            configured_defaults
        };
        let effective_skill_keys = explicit
            .clone()
            .unwrap_or_else(|| inherited_default_skill_keys.clone());
        let options = catalog.options_for_allowlist_view(&effective_skill_keys);
        Ok(SkillConfigurationView {
            agent_id,
            configured: true,
            has_explicit_skill_allowlist: explicit.is_some(),
            explicit_skill_keys: explicit.unwrap_or_default(),
            inherited_default_skill_keys,
            effective_skill_keys,
            options,
            revision: self.revision(),
        })
    }

    fn tool_view_without_catalog(&self, agent_id: String) -> ToolConfigurationView {
        ToolConfigurationView {
            agent_id,
            configured: false,
            policy: None,
            catalog: ToolCatalog::empty(),
            revision: self.revision(),
        }
    }

    fn tool_view(
        &self,
        agent_id: String,
        catalog: ToolCatalog,
    ) -> Result<ToolConfigurationView, ()> {
        let document = self.document()?;
        let agent = document
            .get("agents")
            .and_then(agent_entries)
            .into_iter()
            .flatten()
            .find(|agent| agent.id() == Some(agent_id.as_str()))
            .and_then(ConfigAgentEntry::fields);
        let Some(agent) = agent else {
            return Ok(self.tool_view_without_catalog(agent_id));
        };
        let policy = agent
            .get("tools")
            .and_then(Value::as_object)
            .and_then(|tools| {
                let profile = tools.get("profile").and_then(value_text)?;
                let mut deny = tools
                    .get("deny")
                    .map(display_tool_policy_keys)
                    .unwrap_or_default();
                append_agent_facing_internal_tool_deny(&mut deny);
                Some(ToolPolicy {
                    profile,
                    allow: tools.get("allow").map(display_skills).unwrap_or_default(),
                    deny,
                })
            });
        Ok(ToolConfigurationView {
            agent_id,
            configured: true,
            policy,
            catalog,
            revision: self.revision(),
        })
    }

    fn patch_existing(self, agent_id: String, patch: Patch) -> Result<ConfigPatchRequest, ()> {
        if !self.has_agent(&agent_id) {
            return Err(());
        }
        self.patch(agent_id, patch)
    }

    fn patch(mut self, agent_id: String, patch: Patch) -> Result<ConfigPatchRequest, ()> {
        let document = self.source_document()?;
        let agents = document
            .get("agents")
            .and_then(Value::as_object)
            .ok_or(())?;
        let current_entry = agent_entry(agents, &agent_id).ok_or(())?;
        let entry_path = match current_entry {
            ConfigAgentEntry::List(_) => None,
            ConfigAgentEntry::Entries { id, .. } => Some(format!("agents.entries.{id}")),
        };
        let agent_id = current_entry.id().ok_or(())?.to_owned();
        let current_entry = Value::Object(current_entry.fields().ok_or(())?);
        let mut expected_agents = agents.clone();
        patch_agent_entry(&mut expected_agents, agent_id.clone(), patch)?;
        let expected_entry = agent_entry(&expected_agents, &agent_id)
            .and_then(ConfigAgentEntry::fields)
            .map(Value::Object)
            .ok_or(())?;
        let mut entry_patch = merge_patch(&current_entry, &expected_entry);
        let path = match entry_path.as_deref() {
            Some(path) => path,
            None => {
                entry_patch
                    .as_object_mut()
                    .ok_or(())?
                    .insert("id".into(), Value::String(agent_id.clone()));
                "agents.list[]"
            }
        };
        let replace_paths =
            destructive_array_replace_paths_at(&current_entry, &expected_entry, path);
        let raw = serde_json::to_vec(&agent_patch_document(
            agent_id,
            entry_patch,
            entry_path.is_some(),
        )?)
        .map_err(|_| ())?;
        Ok(ConfigPatchRequest {
            request_id: next_request_id("configuration-patch"),
            raw,
            base_hash: self.base_hash.take(),
            replace_paths,
        })
    }

    fn document(&self) -> Result<Value, ()> {
        serde_json::from_slice(&self.document).map_err(|_| ())
    }

    fn source_document(&self) -> Result<Value, ()> {
        serde_json::from_slice(&self.source_document).map_err(|_| ())
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        self.document.fill(0);
        self.source_document.fill(0);
        if let Some(base_hash) = &mut self.base_hash {
            base_hash.fill(0);
        }
    }
}

struct ConfigPatchRequest {
    request_id: String,
    raw: Vec<u8>,
    base_hash: Option<Vec<u8>>,
    replace_paths: Vec<String>,
}

impl ConfigPatchRequest {
    fn request_id(&self) -> &str {
        &self.request_id
    }

    fn encode(&self) -> Result<String, ()> {
        if !request_parts_are_valid(
            &self.request_id,
            &self.raw,
            self.base_hash.as_deref(),
            &self.replace_paths,
        ) {
            return Err(());
        }
        encode_config_patch_request(
            &self.request_id,
            std::str::from_utf8(&self.raw).map_err(|_| ())?,
            self.base_hash
                .as_ref()
                .map(|value| std::str::from_utf8(value).map_err(|_| ()))
                .transpose()?,
            &self.replace_paths,
        )
        .map_err(|_| ())
    }
}

impl Drop for ConfigPatchRequest {
    fn drop(&mut self) {
        self.raw.fill(0);
        if let Some(base_hash) = &mut self.base_hash {
            base_hash.fill(0);
        }
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

#[derive(Clone, Copy)]
enum ConfigAgentEntry<'a> {
    List(&'a Value),
    Entries { id: &'a str, value: &'a Value },
}

impl ConfigAgentEntry<'_> {
    fn id(&self) -> Option<&str> {
        match self {
            Self::List(value) => value
                .as_object()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str),
            Self::Entries { id, .. } => Some(id),
        }
    }

    fn fields(self) -> Option<Map<String, Value>> {
        match self {
            Self::List(value) => value.as_object().cloned(),
            Self::Entries { id, value } => {
                let mut fields = value.as_object().cloned()?;
                fields.insert("id".into(), Value::String((*id).to_owned()));
                Some(fields)
            }
        }
    }
}

fn agent_entries(agents: &Value) -> Option<Vec<ConfigAgentEntry<'_>>> {
    let agents = agents.as_object()?;
    if let Some(entries) = agents.get("entries").and_then(Value::as_object) {
        return Some(
            entries
                .iter()
                .map(|(id, value)| ConfigAgentEntry::Entries { id, value })
                .collect(),
        );
    }
    Some(
        agents
            .get("list")?
            .as_array()?
            .iter()
            .map(ConfigAgentEntry::List)
            .collect(),
    )
}

fn agent_entry<'a>(
    agents: &'a Map<String, Value>,
    agent_id: &'a str,
) -> Option<ConfigAgentEntry<'a>> {
    if let Some(entries) = agents.get("entries").and_then(Value::as_object) {
        return entries
            .get(agent_id)
            .map(|value| ConfigAgentEntry::Entries {
                id: agent_id,
                value,
            });
    }
    agents
        .get("list")
        .and_then(Value::as_array)
        .and_then(|list| list_agent_entry(list, agent_id))
}

fn list_agent_entry<'a>(list: &'a [Value], agent_id: &str) -> Option<ConfigAgentEntry<'a>> {
    if !list.iter().all(|value| {
        value.as_object().is_some_and(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(valid_text)
        })
    }) {
        return None;
    }
    let mut matching = list
        .iter()
        .filter(|value| {
            value
                .as_object()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str)
                == Some(agent_id)
        })
        .map(ConfigAgentEntry::List);
    let entry = matching.next()?;
    matching.next().is_none().then_some(entry)
}

fn agent_patch_document(
    agent_id: String,
    entry_patch: Value,
    entries_shape: bool,
) -> Result<Value, ()> {
    let mut root = Map::new();
    let mut agents = Map::new();
    if entries_shape {
        let mut entries = Map::new();
        entries.insert(agent_id, entry_patch);
        agents.insert("entries".into(), Value::Object(entries));
    } else {
        agents.insert("list".into(), Value::Array(vec![entry_patch]));
    }
    root.insert("agents".into(), Value::Object(agents));
    Ok(Value::Object(root))
}

fn patch_agent_entry(
    agents: &mut Map<String, Value>,
    agent_id: String,
    patch: Patch,
) -> Result<(), ()> {
    let default_model_fallbacks = agents
        .get("defaults")
        .and_then(Value::as_object)
        .and_then(|defaults| defaults.get("model"))
        .and_then(display_model)
        .map(|model| model.fallbacks)
        .unwrap_or_default();
    if agents.get("entries").is_some() {
        patch_agent_entries(agents, agent_id, patch, &default_model_fallbacks)
    } else {
        patch_agent_list(agents, agent_id, patch, &default_model_fallbacks)
    }
}

fn patch_agent_entries(
    agents: &mut Map<String, Value>,
    agent_id: String,
    patch: Patch,
    default_model_fallbacks: &[String],
) -> Result<(), ()> {
    let entries = agents
        .entry("entries")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or(())?;
    let entry = entries
        .entry(agent_id)
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or(())?;
    patch.apply(entry, default_model_fallbacks);
    entry.remove("id");
    Ok(())
}

fn patch_agent_list(
    agents: &mut Map<String, Value>,
    agent_id: String,
    patch: Patch,
    default_model_fallbacks: &[String],
) -> Result<(), ()> {
    let list = agents
        .entry("list")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or(())?;
    let matching = list
        .iter()
        .enumerate()
        .filter(|(_, value)| {
            value
                .as_object()
                .and_then(|entry| entry.get("id"))
                .and_then(Value::as_str)
                == Some(agent_id.as_str())
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut entry = match matching.as_slice() {
        [] => {
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(agent_id));
            entry
        }
        [index] => list[*index].as_object().cloned().ok_or(())?,
        _ => return Err(()),
    };
    patch.apply(&mut entry, default_model_fallbacks);
    match matching.as_slice() {
        [] => list.push(Value::Object(entry)),
        [index] => list[*index] = Value::Object(entry),
        _ => unreachable!("duplicate agent IDs were rejected"),
    }
    Ok(())
}

fn display_defaults(entry: &Map<String, Value>) -> DisplayDefaults {
    DisplayDefaults {
        workspace: entry.get("workspace").and_then(value_text),
        model: entry.get("model").and_then(display_model),
        skills: entry.get("skills").map(display_skills).unwrap_or_default(),
    }
}

fn display_agent(value: ConfigAgentEntry<'_>) -> Option<DisplayAgent> {
    let entry = value.fields()?;
    let id = entry.get("id").and_then(value_text)?;
    Some(DisplayAgent {
        id,
        description: entry.get("description").and_then(value_text),
        workspace: entry.get("workspace").and_then(value_text),
        model: entry.get("model").and_then(display_model),
        skills: entry.get("skills").map(display_skills),
    })
}

fn display_model(value: &Value) -> Option<Model> {
    match value {
        Value::String(value) => Model::try_new(Some(value.clone()), Vec::new()).ok(),
        Value::Object(value) => Model::try_new(
            value.get("primary").and_then(value_text),
            value
                .get("fallbacks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(value_text)
                .collect(),
        )
        .ok(),
        _ => None,
    }
}

fn display_skills(value: &Value) -> Vec<String> {
    let mut skills = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(value_text)
        .filter_map(|value| canonical_skill(&value))
        .collect::<Vec<_>>();
    skills.sort();
    skills.dedup();
    skills
}

fn display_tool_policy_keys(value: &Value) -> Vec<String> {
    let mut seen = BTreeSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(value_text)
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn value_text(value: &Value) -> Option<String> {
    value.as_str().and_then(normalize_text)
}

fn value_texts(value: Option<&Value>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(value_text)
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn catalog_risk(value: &Value) -> Option<String> {
    let risk = value_text(value)?;
    matches!(risk.as_str(), "low" | "medium" | "high").then_some(risk)
}

fn canonical_skill(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    valid_text(&value).then_some(value)
}

fn normalize_text(value: &str) -> Option<String> {
    let value = value.trim();
    valid_text(value).then(|| value.to_owned())
}

fn valid_identifier(value: &str) -> bool {
    valid_text(value) && value.len() <= 4096
}

fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}

fn decode_config_patch(response: GatewayResponse) -> bool {
    match response {
        GatewayResponse::Success { payload: None, .. } => true,
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => payload.get("ok") == Some(&Value::Bool(true)),
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => false,
    }
}

fn map_read_failure(error: GatewayClientError) -> ReadFailure {
    match error {
        GatewayClientError::Protocol | GatewayClientError::RpcFailed => ReadFailure::Protocol,
        _ => ReadFailure::Unavailable,
    }
}

fn next_request_id(operation: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    format!(
        "agent-configuration-{operation}-{}",
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::gateway::wire::decode_response;

    fn response(mut payload: Value) -> GatewayResponse {
        if let Some(payload) = payload.as_object_mut()
            && !payload.contains_key("sourceConfig")
            && let Some(config) = payload.get("config").cloned()
        {
            payload.insert("sourceConfig".into(), config);
        }
        decode_response(
            &json!({"type": "res", "id": "request", "ok": true, "payload": payload}).to_string(),
            "request",
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn snapshot_rejects_invalid_openclaw_config_payloads() {
        assert!(
            Snapshot::decode(response(json!({
                "valid": false,
                "raw": null,
                "config": {},
                "hash": "base"
            })))
            .is_err()
        );
    }

    #[test]
    fn display_omits_malformed_entries_and_never_carries_snapshot_secrets() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"defaults":{"model":{"primary":"one","fallbacks":["two"]}},"list":[null,{"id":"writer","description":"Docs","skills":[" First ","first"]},{"description":"missing"}]}},
            "hash": "private-hash"
        })))
        .unwrap();
        let display = snapshot.display().unwrap();
        assert_eq!(display.agents().len(), 1);
        assert_eq!(display.agents()[0].id(), "writer");
        assert_eq!(
            display.agents()[0].skills(),
            Some(["first".to_owned()].as_slice())
        );
        assert!(!format!("{display:?}").contains("private-hash"));
    }

    #[test]
    fn patch_uses_base_hash_local_raw_and_redacts_request() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"private":"canary","agents":{"list":[{"id":"writer","other":"keep"}]}},
            "hash": "base-hash-canary"
        })))
        .unwrap();
        let request = snapshot
            .patch("writer".into(), Patch::Description(Some("Docs".into())))
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(frame["method"], CONFIG_PATCH_METHOD);
        assert_eq!(frame["params"]["baseHash"], "base-hash-canary");
        assert_eq!(
            raw,
            json!({"agents":{"list":[{"id":"writer","description":"Docs"}]}})
        );
        assert!(frame["params"].get("replacePaths").is_none());
        let debug = format!("{request:?}");
        assert!(!debug.contains("base-hash-canary"));
        assert!(!debug.contains("canary"));
        assert!(!debug.contains("Docs"));
    }

    #[test]
    fn patch_uses_source_config_without_runtime_defaults() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "sourceConfig": {"agents":{"list":[{"id":"writer","model":"old"}]}},
            "config": {"agents":{"defaults":{"model":{"primary":"default","fallbacks":["runtime-backup"]}},"list":[{"id":"writer","model":"old"}]}},
            "hash": "base"
        })))
        .unwrap();
        let request = snapshot
            .patch(
                "writer".into(),
                Patch::Model(Some(
                    Model::try_new(Some("new".into()), Vec::new()).unwrap(),
                )),
            )
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();

        assert_eq!(
            raw,
            json!({"agents":{"list":[{"id":"writer","model":"new"}]}})
        );
    }

    #[test]
    fn config_patch_omits_absent_base_hash() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer"}]}},
            "hash": null
        })))
        .unwrap();
        let request = snapshot
            .patch("writer".into(), Patch::Description(Some("Docs".into())))
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();

        assert!(
            !frame["params"]
                .as_object()
                .unwrap()
                .contains_key("baseHash")
        );
    }

    #[test]
    fn snapshot_reads_and_patches_entries_shape() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"entries":{"writer":{"description":"Docs","tools":{"profile":"coding","allow":["read"],"deny":["exec"]}}},"list":[{"id":"writer","description":"Docs","tools":{"profile":"coding","allow":["read"],"deny":["exec"]}}]}},
            "hash": "base"
        })))
        .unwrap();
        let display = snapshot.display().unwrap();
        assert_eq!(display.agents()[0].id(), "writer");
        assert_eq!(display.agents()[0].description(), Some("Docs"));
        let view = snapshot
            .tool_view("writer".into(), ToolCatalog::empty())
            .unwrap();
        assert_eq!(view.policy().unwrap().profile(), "coding");
        assert_eq!(view.policy().unwrap().allow(), ["read"]);
        let request = snapshot
            .patch_existing(
                "writer".into(),
                Patch::ToolConfiguration(ToolSelection::Policy {
                    profile: "minimal".into(),
                    allow: vec!["session_status".into()],
                    deny: Vec::new(),
                }),
            )
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            raw,
            json!({"agents":{"entries":{"writer":{"tools":{"profile":"minimal","allow":["session_status"],"deny":[]}}}}})
        );
        assert_eq!(
            frame["params"]["replacePaths"],
            json!([
                "agents.entries.writer.tools.allow",
                "agents.entries.writer.tools.deny"
            ])
        );
    }

    #[test]
    fn model_patch_preserves_existing_agent_fallbacks() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","model":{"primary":"old","fallbacks":["backup","new"]}}]}},
            "hash": "base"
        })))
        .unwrap();
        let request = snapshot
            .patch(
                "writer".into(),
                Patch::Model(Some(
                    Model::try_new(Some("new".into()), Vec::new()).unwrap(),
                )),
            )
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();

        assert_eq!(raw["agents"]["list"][0]["id"], "writer");
        assert_eq!(raw["agents"]["list"][0]["model"]["primary"], "new");
        assert_eq!(
            raw["agents"]["list"][0]["model"]["fallbacks"],
            json!(["backup"])
        );
    }

    #[test]
    fn model_patch_inherits_default_fallbacks_when_agent_has_none() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"defaults":{"model":{"primary":"default","fallbacks":["backup","new",7]}},"list":[{"id":"writer","model":"old"}]}},
            "hash": "base"
        })))
        .unwrap();
        let request = snapshot
            .patch(
                "writer".into(),
                Patch::Model(Some(
                    Model::try_new(Some("new".into()), Vec::new()).unwrap(),
                )),
            )
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();

        assert_eq!(raw["agents"]["list"][0]["model"]["primary"], "new");
        assert_eq!(
            raw["agents"]["list"][0]["model"]["fallbacks"],
            json!(["backup"])
        );
    }

    #[test]
    fn model_patch_keeps_minimal_serialization_without_fallbacks() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","model":{"primary":"old"}}]}},
            "hash": "base"
        })))
        .unwrap();
        let request = snapshot
            .patch(
                "writer".into(),
                Patch::Model(Some(
                    Model::try_new(Some("new".into()), Vec::new()).unwrap(),
                )),
            )
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();

        assert_eq!(raw["agents"]["list"][0]["model"], "new");
    }

    #[test]
    fn description_and_model_deletes_patch_nulls() {
        let description_snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","description":"Docs","model":"old"}]}},
            "hash": "base"
        })))
        .unwrap();
        let description_request = description_snapshot
            .patch("writer".into(), Patch::Description(None))
            .unwrap();
        let description_frame: Value =
            serde_json::from_str(&description_request.encode().unwrap()).unwrap();
        let description_raw: Value =
            serde_json::from_str(description_frame["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            description_raw,
            json!({"agents":{"list":[{"id":"writer","description":null}]}})
        );

        let model_snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","description":"Docs","model":"old"}]}},
            "hash": "base"
        })))
        .unwrap();
        let model_request = model_snapshot
            .patch("writer".into(), Patch::Model(None))
            .unwrap();
        let model_frame: Value = serde_json::from_str(&model_request.encode().unwrap()).unwrap();
        let model_raw: Value =
            serde_json::from_str(model_frame["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            model_raw,
            json!({"agents":{"list":[{"id":"writer","model":null}]}})
        );
    }

    #[test]
    fn skills_and_tools_array_reductions_emit_exact_replace_paths() {
        let skills_snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","skills":["research","plan"]}]}},
            "hash": "base"
        })))
        .unwrap();
        let skills_request = skills_snapshot
            .patch("writer".into(), Patch::Skills(vec!["research".into()]))
            .unwrap();
        let skills_frame: Value = serde_json::from_str(&skills_request.encode().unwrap()).unwrap();
        let skills_raw: Value =
            serde_json::from_str(skills_frame["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            skills_raw,
            json!({"agents":{"list":[{"id":"writer","skills":["research"]}]}})
        );
        assert_eq!(
            skills_frame["params"]["replacePaths"],
            json!(["agents.list[].skills"])
        );

        let tools_snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","tools":{"profile":"coding","allow":["read","write"],"deny":["exec"]}}]}},
            "hash": "base"
        })))
        .unwrap();
        let tools_request = tools_snapshot
            .patch(
                "writer".into(),
                Patch::ToolConfiguration(ToolSelection::Policy {
                    profile: "coding".into(),
                    allow: vec!["read".into()],
                    deny: Vec::new(),
                }),
            )
            .unwrap();
        let tools_frame: Value = serde_json::from_str(&tools_request.encode().unwrap()).unwrap();
        let tools_raw: Value =
            serde_json::from_str(tools_frame["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            tools_raw,
            json!({"agents":{"list":[{"id":"writer","tools":{"allow":["read"],"deny":[]}}]}})
        );
        assert_eq!(
            tools_frame["params"]["replacePaths"],
            json!(["agents.list[].tools.allow", "agents.list[].tools.deny"])
        );
    }

    #[test]
    fn model_and_skills_are_canonicalized_for_safe_projection() {
        let model = Model::try_new(
            Some(" primary ".into()),
            vec!["fallback".into(), "primary".into(), "fallback".into()],
        )
        .unwrap();
        assert_eq!(model.primary(), Some("primary"));
        assert_eq!(model.fallbacks(), ["fallback"]);
        assert_eq!(display_skills(&json!([" Z ", "z", 7, "a"])), ["a", "z"]);
    }

    #[test]
    fn skill_catalog_uses_agent_scoped_status_request() {
        assert_eq!(SKILL_STATUS_METHODS, [SKILLS_STATUS_METHOD]);
        let request = skill_catalog_request("writer").unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();

        assert_eq!(frame["method"], "skills.status");
        assert_eq!(frame["params"], json!({ "agentId": "writer" }));
    }

    #[test]
    fn skill_catalog_preserves_runtime_selectability_and_requires_canonical_keys() {
        let catalog = SkillCatalog::decode(response(json!({
            "privateWorkspace": "must-not-project",
            "skills": [
                {"skillKey": "research", "name": "Research", "description": "Researches", "blockedByAgentFilter": true},
                {"skillKey": "disabled", "disabled": true},
                {"skillKey": "runtime-blocked", "blockedByAllowlist": true},
                {"skillKey": "missing", "missing": {"bins": ["git"]}}
            ]
        })))
        .unwrap();
        let disabled = catalog
            .options()
            .iter()
            .find(|option| option.key() == "disabled")
            .unwrap();
        let runtime_blocked = catalog
            .options()
            .iter()
            .find(|option| option.key() == "runtime-blocked")
            .unwrap();
        let missing = catalog
            .options()
            .iter()
            .find(|option| option.key() == "missing")
            .unwrap();
        assert!(!disabled.selectable());
        assert!(!runtime_blocked.selectable());
        assert!(
            catalog
                .options()
                .iter()
                .find(|option| option.key() == "research")
                .unwrap()
                .selectable()
        );
        assert_eq!(missing.missing_requirements().unwrap().bins(), ["git"]);
        assert_eq!(
            catalog.canonicalize(vec![" Research ".into(), "missing".into()]),
            Err((vec!["missing".into()], vec![" Research ".into()]))
        );
        assert_eq!(
            catalog.canonicalize(vec!["research".into()]),
            Ok(vec!["research".into()])
        );
    }

    #[test]
    fn skill_snapshot_distinguishes_explicit_empty_allowlist_from_inheritance() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"defaults":{"skills":["research"]},"list":[{"id":"inherits"},{"id":"null","skills":null},{"id":"empty","skills":[]},{"id":"retains-disabled","skills":["disabled"]}]}},
            "hash": "base"
        })))
        .unwrap();
        let catalog = SkillCatalog {
            options: vec![
                SkillOption {
                    key: "research".into(),
                    display_name: "Research".into(),
                    description: String::new(),
                    selectable: true,
                    unavailable_reason: None,
                    missing_requirements: None,
                },
                SkillOption {
                    key: "disabled".into(),
                    display_name: "Disabled".into(),
                    description: String::new(),
                    selectable: false,
                    unavailable_reason: Some(SkillUnavailableReason::GlobalSkillDisabled),
                    missing_requirements: None,
                },
            ],
        };
        let inherits = snapshot
            .skill_view("inherits".into(), catalog.clone())
            .unwrap();
        let null = snapshot.skill_view("null".into(), catalog.clone()).unwrap();
        let empty = snapshot
            .skill_view("empty".into(), catalog.clone())
            .unwrap();
        let retains_disabled = snapshot
            .skill_view("retains-disabled".into(), catalog)
            .unwrap();
        assert!(!inherits.has_explicit_skill_allowlist());
        assert_eq!(inherits.effective_skill_keys(), ["research"]);
        assert_eq!(
            inherits
                .options()
                .iter()
                .map(|option| option.key())
                .collect::<Vec<_>>(),
            ["research"]
        );
        assert!(!null.has_explicit_skill_allowlist());
        assert_eq!(null.effective_skill_keys(), ["research"]);
        assert!(empty.has_explicit_skill_allowlist());
        assert!(empty.effective_skill_keys().is_empty());
        let mut retained_keys = retains_disabled
            .options()
            .iter()
            .map(|option| option.key())
            .collect::<Vec<_>>();
        retained_keys.sort();
        assert_eq!(retained_keys, ["disabled", "research"]);
    }

    #[test]
    fn tools_catalog_request_asks_for_plugin_metadata() {
        let request = tool_catalog_request("writer").unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();

        assert_eq!(frame["method"], "tools.catalog");
        assert_eq!(
            frame["params"],
            json!({ "agentId": "writer", "includePlugins": true })
        );
    }

    #[test]
    fn tool_catalog_accepts_historical_global_policy_groups() {
        let catalog = ToolCatalog::decode(response(json!({
            "groups": [{"id": "core", "label": "Core", "tools": [{"id": "shell"}]}]
        })))
        .unwrap();
        assert!(
            unknown_tool_keys(
                &["group:openclaw".into(), "group:plugins".into(), "*".into()],
                &[],
                catalog.policy_keys(),
            )
            .is_empty()
        );
    }

    #[test]
    fn agent_tool_policy_appends_internal_denies_without_reordering_existing_denies() {
        let selection = enforce_agent_facing_internal_tool_deny(ToolSelection::Policy {
            profile: "coding".into(),
            allow: vec!["read".into()],
            deny: vec!["terminal".into(), "gateway".into()],
        });

        let ToolSelection::Policy { deny, .. } = selection else {
            panic!("policy expected");
        };
        assert_eq!(
            deny,
            [
                "terminal",
                "gateway",
                "nodes",
                "create_goal",
                "get_goal",
                "update_goal",
            ]
        );
    }

    #[test]
    fn agent_tool_policy_keeps_internal_denies_idempotent_in_patch() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","tools":{"profile":"coding","allow":["read"],"deny":["terminal","gateway","nodes","create_goal","get_goal","update_goal"]}}]}},
            "hash": "base"
        })))
        .unwrap();
        let request = snapshot
            .patch_existing(
                "writer".into(),
                Patch::ToolConfiguration(enforce_agent_facing_internal_tool_deny(
                    ToolSelection::Policy {
                        profile: "coding".into(),
                        allow: vec!["read".into()],
                        deny: vec![
                            "terminal".into(),
                            "gateway".into(),
                            "nodes".into(),
                            "create_goal".into(),
                            "get_goal".into(),
                            "update_goal".into(),
                        ],
                    },
                )),
            )
            .unwrap();
        let frame: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        let raw: Value = serde_json::from_str(frame["params"]["raw"].as_str().unwrap()).unwrap();

        assert_eq!(raw, json!({"agents":{"list":[{"id":"writer"}]}}));
        assert!(frame["params"].get("replacePaths").is_none());
    }

    #[test]
    fn agent_tool_view_projects_internal_denies_without_mutating_catalog_validation() {
        let snapshot = Snapshot::decode(response(json!({
            "valid": true,
            "raw": null,
            "config": {"agents":{"list":[{"id":"writer","tools":{"profile":"coding","allow":["read"],"deny":["terminal"]}}]}},
            "hash": "base"
        })))
        .unwrap();
        let view = snapshot
            .tool_view("writer".into(), ToolCatalog::empty())
            .unwrap();

        assert_eq!(
            view.policy().unwrap().deny(),
            [
                "terminal",
                "gateway",
                "nodes",
                "create_goal",
                "get_goal",
                "update_goal",
            ]
        );
        assert_eq!(
            unknown_tool_keys(
                &[],
                &[
                    "gateway".into(),
                    "nodes".into(),
                    "create_goal".into(),
                    "get_goal".into(),
                    "update_goal".into(),
                    "definitely_unknown".into(),
                ],
                ToolCatalog::empty().policy_keys(),
            ),
            ["definitely_unknown"]
        );
        assert_eq!(
            unknown_tool_keys(&["gateway".into()], &[], ToolCatalog::empty().policy_keys()),
            ["gateway"]
        );
    }

    #[test]
    fn tool_catalog_preserves_openclaw_tool_metadata() {
        let catalog = ToolCatalog::decode(response(json!({
            "groups": [{
                "id": "plugin-tools",
                "label": "Plugin Tools",
                "source": "plugin",
                "pluginId": "plugin:demo",
                "tools": [{
                    "id": "demo__send",
                    "label": "Send",
                    "description": "Send messages",
                    "source": "plugin",
                    "optional": true,
                    "risk": "medium",
                    "tags": ["chat", "chat", "write"],
                    "defaultProfiles": ["coding", "messaging"]
                }]
            }]
        })))
        .unwrap();
        let option = catalog
            .options()
            .iter()
            .find(|option| option.key() == "demo__send")
            .unwrap();

        assert_eq!(option.optional(), Some(true));
        assert_eq!(option.risk(), Some("medium"));
        assert_eq!(
            option.tags(),
            ["chat".to_owned(), "write".to_owned()].as_slice()
        );
        assert_eq!(
            option.default_profiles(),
            ["coding".to_owned(), "messaging".to_owned()].as_slice()
        );
    }

    #[test]
    fn config_patch_decode_requires_patch_success() {
        assert!(decode_config_patch(response(json!({"ok": true}))));
        assert!(!decode_config_patch(response(json!({"ok": false}))));
        assert!(!decode_config_patch(response(json!([]))));
    }
}
