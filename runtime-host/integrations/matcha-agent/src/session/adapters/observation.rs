use std::sync::{Arc, Mutex};

use foundation::execution::OwnedTask;
use serde_json::{Value, json};
use sessions_module::{
    RuntimeOperationFailure, SessionFuture, SessionObservation, SessionObservationRequest,
    SessionSync, SessionSyncCut,
    command::{SessionEvent, SessionIngressEvent},
    ports::{ItemsSyncMode, OwnedRuntimeFuture},
    state::{
        ApprovalPhase, ApprovalView, MissingFact, RecoveryReason, SessionApplyResult,
        SessionChange, SessionEventBinding, SessionFact, SessionState,
    },
    timeline,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    client::{Client, Event, Subscription},
    peer::MatchaPeerSessionHandle,
    session::{
        events, interaction,
        model::{RunStatus, SessionId, valid_uuid},
        projection::{Streaming, parse_session_key},
        rpc::{self, Failure},
    },
};

struct SyncRequest {
    command: timeline::Command,
    epoch: u64,
    reply: oneshot::Sender<Result<SessionSync, RuntimeOperationFailure>>,
}
struct Observation {
    session: MatchaPeerSessionHandle,
    events: mpsc::Sender<SessionIngressEvent>,
    request: SessionObservationRequest,
    native_id: SessionId,
    receive: Arc<Mutex<Option<ObservationRun>>>,
}
struct ObservationRun {
    requests: mpsc::Sender<SyncRequest>,
    task: Option<OwnedTask<()>>,
}

fn spawn_observation(
    session: MatchaPeerSessionHandle,
    events: mpsc::Sender<SessionIngressEvent>,
    request: SessionObservationRequest,
    native_id: SessionId,
) -> ObservationRun {
    let (requests, receiver) = mpsc::channel(8);
    let (task, _) =
        OwnedTask::spawn(move |cancel| run(session, events, request, native_id, receiver, cancel));
    ObservationRun {
        requests,
        task: Some(task),
    }
}
pub(super) fn prepare(
    session: MatchaPeerSessionHandle,
    events: Option<mpsc::Sender<SessionIngressEvent>>,
    request: SessionObservationRequest,
) -> Result<Arc<dyn SessionObservation>, RuntimeOperationFailure> {
    let events = events.ok_or(RuntimeOperationFailure::Unavailable)?;
    let native_id = SessionId::try_new(
        request
            .endpoint_session_id
            .clone()
            .ok_or(RuntimeOperationFailure::TargetRejected)?,
    )
    .map_err(|_| RuntimeOperationFailure::TargetRejected)?;
    if request.identity.validate().is_err()
        || request.identity.endpoint.runtime_instance_id != "local"
        || request.identity.endpoint.kind != "native-runtime"
        || request.identity.provider() != sessions_module::state::SessionProvider::MatchaAgent
        || parse_session_key(&request.identity.session_key)
            != Some((request.identity.agent_id.as_str(), native_id.as_str()))
        || SessionEventBinding::observed(request.identity.clone(), request.generation, None, true)
            .is_none()
    {
        return Err(RuntimeOperationFailure::TargetRejected);
    }
    let receive = spawn_observation(
        session.clone(),
        events.clone(),
        request.clone(),
        native_id.clone(),
    );
    Ok(Arc::new(Observation {
        session,
        events,
        request,
        native_id,
        receive: Arc::new(Mutex::new(Some(receive))),
    }))
}
impl SessionObservation for Observation {
    fn items_sync_mode(&self) -> ItemsSyncMode {
        ItemsSyncMode::Replace
    }
    fn sync<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> SessionFuture<'a, Result<SessionSync, RuntimeOperationFailure>> {
        Box::pin(async move {
            let requests = self
                .receive
                .lock()
                .expect("observation receive lock is not poisoned")
                .as_ref()
                .filter(|receive| receive.task.is_some())
                .map(|receive| receive.requests.clone())
                .ok_or(RuntimeOperationFailure::Unavailable)?;
            let (reply, received) = oneshot::channel();
            requests
                .send(SyncRequest {
                    command,
                    epoch,
                    reply,
                })
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?;
            received
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?
        })
    }
    fn restart(&self, generation: u64) -> OwnedRuntimeFuture<Result<(), RuntimeOperationFailure>> {
        if SessionEventBinding::observed(self.request.identity.clone(), generation, None, true)
            .is_none()
        {
            return Box::pin(async { Err(RuntimeOperationFailure::TargetRejected) });
        }
        let task = self
            .receive
            .lock()
            .expect("observation receive lock is not poisoned")
            .as_mut()
            .and_then(|receive| receive.task.take());
        let Some(mut task) = task else {
            return Box::pin(async { Err(RuntimeOperationFailure::Unavailable) });
        };
        task.cancel();
        let receive = self.receive.clone();
        let session = self.session.clone();
        let events = self.events.clone();
        let mut request = self.request.clone();
        request.generation = generation;
        let native_id = self.native_id.clone();
        Box::pin(async move {
            task.join()
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?;
            let mut receive = receive
                .lock()
                .expect("observation receive lock is not poisoned");
            *receive
                .as_mut()
                .ok_or(RuntimeOperationFailure::Unavailable)? =
                spawn_observation(session, events, request, native_id);
            Ok(())
        })
    }
    fn close(&self) -> OwnedRuntimeFuture<()> {
        let task = self
            .receive
            .lock()
            .expect("observation receive lock is not poisoned")
            .take()
            .and_then(|receive| receive.task);
        if let Some(task) = &task {
            task.cancel();
        }
        Box::pin(async move {
            if let Some(mut task) = task {
                let _ = task.join().await;
            }
        })
    }
}

struct Projection {
    request: SessionObservationRequest,
    native_id: SessionId,
    source_epoch: u64,
    cursor: u64,
    streaming: Streaming,
    state: SessionState,
}
impl Projection {
    fn new(request: SessionObservationRequest, native_id: SessionId, source_epoch: u64) -> Self {
        let state = SessionState::new(request.identity.clone(), 1)
            .and_then(|state| state.with_goal(sessions_module::goal::SessionGoalView::Unsupported))
            .and_then(|state| state.with_endpoint_session_id(Some(native_id.as_str().to_owned())))
            .expect("validated observation identity");
        Self {
            request,
            native_id,
            source_epoch,
            cursor: 0,
            streaming: Streaming::default(),
            state,
        }
    }
    fn binding(&self) -> SessionEventBinding {
        SessionEventBinding::observed(
            self.request.identity.clone(),
            self.request.generation,
            Some(self.source_epoch),
            true,
        )
        .expect("validated observation binding")
    }
    async fn consume(
        &mut self,
        event: Event,
        output: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
    ) -> Result<(), RuntimeOperationFailure> {
        if event.session_id != self.native_id.as_str()
            || event.seq != self.cursor + 1
            || event.seq > sessions_module::state::MAX_SAFE_INTEGER
            || event.at_ms > sessions_module::state::MAX_SAFE_INTEGER
            || event.run_id.as_deref().is_some_and(|run| !valid_uuid(run))
        {
            return Err(RuntimeOperationFailure::Unknown);
        }
        let projected =
            events::project(&mut self.streaming, &event, &self.state.view()).map_err(failure)?;
        let binding = self.binding();
        let mut candidate = self.state.clone();
        candidate
            .reserve_observation_capacity(&projected.changes)
            .map_err(|_| RuntimeOperationFailure::Unknown)?;
        match candidate.apply_native_bound(
            binding.clone(),
            event.run_id.clone(),
            Some(event.seq),
            projected.changes.clone(),
        ) {
            SessionApplyResult::Applied(_) | SessionApplyResult::Consumed { .. } => {}
            _ => return Err(RuntimeOperationFailure::Unknown),
        }
        let (ingress, receipt) = SessionIngressEvent::new(
            self.request.identity.clone(),
            SessionEvent {
                binding,
                run_id: event.run_id,
                cursor: Some(event.seq),
                history_refresh: projected.history_refresh,
                changes: projected.changes,
            },
        )
        .with_receipt();
        tokio::select! { _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable), result = output.send(ingress) => result.map_err(|_| RuntimeOperationFailure::Unavailable)?, }
        let accepted = tokio::select! { _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable), result = receipt => result.map_err(|_| RuntimeOperationFailure::Unavailable)?, };
        if !accepted {
            return Err(RuntimeOperationFailure::Unknown);
        }
        platform::trace::runtime_trace(
            "matcha.session.event_consumed",
            || json!({"sessionHash":platform::trace::identifier_hash(self.native_id.as_str()),"nativeSeq":event.seq,"sourceEpoch":self.source_epoch,"runtimeKnown":candidate.view().runtime != SessionFact::Unknown}),
        );
        self.cursor = event.seq;
        self.state = candidate;
        Ok(())
    }
    async fn sync(
        &mut self,
        client: &Client,
        subscription: &mut Subscription,
        command: timeline::Command,
        epoch: u64,
        output: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
    ) -> Result<SessionSync, RuntimeOperationFailure> {
        if command.identity() != &self.request.identity
            || command.endpoint_session_id() != Some(self.native_id.as_str())
        {
            return Err(RuntimeOperationFailure::TargetRejected);
        }
        // The subscription is already installed. Drain it while independent history and
        // control reads run, rather than accumulating a second transcript/event queue.
        let native_id = self.native_id.as_str().to_owned();
        // Finish durable replay that predates the history read. Subsequent events
        // are concurrent native facts, not rows silently retired by a stale page.
        let frontier_read = frontier(client, &native_id);
        tokio::pin!(frontier_read);
        let initial = loop {
            tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable),
                result = &mut frontier_read => break result.map_err(failure)?,
                event = subscription.recv() => self.consume(event.map_err(|_| RuntimeOperationFailure::Unavailable)?, output, cancel).await?,
            }
        };
        while self.cursor < initial {
            let event = tokio::select! { _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable), event = subscription.recv() => event.map_err(|_| RuntimeOperationFailure::Unavailable)?, };
            self.consume(event, output, cancel).await?;
        }
        let baseline = self.state.clone();
        let read = async {
            let mut view = super::timeline::read(client, &command, epoch).await?;
            let runs = super::runtime::runs(client, &native_id).await?;
            let approvals = interaction::pending(client, &native_id, "approvals").await?;
            let mut approval_views = Vec::new();
            for item in approvals {
                if item.availability == sessions_module::question::QuestionAvailability::Pending
                    && item.delivery == sessions_module::question::QuestionDelivery::NotSent
                {
                    approval_views.push(ApprovalView {
                        approval_id: item.approval_id()?,
                        run_id: item.run_id.clone(),
                        phase: ApprovalPhase::Requested,
                        option_ids: vec!["allow".into(), "deny".into()],
                    });
                }
            }
            view.approvals = SessionFact::Complete(approval_views);
            if let Some(run) = runs
                .iter()
                .find(|run| {
                    matches!(
                        run.status,
                        RunStatus::Starting | RunStatus::Running | RunStatus::CancelRequested
                    )
                })
                .or_else(|| runs.iter().find(|run| !run.status.terminal()))
                .or_else(|| runs.first())
            {
                view.runtime = SessionFact::Incomplete {
                    facts: events::runtime(
                        run.status,
                        (!run.status.terminal()).then(|| run.run_id.clone()),
                    ),
                    gaps: vec![MissingFact::PartialRuntime],
                };
            }
            // This is only an event frontier oracle, not an atomic history snapshot.
            let target = frontier(client, &native_id).await?;
            Ok::<_, Failure>((view, target))
        };
        tokio::pin!(read);
        let (mut view, target) = loop {
            tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable),
                result = &mut read => break result.map_err(failure)?,
                event = subscription.recv() => self.consume(event.map_err(|_| RuntimeOperationFailure::Unavailable)?, output, cancel).await?,
            }
        };
        while self.cursor < target {
            let event = tokio::select! { _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable), event = subscription.recv() => event.map_err(|_| RuntimeOperationFailure::Unavailable)?, };
            self.consume(event, output, cancel).await?;
        }
        // Event facts are consumed, but history can be ahead of or behind them. UUID
        // identity and the shared reconciler preserve concurrent facts without run guesses.
        let replay = self.state.view();
        if !matches!(
            replay.runtime,
            SessionFact::Unknown | SessionFact::Unavailable
        ) {
            view.runtime = replay.runtime.clone();
        }
        let mut sync = SessionSync {
            view,
            source_epoch: Some(self.source_epoch),
            source_branch: None,
            cut: SessionSyncCut::EventFrontier {
                cursor: self.cursor,
                contiguous: true,
            },
            replay_baseline: Some(replay),
            terminal_runs: Vec::new(),
            retired_item_ids: Vec::new(),
            retired_tool_ids: Vec::new(),
            retired_approval_ids: Vec::new(),
        };
        let replay = sync.replay_baseline.take();
        sync.view = self
            .state
            .reconcile_sync(&sync, &baseline, ItemsSyncMode::Replace)
            .map_err(|_| RuntimeOperationFailure::Unknown)?;
        sync.replay_baseline = replay;
        sync.view.epoch = epoch;
        Ok(sync)
    }
}
async fn run(
    session: MatchaPeerSessionHandle,
    output: mpsc::Sender<SessionIngressEvent>,
    request: SessionObservationRequest,
    native_id: SessionId,
    mut requests: mpsc::Receiver<SyncRequest>,
    cancel: CancellationToken,
) {
    // Sessions installs the observation generation before its first sync admits IO.
    let first =
        tokio::select! { _ = cancel.cancelled() => return, request = requests.recv() => request, };
    let Some(first) = first else {
        return;
    };
    let mut projection = Projection::new(request, native_id, session.observer_source_epoch());
    let client = session.native_client();
    let admitted = tokio::select! {
        _ = cancel.cancelled() => return,
        result = rpc::bound(&client, &projection.request.identity, Some(projection.native_id.as_str())) => result,
    };
    if let Err(error) = admitted {
        let _ = first.reply.send(Err(failure(error)));
        return;
    }
    let subscribed = tokio::select! { _ = cancel.cancelled() => return, result = client.subscribe(projection.native_id.as_str(), 0) => result, };
    let mut subscription = match subscribed {
        Ok(subscription) => subscription,
        Err(_) => {
            let _ = first.reply.send(Err(RuntimeOperationFailure::Unavailable));
            unavailable(&output, &projection, &cancel).await;
            return;
        }
    };
    let result = projection
        .sync(
            &client,
            &mut subscription,
            first.command,
            first.epoch,
            &output,
            &cancel,
        )
        .await;
    let mut failed = result.is_err();
    let _ = first.reply.send(result);
    while !failed {
        tokio::select! {
            _ = cancel.cancelled() => break,
            event = subscription.recv() => match event {
                Ok(event) => failed = projection.consume(event, &output, &cancel).await.is_err(),
                Err(_) => failed = true,
            },
            request = requests.recv() => {
                let Some(request) = request else { break; };
                let result = projection.sync(&client, &mut subscription, request.command, request.epoch, &output, &cancel).await;
                failed = result.is_err(); let _ = request.reply.send(result);
            },
        }
    }
    if failed && !cancel.is_cancelled() {
        unavailable(&output, &projection, &cancel).await;
    }
    // This owns only observation IO. It never closes a session, cancels a run, or
    // shuts down the shared control client.
    let _ = subscription.close().await;
}
async fn unavailable(
    output: &mpsc::Sender<SessionIngressEvent>,
    projection: &Projection,
    cancel: &CancellationToken,
) {
    let event = SessionIngressEvent::new(
        projection.request.identity.clone(),
        SessionEvent {
            binding: projection.binding(),
            run_id: None,
            cursor: None,
            history_refresh: false,
            changes: vec![SessionChange::RecoveryRequired {
                reason: RecoveryReason::NativeUnavailable,
            }],
        },
    );
    tokio::select! { _ = cancel.cancelled() => {}, _ = output.send(event) => {}, }
}
async fn frontier(client: &Client, id: &str) -> Result<u64, Failure> {
    let value = rpc::call(
        client,
        "events.replay",
        json!({"sessionId":id,"afterSeq":0,"limit":0}),
    )
    .await?;
    if value.get("sessionId").and_then(Value::as_str) != Some(id)
        || value
            .get("events")
            .and_then(Value::as_array)
            .is_none_or(|events| !events.is_empty())
    {
        return Err(Failure::InvalidReadback);
    }
    value
        .get("latestSeq")
        .and_then(Value::as_u64)
        .filter(|seq| *seq <= sessions_module::state::MAX_SAFE_INTEGER)
        .ok_or(Failure::InvalidReadback)
}
fn failure(error: Failure) -> RuntimeOperationFailure {
    match error.kind() {
        rpc::FailureKind::Rejected => RuntimeOperationFailure::TargetRejected,
        rpc::FailureKind::Unknown => RuntimeOperationFailure::Unknown,
        _ => RuntimeOperationFailure::Unavailable,
    }
}
