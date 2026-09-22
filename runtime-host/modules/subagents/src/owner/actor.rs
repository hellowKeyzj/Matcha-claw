use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    application::commands::{SubagentCommandEnvelope, SubagentOwnerKey, SubagentQuery},
    domain::model::{Command, NativeEndpoint, Outcome},
    ports::{
        SealedAgentError, SealedAgentStorePort, SubagentRequestAdmission, SubagentRuntimeDirectory,
    },
};

pub struct SubagentOwnerInput {
    pub admission: Arc<dyn SubagentRequestAdmission>,
    pub runtime_directory: Arc<dyn SubagentRuntimeDirectory>,
    pub sealed_agents: Arc<dyn SealedAgentStorePort>,
}

#[derive(Clone)]
pub(crate) struct SubagentShared {
    admission: Arc<dyn SubagentRequestAdmission>,
    runtime_directory: Arc<dyn SubagentRuntimeDirectory>,
    sealed_agents: Arc<dyn SealedAgentStorePort>,
}

pub(crate) struct SubagentGlobalState;
pub(crate) struct SubagentLaneState;

pub(crate) struct SubagentOwner {
    shared: SubagentShared,
}

impl SubagentOwner {
    pub fn new(input: SubagentOwnerInput) -> Self {
        Self {
            shared: SubagentShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
                sealed_agents: input.sealed_agents,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for SubagentOwner {
    type Command = SubagentCommandEnvelope;
    type Query = SubagentQuery;
    type Key = SubagentOwnerKey;
    type Shared = SubagentShared;
    type GlobalState = SubagentGlobalState;
    type LaneState = SubagentLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, SubagentGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        SubagentLaneState
    }

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            SubagentCommandEnvelope::Execute { command, reply } => {
                let _ = reply.send(execute_subagent(&shared, command).await);
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, global, query).await;
    }
}

async fn execute_subagent(shared: &SubagentShared, command: Command) -> Outcome {
    if shared.admission.admit_subagent_request().is_err() {
        return Outcome::Unavailable;
    }
    match command {
        Command::ExportPackage { endpoint, agent_id } => {
            if endpoint != NativeEndpoint::OpenClawLocal {
                return Outcome::Unsupported;
            }
            return sealed_outcome(
                shared.sealed_agents.export_package(agent_id),
                Outcome::PackageExported,
            );
        }
        Command::InstallPackage {
            endpoint,
            package_path,
        } => {
            if endpoint != NativeEndpoint::OpenClawLocal {
                return Outcome::Unsupported;
            }
            return sealed_outcome(
                shared.sealed_agents.install_package(package_path),
                Outcome::PackageInstalled,
            );
        }
        command => {
            let Some(ops) = shared.runtime_directory.subagent_ops(command.endpoint()) else {
                return Outcome::Unsupported;
            };
            if !ops.subagent_runtime_ready() {
                return Outcome::Unavailable;
            }
            let outcome = ops.subagents(command).await;
            project_sealed_state(&*shared.sealed_agents, outcome)
        }
    }
}

fn sealed_outcome<T>(
    result: Result<T, SealedAgentError>,
    applied: impl FnOnce(T) -> Outcome,
) -> Outcome {
    match result {
        Ok(value) => applied(value),
        Err(SealedAgentError::NotFound | SealedAgentError::Rejected) => Outcome::Rejected,
        Err(SealedAgentError::AlreadyExists) => Outcome::Unknown,
        Err(SealedAgentError::Unknown) => Outcome::Unavailable,
    }
}

fn project_sealed_state(sealed_agents: &dyn SealedAgentStorePort, outcome: Outcome) -> Outcome {
    let Outcome::Agents {
        default_id,
        selection_required,
        mut agents,
    } = outcome
    else {
        return outcome;
    };
    let agent_ids = agents
        .iter()
        .map(|agent| agent.id.clone())
        .collect::<Vec<_>>();
    let sealed = sealed_agents
        .contains_agents(&agent_ids)
        .unwrap_or_default();
    for agent in &mut agents {
        agent.sealed = sealed.iter().any(|sealed| sealed == &agent.id);
    }
    Outcome::Agents {
        default_id,
        selection_required,
        agents,
    }
}
