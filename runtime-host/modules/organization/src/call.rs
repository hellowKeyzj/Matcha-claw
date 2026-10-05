use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    time::Instant,
};

use foundation::execution::OwnedTask;
use platform::{
    call::{CallContext, CallDetail, CallReceipt, CallRecorder, CallStatus},
    loopback::{Request, Response},
    trace::{identifier_hash, session_trace, with_session_trace},
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::adapters::loopback::{self, Dependencies};

pub(crate) mod outcome;

#[derive(Clone)]
pub(crate) struct CallScope {
    context: CallContext<OrganizationCallDetail>,
    detail: Arc<Mutex<OrganizationCallDetail>>,
    terminal_in_owner: bool,
    provision_progress_enabled: bool,
    finished: Arc<AtomicBool>,
    workflow_owned: Arc<AtomicBool>,
    state: Arc<Mutex<CallStatus>>,
    workflows: std::sync::Weak<CallWorkflows>,
}

pub struct CallReply<T> {
    sender: oneshot::Sender<T>,
    call: Option<CallScope>,
}

impl<T> CallReply<T> {
    pub(crate) fn new(sender: oneshot::Sender<T>, call: Option<CallScope>) -> Self {
        Self { sender, call }
    }
}

impl<T> CallReply<T> {
    pub(crate) fn trace_id(&self) -> Option<String> {
        self.call.as_ref().map(CallScope::trace_id)
    }

    pub(crate) fn provision_observer(&self) -> Option<crate::TeamProvisionObserver> {
        let call = self.call.as_ref().filter(|call| call.provision_progress_enabled)?;
        Some(Arc::new(call.clone()))
    }

    pub(crate) async fn running(&self) -> bool {
        with_session_trace(self.trace_id(), async {
            match &self.call {
                Some(call) => {
                    if call.running().await {
                        true
                    } else {
                        call.finish(true).await;
                        false
                    }
                }
                None => true,
            }
        })
        .await
    }

    pub(crate) async fn materialization(
        &self,
        native: Option<bool>,
        committed: Result<(), &crate::StoreFault>,
    ) {
        let Some(call) = &self.call else {
            return;
        };
        let mut detail = call.detail.lock().await;
        let Some(provision) = &mut detail.provision else {
            return;
        };
        provision.native_installed = native;
        provision.commit = Some(match committed {
            Ok(()) => ProvisionCommit::Committed,
            Err(
                crate::StoreFault::CommitOutcomeUnknown(_) | crate::StoreFault::RecoveryRequired,
            ) => ProvisionCommit::OutcomeUnknown,
            Err(_) => ProvisionCommit::Failed,
        });
        if matches!(
            committed,
            Err(crate::StoreFault::CommitOutcomeUnknown(_) | crate::StoreFault::RecoveryRequired)
        ) {
            detail.outcome = Some(OrganizationCallOutcome::OutcomeUnknown);
        }
    }

    pub(crate) async fn creation(
        &self,
        native: Option<bool>,
        committed: Result<(), &crate::StoreFault>,
    ) {
        let Some(call) = &self.call else {
            return;
        };
        let mut detail = call.detail.lock().await;
        let Some(creation) = &mut detail.creation else {
            return;
        };
        creation.native_installed = native;
        creation.commit = Some(match committed {
            Ok(()) => ProvisionCommit::Committed,
            Err(crate::StoreFault::CommitOutcomeUnknown(_) | crate::StoreFault::RecoveryRequired) => {
                ProvisionCommit::OutcomeUnknown
            }
            Err(_) => ProvisionCommit::Failed,
        });
        if matches!(
            committed,
            Err(crate::StoreFault::CommitOutcomeUnknown(_) | crate::StoreFault::RecoveryRequired)
        ) {
            detail.outcome = Some(OrganizationCallOutcome::OutcomeUnknown);
        }
    }

    pub(crate) fn awaits_workflow_settlement(&self) -> bool {
        self.call.as_ref().is_some_and(|call| call.workflow_owned.load(Ordering::Acquire))
    }

    pub(crate) async fn unavailable(&self) {
        if let Some(call) = &self.call {
            call.summarize(&crate::application::team_runtime::TeamRuntimeStatus::Unavailable)
                .await;
        }
    }

    pub(crate) async fn send(self, value: T) -> Result<(), T>
    where
        T: outcome::AuditOutcome,
    {
        with_session_trace(self.trace_id(), async {
            if let Some(call) = &self.call {
                let mut detail = call.detail.lock().await;
                value.summarize(&mut detail);
                if call.terminal_in_owner {
                    if call.context.finish(detail.status(), &detail).await.is_ok() {
                        call.finished.store(true, Ordering::Release);
                        session_trace(
                            "runtime.team.call.terminal",
                            json!({"status": detail.status()}),
                        );
                    } else {
                        audit_failure();
                    }
                } else if call.context.update(&detail).await.is_err() {
                    audit_failure();
                }
            }
            let sent = self.sender.send(value);
            session_trace(
                "runtime.team.owner.reply",
                json!({"reason": if sent.is_ok() { "sent" } else { "receiver_closed" }}),
            );
            sent
        })
        .await
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationCallDetail {
    team_id: Option<String>,
    run_id: Option<String>,
    team_id_hash: Option<String>,
    run_id_hash: Option<String>,
    command_id: Option<String>,
    graph: Option<GraphSummary>,
    outcome: Option<OrganizationCallOutcome>,
    provision: Option<ProvisionSummary>,
    creation: Option<ProvisionSummary>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionSummary {
    native_installed: Option<bool>,
    commit: Option<ProvisionCommit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<crate::TeamProvisionProgress>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProvisionCommit {
    Committed,
    Failed,
    OutcomeUnknown,
}

impl CallDetail for OrganizationCallDetail {
    const MODULE: &'static str = "organization";
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphSummary {
    status: GraphCallStatus,
    nodes: u64,
    edges: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum GraphCallStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum OrganizationCallOutcome {
    Read,
    CommandCommitted,
    Materialized,
    Created,
    Started,
    Intake,
    WaitingForInput,
    ApprovalRequested,
    TerminalRecorded,
    TerminalReceiptRequired,
    Cancelling,
    Cancelled,
    Tombstoned,
    Purged,
    Rejected,
    Unavailable,
    OutcomeUnknown,
}

pub(crate) struct CallWorkflows {
    sender: mpsc::Sender<CallWorkflow>,
    reads: mpsc::Sender<CallWorkflow>,
    tasks: Mutex<Vec<OwnedTask<()>>>,
    recorder: CallRecorder,
}

pub(crate) enum TeamWorkflow {
    Skill(loopback::skill::Request),
    Manual(loopback::manual::Request),
    RunDelete {
        run_id: crate::GraphRunId,
        idempotency_key: String,
        observed_at: u64,
    },
}

enum CallWorkflow {
    Team {
        owner: crate::OrganizationHandle,
        request: TeamWorkflow,
    },
    Runtime {
        owner: crate::OrganizationHandle,
        command: crate::TeamRuntimeCommand,
        reply: oneshot::Sender<
            Result<crate::TeamRuntimeCommandOutcome, crate::RequestAdmissionClosed>,
        >,
    },
    Graph {
        owner: crate::OrganizationHandle,
        request: loopback::graph::Request,
        reply: oneshot::Sender<loopback::graph::Delivery>,
    },
    Capability {
        owner: crate::OrganizationHandle,
        request: crate::TeamRuntimeCapabilityRequest,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        reply: Option<
            oneshot::Sender<
                Result<(String, crate::TeamRuntimeControlOutcome), crate::TeamRuntimeDecodeError>,
            >,
        >,
    },
}

impl CallWorkflows {
    pub(crate) fn start(recorder: CallRecorder) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel::<CallWorkflow>(64);
        let (reads, read_receiver) = mpsc::channel::<CallWorkflow>(64);
        Arc::new(Self {
            sender,
            reads,
            tasks: Mutex::new(vec![Self::spawn(receiver), Self::spawn(read_receiver)]),
            recorder,
        })
    }

    fn spawn(mut receiver: mpsc::Receiver<CallWorkflow>) -> OwnedTask<()> {
        let (task, _) = OwnedTask::spawn(move |shutdown| async move {
            loop {
                let workflow = tokio::select! {
                    _ = shutdown.cancelled() => {
                        receiver.close();
                        receiver.recv().await
                    }
                    workflow = receiver.recv() => workflow,
                };
                match workflow {
                    Some(CallWorkflow::Team { owner, request }) => {
                        with_session_trace(owner.call_trace_id(), async {
                            session_trace("runtime.team.workflow.start", json!({}));
                            let failed = if owner.call_running().await {
                                match request {
                                    TeamWorkflow::Skill(request) => {
                                        matches!(
                                            loopback::skill::dispatch(&owner, request).await,
                                            loopback::skill::Delivery::Unavailable
                                        )
                                    }
                                    TeamWorkflow::Manual(request) => {
                                        let outcome =
                                            loopback::manual::dispatch(&owner, request).await;
                                        if matches!(outcome, loopback::manual::Delivery::Rejected) {
                                            owner
                                                .summarize_call(&crate::TeamRuntimeStatus::Rejected)
                                                .await;
                                        }
                                        matches!(outcome, loopback::manual::Delivery::Unavailable)
                                    }
                                    TeamWorkflow::RunDelete {
                                        run_id,
                                        idempotency_key,
                                        observed_at,
                                    } => owner
                                        .run_delete_and_purge(run_id, idempotency_key, observed_at)
                                        .await
                                        .is_err(),
                                }
                            } else {
                                true
                            };
                            owner.finish_workflow(failed).await;
                            session_trace("runtime.team.workflow.end", json!({}));
                        })
                        .await;
                    }
                    Some(CallWorkflow::Runtime {
                        owner,
                        command,
                        reply,
                    }) => {
                        with_session_trace(owner.call_trace_id(), async {
                            session_trace("runtime.team.workflow.start", json!({}));
                            let outcome = if owner.call_running().await {
                                owner.execute_team_runtime_inline(command).await
                            } else {
                                Err(crate::owner::handle::closed_error())
                            };
                            owner.finish_workflow(outcome.is_err()).await;
                            session_trace(
                                "runtime.team.workflow.reply",
                                json!({"sent": reply.send(outcome).is_ok()}),
                            );
                            session_trace("runtime.team.workflow.end", json!({}));
                        })
                        .await;
                    }
                    Some(CallWorkflow::Graph {
                        owner,
                        request,
                        reply,
                    }) => {
                        let outcome = if owner.call_running().await {
                            loopback::graph::handle(&owner, request).await
                        } else {
                            loopback::graph::Delivery::Unavailable
                        };
                        owner.summarize_call(&outcome).await;
                        owner.finish_workflow(false).await;
                        let _ = reply.send(outcome);
                    }
                    Some(CallWorkflow::Capability {
                        owner,
                        request,
                        resolver,
                        reply,
                    }) => {
                        with_session_trace(owner.call_trace_id(), async {
                            session_trace("runtime.team.workflow.start", json!({}));
                            let outcome = if owner.call_running().await {
                                owner
                                    .execute_runtime_capability_inline(resolver, request)
                                    .await
                            } else {
                                Err(crate::TeamRuntimeDecodeError::Unavailable)
                            };
                            owner.finish_workflow(outcome.is_err()).await;
                            if let Some(reply) = reply {
                                session_trace(
                                    "runtime.team.workflow.reply",
                                    json!({"sent": reply.send(outcome).is_ok()}),
                                );
                            }
                            session_trace("runtime.team.workflow.end", json!({}));
                        })
                        .await;
                    }
                    None => break,
                }
            }
        });
        task
    }

    pub(crate) async fn runtime(
        &self,
        owner: crate::OrganizationHandle,
        command: crate::TeamRuntimeCommand,
    ) -> Result<crate::TeamRuntimeCommandOutcome, crate::RequestAdmissionClosed> {
        let (reply, outcome) = oneshot::channel();
        let sender = if matches!(command, crate::TeamRuntimeCommand::RunSnapshot { .. }) {
            &self.reads
        } else {
            &self.sender
        };
        sender
            .try_send(CallWorkflow::Runtime {
                owner: owner.clone(),
                command,
                reply,
            })
            .map_err(|_| {
                session_trace(
                    "runtime.team.workflow.enqueue",
                    json!({"reason": "admission_closed"}),
                );
                crate::owner::handle::closed_error()
            })?;
        session_trace("runtime.team.workflow.enqueue", json!({"reason": "queued"}));
        owner.call_admitted().await;
        outcome
            .await
            .map_err(|_| crate::owner::handle::closed_error())?
    }

    pub(crate) async fn graph(
        &self,
        owner: crate::OrganizationHandle,
        request: loopback::graph::Request,
    ) -> loopback::graph::Delivery {
        let (reply, outcome) = oneshot::channel();
        if self
            .sender
            .try_send(CallWorkflow::Graph {
                owner: owner.clone(),
                request,
                reply,
            })
            .is_err()
        {
            return loopback::graph::Delivery::Unavailable;
        }
        owner.call_admitted().await;
        outcome
            .await
            .unwrap_or(loopback::graph::Delivery::Unavailable)
    }

    pub(crate) async fn capability(
        &self,
        owner: crate::OrganizationHandle,
        request: crate::TeamRuntimeCapabilityRequest,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
    ) -> Result<(String, crate::TeamRuntimeControlOutcome), crate::TeamRuntimeDecodeError> {
        let (reply, outcome) = oneshot::channel();
        let sender = if request.operation_id() == "team.runSnapshot" {
            &self.reads
        } else {
            &self.sender
        };
        sender
            .try_send(CallWorkflow::Capability {
                owner: owner.clone(),
                request,
                resolver,
                reply: Some(reply),
            })
            .map_err(|_| {
                session_trace(
                    "runtime.team.workflow.enqueue",
                    json!({"reason": "admission_closed"}),
                );
                crate::TeamRuntimeDecodeError::Unavailable
            })?;
        session_trace("runtime.team.workflow.enqueue", json!({"reason": "queued"}));
        owner.call_admitted().await;
        outcome
            .await
            .map_err(|_| crate::TeamRuntimeDecodeError::Unavailable)?
    }

    pub(crate) async fn admit_capability(
        &self,
        owner: crate::OrganizationHandle,
        call: &CallScope,
        request: crate::TeamRuntimeCapabilityRequest,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
    ) -> Result<CallReceipt, crate::TeamRuntimeDecodeError> {
        self.admit(
            call,
            CallWorkflow::Capability { owner, request, resolver, reply: None },
        ).await
    }

    pub(crate) async fn admit_team(
        &self,
        owner: crate::OrganizationHandle,
        call: &CallScope,
        request: TeamWorkflow,
    ) -> Result<CallReceipt, crate::TeamRuntimeDecodeError> {
        self.admit(call, CallWorkflow::Team { owner, request }).await
    }

    async fn admit(
        &self,
        call: &CallScope,
        workflow: CallWorkflow,
    ) -> Result<CallReceipt, crate::TeamRuntimeDecodeError> {
        let mut state = call.state.lock().await;
        self.sender.try_send(workflow).map_err(|_| {
            session_trace(
                "runtime.team.workflow.enqueue",
                json!({"reason": "admission_closed"}),
            );
            crate::TeamRuntimeDecodeError::Unavailable
        })?;
        session_trace("runtime.team.workflow.enqueue", json!({"reason": "queued"}));
        call.workflow_owned.store(true, Ordering::Release);
        match call.context.accepted().await {
            Ok(receipt) => {
                *state = CallStatus::Accepted;
                session_trace("runtime.team.call.admission", json!({"reason": "accepted"}));
                Ok(receipt)
            }
            Err(_) => {
                audit_failure();
                *state = CallStatus::Failed;
                session_trace(
                    "runtime.team.call.admission",
                    json!({"reason": "audit_failed"}),
                );
                Err(crate::TeamRuntimeDecodeError::Unavailable)
            }
        }
    }

    pub(crate) async fn execute(
        self: &Arc<Self>,
        mut dependencies: Dependencies,
        request: Request,
        runtime_route: bool,
    ) -> Response {
        let mut detail = request_detail(&request);
        let context = match command_name(&request, runtime_route) {
            Some(command) => match self.recorder.begin(command, &detail).await {
                Ok(context) => Some(context),
                Err(_) => return Response::error(503, "Organization call audit is unavailable"),
            },
            None => None,
        };
        let scope = context.as_ref().map(|context| CallScope {
            context: context.clone(),
            detail: Arc::new(Mutex::new(detail.clone())),
            terminal_in_owner: single_stage(&request, runtime_route),
            provision_progress_enabled: runtime_route
                && serde_json::from_slice::<Value>(&request.body).ok().is_some_and(|body| {
                    body.get("operationId").and_then(Value::as_str) == Some("team.provisionAgents")
                        && body.get("input").and_then(|input| input.get("sourceType"))
                            .and_then(Value::as_str) == Some("manual")
                }),
            finished: Arc::new(AtomicBool::new(false)),
            workflow_owned: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(CallStatus::Received)),
            workflows: Arc::downgrade(self),
        });
        if let Some(scope) = &scope {
            dependencies = dependencies.with_call(scope.clone());
        }
        let trace_id = scope.as_ref().map(CallScope::trace_id);
        with_session_trace(trace_id, async {
            let started = Instant::now();
            let request_trace_hash = serde_json::from_slice::<Value>(&request.body)
                .ok()
                .and_then(|body| {
                    body.get("traceId")
                        .and_then(Value::as_str)
                        .map(identifier_hash)
                });
            session_trace(
                "runtime.team.call.received",
                json!({"requestTraceIdHash": request_trace_hash}),
            );
            let response = if runtime_route {
                loopback::dispatch_team_runtime(dependencies, request).await
            } else {
                loopback::dispatch_team(dependencies, request).await
            };
            if let (Some(context), Some(scope)) = (context, scope) {
                detail = scope.detail.lock().await.clone();
                if !scope.finished.load(Ordering::Acquire)
                    && !scope.workflow_owned.load(Ordering::Acquire)
                {
                    finish(&context, &mut detail, &response).await;
                }
            }
            session_trace(
                "runtime.team.call.response",
                json!({"status": response.status(), "elapsedMs": started.elapsed().as_millis()}),
            );
            response
        })
        .await
    }

    pub(crate) async fn shutdown(&self) {
        let mut tasks = self.tasks.lock().await;
        for task in tasks.iter() {
            task.cancel();
        }
        for mut task in tasks.drain(..) {
            let _ = task.join().await;
        }
    }
}

impl CallScope {
    pub(crate) fn trace_id(&self) -> String {
        let id = self.context.id().as_str();
        format!(
            "session-trace:team-call:{}-{}-{}-{}-{}",
            &id[..8],
            &id[8..12],
            &id[12..16],
            &id[16..20],
            &id[20..]
        )
    }

    pub(crate) async fn references(
        &self,
        team: Option<&str>,
        run: Option<&str>,
        command: Option<&str>,
    ) {
        let mut detail = self.detail.lock().await;
        if let Some(team) = team {
            detail.team_reference(team);
        }
        if let Some(run) = run {
            detail.run_reference(run);
        }
        if let Some(command) = command {
            detail.command_id = safe_reference(command);
        }
    }

    pub(crate) async fn summarize<T: outcome::AuditOutcome>(&self, value: &T) {
        if self.finished.load(Ordering::Acquire) {
            return;
        }
        let mut detail = self.detail.lock().await;
        value.summarize(&mut detail);
        if self.context.update(&detail).await.is_err() {
            audit_failure();
        }
    }

    pub(crate) async fn admitted(&self) {
        let mut state = self.state.lock().await;
        if *state == CallStatus::Received {
            if self.context.accepted().await.is_ok() {
                *state = CallStatus::Accepted;
                session_trace("runtime.team.call.admission", json!({"reason": "accepted"}));
            } else {
                audit_failure();
                *state = CallStatus::Failed;
            }
        }
    }

    pub(crate) async fn running(&self) -> bool {
        self.admitted().await;
        let mut state = self.state.lock().await;
        if *state == CallStatus::Accepted {
            if self.context.running().await.is_ok() {
                *state = CallStatus::Running;
                session_trace("runtime.team.call.running", json!({"reason": "running"}));
            } else {
                audit_failure();
                *state = CallStatus::Failed;
            }
        }
        *state == CallStatus::Running
    }

    pub(crate) fn workflows(&self) -> Option<Arc<CallWorkflows>> {
        self.workflows.upgrade()
    }

    pub(crate) async fn finish(&self, failed: bool) {
        if self.finished.load(Ordering::Acquire) {
            return;
        }
        let mut detail = self.detail.lock().await;
        if failed
            && !matches!(
                detail.outcome,
                Some(OrganizationCallOutcome::OutcomeUnknown | OrganizationCallOutcome::Rejected)
            )
        {
            detail.outcome = Some(OrganizationCallOutcome::Unavailable);
        }
        if self.context.finish(detail.status(), &detail).await.is_ok() {
            self.finished.store(true, Ordering::Release);
            session_trace(
                "runtime.team.call.terminal",
                json!({"status": detail.status()}),
            );
        } else {
            audit_failure();
        }
    }
}

impl crate::TeamProvisionReporter for CallScope {
    fn report(
        &self,
        update: crate::TeamProvisionUpdate,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let mut detail = self.detail.lock().await;
            if self.finished.load(Ordering::Acquire) {
                return;
            }
            let Some(provision) = &mut detail.provision else {
                return;
            };
            match update {
                crate::TeamProvisionUpdate::Started(progress) => {
                    if provision.progress.as_ref() == Some(&progress) {
                        return;
                    }
                    provision.progress = Some(progress);
                }
                crate::TeamProvisionUpdate::Stage(stage) => {
                    let Some(progress) = &mut provision.progress else {
                        return;
                    };
                    if progress.stage == stage {
                        return;
                    }
                    progress.stage = stage;
                }
                crate::TeamProvisionUpdate::Member { index, status } => {
                    let Some(member) = provision.progress.as_mut()
                        .and_then(|progress| progress.members.get_mut(index)) else {
                        return;
                    };
                    if *member == status {
                        return;
                    }
                    *member = status;
                }
            }
            if self.context.update(&detail).await.is_err() {
                audit_failure();
            }
        })
    }
}

async fn finish(
    context: &CallContext<OrganizationCallDetail>,
    detail: &mut OrganizationCallDetail,
    response: &Response,
) {
    use OrganizationCallOutcome as Outcome;
    // Owner-typed outcome is authoritative, especially an unknown commit returned as HTTP 200.
    let status = match detail.outcome {
        Some(Outcome::OutcomeUnknown) => CallStatus::Unknown,
        Some(Outcome::Unavailable) => CallStatus::Failed,
        Some(Outcome::Rejected) => CallStatus::Rejected,
        _ if response.status() >= 500 => {
            detail.outcome = Some(Outcome::Unavailable);
            CallStatus::Failed
        }
        _ if response.status() >= 400 => {
            detail.outcome = Some(Outcome::Rejected);
            CallStatus::Rejected
        }
        Some(_) => CallStatus::Succeeded,
        None => {
            // Only webhook credential reads have no Organization owner command/query.
            detail.outcome = Some(Outcome::Read);
            CallStatus::Succeeded
        }
    };
    if context.finish(status, detail).await.is_err() {
        audit_failure();
    } else {
        session_trace("runtime.team.call.terminal", json!({"status": status}));
    }
}

fn audit_failure() {
    session_trace(
        "runtime.team.call.audit",
        json!({"reason": "persistence_failed"}),
    );
    eprintln!("Organization call audit persistence failed");
}

fn request_detail(request: &Request) -> OrganizationCallDetail {
    let path = request.path().split('?').next().unwrap_or_default();
    let body = serde_json::from_slice::<Value>(&request.body).ok();
    let input = body
        .as_ref()
        .and_then(|body| body.get("input"))
        .or(body.as_ref());
    let mut detail = OrganizationCallDetail {
        command_id: input.and_then(|input| reference(input.get("commandId"))),
        provision: body.as_ref().filter(|body| {
            body.get("operationId").and_then(Value::as_str) == Some("team.provisionAgents")
                || body.get("operation").and_then(Value::as_str) == Some("team.skill.materialize")
                || path == "/api/team/manual-materialize-and-create"
        }).map(|_| ProvisionSummary::default()),
        creation: (path == "/api/team/manual-materialize-and-create").then(ProvisionSummary::default),
        ..OrganizationCallDetail::default()
    };
    if let Some(team) = input.and_then(|input| input.get("teamId")).and_then(Value::as_str) {
        detail.team_reference(team);
    }
    if let Some(run) = input.and_then(|input| input.get("runId")).and_then(Value::as_str) {
        detail.run_reference(run);
    }
    detail
}

fn reference(value: Option<&Value>) -> Option<String> {
    safe_reference(value?.as_str()?)
}

fn safe_reference(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')))
    .then(|| value.to_owned())
}

fn safe_run_reference(value: &str) -> Option<String> {
    safe_reference(value).or_else(|| {
        value.strip_prefix("manual:")
            .filter(|key| safe_reference(key).is_some())
            .map(|_| value.to_owned())
    })
}

fn command_name(request: &Request, runtime_route: bool) -> Option<&'static str> {
    let body = serde_json::from_slice::<Value>(&request.body).ok();
    if runtime_route {
        return Some(
            match body
                .as_ref()
                .and_then(|body| body.get("operationId"))
                .and_then(Value::as_str)
            {
                Some("team.packageValidate") => "team.packageValidate",
                Some("team.dependencyPlan") => "team.dependencyPlan",
                Some("team.provisionAgents") => "team.provisionAgents",
                Some("team.delete") => "team.delete",
                Some("team.runCreate") => "team.runCreate",
                Some("team.runList") => "team.runList",
                Some("team.triggerList") => "team.triggerList",
                Some("team.webhookTriggerFire") => "team.webhookTriggerFire",
                Some("team.runSnapshot") => "team.runSnapshot",
                Some("team.graphSave") => "team.graphSave",
                Some("team.graphPatch") => "team.graphPatch",
                Some("team.graphContext") => "team.graphContext",
                Some("team.graphExportYaml") => "team.graphExportYaml",
                Some("team.graphImportYaml") => "team.graphImportYaml",
                Some("team.triggerFire") => "team.triggerFire",
                Some("team.runStartConfirm" | "team.proposalConfirm") => "team.runStartConfirm",
                Some(
                    "team.runStartContinue"
                    | "team.proposalContinue"
                    | "team.proposalCancel"
                    | "team.runStartReject",
                ) => "team.runStartContinue",
                Some("team.nodePromptRetryDue") => "team.nodePromptRetryDue",
                Some("team.nodeEvent") => "team.nodeEvent",
                Some("team.runDiagnostics") => "team.runDiagnostics",
                Some("team.runDecisionSubmit") => "team.runDecisionSubmit",
                Some("team.resume") => "team.resume",
                Some("team.approvalResolve") => "team.approvalResolve",
                Some("team.runCancel") => "team.runCancel",
                Some("team.runDelete") => "team.runDelete",
                _ => "team.runtime.invalid",
            },
        );
    }
    let action = body
        .as_ref()
        .and_then(|body| body.get("action"))
        .and_then(Value::as_str);
    Some(match request.path().split('?').next()? {
        "/api/team/public" => "team.public.read",
        "/api/team/role-sessions" => "team.role-sessions.read",
        "/api/team/approvals" => "team.approvals.list",
        "/api/team/task-board" if action == Some("read") => "team.task-board.read",
        "/api/team/task-board" => "team.task-board.mutate",
        "/api/team/decision" => "team.decision.resolve",
        "/api/team/lifecycle" => match action {
            Some("list") => "team.lifecycle.list",
            Some("resume") => "team.lifecycle.resume",
            Some("create") => "team.lifecycle.create",
            Some("cancel") => "team.lifecycle.cancel",
            Some("delete") => "team.lifecycle.delete",
            _ => "team.lifecycle.invalid",
        },
        "/api/team/graph" if action == Some("export") => "team.graph.export",
        "/api/team/graph" => "team.graph.update",
        "/api/team/skill" => match body
            .as_ref()
            .and_then(|body| body.get("operation"))
            .and_then(Value::as_str)
        {
            Some("team.skill.authorize") => "team.skill.authorize",
            Some("team.skill.validate") => "team.skill.validate",
            Some("team.skill.dependency-plan") => "team.skill.dependency-plan",
            Some("team.skill.materialize") => "team.skill.materialize",
            _ => "team.skill.invalid",
        },
        "/api/team/manual-materialize-and-create" => "team.manual.materialize-and-create",
        "/api/team/trigger" if action == Some("list") => "team.trigger.list",
        "/api/team/trigger" => "team.trigger.fire",
        "/api/team/webhook-auth" => "team.webhook-auth.read",
        _ => return None,
    })
}

impl OrganizationCallDetail {
    fn team_reference(&mut self, value: &str) {
        self.team_id = safe_reference(value);
        self.team_id_hash = self.team_id.is_none().then(|| format!("{:x}", Sha256::digest(value.as_bytes())));
    }

    fn run_reference(&mut self, value: &str) {
        self.run_id = safe_run_reference(value);
        self.run_id_hash = self.run_id.is_none().then(|| format!("{:x}", Sha256::digest(value.as_bytes())));
    }

    fn status(&self) -> CallStatus {
        if [self.provision.as_ref(), self.creation.as_ref()].into_iter().flatten().any(|provision| {
            matches!(provision.commit, Some(ProvisionCommit::OutcomeUnknown))
                || (matches!(provision.commit, Some(ProvisionCommit::Committed))
                    && provision.native_installed.is_none())
        }) {
            return CallStatus::Unknown;
        }
        match self.outcome {
            Some(OrganizationCallOutcome::OutcomeUnknown) => CallStatus::Unknown,
            Some(OrganizationCallOutcome::Unavailable) => CallStatus::Failed,
            Some(OrganizationCallOutcome::Rejected) => CallStatus::Rejected,
            Some(_) => CallStatus::Succeeded,
            None => CallStatus::Unknown,
        }
    }
}

fn single_stage(request: &Request, runtime_route: bool) -> bool {
    if !runtime_route {
        let path = request.path().split('?').next().unwrap_or_default();
        let body = serde_json::from_slice::<Value>(&request.body).ok();
        if path == "/api/team/manual-materialize-and-create"
            || (path == "/api/team/skill" && body.as_ref().and_then(|body| body.get("operation")).and_then(Value::as_str) == Some("team.skill.materialize"))
            || (path == "/api/team/lifecycle" && body.as_ref().is_some_and(|body| body.get("action").and_then(Value::as_str) == Some("delete") && body.get("runId").is_some()))
        { return false; }
        return matches!(
            request.path().split('?').next(),
            Some(
                "/api/team/public"
                    | "/api/team/role-sessions"
                    | "/api/team/approvals"
                    | "/api/team/task-board"
                    | "/api/team/decision"
                    | "/api/team/lifecycle"
                    | "/api/team/skill"
                    | "/api/team/trigger"
                    | "/api/team/manual-materialize-and-create"
            )
        ) || (request.path() == "/api/team/graph"
            && serde_json::from_slice::<Value>(&request.body)
                .ok()
                .and_then(|body| {
                    body.get("action")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                == Some("export"));
    }
    let body = serde_json::from_slice::<Value>(&request.body).ok();
    matches!(
        body.as_ref()
            .and_then(|body| body.get("operationId"))
            .and_then(Value::as_str),
        Some(
            "team.packageValidate"
                | "team.dependencyPlan"
                | "team.runList"
                | "team.triggerList"
                | "team.webhookTriggerFire"
                | "team.graphSave"
                | "team.graphPatch"
                | "team.graphExportYaml"
                | "team.graphImportYaml"
                | "team.graphContext"
                | "team.triggerFire"
                | "team.nodeEvent"
                | "team.runDecisionSubmit"
                | "team.runStartConfirm"
                | "team.proposalConfirm"
                | "team.runStartContinue"
                | "team.proposalContinue"
                | "team.proposalCancel"
                | "team.runStartReject"
                | "team.nodePromptRetryDue"
                | "team.runDiagnostics"
                | "team.approvalResolve"
                | "team.runCancel"
        )
    )
}

pub(crate) fn runtime_single_stage(command: &crate::TeamRuntimeCommand) -> bool {
    use crate::TeamRuntimeCommand::*;
    !matches!(
        command,
        ProvisionAgents { .. } | Delete { .. } | RunCreate { .. } | RunSnapshot { .. } | Resume { .. } | RunDelete { .. }
    )
}
