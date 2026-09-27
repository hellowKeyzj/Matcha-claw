use serde::Serialize;
use serde_json::Value;

use crate::domain::model as agents;

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
        "deniedByGlobalPolicy": option.denied_by_global_policy(),
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

fn package_export(package: agents::PackageExportReceipt) -> PackageExportResponse {
    PackageExportResponse {
        agent_id: package.agent_id().to_owned(),
        file_name: package.file_name().to_owned(),
        size: package.size(),
        exported_at_ms: package.exported_at_ms(),
    }
}

fn package_install(package: agents::PackageInstallReceipt) -> PackageInstallResponse {
    PackageInstallResponse {
        agent_id: package.agent_id().to_owned(),
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
    use serde_json::json;

    use super::*;

    #[test]
    fn projects_agent_list_with_public_kind_and_selection_requirement() {
        let body = map_outcome(agents::Outcome::Agents {
            default_id: "main".into(),
            selection_required: true,
            agents: vec![
                agents::AgentSummary {
                    id: "main".into(),
                    name: Some("Main".into()),
                    workspace: Some("C:/workspace/main".into()),
                    model: Some("provider/model".into()),
                    kind: agents::AgentKind::Agent,
                    sealed: false,
                },
                agents::AgentSummary {
                    id: "system".into(),
                    name: None,
                    workspace: None,
                    model: None,
                    kind: agents::AgentKind::System,
                    sealed: true,
                },
            ],
        })
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
        let delivery = map_outcome(agents::Outcome::File(agents::AgentFile {
            name: agents::AgentFileName::Agents,
            missing: false,
            size: Some(0),
            updated_at_ms: Some(1),
            content: Some(String::new()),
        }));
        let rendered = delivery.body().to_string();
        assert!(!rendered.contains("workspace"));
        assert!(!rendered.contains("path"));
    }

    #[test]
    fn configuration_projection_omits_private_workspace() {
        let rendered = map_outcome(agents::Outcome::Configuration(
            agents::ConfigurationDisplay {
                defaults: agents::ConfigurationDefaults {
                    model: None,
                    skills: vec!["research".into()],
                },
                agents: vec![agents::ConfigurationAgent {
                    id: "writer".into(),
                    description: Some("Writes copy".into()),
                    model: None,
                    skills: Some(vec![]),
                }],
            },
        ))
        .body()
        .to_string();
        assert!(!rendered.contains("workspace"));
        assert!(!rendered.contains("path"));
        assert!(!rendered.contains("hash"));
    }

    #[test]
    fn mutation_outcome_unknown_is_distinct_and_non_success() {
        let delivery = map_outcome(agents::Outcome::Unknown);
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
        let rejected = map_outcome(agents::Outcome::SkillConfiguration(
            agents::SkillConfigurationOutcome::Rejected,
        ));
        assert_eq!(rejected.status_code(), 422);
        assert_eq!(
            rejected.body(),
            json!({ "success": false, "error": "Subagent request was rejected" })
        );

        let unknown = map_outcome(agents::Outcome::ToolConfiguration(
            agents::ToolConfigurationOutcome::OutcomeUnknown,
        ));
        assert_eq!(unknown.status_code(), 409);
        assert_eq!(
            unknown.body(),
            json!({ "success": false, "error": "Subagent mutation outcome is unknown" })
        );
    }
}
