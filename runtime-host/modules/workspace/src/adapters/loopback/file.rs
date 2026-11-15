use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::{Deserialize, Deserializer};

use crate::application::commands::WorkspaceFileSelection;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(super) enum FileScope {
    #[serde(rename = "agent")]
    Agent {
        endpoint: Endpoint,
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    #[serde(rename = "team-run")]
    TeamRun {
        endpoint: Endpoint,
        #[serde(rename = "teamId")]
        team_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
}

impl FileScope {
    pub(super) fn matches_input(
        &self,
        endpoint: &Endpoint,
        agent_id: Option<&str>,
        team_id: Option<&str>,
        run_id: Option<&str>,
    ) -> bool {
        if endpoint.runtime_endpoint().is_none() {
            return false;
        }
        match self {
            Self::Agent { endpoint: selected, agent_id: selected_agent } => {
                selected == endpoint && valid_identity(selected_agent)
                    && agent_id == Some(selected_agent.as_str()) && team_id.is_none() && run_id.is_none()
            }
            Self::TeamRun { endpoint: selected, team_id: selected_team, run_id: selected_run } => {
                selected == endpoint && valid_identity(selected_team) && valid_identity(selected_run)
                    && agent_id.is_none() && team_id == Some(selected_team.as_str()) && run_id == Some(selected_run.as_str())
            }
        }
    }

    pub(super) fn selection(&self) -> WorkspaceFileSelection {
        match self {
            Self::Agent { agent_id, .. } => WorkspaceFileSelection::Agent(agent_id.clone()),
            Self::TeamRun { team_id, run_id, .. } => WorkspaceFileSelection::TeamRun {
                team_id: team_id.clone(), run_id: run_id.clone(),
            },
        }
    }
}

pub(super) fn optional_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.as_bytes().contains(&0)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    pub(super) fn runtime_endpoint(&self) -> Option<RuntimeEndpoint> {
        (self.kind == "native-runtime")
            .then(|| RuntimeEndpoint::try_new(&self.runtime_adapter_id, &self.runtime_instance_id).ok())
            .flatten()
    }
}
