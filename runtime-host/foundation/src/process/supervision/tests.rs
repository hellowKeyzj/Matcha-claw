use std::{
    collections::VecDeque,
    ffi::OsString,
    future::{pending, poll_fn},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::Poll,
    time::{Duration, SystemTime},
};

use tokio::sync::{Notify, Semaphore, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::super::{
    AuthorityScope, ExitObservation, FixedLaunch, LaunchAttempt, LaunchAttemptCleanupFailure,
    LaunchAttemptFuture, LaunchAttemptGuard, LaunchAttemptMaterializer, LaunchSpec,
    ProcessIdentity, ProcessObservation, ProcessStdio, Provenance, ScopeId, ShutdownOutcome,
    StdioActivationResult, StdioDrain, StdioDrainResult, StdioMode, StdioSpec, TerminationFailure,
    TerminationOutcome,
    resource::{
        NativeAdapter, NativeCleanupResult, NativeDetachResult, NativeFuture, NativeInstallResult,
        NativePollResult, NativeStdio, ResourceRuntime,
    },
};
use super::{
    CommandReceipt, Completion, CompletionError, GracefulStop, GracefulStopResult, PolicyFuture,
    ReadinessProbe, ReadinessResult, RestartDecision, RestartEpisode, RestartOutcome,
    RestartPolicy, StartOutcome, StartRecovery, StartRecoveryResult, StdioActivation, Supervisor,
    SupervisorFailure, SupervisorHandle, SupervisorPhase, SupervisorRejection,
    TerminationCompletion,
    dispatch::{Command, ControlCommand, Ingress},
};

#[derive(Clone, Debug, Eq, PartialEq)]
enum AttemptEvent {
    Materialized(&'static str),
    Installed(OsString),
    CleanupStarted,
    CleanupReturned,
}

#[derive(Clone)]
pub(super) struct FakeAdapter {
    state: Arc<FakeState>,
}

struct FakeState {
    install: Mutex<VecDeque<NativeInstallResult>>,
    install_permits: Semaphore,
    install_called: Notify,
    install_calls: AtomicUsize,
    installed_markers: Mutex<Vec<OsString>>,
    events: Arc<Mutex<Vec<AttemptEvent>>>,
    poll: Mutex<VecDeque<NativePollResult>>,
    cleanup: Mutex<VecDeque<NativeCleanupResult>>,
    poll_calls: AtomicUsize,
    cleanup_permits: Semaphore,
    cleanup_called: Notify,
    cleanup_calls: AtomicUsize,
    detach: Mutex<VecDeque<NativeDetachResult>>,
    detach_calls: AtomicUsize,
}

impl FakeAdapter {
    pub(super) fn owned(installs: impl IntoIterator<Item = NativeInstallResult>) -> Self {
        Self::new(installs, 32, 32)
    }

    pub(super) fn blocked_install(installs: impl IntoIterator<Item = NativeInstallResult>) -> Self {
        Self::new(installs, 0, 32)
    }

    fn blocked_cleanup(installs: impl IntoIterator<Item = NativeInstallResult>) -> Self {
        Self::new(installs, 32, 0)
    }

    fn new(
        installs: impl IntoIterator<Item = NativeInstallResult>,
        install_permits: usize,
        cleanup_permits: usize,
    ) -> Self {
        Self::with_events(
            installs,
            install_permits,
            cleanup_permits,
            Arc::new(Mutex::new(Vec::new())),
        )
    }

    fn with_events(
        installs: impl IntoIterator<Item = NativeInstallResult>,
        install_permits: usize,
        cleanup_permits: usize,
        events: Arc<Mutex<Vec<AttemptEvent>>>,
    ) -> Self {
        Self {
            state: Arc::new(FakeState {
                install: Mutex::new(installs.into_iter().collect()),
                install_permits: Semaphore::new(install_permits),
                install_called: Notify::new(),
                install_calls: AtomicUsize::new(0),
                installed_markers: Mutex::new(Vec::new()),
                events,
                poll: Mutex::new(VecDeque::new()),
                poll_calls: AtomicUsize::new(0),
                cleanup: Mutex::new(VecDeque::new()),
                cleanup_permits: Semaphore::new(cleanup_permits),
                cleanup_called: Notify::new(),
                cleanup_calls: AtomicUsize::new(0),
                detach: Mutex::new(VecDeque::new()),
                detach_calls: AtomicUsize::new(0),
            }),
        }
    }

    fn allow_install(&self) {
        self.state.install_permits.add_permits(1);
    }

    fn allow_cleanup(&self) {
        self.state.cleanup_permits.add_permits(1);
    }

    pub(super) fn push_poll(&self, result: NativePollResult) {
        self.state.poll.lock().unwrap().push_back(result);
    }

    fn push_cleanup(&self, result: NativeCleanupResult) {
        self.state.cleanup.lock().unwrap().push_back(result);
    }

    fn push_detach(&self, result: NativeDetachResult) {
        self.state.detach.lock().unwrap().push_back(result);
    }

    pub(super) fn install_calls(&self) -> usize {
        self.state.install_calls.load(Ordering::SeqCst)
    }

    fn installed_markers(&self) -> Vec<OsString> {
        self.state.installed_markers.lock().unwrap().clone()
    }

    pub(super) fn poll_calls(&self) -> usize {
        self.state.poll_calls.load(Ordering::SeqCst)
    }

    pub(super) fn cleanup_calls(&self) -> usize {
        self.state.cleanup_calls.load(Ordering::SeqCst)
    }

    fn detach_calls(&self) -> usize {
        self.state.detach_calls.load(Ordering::SeqCst)
    }
}

impl NativeAdapter for FakeAdapter {
    fn install(
        &mut self,
        request: crate::process::launch::LaunchRequest,
    ) -> NativeFuture<'_, NativeInstallResult> {
        let state = self.state.clone();
        let marker = request.spec.arguments().first().cloned().unwrap();
        Box::pin(async move {
            state.installed_markers.lock().unwrap().push(marker.clone());
            state
                .events
                .lock()
                .unwrap()
                .push(AttemptEvent::Installed(marker));
            state.install_calls.fetch_add(1, Ordering::SeqCst);
            state.install_called.notify_waiters();
            state.install_permits.acquire().await.unwrap().forget();
            state.install.lock().unwrap().pop_front().unwrap()
        })
    }

    fn poll(&mut self) -> NativeFuture<'_, NativePollResult> {
        self.state.poll_calls.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .poll
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(NativePollResult::Pending);
        Box::pin(async move { result })
    }

    fn cleanup(&mut self) -> NativeFuture<'_, NativeCleanupResult> {
        let state = self.state.clone();
        Box::pin(async move {
            state.cleanup_calls.fetch_add(1, Ordering::SeqCst);
            state
                .events
                .lock()
                .unwrap()
                .push(AttemptEvent::CleanupStarted);
            state.cleanup_called.notify_waiters();
            state.cleanup_permits.acquire().await.unwrap().forget();
            let result = state
                .cleanup
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| NativeCleanupResult::Terminated(exit(9)));
            state
                .events
                .lock()
                .unwrap()
                .push(AttemptEvent::CleanupReturned);
            result
        })
    }

    fn detach(&mut self) -> NativeFuture<'_, NativeDetachResult> {
        self.state.detach_calls.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .detach
            .lock()
            .unwrap()
            .pop_front()
            .expect("detach result missing");
        Box::pin(async move { result })
    }
}

#[derive(Clone)]
pub(super) struct Ready {
    results: Arc<Mutex<VecDeque<ReadinessResult>>>,
    release: Option<Arc<Notify>>,
    calls: Arc<AtomicUsize>,
}

impl Ready {
    pub(super) fn immediate() -> Self {
        Self::sequence([ReadinessResult::Ready])
    }

    pub(super) fn blocked(result: ReadinessResult) -> (Self, Arc<Notify>) {
        let release = Arc::new(Notify::new());
        (
            Self {
                results: Arc::new(Mutex::new(VecDeque::from([result]))),
                release: Some(release.clone()),
                calls: Arc::new(AtomicUsize::new(0)),
            },
            release,
        )
    }

    pub(super) fn sequence(results: impl IntoIterator<Item = ReadinessResult>) -> Self {
        Self {
            results: Arc::new(Mutex::new(results.into_iter().collect())),
            release: None,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(super) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct PanickingReady;

impl ReadinessProbe for PanickingReady {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        Box::pin(async { panic!("readiness panic") })
    }
}

impl ReadinessProbe for Ready {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = self
            .results
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(ReadinessResult::Ready);
        let release = self.release.clone();
        Box::pin(async move {
            if let Some(release) = release {
                release.notified().await;
            }
            result
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct DrainStdio;

impl StdioActivation for DrainStdio {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (stdin, stdout, stderr) = stdio.into_parts();
            if stdin.is_some() || stdout.is_some() || stderr.is_some() {
                return StdioActivationResult::Unavailable;
            }
            StdioActivationResult::Activated(StdioDrain::new(async { StdioDrainResult::Drained }))
        })
    }
}

#[derive(Clone)]
pub(super) struct GatedStdio {
    activation: Option<StdioActivationFailure>,
    drain: Option<StdioDrainResult>,
    drain_panics: bool,
    drain_started: Arc<Notify>,
    drain_release: Arc<Notify>,
    drain_dropped: Arc<Notify>,
}

#[derive(Clone, Copy)]
pub(super) enum StdioActivationFailure {
    Unavailable,
    Cancelled,
    Panic,
}

impl GatedStdio {
    pub(super) fn drain(result: Option<StdioDrainResult>) -> Self {
        Self {
            activation: None,
            drain: result,
            drain_panics: false,
            drain_started: Arc::new(Notify::new()),
            drain_release: Arc::new(Notify::new()),
            drain_dropped: Arc::new(Notify::new()),
        }
    }

    pub(super) fn activation(failure: StdioActivationFailure) -> Self {
        Self {
            activation: Some(failure),
            drain: None,
            drain_panics: false,
            drain_started: Arc::new(Notify::new()),
            drain_release: Arc::new(Notify::new()),
            drain_dropped: Arc::new(Notify::new()),
        }
    }

    pub(super) fn panicking_drain() -> Self {
        Self {
            activation: None,
            drain: None,
            drain_panics: true,
            drain_started: Arc::new(Notify::new()),
            drain_release: Arc::new(Notify::new()),
            drain_dropped: Arc::new(Notify::new()),
        }
    }

    pub(super) async fn wait_drain_started(&self) {
        self.drain_started.notified().await;
    }

    pub(super) fn release_drain(&self) {
        self.drain_release.notify_one();
    }

    pub(super) async fn wait_drain_dropped(&self) {
        self.drain_dropped.notified().await;
    }
}

struct DrainDropGuard(Arc<Notify>);

impl Drop for DrainDropGuard {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

impl StdioActivation for GatedStdio {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let activation = self.activation;
        let result = self.drain;
        let drain_panics = self.drain_panics;
        let started = self.drain_started.clone();
        let release = self.drain_release.clone();
        let dropped = self.drain_dropped.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (stdin, stdout, stderr) = stdio.into_parts();
            if stdin.is_some() || stdout.is_some() || stderr.is_some() {
                return StdioActivationResult::Unavailable;
            }
            match activation {
                Some(StdioActivationFailure::Unavailable) => StdioActivationResult::Unavailable,
                Some(StdioActivationFailure::Cancelled) => StdioActivationResult::Cancelled,
                Some(StdioActivationFailure::Panic) => panic!("stdio activation panic"),
                None => StdioActivationResult::Activated(StdioDrain::new(async move {
                    let _guard = DrainDropGuard(dropped);
                    started.notify_one();
                    release.notified().await;
                    assert!(!drain_panics, "stdio drain panic");
                    match result {
                        Some(result) => result,
                        None => pending().await,
                    }
                })),
            }
        })
    }
}

#[derive(Clone)]
pub(super) struct Stop {
    period: Duration,
    result: Option<GracefulStopResult>,
    calls: Arc<AtomicUsize>,
}

impl Stop {
    pub(super) fn requested(period: Duration) -> Self {
        Self::new(period, Some(GracefulStopResult::Requested))
    }

    fn rejected(period: Duration) -> Self {
        Self::new(period, Some(GracefulStopResult::Rejected))
    }

    fn blocked(period: Duration) -> Self {
        Self::new(period, None)
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn new(period: Duration, result: Option<GracefulStopResult>) -> Self {
        Self {
            period,
            result,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl GracefulStop for Stop {
    fn grace_period(&self) -> Duration {
        self.period
    }

    fn request_stop(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = self.result;
        Box::pin(async move {
            match result {
                Some(result) => result,
                None => pending().await,
            }
        })
    }
}

#[derive(Clone)]
pub(super) struct Recovery {
    result: StartRecoveryResult,
    calls: Arc<AtomicUsize>,
    failures: Arc<Mutex<Vec<SupervisorFailure>>>,
    release: Option<Arc<Notify>>,
}

impl Recovery {
    pub(super) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub(super) fn fail() -> Self {
        Self::new(StartRecoveryResult::Fail)
    }

    pub(super) fn blocked(result: StartRecoveryResult) -> (Self, Arc<Notify>) {
        let release = Arc::new(Notify::new());
        (
            Self {
                result,
                calls: Arc::new(AtomicUsize::new(0)),
                failures: Arc::new(Mutex::new(Vec::new())),
                release: Some(release.clone()),
            },
            release,
        )
    }

    fn new(result: StartRecoveryResult) -> Self {
        Self {
            result,
            calls: Arc::new(AtomicUsize::new(0)),
            failures: Arc::new(Mutex::new(Vec::new())),
            release: None,
        }
    }
}

impl StartRecovery for Recovery {
    fn recover(
        &self,
        failure: SupervisorFailure,
        _: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.failures.lock().unwrap().push(failure);
        let result = self.result;
        let release = self.release.clone();
        Box::pin(async move {
            if let Some(release) = release {
                release.notified().await;
            }
            result
        })
    }
}

#[derive(Clone)]
pub(super) struct Policy {
    decision: RestartDecision,
    pub(super) calls: Arc<AtomicUsize>,
    episodes: Arc<Mutex<Vec<RestartEpisode>>>,
}

impl Policy {
    pub(super) fn halt() -> Self {
        Self::new(RestartDecision::Halt)
    }

    pub(super) fn new(decision: RestartDecision) -> Self {
        Self {
            decision,
            calls: Arc::new(AtomicUsize::new(0)),
            episodes: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl RestartPolicy for Policy {
    fn decide(&self, _: &SupervisorFailure, episode: RestartEpisode) -> RestartDecision {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.episodes.lock().unwrap().push(episode);
        self.decision
    }
}

pub(super) fn test_launch() -> FixedLaunch {
    FixedLaunch::new(test_launch_spec("fixed-attempt"))
}

fn test_launch_spec(marker: &str) -> LaunchSpec {
    LaunchSpec::try_new(
        test_absolute_path("foundation-supervision-runtime"),
        test_absolute_path("foundation-supervision-working-directory"),
        [OsString::from(marker)],
        [],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap()
}

fn test_absolute_path(name: &str) -> PathBuf {
    let root = if cfg!(windows) { "C:/" } else { "/" };
    PathBuf::from(root).join(name)
}

struct SequencedMaterializer {
    markers: VecDeque<&'static str>,
    calls: Arc<AtomicUsize>,
    events: Arc<Mutex<Vec<AttemptEvent>>>,
}

impl SequencedMaterializer {
    fn new(markers: impl IntoIterator<Item = &'static str>) -> (Self, Arc<AtomicUsize>) {
        Self::with_events(markers, Arc::new(Mutex::new(Vec::new())))
    }

    fn with_events(
        markers: impl IntoIterator<Item = &'static str>,
        events: Arc<Mutex<Vec<AttemptEvent>>>,
    ) -> (Self, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                markers: markers.into_iter().collect(),
                calls: calls.clone(),
                events,
            },
            calls,
        )
    }
}

impl LaunchAttemptMaterializer for SequencedMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let marker = self.markers.pop_front().unwrap();
        self.events
            .lock()
            .unwrap()
            .push(AttemptEvent::Materialized(marker));
        Box::pin(async move { Ok(LaunchAttempt::new(test_launch_spec(marker), ())) })
    }
}

struct GuardedMaterializer {
    materialize_calls: Arc<AtomicUsize>,
    cleanup_results: Arc<Mutex<VecDeque<Result<(), LaunchAttemptCleanupFailure>>>>,
    guard_cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl GuardedMaterializer {
    fn succeeds(drops: Arc<AtomicUsize>) -> Self {
        Self::new(drops, [Ok(())]).0
    }

    fn new(
        drops: Arc<AtomicUsize>,
        cleanup_results: impl IntoIterator<Item = Result<(), LaunchAttemptCleanupFailure>>,
    ) -> (Self, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let materialize_calls = Arc::new(AtomicUsize::new(0));
        let guard_cleanup_calls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                materialize_calls: Arc::clone(&materialize_calls),
                cleanup_results: Arc::new(Mutex::new(cleanup_results.into_iter().collect())),
                guard_cleanup_calls: Arc::clone(&guard_cleanup_calls),
                drops,
            },
            materialize_calls,
            guard_cleanup_calls,
        )
    }
}

impl LaunchAttemptMaterializer for GuardedMaterializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        self.materialize_calls.fetch_add(1, Ordering::SeqCst);
        let cleanup_results = Arc::clone(&self.cleanup_results);
        let guard_cleanup_calls = Arc::clone(&self.guard_cleanup_calls);
        let drops = Arc::clone(&self.drops);
        Box::pin(async move {
            Ok(LaunchAttempt::new(
                test_launch_spec("guarded-attempt"),
                AttemptDropCounter {
                    cleanup_results,
                    guard_cleanup_calls,
                    drops,
                },
            ))
        })
    }
}

struct AttemptDropCounter {
    cleanup_results: Arc<Mutex<VecDeque<Result<(), LaunchAttemptCleanupFailure>>>>,
    guard_cleanup_calls: Arc<AtomicUsize>,
    drops: Arc<AtomicUsize>,
}

impl LaunchAttemptGuard for AttemptDropCounter {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        self.guard_cleanup_calls.fetch_add(1, Ordering::SeqCst);
        self.cleanup_results
            .lock()
            .unwrap()
            .pop_front()
            .expect("attempt cleanup result missing")
    }
}

impl Drop for AttemptDropCounter {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

fn supervisor_with_materializer<M: LaunchAttemptMaterializer>(
    adapter: FakeAdapter,
    materializer: M,
    ready: Ready,
    stop: Stop,
    recovery: Recovery,
    policy: Policy,
) -> Supervisor {
    Supervisor::new(
        ResourceRuntime::spawn(adapter, materializer),
        DrainStdio,
        ready,
        stop,
        recovery,
        policy,
    )
}

fn supervisor(
    adapter: FakeAdapter,
    ready: Ready,
    stop: Stop,
    recovery: Recovery,
    policy: Policy,
) -> Supervisor {
    Supervisor::new(
        ResourceRuntime::spawn(adapter, test_launch()),
        DrainStdio,
        ready,
        stop,
        recovery,
        policy,
    )
}

#[test]
fn failure_display_is_fixed_and_secret_safe() {
    assert_eq!(
        super::LaunchFailure::ArtifactUnavailable.to_string(),
        "process artifact is unavailable"
    );
    assert_eq!(
        super::LaunchFailure::PermissionDenied.to_string(),
        "process launch permission was denied"
    );
    assert_eq!(
        super::LaunchFailure::ResourceUnavailable.to_string(),
        "process launch resource is unavailable"
    );
    assert_eq!(
        super::LaunchFailure::PlatformRejected.to_string(),
        "process launch was rejected by the platform"
    );
    assert_eq!(
        SupervisorFailure::LaunchFailed(super::LaunchFailure::PermissionDenied).to_string(),
        "process launch permission was denied"
    );
    assert_eq!(
        SupervisorFailure::Exited(ExitObservation::new(
            Some(73),
            Some(9),
            SystemTime::UNIX_EPOCH,
        ))
        .to_string(),
        "process exited unexpectedly"
    );
}

#[tokio::test]
async fn stop_cancels_launch_recovery_after_begin_drained() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Drained(
        super::super::resource::BeginDrained::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable,
        ),
    )]);
    let (recovery, _release) = Recovery::blocked(StartRecoveryResult::RetryAfter(Duration::ZERO));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        recovery.clone(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);
    wait_until(|| recovery.calls.load(Ordering::SeqCst) == 1).await;

    assert!(matches!(
        completion(handle.stop().await).wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::NoProcess)
    ));
    assert_eq!(
        start.wait().await.unwrap(),
        StartOutcome::Cancelled {
            by: super::ControlIntent::Stop,
            cleanup: TerminationOutcome::NoProcess,
        }
    );
    tokio::task::yield_now().await;
    assert_eq!(adapter.install_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn shutdown_cancels_launch_recovery_and_settles_after_shutdown_snapshot() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Drained(
        super::super::resource::BeginDrained::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable,
        ),
    )]);
    let (recovery, _release) = Recovery::blocked(StartRecoveryResult::RetryAfter(Duration::ZERO));
    let mut supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        recovery.clone(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);
    let snapshots = handle.subscribe();
    wait_until(|| recovery.calls.load(Ordering::SeqCst) == 1).await;

    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::NoProcess)
    );
    assert_eq!(snapshots.borrow().phase(), SupervisorPhase::ShutDown);
    assert_eq!(
        start.wait().await.unwrap(),
        StartOutcome::Cancelled {
            by: super::ControlIntent::Shutdown,
            cleanup: TerminationOutcome::NoProcess,
        }
    );
    assert_eq!(adapter.install_calls(), 1);
    supervisor.join().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn control_cancels_waiting_restart_without_late_launch() {
    for control in [super::ControlIntent::Stop, super::ControlIntent::Kill] {
        let adapter = FakeAdapter::owned([
            NativeInstallResult::Drained(super::super::resource::BeginDrained::LaunchFailed(
                super::LaunchFailure::ResourceUnavailable,
            )),
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
        ]);
        let supervisor = supervisor(
            adapter.clone(),
            Ready::immediate(),
            Stop::requested(Duration::from_secs(1)),
            Recovery::new(StartRecoveryResult::RetryAfter(Duration::from_secs(10))),
            Policy::halt(),
        );
        let handle = supervisor.handle();
        let start = completion(handle.start().await);
        wait_for(&handle, |snapshot| {
            snapshot.phase() == SupervisorPhase::WaitingToRestart
        })
        .await;

        let receipt = match control {
            super::ControlIntent::Stop => handle.stop().await,
            super::ControlIntent::Kill => handle.kill().await,
            super::ControlIntent::Shutdown => unreachable!(),
        };
        assert!(matches!(
            completion(receipt).wait().await.unwrap(),
            TerminationCompletion::Completed(TerminationOutcome::NoProcess)
        ));
        assert_eq!(
            start.wait().await.unwrap(),
            StartOutcome::Cancelled {
                by: control,
                cleanup: TerminationOutcome::NoProcess,
            }
        );
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        assert_eq!(adapter.install_calls(), 1);
        shutdown(supervisor, handle).await;
    }
}

#[tokio::test(start_paused = true)]
async fn shutdown_cancels_waiting_restart_without_late_launch() {
    let adapter = FakeAdapter::owned([
        NativeInstallResult::Drained(super::super::resource::BeginDrained::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable,
        )),
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
    ]);
    let mut supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::new(StartRecoveryResult::RetryAfter(Duration::from_secs(10))),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::WaitingToRestart
    })
    .await;

    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::NoProcess)
    );
    assert_eq!(
        start.wait().await.unwrap(),
        StartOutcome::Cancelled {
            by: super::ControlIntent::Shutdown,
            cleanup: TerminationOutcome::NoProcess,
        }
    );
    tokio::time::advance(Duration::from_secs(10)).await;
    assert_eq!(adapter.install_calls(), 1);
    supervisor.join().await.unwrap();
}

#[tokio::test]
async fn stop_rejects_unrepresentable_grace_deadline_without_starting_policy() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    let stop = Stop::requested(Duration::MAX);
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        stop.clone(),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let before = handle.snapshot();

    assert!(matches!(
        handle.stop().await,
        CommandReceipt::Rejected(SupervisorRejection::RecoveryRequired)
    ));
    assert_eq!(handle.snapshot(), before);
    assert_eq!(stop.calls(), 0);
    assert_eq!(adapter.cleanup_calls(), 0);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn restart_rejects_unrepresentable_grace_deadline_without_starting_policy() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    let stop = Stop::requested(Duration::MAX);
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        stop.clone(),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let before = handle.snapshot();

    assert!(matches!(
        handle.restart().await,
        CommandReceipt::Rejected(SupervisorRejection::RecoveryRequired)
    ));
    assert_eq!(handle.snapshot(), before);
    assert_eq!(stop.calls(), 0);
    assert_eq!(adapter.cleanup_calls(), 0);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn recovery_retry_overflow_fails_closed() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Drained(
        super::super::resource::BeginDrained::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable,
        ),
    )]);
    let recovery = Recovery::new(StartRecoveryResult::RetryAfter(Duration::MAX));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        recovery.clone(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);

    assert!(matches!(
        start.wait().await,
        Err(CompletionError::Failed(SupervisorFailure::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable
        )))
    ));
    assert_eq!(
        recovery.failures.lock().unwrap().as_slice(),
        [SupervisorFailure::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable
        )]
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(
        handle.snapshot().failure(),
        Some(&SupervisorFailure::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable
        ))
    );
    assert_eq!(adapter.install_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn restart_policy_delay_overflow_fails_closed() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::new(RestartDecision::RestartAfter(Duration::MAX)),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    adapter.push_poll(NativePollResult::Drained(exit(17)));

    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::OperationFailed
    })
    .await;
    assert!(matches!(
        handle.snapshot().failure(),
        Some(SupervisorFailure::Exited(observation)) if observation.exit_code() == Some(17)
    ));
    assert_eq!(adapter.install_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn control_ingress_bypasses_saturated_command_mailbox() {
    let (commands, mut command_receiver) = mpsc::channel(1);
    let (controls, mut control_receiver) = mpsc::channel(1);
    let (_, snapshots) = watch::channel(super::SupervisorSnapshot::idle());
    let ingress = Ingress::new(
        commands.clone(),
        controls,
        snapshots,
        Arc::new(std::sync::RwLock::new(None)),
    );
    let (reply, _) = oneshot::channel();
    commands.send(Command::Start(reply)).await.unwrap();

    let stop = tokio::spawn({
        let ingress = ingress.clone();
        async move { ingress.stop().await }
    });
    let ControlCommand::Stop(reply) = control_receiver.recv().await.unwrap() else {
        panic!("expected stop control command");
    };
    assert!(reply.send(CommandReceipt::AlreadySatisfied).is_ok());
    assert!(matches!(
        stop.await.unwrap(),
        CommandReceipt::AlreadySatisfied
    ));
    assert!(matches!(command_receiver.try_recv(), Ok(Command::Start(_))));
}

#[tokio::test]
async fn initial_start_materializes_once_before_install_and_reaches_running() {
    let adapter = FakeAdapter::blocked_install([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let readiness = Ready::immediate();
    let (materializer, materialize_calls) = SequencedMaterializer::new(["initial-attempt"]);
    let supervisor = supervisor_with_materializer(
        adapter.clone(),
        materializer,
        readiness.clone(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let first = completion(handle.start().await);
    wait_until(|| adapter.install_calls() == 1).await;
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.installed_markers(), ["initial-attempt"]);
    let second = shared(handle.start().await);
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Starting);
    assert_eq!(handle.snapshot().process(), None);
    assert_eq!(readiness.calls(), 0);

    adapter.allow_install();
    assert_eq!(first.wait().await.unwrap(), StartOutcome::Started);
    assert_eq!(second.wait().await.unwrap(), StartOutcome::Started);
    assert_eq!(readiness.calls(), 1);
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Running);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn readiness_task_panic_holds_guard_until_cleanup_terminal_and_owner_join() {
    let adapter = FakeAdapter::blocked_cleanup([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let drops = Arc::new(AtomicUsize::new(0));
    let mut supervisor = Supervisor::new(
        ResourceRuntime::spawn(
            adapter.clone(),
            GuardedMaterializer::succeeds(Arc::clone(&drops)),
        ),
        DrainStdio,
        PanickingReady,
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);

    assert!(matches!(
        start.wait().await,
        Err(CompletionError::Failed(SupervisorFailure::ReadinessFailed))
    ));
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(drops.load(Ordering::SeqCst), 0);

    let shutdown = tokio::spawn(completion(handle.shutdown().await).wait());
    wait_until(|| adapter.cleanup_calls() == 1).await;
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    assert!(!shutdown.is_finished());
    adapter.allow_cleanup();
    assert!(matches!(
        shutdown.await.unwrap().unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(_))
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    supervisor.join().await.unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn launch_failure_counts_once_across_recovery_timer_and_begin() {
    let adapter = FakeAdapter::owned([
        NativeInstallResult::Drained(super::super::resource::BeginDrained::LaunchFailed(
            super::LaunchFailure::ResourceUnavailable,
        )),
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
    ]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter,
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::new(StartRecoveryResult::RetryAfter(Duration::ZERO)),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);

    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::WaitingToRestart
    })
    .await;
    assert_eq!(handle.snapshot().restart_episode().settled_failures(), 1);
    assert_eq!(start.wait().await.unwrap(), StartOutcome::Started);
    assert_eq!(handle.snapshot().restart_episode().settled_failures(), 0);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn settled_failures_count_once_and_readiness_resets_episode() {
    let adapter = FakeAdapter::owned([
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
    ]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(1)));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let recovery = Recovery::new(StartRecoveryResult::RetryAfter(Duration::ZERO));
    let supervisor = supervisor(
        adapter,
        Ready::sequence([ReadinessResult::Unavailable, ReadinessResult::Ready]),
        Stop::requested(Duration::from_secs(1)),
        recovery,
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);

    wait_for(&handle, |snapshot| {
        snapshot.restart_episode().settled_failures() == 1
    })
    .await;
    assert_eq!(handle.snapshot().restart_episode().settled_failures(), 1);
    assert_eq!(start.wait().await.unwrap(), StartOutcome::Started);
    assert_eq!(handle.snapshot().restart_episode().settled_failures(), 0);
    shutdown(supervisor, handle).await;
}

#[tokio::test(start_paused = true)]
async fn running_crash_restart_materializes_a_new_attempt() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let adapter = FakeAdapter::with_events(
        [
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
        ],
        32,
        32,
        events.clone(),
    );
    let policy = Policy::new(RestartDecision::RestartAfter(Duration::from_millis(10)));
    let (materializer, materialize_calls) =
        SequencedMaterializer::with_events(["crash-attempt-1", "crash-attempt-2"], events.clone());
    let supervisor = supervisor_with_materializer(
        adapter.clone(),
        materializer,
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        policy.clone(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    adapter.push_poll(NativePollResult::Drained(exit(17)));
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::WaitingToRestart
    })
    .await;
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(10)).await;
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::Running
    })
    .await;

    assert_eq!(materialize_calls.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.install_calls(), 2);
    assert_eq!(
        adapter.installed_markers(),
        ["crash-attempt-1", "crash-attempt-2"]
    );
    assert_eq!(
        *events.lock().unwrap(),
        [
            AttemptEvent::Materialized("crash-attempt-1"),
            AttemptEvent::Installed(OsString::from("crash-attempt-1")),
            AttemptEvent::Materialized("crash-attempt-2"),
            AttemptEvent::Installed(OsString::from("crash-attempt-2")),
        ]
    );
    assert_eq!(policy.calls.load(Ordering::SeqCst), 1);
    assert_eq!(policy.episodes.lock().unwrap()[0].settled_failures(), 1);
    assert_eq!(handle.snapshot().restart_episode().settled_failures(), 0);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn stop_settles_natural_drain_as_graceful() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    let stop = Stop::requested(Duration::from_secs(1));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        stop.clone(),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let stopped = completion(handle.stop().await);
    wait_until(|| stop.calls.load(Ordering::SeqCst) == 1).await;
    adapter.push_poll(NativePollResult::Drained(exit(0)));

    assert!(matches!(
        stopped.wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Graceful(observation))
            if observation.exit_code() == Some(0)
    ));
    assert_eq!(adapter.cleanup_calls(), 0);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn rejected_graceful_action_uses_one_verified_fallback() {
    let adapter = FakeAdapter::blocked_cleanup([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::AlreadyDrained(exit(0)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::rejected(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let first = completion(handle.stop().await);
    wait_until(|| adapter.cleanup_calls() == 1).await;
    let second = shared(handle.stop().await);
    adapter.allow_cleanup();

    for stopped in [first, second] {
        assert!(matches!(
            stopped.wait().await.unwrap(),
            TerminationCompletion::Completed(TerminationOutcome::Graceful(observation))
                if observation.exit_code() == Some(0)
        ));
    }
    assert_eq!(adapter.cleanup_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test(start_paused = true)]
async fn stop_deadline_is_absolute_and_upgrade_does_not_extend_it() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::AlreadyDrained(exit(0)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::blocked(Duration::from_millis(30)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let graceful = completion(handle.stop().await);
    tokio::time::advance(Duration::from_millis(20)).await;
    let duplicate = shared(handle.stop().await);
    tokio::time::advance(Duration::from_millis(10)).await;
    tokio::task::yield_now().await;

    for stopped in [graceful, duplicate] {
        assert!(matches!(
            stopped.wait().await.unwrap(),
            TerminationCompletion::Completed(TerminationOutcome::Graceful(_))
        ));
    }
    assert_eq!(adapter.cleanup_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn kill_classifies_already_drained_evidence_by_origin() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::AlreadyDrained(exit(0)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert!(matches!(
        completion(handle.kill().await).wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Graceful(_))
    ));
    assert_eq!(adapter.cleanup_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn stop_fallback_cleanup_is_classified_by_origin() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::rejected(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert!(matches!(
        completion(handle.stop().await).wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Forced(_))
    ));
    assert_eq!(adapter.cleanup_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test(start_paused = true)]
async fn startup_recovery_drains_installed_resource_before_retry() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let adapter = FakeAdapter::with_events(
        [
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
        ],
        32,
        32,
        events.clone(),
    );
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(1)));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let recovery = Recovery::new(StartRecoveryResult::RetryAfter(Duration::from_millis(10)));
    let (materializer, materialize_calls) = SequencedMaterializer::with_events(
        ["readiness-attempt-1", "readiness-attempt-2"],
        events.clone(),
    );
    let supervisor = supervisor_with_materializer(
        adapter.clone(),
        materializer,
        Ready::sequence([ReadinessResult::Unavailable, ReadinessResult::Ready]),
        Stop::requested(Duration::from_secs(1)),
        recovery.clone(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);

    wait_until(|| adapter.cleanup_calls() == 1).await;
    assert_eq!(adapter.install_calls(), 1);
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.installed_markers(), ["readiness-attempt-1"]);
    tokio::time::advance(Duration::from_millis(10)).await;
    assert_eq!(start.wait().await.unwrap(), StartOutcome::Started);
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.install_calls(), 2);
    assert_eq!(
        adapter.installed_markers(),
        ["readiness-attempt-1", "readiness-attempt-2"]
    );
    assert_eq!(
        *events.lock().unwrap(),
        [
            AttemptEvent::Materialized("readiness-attempt-1"),
            AttemptEvent::Installed(OsString::from("readiness-attempt-1")),
            AttemptEvent::CleanupStarted,
            AttemptEvent::CleanupReturned,
            AttemptEvent::Materialized("readiness-attempt-2"),
            AttemptEvent::Installed(OsString::from("readiness-attempt-2")),
        ]
    );
    assert_eq!(recovery.calls.load(Ordering::SeqCst), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn lease_is_invalidated_by_restart_stop_and_shutdown() {
    let adapter = FakeAdapter::blocked_cleanup([
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
    ]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::sequence([
            ReadinessResult::Ready,
            ReadinessResult::Ready,
            ReadinessResult::Ready,
        ]),
        Stop::rejected(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();

    assert_eq!(
        completion(handle.start().await).wait().await.unwrap(),
        StartOutcome::Started
    );
    let first = handle.lease().expect("ready generation lease");
    assert!(!first.is_cancelled());

    let restart = tokio::spawn(completion(handle.restart().await).wait());
    wait_until(|| adapter.cleanup_calls() == 1).await;
    assert!(first.is_cancelled());
    assert!(handle.lease().is_none());
    adapter.allow_cleanup();
    assert_eq!(restart.await.unwrap().unwrap(), RestartOutcome::Restarted);

    let second = handle.lease().expect("replacement generation lease");
    assert_ne!(first.generation(), second.generation());
    assert!(!second.is_cancelled());

    let stopped = tokio::spawn(completion(handle.stop().await).wait());
    wait_until(|| adapter.cleanup_calls() == 2).await;
    assert!(second.is_cancelled());
    assert!(handle.lease().is_none());
    adapter.allow_cleanup();
    assert_eq!(
        stopped.await.unwrap().unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Forced(exit(9)))
    );

    assert_eq!(
        completion(handle.start().await).wait().await.unwrap(),
        StartOutcome::Started
    );
    let third = handle.lease().expect("new ready generation lease");
    assert_ne!(second.generation(), third.generation());
    assert!(!third.is_cancelled());

    let shutdown = tokio::spawn(completion(handle.shutdown().await).wait());
    wait_until(|| adapter.cleanup_calls() == 3).await;
    assert!(third.is_cancelled());
    assert!(handle.lease().is_none());
    adapter.allow_cleanup();
    assert_eq!(
        shutdown.await.unwrap().unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(exit(9)))
    );
    let mut supervisor = supervisor;
    supervisor.join().await.unwrap();
}

#[tokio::test]
async fn operation_failed_restart_cleans_active_epoch_before_new_begin() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let adapter = FakeAdapter::with_events(
        [
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
            NativeInstallResult::Installed(
                owned(),
                NativeStdio::new(ProcessStdio::new(None, None, None)),
            ),
        ],
        32,
        32,
        events.clone(),
    );
    adapter.push_cleanup(NativeCleanupResult::AlreadyDrained(exit(1)));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let (materializer, materialize_calls) = SequencedMaterializer::with_events(
        ["explicit-attempt-1", "explicit-attempt-2"],
        events.clone(),
    );
    let supervisor = supervisor_with_materializer(
        adapter.clone(),
        materializer,
        Ready::sequence([ReadinessResult::Unavailable, ReadinessResult::Ready]),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    assert!(matches!(
        completion(handle.start().await).wait().await,
        Err(CompletionError::Failed(SupervisorFailure::ReadinessFailed))
    ));
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.installed_markers(), ["explicit-attempt-1"]);

    let restart = completion(handle.restart().await);
    assert_eq!(restart.wait().await.unwrap(), RestartOutcome::Restarted);
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.install_calls(), 2);
    assert_eq!(
        adapter.installed_markers(),
        ["explicit-attempt-1", "explicit-attempt-2"]
    );
    assert_eq!(
        *events.lock().unwrap(),
        [
            AttemptEvent::Materialized("explicit-attempt-1"),
            AttemptEvent::Installed(OsString::from("explicit-attempt-1")),
            AttemptEvent::CleanupStarted,
            AttemptEvent::CleanupReturned,
            AttemptEvent::Materialized("explicit-attempt-2"),
            AttemptEvent::Installed(OsString::from("explicit-attempt-2")),
        ]
    );
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn attached_resource_retries_unresolved_detach_until_detached() {
    let adapter = FakeAdapter::owned([]);
    adapter.push_detach(NativeDetachResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    adapter.push_detach(NativeDetachResult::Detached);
    let mut supervisor = Supervisor::new(
        ResourceRuntime::spawn_attached(adapter.clone(), attached()),
        DrainStdio,
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::Running);
    assert_eq!(handle.snapshot().process(), Some(attached()));
    for receipt in [handle.stop().await, handle.kill().await] {
        assert!(matches!(
            receipt,
            CommandReceipt::Rejected(SupervisorRejection::NoTerminationAuthority)
        ));
    }
    assert!(matches!(
        handle.restart().await,
        CommandReceipt::Rejected(SupervisorRejection::NoTerminationAuthority)
    ));
    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Unresolved {
            failure: TerminationFailure::CleanupUnconfirmed,
        }
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(attached()));
    assert_eq!(adapter.detach_calls(), 1);

    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Detached
    );
    assert_eq!(adapter.detach_calls(), 2);
    supervisor.join().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn owner_drop_invalidates_ready_lease_before_actor_cleanup() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let lease = handle.lease().expect("ready generation lease");

    drop(supervisor);

    assert!(lease.is_cancelled());
    assert!(handle.lease().is_none());
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::ShutDown
    })
    .await;
    assert_eq!(adapter.cleanup_calls(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn owner_drop_prevents_late_ready_lease_publication() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let (ready, ready_release) = Ready::blocked(ReadinessResult::Ready);
    let supervisor = supervisor(
        adapter,
        ready.clone(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);

    wait_until(|| ready.calls() == 1).await;
    drop(supervisor);
    ready_release.notify_one();

    assert!(matches!(
        start.wait().await.unwrap(),
        StartOutcome::Cancelled {
            by: super::ControlIntent::Shutdown,
            ..
        }
    ));
    assert!(handle.lease().is_none());
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::ShutDown
    })
    .await;
}

#[tokio::test]
async fn owner_drop_cleans_active_owned_process_once_and_publishes_shutdown() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    drop(supervisor);
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::ShutDown
    })
    .await;

    assert_eq!(adapter.cleanup_calls(), 1);
    assert!(matches!(
        handle.snapshot().last_outcome(),
        Some(super::SupervisorOutcome::ShutDown(
            ShutdownOutcome::Terminated(TerminationOutcome::Forced(observation))
        )) if observation.exit_code() == Some(9)
    ));
}

#[tokio::test]
async fn owner_drop_holds_guard_until_cleanup_and_owner_join_complete() {
    let adapter = FakeAdapter::blocked_cleanup([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let drops = Arc::new(AtomicUsize::new(0));
    let supervisor = supervisor_with_materializer(
        adapter.clone(),
        GuardedMaterializer::succeeds(Arc::clone(&drops)),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    drop(supervisor);
    wait_until(|| adapter.cleanup_calls() == 1).await;
    assert_ne!(handle.snapshot().phase(), SupervisorPhase::ShutDown);
    assert_eq!(drops.load(Ordering::SeqCst), 0);

    adapter.allow_cleanup();
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::ShutDown
    })
    .await;
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_join_preserves_owner_and_guard_until_retried_terminal_and_natural_join() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let drops = Arc::new(AtomicUsize::new(0));
    let mut supervisor = supervisor_with_materializer(
        adapter.clone(),
        GuardedMaterializer::succeeds(Arc::clone(&drops)),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Unresolved {
            failure: TerminationFailure::CleanupUnconfirmed,
        }
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    let mut join = Box::pin(supervisor.join());
    poll_fn(|context| {
        assert!(matches!(join.as_mut().poll(context), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    drop(join);

    assert!(matches!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(ref observation))
            if observation.exit_code() == Some(9)
    ));
    assert_eq!(adapter.cleanup_calls(), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    supervisor.join().await.unwrap();
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::ShutDown);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn material_cleanup_failure_retries_same_epoch_and_preserves_terminal_outcome() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let drops = Arc::new(AtomicUsize::new(0));
    let (materializer, materialize_calls, guard_cleanup_calls) = GuardedMaterializer::new(
        Arc::clone(&drops),
        [Err(LaunchAttemptCleanupFailure), Ok(())],
    );
    let mut supervisor = supervisor_with_materializer(
        adapter.clone(),
        materializer,
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Unresolved {
            failure: TerminationFailure::MaterialCleanupFailed,
        }
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.install_calls(), 1);
    assert_eq!(guard_cleanup_calls.load(Ordering::SeqCst), 1);
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    let mut join = Box::pin(supervisor.join());
    poll_fn(|context| {
        assert!(matches!(join.as_mut().poll(context), Poll::Pending));
        Poll::Ready(())
    })
    .await;

    assert!(matches!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(ref observation))
            if observation.exit_code() == Some(9)
    ));
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(materialize_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.install_calls(), 1);
    assert_eq!(guard_cleanup_calls.load(Ordering::SeqCst), 2);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    join.await.unwrap();
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::ShutDown);
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_shutdown_wait_preserves_guard_until_retried_terminal_and_join() {
    let adapter = FakeAdapter::blocked_cleanup([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let drops = Arc::new(AtomicUsize::new(0));
    let mut supervisor = supervisor_with_materializer(
        adapter.clone(),
        GuardedMaterializer::succeeds(Arc::clone(&drops)),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    let cancelled = tokio::spawn(completion(handle.shutdown().await).wait());
    wait_until(|| adapter.cleanup_calls() == 1).await;
    let shared = shared(handle.shutdown().await);
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    adapter.allow_cleanup();
    assert_eq!(
        shared.wait().await.unwrap(),
        ShutdownOutcome::Unresolved {
            failure: TerminationFailure::CleanupUnconfirmed,
        }
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert_eq!(drops.load(Ordering::SeqCst), 0);

    let retry = tokio::spawn(completion(handle.shutdown().await).wait());
    wait_until(|| adapter.cleanup_calls() == 2).await;
    assert_eq!(drops.load(Ordering::SeqCst), 0);
    adapter.allow_cleanup();
    assert!(matches!(
        retry.await.unwrap().unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(ref observation))
            if observation.exit_code() == Some(9)
    ));
    assert_eq!(drops.load(Ordering::SeqCst), 1);
    supervisor.join().await.unwrap();
    assert_eq!(drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn owner_drop_retries_attached_resource_until_detached() {
    let adapter = FakeAdapter::owned([]);
    adapter.push_detach(NativeDetachResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    adapter.push_detach(NativeDetachResult::Detached);
    let supervisor = Supervisor::new(
        ResourceRuntime::spawn_attached(adapter.clone(), attached()),
        DrainStdio,
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();

    drop(supervisor);
    wait_for(&handle, |snapshot| {
        snapshot.phase() == SupervisorPhase::ShutDown
    })
    .await;

    assert_eq!(adapter.detach_calls(), 2);
    assert_eq!(adapter.cleanup_calls(), 0);
    assert_eq!(
        handle.snapshot().last_outcome(),
        Some(&super::SupervisorOutcome::ShutDown(
            ShutdownOutcome::Detached
        ))
    );
}

#[tokio::test]
async fn shutdown_receipt_waits_for_owner_cleanup_and_full_join() {
    let adapter = FakeAdapter::blocked_cleanup([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let mut supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let snapshots = handle.subscribe();
    let waiter = tokio::spawn(completion(handle.shutdown().await).wait());
    wait_until(|| adapter.cleanup_calls() == 1).await;
    assert!(!waiter.is_finished());
    assert_ne!(snapshots.borrow().phase(), SupervisorPhase::ShutDown);

    adapter.allow_cleanup();
    assert!(matches!(
        waiter.await.unwrap().unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(_))
    ));
    assert_eq!(snapshots.borrow().phase(), SupervisorPhase::ShutDown);
    supervisor.join().await.unwrap();
}

#[tokio::test]
async fn stop_authority_loss_is_a_successful_typed_outcome() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::AuthorityLost,
    ));
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::AuthorityLost,
    ));
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::AuthorityLost,
    ));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let mut supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::rejected(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert_eq!(
        completion(handle.stop().await).wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::AuthorityLost)
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert_eq!(
        handle.snapshot().failure(),
        Some(&SupervisorFailure::Termination(
            TerminationFailure::AuthorityLost
        ))
    );
    assert!(matches!(
        handle.stop().await,
        CommandReceipt::Rejected(SupervisorRejection::AuthorityLost)
    ));
    assert!(matches!(
        handle.kill().await,
        CommandReceipt::Rejected(SupervisorRejection::AuthorityLost)
    ));
    assert!(matches!(
        handle.restart().await,
        CommandReceipt::Rejected(SupervisorRejection::AuthorityLost)
    ));
    assert_eq!(adapter.cleanup_calls(), 1);
    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Unresolved {
            failure: TerminationFailure::AuthorityLost,
        }
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert_eq!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Unresolved {
            failure: TerminationFailure::AuthorityLost,
        }
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert!(matches!(
        completion(handle.shutdown().await).wait().await.unwrap(),
        ShutdownOutcome::Terminated(TerminationOutcome::Forced(ref observation))
            if observation.exit_code() == Some(9)
    ));
    assert_eq!(adapter.cleanup_calls(), 4);
    supervisor.join().await.unwrap();
}

#[tokio::test]
async fn kill_cleanup_unconfirmed_is_a_successful_typed_outcome() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert_eq!(
        completion(handle.kill().await).wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Failed(
            TerminationFailure::CleanupUnconfirmed
        ))
    );
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    assert_eq!(
        handle.snapshot().failure(),
        Some(&SupervisorFailure::Termination(
            TerminationFailure::CleanupUnconfirmed
        ))
    );
    assert!(matches!(
        completion(handle.stop().await).wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Forced(observation))
            if observation.exit_code() == Some(9)
    ));
    assert_eq!(adapter.cleanup_calls(), 2);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn restart_cleanup_failure_fails_the_restart_completion() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Unresolved(
        TerminationFailure::CleanupUnconfirmed,
    ));
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter,
        Ready::immediate(),
        Stop::rejected(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();

    assert!(matches!(
        completion(handle.restart().await).wait().await,
        Err(CompletionError::Failed(SupervisorFailure::Termination(
            TerminationFailure::CleanupUnconfirmed
        )))
    ));
    assert_eq!(handle.snapshot().phase(), SupervisorPhase::OperationFailed);
    assert_eq!(handle.snapshot().process(), Some(owned()));
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn control_during_recovery_cleanup_prevents_retry() {
    let adapter = FakeAdapter::blocked_cleanup([
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
        NativeInstallResult::Installed(
            owned(),
            NativeStdio::new(ProcessStdio::new(None, None, None)),
        ),
    ]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(1)));
    let supervisor = supervisor(
        adapter.clone(),
        Ready::sequence([ReadinessResult::Unavailable, ReadinessResult::Ready]),
        Stop::requested(Duration::from_secs(1)),
        Recovery::new(StartRecoveryResult::RetryAfter(Duration::ZERO)),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    let start = completion(handle.start().await);
    wait_until(|| adapter.cleanup_calls() == 1).await;
    let stopped = completion(handle.stop().await);
    adapter.allow_cleanup();

    assert!(matches!(
        stopped.wait().await.unwrap(),
        TerminationCompletion::Completed(TerminationOutcome::Forced(_))
    ));
    assert_eq!(
        start.wait().await.unwrap(),
        StartOutcome::Cancelled {
            by: super::ControlIntent::Stop,
            cleanup: TerminationOutcome::Forced(exit(1)),
        }
    );
    tokio::task::yield_now().await;
    assert_eq!(adapter.install_calls(), 1);
    shutdown(supervisor, handle).await;
}

#[tokio::test]
async fn shutdown_is_already_satisfied_after_full_join() {
    let adapter = FakeAdapter::owned([]);
    let mut supervisor = supervisor(
        adapter,
        Ready::immediate(),
        Stop::requested(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.shutdown().await).wait().await.unwrap();
    supervisor.join().await.unwrap();

    assert!(matches!(
        handle.shutdown().await,
        CommandReceipt::AlreadySatisfied
    ));
    assert!(matches!(handle.start().await, CommandReceipt::ShuttingDown));
    assert!(matches!(
        handle.restart().await,
        CommandReceipt::ShuttingDown
    ));
    assert!(matches!(handle.stop().await, CommandReceipt::ShuttingDown));
    assert!(matches!(handle.kill().await, CommandReceipt::ShuttingDown));
}

#[tokio::test]
async fn snapshot_is_published_before_termination_receipt() {
    let adapter = FakeAdapter::owned([NativeInstallResult::Installed(
        owned(),
        NativeStdio::new(ProcessStdio::new(None, None, None)),
    )]);
    adapter.push_cleanup(NativeCleanupResult::Terminated(exit(9)));
    let supervisor = supervisor(
        adapter,
        Ready::immediate(),
        Stop::rejected(Duration::from_secs(1)),
        Recovery::fail(),
        Policy::halt(),
    );
    let handle = supervisor.handle();
    completion(handle.start().await).wait().await.unwrap();
    let snapshots = handle.subscribe();
    completion(handle.stop().await).wait().await.unwrap();
    assert_eq!(snapshots.borrow().phase(), SupervisorPhase::Idle);
    shutdown(supervisor, handle).await;
}

fn completion<T>(receipt: CommandReceipt<T>) -> Completion<T> {
    match receipt {
        CommandReceipt::Accepted(completion) => completion,
        _ => panic!("expected accepted receipt"),
    }
}

fn shared<T>(receipt: CommandReceipt<T>) -> Completion<T> {
    match receipt {
        CommandReceipt::Shared(completion) => completion,
        _ => panic!("expected shared receipt"),
    }
}

async fn wait_for(handle: &SupervisorHandle, matches: impl Fn(&super::SupervisorSnapshot) -> bool) {
    let mut snapshots = handle.subscribe();
    loop {
        if matches(&snapshots.borrow()) {
            return;
        }
        snapshots.changed().await.unwrap();
    }
}

pub(super) async fn wait_until(matches: impl Fn() -> bool) {
    for _ in 0..100 {
        if matches() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("condition was not reached");
}

async fn shutdown(mut supervisor: Supervisor, handle: SupervisorHandle) {
    let receipt = handle.shutdown().await;
    if let CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) = receipt {
        completion.wait().await.unwrap();
    }
    supervisor.join().await.unwrap();
}

pub(super) fn owned() -> ProcessObservation {
    ProcessObservation::new(
        ProcessIdentity::new(7, 1),
        Provenance::Spawned {
            scope: AuthorityScope::owned(ScopeId::new([7; 16])),
        },
    )
}

fn attached() -> ProcessObservation {
    let identity = ProcessIdentity::new(9, 2);
    ProcessObservation::new(identity, Provenance::Attached { subject: identity })
}

pub(super) fn exit(code: i32) -> ExitObservation {
    ExitObservation::new(Some(code), None, SystemTime::UNIX_EPOCH)
}
