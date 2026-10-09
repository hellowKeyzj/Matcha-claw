use super::*;
use crate::{
    SessionHandle, SessionOps,
    abort::SessionAbortCommand,
    create::SessionAdmission,
    ports::{OwnedRuntimeFuture, SessionFuture, SessionOwnershipQuery, SessionOwnershipReader},
    state::{ItemStatus, SessionContent, SessionItem},
};
use foundation::{
    execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeHandle, OwnerRuntimeSystem},
    process::supervision::{
        RestartOutcome, StartOutcome, SupervisorSnapshot, TerminationCompletion,
    },
};
use provider_module::{
    ProviderCascade, ProviderConfigOps, ProviderModelDiscoveryOps, ProviderOwnerInput,
    ProviderPrivateProjectionOps, ProviderRuntimeDirectory, ProviderRuntimeIdentityOps,
};
use runtime_directory::{RuntimeLifecycleFailure, RuntimeStartFailure};
use tokio::sync::{Notify, mpsc, oneshot, watch};

const SESSION: &str = "agent:reviewer:terminal-test";
const NATIVE_RUN: &str = "peer-accepted-run";

struct NativeBoundary {
    entered: mpsc::Sender<()>,
    release: Notify,
    outcome: StdMutex<SessionSendOutcome>,
}

impl RuntimeDriver for NativeBoundary {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::open_claw()
    }
    fn session_ops(&self) -> Option<&dyn SessionOps> {
        Some(self)
    }
    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl LifecycleOps for NativeBoundary {
    fn readiness(&self) -> bool {
        true
    }
    fn snapshot(&self) -> SupervisorSnapshot {
        panic!("unused lifecycle boundary")
    }
    fn subscribe(&self) -> watch::Receiver<SupervisorSnapshot> {
        panic!("unused lifecycle boundary")
    }
    fn start(&self) -> OwnedRuntimeFuture<Result<StartOutcome, RuntimeStartFailure>> {
        panic!("unused lifecycle boundary")
    }
    fn stop(&self) -> OwnedRuntimeFuture<Result<TerminationCompletion, RuntimeLifecycleFailure>> {
        panic!("unused lifecycle boundary")
    }
    fn restart(&self) -> OwnedRuntimeFuture<Result<RestartOutcome, RuntimeLifecycleFailure>> {
        panic!("unused lifecycle boundary")
    }
}

impl SessionOps for NativeBoundary {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::new(self.endpoint(), SessionProvider::OpenClaw)
    }
    fn abort_session<'a>(
        &'a self,
        _: SessionAbortCommand,
    ) -> SessionFuture<'a, SessionAbortOutcome> {
        panic!("unused native boundary")
    }
    fn create_session<'a>(
        &'a self,
        _: SessionCreateCommand,
        _: u64,
    ) -> SessionFuture<'a, SessionCreateOutcome> {
        panic!("unused native boundary")
    }
    fn select_session_model<'a>(
        &'a self,
        _: ResolvedSessionModelSelection,
    ) -> SessionFuture<'a, SessionModelSelectionOutcome> {
        panic!("unused native boundary")
    }
    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> SessionFuture<'a, SessionSendOutcome> {
        Box::pin(async move {
            assert_eq!(command.requested_run_id(), Some("requested-run"));
            self.entered.send(()).await.unwrap();
            self.release.notified().await;
            self.outcome.lock().unwrap().clone()
        })
    }
}

struct Directory(Arc<NativeBoundary>);
impl SessionRuntimeDirectory for Directory {
    fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<Arc<dyn RuntimeDriver>> {
        (endpoint == &self.0.endpoint()).then(|| self.0.clone() as Arc<dyn RuntimeDriver>)
    }
}
impl ProviderRuntimeDirectory for Directory {
    fn provider_config_ops(&self) -> Vec<&dyn ProviderConfigOps> {
        Vec::new()
    }
    fn provider_model_discovery_ops(&self) -> Option<&dyn ProviderModelDiscoveryOps> {
        None
    }
    fn provider_runtime_identity_ops(&self) -> Option<&dyn ProviderRuntimeIdentityOps> {
        None
    }
    fn provider_private_projection_ops(&self) -> Option<&dyn ProviderPrivateProjectionOps> {
        None
    }
}

struct MissingOwnershipReader;
impl SessionOwnershipReader for MissingOwnershipReader {
    fn lookup<'a>(
        &'a self,
        _: Vec<SessionOwnershipQuery>,
    ) -> SessionFuture<
        'a,
        Option<
            std::collections::HashMap<
                platform::endpoint::runtime_address::SessionIdentity,
                SessionSourceBinding,
            >,
        >,
    > {
        Box::pin(async { None })
    }
}

#[derive(Default)]
struct TerminalBoundary(StdMutex<Vec<SessionRunTerminalSnapshot>>);
impl SessionTerminalHook for TerminalBoundary {
    fn run_terminal(&self, snapshot: SessionRunTerminalSnapshot) {
        self.0.lock().unwrap().push(snapshot);
    }
}

struct Harness {
    system: OwnerRuntimeSystem,
    provider_task: OwnedTask<()>,
    session_task: OwnedTask<()>,
    owner: OwnerRuntimeHandle<SessionCommand, SessionQuery>,
    handle: SessionHandle,
    snapshot: Arc<ArcSwap<SessionSnapshot>>,
    native: Arc<NativeBoundary>,
    entered: mpsc::Receiver<()>,
    terminals: Arc<TerminalBoundary>,
    root: std::path::PathBuf,
}

impl Harness {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "sessions-terminal-{}-{}",
            std::process::id(),
            next_session_epoch()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let system = OwnerRuntimeSystem::spawn(OwnerRuntimeConfig::default());
        let (entered_tx, entered) = mpsc::channel(1);
        let native = Arc::new(NativeBoundary {
            entered: entered_tx,
            release: Notify::new(),
            outcome: StdMutex::new(SessionSendOutcome::Queued {
                run_id: NATIVE_RUN.into(),
            }),
        });
        let directory = Arc::new(Directory(native.clone()));
        let (provider, provider_task) = provider_module::spawn_owner(
            &system,
            ProviderOwnerInput {
                cascade: ProviderCascade::open(
                    root.join("accounts"),
                    root.join("models"),
                    root.join("routing"),
                    root.join("journal"),
                )
                .unwrap(),
                runtime_directory: directory.clone(),
            },
        );
        let terminals = Arc::new(TerminalBoundary::default());
        let (session, snapshot) = SessionOwner::new(
            directory.clone(),
            Arc::new(MissingOwnershipReader),
            provider.handle().clone(),
            None,
            Some(terminals.clone()),
        );
        let (owner, session_task) = system.spawn_owner(
            session,
            OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
        );
        let handle = SessionHandle::new(owner.clone(), directory);
        assert!(matches!(
            handle
                .ensure_bound_session(identity(), source())
                .await
                .unwrap(),
            SessionEnsureOutcome::Created(_)
        ));
        Self {
            system,
            provider_task,
            session_task,
            owner,
            handle,
            snapshot,
            native,
            entered,
            terminals,
            root,
        }
    }

    async fn begin_send(
        &mut self,
        context: Option<SessionDeliveryContext>,
    ) -> oneshot::Receiver<SessionSendOutcome> {
        let mut command = SessionSendCommand::try_new(
            NativeEndpoint::OpenClawLocal,
            SESSION.into(),
            None,
            "renderer-route:test".into(),
            "review".into(),
            Some("requested-run".into()),
            None,
            None,
            Vec::new(),
            None,
        )
        .unwrap()
        .with_source_binding(source());
        command.delivery_context = context;
        let (reply, response) = oneshot::channel();
        self.owner
            .command(SessionCommand::Send {
                request: SessionSendRequest::Session { command, reply },
            })
            .await
            .unwrap();
        self.entered.recv().await.unwrap();
        response
    }

    fn state(&self) -> SessionState {
        self.snapshot.load().states[&session_lane_key(SessionProvider::OpenClaw, SESSION)].clone()
    }

    async fn finish(mut self) {
        self.session_task.cancel_and_join().await.unwrap();
        self.provider_task.cancel_and_join().await.unwrap();
        self.system.cancel_and_join().await.unwrap();
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn identity() -> SessionIdentity {
    SessionIdentity::new(SESSION, SessionProvider::OpenClaw, Some("reviewer".into())).unwrap()
}

fn source() -> SessionSourceBinding {
    SessionSourceBinding::team_from_receipt(&organization::RoleSessionReceipt::new(
        organization::TeamId::try_new("team-test").unwrap(),
        organization::GraphRunId::new("graph-run"),
        organization::RoleId::try_new("reviewer").unwrap(),
        organization::RoleSessionRef::initial(),
        organization::ManagedAgentReference::try_new("reviewer").unwrap(),
        organization::RuntimeEndpointReference::try_new("openclaw:local").unwrap(),
    ))
}

fn context() -> SessionDeliveryContext {
    SessionDeliveryContext {
        delivery_id: organization::DeliveryId::new("delivery-private").unwrap(),
        endpoint_session_id: organization::EndpointSessionId::try_new("endpoint-private").unwrap(),
    }
}

fn event(phase: RunPhase, text: Option<&str>) -> SessionEvent {
    let mut changes = Vec::new();
    if let Some(text) = text {
        changes.push(SessionChange::MessageUpdated {
            item: SessionItem::AssistantTurn {
                item_id: "assistant-item".into(),
                run_id: Some(NATIVE_RUN.into()),
                message_id: Some("assistant-message".into()),
                status: ItemStatus::Streaming,
                segments: vec![SessionContent::Text { text: text.into() }],
                text: text.into(),
            },
        });
    }
    changes.push(SessionChange::RunPhaseChanged {
        run_id: NATIVE_RUN.into(),
        phase,
    });
    SessionEvent {
        binding: SessionEventBinding::new(SESSION, Some("renderer-route:test".into()), None)
            .unwrap(),
        run_id: Some(NATIVE_RUN.into()),
        cursor: None,
        history_refresh: false,
        changes,
    }
}

#[tokio::test]
async fn send_binds_actual_native_run_before_early_terminal_and_preserves_optional_text() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for (phase, text) in [
            (RunPhase::Completed, Some("native final answer")),
            (RunPhase::Completed, None),
            (RunPhase::Failed, None),
            (RunPhase::Cancelled, None),
            (RunPhase::Interrupted, None),
        ] {
            let mut harness = Harness::new().await;
            let mut accepted = harness.begin_send(Some(context())).await;
            let (reply, terminal) = oneshot::channel();
            // Ingress is admitted while native send is still awaiting its acceptance receipt.
            harness
                .owner
                .command(SessionCommand::Ingest {
                    identity: identity(),
                    event: event(phase, text),
                    reply,
                })
                .await
                .unwrap();
            assert!(matches!(
                accepted.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            harness.native.release.notify_one();
            assert_eq!(
                accepted.await.unwrap(),
                SessionSendOutcome::Queued {
                    run_id: NATIVE_RUN.into()
                }
            );
            assert!(matches!(
                terminal.await.unwrap(),
                SessionIngestOutcome::Applied(_)
            ));
            {
                let terminals = harness.terminals.0.lock().unwrap();
                assert_eq!(terminals.len(), 1);
                assert_eq!(terminals[0].native_run_id, NATIVE_RUN);
                assert_eq!(terminals[0].delivery_context, Some(context()));
                assert_eq!(terminals[0].phase, phase);
                assert_eq!(terminals[0].final_assistant_text.as_deref(), text);
            }
            assert!(harness.state().run_delivery_contexts.is_empty());
            assert!(matches!(
                harness
                    .handle
                    .ingest_event(identity(), event(phase, None))
                    .await
                    .unwrap(),
                SessionIngestOutcome::Rejected { .. }
            ));
            assert_eq!(harness.terminals.0.lock().unwrap().len(), 1);
            harness.finish().await;
        }
    })
    .await
    .expect("session lane must not await terminal settlement");
}

#[tokio::test]
async fn repeated_accepted_run_retains_context_without_public_projection_leak() {
    let mut harness = Harness::new().await;
    let first = harness.begin_send(None).await;
    harness.native.release.notify_one();
    first.await.unwrap();
    let before = harness.state();
    let second = harness.begin_send(Some(context())).await;
    harness.native.release.notify_one();
    second.await.unwrap();
    let after = harness.state();
    assert!(
        after.seq() > before.seq(),
        "equal RuntimeChanged is still an accepted delta"
    );
    assert_eq!(
        after.run_delivery_contexts.get(NATIVE_RUN),
        Some(&context())
    );
    assert!(!after.run_delivery_contexts.contains_key("requested-run"));
    let public = serde_json::to_string(&after.view()).unwrap();
    for private in [
        "delivery-private",
        "endpoint-private",
        "deliveryContext",
        "runDeliveryContexts",
    ] {
        assert!(!public.contains(private));
    }
    let rehydrated = state_from_view_seeded(&after.view(), Some(&after)).unwrap();
    assert_eq!(
        rehydrated.run_delivery_contexts.get(NATIVE_RUN),
        Some(&context())
    );
    harness.handle.evict_session(SESSION.into()).await.unwrap();
    assert!(harness.snapshot.load().states.is_empty());
    harness.finish().await;
}

#[tokio::test]
async fn rejected_send_does_not_retain_delivery_context() {
    let mut harness = Harness::new().await;
    *harness.native.outcome.lock().unwrap() = SessionSendOutcome::Rejected;
    let response = harness.begin_send(Some(context())).await;
    harness.native.release.notify_one();
    assert_eq!(response.await.unwrap(), SessionSendOutcome::Rejected);
    assert!(harness.state().run_delivery_contexts.is_empty());
    harness.finish().await;
}

#[test]
fn hydrated_terminal_uses_pending_context_once_and_history_keeps_none() {
    let mut pending = SessionState::new(identity(), 1)
        .unwrap()
        .with_source_binding(source());
    pending
        .run_delivery_contexts
        .insert(NATIVE_RUN.into(), context());
    let mut hydrated = SessionState::new(identity(), 1).unwrap();
    let event = event(RunPhase::Completed, Some("hydrated answer"));
    assert!(matches!(
        hydrated.apply_native_bound(event.binding, event.run_id, event.cursor, event.changes),
        crate::state::SessionApplyResult::Applied(_)
    ));
    let mut state = state_from_view_seeded(&hydrated.view(), Some(&pending)).unwrap();
    let first = SessionShared::hydrated_terminal_snapshots(&mut state);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].delivery_context, Some(context()));
    assert_eq!(
        first[0].final_assistant_text.as_deref(),
        Some("hydrated answer")
    );
    assert!(state.run_delivery_contexts.is_empty());
    let history = SessionShared::hydrated_terminal_snapshots(&mut state);
    assert_eq!(history[0].delivery_context, None);
}
