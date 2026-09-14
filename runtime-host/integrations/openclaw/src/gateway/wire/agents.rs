use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    GatewayResponse, RpcRequest, WireError, rpc_request, success_payload, valid_optional_string,
    valid_string, valid_strings,
};

pub(crate) const AGENTS_LIST_METHOD: &str = "agents.list";
pub(crate) const AGENTS_CREATE_METHOD: &str = "agents.create";
pub(crate) const AGENTS_UPDATE_METHOD: &str = "agents.update";
pub(crate) const AGENTS_DELETE_METHOD: &str = "agents.delete";
pub(crate) const AGENTS_FILES_LIST_METHOD: &str = "agents.files.list";
pub(crate) const AGENTS_FILES_GET_METHOD: &str = "agents.files.get";
pub(crate) const AGENTS_FILES_SET_METHOD: &str = "agents.files.set";
pub(crate) const AGENTS_WAIT_METHOD: &str = "agent.wait";

pub(crate) const AGENTS_WAIT_METHODS: &[&str] = &[AGENTS_WAIT_METHOD];

pub(crate) fn list_request(request_id: String) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_LIST_METHOD,
        AgentsListParams {},
        WireError::InvalidAgentsListRequest,
    )
}

pub(crate) fn create_request(
    request_id: String,
    input: AgentCreate,
) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_CREATE_METHOD,
        AgentCreateWire::from(input),
        WireError::InvalidAgentsCreateRequest,
    )
}

pub(crate) fn update_request(
    request_id: String,
    input: AgentUpdate,
) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_UPDATE_METHOD,
        AgentUpdateWire::from(input),
        WireError::InvalidAgentsUpdateRequest,
    )
}

pub(crate) fn delete_request(
    request_id: String,
    input: AgentDelete,
) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_DELETE_METHOD,
        AgentDeleteWire::from(input),
        WireError::InvalidAgentsDeleteRequest,
    )
}

pub(crate) fn files_list_request(
    request_id: String,
    agent_id: String,
) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_FILES_LIST_METHOD,
        AgentFilesListParams { agent_id },
        WireError::InvalidAgentsFilesListRequest,
    )
}

pub(crate) fn files_get_request(
    request_id: String,
    agent_id: String,
    name: AgentFileName,
) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_FILES_GET_METHOD,
        AgentFileGetParams {
            agent_id,
            name: name.as_str(),
        },
        WireError::InvalidAgentsFilesGetRequest,
    )
}

pub(crate) fn files_set_request(
    request_id: String,
    agent_id: String,
    name: AgentFileName,
    content: String,
) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_FILES_SET_METHOD,
        AgentFileSetParams {
            agent_id,
            name: name.as_str(),
            content,
        },
        WireError::InvalidAgentsFilesSetRequest,
    )
}

pub(crate) fn wait_request(request_id: String, input: AgentWait) -> Result<RpcRequest, WireError> {
    request(
        request_id,
        AGENTS_WAIT_METHOD,
        AgentWaitParams {
            run_id: input.run_id,
            timeout_ms: input.wait_slice_ms,
        },
        WireError::InvalidAgentsWaitRequest,
    )
}

pub(crate) fn decode_list(response: GatewayResponse) -> Result<AgentsList, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsList)?;
    let result: AgentsListWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsList)?;
    result.into_public()
}

pub(crate) fn decode_create(response: GatewayResponse) -> Result<AgentCreated, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsCreate)?;
    let result: AgentCreatedWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsCreate)?;
    result.into_public()
}

pub(crate) fn decode_update(response: GatewayResponse) -> Result<AgentUpdated, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsUpdate)?;
    let result: AgentUpdatedWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsUpdate)?;
    result.into_public()
}

pub(crate) fn decode_delete(response: GatewayResponse) -> Result<AgentDeleted, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsDelete)?;
    let result: AgentDeletedWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsDelete)?;
    result.into_public()
}

pub(crate) fn decode_files_list(
    response: GatewayResponse,
    expected_agent_id: &str,
) -> Result<AgentFiles, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsFilesList)?;
    let result: AgentFilesWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsFilesList)?;
    result.into_public(expected_agent_id)
}

pub(crate) fn decode_files_get(
    response: GatewayResponse,
    expected_agent_id: &str,
    expected_name: AgentFileName,
) -> Result<AgentFile, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsFilesGet)?;
    let result: AgentFileResultWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsFilesGet)?;
    result.into_public(expected_agent_id, expected_name)
}

pub(crate) fn decode_files_set(
    response: GatewayResponse,
    expected_agent_id: &str,
    expected_name: AgentFileName,
) -> Result<AgentFile, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsFilesSet)?;
    let result: AgentFileSetResultWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsFilesSet)?;
    result.into_public(expected_agent_id, expected_name)
}

pub(crate) fn decode_wait(
    response: GatewayResponse,
    expected_run_id: &str,
) -> Result<AgentWaitResult, WireError> {
    let value = success_payload(response, WireError::InvalidAgentsWait)?;
    let result: AgentWaitWire =
        serde_json::from_value(value).map_err(|_| WireError::InvalidAgentsWait)?;
    result.into_public(expected_run_id)
}

fn request<T: Serialize>(
    request_id: String,
    method: &'static str,
    params: T,
    error: WireError,
) -> Result<RpcRequest, WireError> {
    if !valid_string(&request_id) {
        return Err(error);
    }
    let params = serde_json::to_value(params).map_err(|_| error)?;
    rpc_request(request_id, method, Some(params)).map_err(|_| error)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCreate {
    pub name: String,
    pub workspace: String,
    pub model: Option<String>,
    pub emoji: Option<String>,
    pub avatar: Option<String>,
}

impl AgentCreate {
    pub fn try_new(
        name: String,
        workspace: String,
        model: Option<String>,
    ) -> Result<Self, WireError> {
        Self::try_new_with_display(name, workspace, model, None, None)
    }

    pub fn try_new_with_display(
        name: String,
        workspace: String,
        model: Option<String>,
        emoji: Option<String>,
        avatar: Option<String>,
    ) -> Result<Self, WireError> {
        if !valid_string(&name)
            || !valid_string(&workspace)
            || !valid_optional_string(&model)
            || !valid_optional_string(&emoji)
            || !valid_optional_string(&avatar)
        {
            return Err(WireError::InvalidAgentsCreateRequest);
        }
        Ok(Self {
            name,
            workspace,
            model,
            emoji,
            avatar,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentUpdate {
    pub agent_id: String,
    pub name: Option<String>,
    pub workspace: Option<String>,
    pub model: AgentModelUpdate,
    pub emoji: Option<String>,
    pub avatar: Option<String>,
}

impl AgentUpdate {
    pub fn try_new(
        agent_id: String,
        name: Option<String>,
        workspace: Option<String>,
        model: Option<String>,
    ) -> Result<Self, WireError> {
        Self::try_new_with_display(
            agent_id,
            name,
            workspace,
            model.map_or(AgentModelUpdate::Unchanged, |model| {
                AgentModelUpdate::Set(Some(model))
            }),
            None,
            None,
        )
    }

    pub fn try_new_clearing_model(
        agent_id: String,
        name: Option<String>,
        workspace: Option<String>,
    ) -> Result<Self, WireError> {
        Self::try_new_clearing_model_with_display(agent_id, name, workspace, None, None)
    }

    pub fn try_new_clearing_model_with_display(
        agent_id: String,
        name: Option<String>,
        workspace: Option<String>,
        emoji: Option<String>,
        avatar: Option<String>,
    ) -> Result<Self, WireError> {
        Self::try_new_with_display(
            agent_id,
            name,
            workspace,
            AgentModelUpdate::Set(None),
            emoji,
            avatar,
        )
    }

    pub fn try_new_with_display(
        agent_id: String,
        name: Option<String>,
        workspace: Option<String>,
        model: AgentModelUpdate,
        emoji: Option<String>,
        avatar: Option<String>,
    ) -> Result<Self, WireError> {
        if !valid_string(&agent_id)
            || !valid_optional_string(&name)
            || !valid_optional_string(&workspace)
            || !model.is_valid()
            || !valid_optional_string(&emoji)
            || !valid_optional_string(&avatar)
            || (name.is_none()
                && workspace.is_none()
                && model == AgentModelUpdate::Unchanged
                && emoji.is_none()
                && avatar.is_none())
        {
            return Err(WireError::InvalidAgentsUpdateRequest);
        }
        Ok(Self {
            agent_id,
            name,
            workspace,
            model,
            emoji,
            avatar,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentModelUpdate {
    Unchanged,
    Set(Option<String>),
}

impl AgentModelUpdate {
    fn is_valid(&self) -> bool {
        match self {
            Self::Unchanged => true,
            Self::Set(model) => valid_optional_string(model),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDelete {
    pub agent_id: String,
    pub delete_files: bool,
}

impl AgentDelete {
    pub fn try_new(agent_id: String, delete_files: bool) -> Result<Self, WireError> {
        if !valid_string(&agent_id) {
            return Err(WireError::InvalidAgentsDeleteRequest);
        }
        Ok(Self {
            agent_id,
            delete_files,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentFileName {
    Agents,
    Soul,
    User,
    Memory,
}

impl AgentFileName {
    pub fn parse(value: &str) -> Result<Self, WireError> {
        match value {
            "AGENTS.md" => Ok(Self::Agents),
            "SOUL.md" => Ok(Self::Soul),
            "USER.md" => Ok(Self::User),
            "MEMORY.md" => Ok(Self::Memory),
            _ => Err(WireError::InvalidAgentsFileName),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS.md",
            Self::Soul => "SOUL.md",
            Self::User => "USER.md",
            Self::Memory => "MEMORY.md",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentWait {
    run_id: String,
    wait_slice_ms: u64,
    rpc_timeout_buffer_ms: u64,
}

impl AgentWait {
    pub fn try_new(
        run_id: String,
        wait_slice_ms: u64,
        rpc_timeout_buffer_ms: u64,
    ) -> Result<Self, WireError> {
        if !valid_wait_identifier(&run_id)
            || !(1_000..=60_000).contains(&wait_slice_ms)
            || rpc_timeout_buffer_ms > 10_000
        {
            return Err(WireError::InvalidAgentsWaitRequest);
        }
        Ok(Self {
            run_id,
            wait_slice_ms,
            rpc_timeout_buffer_ms,
        })
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn rpc_deadline_ms(&self) -> u64 {
        self.wait_slice_ms + self.rpc_timeout_buffer_ms
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentWaitStatus {
    Completed,
    Failed,
    Timeout,
    Pending,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentWaitResult {
    pub status: AgentWaitStatus,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentKind {
    System,
    Agent,
}

impl AgentKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Agent => "agent",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSummary {
    pub id: String,
    pub name: Option<String>,
    pub workspace: Option<String>,
    pub model: Option<String>,
    pub kind: AgentKind,
    pub default_permission_mode: Option<String>,
    pub sealed: bool,
}

impl AgentSummary {
    pub const fn kind(&self) -> AgentKind {
        self.kind
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentsList {
    pub default_id: String,
    pub selection_required: bool,
    pub agents: Vec<AgentSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentCreated {
    pub agent_id: String,
    pub name: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentUpdated {
    pub agent_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentDeleted {
    pub agent_id: String,
    pub removed_bindings: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentFile {
    pub name: AgentFileName,
    pub missing: bool,
    pub size: Option<u64>,
    pub updated_at_ms: Option<u64>,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentFiles {
    pub agent_id: String,
    pub files: Vec<AgentFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWaitParams {
    run_id: String,
    timeout_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentsListParams {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentFilesListParams {
    agent_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentFileGetParams {
    agent_id: String,
    name: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentFileSetParams {
    agent_id: String,
    name: &'static str,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCreateWire {
    name: String,
    workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
}

impl From<AgentCreate> for AgentCreateWire {
    fn from(value: AgentCreate) -> Self {
        Self {
            name: value.name,
            workspace: value.workspace,
            model: value.model,
            emoji: value.emoji,
            avatar: value.avatar,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUpdateWire {
    agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<String>,
    #[serde(
        serialize_with = "serialize_agent_model_update",
        skip_serializing_if = "AgentModelUpdate::is_unchanged"
    )]
    model: AgentModelUpdate,
    #[serde(skip_serializing_if = "Option::is_none")]
    emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
}

impl From<AgentUpdate> for AgentUpdateWire {
    fn from(value: AgentUpdate) -> Self {
        Self {
            agent_id: value.agent_id,
            name: value.name,
            workspace: value.workspace,
            model: value.model,
            emoji: value.emoji,
            avatar: value.avatar,
        }
    }
}

impl AgentModelUpdate {
    fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

fn serialize_agent_model_update<S>(
    value: &AgentModelUpdate,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        AgentModelUpdate::Unchanged => serializer.serialize_none(),
        AgentModelUpdate::Set(model) => model.serialize(serializer),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDeleteWire {
    agent_id: String,
    delete_files: bool,
}

impl From<AgentDelete> for AgentDeleteWire {
    fn from(value: AgentDelete) -> Self {
        Self {
            agent_id: value.agent_id,
            delete_files: value.delete_files,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentWaitWire {
    run_id: String,
    status: String,
    started_at: Option<WaitTimestampWire>,
    ended_at: Option<WaitTimestampWire>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WaitTimestampWire {
    Value(u64),
    Null(()),
}

impl WaitTimestampWire {
    const fn into_option(self) -> Option<u64> {
        match self {
            Self::Value(value) => Some(value),
            Self::Null(()) => None,
        }
    }
}

fn valid_wait_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}

impl AgentWaitWire {
    fn into_public(self, expected_run_id: &str) -> Result<AgentWaitResult, WireError> {
        let started_at = self.started_at.and_then(WaitTimestampWire::into_option);
        let ended_at = self.ended_at.and_then(WaitTimestampWire::into_option);
        if self.run_id != expected_run_id
            || !valid_wait_identifier(&self.run_id)
            || ended_at
                .zip(started_at)
                .is_some_and(|(ended, started)| ended < started)
        {
            return Err(WireError::InvalidAgentsWait);
        }
        let status = match self.status.as_str() {
            "ok" | "completed" => AgentWaitStatus::Completed,
            "error" | "failed" => AgentWaitStatus::Failed,
            "timeout" => AgentWaitStatus::Timeout,
            "pending" => AgentWaitStatus::Pending,
            _ => return Err(WireError::InvalidAgentsWait),
        };
        Ok(AgentWaitResult {
            status,
            started_at,
            ended_at,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsListWire {
    default_id: String,
    main_key: String,
    scope: String,
    ownership: Option<Value>,
    #[serde(default)]
    selection_required: bool,
    agents: Vec<AgentSummaryWire>,
    workspace_git: Option<Value>,
    agent_runtime: Option<AgentRuntimeWire>,
    thinking_levels: Option<Value>,
    thinking_options: Option<Vec<String>>,
    thinking_default: Option<String>,
    default_permission_mode: Option<String>,
}

impl AgentsListWire {
    fn into_public(self) -> Result<AgentsList, WireError> {
        if !valid_string(&self.default_id)
            || !valid_string(&self.main_key)
            || !matches!(self.scope.as_str(), "per-sender" | "global")
            || self
                .ownership
                .as_ref()
                .is_some_and(|ownership| !valid_ownership(ownership))
            || self
                .workspace_git
                .as_ref()
                .is_some_and(|workspace_git| !valid_workspace_git(workspace_git))
            || self
                .agent_runtime
                .as_ref()
                .is_some_and(|runtime| !runtime.is_valid())
            || self
                .thinking_levels
                .as_ref()
                .is_some_and(|levels| !valid_thinking_levels(levels))
            || self
                .thinking_options
                .as_deref()
                .is_some_and(|options| !valid_strings(options))
            || !valid_optional_string(&self.thinking_default)
            || !valid_permission_mode(&self.default_permission_mode)
        {
            return Err(WireError::InvalidAgentsList);
        }
        Ok(AgentsList {
            default_id: self.default_id,
            selection_required: self.selection_required,
            agents: self
                .agents
                .into_iter()
                .map(AgentSummaryWire::into_public)
                .collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSummaryWire {
    id: String,
    name: Option<String>,
    identity: Option<IdentityWire>,
    workspace: Option<String>,
    model: Option<ModelWire>,
    kind: Option<String>,
    created_via: Option<String>,
    creator_agent_id: Option<String>,
    created_at: Option<u64>,
    workspace_git: Option<Value>,
    agent_runtime: Option<AgentRuntimeWire>,
    thinking_levels: Option<Value>,
    thinking_options: Option<Vec<String>>,
    thinking_default: Option<String>,
    default_permission_mode: Option<String>,
}

impl AgentSummaryWire {
    fn into_public(self) -> Result<AgentSummary, WireError> {
        let kind = match self.kind.as_deref() {
            Some(kind) => AgentKind::parse(kind).ok_or(WireError::InvalidAgentsList)?,
            None => AgentKind::Agent,
        };
        if !valid_string(&self.id)
            || !valid_optional_string(&self.name)
            || self
                .identity
                .as_ref()
                .is_some_and(|identity| !identity.is_valid())
            || !valid_optional_string(&self.workspace)
            || !valid_optional_string(&self.created_via)
            || !valid_optional_string(&self.creator_agent_id)
            || self
                .workspace_git
                .as_ref()
                .is_some_and(|workspace_git| !valid_workspace_git(workspace_git))
            || self
                .agent_runtime
                .as_ref()
                .is_some_and(|runtime| !runtime.is_valid())
            || self
                .thinking_levels
                .as_ref()
                .is_some_and(|levels| !valid_thinking_levels(levels))
            || self
                .thinking_options
                .as_deref()
                .is_some_and(|options| !valid_strings(options))
            || !valid_optional_string(&self.thinking_default)
            || !valid_permission_mode(&self.default_permission_mode)
        {
            return Err(WireError::InvalidAgentsList);
        }
        let model = self
            .model
            .map(ModelWire::primary)
            .transpose()
            .map_err(|_| WireError::InvalidAgentsList)?
            .flatten();
        Ok(AgentSummary {
            id: self.id,
            name: self.name,
            workspace: self.workspace,
            model,
            kind,
            default_permission_mode: self.default_permission_mode,
            sealed: false,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityWire {
    name: Option<String>,
    theme: Option<String>,
    emoji: Option<String>,
    avatar: Option<String>,
    avatar_url: Option<String>,
}

impl IdentityWire {
    fn is_valid(&self) -> bool {
        valid_optional_string(&self.name)
            && valid_optional_string(&self.theme)
            && valid_optional_string(&self.emoji)
            && valid_optional_string(&self.avatar)
            && valid_optional_string(&self.avatar_url)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelWire {
    primary: Option<String>,
    fallbacks: Option<Vec<String>>,
}

impl ModelWire {
    fn primary(self) -> Result<Option<String>, WireError> {
        if !valid_optional_string(&self.primary)
            || self
                .fallbacks
                .as_deref()
                .is_some_and(|fallbacks| fallbacks.iter().any(|fallback| !valid_string(fallback)))
        {
            return Err(WireError::InvalidAgentsList);
        }
        Ok(self.primary)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeWire {
    id: Option<String>,
    fallback: Option<String>,
    source: Option<String>,
}

impl AgentRuntimeWire {
    fn is_valid(&self) -> bool {
        valid_optional_string(&self.id)
            && self
                .fallback
                .as_deref()
                .is_none_or(|fallback| matches!(fallback, "openclaw" | "none"))
            && self.source.as_deref().is_none_or(|source| {
                matches!(
                    source,
                    "env"
                        | "agent"
                        | "defaults"
                        | "model"
                        | "provider"
                        | "implicit"
                        | "session"
                        | "session-key"
                )
            })
    }
}

fn valid_ownership(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|ownership| matches!(ownership, "sole" | "legacy" | "explicit"))
}

fn valid_thinking_levels(value: &Value) -> bool {
    value.as_array().is_some_and(|levels| {
        levels.iter().all(|level| {
            let Some(level) = level.as_object() else {
                return false;
            };
            level
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(valid_string)
                && level
                    .get("label")
                    .and_then(Value::as_str)
                    .is_some_and(valid_string)
                && level.iter().all(|(key, value)| match key.as_str() {
                    "id" | "label" => value.as_str().is_some_and(valid_string),
                    _ => true,
                })
        })
    })
}

fn valid_workspace_git(value: &Value) -> bool {
    if value.is_boolean() {
        return true;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "root" | "branch" | "head" | "remote" | "url" => value.as_str().is_some_and(valid_string),
        "dirty" | "isDirty" => value.is_boolean(),
        _ => true,
    })
}

fn valid_permission_mode(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_none_or(|mode| matches!(mode, "read-only" | "guarded" | "workspace" | "full"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCreatedWire {
    ok: bool,
    agent_id: String,
    name: String,
    workspace: String,
    model: Option<String>,
}

impl AgentCreatedWire {
    fn into_public(self) -> Result<AgentCreated, WireError> {
        if !self.ok
            || !valid_string(&self.agent_id)
            || !valid_string(&self.name)
            || !valid_string(&self.workspace)
            || !valid_optional_string(&self.model)
        {
            return Err(WireError::InvalidAgentsCreate);
        }
        Ok(AgentCreated {
            agent_id: self.agent_id,
            name: self.name,
            model: self.model,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentUpdatedWire {
    ok: bool,
    agent_id: String,
}

impl AgentUpdatedWire {
    fn into_public(self) -> Result<AgentUpdated, WireError> {
        if !self.ok || !valid_string(&self.agent_id) {
            return Err(WireError::InvalidAgentsUpdate);
        }
        Ok(AgentUpdated {
            agent_id: self.agent_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentDeletedWire {
    ok: bool,
    agent_id: String,
    removed_bindings: u64,
}

impl AgentDeletedWire {
    fn into_public(self) -> Result<AgentDeleted, WireError> {
        if !self.ok || !valid_string(&self.agent_id) {
            return Err(WireError::InvalidAgentsDelete);
        }
        Ok(AgentDeleted {
            agent_id: self.agent_id,
            removed_bindings: self.removed_bindings,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFilesWire {
    agent_id: String,
    workspace: String,
    files: Vec<AgentFileWire>,
}

impl AgentFilesWire {
    fn into_public(self, expected_agent_id: &str) -> Result<AgentFiles, WireError> {
        if self.agent_id != expected_agent_id || !valid_string(&self.workspace) {
            return Err(WireError::InvalidAgentsFilesList);
        }
        let files = self
            .files
            .into_iter()
            .map(AgentFileWire::into_public)
            .collect::<Result<Vec<_>, _>>()?;
        if files.iter().enumerate().any(|(index, file)| {
            files[..index]
                .iter()
                .any(|previous| previous.name == file.name)
        }) {
            return Err(WireError::InvalidAgentsFilesList);
        }
        Ok(AgentFiles {
            agent_id: self.agent_id,
            files,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFileResultWire {
    agent_id: String,
    workspace: String,
    file: AgentFileWire,
}

impl AgentFileResultWire {
    fn into_public(
        self,
        expected_agent_id: &str,
        expected_name: AgentFileName,
    ) -> Result<AgentFile, WireError> {
        if self.agent_id != expected_agent_id || !valid_string(&self.workspace) {
            return Err(WireError::InvalidAgentsFilesGet);
        }
        self.file
            .into_public_for(expected_name, WireError::InvalidAgentsFilesGet)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFileSetResultWire {
    ok: bool,
    agent_id: String,
    workspace: String,
    file: AgentFileWire,
}

impl AgentFileSetResultWire {
    fn into_public(
        self,
        expected_agent_id: &str,
        expected_name: AgentFileName,
    ) -> Result<AgentFile, WireError> {
        if !self.ok || self.agent_id != expected_agent_id || !valid_string(&self.workspace) {
            return Err(WireError::InvalidAgentsFilesSet);
        }
        self.file
            .into_public_for(expected_name, WireError::InvalidAgentsFilesSet)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFileWire {
    name: String,
    path: String,
    missing: bool,
    expected_absent: Option<bool>,
    size: Option<u64>,
    updated_at_ms: Option<u64>,
    content: Option<String>,
}

impl AgentFileWire {
    fn into_public(self) -> Result<AgentFile, WireError> {
        let name = AgentFileName::parse(&self.name)?;
        self.into_public_for(name, WireError::InvalidAgentsFilesList)
    }

    fn into_public_for(
        self,
        expected_name: AgentFileName,
        error: WireError,
    ) -> Result<AgentFile, WireError> {
        if self.name != expected_name.as_str()
            || !valid_string(&self.path)
            || Path::new(&self.path)
                .file_name()
                .and_then(|name| name.to_str())
                != Some(expected_name.as_str())
        {
            return Err(error);
        }
        if self.missing && self.content.is_some() {
            return Err(error);
        }
        if self.missing && (self.size.is_some() || self.updated_at_ms.is_some()) {
            return Err(error);
        }
        if self.expected_absent == Some(true) && !self.missing {
            return Err(error);
        }
        Ok(AgentFile {
            name: expected_name,
            missing: self.missing,
            size: self.size,
            updated_at_ms: self.updated_at_ms,
            content: self.content,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn response(payload: serde_json::Value) -> GatewayResponse {
        super::super::decode_response(
            &json!({ "type": "res", "id": "wait-1", "ok": true, "payload": payload }).to_string(),
            "wait-1",
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn wait_request_is_bounded_and_encodes_only_native_wait_fields() {
        for (run_id, wait_slice_ms, rpc_timeout_buffer_ms) in [
            ("", 1_000, 0),
            ("run", 999, 0),
            ("run", 60_001, 0),
            ("run", 1_000, 10_001),
            ("run\0id", 1_000, 0),
        ] {
            assert!(
                AgentWait::try_new(run_id.into(), wait_slice_ms, rpc_timeout_buffer_ms).is_err()
            );
        }
        assert!(AgentWait::try_new("x".repeat(4097), 1_000, 0).is_err());

        let input = AgentWait::try_new("run-1".into(), 30_000, 10_000).unwrap();
        assert_eq!(input.rpc_deadline_ms(), 40_000);
        let request = wait_request("wait-1".into(), input).unwrap();
        assert_eq!(request.method(), AGENTS_WAIT_METHOD);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&request.encode().unwrap()).unwrap(),
            json!({
                "type": "req",
                "id": "wait-1",
                "method": "agent.wait",
                "params": { "runId": "run-1", "timeoutMs": 30_000 },
            }),
        );
    }

    #[test]
    fn wait_decode_projects_only_safe_receipt_fields() {
        for (native_status, status) in [
            ("ok", AgentWaitStatus::Completed),
            ("completed", AgentWaitStatus::Completed),
            ("error", AgentWaitStatus::Failed),
            ("failed", AgentWaitStatus::Failed),
            ("timeout", AgentWaitStatus::Timeout),
            ("pending", AgentWaitStatus::Pending),
        ] {
            let result = decode_wait(
                response(json!({
                    "runId": "run-1",
                    "status": native_status,
                    "startedAt": 1,
                    "endedAt": 2,
                })),
                "run-1",
            )
            .unwrap();
            assert_eq!(result.status, status);
            assert_eq!(result.started_at, Some(1));
            assert_eq!(result.ended_at, Some(2));
        }
    }

    #[test]
    fn wait_decode_rejects_mismatched_or_malformed_receipts() {
        assert_eq!(
            decode_wait(
                response(json!({
                    "runId": "run-1",
                    "status": "pending",
                    "startedAt": 1,
                    "endedAt": null,
                })),
                "run-1",
            )
            .unwrap(),
            AgentWaitResult {
                status: AgentWaitStatus::Pending,
                started_at: Some(1),
                ended_at: None,
            },
        );
        assert_eq!(
            decode_wait(
                response(json!({
                    "runId": "run-1",
                    "status": "timeout",
                })),
                "run-1",
            )
            .unwrap(),
            AgentWaitResult {
                status: AgentWaitStatus::Timeout,
                started_at: None,
                ended_at: None,
            },
        );
        assert_eq!(
            decode_wait(
                response(json!({
                    "runId": "run-1",
                    "status": "completed",
                    "endedAt": 2,
                })),
                "run-1",
            )
            .unwrap(),
            AgentWaitResult {
                status: AgentWaitStatus::Completed,
                started_at: None,
                ended_at: Some(2),
            },
        );

        for payload in [
            json!({ "runId": "other", "status": "completed", "startedAt": 1, "endedAt": 2 }),
            json!({ "runId": "run-1", "status": "unknown", "startedAt": 1, "endedAt": 2 }),
            json!({ "runId": "run-1", "status": "completed", "startedAt": 2, "endedAt": 1 }),
            json!({ "runId": "run-1", "status": "completed", "startedAt": 2, "endedAt": 1 }),
        ] {
            assert_eq!(
                decode_wait(response(payload), "run-1"),
                Err(WireError::InvalidAgentsWait),
            );
        }
    }

    #[test]
    fn wait_decode_accepts_additive_native_detail_without_projecting_it() {
        let result = decode_wait(
            response(json!({
                "runId": "run-1",
                "status": "timeout",
                "error": "private native detail",
                "futureNativeField": { "private": true },
            })),
            "run-1",
        )
        .unwrap();
        assert_eq!(
            result,
            AgentWaitResult {
                status: AgentWaitStatus::Timeout,
                started_at: None,
                ended_at: None,
            },
        );
    }

    #[test]
    fn list_decode_accepts_openclaw_8_2_fields_and_projects_safe_summary() {
        let result = decode_list(response(json!({
            "defaultId": "main",
            "mainKey": "main",
            "scope": "global",
            "ownership": "explicit",
            "selectionRequired": true,
            "workspaceGit": { "root": "/work", "branch": "main", "head": "abc", "dirty": false },
            "agentRuntime": { "id": "runtime-1", "fallback": "openclaw", "source": "defaults" },
            "thinkingLevels": [{ "id": "low", "label": "Low" }, { "id": "high", "label": "High" }],
            "thinkingOptions": ["low", "high"],
            "thinkingDefault": "low",
            "defaultPermissionMode": "workspace",
            "agents": [
                {
                    "id": "main",
                    "name": "Main",
                    "identity": {
                        "name": "Main",
                        "theme": "green",
                        "emoji": "🍵",
                        "avatar": "matcha",
                        "avatarUrl": "file:///avatar.png",
                        "nativeDetail": { "private": true }
                    },
                    "workspace": "/work/main",
                    "model": { "primary": "provider/model", "fallbacks": ["provider/fallback"] },
                    "kind": "system",
                    "createdVia": "claw",
                    "createdAt": 1,
                    "workspaceGit": { "root": "/work/main" },
                    "agentRuntime": { "id": "runtime-1", "fallback": "none", "source": "session-key" },
                    "thinkingLevels": [{ "id": "low", "label": "Low" }],
                    "thinkingOptions": ["low"],
                    "thinkingDefault": "low",
                    "defaultPermissionMode": "guarded",
                    "nativeDetail": { "private": true }
                },
                {
                    "id": "writer",
                    "name": "Writer",
                    "workspace": "/work/writer",
                    "model": null,
                    "kind": "agent",
                    "createdVia": "operator",
                    "creatorAgentId": "main",
                    "createdAt": 2
                }
            ],
            "futureNativeField": { "private": true }
        })))
        .unwrap();

        assert_eq!(result.default_id, "main");
        assert!(result.selection_required);
        assert_eq!(result.agents.len(), 2);
        assert_eq!(result.agents[0].id, "main");
        assert_eq!(result.agents[0].kind, AgentKind::System);
        assert_eq!(result.agents[0].model.as_deref(), Some("provider/model"));
        assert_eq!(
            result.agents[0].default_permission_mode.as_deref(),
            Some("guarded")
        );
        assert_eq!(result.agents[1].id, "writer");
        assert_eq!(result.agents[1].kind, AgentKind::Agent);
        assert_eq!(result.agents[1].model, None);
        assert_eq!(result.agents[1].default_permission_mode, None);
    }

    #[test]
    fn list_decode_rejects_illegal_core_8_2_fields() {
        for payload in [
            json!({
                "defaultId": "main",
                "mainKey": "main",
                "scope": "global",
                "selectionRequired": false,
                "agents": [{ "id": "writer", "kind": "tool" }]
            }),
            json!({
                "defaultId": "main",
                "mainKey": "main",
                "scope": "global",
                "selectionRequired": false,
                "agentRuntime": { "id": "runtime-1", "fallback": "maybe", "source": "defaults" },
                "agents": []
            }),
            json!({
                "defaultId": "main",
                "mainKey": "main",
                "scope": "global",
                "selectionRequired": false,
                "defaultPermissionMode": "root",
                "agents": []
            }),
            json!({
                "defaultId": "main",
                "mainKey": "main",
                "scope": "global",
                "selectionRequired": false,
                "ownership": [{ "agentId": "" }],
                "agents": []
            }),
            json!({
                "defaultId": "main",
                "mainKey": "main",
                "scope": "global",
                "selectionRequired": false,
                "workspaceGit": { "dirty": "no" },
                "agents": []
            }),
        ] {
            assert_eq!(
                decode_list(response(payload)),
                Err(WireError::InvalidAgentsList),
            );
        }
    }

    #[test]
    fn create_and_update_encode_openclaw_8_2_display_and_model_clear() {
        let create = AgentCreate::try_new_with_display(
            "writer".into(),
            "/work/writer".into(),
            Some("provider/model".into()),
            Some("🍵".into()),
            Some("matcha".into()),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &create_request("wait-1".into(), create)
                    .unwrap()
                    .encode()
                    .unwrap()
            )
            .unwrap(),
            json!({
                "type": "req",
                "id": "wait-1",
                "method": "agents.create",
                "params": {
                    "name": "writer",
                    "workspace": "/work/writer",
                    "model": "provider/model",
                    "emoji": "🍵",
                    "avatar": "matcha"
                },
            }),
        );

        let update = AgentUpdate::try_new_clearing_model_with_display(
            "writer".into(),
            None,
            None,
            Some("✍️".into()),
            Some("pen".into()),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &update_request("wait-1".into(), update)
                    .unwrap()
                    .encode()
                    .unwrap()
            )
            .unwrap(),
            json!({
                "type": "req",
                "id": "wait-1",
                "method": "agents.update",
                "params": {
                    "agentId": "writer",
                    "model": null,
                    "emoji": "✍️",
                    "avatar": "pen"
                },
            }),
        );
    }

    #[test]
    fn delete_and_files_decode_openclaw_8_2_additive_fields() {
        let deleted = decode_delete(response(json!({
            "ok": true,
            "agentId": "writer",
            "removedBindings": 2,
            "removed": ["writer"],
            "failed": [],
            "purgeFailed": [],
            "futureNativeField": { "private": true }
        })))
        .unwrap();
        assert_eq!(deleted.agent_id, "writer");
        assert_eq!(deleted.removed_bindings, 2);

        let file = decode_files_get(
            response(json!({
                "agentId": "writer",
                "workspace": "/work/writer",
                "file": {
                    "name": "AGENTS.md",
                    "path": "/work/writer/AGENTS.md",
                    "missing": true,
                    "expectedAbsent": true,
                    "futureNativeField": { "private": true }
                },
                "futureNativeField": { "private": true }
            })),
            "writer",
            AgentFileName::Agents,
        )
        .unwrap();
        assert_eq!(file.name, AgentFileName::Agents);
        assert!(file.missing);
        assert_eq!(file.content, None);
    }
}
