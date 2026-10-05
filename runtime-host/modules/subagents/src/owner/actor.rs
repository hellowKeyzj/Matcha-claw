use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    application::commands::{SubagentCommandEnvelope, SubagentOwnerKey, SubagentQuery},
    domain::model::{
        AgentCreate, AgentDelete, CloudPackageMetadata, Command, NativeEndpoint, Outcome,
        WorkspaceInitialization,
    },
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
    results: crate::application::results::MutationResults,
}

pub(crate) struct SubagentGlobalState;
pub(crate) struct SubagentLaneState;

pub(crate) struct SubagentOwner {
    shared: SubagentShared,
}

impl SubagentOwner {
    pub fn new(
        input: SubagentOwnerInput,
        results: crate::application::results::MutationResults,
    ) -> Self {
        Self {
            shared: SubagentShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
                sealed_agents: input.sealed_agents,
                results,
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
            SubagentCommandEnvelope::Execute {
                command,
                call,
                mut detail,
                admission,
                reply,
            } => {
                let outcome = 'execution: {
                    if let Some(call) = &call {
                        let accepted = match &admission {
                            Some(admission) => {
                                admission.get_or_init(|| call.accepted()).await.clone()
                            }
                            None => call.accepted().await,
                        };
                        if let Err(error) = accepted {
                            eprintln!("subagents call-log acceptance: {error}");
                            break 'execution Outcome::Unavailable;
                        }
                        if let Err(error) = call.running().await {
                            eprintln!("subagents call-log running: {error}");
                            break 'execution Outcome::Unavailable;
                        }
                    }
                    execute_subagent(&shared, command).await
                };
                if let Some(call) = &call {
                    if admission.is_some() {
                        shared.results.complete(call.id(), outcome.clone());
                    }
                    let status = detail.finish(&outcome);
                    if let Err(error) = call.finish(status, &detail).await {
                        eprintln!("subagents call-log terminal: {error}");
                    }
                }
                let _ = reply.send(outcome);
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
            let agent_name = match export_agent_name(shared, endpoint, &agent_id).await {
                Ok(name) => name,
                Err(outcome) => return outcome,
            };
            let sealed_agents = Arc::clone(&shared.sealed_agents);
            return match tokio::task::spawn_blocking(move || {
                sealed_agents.export_package(agent_id, agent_name)
            })
            .await
            {
                Ok(result) => sealed_outcome(result, Outcome::PackageExported),
                Err(_) => Outcome::Unavailable,
            };
        }
        Command::ExportCloudPackage {
            endpoint,
            agent_id,
            cloud_public_key,
            cloud_key_id,
        } => {
            if endpoint != NativeEndpoint::OpenClawLocal {
                return Outcome::Unsupported;
            }
            let agent_name = match export_agent_name(shared, endpoint, &agent_id).await {
                Ok(name) => name,
                Err(outcome) => return outcome,
            };
            let sealed_agents = Arc::clone(&shared.sealed_agents);
            return match tokio::task::spawn_blocking(move || {
                sealed_agents.export_cloud_package(
                    agent_id,
                    agent_name,
                    cloud_public_key,
                    cloud_key_id,
                )
            })
            .await
            {
                Ok(result) => sealed_outcome(result, Outcome::PackageExported),
                Err(_) => Outcome::Unavailable,
            };
        }
        Command::InstallPackage {
            endpoint,
            package_path,
            cloud_metadata,
        } => return install_agent_package(shared, endpoint, package_path, cloud_metadata).await,
        Command::Delete { endpoint, input } => {
            let agent_id = input.agent_id.clone();
            let Some(ops) = shared.runtime_directory.subagent_ops(endpoint) else {
                return Outcome::Unsupported;
            };
            if !ops.subagent_runtime_ready() {
                return Outcome::Unavailable;
            }
            let outcome = ops.subagents(Command::Delete { endpoint, input }).await;
            match outcome {
                Outcome::Deleted(mut agent) => {
                    if agent.native_succeeded() {
                        agent.sealed_purge = match shared.sealed_agents.remove_package(agent_id) {
                            Ok(_) | Err(SealedAgentError::NotFound) => {
                                crate::model::SealedPurge::Completed
                            }
                            Err(_) => crate::model::SealedPurge::Failed,
                        };
                    }
                    Outcome::Deleted(agent)
                }
                other => other,
            }
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

async fn export_agent_name(
    shared: &SubagentShared,
    endpoint: NativeEndpoint,
    agent_id: &str,
) -> Result<String, Outcome> {
    let Some(ops) = shared.runtime_directory.subagent_ops(endpoint) else {
        return Err(Outcome::Unsupported);
    };
    if !ops.subagent_runtime_ready() {
        return Err(Outcome::Unavailable);
    }
    let outcome = ops.subagents(Command::List { endpoint }).await;
    let Outcome::Agents { agents, .. } = outcome else {
        return Err(outcome);
    };
    let agent = agents
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or(Outcome::Rejected)?;
    Ok(agent
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(agent_id)
        .to_owned())
}

async fn install_agent_package(
    shared: &SubagentShared,
    endpoint: NativeEndpoint,
    package_path: String,
    cloud_metadata: Option<CloudPackageMetadata>,
) -> Outcome {
    if endpoint != NativeEndpoint::OpenClawLocal {
        return Outcome::Unsupported;
    }
    let Some(ops) = shared.runtime_directory.subagent_ops(endpoint) else {
        return Outcome::Unsupported;
    };
    if !ops.subagent_runtime_ready() {
        return Outcome::Unavailable;
    }
    let plan = match shared
        .sealed_agents
        .prepare_install(package_path.clone(), cloud_metadata.clone())
    {
        Ok(plan) => plan,
        Err(error) => return sealed_error(error),
    };
    let outcome = ops
        .subagents(Command::Create {
            endpoint,
            input: AgentCreate {
                name: plan.agent_id().to_owned(),
                workspace: plan.workspace().to_owned(),
                model: None,
            },
            workspace_initialization: WorkspaceInitialization::EmptyWorkspace,
        })
        .await;
    let Outcome::Created(agent) = outcome else {
        return outcome;
    };
    let result = if agent.agent_id == plan.agent_id() {
        shared
            .sealed_agents
            .install_prepared_package(package_path, cloud_metadata)
    } else {
        Err(SealedAgentError::Rejected)
    };
    match result {
        Ok(receipt) => Outcome::PackageInstalled(receipt),
        Err(error) => {
            let compensation = ops
                .subagents(Command::Delete {
                    endpoint,
                    input: AgentDelete {
                        agent_id: agent.agent_id.clone(),
                        delete_files: !plan.workspace_preexisted(),
                    },
                })
                .await;
            use crate::model::{CompensationOutcome, InstallCompensation, PackageInstallFailure};
            let (outcome, failed_count, purge_failed_count) = match compensation {
                Outcome::Deleted(deleted) => (
                    if deleted.native_succeeded() {
                        CompensationOutcome::Deleted
                    } else {
                        CompensationOutcome::Unavailable
                    },
                    deleted.failed_count,
                    deleted.purge_failed_count,
                ),
                Outcome::Rejected => (CompensationOutcome::Rejected, 0, 0),
                Outcome::Unsupported => (CompensationOutcome::Unsupported, 0, 0),
                Outcome::Unavailable => (CompensationOutcome::Unavailable, 0, 0),
                _ => (CompensationOutcome::OutcomeUnknown, 0, 0),
            };
            Outcome::PackageInstallFailed {
                agent_id: agent.agent_id,
                failure: match error {
                    SealedAgentError::NotFound | SealedAgentError::Rejected => {
                        PackageInstallFailure::Rejected
                    }
                    SealedAgentError::AlreadyExists => PackageInstallFailure::OutcomeUnknown,
                    SealedAgentError::Unknown => PackageInstallFailure::Unavailable,
                },
                compensation: InstallCompensation {
                    outcome,
                    failed_count,
                    purge_failed_count,
                },
            }
        }
    }
}

fn sealed_outcome<T>(
    result: Result<T, SealedAgentError>,
    applied: impl FnOnce(T) -> Outcome,
) -> Outcome {
    match result {
        Ok(value) => applied(value),
        Err(error) => sealed_error(error),
    }
}

fn sealed_error(error: SealedAgentError) -> Outcome {
    match error {
        SealedAgentError::NotFound | SealedAgentError::Rejected => Outcome::Rejected,
        SealedAgentError::AlreadyExists => Outcome::Unknown,
        SealedAgentError::Unknown => Outcome::Unavailable,
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
    let sealed = match sealed_agents.agents_using_sealed_source(&agent_ids) {
        Ok(sealed) => sealed,
        Err(error) => return sealed_error(error),
    };
    for agent in &mut agents {
        agent.sealed = sealed.iter().any(|sealed| sealed == &agent.id);
    }
    Outcome::Agents {
        default_id,
        selection_required,
        agents,
    }
}
