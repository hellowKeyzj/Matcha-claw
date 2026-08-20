use openclaw::{
    agents::{
        AgentCreate, AgentCreated, AgentDelete, AgentDeleted, AgentFile, AgentFileName, AgentFiles,
        AgentSummary, AgentUpdate, AgentUpdated, AgentWait, AgentWaitResult, AgentsList,
        AgentsMutationOutcome, AgentsReadFailure, AgentsWaitOutcome,
    },
    projection::agent_configuration::{
        Display as AgentConfigurationDisplay, Model as AgentConfigurationModel,
        MutationOutcome as AgentConfigurationMutationOutcome,
        ReadFailure as AgentConfigurationReadFailure, SkillConfigurationOutcome, SkillSelection,
        ToolConfigurationOutcome, ToolSelection,
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeEndpoint {
    OpenClawLocal,
    MatchaAgentLocal,
}

impl NativeEndpoint {
    pub(crate) fn runtime_endpoint(self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        match self {
            Self::OpenClawLocal => {
                crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint()
            }
            Self::MatchaAgentLocal => {
                crate::runtime_driver::RuntimeDriverIdentity::matcha_agent().endpoint()
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    List {
        endpoint: NativeEndpoint,
    },
    Wait {
        endpoint: NativeEndpoint,
        input: AgentWait,
    },
    Create {
        endpoint: NativeEndpoint,
        input: AgentCreate,
    },
    Update {
        endpoint: NativeEndpoint,
        input: AgentUpdate,
    },
    Delete {
        endpoint: NativeEndpoint,
        input: AgentDelete,
    },
    ListFiles {
        endpoint: NativeEndpoint,
        agent_id: String,
    },
    GetFile {
        endpoint: NativeEndpoint,
        agent_id: String,
        name: AgentFileName,
    },
    SetFile {
        endpoint: NativeEndpoint,
        agent_id: String,
        name: AgentFileName,
        content: String,
    },
    DisplayConfiguration {
        endpoint: NativeEndpoint,
    },
    SetDescription {
        endpoint: NativeEndpoint,
        agent_id: String,
        description: Option<String>,
    },
    SetConfigurationModel {
        endpoint: NativeEndpoint,
        agent_id: String,
        model: Option<AgentConfigurationModel>,
    },
    SetSkills {
        endpoint: NativeEndpoint,
        agent_id: String,
        skills: Vec<String>,
    },
    SkillConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
    },
    SetSkillConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
        revision: String,
        selection: SkillSelection,
    },
    ToolConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
    },
    SetToolConfiguration {
        endpoint: NativeEndpoint,
        agent_id: String,
        revision: String,
        selection: ToolSelection,
    },
}

impl Command {
    pub(crate) const fn endpoint(&self) -> NativeEndpoint {
        match self {
            Self::List { endpoint }
            | Self::Wait { endpoint, .. }
            | Self::Create { endpoint, .. }
            | Self::Update { endpoint, .. }
            | Self::Delete { endpoint, .. }
            | Self::ListFiles { endpoint, .. }
            | Self::GetFile { endpoint, .. }
            | Self::SetFile { endpoint, .. }
            | Self::DisplayConfiguration { endpoint, .. }
            | Self::SetDescription { endpoint, .. }
            | Self::SetConfigurationModel { endpoint, .. }
            | Self::SetSkills { endpoint, .. }
            | Self::SkillConfiguration { endpoint, .. }
            | Self::SetSkillConfiguration { endpoint, .. }
            | Self::ToolConfiguration { endpoint, .. }
            | Self::SetToolConfiguration { endpoint, .. } => *endpoint,
        }
    }
}

pub(crate) enum Outcome {
    Agents {
        default_id: String,
        agents: Vec<AgentSummary>,
    },
    Waited(AgentWaitResult),
    WaitUnknown,
    Created(AgentCreated),
    Updated(AgentUpdated),
    Deleted(AgentDeleted),
    Files(AgentFiles),
    File(AgentFile),
    Configuration(AgentConfigurationDisplay),
    ConfigurationApplied,
    SkillConfiguration(SkillConfigurationOutcome),
    ToolConfiguration(ToolConfigurationOutcome),
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

pub(crate) fn wait(result: AgentsWaitOutcome) -> Outcome {
    match result {
        AgentsWaitOutcome::Observed(receipt) => Outcome::Waited(receipt),
        AgentsWaitOutcome::Rejected => Outcome::Rejected,
        AgentsWaitOutcome::OutcomeUnknown => Outcome::WaitUnknown,
    }
}

pub(crate) fn read(result: Result<AgentsList, AgentsReadFailure>) -> Outcome {
    match result {
        Ok(AgentsList { default_id, agents }) => Outcome::Agents { default_id, agents },
        Err(AgentsReadFailure::Rejected) => Outcome::Rejected,
        Err(AgentsReadFailure::Unavailable | AgentsReadFailure::Protocol) => Outcome::Unavailable,
    }
}

pub(crate) fn files(result: Result<AgentFiles, AgentsReadFailure>) -> Outcome {
    match result {
        Ok(files) => Outcome::Files(files),
        Err(AgentsReadFailure::Rejected) => Outcome::Rejected,
        Err(AgentsReadFailure::Unavailable | AgentsReadFailure::Protocol) => Outcome::Unavailable,
    }
}

pub(crate) fn file(result: Result<AgentFile, AgentsReadFailure>) -> Outcome {
    match result {
        Ok(file) => Outcome::File(file),
        Err(AgentsReadFailure::Rejected) => Outcome::Rejected,
        Err(AgentsReadFailure::Unavailable | AgentsReadFailure::Protocol) => Outcome::Unavailable,
    }
}

pub(crate) fn mutation<T>(
    result: AgentsMutationOutcome<T>,
    applied: impl FnOnce(T) -> Outcome,
) -> Outcome {
    match result {
        AgentsMutationOutcome::Applied(value) => applied(value),
        AgentsMutationOutcome::Rejected => Outcome::Rejected,
        AgentsMutationOutcome::OutcomeUnknown => Outcome::Unknown,
    }
}

pub(crate) fn configuration(
    result: Result<AgentConfigurationDisplay, AgentConfigurationReadFailure>,
) -> Outcome {
    match result {
        Ok(display) => Outcome::Configuration(display),
        Err(AgentConfigurationReadFailure::Rejected) => Outcome::Rejected,
        Err(
            AgentConfigurationReadFailure::Unavailable | AgentConfigurationReadFailure::Protocol,
        ) => Outcome::Unavailable,
    }
}

pub(crate) fn configuration_mutation(result: AgentConfigurationMutationOutcome) -> Outcome {
    match result {
        AgentConfigurationMutationOutcome::Applied => Outcome::ConfigurationApplied,
        AgentConfigurationMutationOutcome::Rejected => Outcome::Rejected,
        AgentConfigurationMutationOutcome::OutcomeUnknown => Outcome::Unknown,
    }
}

pub(crate) fn skill_configuration(result: SkillConfigurationOutcome) -> Outcome {
    Outcome::SkillConfiguration(result)
}

pub(crate) fn tool_configuration(result: ToolConfigurationOutcome) -> Outcome {
    Outcome::ToolConfiguration(result)
}
