use serde::{Deserialize, Serialize};

use crate::{
    EndpointSessionId, GraphRunFacts, GraphRunId, ManagedAgentReference, RoleId,
    RoleSessionReceipt, RoleSessionRef, RunRuntimeReceipt, RuntimeEndpointReference, TeamId,
    TeamRevision,
    run::lifecycle::{GraphRunLifecycle, GraphRunLifecycleState},
    store::{RunStartGate, StoreFault, schema::{RecordKind, StoredRecord}},
};
use super::{decode, record};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    revision: u64,
    runtime: Option<Vec<Binding>>,
    creation_key: String,
    lifecycle: Lifecycle,
    gate: Gate,
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
    pub(crate) lifecycle: GraphRunLifecycle,
    pub(crate) gate: RunStartGate,
}

pub(crate) fn encode_header(run: &GraphRunFacts) -> Result<StoredRecord, StoreFault> {
    let lifecycle = match run.lifecycle().state() {
        GraphRunLifecycleState::Active => Lifecycle::Active,
        GraphRunLifecycleState::Cancelling { idempotency_key, requested_at } => Lifecycle::Cancelling(idempotency_key.clone(), *requested_at),
        GraphRunLifecycleState::Cancelled { idempotency_key, cancelled_at } => Lifecycle::Cancelled(idempotency_key.clone(), *cancelled_at),
        GraphRunLifecycleState::OutcomeUnknown { idempotency_key, observed_at } => Lifecycle::OutcomeUnknown(idempotency_key.clone(), *observed_at),
        GraphRunLifecycleState::Tombstoned { idempotency_key, tombstoned_at } => Lifecycle::Tombstoned(idempotency_key.clone(), *tombstoned_at),
    };
    let gate = match run.start_gate() {
        RunStartGate::Intake => Gate::Intake,
        RunStartGate::Designing { design_epoch, prompt_generation } => Gate::Designing(design_epoch.clone(), prompt_generation.clone()),
        RunStartGate::Started => Gate::Started,
    };
    let runtime = run.runtime().map(|runtime| runtime.bindings().iter().map(|binding| Binding {
        team: binding.team().as_str().to_owned(),
        run: binding.team_run().as_str().to_owned(),
        role: binding.role().as_str().to_owned(),
        session: binding.session_ref().as_str().to_owned(),
        endpoint_session: binding.endpoint_session_id().as_str().to_owned(),
        agent: binding.agent().as_str().to_owned(),
        endpoint: binding.endpoint().as_str().to_owned(),
    }).collect());
    record(run.team(), run.run_id(), RecordKind::RunHeader, "", &Header {
        revision: run.frozen_team_revision().get(), runtime,
        creation_key: run.lifecycle().creation_idempotency_key().to_owned(), lifecycle, gate,
    })
}

pub(crate) fn decode_header(row: &StoredRecord) -> Result<RunHeader, StoreFault> {
    let header: Header = decode(row, RecordKind::RunHeader)?;
    let team = TeamId::try_new(row.team_id.clone().ok_or(StoreFault::InvalidFacts)?).map_err(|_| StoreFault::InvalidFacts)?;
    let run = GraphRunId::new(row.run_id.clone().ok_or(StoreFault::InvalidFacts)?);
    if row.key.scope != run.as_str() || !row.key.id.is_empty() { return Err(StoreFault::InvalidFacts); }
    let revision = TeamRevision::try_new(header.revision).map_err(|_| StoreFault::InvalidFacts)?;
    let runtime = header.runtime.map(|bindings| {
        let bindings = bindings.into_iter().map(|binding| Ok(RoleSessionReceipt::with_endpoint_session_id(
            TeamId::try_new(binding.team).map_err(|_| StoreFault::InvalidFacts)?,
            GraphRunId::new(binding.run),
            RoleId::try_new(binding.role).map_err(|_| StoreFault::InvalidFacts)?,
            RoleSessionRef::try_new(binding.session).map_err(|_| StoreFault::InvalidFacts)?,
            EndpointSessionId::try_new(binding.endpoint_session).map_err(|_| StoreFault::InvalidFacts)?,
            ManagedAgentReference::try_new(binding.agent).map_err(|_| StoreFault::InvalidFacts)?,
            RuntimeEndpointReference::try_new(binding.endpoint).map_err(|_| StoreFault::InvalidFacts)?,
        ))).collect::<Result<Vec<_>, StoreFault>>()?;
        RunRuntimeReceipt::try_new(run.clone(), bindings).map_err(|_| StoreFault::InvalidFacts)
    }).transpose()?;
    let state = match header.lifecycle {
        Lifecycle::Active => GraphRunLifecycleState::Active,
        Lifecycle::Cancelling(idempotency_key, requested_at) => GraphRunLifecycleState::Cancelling { idempotency_key, requested_at },
        Lifecycle::Cancelled(idempotency_key, cancelled_at) => GraphRunLifecycleState::Cancelled { idempotency_key, cancelled_at },
        Lifecycle::OutcomeUnknown(idempotency_key, observed_at) => GraphRunLifecycleState::OutcomeUnknown { idempotency_key, observed_at },
        Lifecycle::Tombstoned(idempotency_key, tombstoned_at) => GraphRunLifecycleState::Tombstoned { idempotency_key, tombstoned_at },
    };
    let lifecycle = GraphRunLifecycle::restore(header.creation_key, state).map_err(|_| StoreFault::InvalidFacts)?;
    let gate = match header.gate {
        Gate::Intake => RunStartGate::Intake,
        Gate::Designing(design_epoch, prompt_generation) => RunStartGate::Designing { design_epoch, prompt_generation },
        Gate::Started => RunStartGate::Started,
    };
    if let RunStartGate::Designing { design_epoch, prompt_generation } = &gate {
        if design_epoch.trim().is_empty() || prompt_generation.as_ref().is_some_and(|value| value.trim().is_empty()) { return Err(StoreFault::InvalidFacts); }
    }
    Ok(RunHeader { team, run, revision, runtime, lifecycle, gate })
}
