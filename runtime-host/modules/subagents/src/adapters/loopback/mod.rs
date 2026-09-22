use std::{sync::Arc, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    SubagentsModule,
    api::SubagentHandle,
    domain::model::{self as agents, NativeEndpoint, WorkspaceInitialization},
    ports::SealedAgentError,
};

pub(crate) mod handler;

const SUBAGENT_MANAGEMENT_CAPABILITY_ID: &str = "subagent.management";
const SUBAGENT_SKILLS_CAPABILITY_ID: &str = "subagent.skills";
const SUBAGENT_TOOLS_CAPABILITY_ID: &str = "subagent.tools";
const RUNTIME_KIND: &str = "native-runtime";
const SCOPE_KIND: &str = "agent";
const AGENT_TARGET_KIND: &str = "agent";
const SUBAGENT_TARGET_KIND: &str = "subagent";
const AUTHORIZATION_ENDPOINT: &str = "/api/subagents/agents";
const AUTHORIZATION_SCOPE: &str = "subagents:manage";
const AUTHORIZATION_SUBJECT: &str = "subagents";
const SEALED_AGENT_READ_ENDPOINT_PREFIX: &str = "/api/sealed-agents/read/";
const SEALED_RUNTIME_AUTHORIZATION_HEADER: &str = "x-matcha-sealed-token";
const SEALED_RUNTIME_HEADER: &str = "x-matcha-sealed-runtime";
const OPENCLAW_RUNTIME: &str = "openclaw";
const MAX_AGENT_KEY_BYTES: usize = 4 * 1024;
const MAX_PACKAGE_RELATIVE_PATH_BYTES: usize = 240;
const MAX_TEXT_LENGTH: usize = 1024 * 1024;
const SUBAGENTS_REQUEST_BYTES: usize = 1024 * 1024 + 64 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    subagents: SubagentHandle,
    sealed_agents: SubagentsModule,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        subagents: SubagentHandle,
        sealed_agents: SubagentsModule,
    ) -> Self {
        Self {
            verifier,
            subagents,
            sealed_agents,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("subagents"),
        vec![RouteDescriptor::bound(
            "subagents.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    (path == AUTHORIZATION_ENDPOINT || path.starts_with(SEALED_AGENT_READ_ENDPOINT_PREFIX)).then(
        || {
            RouteHeadPlan::new(
                body_policy_for_method(head.method.as_str(), SUBAGENTS_REQUEST_BYTES),
                SHORT_DEADLINE,
                timeout_response,
            )
        },
    )
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let path = pathname(request.path());
        if path.starts_with(SEALED_AGENT_READ_ENDPOINT_PREFIX) {
            sealed_agent_read(request, dependencies.sealed_agents)
                .await
                .into()
        } else {
            handler::handle(request, dependencies).await.into()
        }
    })
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required { max_bytes }
    } else {
        BodyPolicy::Optional {
            max_bytes: 64 * 1024,
        }
    }
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

async fn sealed_agent_read(request: Request, subagents: SubagentsModule) -> Response {
    match sealed_agent_read_body(
        request.path(),
        request.method(),
        request.headers(),
        &request.body,
        subagents,
    ) {
        Ok((status, body)) => Response::json(status, body),
        Err(SealedAgentReadError::Invalid) => Response::json(400, json!({ "outcome": "rejected" })),
        Err(SealedAgentReadError::Unauthorized) => Response::json(
            401,
            json!({ "success": false, "error": "Sealed resource authorization is invalid" }),
        ),
        Err(SealedAgentReadError::Unavailable) => {
            Response::json(503, json!({ "outcome": "unknown" }))
        }
    }
}

fn sealed_agent_read_body(
    endpoint: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
    subagents: SubagentsModule,
) -> Result<(u16, Value), SealedAgentReadError> {
    if method != "GET" || !body.is_empty() {
        return Err(SealedAgentReadError::Invalid);
    }
    let runtime =
        header_value(headers, SEALED_RUNTIME_HEADER).ok_or(SealedAgentReadError::Unauthorized)?;
    if runtime != OPENCLAW_RUNTIME {
        return Err(SealedAgentReadError::Unauthorized);
    }
    let token = header_value(headers, SEALED_RUNTIME_AUTHORIZATION_HEADER)
        .ok_or(SealedAgentReadError::Unauthorized)?;
    let (agent_id, path) = decode_agent_read_path(endpoint)?;
    match subagents.read_sealed_agent_file(token, agent_id, path) {
        Ok(read) => {
            let mut value = json!({
                "contentBase64": STANDARD.encode(read.content()),
            });
            if let Some(binding) = read.metering_binding() {
                value["meteringBinding"] = json!(binding);
            }
            Ok((200, value))
        }
        Err(SealedAgentError::NotFound) => Ok((404, json!({ "outcome": "notFound" }))),
        Err(SealedAgentError::Unknown) => Err(SealedAgentReadError::Unavailable),
        Err(SealedAgentError::AlreadyExists | SealedAgentError::Rejected) => {
            Err(SealedAgentReadError::Invalid)
        }
    }
}

fn decode_agent_read_path(endpoint: &str) -> Result<(String, String), SealedAgentReadError> {
    let value = endpoint
        .strip_prefix(SEALED_AGENT_READ_ENDPOINT_PREFIX)
        .ok_or(SealedAgentReadError::Invalid)?;
    let (agent_id, path) = value.split_once('/').ok_or(SealedAgentReadError::Invalid)?;
    let agent_id = percent_decode(agent_id)?;
    if !valid_agent_key(&agent_id) {
        return Err(SealedAgentReadError::Invalid);
    }
    let path = percent_decode(path)?;
    validate_package_relative_path(&path)?;
    Ok((agent_id, path))
}

fn valid_agent_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.len() <= MAX_AGENT_KEY_BYTES && !value.contains('\0')
}

fn validate_package_relative_path(value: &str) -> Result<(), SealedAgentReadError> {
    use std::path::{Component, Path};

    if value.is_empty()
        || value.len() > MAX_PACKAGE_RELATIVE_PATH_BYTES
        || value.contains('\\')
        || value.contains('\0')
        || value.starts_with('/')
        || Path::new(value).is_absolute()
        || value.split('/').any(|component| {
            component.is_empty()
                || component == "."
                || component == ".."
                || is_windows_drive(component)
        })
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(SealedAgentReadError::Invalid);
    }
    Ok(())
}

fn is_windows_drive(component: &str) -> bool {
    let bytes = component.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header, _)| header == name)
        .map(|(_, value)| value.as_str())
}

fn percent_decode(value: &str) -> Result<String, SealedAgentReadError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(SealedAgentReadError::Invalid);
            }
            let high = hex(bytes[index + 1]).ok_or(SealedAgentReadError::Invalid)?;
            let low = hex(bytes[index + 2]).ok_or(SealedAgentReadError::Invalid)?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| SealedAgentReadError::Invalid)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SealedAgentReadError {
    Invalid,
    Unauthorized,
    Unavailable,
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}

fn valid_package_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && value.ends_with(".matcha-agentpkg")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct AgentsRequest {
    id: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    scope: Scope,
    target: Target,
    input: Value,
}

impl AgentsRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, RequestError> {
        let request = Self::decode_semantics(value)?;
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                request.capability_id(),
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| RequestError::Invalid)?;
        Ok(request)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request: Self = serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        let operation = Operation::parse(&self.operation_id).ok_or(RequestError::Invalid)?;
        let input = Input::decode(operation, self.input.clone())?;
        (self.id == operation.capability_id()
            && self.scope.kind == SCOPE_KIND
            && self.target.is_valid_for(operation, &self.scope.agent_id)
            && valid_id(&self.scope.agent_id)
            && input
                .endpoint()
                .is_none_or(|endpoint| &self.scope.endpoint == endpoint)
            && self.scope.endpoint.is_supported()
            && (!operation.requires_openclaw()
                || self.scope.endpoint.runtime_adapter_id == "openclaw")
            && input.is_valid_for(operation, &self.target))
        .then_some(())
        .ok_or(RequestError::Invalid)
    }

    fn capability_id(&self) -> &str {
        &self.id
    }

    pub(crate) fn command(self, trace_id: Option<&str>) -> Result<agents::Command, RequestError> {
        let endpoint = self.scope.endpoint.native_endpoint();
        let operation = Operation::parse(&self.operation_id).ok_or(RequestError::Invalid)?;
        let input = Input::decode(operation, self.input)?;
        match (operation, input) {
            (Operation::List, Input::List { .. }) => Ok(agents::Command::List { endpoint }),
            (
                Operation::DraftWait,
                Input::DraftWait {
                    run_id,
                    wait_slice_ms,
                    rpc_timeout_buffer_ms,
                    ..
                },
            ) => agents::AgentWait::try_new(run_id, wait_slice_ms, rpc_timeout_buffer_ms)
                .map(|input| agents::Command::Wait { endpoint, input })
                .map_err(|_| RequestError::Invalid),
            (
                Operation::Create,
                Input::Create {
                    name,
                    workspace,
                    model,
                    workspace_initialization,
                    ..
                },
            ) => agents::AgentCreate::try_new(name, workspace, model)
                .map(|input| agents::Command::Create {
                    endpoint,
                    input,
                    workspace_initialization: workspace_initialization.into(),
                })
                .map_err(|_| RequestError::Invalid),
            (
                Operation::Update,
                Input::Update {
                    agent_id,
                    name,
                    workspace,
                    model,
                    ..
                },
            ) => agents::AgentUpdate::try_new(
                agent_id,
                name.into_value(),
                workspace.into_value(),
                model.into_model_update(),
            )
            .map(|input| agents::Command::Update { endpoint, input })
            .map_err(|_| RequestError::Invalid),
            (
                Operation::Delete,
                Input::Delete {
                    agent_id,
                    delete_files,
                    ..
                },
            ) => agents::AgentDelete::try_new(agent_id, delete_files)
                .map(|input| agents::Command::Delete { endpoint, input })
                .map_err(|_| RequestError::Invalid),
            (Operation::FilesList, Input::FilesList { agent_id, .. }) => {
                Ok(agents::Command::ListFiles { endpoint, agent_id })
            }
            (Operation::FilesGet, Input::FilesGet { agent_id, name, .. }) => parse_file_name(name)
                .map(|name| agents::Command::GetFile {
                    endpoint,
                    agent_id,
                    name,
                }),
            (Operation::PackageExport, Input::PackageExport { agent_id, .. }) => {
                Ok(agents::Command::ExportPackage { endpoint, agent_id })
            }
            (Operation::PackageInstall, Input::PackageInstall { package_path, .. }) => {
                Ok(agents::Command::InstallPackage {
                    endpoint,
                    package_path,
                })
            }
            (
                Operation::FilesSet,
                Input::FilesSet {
                    agent_id,
                    name,
                    content,
                    ..
                },
            ) => parse_file_name(name).map(|name| agents::Command::SetFile {
                endpoint,
                agent_id,
                name,
                content,
            }),
            (Operation::DisplayConfiguration, Input::DisplayConfiguration { .. }) => {
                Ok(agents::Command::DisplayConfiguration { endpoint })
            }
            (
                Operation::SetDescription,
                Input::SetDescription {
                    agent_id,
                    description,
                    ..
                },
            ) => Ok(agents::Command::SetDescription {
                endpoint,
                agent_id,
                description,
            }),
            (
                Operation::SetConfigurationModel,
                Input::SetConfigurationModel {
                    agent_id, model, ..
                },
            ) => {
                let model = model
                    .map(|model| {
                        agents::ConfigurationModel::try_new(model.primary, model.fallbacks)
                    })
                    .transpose()
                    .map_err(|_| RequestError::Invalid)?;
                Ok(agents::Command::SetConfigurationModel {
                    endpoint,
                    agent_id,
                    model,
                })
            }
            (
                Operation::SetSkills,
                Input::SetSkills {
                    agent_id, skills, ..
                },
            ) => Ok(agents::Command::SetSkills {
                endpoint,
                agent_id,
                skills,
            }),
            (Operation::SkillConfiguration, Input::SkillConfiguration { agent_id, .. }) => {
                Ok(agents::Command::SkillConfiguration {
                    endpoint,
                    agent_id,
                    trace_id: trace_id.map(str::to_owned),
                })
            }
            (
                Operation::SetSkillConfiguration,
                Input::SetSkillConfiguration {
                    agent_id,
                    revision,
                    selection,
                    ..
                },
            ) => Ok(agents::Command::SetSkillConfiguration {
                endpoint,
                agent_id,
                revision,
                selection: match selection {
                    SkillSelectionInput::InheritDefaultSkills {} => {
                        agents::SkillSelection::InheritDefaultSkills
                    }
                    SkillSelectionInput::SetExplicitSkillAllowlist { skill_keys } => {
                        agents::SkillSelection::ExplicitSkillAllowlist(skill_keys)
                    }
                },
                trace_id: trace_id.map(str::to_owned),
            }),
            (Operation::ToolConfiguration, Input::ToolConfiguration { agent_id, .. }) => {
                Ok(agents::Command::ToolConfiguration {
                    endpoint,
                    agent_id,
                    trace_id: trace_id.map(str::to_owned),
                })
            }
            (
                Operation::SetToolConfiguration,
                Input::SetToolConfiguration {
                    agent_id,
                    revision,
                    selection,
                    ..
                },
            ) => Ok(agents::Command::SetToolConfiguration {
                endpoint,
                agent_id,
                revision,
                selection: match selection {
                    ToolSelectionInput::InheritDefaultTools {} => {
                        agents::ToolSelection::InheritDefaultTools
                    }
                    ToolSelectionInput::SetAgentToolPolicy {
                        profile,
                        allow,
                        deny,
                    } => agents::ToolSelection::Policy {
                        profile,
                        allow,
                        deny,
                    },
                },
                trace_id: trace_id.map(str::to_owned),
            }),
            _ => Err(RequestError::Invalid),
        }
    }
}

fn parse_file_name(value: String) -> Result<agents::AgentFileName, RequestError> {
    agents::AgentFileName::parse(&value).map_err(|_| RequestError::Invalid)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Operation {
    List,
    DraftWait,
    Create,
    Update,
    Delete,
    FilesGet,
    FilesSet,
    FilesList,
    DisplayConfiguration,
    PackageExport,
    PackageInstall,
    SetDescription,
    SetConfigurationModel,
    SetSkills,
    SkillConfiguration,
    SetSkillConfiguration,
    ToolConfiguration,
    SetToolConfiguration,
}

impl Operation {
    fn requires_openclaw(self) -> bool {
        matches!(
            self,
            Self::DraftWait
                | Self::DisplayConfiguration
                | Self::PackageExport
                | Self::PackageInstall
                | Self::SetDescription
                | Self::SetConfigurationModel
                | Self::SetSkills
                | Self::SkillConfiguration
                | Self::SetSkillConfiguration
                | Self::ToolConfiguration
                | Self::SetToolConfiguration
        )
    }

    fn capability_id(self) -> &'static str {
        match self {
            Self::SkillConfiguration | Self::SetSkillConfiguration => SUBAGENT_SKILLS_CAPABILITY_ID,
            Self::ToolConfiguration | Self::SetToolConfiguration => SUBAGENT_TOOLS_CAPABILITY_ID,
            _ => SUBAGENT_MANAGEMENT_CAPABILITY_ID,
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "subagents.list" => Some(Self::List),
            "subagents.draft.wait" => Some(Self::DraftWait),
            "subagents.create" => Some(Self::Create),
            "subagents.update" => Some(Self::Update),
            "subagents.delete" => Some(Self::Delete),
            "subagents.files.get" => Some(Self::FilesGet),
            "subagents.files.set" => Some(Self::FilesSet),
            "subagents.files.list" => Some(Self::FilesList),
            "subagents.displayConfig.get" => Some(Self::DisplayConfiguration),
            "subagents.package.export" => Some(Self::PackageExport),
            "subagents.package.install" => Some(Self::PackageInstall),
            "subagents.description.set" => Some(Self::SetDescription),
            "subagents.model.set" => Some(Self::SetConfigurationModel),
            "subagents.skills.set" => Some(Self::SetSkills),
            "subagentSkills.get" => Some(Self::SkillConfiguration),
            "subagentSkills.set" => Some(Self::SetSkillConfiguration),
            "subagentTools.get" => Some(Self::ToolConfiguration),
            "subagentTools.set" => Some(Self::SetToolConfiguration),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
    #[serde(rename = "agentId")]
    agent_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "subagentId")]
    subagent_id: Option<String>,
}

impl Target {
    fn is_valid_for(&self, operation: Operation, scope_agent_id: &str) -> bool {
        match operation {
            Operation::List | Operation::DisplayConfiguration => {
                self.kind == AGENT_TARGET_KIND
                    && self.agent_id.as_deref() == Some(scope_agent_id)
                    && self.subagent_id.is_none()
            }
            Operation::Create => {
                self.kind == SUBAGENT_TARGET_KIND
                    && self.agent_id.is_none()
                    && self.subagent_id.is_none()
            }
            _ => self.kind == SUBAGENT_TARGET_KIND && self.agent_id.is_none(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    kind: String,
    #[serde(rename = "runtimeAdapterId")]
    runtime_adapter_id: String,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: String,
}

impl Endpoint {
    fn is_supported(&self) -> bool {
        self.kind == RUNTIME_KIND
            && self.runtime_instance_id == "local"
            && matches!(
                self.runtime_adapter_id.as_str(),
                "openclaw" | "matcha-agent"
            )
    }

    fn native_endpoint(&self) -> NativeEndpoint {
        match self.runtime_adapter_id.as_str() {
            "openclaw" => NativeEndpoint::OpenClawLocal,
            "matcha-agent" => NativeEndpoint::MatchaAgentLocal,
            _ => unreachable!("validated endpoint is supported"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Input {
    List {
        endpoint: Endpoint,
    },
    DraftWait {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "waitSliceMs")]
        wait_slice_ms: u64,
        #[serde(rename = "rpcTimeoutBufferMs")]
        rpc_timeout_buffer_ms: u64,
    },
    Create {
        endpoint: Endpoint,
        name: String,
        workspace: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(rename = "workspaceInitialization", default)]
        workspace_initialization: WorkspaceInitializationInput,
    },
    Update {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(default)]
        name: FieldUpdate<String>,
        #[serde(default)]
        workspace: FieldUpdate<String>,
        #[serde(default)]
        model: FieldUpdate<String>,
    },
    Delete {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "deleteFiles")]
        delete_files: bool,
    },
    FilesGet {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        name: String,
    },
    FilesSet {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        name: String,
        content: String,
    },
    FilesList {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    PackageExport {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    PackageInstall {
        endpoint: Endpoint,
        #[serde(rename = "packagePath")]
        package_path: String,
    },
    DisplayConfiguration {
        endpoint: Endpoint,
    },
    SetDescription {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        description: Option<String>,
    },
    SetConfigurationModel {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        model: Option<ModelInput>,
    },
    SetSkills {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
        skills: Vec<String>,
    },
    SkillConfiguration {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    SetSkillConfiguration {
        #[serde(rename = "agentId")]
        agent_id: String,
        revision: String,
        selection: SkillSelectionInput,
    },
    ToolConfiguration {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    SetToolConfiguration {
        #[serde(rename = "agentId")]
        agent_id: String,
        revision: String,
        selection: ToolSelectionInput,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum WorkspaceInitializationInput {
    #[default]
    MainAgentTemplate,
    EmptyWorkspace,
}

impl From<WorkspaceInitializationInput> for WorkspaceInitialization {
    fn from(value: WorkspaceInitializationInput) -> Self {
        match value {
            WorkspaceInitializationInput::MainAgentTemplate => Self::MainAgentTemplate,
            WorkspaceInitializationInput::EmptyWorkspace => Self::EmptyWorkspace,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum FieldUpdate<T> {
    Unchanged,
    Set(Option<T>),
}

impl<T> Default for FieldUpdate<T> {
    fn default() -> Self {
        Self::Unchanged
    }
}

impl<'de, T> Deserialize<'de> for FieldUpdate<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self::Set)
    }
}

impl FieldUpdate<String> {
    fn is_set(&self) -> bool {
        matches!(self, Self::Set(_))
    }

    fn is_valid_value(&self) -> bool {
        match self {
            Self::Unchanged => true,
            Self::Set(Some(value)) => valid_id(value),
            Self::Set(None) => false,
        }
    }

    fn is_valid_nullable_value(&self) -> bool {
        match self {
            Self::Unchanged | Self::Set(None) => true,
            Self::Set(Some(value)) => valid_id(value),
        }
    }

    fn into_value(self) -> Option<String> {
        match self {
            Self::Set(Some(value)) => Some(value),
            Self::Unchanged | Self::Set(None) => None,
        }
    }

    fn into_model_update(self) -> agents::AgentModelUpdate {
        match self {
            Self::Unchanged => agents::AgentModelUpdate::Unchanged,
            Self::Set(value) => agents::AgentModelUpdate::Set(value),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct AgentConfigurationInput {
    #[serde(rename = "agentId")]
    agent_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct SetSkillConfigurationInput {
    #[serde(rename = "agentId")]
    agent_id: String,
    revision: String,
    selection: SkillSelectionInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct SetToolConfigurationInput {
    #[serde(rename = "agentId")]
    agent_id: String,
    revision: String,
    selection: ToolSelectionInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "selectionType", rename_all = "camelCase", deny_unknown_fields)]
enum SkillSelectionInput {
    InheritDefaultSkills {},
    SetExplicitSkillAllowlist {
        #[serde(rename = "skillKeys")]
        skill_keys: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "selectionType", rename_all = "camelCase", deny_unknown_fields)]
enum ToolSelectionInput {
    InheritDefaultTools {},
    SetAgentToolPolicy {
        profile: String,
        allow: Vec<String>,
        deny: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct ModelInput {
    #[serde(default)]
    primary: Option<String>,
    #[serde(default)]
    fallbacks: Vec<String>,
}

impl Input {
    fn decode(operation: Operation, value: Value) -> Result<Self, RequestError> {
        match operation {
            Operation::SkillConfiguration => {
                let input: AgentConfigurationInput =
                    serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
                Ok(Self::SkillConfiguration {
                    agent_id: input.agent_id,
                })
            }
            Operation::SetSkillConfiguration => {
                let input: SetSkillConfigurationInput =
                    serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
                Ok(Self::SetSkillConfiguration {
                    agent_id: input.agent_id,
                    revision: input.revision,
                    selection: input.selection,
                })
            }
            Operation::ToolConfiguration => {
                let input: AgentConfigurationInput =
                    serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
                Ok(Self::ToolConfiguration {
                    agent_id: input.agent_id,
                })
            }
            Operation::SetToolConfiguration => {
                let input: SetToolConfigurationInput =
                    serde_json::from_value(value).map_err(|_| RequestError::Invalid)?;
                Ok(Self::SetToolConfiguration {
                    agent_id: input.agent_id,
                    revision: input.revision,
                    selection: input.selection,
                })
            }
            _ => serde_json::from_value(value).map_err(|_| RequestError::Invalid),
        }
    }

    fn endpoint(&self) -> Option<&Endpoint> {
        match self {
            Self::List { endpoint }
            | Self::DraftWait { endpoint, .. }
            | Self::Create { endpoint, .. }
            | Self::Update { endpoint, .. }
            | Self::Delete { endpoint, .. }
            | Self::FilesGet { endpoint, .. }
            | Self::FilesSet { endpoint, .. }
            | Self::FilesList { endpoint, .. }
            | Self::PackageExport { endpoint, .. }
            | Self::PackageInstall { endpoint, .. }
            | Self::DisplayConfiguration { endpoint, .. }
            | Self::SetDescription { endpoint, .. }
            | Self::SetConfigurationModel { endpoint, .. }
            | Self::SetSkills { endpoint, .. } => Some(endpoint),
            Self::SkillConfiguration { .. }
            | Self::SetSkillConfiguration { .. }
            | Self::ToolConfiguration { .. }
            | Self::SetToolConfiguration { .. } => None,
        }
    }

    fn is_valid_for(&self, operation: Operation, target: &Target) -> bool {
        let target_matches = |agent_id: &str| target.subagent_id.as_deref() == Some(agent_id);
        match (operation, self) {
            (Operation::List, Self::List { .. }) => true,
            (
                Operation::DraftWait,
                Self::DraftWait {
                    agent_id,
                    run_id,
                    wait_slice_ms,
                    rpc_timeout_buffer_ms,
                    ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && valid_id(run_id)
                    && (1_000..=60_000).contains(wait_slice_ms)
                    && *rpc_timeout_buffer_ms <= 10_000
            }
            (
                Operation::Create,
                Self::Create {
                    name,
                    workspace,
                    model,
                    ..
                },
            ) => {
                target.subagent_id.is_none()
                    && valid_id(name)
                    && valid_id(workspace)
                    && model.as_deref().is_none_or(valid_id)
            }
            (
                Operation::Update,
                Self::Update {
                    agent_id,
                    name,
                    workspace,
                    model,
                    ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && name.is_valid_value()
                    && workspace.is_valid_value()
                    && model.is_valid_nullable_value()
                    && (name.is_set() || workspace.is_set() || model.is_set())
            }
            (Operation::Delete, Self::Delete { agent_id, .. })
            | (Operation::FilesList, Self::FilesList { agent_id, .. })
            | (Operation::PackageExport, Self::PackageExport { agent_id, .. }) => {
                valid_id(agent_id) && target_matches(agent_id)
            }
            (Operation::PackageInstall, Self::PackageInstall { package_path, .. }) => {
                target.subagent_id.is_none() && valid_package_path(package_path)
            }
            (Operation::FilesGet, Self::FilesGet { agent_id, name, .. }) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && agents::AgentFileName::parse(name).is_ok()
            }
            (
                Operation::FilesSet,
                Self::FilesSet {
                    agent_id,
                    name,
                    content,
                    ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && agents::AgentFileName::parse(name).is_ok()
                    && content.len() <= MAX_TEXT_LENGTH
            }
            (Operation::DisplayConfiguration, Self::DisplayConfiguration { .. }) => true,
            (
                Operation::SetDescription,
                Self::SetDescription {
                    agent_id,
                    description,
                    ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && description.as_deref().is_none_or(valid_id)
            }
            (
                Operation::SetConfigurationModel,
                Self::SetConfigurationModel {
                    agent_id, model, ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && model.as_ref().is_none_or(|model| {
                        model.primary.as_deref().is_none_or(valid_id)
                            && model.fallbacks.iter().all(|fallback| valid_id(fallback))
                    })
            }
            (
                Operation::SetSkills,
                Self::SetSkills {
                    agent_id, skills, ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && skills.iter().all(|skill| valid_id(skill))
            }
            (Operation::SkillConfiguration, Self::SkillConfiguration { agent_id, .. })
            | (Operation::ToolConfiguration, Self::ToolConfiguration { agent_id, .. }) => {
                valid_id(agent_id) && target_matches(agent_id)
            }
            (
                Operation::SetSkillConfiguration,
                Self::SetSkillConfiguration {
                    agent_id,
                    revision,
                    selection,
                    ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && valid_id(revision)
                    && match selection {
                        SkillSelectionInput::InheritDefaultSkills {} => true,
                        SkillSelectionInput::SetExplicitSkillAllowlist { skill_keys } => {
                            skill_keys.iter().all(|key| valid_id(key))
                        }
                    }
            }
            (
                Operation::SetToolConfiguration,
                Self::SetToolConfiguration {
                    agent_id,
                    revision,
                    selection,
                    ..
                },
            ) => {
                valid_id(agent_id)
                    && target_matches(agent_id)
                    && valid_id(revision)
                    && match selection {
                        ToolSelectionInput::InheritDefaultTools {} => true,
                        ToolSelectionInput::SetAgentToolPolicy {
                            profile,
                            allow,
                            deny,
                        } => valid_id(profile) && allow.iter().chain(deny).all(|key| valid_id(key)),
                    }
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    fn endpoint(adapter: &str) -> Value {
        json!({
            "kind": "native-runtime",
            "runtimeAdapterId": adapter,
            "runtimeInstanceId": "local",
        })
    }

    fn request() -> Value {
        json!({
            "id": "subagent.management",
            "operationId": "subagents.files.set",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent", "subagentId": "agent-1" },
            "input": {
                "kind": "filesSet",
                "endpoint": endpoint("openclaw"),
                "agentId": "agent-1",
                "name": "AGENTS.md",
                "content": "",
            },
        })
    }

    #[test]
    fn unit_variant_rejects_unknown_fields() {
        let skills_set = |selection: Value| {
            json!({
                "id": SUBAGENT_SKILLS_CAPABILITY_ID,
                "operationId": "subagentSkills.set",
                "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
                "target": { "kind": "subagent", "subagentId": "main" },
                "input": {
                    "agentId": "main",
                    "revision": "rev-1",
                    "selection": selection,
                },
            })
        };

        let mut accepted_verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(
            AgentsRequest::decode(
                skills_set(json!({ "selectionType": "inheritDefaultSkills" })),
                &decision_for(SUBAGENT_SKILLS_CAPABILITY_ID),
                &mut accepted_verifier,
                now_millis(),
            )
            .is_ok()
        );

        let mut rejected_verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(
            AgentsRequest::decode(
                skills_set(json!({ "selectionType": "inheritDefaultSkills", "bogus": 1 })),
                &decision_for(SUBAGENT_SKILLS_CAPABILITY_ID),
                &mut rejected_verifier,
                now_millis(),
            )
            .is_err()
        );
    }

    #[test]
    fn validates_the_list_request_with_a_capability_level_decision() {
        let value = json!({
            "id": "subagent.management",
            "operationId": "subagents.list",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "agent", "agentId": "main" },
            "input": { "kind": "list", "endpoint": endpoint("openclaw") },
        });
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();

        assert!(AgentsRequest::decode(value, &decision(), &mut verifier, now_millis()).is_ok());
    }

    #[test]
    fn accepts_one_capability_level_decision_for_each_distinct_subagent_operation() {
        let list = json!({
            "id": "subagent.management",
            "operationId": "subagents.list",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "agent", "agentId": "main" },
            "input": { "kind": "list", "endpoint": endpoint("openclaw") },
        });
        let skill_configuration = json!({
            "id": "subagent.skills",
            "operationId": "subagentSkills.get",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent", "subagentId": "main" },
            "input": { "agentId": "main" },
        });
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();

        assert!(AgentsRequest::decode(list, &decision(), &mut verifier, now_millis()).is_ok());
        assert!(
            AgentsRequest::decode(
                skill_configuration,
                &decision_for(SUBAGENT_SKILLS_CAPABILITY_ID),
                &mut verifier,
                now_millis(),
            )
            .is_ok()
        );
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[47; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision_for(capability: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": capability,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": now_millis() + 60_000,
            "correlation": format!("test:{}", now_millis()),
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }

    fn decision() -> String {
        decision_for(SUBAGENT_MANAGEMENT_CAPABILITY_ID)
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap()
    }

    #[test]
    fn create_defaults_to_main_agent_templates_and_accepts_empty_workspace_override() {
        let request = json!({
            "id": "subagent.management",
            "operationId": "subagents.create",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent" },
            "input": {
                "kind": "create",
                "endpoint": endpoint("openclaw"),
                "name": "writer",
                "workspace": "C:/workspace/writer",
                "model": null,
            },
        });
        assert!(AgentsRequest::decode_semantics(request.clone()).is_ok());
        assert_eq!(
            AgentsRequest::decode_semantics(request.clone())
                .expect("decode create")
                .command(None),
            Ok(agents::Command::Create {
                endpoint: NativeEndpoint::OpenClawLocal,
                input: agents::AgentCreate::try_new(
                    "writer".into(),
                    "C:/workspace/writer".into(),
                    None,
                )
                .expect("agent create"),
                workspace_initialization: WorkspaceInitialization::MainAgentTemplate,
            })
        );

        let mut empty = request.clone();
        empty["input"]["workspaceInitialization"] = json!("emptyWorkspace");
        assert_eq!(
            AgentsRequest::decode_semantics(empty)
                .expect("decode create")
                .command(None),
            Ok(agents::Command::Create {
                endpoint: NativeEndpoint::OpenClawLocal,
                input: agents::AgentCreate::try_new(
                    "writer".into(),
                    "C:/workspace/writer".into(),
                    None,
                )
                .expect("agent create"),
                workspace_initialization: WorkspaceInitialization::EmptyWorkspace,
            })
        );

        let mut invalid = request;
        invalid["input"]["workspaceInitialization"] = json!("bad");
        assert_eq!(
            AgentsRequest::decode_semantics(invalid),
            Err(RequestError::Invalid)
        );
    }

    #[test]
    fn accepts_only_the_fixed_rooted_file_request() {
        assert!(AgentsRequest::decode_semantics(request()).is_ok());
        for value in [
            json!({}),
            {
                let mut value = request();
                value["input"]["name"] = json!("../AGENTS.md");
                value
            },
            {
                let mut value = request();
                value["input"]["path"] = json!("C:/private/root/AGENTS.md");
                value
            },
            {
                let mut value = request();
                value["input"]["workspaceInitialization"] = json!("emptyWorkspace");
                value
            },
        ] {
            assert_eq!(
                AgentsRequest::decode_semantics(value),
                Err(RequestError::Invalid)
            );
        }
    }

    #[test]
    fn accepts_only_the_fixed_configuration_requests() {
        let display = json!({
            "id": "subagent.management",
            "operationId": "subagents.displayConfig.get",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "agent", "agentId": "main" },
            "input": {
                "kind": "displayConfiguration",
                "endpoint": endpoint("openclaw"),
            },
        });
        assert!(AgentsRequest::decode_semantics(display.clone()).is_ok());

        let description = json!({
            "id": "subagent.management",
            "operationId": "subagents.description.set",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent", "subagentId": "writer" },
            "input": {
                "kind": "setDescription",
                "endpoint": endpoint("openclaw"),
                "agentId": "writer",
                "description": null,
            },
        });
        assert!(AgentsRequest::decode_semantics(description).is_ok());

        let model = json!({
            "id": "subagent.management",
            "operationId": "subagents.model.set",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent", "subagentId": "writer" },
            "input": {
                "kind": "setConfigurationModel",
                "endpoint": endpoint("openclaw"),
                "agentId": "writer",
                "model": { "primary": "provider/one", "fallbacks": ["provider/two"] },
            },
        });
        assert!(AgentsRequest::decode_semantics(model).is_ok());

        let skills = json!({
            "id": "subagent.management",
            "operationId": "subagents.skills.set",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent", "subagentId": "writer" },
            "input": {
                "kind": "setSkills",
                "endpoint": endpoint("openclaw"),
                "agentId": "writer",
                "skills": ["research"],
            },
        });
        assert!(AgentsRequest::decode_semantics(skills).is_ok());

        let mut non_openclaw = display.clone();
        non_openclaw["scope"]["endpoint"] = endpoint("matcha-agent");
        non_openclaw["input"]["endpoint"] = endpoint("matcha-agent");
        assert_eq!(
            AgentsRequest::decode_semantics(non_openclaw),
            Err(RequestError::Invalid)
        );

        let mut scoped_display = display.clone();
        scoped_display["target"]["subagentId"] = json!("writer");
        assert_eq!(
            AgentsRequest::decode_semantics(scoped_display),
            Err(RequestError::Invalid)
        );

        let mut agent_scoped_display = display;
        agent_scoped_display["input"]["agentId"] = json!("writer");
        assert_eq!(
            AgentsRequest::decode_semantics(agent_scoped_display),
            Err(RequestError::Invalid)
        );
    }

    #[test]
    fn package_install_uses_root_subagent_target_and_public_receipt() {
        let request = json!({
            "id": "subagent.management",
            "operationId": "subagents.package.install",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent" },
            "input": {
                "kind": "packageInstall",
                "endpoint": endpoint("openclaw"),
                "packagePath": "C:/sealed/writer.matcha-agentpkg",
            },
        });
        let decoded =
            AgentsRequest::decode_semantics(request.clone()).expect("decode package install");
        assert_eq!(
            decoded.command(None),
            Ok(agents::Command::InstallPackage {
                endpoint: NativeEndpoint::OpenClawLocal,
                package_path: "C:/sealed/writer.matcha-agentpkg".into(),
            })
        );

        for value in [
            {
                let mut value = request.clone();
                value["target"]["subagentId"] = json!("writer");
                value
            },
            {
                let mut value = request.clone();
                value["input"]["agentId"] = json!("writer");
                value
            },
            {
                let mut value = request.clone();
                value["input"]["files"] = json!([]);
                value
            },
            {
                let mut value = request.clone();
                value["input"]["workspaceInitialization"] = json!("emptyWorkspace");
                value
            },
            {
                let mut value = request.clone();
                value["input"]["description"] = json!("Writes copy");
                value
            },
            {
                let mut value = request.clone();
                value["input"]["packagePath"] = json!("C:/sealed/writer.matchaclaw-agent.json");
                value
            },
            {
                let mut value = request.clone();
                value["scope"]["endpoint"] = endpoint("matcha-agent");
                value["input"]["endpoint"] = endpoint("matcha-agent");
                value
            },
        ] {
            assert_eq!(
                AgentsRequest::decode_semantics(value),
                Err(RequestError::Invalid)
            );
        }

        assert_eq!(
            crate::projection::public::map_outcome(agents::Outcome::PackageInstalled(
                agents::PackageInstallReceipt::new("writer".into()),
            ))
            .body(),
            json!({ "success": true, "package": { "agentId": "writer" } })
        );
    }

    #[test]
    fn draft_wait_accepts_only_bound_openclaw_input_and_redacts_receipts() {
        let request = json!({
            "id": "subagent.management",
            "operationId": "subagents.draft.wait",
            "scope": { "kind": "agent", "endpoint": endpoint("openclaw"), "agentId": "main" },
            "target": { "kind": "subagent", "subagentId": "writer" },
            "input": {
                "kind": "draftWait",
                "endpoint": endpoint("openclaw"),
                "agentId": "writer",
                "runId": "run-1",
                "waitSliceMs": 30_000,
                "rpcTimeoutBufferMs": 10_000,
            },
        });
        assert!(AgentsRequest::decode_semantics(request.clone()).is_ok());

        for value in [
            {
                let mut value = request.clone();
                value["target"]["subagentId"] = json!("other");
                value
            },
            {
                let mut value = request.clone();
                value["input"]["runId"] = json!("\u{0}");
                value
            },
            {
                let mut value = request.clone();
                value["input"]["waitSliceMs"] = json!(999);
                value
            },
            {
                let mut value = request.clone();
                value["input"]["rpcTimeoutBufferMs"] = json!(10_001);
                value
            },
            {
                let mut value = request.clone();
                value["scope"]["endpoint"] = endpoint("matcha-agent");
                value["input"]["endpoint"] = endpoint("matcha-agent");
                value
            },
        ] {
            assert_eq!(
                AgentsRequest::decode_semantics(value),
                Err(RequestError::Invalid)
            );
        }

        let delivery = crate::projection::public::map_outcome(agents::Outcome::Waited(
            agents::AgentWaitResult {
                status: agents::AgentWaitStatus::Timeout,
                started_at: Some(1),
                ended_at: None,
            },
        ));
        assert_eq!(delivery.status_code(), 200);
        assert_eq!(
            delivery.body(),
            json!({
                "success": true,
                "status": "timeout",
                "startedAt": 1,
                "endedAt": null,
            })
        );
        assert!(!delivery.body().to_string().contains("error"));

        let unknown = crate::projection::public::map_outcome(agents::Outcome::WaitUnknown);
        assert_eq!(unknown.status_code(), 409);
        assert_eq!(
            unknown.body(),
            json!({
                "success": false,
                "error": "Subagent wait outcome is unknown",
            })
        );
    }
}
