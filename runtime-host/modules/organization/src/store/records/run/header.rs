use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, num::NonZeroU64};

use super::{decode, record};
use crate::{
    EndpointSessionId, GraphRunFacts, GraphRunId, ManagedAgentReference, RoleId,
    RoleSessionReceipt, RoleSessionRef, RunRuntimeReceipt, RuntimeEndpointReference, TeamId,
    TeamRevision,
    run::lifecycle::{GraphRunLifecycle, GraphRunLifecycleState},
    store::{
        RunStartGate, StoreFault,
        schema::{RecordKind, StoredRecord},
    },
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    revision: u64,
    runtime: Option<Vec<Binding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace: Option<Workspace>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    role_session_intents: std::collections::BTreeMap<String, SessionIntent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    deletion_confirmations: Vec<Binding>,
    execution_control: ExecutionControl,
    creation_key: String,
    lifecycle: Lifecycle,
    gate: Gate,
    #[serde(default)]
    retired_executions: Vec<(String, String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_execution_context: Option<crate::TaskExecutionContext>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionControl {
    next_batch_id: u64,
    rework_counts: Vec<ReworkCounter>,
    blocked_reworks: Vec<BlockedRework>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReworkCounter {
    batch_id: u64,
    source_node_id: String,
    source_port: String,
    used: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BlockedRework {
    batch_id: u64,
    source_node_id: String,
    source_port: String,
    source_fence: super::attempt::Fence,
    scope: Vec<String>,
    edge_ids: Vec<String>,
    used: u32,
    max_reworks: u32,
    blocked_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    team: String,
    run: String,
    role: String,
    session: String,
    endpoint_session: String,
    agent: String,
    endpoint: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Workspace {
    root: std::path::PathBuf,
    prepared: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionIntent {
    binding: Binding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    submission_uncertain: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    phase: Option<SessionPhase>,
}

#[derive(Serialize, Deserialize)]
enum SessionPhase {
    Reserved,
    SubmissionUncertain,
    Confirmed,
}

fn encode_binding(binding: &RoleSessionReceipt) -> Binding {
    Binding {
        team: binding.team().as_str().to_owned(),
        run: binding.team_run().as_str().to_owned(),
        role: binding.role().as_str().to_owned(),
        session: binding.session_ref().as_str().to_owned(),
        endpoint_session: binding.endpoint_session_id().as_str().to_owned(),
        agent: binding.agent().as_str().to_owned(),
        endpoint: binding.endpoint().as_str().to_owned(),
    }
}

fn decode_binding(binding: Binding) -> Result<RoleSessionReceipt, StoreFault> {
    Ok(RoleSessionReceipt::with_endpoint_session_id(
        TeamId::try_new(binding.team).map_err(|_| StoreFault::InvalidFacts)?,
        GraphRunId::new(binding.run),
        RoleId::try_new(binding.role).map_err(|_| StoreFault::InvalidFacts)?,
        RoleSessionRef::try_new(binding.session).map_err(|_| StoreFault::InvalidFacts)?,
        EndpointSessionId::try_new(binding.endpoint_session).map_err(|_| StoreFault::InvalidFacts)?,
        ManagedAgentReference::try_new(binding.agent).map_err(|_| StoreFault::InvalidFacts)?,
        RuntimeEndpointReference::try_new(binding.endpoint).map_err(|_| StoreFault::InvalidFacts)?,
    ))
}

#[derive(Serialize, Deserialize)]
enum Lifecycle {
    Active,
    Cancelling(String, u64),
    Cancelled(String, u64),
    OutcomeUnknown(String, u64),
    Tombstoned(String, u64),
}

#[derive(Serialize, Deserialize)]
enum Gate {
    Intake,
    Designing(String, Option<String>),
    Started,
}

pub(crate) struct RunHeader {
    pub(crate) team: TeamId,
    pub(crate) run: GraphRunId,
    pub(crate) revision: TeamRevision,
    pub(crate) runtime: Option<RunRuntimeReceipt>,
    pub(crate) workspace: Option<crate::RunWorkspace>,
    pub(crate) role_session_intents: std::collections::BTreeMap<String, crate::store::RoleSessionIntent>,
    pub(crate) deletion_confirmations: Vec<crate::RoleSessionDeletionConfirmation>,
    pub(crate) lifecycle: GraphRunLifecycle,
    pub(crate) gate: RunStartGate,
    pub(crate) retired_executions:
        std::collections::BTreeSet<(crate::NodeId, crate::ExecutionFence)>,
    pub(crate) task_execution_context: Option<crate::TaskExecutionContext>,
    pub(crate) next_batch_id: NonZeroU64,
    pub(crate) rework_counts: BTreeMap<crate::run::graph::ReworkCounterKey, u32>,
    pub(crate) blocked_reworks: BTreeMap<crate::NodeId, crate::run::graph::BlockedRework>,
}

pub(crate) fn encode_header(run: &GraphRunFacts) -> Result<StoredRecord, StoreFault> {
    let lifecycle = match run.lifecycle().state() {
        GraphRunLifecycleState::Active => Lifecycle::Active,
        GraphRunLifecycleState::Cancelling {
            idempotency_key,
            requested_at,
        } => Lifecycle::Cancelling(idempotency_key.clone(), *requested_at),
        GraphRunLifecycleState::Cancelled {
            idempotency_key,
            cancelled_at,
        } => Lifecycle::Cancelled(idempotency_key.clone(), *cancelled_at),
        GraphRunLifecycleState::OutcomeUnknown {
            idempotency_key,
            observed_at,
        } => Lifecycle::OutcomeUnknown(idempotency_key.clone(), *observed_at),
        GraphRunLifecycleState::Tombstoned {
            idempotency_key,
            tombstoned_at,
        } => Lifecycle::Tombstoned(idempotency_key.clone(), *tombstoned_at),
    };
    let gate = match run.start_gate() {
        RunStartGate::Intake => Gate::Intake,
        RunStartGate::Designing {
            design_epoch,
            prompt_generation,
        } => Gate::Designing(design_epoch.clone(), prompt_generation.clone()),
        RunStartGate::Started => Gate::Started,
    };
    let runtime = run
        .runtime()
        .map(|runtime| runtime.bindings().iter().map(encode_binding).collect());
    record(
        run.team(),
        run.run_id(),
        RecordKind::RunHeader,
        "",
        &Header {
            revision: run.frozen_team_revision().get(),
            runtime,
            workspace: run.workspace().map(|workspace| Workspace { root: workspace.root().to_owned(), prepared: workspace.is_prepared() }),
            execution_control: ExecutionControl {
                next_batch_id: run.graph().next_batch_id().get(),
                rework_counts: run
                    .graph()
                    .rework_counts()
                    .iter()
                    .map(|(key, used)| ReworkCounter {
                        batch_id: key.batch_id.get(),
                        source_node_id: key.source_node_id.as_str().to_owned(),
                        source_port: key.source_port.clone(),
                        used: *used,
                    })
                    .collect(),
                blocked_reworks: run
                    .graph()
                    .blocked_reworks()
                    .values()
                    .map(|blocked| BlockedRework {
                        batch_id: blocked.batch_id.get(),
                        source_node_id: blocked.source_node_id.as_str().to_owned(),
                        source_port: blocked.source_port.clone(),
                        source_fence: super::attempt::Fence::from_domain(&blocked.source_fence),
                        scope: blocked
                            .scope
                            .iter()
                            .map(|node| node.as_str().to_owned())
                            .collect(),
                        edge_ids: blocked
                            .edge_ids
                            .iter()
                            .map(|edge| edge.as_str().to_owned())
                            .collect(),
                        used: blocked.used,
                        max_reworks: blocked.max_reworks,
                        blocked_at: blocked.blocked_at,
                    })
                    .collect(),
            },
            role_session_intents: run
                .role_session_intents()
                .iter()
                .map(|(key, intent)| {
                    (
                        key.clone(),
                        SessionIntent {
                            binding: encode_binding(&intent.binding),
                            submission_uncertain: None,
                            phase: Some(match intent.phase {
                                crate::store::RoleSessionPhase::Reserved => SessionPhase::Reserved,
                                crate::store::RoleSessionPhase::SubmissionUncertain => SessionPhase::SubmissionUncertain,
                                crate::store::RoleSessionPhase::Confirmed => SessionPhase::Confirmed,
                            }),
                        },
                    )
                })
                .collect(),
        deletion_confirmations: run.deletion_confirmations().iter()
            .map(|confirmation| encode_binding(confirmation.binding())).collect(),
        task_execution_context: run.task_execution_context().cloned(),
        creation_key: run.lifecycle().creation_idempotency_key().to_owned(), lifecycle, gate,
        retired_executions: run
            .retired_executions()
            .iter()
            .map(|(node, fence)| {
                (
                    node.as_str().to_owned(),
                    fence.attempt_id().as_str().to_owned(),
                    fence.node_execution_id().as_str().to_owned(),
                )
            })
            .collect(),
        },
    )
}

pub(crate) fn decode_header(row: &StoredRecord) -> Result<RunHeader, StoreFault> {
    let header: Header = decode(row, RecordKind::RunHeader)?;
    let team = TeamId::try_new(row.team_id.clone().ok_or(StoreFault::InvalidFacts)?).map_err(|_| StoreFault::InvalidFacts)?;
    let run = GraphRunId::new(row.run_id.clone().ok_or(StoreFault::InvalidFacts)?);
    if row.key.scope != run.as_str() || !row.key.id.is_empty() { return Err(StoreFault::InvalidFacts); }
    let revision = TeamRevision::try_new(header.revision).map_err(|_| StoreFault::InvalidFacts)?;
    let runtime = header.runtime.map(|bindings| {
        let bindings = bindings.into_iter().map(decode_binding).collect::<Result<Vec<_>, StoreFault>>()?;
        RunRuntimeReceipt::try_new(run.clone(), bindings).map_err(|_| StoreFault::InvalidFacts)
    }).transpose()?;
    let state = match header.lifecycle {
        Lifecycle::Active => GraphRunLifecycleState::Active,
        Lifecycle::Cancelling(idempotency_key, requested_at) => {
            GraphRunLifecycleState::Cancelling {
                idempotency_key,
                requested_at,
            }
        }
        Lifecycle::Cancelled(idempotency_key, cancelled_at) => GraphRunLifecycleState::Cancelled {
            idempotency_key,
            cancelled_at,
        },
        Lifecycle::OutcomeUnknown(idempotency_key, observed_at) => {
            GraphRunLifecycleState::OutcomeUnknown {
                idempotency_key,
                observed_at,
            }
        }
        Lifecycle::Tombstoned(idempotency_key, tombstoned_at) => {
            GraphRunLifecycleState::Tombstoned {
                idempotency_key,
                tombstoned_at,
            }
        }
    };
    let lifecycle = GraphRunLifecycle::restore(header.creation_key, state)
        .map_err(|_| StoreFault::InvalidFacts)?;
    let gate = match header.gate {
        Gate::Intake => RunStartGate::Intake,
        Gate::Designing(design_epoch, prompt_generation) => RunStartGate::Designing {
            design_epoch,
            prompt_generation,
        },
        Gate::Started => RunStartGate::Started,
    };
    if let RunStartGate::Designing {
        design_epoch,
        prompt_generation,
    } = &gate
    {
        if design_epoch.trim().is_empty()
            || prompt_generation
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(StoreFault::InvalidFacts);
        }
    }
    let mut retired_executions = std::collections::BTreeSet::new();
    for (node, attempt, execution) in header.retired_executions {
        if !retired_executions.insert((
            crate::NodeId::new(node),
            crate::ExecutionFence::from_durable(attempt, execution),
        )) {
            return Err(StoreFault::InvalidFacts);
        }
    }
    if header.task_execution_context.as_ref().is_some_and(|context| {
        !context.valid() || context.root_request_id != lifecycle.creation_idempotency_key()
        })
    {
        return Err(StoreFault::InvalidFacts);
    }
    let next_batch_id =
        NonZeroU64::new(header.execution_control.next_batch_id).ok_or(StoreFault::InvalidFacts)?;
    let mut rework_counts = BTreeMap::new();
    for counter in header.execution_control.rework_counts {
        let key = crate::run::graph::ReworkCounterKey {
            batch_id: NonZeroU64::new(counter.batch_id).ok_or(StoreFault::InvalidFacts)?,
            source_node_id: crate::NodeId::new(counter.source_node_id),
            source_port: counter.source_port,
        };
        if rework_counts.insert(key, counter.used).is_some() {
            return Err(StoreFault::InvalidFacts);
        }
    }
    let mut blocked_reworks = BTreeMap::new();
    for blocked in header.execution_control.blocked_reworks {
        let blocked = crate::run::graph::BlockedRework {
            batch_id: NonZeroU64::new(blocked.batch_id).ok_or(StoreFault::InvalidFacts)?,
            source_node_id: crate::NodeId::new(blocked.source_node_id),
            source_port: blocked.source_port,
            source_fence: blocked.source_fence.into_domain(),
            scope: blocked.scope.into_iter().map(crate::NodeId::new).collect(),
            edge_ids: blocked
                .edge_ids
                .into_iter()
                .map(crate::EdgeId::new)
                .collect(),
            used: blocked.used,
            max_reworks: blocked.max_reworks,
            blocked_at: blocked.blocked_at,
        };
        if blocked_reworks
            .insert(blocked.source_node_id.clone(), blocked)
            .is_some()
        {
            return Err(StoreFault::InvalidFacts);
        }
    }
    let workspace = header.workspace.map(|workspace| crate::RunWorkspace::try_new(workspace.root, workspace.prepared)
        .map_err(|_| StoreFault::InvalidFacts)).transpose()?;
    let role_session_intents = header.role_session_intents.into_iter().map(|(key, intent)| {
        use crate::store::RoleSessionPhase as Phase;
        let binding = decode_binding(intent.binding)?;
        let installed = runtime.as_ref().is_some_and(|runtime| runtime.bindings().contains(&binding));
        let phase = match (intent.phase, intent.submission_uncertain) {
            (Some(SessionPhase::Reserved), None) => Phase::Reserved,
            (Some(SessionPhase::SubmissionUncertain), None) => Phase::SubmissionUncertain,
            (Some(SessionPhase::Confirmed), None) => Phase::Confirmed,
            (None, Some(false)) if installed => Phase::Confirmed,
            (None, Some(false)) => Phase::Reserved,
            (None, Some(true)) if !installed => Phase::SubmissionUncertain,
            _ => return Err(StoreFault::InvalidFacts),
        };
        Ok((key, crate::store::RoleSessionIntent { binding, phase }))
    }).collect::<Result<_, StoreFault>>()?;
    let deletion_confirmations = header.deletion_confirmations.into_iter().map(|binding| {
        let binding = decode_binding(binding)?;
        let receipt = crate::RoleSessionDeleteReceipt::new(binding.endpoint_session_id().clone());
        crate::RoleSessionDeletionConfirmation::try_new(binding, receipt).map_err(|_| StoreFault::InvalidFacts)
    }).collect::<Result<_, _>>()?;
    Ok(RunHeader {
        workspace,
        role_session_intents,
        deletion_confirmations,
        next_batch_id,
        rework_counts,
        blocked_reworks,
        task_execution_context: header.task_execution_context,
        team,
        run,
        revision,
        runtime,
        lifecycle,
        gate,
        retired_executions,
    })
}
