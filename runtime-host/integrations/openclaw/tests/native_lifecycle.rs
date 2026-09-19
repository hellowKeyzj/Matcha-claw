#![cfg(windows)]

use std::{
    fs,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use foundation::process::{
    ProcessContainment, ShutdownOutcome, TerminationOutcome, supervise,
    supervision::{CommandReceipt, Supervisor, SupervisorPhase},
};
use openclaw::{
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClientMetadata, GatewayEndpoint},
        wire::{self, CronJobCreate, CronSchedule, CronWakeMode},
    },
    lifecycle::{
        launch::{LaunchFactory, OpenClawLaunchInput},
        logs::LifecycleDiagnostic,
        recovery::OpenClawStartRecovery,
        restart::OpenClawRestartPolicy,
        state_dir::CanonicalStateDir,
        stdio::OpenClawStdioActivation,
    },
    port::{
        CronExecutionStatus, CronMutationOutcome, CronTriggerOutcome, OpenClawControlReadiness,
        OpenClawGateway, SessionEvent,
    },
    session::protocol::{
        AgentId, EndpointSessionId, ModelRef, SessionCreateParams, SessionKey,
        SessionModelPatchParams, SessionsListParams,
    },
};
use platform::listener_identity::ListenerIdentity;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    time::{Instant, timeout},
};

const PACKAGED_UNPACKED_ENV: &str = "MATCHACLAW_PACKAGED_UNPACKED";
const START_DEADLINE: Duration = Duration::from_secs(60);
const PACKAGED_EADDRINUSE_RETRY_WINDOW: Duration = Duration::from_secs(10);
const HTTP_PROBE_DEADLINE: Duration = Duration::from_secs(30);
const CONTROL_DEADLINE: Duration = Duration::from_secs(30);
const STOP_DEADLINE: Duration = Duration::from_secs(45);
const RESTART_DEADLINE: Duration = Duration::from_secs(60);
const RECOVERY_DEADLINE: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_listener_readiness_settles_the_real_supervisor() {
    let mut fixture = NativeOpenClawFixture::start().await;

    assert_eq!(
        fixture.supervisor.handle().snapshot().phase(),
        SupervisorPhase::Running,
        "the real packaged Gateway listener must settle the supervisor without session RPC",
    );

    fixture.finish().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_lifecycle_uses_real_http_control_session_receipt_and_restart_boundaries()
{
    let mut fixture = NativeOpenClawFixture::start().await;

    fixture.assert_ready_http_probe().await;
    fixture.assert_authenticated_control_ready().await;
    fixture.assert_session_subscription_receipt().await;
    fixture.assert_native_session_event_translation().await;
    fixture.assert_explicit_restart().await;
    fixture.assert_graceful_stop().await;

    fixture.finish().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_agents_list_decodes_the_native_result() {
    let mut fixture = NativeOpenClawFixture::start().await;

    let agents = timeout(CONTROL_DEADLINE, fixture.gateway.list_agents())
        .await
        .expect("agents.list must finish within the bounded fixture deadline")
        .expect("the real packaged Gateway agents.list response must decode");
    assert_eq!(agents.default_id, "main");
    assert!(agents.agents.iter().any(|agent| agent.id == "main"));

    fixture.finish().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_cron_uses_native_crud_and_durable_terminal_run_log_receipt() {
    let mut fixture = NativeOpenClawFixture::start().await;

    fixture.assert_native_cron_crud_and_terminal_run_log().await;
    fixture.assert_graceful_stop().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_initial_start_recovers_after_owned_port_conflict() {
    let (mut fixture, occupied, started) =
        NativeOpenClawFixture::start_with_initial_port_conflict().await;

    let started_at = Instant::now();
    wait_for_initial_start_recovery(&fixture.supervisor, START_DEADLINE).await;
    assert!(
        started_at.elapsed() >= PACKAGED_EADDRINUSE_RETRY_WINDOW,
        "the fixture must outlast the packaged Gateway's own EADDRINUSE retry window before testing supervisor recovery",
    );
    drop(occupied);

    wait_started(started, START_DEADLINE).await;
    wait_for_phase(
        &fixture.supervisor,
        SupervisorPhase::Running,
        START_DEADLINE,
    )
    .await;
    fixture.assert_authenticated_control_ready().await;

    fixture.finish().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_post_ready_crash_restarts_the_real_supervisor() {
    let mut fixture = NativeOpenClawFixture::start().await;
    let first_pid = fixture.root_process_id();

    fixture.force_root_process_exit();
    fixture.assert_crash_recovery_from(first_pid).await;
    fixture.assert_authenticated_control_ready().await;

    fixture.finish().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_openclaw_lifecycle_forced_stop_is_reported_by_the_real_supervisor() {
    let mut fixture = NativeOpenClawFixture::start().await;

    let outcome = wait_termination(fixture.supervisor.handle().kill().await, STOP_DEADLINE).await;
    assert!(matches!(outcome, TerminationOutcome::Forced(_),));

    fixture.finish().await;
}

struct NativeOpenClawFixture {
    root: FixtureRoot,
    supervisor: Supervisor,
    gateway: OpenClawGateway,
    events: mpsc::Receiver<SessionEvent>,
    endpoint: GatewayEndpoint,
}

impl NativeOpenClawFixture {
    async fn start() -> Self {
        let fixture = Self::build(reserve_loopback_port());
        let started = fixture.supervisor.handle().start().await;
        wait_started(started, START_DEADLINE).await;
        wait_for_phase(
            &fixture.supervisor,
            SupervisorPhase::Running,
            START_DEADLINE,
        )
        .await;
        fixture
    }

    async fn start_with_initial_port_conflict() -> (
        Self,
        std::net::TcpListener,
        CommandReceipt<foundation::process::supervision::StartOutcome>,
    ) {
        let occupied = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .expect("fixture must reserve an occupied loopback port");
        let port = occupied
            .local_addr()
            .expect("fixture occupied listener must expose its address")
            .port();
        let fixture = Self::build(port);
        let started = fixture.supervisor.handle().start().await;
        (fixture, occupied, started)
    }

    fn build(port: u16) -> Self {
        let artifact = PackagedArtifact::resolve();
        let root = FixtureRoot::new();
        let state_dir = root.state_dir();
        let endpoint = GatewayEndpoint::try_new(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .expect("fixture allocates a non-zero loopback port");
        let listener_identity = Arc::new(
            ListenerIdentity::generate_loopback()
                .expect("fixture generates loopback listener identity"),
        );
        let secret = Arc::new(
            GatewaySecret::new(fixture_secret())
                .expect("fixture derives a non-empty private gateway secret"),
        );
        let metadata = GatewayClientMetadata::try_new("native-fixture".into(), "windows".into())
            .expect("fixed fixture client metadata is valid");
        let launch = OpenClawLaunchInput {
            electron_image: artifact.electron_image,
            working_directory: artifact.working_directory,
            openclaw_dir: artifact.openclaw_dir,
            entry: artifact.entry,
            state_dir,
            port,
            secret: Arc::clone(&secret),
        }
        .try_into_launch_factory()
        .expect("packaged OpenClaw launch inputs must be valid");
        let (events, received_events) = mpsc::channel(16);
        let (canonical_events, _received_canonical_events) = mpsc::channel(32);
        let gateway = OpenClawGateway::new(
            endpoint,
            listener_identity.fingerprint(),
            Arc::clone(&secret),
            metadata,
            events,
            canonical_events,
        );
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let supervisor = build_supervisor(launch, &gateway, diagnostics);
        Self {
            root,
            supervisor,
            gateway,
            events: received_events,
            endpoint,
        }
    }

    async fn assert_ready_http_probe(&self) {
        assert_eq!(
            self.http_status("/healthz").await,
            200,
            "the real packaged Gateway must expose liveness",
        );
        assert_eq!(
            self.http_status("/readyz").await,
            200,
            "the real packaged Gateway must expose readiness only after the supervisor settles",
        );
    }

    async fn assert_authenticated_control_ready(&self) {
        assert_eq!(
            timeout(CONTROL_DEADLINE, self.gateway.observe_control())
                .await
                .expect("control readiness must finish within the bounded fixture deadline"),
            OpenClawControlReadiness::Ready,
            "control readiness must complete through the authenticated Gateway protocol",
        );
    }

    async fn assert_native_cron_crud_and_terminal_run_log(&self) {
        let job = CronJobCreate::isolated_agent_turn(
            fixture_cron_name(),
            CronSchedule::every(60_000).expect("fixture cron interval is valid"),
            CronWakeMode::NextHeartbeat,
            "fixture native cron event",
        )
        .expect("fixture cron job is valid");
        let created = match self.gateway.add_cron_job(job).await {
            CronMutationOutcome::Applied(job) => job,
            outcome => {
                panic!("the real packaged Gateway must return the added cron job: {outcome:?}")
            }
        };

        let listed = self
            .gateway
            .list_cron_jobs()
            .await
            .expect("the real packaged Gateway must answer cron.list");
        assert!(
            listed.jobs.iter().any(|job| job.id == created.id),
            "cron.list must include the job created by this native fixture"
        );

        let run_id = match self.gateway.admit_cron_execution(created.id.clone()).await {
            Ok(Ok(admission)) => {
                let run_id = admission.run_id().to_owned();
                assert_eq!(
                    OpenClawGateway::await_cron_execution(
                        admission,
                        tokio_util::sync::CancellationToken::new(),
                    )
                    .await,
                    CronExecutionStatus::Succeeded,
                    "the real packaged Gateway must publish a terminal cron run status"
                );
                run_id
            }
            Ok(Err(CronTriggerOutcome::Skipped(_))) => {
                panic!("the real packaged Gateway must enqueue the cron run")
            }
            Ok(Err(CronTriggerOutcome::OutcomeUnknown)) | Err(_) => {
                panic!("the real packaged Gateway must return a cron run receipt")
            }
            Ok(Err(CronTriggerOutcome::Accepted)) => unreachable!(),
        };

        self.wait_for_terminal_cron_run(&created.id, &run_id).await;

        assert!(
            matches!(
                self.gateway.remove_cron_job(created.id).await,
                CronMutationOutcome::Applied(removed) if removed.removed
            ),
            "the real packaged Gateway must remove the fixture cron job"
        );
    }

    async fn wait_for_terminal_cron_run(
        &self,
        job_id: &str,
        run_id: &str,
    ) -> wire::CronRunHistoryEntry {
        let started = Instant::now();
        loop {
            let log = self
                .gateway
                .cron_run_history(job_id.to_owned(), 200)
                .await
                .expect("the real packaged Gateway must answer cron.runs");
            if let Some(entry) = log
                .into_iter()
                .find(|entry| entry.run_id.as_deref() == Some(run_id))
            {
                assert!(
                    entry.status().is_some(),
                    "the real packaged Gateway must publish a terminal cron run status"
                );
                return entry;
            }
            assert!(
                started.elapsed() < CONTROL_DEADLINE,
                "the real packaged Gateway did not publish a terminal cron.runs receipt"
            );
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    async fn assert_session_subscription_receipt(&mut self) {
        while self.events.try_recv().is_ok() {}

        self.gateway
            .list_sessions(SessionsListParams::default())
            .await
            .expect("the native session actor must list sessions before creating one");

        let endpoint_session_id = EndpointSessionId::try_new(fixture_session_id())
            .expect("fixture endpoint session identity is valid");
        let created = self
            .gateway
            .create_session(
                SessionCreateParams::try_new(
                    AgentId::try_new("main").expect("fixed fixture agent identity is valid"),
                    endpoint_session_id,
                    ModelRef::try_new("anthropic/claude-sonnet-4-6")
                        .expect("fixed fixture model identity is valid"),
                )
                .expect("fixture session creation parameters are valid"),
            )
            .await
            .expect("the real session socket must receive the native session RPC receipt");
        assert!(matches!(
            created,
            platform::exchange::InvocationOutcome::Succeeded(_)
        ));
    }

    async fn assert_native_session_event_translation(&mut self) {
        while self.events.try_recv().is_ok() {}

        let endpoint_session_id = EndpointSessionId::try_new(fixture_session_id())
            .expect("fixture endpoint session identity is valid");
        let created = SessionCreateParams::try_new(
            AgentId::try_new("main").expect("fixed fixture agent identity is valid"),
            endpoint_session_id,
            ModelRef::try_new("anthropic/claude-sonnet-4-6")
                .expect("fixed fixture model identity is valid"),
        )
        .expect("fixture session creation parameters are valid");
        let session_key = SessionKey::try_new(created.key().as_str().to_owned())
            .expect("created agent-scoped key is a valid session key");
        let created = self
            .gateway
            .create_session(created)
            .await
            .expect("the real session socket must receive the native session RPC receipt");
        assert!(matches!(
            created,
            platform::exchange::InvocationOutcome::Succeeded(_)
        ));

        let patched = self
            .gateway
            .patch_session_model(SessionModelPatchParams::new(session_key, None))
            .await
            .expect("the real session socket must receive the native session patch receipt");
        assert!(matches!(
            patched,
            platform::exchange::InvocationOutcome::Succeeded(_)
        ));

        let event = timeout(CONTROL_DEADLINE, self.events.recv())
            .await
            .expect("the subscribed native session socket must receive the Gateway event")
            .expect("fixture session event channel must remain open")
            .lifecycle_event()
            .expect("the Gateway event must preserve its native lifecycle projection");
        assert!(!event.has_run());
        assert!(!event.has_message());
        assert!(!event.has_session_activity());
    }

    async fn assert_explicit_restart(&mut self) {
        wait_restarted(self.supervisor.handle().restart().await, RESTART_DEADLINE).await;
        wait_for_phase(&self.supervisor, SupervisorPhase::Running, RESTART_DEADLINE).await;
        self.assert_authenticated_control_ready().await;
    }

    fn root_process_id(&self) -> u32 {
        self.supervisor
            .handle()
            .snapshot()
            .process()
            .expect("running fixture supervisor must expose an owned root process")
            .identity()
            .pid()
    }

    fn force_root_process_exit(&self) {
        let pid = self.root_process_id();
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status()
            .expect("Windows must provide taskkill for the owned fixture root");
        assert!(
            status.success(),
            "taskkill must terminate the owned fixture root"
        );
    }

    async fn assert_crash_recovery_from(&mut self, first_pid: u32) {
        let started = Instant::now();
        let mut observed_backoff = false;
        loop {
            let snapshot = self.supervisor.handle().snapshot();
            observed_backoff |= snapshot.phase() == SupervisorPhase::WaitingToRestart;
            if snapshot.phase() == SupervisorPhase::Running
                && snapshot
                    .process()
                    .is_some_and(|process| process.identity().pid() != first_pid)
            {
                assert!(
                    observed_backoff,
                    "a real post-ready crash must traverse supervisor restart backoff before a new root runs",
                );
                return;
            }
            assert!(
                started.elapsed() < RECOVERY_DEADLINE,
                "the real packaged Gateway did not restart after its owned root exited"
            );
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    async fn assert_graceful_stop(&mut self) {
        let outcome = wait_termination(self.supervisor.handle().stop().await, STOP_DEADLINE).await;
        assert!(matches!(outcome, TerminationOutcome::Graceful(_)));
    }

    async fn http_status_if_reachable(&self, path: &str) -> Option<u16> {
        let mut stream = TcpStream::connect(self.endpoint.address()).await.ok()?;
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut response = Vec::new();
        timeout(HTTP_PROBE_DEADLINE, stream.read_to_end(&mut response))
            .await
            .ok()?
            .ok()?;
        parse_http_status(&response)
    }

    async fn http_status(&self, path: &str) -> u16 {
        self.http_status_if_reachable(path)
            .await
            .expect("the real Gateway probe endpoint must be reachable")
    }

    async fn finish(&mut self) {
        let outcome = self.supervisor.handle().shutdown().await;
        match outcome {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                let outcome = timeout(STOP_DEADLINE, completion.wait())
                    .await
                    .expect("fixture supervisor shutdown must be bounded")
                    .expect("fixture supervisor shutdown must settle");
                assert!(matches!(
                    outcome,
                    ShutdownOutcome::Terminated(_) | ShutdownOutcome::Detached
                ));
            }
            CommandReceipt::AlreadySatisfied => {}
            CommandReceipt::Busy => panic!("fixture supervisor shutdown was busy"),
            CommandReceipt::Rejected(_) => panic!("fixture supervisor shutdown was rejected"),
            CommandReceipt::ShuttingDown => panic!("fixture supervisor was already shutting down"),
        }
        timeout(STOP_DEADLINE, self.supervisor.join())
            .await
            .expect("fixture supervisor task must terminate")
            .expect("fixture supervisor task must not panic");
        assert!(self.root.path().exists());
    }
}

struct PackagedArtifact {
    working_directory: PathBuf,
    electron_image: PathBuf,
    openclaw_dir: PathBuf,
    entry: PathBuf,
}

impl PackagedArtifact {
    fn resolve() -> Self {
        let root = PathBuf::from(
            std::env::var_os(PACKAGED_UNPACKED_ENV).expect(
                "set MATCHACLAW_PACKAGED_UNPACKED to a real unpacked Electron artifact with bundled OpenClaw",
            ),
        );
        let working_directory = root.join("resources");
        let electron_image = root.join("MatchaClaw.exe");
        let openclaw_dir = working_directory.join("openclaw");
        let entry = openclaw_dir.join("openclaw.mjs");
        for path in [&root, &electron_image, &openclaw_dir, &entry] {
            assert!(
                path.is_absolute() && path.exists(),
                "MATCHACLAW_PACKAGED_UNPACKED must name a real unpacked Electron artifact with bundled OpenClaw; missing {}",
                path.display()
            );
        }
        Self {
            working_directory,
            electron_image,
            openclaw_dir,
            entry,
        }
    }
}

struct FixtureRoot {
    path: PathBuf,
}

impl FixtureRoot {
    fn new() -> Self {
        let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("fixture clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "matcha-openclaw-native-fixture-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("fixture root must be created");
        Self { path }
    }

    fn state_dir(&self) -> CanonicalStateDir {
        CanonicalStateDir::provision(self.path.join("state"))
            .expect("fixture state directory must be provisioned")
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn build_supervisor(
    launch: LaunchFactory,
    gateway: &OpenClawGateway,
    diagnostics: Arc<Mutex<Vec<LifecycleDiagnostic>>>,
) -> Supervisor {
    supervise(
        ProcessContainment::job(),
        launch,
        OpenClawStdioActivation::new(Arc::new(move |diagnostic| {
            diagnostics
                .lock()
                .expect("fixture diagnostic sink lock must be available")
                .push(diagnostic);
        })),
        gateway.readiness_policy(),
        gateway.graceful_stop_policy(),
        OpenClawStartRecovery::new(),
        OpenClawRestartPolicy,
    )
}

fn reserve_loopback_port() -> u16 {
    std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .expect("fixture must reserve a loopback port")
        .local_addr()
        .expect("fixture loopback listener must expose its address")
        .port()
}

fn fixture_secret() -> String {
    let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("fixture clock must follow the Unix epoch")
        .as_nanos();
    format!("native-fixture-{nanos}-{sequence}")
}

fn fixture_session_id() -> String {
    let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
    format!("native-fixture-session-{sequence}")
}

fn fixture_cron_name() -> String {
    let sequence = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
    format!("native-fixture-cron-{sequence}")
}

fn parse_http_status(response: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(response).ok()?.lines().next()?;
    line.split_whitespace().nth(1)?.parse().ok()
}

async fn wait_started(
    receipt: CommandReceipt<foundation::process::supervision::StartOutcome>,
    deadline: Duration,
) {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            timeout(deadline, completion.wait())
                .await
                .expect("fixture process startup must be bounded")
                .expect("real packaged OpenClaw must reach authenticated supervisor readiness");
        }
        CommandReceipt::AlreadySatisfied => panic!("fixture process start was already satisfied"),
        CommandReceipt::Busy => panic!("fixture process start was busy"),
        CommandReceipt::Rejected(_) => panic!("fixture process start was rejected"),
        CommandReceipt::ShuttingDown => panic!("fixture process supervisor was shutting down"),
    }
}

async fn wait_restarted(
    receipt: CommandReceipt<foundation::process::supervision::RestartOutcome>,
    deadline: Duration,
) {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            timeout(deadline, completion.wait())
                .await
                .expect("fixture process restart must be bounded")
                .expect("real packaged OpenClaw must restart through the supervisor");
        }
        CommandReceipt::AlreadySatisfied => panic!("fixture process restart was already satisfied"),
        CommandReceipt::Busy => panic!("fixture process restart was busy"),
        CommandReceipt::Rejected(_) => panic!("fixture process restart was rejected"),
        CommandReceipt::ShuttingDown => panic!("fixture process supervisor was shutting down"),
    }
}

async fn wait_termination(
    receipt: CommandReceipt<foundation::process::supervision::TerminationCompletion>,
    deadline: Duration,
) -> TerminationOutcome {
    let completion = match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => completion,
        CommandReceipt::AlreadySatisfied => panic!("fixture termination was already satisfied"),
        CommandReceipt::Busy => panic!("fixture termination was busy"),
        CommandReceipt::Rejected(_) => panic!("fixture termination was rejected"),
        CommandReceipt::ShuttingDown => panic!("fixture termination was rejected during shutdown"),
    };
    let completion = timeout(deadline, completion.wait())
        .await
        .expect("fixture termination must be bounded")
        .expect("fixture termination must settle");
    match completion {
        foundation::process::supervision::TerminationCompletion::Completed(outcome) => outcome,
        foundation::process::supervision::TerminationCompletion::Superseded { .. } => {
            panic!("fixture termination must not be superseded")
        }
    }
}

async fn wait_for_initial_start_recovery(supervisor: &Supervisor, deadline: Duration) {
    let started = Instant::now();
    loop {
        let snapshot = supervisor.handle().snapshot();
        if snapshot.phase() == SupervisorPhase::WaitingToRestart {
            return;
        }
        assert!(
            snapshot.phase() != SupervisorPhase::OperationFailed,
            "the real packaged Gateway did not enter initial-start recovery"
        );
        assert!(
            started.elapsed() < deadline,
            "the real packaged Gateway did not enter initial-start recovery within {deadline:?}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn wait_for_phase(supervisor: &Supervisor, expected: SupervisorPhase, deadline: Duration) {
    let started = Instant::now();
    loop {
        if supervisor.handle().snapshot().phase() == expected {
            return;
        }
        assert!(
            started.elapsed() < deadline,
            "fixture supervisor did not reach {expected:?} within {deadline:?}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
