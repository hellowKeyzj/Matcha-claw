use std::path::PathBuf;

use crate::driver::OpenClawDriver;

use super::projection::{
    agent_created, agent_deleted, agent_file, agent_updated, agents_file, agents_files,
    agents_mutation, agents_read, configuration_display, configuration_mutation,
    configuration_read_failure, native_configuration_model, native_create, native_delete,
    native_file_name, native_skill_selection, native_tool_selection, native_update,
    skill_configuration_outcome, tool_configuration_outcome,
};
use subagents as agents;

impl OpenClawDriver {
    pub(crate) async fn agents(&self, command: agents::Command) -> agents::Outcome {
        use agents::{Command, NativeEndpoint, Outcome, WorkspaceInitialization};

        const MAIN_AGENT_ID: &str = "main";

        if command.endpoint() == NativeEndpoint::MatchaAgentLocal {
            return Outcome::Unsupported;
        }
        match command {
            Command::List { .. } => {
                let result = self
                    .gateway
                    .lock()
                    .await
                    .list_agents()
                    .await
                    .map(|mut list| {
                        // Matcha's default/system identity does not change OpenClaw's native default.
                        if let Some(agent) = list
                            .agents
                            .iter_mut()
                            .find(|agent| agent.id == MAIN_AGENT_ID)
                        {
                            agent.kind = super::AgentKind::System;
                            list.default_id = MAIN_AGENT_ID.to_owned();
                            list.selection_required = false;
                        }
                        list
                    });
                agents_read(result)
            }
            Command::Create {
                input,
                workspace_initialization,
                ..
            } => {
                let workspace = input.workspace.clone();
                let Ok(input) = native_create(input) else {
                    return Outcome::Rejected;
                };
                let result = self.gateway.lock().await.create_agent(input).await;
                match result {
                    super::AgentsMutationOutcome::Applied(agent) => {
                        if workspace_initialization == WorkspaceInitialization::MainAgentTemplate
                            && crate::native_config::workspace::AgentWorkspaceDirectory::try_new(
                                PathBuf::from(workspace),
                            )
                            .and_then(|workspace| {
                                crate::native_config::workspace::MatchaWorkspaceOverlay::seed_main_agent_templates(
                                    workspace,
                                    self.matcha_workspace_templates.clone(),
                                )
                            })
                            .is_err()
                        {
                            Outcome::WorkspaceInitializationFailed(agent_created(agent))
                        } else {
                            Outcome::Created(agent_created(agent))
                        }
                    }
                    other => agents_mutation(other, |agent| Outcome::Created(agent_created(agent))),
                }
            }
            Command::Update { input, .. } => {
                let Ok(input) = native_update(input) else {
                    return Outcome::Rejected;
                };
                agents_mutation(
                    self.gateway.lock().await.update_agent(input).await,
                    |agent| Outcome::Updated(agent_updated(agent)),
                )
            }
            Command::Delete { ref input, .. }
                if input.agent_id.trim().eq_ignore_ascii_case(MAIN_AGENT_ID) =>
            {
                Outcome::Rejected
            }
            Command::Delete { input, .. } => {
                let Ok(input) = native_delete(input) else {
                    return Outcome::Rejected;
                };
                agents_mutation(
                    self.gateway.lock().await.delete_agent(input).await,
                    |agent| Outcome::Deleted(agent_deleted(agent)),
                )
            }
            Command::ListFiles { agent_id, .. } => {
                agents_files(self.gateway.lock().await.list_agent_files(agent_id).await)
            }
            Command::GetFile { agent_id, name, .. } => {
                let name = native_file_name(name);
                agents_file(
                    self.gateway
                        .lock()
                        .await
                        .get_agent_file(agent_id, name)
                        .await,
                )
            }
            Command::SetFile {
                agent_id,
                name,
                content,
                ..
            } => {
                let name = native_file_name(name);
                agents_mutation(
                    self.gateway
                        .lock()
                        .await
                        .set_agent_file(agent_id, name, content)
                        .await,
                    |file| Outcome::File(agent_file(file)),
                )
            }
            Command::DisplayConfiguration { .. } => agents::configuration(
                self.gateway
                    .lock()
                    .await
                    .agent_configuration_display()
                    .await
                    .map(configuration_display)
                    .map_err(configuration_read_failure),
            ),
            Command::SetDescription {
                agent_id,
                description,
                ..
            } => agents::configuration_mutation(configuration_mutation(
                self.gateway
                    .lock()
                    .await
                    .set_agent_description(agent_id, description)
                    .await,
            )),
            Command::SetConfigurationModel {
                agent_id, model, ..
            } => {
                let model = match model.map(native_configuration_model).transpose() {
                    Ok(model) => model,
                    Err(()) => return Outcome::Rejected,
                };
                agents::configuration_mutation(configuration_mutation(
                    self.gateway
                        .lock()
                        .await
                        .set_agent_configuration_model(agent_id, model)
                        .await,
                ))
            }
            Command::SetSkills {
                agent_id, skills, ..
            } => match self.gateway.lock().await.set_agent_skills(agent_id, skills).await {
                Ok(outcome) => agents::configuration_mutation(configuration_mutation(outcome)),
                Err((unknown_skill_keys, non_canonical_skill_keys)) => Outcome::SkillConfiguration(
                    agents::SkillConfigurationOutcome::InvalidSkillKeys { unknown_skill_keys, non_canonical_skill_keys },
                ),
            },
            Command::SkillConfiguration {
                agent_id, trace_id, ..
            } => Outcome::SkillConfiguration(skill_configuration_outcome(
                self.gateway
                    .lock()
                    .await
                    .agent_skill_configuration(agent_id, trace_id)
                    .await,
            )),
            Command::SetSkillConfiguration {
                agent_id,
                revision,
                selection,
                trace_id,
                ..
            } => Outcome::SkillConfiguration(skill_configuration_outcome(
                self.gateway
                    .lock()
                    .await
                    .set_agent_skill_configuration(
                        agent_id,
                        revision,
                        native_skill_selection(selection),
                        trace_id,
                    )
                    .await,
            )),
            Command::ToolConfiguration {
                agent_id, trace_id, ..
            } => Outcome::ToolConfiguration(tool_configuration_outcome(
                self.gateway
                    .lock()
                    .await
                    .agent_tool_configuration(agent_id, trace_id)
                    .await,
            )),
            Command::SetToolConfiguration {
                agent_id,
                revision,
                selection,
                trace_id,
                ..
            } => Outcome::ToolConfiguration(tool_configuration_outcome(
                self.gateway
                    .lock()
                    .await
                    .set_agent_tool_configuration(
                        agent_id,
                        revision,
                        native_tool_selection(selection),
                        trace_id,
                    )
                    .await,
            )),
            Command::ExportPackage { .. }
            | Command::ExportCloudPackage { .. }
            | Command::InstallPackage { .. } => Outcome::Unsupported,
        }
    }
}

impl subagents::SubagentOps for OpenClawDriver {
    fn subagents<'a>(
        &'a self,
        command: agents::Command,
    ) -> agents::SubagentFuture<'a, agents::Outcome> {
        Box::pin(self.agents(command))
    }

    fn subagent_runtime_ready(&self) -> bool {
        self.owner().snapshot().phase()
            == foundation::process::supervision::SupervisorPhase::Running
    }
}
