use crate::{
    native_config::agent_configuration::{
        AgentConfiguration, Display as AgentConfigurationDisplay, Model as AgentConfigurationModel,
        MutationOutcome as AgentConfigurationMutationOutcome,
        ReadFailure as AgentConfigurationReadFailure, SkillConfigurationOutcome, SkillSelection,
        ToolCatalog, ToolConfigurationOutcome, ToolSelection,
    },
    port::OpenClawGateway,
};

use super::{
    AgentCreate, AgentCreated, AgentDelete, AgentDeleted, AgentFile, AgentFileName, AgentFiles,
    AgentUpdate, AgentUpdated, AgentWait, AgentsList, AgentsMutationOutcome, AgentsReadFailure,
    AgentsWaitOutcome, OpenClawAgents,
};

impl OpenClawGateway {
    pub async fn list_agents(&self) -> Result<AgentsList, AgentsReadFailure> {
        OpenClawAgents::new(self.client()).list().await
    }

    pub async fn wait_agent(&self, input: AgentWait) -> AgentsWaitOutcome {
        OpenClawAgents::new(self.client()).wait(input).await
    }

    pub async fn list_agent_files(
        &self,
        agent_id: String,
    ) -> Result<AgentFiles, AgentsReadFailure> {
        OpenClawAgents::new(self.client())
            .files_list(agent_id)
            .await
    }

    pub async fn get_agent_file(
        &self,
        agent_id: String,
        name: AgentFileName,
    ) -> Result<AgentFile, AgentsReadFailure> {
        OpenClawAgents::new(self.client())
            .files_get(agent_id, name)
            .await
    }

    pub async fn create_agent(&self, input: AgentCreate) -> AgentsMutationOutcome<AgentCreated> {
        OpenClawAgents::new(self.client()).create(input).await
    }

    pub async fn update_agent(&self, input: AgentUpdate) -> AgentsMutationOutcome<AgentUpdated> {
        OpenClawAgents::new(self.client()).update(input).await
    }

    pub async fn delete_agent(&self, input: AgentDelete) -> AgentsMutationOutcome<AgentDeleted> {
        OpenClawAgents::new(self.client()).delete(input).await
    }

    pub async fn agent_configuration_display(
        &self,
    ) -> Result<AgentConfigurationDisplay, AgentConfigurationReadFailure> {
        AgentConfiguration::new(self.client()).display().await
    }

    pub async fn set_agent_description(
        &self,
        agent_id: String,
        description: Option<String>,
    ) -> AgentConfigurationMutationOutcome {
        AgentConfiguration::new(self.client())
            .set_description(agent_id, description)
            .await
    }

    pub async fn set_agent_configuration_model(
        &self,
        agent_id: String,
        model: Option<AgentConfigurationModel>,
    ) -> AgentConfigurationMutationOutcome {
        AgentConfiguration::new(self.client())
            .set_model(agent_id, model)
            .await
    }

    pub async fn set_agent_skills(
        &self,
        agent_id: String,
        skills: Vec<String>,
    ) -> AgentConfigurationMutationOutcome {
        AgentConfiguration::new(self.client())
            .set_skills(agent_id, skills)
            .await
    }

    pub async fn agent_skill_configuration(
        &self,
        agent_id: String,
        trace_id: Option<String>,
    ) -> SkillConfigurationOutcome {
        AgentConfiguration::with_trace_id(self.client(), trace_id)
            .skill_configuration(agent_id)
            .await
    }

    pub async fn set_agent_skill_configuration(
        &self,
        agent_id: String,
        revision: String,
        selection: SkillSelection,
        trace_id: Option<String>,
    ) -> SkillConfigurationOutcome {
        AgentConfiguration::with_trace_id(self.client(), trace_id)
            .set_skill_configuration(agent_id, revision, selection)
            .await
    }

    pub async fn agent_tool_configuration(
        &self,
        agent_id: String,
        trace_id: Option<String>,
    ) -> ToolConfigurationOutcome {
        AgentConfiguration::with_trace_id(self.client(), trace_id)
            .tool_configuration(agent_id)
            .await
    }

    pub async fn platform_tools_catalog(
        &self,
    ) -> Result<ToolCatalog, AgentConfigurationReadFailure> {
        AgentConfiguration::new(self.client())
            .platform_tools_catalog()
            .await
    }

    pub async fn set_agent_tool_configuration(
        &self,
        agent_id: String,
        revision: String,
        selection: ToolSelection,
        trace_id: Option<String>,
    ) -> ToolConfigurationOutcome {
        AgentConfiguration::with_trace_id(self.client(), trace_id)
            .set_tool_configuration(agent_id, revision, selection)
            .await
    }

    pub async fn set_agent_file(
        &self,
        agent_id: String,
        name: AgentFileName,
        content: String,
    ) -> AgentsMutationOutcome<AgentFile> {
        OpenClawAgents::new(self.client())
            .files_set(agent_id, name, content)
            .await
    }
}
