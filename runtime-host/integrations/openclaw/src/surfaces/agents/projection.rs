use crate::native_config::agent_configuration as native_agent_configuration;

use subagents as agents;

pub(crate) fn native_wait(input: agents::AgentWait) -> Result<super::AgentWait, ()> {
    super::AgentWait::try_new(
        input.run_id,
        input.wait_slice_ms,
        input.rpc_timeout_buffer_ms,
    )
    .map_err(|_| ())
}

pub(crate) fn native_create(input: agents::AgentCreate) -> Result<super::AgentCreate, ()> {
    super::AgentCreate::try_new(input.name, input.workspace, input.model).map_err(|_| ())
}

pub(crate) fn native_update(input: agents::AgentUpdate) -> Result<super::AgentUpdate, ()> {
    super::AgentUpdate::try_new_with_display(
        input.agent_id,
        input.name,
        input.workspace,
        native_model_update(input.model),
        None,
        None,
    )
    .map_err(|_| ())
}

pub(crate) fn native_model_update(input: agents::AgentModelUpdate) -> super::AgentModelUpdate {
    match input {
        agents::AgentModelUpdate::Unchanged => super::AgentModelUpdate::Unchanged,
        agents::AgentModelUpdate::Set(model) => super::AgentModelUpdate::Set(model),
    }
}

pub(crate) fn native_delete(input: agents::AgentDelete) -> Result<super::AgentDelete, ()> {
    super::AgentDelete::try_new(input.agent_id, input.delete_files).map_err(|_| ())
}

pub(crate) const fn native_file_name(name: agents::AgentFileName) -> super::AgentFileName {
    match name {
        agents::AgentFileName::Agents => super::AgentFileName::Agents,
        agents::AgentFileName::Soul => super::AgentFileName::Soul,
        agents::AgentFileName::User => super::AgentFileName::User,
        agents::AgentFileName::Memory => super::AgentFileName::Memory,
    }
}

pub(crate) const fn host_file_name(name: super::AgentFileName) -> agents::AgentFileName {
    match name {
        super::AgentFileName::Agents => agents::AgentFileName::Agents,
        super::AgentFileName::Soul => agents::AgentFileName::Soul,
        super::AgentFileName::User => agents::AgentFileName::User,
        super::AgentFileName::Memory => agents::AgentFileName::Memory,
    }
}

pub(crate) fn agents_read(
    result: Result<super::AgentsList, super::AgentsReadFailure>,
) -> agents::Outcome {
    match result {
        Ok(list) => agents::Outcome::Agents {
            default_id: list.default_id,
            selection_required: list.selection_required,
            agents: list.agents.into_iter().map(agent_summary).collect(),
        },
        Err(super::AgentsReadFailure::Rejected) => agents::Outcome::Rejected,
        Err(super::AgentsReadFailure::Unavailable | super::AgentsReadFailure::Protocol) => {
            agents::Outcome::Unavailable
        }
    }
}

pub(crate) fn agents_files(
    result: Result<super::AgentFiles, super::AgentsReadFailure>,
) -> agents::Outcome {
    match result {
        Ok(files) => agents::Outcome::Files(agent_files(files)),
        Err(super::AgentsReadFailure::Rejected) => agents::Outcome::Rejected,
        Err(super::AgentsReadFailure::Unavailable | super::AgentsReadFailure::Protocol) => {
            agents::Outcome::Unavailable
        }
    }
}

pub(crate) fn agents_file(
    result: Result<super::AgentFile, super::AgentsReadFailure>,
) -> agents::Outcome {
    match result {
        Ok(file) => agents::Outcome::File(agent_file(file)),
        Err(super::AgentsReadFailure::Rejected) => agents::Outcome::Rejected,
        Err(super::AgentsReadFailure::Unavailable | super::AgentsReadFailure::Protocol) => {
            agents::Outcome::Unavailable
        }
    }
}

pub(crate) fn agents_wait(result: super::AgentsWaitOutcome) -> agents::Outcome {
    match result {
        super::AgentsWaitOutcome::Observed(wait) => agents::Outcome::Waited(agent_wait(wait)),
        super::AgentsWaitOutcome::Rejected => agents::Outcome::Rejected,
        super::AgentsWaitOutcome::OutcomeUnknown => agents::Outcome::WaitUnknown,
    }
}

pub(crate) fn agents_mutation<T>(
    result: super::AgentsMutationOutcome<T>,
    applied: impl FnOnce(T) -> agents::Outcome,
) -> agents::Outcome {
    match result {
        super::AgentsMutationOutcome::Applied(value) => applied(value),
        super::AgentsMutationOutcome::Rejected => agents::Outcome::Rejected,
        super::AgentsMutationOutcome::OutcomeUnknown => agents::Outcome::Unknown,
    }
}

pub(crate) fn agent_summary(agent: super::AgentSummary) -> agents::AgentSummary {
    agents::AgentSummary {
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace,
        model: agent.model,
        kind: match agent.kind {
            super::AgentKind::System => agents::AgentKind::System,
            super::AgentKind::Agent => agents::AgentKind::Agent,
        },
        sealed: agent.sealed,
    }
}

pub(crate) fn agent_created(agent: super::AgentCreated) -> agents::AgentCreated {
    agents::AgentCreated {
        agent_id: agent.agent_id,
        name: agent.name,
        model: agent.model,
    }
}

pub(crate) fn agent_updated(agent: super::AgentUpdated) -> agents::AgentUpdated {
    agents::AgentUpdated {
        agent_id: agent.agent_id,
    }
}

pub(crate) fn agent_deleted(agent: super::AgentDeleted) -> agents::AgentDeleted {
    agents::AgentDeleted {
        agent_id: agent.agent_id,
    }
}

pub(crate) fn agent_files(files: super::AgentFiles) -> agents::AgentFiles {
    agents::AgentFiles {
        files: files.files.into_iter().map(agent_file).collect(),
    }
}

pub(crate) fn agent_file(file: super::AgentFile) -> agents::AgentFile {
    agents::AgentFile {
        name: host_file_name(file.name),
        missing: file.missing,
        size: file.size,
        updated_at_ms: file.updated_at_ms,
        content: file.content,
    }
}

pub(crate) fn agent_wait(wait: super::AgentWaitResult) -> agents::AgentWaitResult {
    agents::AgentWaitResult {
        status: match wait.status {
            super::AgentWaitStatus::Completed => agents::AgentWaitStatus::Completed,
            super::AgentWaitStatus::Failed => agents::AgentWaitStatus::Failed,
            super::AgentWaitStatus::Timeout => agents::AgentWaitStatus::Timeout,
            super::AgentWaitStatus::Pending => agents::AgentWaitStatus::Pending,
        },
        started_at: wait.started_at,
        ended_at: wait.ended_at,
    }
}

pub(crate) fn configuration_display(
    display: native_agent_configuration::Display,
) -> agents::ConfigurationDisplay {
    agents::ConfigurationDisplay {
        defaults: agents::ConfigurationDefaults {
            model: display.defaults().model().map(configuration_model),
            skills: display.defaults().skills().to_vec(),
        },
        agents: display.agents().iter().map(configuration_agent).collect(),
    }
}

pub(crate) fn configuration_agent(
    agent: &native_agent_configuration::DisplayAgent,
) -> agents::ConfigurationAgent {
    agents::ConfigurationAgent {
        id: agent.id().to_owned(),
        description: agent.description().map(str::to_owned),
        model: agent.model().map(configuration_model),
        skills: agent.skills().map(<[_]>::to_vec),
    }
}

pub(crate) fn configuration_model(
    model: &native_agent_configuration::Model,
) -> agents::ConfigurationModel {
    agents::ConfigurationModel {
        primary: model.primary().map(str::to_owned),
        fallbacks: model.fallbacks().to_vec(),
    }
}

pub(crate) fn native_configuration_model(
    model: agents::ConfigurationModel,
) -> Result<native_agent_configuration::Model, ()> {
    native_agent_configuration::Model::try_new(model.primary, model.fallbacks).map_err(|_| ())
}

pub(crate) const fn configuration_read_failure(
    failure: native_agent_configuration::ReadFailure,
) -> agents::ConfigurationReadFailure {
    match failure {
        native_agent_configuration::ReadFailure::Unavailable => {
            agents::ConfigurationReadFailure::Unavailable
        }
        native_agent_configuration::ReadFailure::Rejected => {
            agents::ConfigurationReadFailure::Rejected
        }
        native_agent_configuration::ReadFailure::Protocol => {
            agents::ConfigurationReadFailure::Protocol
        }
    }
}

pub(crate) const fn configuration_mutation(
    outcome: native_agent_configuration::MutationOutcome,
) -> agents::ConfigurationMutationOutcome {
    match outcome {
        native_agent_configuration::MutationOutcome::Applied => {
            agents::ConfigurationMutationOutcome::Applied
        }
        native_agent_configuration::MutationOutcome::Rejected => {
            agents::ConfigurationMutationOutcome::Rejected
        }
        native_agent_configuration::MutationOutcome::OutcomeUnknown => {
            agents::ConfigurationMutationOutcome::OutcomeUnknown
        }
    }
}

pub(crate) fn native_skill_selection(
    selection: agents::SkillSelection,
) -> native_agent_configuration::SkillSelection {
    match selection {
        agents::SkillSelection::InheritDefaultSkills => {
            native_agent_configuration::SkillSelection::InheritDefaultSkills
        }
        agents::SkillSelection::ExplicitSkillAllowlist(skills) => {
            native_agent_configuration::SkillSelection::ExplicitSkillAllowlist(skills)
        }
    }
}

pub(crate) fn native_tool_selection(
    selection: agents::ToolSelection,
) -> native_agent_configuration::ToolSelection {
    match selection {
        agents::ToolSelection::InheritDefaultTools => {
            native_agent_configuration::ToolSelection::InheritDefaultTools
        }
        agents::ToolSelection::Policy {
            profile,
            allow,
            deny,
        } => native_agent_configuration::ToolSelection::Policy {
            profile,
            allow,
            deny,
        },
    }
}

pub(crate) fn skill_configuration_outcome(
    outcome: native_agent_configuration::SkillConfigurationOutcome,
) -> agents::SkillConfigurationOutcome {
    match outcome {
        native_agent_configuration::SkillConfigurationOutcome::View(view) => {
            agents::SkillConfigurationOutcome::View(skill_configuration_view(view))
        }
        native_agent_configuration::SkillConfigurationOutcome::Updated(view) => {
            agents::SkillConfigurationOutcome::Updated(skill_configuration_view(view))
        }
        native_agent_configuration::SkillConfigurationOutcome::Stale(view) => {
            agents::SkillConfigurationOutcome::Stale(skill_configuration_view(view))
        }
        native_agent_configuration::SkillConfigurationOutcome::InvalidSkillKeys {
            unknown_skill_keys,
            non_canonical_skill_keys,
        } => agents::SkillConfigurationOutcome::InvalidSkillKeys {
            unknown_skill_keys,
            non_canonical_skill_keys,
        },
        native_agent_configuration::SkillConfigurationOutcome::Unsupported => {
            agents::SkillConfigurationOutcome::Unsupported
        }
        native_agent_configuration::SkillConfigurationOutcome::Rejected => {
            agents::SkillConfigurationOutcome::Rejected
        }
        native_agent_configuration::SkillConfigurationOutcome::OutcomeUnknown => {
            agents::SkillConfigurationOutcome::OutcomeUnknown
        }
        native_agent_configuration::SkillConfigurationOutcome::Unavailable(failure) => {
            agents::SkillConfigurationOutcome::Unavailable(configuration_read_failure(failure))
        }
    }
}

pub(crate) fn skill_configuration_view(
    view: native_agent_configuration::SkillConfigurationView,
) -> agents::SkillConfigurationView {
    agents::SkillConfigurationView {
        agent_id: view.agent_id().to_owned(),
        configured: view.configured(),
        has_explicit_skill_allowlist: view.has_explicit_skill_allowlist(),
        explicit_skill_keys: view.explicit_skill_keys().to_vec(),
        inherited_default_skill_keys: view.inherited_default_skill_keys().to_vec(),
        effective_skill_keys: view.effective_skill_keys().to_vec(),
        options: view.options().iter().map(skill_option).collect(),
        revision: view.revision().to_owned(),
    }
}

pub(crate) fn skill_option(
    option: &native_agent_configuration::SkillOption,
) -> agents::SkillOption {
    agents::SkillOption {
        key: option.key().to_owned(),
        display_name: option.display_name().to_owned(),
        description: option.description().to_owned(),
        selectable: option.selectable(),
        unavailable_reason: option.unavailable_reason().map(skill_unavailable_reason),
        missing_requirements: option
            .missing_requirements()
            .map(missing_skill_requirements),
    }
}

pub(crate) const fn skill_unavailable_reason(
    reason: native_agent_configuration::SkillUnavailableReason,
) -> agents::SkillUnavailableReason {
    match reason {
        native_agent_configuration::SkillUnavailableReason::GlobalSkillDisabled => {
            agents::SkillUnavailableReason::GlobalSkillDisabled
        }
        native_agent_configuration::SkillUnavailableReason::BlockedByRuntimeAllowlist => {
            agents::SkillUnavailableReason::BlockedByRuntimeAllowlist
        }
        native_agent_configuration::SkillUnavailableReason::MissingRequirements => {
            agents::SkillUnavailableReason::MissingRequirements
        }
    }
}

pub(crate) fn missing_skill_requirements(
    requirements: &native_agent_configuration::MissingSkillRequirements,
) -> agents::MissingSkillRequirements {
    agents::MissingSkillRequirements {
        bins: requirements.bins().to_vec(),
        any_bins: requirements.any_bins().to_vec(),
        env: requirements.env().to_vec(),
        config: requirements.config().to_vec(),
        os: requirements.os().to_vec(),
    }
}

pub(crate) fn tool_configuration_outcome(
    outcome: native_agent_configuration::ToolConfigurationOutcome,
) -> agents::ToolConfigurationOutcome {
    match outcome {
        native_agent_configuration::ToolConfigurationOutcome::View(view) => {
            agents::ToolConfigurationOutcome::View(tool_configuration_view(view))
        }
        native_agent_configuration::ToolConfigurationOutcome::Updated(view) => {
            agents::ToolConfigurationOutcome::Updated(tool_configuration_view(view))
        }
        native_agent_configuration::ToolConfigurationOutcome::Stale(view) => {
            agents::ToolConfigurationOutcome::Stale(tool_configuration_view(view))
        }
        native_agent_configuration::ToolConfigurationOutcome::InvalidToolKeys(keys) => {
            agents::ToolConfigurationOutcome::InvalidToolKeys(keys)
        }
        native_agent_configuration::ToolConfigurationOutcome::Unsupported => {
            agents::ToolConfigurationOutcome::Unsupported
        }
        native_agent_configuration::ToolConfigurationOutcome::Rejected => {
            agents::ToolConfigurationOutcome::Rejected
        }
        native_agent_configuration::ToolConfigurationOutcome::OutcomeUnknown => {
            agents::ToolConfigurationOutcome::OutcomeUnknown
        }
        native_agent_configuration::ToolConfigurationOutcome::Unavailable(failure) => {
            agents::ToolConfigurationOutcome::Unavailable(configuration_read_failure(failure))
        }
    }
}

pub(crate) fn tool_configuration_view(
    view: native_agent_configuration::ToolConfigurationView,
) -> agents::ToolConfigurationView {
    agents::ToolConfigurationView {
        agent_id: view.agent_id().to_owned(),
        configured: view.configured(),
        policy: view.policy().map(tool_policy),
        catalog: tool_catalog(view.catalog()),
        revision: view.revision().to_owned(),
    }
}

pub(crate) fn tool_policy(policy: &native_agent_configuration::ToolPolicy) -> agents::ToolPolicy {
    agents::ToolPolicy {
        profile: policy.profile().to_owned(),
        allow: policy.allow().to_vec(),
        deny: policy.deny().to_vec(),
    }
}

pub(crate) fn tool_catalog(
    catalog: &native_agent_configuration::ToolCatalog,
) -> agents::ToolCatalog {
    agents::ToolCatalog {
        profiles: catalog.profiles().iter().map(tool_profile).collect(),
        groups: catalog.groups().iter().map(tool_group).collect(),
        options: catalog.options().iter().map(tool_option).collect(),
    }
}

pub(crate) fn tool_profile(
    profile: &native_agent_configuration::ToolProfile,
) -> agents::ToolProfile {
    agents::ToolProfile {
        key: profile.key().to_owned(),
        display_name: profile.display_name().to_owned(),
    }
}

pub(crate) fn tool_group(group: &native_agent_configuration::ToolGroup) -> agents::ToolGroup {
    agents::ToolGroup {
        key: group.key().to_owned(),
        display_name: group.display_name().to_owned(),
        source: group.source().to_owned(),
        plugin_id: group.plugin_id().map(str::to_owned),
        tools: group.tools().iter().map(tool_option).collect(),
    }
}

pub(crate) fn tool_option(option: &native_agent_configuration::ToolOption) -> agents::ToolOption {
    agents::ToolOption {
        key: option.key().to_owned(),
        display_name: option.display_name().to_owned(),
        description: option.description().map(str::to_owned),
        source: option.source().to_owned(),
        plugin_id: option.plugin_id().map(str::to_owned),
        optional: option.optional(),
        risk: option.risk().map(str::to_owned),
        tags: option.tags().to_vec(),
        default_profiles: option.default_profiles().to_vec(),
        group_key: option.group_key().map(str::to_owned),
        group_display_name: option.group_display_name().map(str::to_owned),
    }
}
