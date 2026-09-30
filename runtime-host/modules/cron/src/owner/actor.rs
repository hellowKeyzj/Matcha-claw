use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use foundation::execution::{
    LaneRetention, ObservationSink, OperationHandle, OwnerSpec, TraceContext,
};
use platform::call::CallStatus;
use tokio::sync::mpsc;

use crate::{
    application::{
        commands::{CronCommand, CronOwnerKey, CronQuery, MutationCommand},
        results::{MutationResult, MutationResults},
    },
    call::{CronCall, ExecutionStatus, Outcome, safe_id},
    model::{
        CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronExecutionTerminalEvent,
        CronExecutionTerminalStatus, CronHistoryCommand, CronHistoryOutcome,
        CronJobMutationOutcome, CronListOutcome, CronRunHistoryFailure, CronTriggerResult,
        CronUpdateCommand,
    },
    ports::{
        CronRequestAdmission, CronRequestAdmissionClosed, CronRuntimeDirectory,
        CronSessionHistoryFailure, CronSessionHistoryPort,
    },
};

const CRON_EXECUTION_CAPACITY: usize = 32;
const CRON_EXECUTION_TRACE_NAME: &str = "cron.execution";

static NEXT_CRON_EXECUTION_TRACE: AtomicU64 = AtomicU64::new(1);

pub struct CronOwnerInput {
    pub admission: Arc<dyn CronRequestAdmission>,
    pub runtime_directory: Arc<dyn CronRuntimeDirectory>,
    pub session_history: Arc<dyn CronSessionHistoryPort>,
    pub events: Option<mpsc::Sender<CronExecutionTerminalEvent>>,
    pub observation: ObservationSink,
}

#[derive(Clone)]
pub(crate) struct CronShared {
    admission: Arc<dyn CronRequestAdmission>,
    runtime_directory: Arc<dyn CronRuntimeDirectory>,
    session_history: Arc<dyn CronSessionHistoryPort>,
    events: Option<mpsc::Sender<CronExecutionTerminalEvent>>,
    observation: ObservationSink,
    results: MutationResults,
}

pub(crate) struct CronGlobalState {
    active_executions: Vec<CronExecution>,
}

pub(crate) struct CronLaneState;

struct CronExecution {
    job_id: String,
    run_id: String,
    handle: OperationHandle<CronExecutionTerminalStatus>,
    call: Option<CronCall>,
}

pub(crate) struct CronOwner {
    shared: CronShared,
    global: CronGlobalState,
}

impl CronOwner {
    pub(crate) fn new(input: CronOwnerInput, results: MutationResults) -> Self {
        Self {
            shared: CronShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
                session_history: input.session_history,
                events: input.events,
                observation: input.observation,
                results,
            },
            global: CronGlobalState {
                active_executions: Vec::new(),
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for CronOwner {
    type Command = CronCommand;
    type Query = CronQuery;
    type Key = CronOwnerKey;
    type Shared = CronShared;
    type GlobalState = CronGlobalState;
    type LaneState = CronLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.global)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        CronLaneState
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
        global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            CronCommand::Mutate { command, mut call } => {
                let result = if !call.running().await {
                    MutationResult::Unavailable
                } else {
                    match command {
                        MutationCommand::Create(command) => {
                            MutationResult::job(create(&shared, command).await)
                        }
                        MutationCommand::Update(command) => {
                            MutationResult::job(update(&shared, command).await)
                        }
                        MutationCommand::Delete(command) => {
                            MutationResult::deleted(delete(&shared, command).await)
                        }
                    }
                };
                let (status, outcome) = result.finish_detail(&mut call.detail);
                shared.results.complete(call.id(), result);
                call.finish(status, outcome).await;
            }
            CronCommand::Trigger {
                job_id,
                mut call,
                reply,
            } => {
                let outcome = match &call {
                    Some(call) if !call.running().await => Err(CronRequestAdmissionClosed),
                    _ => trigger(&shared, global, job_id, &mut call).await,
                };
                if let Some(call) = &mut call {
                    call.finish_trigger(&outcome).await;
                }
                let _ = reply.send(outcome);
            }
            CronCommand::CancelOperations { reply } => {
                cancel_operations(&shared, global).await;
                let _ = reply.send(());
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
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {
            CronQuery::List { mut call, reply } => {
                let outcome = match &call {
                    Some(call) if !call.running().await => CronListOutcome::Unavailable,
                    _ => list(&shared).await,
                };
                if let Some(call) = &mut call {
                    let (status, detail_outcome) = match &outcome {
                        CronListOutcome::Listed(view) => {
                            call.detail.item_count = Some(view.jobs.len());
                            (CallStatus::Succeeded, Outcome::Listed)
                        }
                        CronListOutcome::Rejected => (CallStatus::Rejected, Outcome::Rejected),
                        CronListOutcome::Protocol => (CallStatus::Failed, Outcome::Protocol),
                        CronListOutcome::Unavailable => (CallStatus::Failed, Outcome::Unavailable),
                    };
                    call.finish(status, detail_outcome).await;
                }
                let _ = reply.send(outcome);
            }
            CronQuery::LoadHistory {
                command,
                mut call,
                reply,
            } => {
                let outcome = match &call {
                    Some(call) if !call.running().await => CronHistoryOutcome::Unavailable,
                    _ => load_history(&shared, command).await,
                };
                if let Some(call) = &mut call {
                    let (status, detail_outcome) = match &outcome {
                        CronHistoryOutcome::Loaded(view) => {
                            call.detail.item_count = Some(view.messages.len());
                            (CallStatus::Succeeded, Outcome::Loaded)
                        }
                        CronHistoryOutcome::Rejected => (CallStatus::Rejected, Outcome::Rejected),
                        CronHistoryOutcome::Protocol => (CallStatus::Failed, Outcome::Protocol),
                        CronHistoryOutcome::Deadline => (CallStatus::Failed, Outcome::Deadline),
                        CronHistoryOutcome::Unavailable => {
                            (CallStatus::Failed, Outcome::Unavailable)
                        }
                    };
                    call.finish(status, detail_outcome).await;
                }
                let _ = reply.send(outcome);
            }
        }
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, global, query).await;
    }
}

async fn list(shared: &CronShared) -> CronListOutcome {
    if shared.admission.admit_cron_request().is_err() {
        return CronListOutcome::Unavailable;
    }
    match shared.runtime_directory.cron_ops() {
        Some(ops) => ops.list_cron_jobs().await,
        None => CronListOutcome::Unavailable,
    }
}

async fn load_history(shared: &CronShared, command: CronHistoryCommand) -> CronHistoryOutcome {
    if shared.admission.admit_cron_request().is_err() {
        return CronHistoryOutcome::Unavailable;
    }
    let Some(ops) = shared.runtime_directory.cron_ops() else {
        return CronHistoryOutcome::Unavailable;
    };
    let receipts = match ops
        .cron_run_history(command.job_id().to_owned(), command.limit())
        .await
    {
        Ok(receipts) => receipts.into_iter(),
        Err(CronRunHistoryFailure::Rejected) => return CronHistoryOutcome::Rejected,
        Err(CronRunHistoryFailure::Protocol) => return CronHistoryOutcome::Protocol,
        Err(CronRunHistoryFailure::Deadline) => return CronHistoryOutcome::Deadline,
        Err(CronRunHistoryFailure::Unavailable) => return CronHistoryOutcome::Unavailable,
    };
    let session_key = match command.canonical_session_key(receipts) {
        Some(session_key) => session_key,
        None => return CronHistoryOutcome::Rejected,
    };
    match shared
        .session_history
        .load_cron_session_history(session_key, command.limit())
        .await
    {
        Ok(history) => CronHistoryOutcome::Loaded(history),
        Err(CronSessionHistoryFailure::Rejected) => CronHistoryOutcome::Rejected,
        Err(CronSessionHistoryFailure::Protocol) => CronHistoryOutcome::Protocol,
        Err(CronSessionHistoryFailure::Unavailable) => CronHistoryOutcome::Unavailable,
        Err(CronSessionHistoryFailure::Deadline) => CronHistoryOutcome::Deadline,
    }
}

async fn create(shared: &CronShared, command: CronCreateCommand) -> CronJobMutationOutcome {
    if shared.admission.admit_cron_request().is_err() {
        return CronJobMutationOutcome::Unavailable;
    }
    match shared.runtime_directory.cron_ops() {
        Some(ops) => ops.add_cron_job(command).await,
        None => CronJobMutationOutcome::Unavailable,
    }
}

async fn update(shared: &CronShared, command: CronUpdateCommand) -> CronJobMutationOutcome {
    if shared.admission.admit_cron_request().is_err() {
        return CronJobMutationOutcome::Unavailable;
    }
    match shared.runtime_directory.cron_ops() {
        Some(ops) => {
            let job_id = command.job_id.clone();
            match ops.update_cron_job(command).await {
                CronJobMutationOutcome::Applied(job) if job.id != job_id => {
                    CronJobMutationOutcome::OutcomeUnknown
                }
                outcome => outcome,
            }
        }
        None => CronJobMutationOutcome::Unavailable,
    }
}

async fn delete(shared: &CronShared, command: CronDeleteCommand) -> CronDeleteOutcome {
    if shared.admission.admit_cron_request().is_err() {
        return CronDeleteOutcome::Unavailable;
    }
    match shared.runtime_directory.cron_ops() {
        Some(ops) => ops.delete_cron_job(command).await,
        None => CronDeleteOutcome::Unavailable,
    }
}

async fn trigger(
    shared: &CronShared,
    global: &mut CronGlobalState,
    job_id: String,
    call: &mut Option<CronCall>,
) -> Result<CronTriggerResult, CronRequestAdmissionClosed> {
    shared.admission.admit_cron_request()?;
    let Some(ops) = shared.runtime_directory.cron_ops() else {
        return Ok(CronTriggerResult::OutcomeUnknown);
    };
    reap_active_executions(shared, global).await;
    if global.active_executions.len() >= CRON_EXECUTION_CAPACITY {
        return Ok(CronTriggerResult::OutcomeUnknown);
    }
    let Some(events) = shared.events.clone() else {
        return Ok(CronTriggerResult::OutcomeUnknown);
    };
    let admission = match ops.admit_cron_execution(job_id.clone()).await {
        Ok(Ok(admission)) => admission,
        Ok(Err(status)) => return Ok(status),
        Err(_) => return Ok(CronTriggerResult::OutcomeUnknown),
    };
    let run_id = admission.run_id().to_owned();
    let mut execution_call = call.take();
    if let Some(call) = &mut execution_call {
        call.detail.run_id = safe_id(&run_id);
        call.detail.execution_status = Some(ExecutionStatus::Waiting);
        call.finish_trigger(&Ok(CronTriggerResult::Accepted)).await;
    }
    let mut terminal_call = execution_call.clone();
    let event_job_id = job_id.clone();
    let event_run_id = run_id.clone();
    let operation = if shared.observation.is_enabled() {
        OperationHandle::spawn_observed(
            shared.observation.clone(),
            next_cron_execution_trace(),
            CRON_EXECUTION_TRACE_NAME,
            move |cancellation| async move {
                let status = admission.await_terminal(cancellation).await;
                let _ = events.try_send(CronExecutionTerminalEvent::new(
                    event_job_id,
                    event_run_id,
                    status,
                ));
                if let Some(call) = &mut terminal_call {
                    call.terminal(status).await;
                }
                status
            },
        )
        .0
    } else {
        OperationHandle::spawn(move |cancellation| async move {
            let status = admission.await_terminal(cancellation).await;
            let _ = events.try_send(CronExecutionTerminalEvent::new(
                event_job_id,
                event_run_id,
                status,
            ));
            if let Some(call) = &mut terminal_call {
                call.terminal(status).await;
            }
            status
        })
        .0
    };
    global.active_executions.push(CronExecution {
        job_id,
        run_id,
        handle: operation,
        call: execution_call,
    });
    Ok(CronTriggerResult::Accepted)
}

async fn cancel_operations(shared: &CronShared, global: &mut CronGlobalState) {
    let events = shared.events.clone();
    for execution in global.active_executions.iter() {
        execution.handle.cancel();
    }
    for mut execution in global.active_executions.drain(..) {
        if execution.handle.join().await.is_err() {
            if let Some(call) = &mut execution.call {
                call.terminal(CronExecutionTerminalStatus::OutcomeUnknown)
                    .await;
            }
            if let Some(events) = &events {
                let _ = events.try_send(CronExecutionTerminalEvent::new(
                    execution.job_id,
                    execution.run_id,
                    CronExecutionTerminalStatus::OutcomeUnknown,
                ));
            }
        }
    }
}

async fn reap_active_executions(shared: &CronShared, global: &mut CronGlobalState) {
    let events = shared.events.clone();
    let mut pending = Vec::with_capacity(global.active_executions.len());
    for mut execution in global.active_executions.drain(..) {
        if execution.handle.is_finished() {
            if execution.handle.join().await.is_err() {
                if let Some(call) = &mut execution.call {
                    call.terminal(CronExecutionTerminalStatus::OutcomeUnknown)
                        .await;
                }
                if let Some(events) = &events {
                    let _ = events.try_send(CronExecutionTerminalEvent::new(
                        execution.job_id,
                        execution.run_id,
                        CronExecutionTerminalStatus::OutcomeUnknown,
                    ));
                }
            }
        } else {
            pending.push(execution);
        }
    }
    global.active_executions = pending;
}

fn next_cron_execution_trace() -> TraceContext {
    TraceContext::root(NEXT_CRON_EXECUTION_TRACE.fetch_add(1, Ordering::Relaxed))
}
