use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    agents::{self, NativeEndpoint, WorkspaceInitialization},
    transport::common::authorization::CapabilityDecisionVerifier,
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
const MAX_TEXT_LENGTH: usize = 1024 * 1024;

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Delivery {
    Agents {
        default_id: String,
        selection_required: bool,
        agents: Vec<AgentSummaryResponse>,
    },
    Wait(AgentWaitResponse),
    Created(AgentMutationResponse),
    Updated(AgentMutationResponse),
    Deleted(AgentMutationResponse),
    Files(Vec<AgentFileResponse>),
    File(AgentFileResponse),
    Configuration(ConfigurationResponse),
    ConfigurationApplied,
    SkillConfiguration(Value),
    ToolConfiguration(Value),
    PackageExport(PackageExportResponse),
    PackageInstall(PackageInstallResponse),
    Rejected,
    OutcomeUnknown,
    WaitUnknown,
    Unsupported,
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Agents { .. }
            | Self::Wait(_)
            | Self::Created(_)
            | Self::Updated(_)
            | Self::Deleted(_)
            | Self::Files(_)
            | Self::File(_)
            | Self::Configuration(_)
            | Self::ConfigurationApplied
            | Self::SkillConfiguration(_)
            | Self::ToolConfiguration(_)
            | Self::PackageExport(_)
            | Self::PackageInstall(_) => 200,
            Self::Rejected => 422,
            Self::OutcomeUnknown | Self::WaitUnknown | Self::Unsupported => 409,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Agents {
                default_id,
                selection_required,
                agents,
            } => serde_json::json!({
                "success": true,
                "defaultId": default_id,
                "selectionRequired": selection_required,
                "agents": agents,
            }),
            Self::Wait(wait) => serde_json::json!({
                "success": true,
                "status": wait.status,
                "startedAt": wait.started_at,
                "endedAt": wait.ended_at,
            }),
            Self::Created(agent) => success_mutation("created", agent),
            Self::Updated(agent) => success_mutation("updated", agent),
            Self::Deleted(agent) => success_mutation("deleted", agent),
            Self::Files(files) => serde_json::json!({ "success": true, "files": files }),
            Self::File(file) => serde_json::json!({ "success": true, "file": file }),
            Self::Configuration(configuration) => serde_json::json!({
                "success": true,
                "defaults": configuration.defaults,
                "agents": configuration.agents,
            }),
            Self::ConfigurationApplied => serde_json::json!({ "success": true }),
            Self::SkillConfiguration(view) | Self::ToolConfiguration(view) => view.clone(),
            Self::PackageExport(package) => {
                serde_json::json!({ "success": true, "package": package })
            }
            Self::PackageInstall(package) => {
                serde_json::json!({ "success": true, "package": package })
            }
            Self::Rejected => error("Subagent request was rejected"),
            Self::OutcomeUnknown => error("Subagent mutation outcome is unknown"),
            Self::WaitUnknown => error("Subagent wait outcome is unknown"),
            Self::Unsupported => error("Subagent management is unsupported for this runtime"),
            Self::Unavailable => error("Subagent management is unavailable"),
        }
    }
}

fn success_mutation(kind: &'static str, agent: &AgentMutationResponse) -> Value {
    serde_json::json!({ "success": true, "kind": kind, "agent": agent })
}

fn error(message: &'static str) -> Value {
    serde_json::json!({ "success": false, "error": message })
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentWaitResponse {
    status: &'static str,
    started_at: Option<u64>,
    ended_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSummaryResponse {
    id: String,
    name: Option<String>,
    workspace: Option<String>,
    model: Option<String>,
    kind: AgentKindResponse,
    sealed: bool,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum AgentKindResponse {
    Agent,
    System,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageExportResponse {
    agent_id: String,
    file_name: String,
    package_path: String,
    size: u64,
    exported_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageInstallResponse {
    agent_id: String,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentMutationResponse {
    id: String,
    name: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentFileResponse {
    name: String,
    missing: bool,
    size: Option<u64>,
    updated_at_ms: Option<u64>,
    content: Option<String>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigurationResponse {
    defaults: ConfigurationDefaultsResponse,
    agents: Vec<ConfigurationAgentResponse>,
}

#[derive(Clone, Debug, Serialize, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ConfigurationDefaultsResponse {
    model: Option<ConfigurationModelResponse>,
    skills: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ConfigurationAgentResponse {
    id: String,
    description: Option<String>,
    model: Option<ConfigurationModelResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skills: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ConfigurationModelResponse {
    primary: Option<String>,
    fallbacks: Vec<String>,
}

pub(crate) fn map_outcome(outcome: agents::Outcome) -> Delivery {
    match outcome {
        agents::Outcome::Agents {
            default_id,
            selection_required,
            agents,
        } => Delivery::Agents {
            default_id,
            selection_required,
            agents: agents.into_iter().map(agent_summary).collect(),
        },
        agents::Outcome::Waited(wait) => Delivery::Wait(agent_wait(wait)),
        agents::Outcome::Created(agent) => Delivery::Created(agent_mutation(agent)),
        agents::Outcome::Updated(agent) => Delivery::Updated(agent_mutation(agent)),
        agents::Outcome::Deleted(agent) => Delivery::Deleted(agent_mutation(agent)),
        agents::Outcome::Files(files) => {
            Delivery::Files(files.files.into_iter().map(agent_file).collect())
        }
        agents::Outcome::File(file) => Delivery::File(agent_file(file)),
        agents::Outcome::Configuration(configuration) => {
            Delivery::Configuration(configuration_response(configuration))
        }
        agents::Outcome::ConfigurationApplied => Delivery::ConfigurationApplied,
        agents::Outcome::SkillConfiguration(outcome) => skill_configuration_delivery(outcome),
        agents::Outcome::ToolConfiguration(outcome) => tool_configuration_delivery(outcome),
        agents::Outcome::PackageExported(package) => {
            Delivery::PackageExport(package_export(package))
        }
        agents::Outcome::PackageInstalled(package) => {
            Delivery::PackageInstall(package_install(package))
        }
        agents::Outcome::Rejected => Delivery::Rejected,
        agents::Outcome::Unknown => Delivery::OutcomeUnknown,
        agents::Outcome::WaitUnknown => Delivery::WaitUnknown,
        agents::Outcome::Unsupported => Delivery::Unsupported,
        agents::Outcome::Unavailable => Delivery::Unavailable,
    }
}

fn skill_configuration_delivery(outcome: agents::SkillConfigurationOutcome) -> Delivery {
    use agents::SkillConfigurationOutcome;
    match outcome {
        SkillConfigurationOutcome::View(view) => {
            Delivery::SkillConfiguration(skill_view_value(view))
        }
        SkillConfigurationOutcome::Updated(view) => {
            Delivery::SkillConfiguration(skill_updated_response(view))
        }
        SkillConfigurationOutcome::Stale(view) => Delivery::SkillConfiguration(serde_json::json!({
            "success": true,
            "resultType": "staleRevision",
            "latestView": skill_view_value(view),
        })),
        SkillConfigurationOutcome::InvalidSkillKeys {
            unknown_skill_keys,
            non_canonical_skill_keys,
        } => Delivery::SkillConfiguration(serde_json::json!({
            "success": true,
            "resultType": "invalidSkillKeys",
            "unknownSkillKeys": unknown_skill_keys,
            "nonCanonicalSkillKeys": non_canonical_skill_keys,
        })),
        SkillConfigurationOutcome::Unsupported => {
            Delivery::SkillConfiguration(unsupported_skill_response())
        }
        SkillConfigurationOutcome::Rejected => Delivery::Rejected,
        SkillConfigurationOutcome::OutcomeUnknown => Delivery::OutcomeUnknown,
        SkillConfigurationOutcome::Unavailable(_) => Delivery::Unavailable,
    }
}

fn tool_configuration_delivery(outcome: agents::ToolConfigurationOutcome) -> Delivery {
    use agents::ToolConfigurationOutcome;
    match outcome {
        ToolConfigurationOutcome::View(view) => Delivery::ToolConfiguration(tool_view_value(view)),
        ToolConfigurationOutcome::Updated(view) => {
            Delivery::ToolConfiguration(tool_updated_response(view))
        }
        ToolConfigurationOutcome::Stale(view) => Delivery::ToolConfiguration(serde_json::json!({
            "success": true,
            "resultType": "staleRevision",
            "latestView": tool_view_value(view),
        })),
        ToolConfigurationOutcome::InvalidToolKeys(keys) => {
            Delivery::ToolConfiguration(serde_json::json!({
                "success": true,
                "resultType": "invalidToolKeys",
                "unknownToolKeys": keys,
            }))
        }
        ToolConfigurationOutcome::Unsupported => {
            Delivery::ToolConfiguration(unsupported_tool_response())
        }
        ToolConfigurationOutcome::Rejected => Delivery::Rejected,
        ToolConfigurationOutcome::OutcomeUnknown => Delivery::OutcomeUnknown,
        ToolConfigurationOutcome::Unavailable(_) => Delivery::Unavailable,
    }
}

fn unsupported_skill_response() -> Value {
    serde_json::json!({
        "success": true,
        "resultType": "unsupported",
        "reason": "agentNotConfigured",
    })
}

fn unsupported_tool_response() -> Value {
    serde_json::json!({
        "success": true,
        "resultType": "unsupported",
        "reason": "agentNotConfigured",
    })
}

fn skill_updated_response(view: agents::SkillConfigurationView) -> Value {
    serde_json::json!({ "success": true, "resultType": "updated", "view": skill_view_value(view) })
}

fn skill_view_value(view: agents::SkillConfigurationView) -> Value {
    let support = if view.configured() {
        serde_json::json!({ "supportType": "supported" })
    } else {
        serde_json::json!({ "supportType": "unsupported", "reason": "agentNotConfigured" })
    };
    serde_json::json!({
        "agentId": view.agent_id(),
        "support": support,
        "selectionMode": if view.has_explicit_skill_allowlist() { "usesExplicitSkillAllowlist" } else { "inheritsDefaultSkills" },
        "explicitSkillKeys": view.explicit_skill_keys(),
        "inheritedDefaultSkillKeys": view.inherited_default_skill_keys(),
        "effectiveSkillKeys": view.effective_skill_keys(),
        "options": view.options().iter().map(skill_option_value).collect::<Vec<_>>(),
        "revision": view.revision(),
        "updatedAt": Value::Null,
    })
}

fn skill_option_value(option: &agents::SkillOption) -> Value {
    use agents::SkillUnavailableReason;
    let unavailable_reason = option.unavailable_reason().map(|reason| match reason {
        SkillUnavailableReason::GlobalSkillDisabled => "globalSkillDisabled",
        SkillUnavailableReason::BlockedByRuntimeAllowlist => "blockedByRuntimeAllowlist",
        SkillUnavailableReason::MissingRequirements => "missingRequirements",
    });
    let missing_requirements = option.missing_requirements().map(|missing| {
        serde_json::json!({
            "bins": missing.bins(),
            "anyBins": missing.any_bins(),
            "env": missing.env(),
            "config": missing.config(),
            "os": missing.os(),
        })
    });
    serde_json::json!({
        "skillKey": option.key(), "displayName": option.display_name(), "description": option.description(),
        "selectable": option.selectable(),
        "unavailableReason": unavailable_reason, "missingRequirements": missing_requirements,
    })
}

fn tool_updated_response(view: agents::ToolConfigurationView) -> Value {
    serde_json::json!({ "success": true, "resultType": "updated", "view": tool_view_value(view) })
}

fn tool_view_value(view: agents::ToolConfigurationView) -> Value {
    let support = if view.configured() {
        serde_json::json!({ "supportType": "supported" })
    } else {
        serde_json::json!({ "supportType": "unsupported", "reason": "agentNotConfigured" })
    };
    let catalog = view.catalog();
    serde_json::json!({
        "agentId": view.agent_id(),
        "support": support,
        "selectionMode": if view.policy().is_some() { "usesAgentToolPolicy" } else { "inheritsDefaultTools" },
        "toolPolicy": view.policy().map(|policy| serde_json::json!({ "profile": policy.profile(), "allow": policy.allow(), "deny": policy.deny() })),
        "toolProfiles": catalog.profiles().iter().map(|profile| serde_json::json!({ "profileKey": profile.key(), "displayName": profile.display_name() })).collect::<Vec<_>>(),
        "toolGroups": catalog.groups().iter().map(|group| serde_json::json!({
            "groupKey": group.key(), "displayName": group.display_name(), "source": group.source(), "pluginId": group.plugin_id(),
            "toolOptions": group.tools().iter().map(tool_option_value).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "toolOptions": catalog.options().iter().map(tool_option_value).collect::<Vec<_>>(),
        "revision": view.revision(),
        "updatedAt": Value::Null,
    })
}

fn tool_option_value(option: &agents::ToolOption) -> Value {
    serde_json::json!({
        "toolKey": option.key(), "displayName": option.display_name(),
        "optionType": if option.group_key().is_some() { "tool" } else { "group" },
        "description": option.description(), "source": option.source(), "pluginId": option.plugin_id(),
        "optional": option.optional(), "risk": option.risk(), "tags": option.tags(), "defaultProfiles": option.default_profiles(),
        "groupKey": option.group_key(), "groupDisplayName": option.group_display_name(),
    })
}

fn agent_wait(wait: agents::AgentWaitResult) -> AgentWaitResponse {
    AgentWaitResponse {
        status: match wait.status {
            agents::AgentWaitStatus::Completed => "completed",
            agents::AgentWaitStatus::Failed => "failed",
            agents::AgentWaitStatus::Timeout => "timeout",
            agents::AgentWaitStatus::Pending => "pending",
        },
        started_at: wait.started_at,
        ended_at: wait.ended_at,
    }
}

fn agent_summary(agent: agents::AgentSummary) -> AgentSummaryResponse {
    let kind = match agent.kind {
        agents::AgentKind::Agent => AgentKindResponse::Agent,
        agents::AgentKind::System => AgentKindResponse::System,
    };
    AgentSummaryResponse {
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace,
        model: agent.model,
        kind,
        sealed: agent.sealed,
    }
}

fn package_export(
    package: crate::sealed_resource::SealedAgentPackageExport,
) -> PackageExportResponse {
    PackageExportResponse {
        agent_id: package.agent_key().as_str().to_owned(),
        file_name: package.file_name().to_owned(),
        package_path: package.package_path().to_string_lossy().into_owned(),
        size: package.size(),
        exported_at_ms: package.exported_at_ms(),
    }
}

fn package_install(
    package: crate::sealed_resource::SealedAgentCatalogEntry,
) -> PackageInstallResponse {
    PackageInstallResponse {
        agent_id: package.agent_key().as_str().to_owned(),
    }
}

fn agent_mutation(agent: impl IntoMutationResponse) -> AgentMutationResponse {
    agent.into_mutation_response()
}

trait IntoMutationResponse {
    fn into_mutation_response(self) -> AgentMutationResponse;
}

impl IntoMutationResponse for agents::AgentCreated {
    fn into_mutation_response(self) -> AgentMutationResponse {
        AgentMutationResponse {
            id: self.agent_id,
            name: Some(self.name),
            model: self.model,
        }
    }
}

impl IntoMutationResponse for agents::AgentUpdated {
    fn into_mutation_response(self) -> AgentMutationResponse {
        AgentMutationResponse {
            id: self.agent_id,
            name: None,
            model: None,
        }
    }
}

impl IntoMutationResponse for agents::AgentDeleted {
    fn into_mutation_response(self) -> AgentMutationResponse {
        AgentMutationResponse {
            id: self.agent_id,
            name: None,
            model: None,
        }
    }
}

fn agent_file(file: agents::AgentFile) -> AgentFileResponse {
    AgentFileResponse {
        name: file.name.as_str().to_owned(),
        missing: file.missing,
        size: file.size,
        updated_at_ms: file.updated_at_ms,
        content: file.content,
    }
}

fn configuration_response(configuration: agents::ConfigurationDisplay) -> ConfigurationResponse {
    ConfigurationResponse {
        defaults: ConfigurationDefaultsResponse {
            model: configuration.defaults().model().map(configuration_model),
            skills: configuration.defaults().skills().to_vec(),
        },
        agents: configuration
            .agents()
            .iter()
            .map(|agent| ConfigurationAgentResponse {
                id: agent.id().to_owned(),
                description: agent.description().map(str::to_owned),
                model: agent.model().map(configuration_model),
                skills: agent.skills().map(ToOwned::to_owned),
            })
            .collect(),
    }
}

fn configuration_model(model: &agents::ConfigurationModel) -> ConfigurationModelResponse {
    ConfigurationModelResponse {
        primary: model.primary().map(str::to_owned),
        fallbacks: model.fallbacks().to_vec(),
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
    fn projects_agent_list_with_public_kind_and_selection_requirement() {
        let body = Delivery::Agents {
            default_id: "main".into(),
            selection_required: true,
            agents: vec![
                AgentSummaryResponse {
                    id: "main".into(),
                    name: Some("Main".into()),
                    workspace: Some("C:/workspace/main".into()),
                    model: Some("provider/model".into()),
                    kind: AgentKindResponse::Agent,
                    sealed: false,
                },
                AgentSummaryResponse {
                    id: "system".into(),
                    name: None,
                    workspace: None,
                    model: None,
                    kind: AgentKindResponse::System,
                    sealed: true,
                },
            ],
        }
        .body();

        assert_eq!(
            body,
            json!({
                "success": true,
                "defaultId": "main",
                "selectionRequired": true,
                "agents": [
                    { "id": "main", "name": "Main", "workspace": "C:/workspace/main", "model": "provider/model", "kind": "agent", "sealed": false },
                    { "id": "system", "name": null, "workspace": null, "model": null, "kind": "system", "sealed": true },
                ],
            })
        );
        let rendered = body.to_string();
        assert!(!rendered.contains("identity"));
        assert!(!rendered.contains("agentRuntime"));
        assert!(!rendered.contains("ownership"));
    }

    #[test]
    fn projects_files_without_native_workspace_or_path() {
        let delivery = Delivery::File(AgentFileResponse {
            name: "AGENTS.md".into(),
            missing: false,
            size: Some(0),
            updated_at_ms: Some(1),
            content: Some(String::new()),
        });
        let rendered = delivery.body().to_string();
        assert!(!rendered.contains("workspace"));
        assert!(!rendered.contains("path"));
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
    fn configuration_projection_omits_private_workspace() {
        let response = ConfigurationResponse {
            defaults: ConfigurationDefaultsResponse {
                model: None,
                skills: vec!["research".into()],
            },
            agents: vec![ConfigurationAgentResponse {
                id: "writer".into(),
                description: Some("Writes copy".into()),
                model: None,
                skills: Some(vec![]),
            }],
        };
        let rendered = Delivery::Configuration(response).body().to_string();
        assert!(!rendered.contains("workspace"));
        assert!(!rendered.contains("path"));
        assert!(!rendered.contains("hash"));
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
            Delivery::PackageInstall(PackageInstallResponse {
                agent_id: "writer".into(),
            })
            .body(),
            json!({ "success": true, "package": { "agentId": "writer" } })
        );
    }

    #[test]
    fn mutation_outcome_unknown_is_distinct_and_non_success() {
        let delivery = Delivery::OutcomeUnknown;
        assert_eq!(delivery.status_code(), 409);
        assert_eq!(
            delivery.body(),
            json!({
                "success": false,
                "error": "Subagent mutation outcome is unknown",
            })
        );
    }

    #[test]
    fn typed_configuration_failures_preserve_the_native_failure_taxonomy() {
        use agents::{SkillConfigurationOutcome, ToolConfigurationOutcome};

        let rejected = skill_configuration_delivery(SkillConfigurationOutcome::Rejected);
        assert_eq!(rejected.status_code(), 422);
        assert_eq!(
            rejected.body(),
            json!({ "success": false, "error": "Subagent request was rejected" })
        );

        let unknown = tool_configuration_delivery(ToolConfigurationOutcome::OutcomeUnknown);
        assert_eq!(unknown.status_code(), 409);
        assert_eq!(
            unknown.body(),
            json!({ "success": false, "error": "Subagent mutation outcome is unknown" })
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

        let delivery = Delivery::Wait(AgentWaitResponse {
            status: "timeout",
            started_at: Some(1),
            ended_at: None,
        });
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

        let unknown = Delivery::WaitUnknown;
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
