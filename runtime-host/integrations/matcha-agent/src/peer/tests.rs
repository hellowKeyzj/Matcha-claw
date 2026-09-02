use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::{net::TcpListener, sync::atomic::AtomicUsize, time::Duration};

#[cfg(unix)]
use foundation::process::InvalidGuardianExecutable;
#[cfg(windows)]
use foundation::process::TerminationOutcome;
use foundation::process::supervision::SupervisorPhase;
#[cfg(windows)]
use foundation::process::supervision::{RestartOutcome, TerminationCompletion};
use foundation::toolchain::{
    NativeToolchainRuntime, ToolchainPlatform, UnsupportedToolchainCommandPort,
};

use super::*;
use crate::{
    lifecycle::{launch::LaunchError, secret::Secret},
    session::client::AppServerClientError,
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "runtime-host-matcha-peer-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("test storage parent must be created");
        Self(root)
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}

fn input(root: &TestRoot) -> MatchaPeerInput {
    MatchaPeerInput {
        bun_executable: absolute_path("bin/bun"),
        entry: absolute_path("matcha-agent/dist/cli-bun.js"),
        working_directory: absolute_path("runtime"),
        storage_root: root.0.join("storage"),
        port: 18_790,
        toolchain: toolchain(),
        report_diagnostic: Arc::new(|_| {}),
        #[cfg(windows)]
        git_bash: absolute_path("bin/bash.exe"),
        #[cfg(unix)]
        guardian_executable: absolute_path("bin/runtime-host-guardian"),
    }
}

fn secret() -> Secret {
    let entropy = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock must follow the Unix epoch")
        .as_nanos()
        ^ u128::from(NEXT_ROOT.fetch_add(1, Ordering::Relaxed));
    Secret::new(entropy.to_string()).unwrap()
}

fn toolchain() -> Arc<NativeToolchainRuntime> {
    Arc::new(NativeToolchainRuntime::new(
        ToolchainPlatform::current(),
        std::env::consts::ARCH,
        absolute_path("runtime"),
        None,
        Arc::new(UnsupportedToolchainCommandPort),
    ))
}

#[cfg(windows)]
struct PackagedMatchaArtifact {
    resources: PathBuf,
    bun_executable: PathBuf,
    entry: PathBuf,
    git_bash: PathBuf,
}

#[cfg(windows)]
impl PackagedMatchaArtifact {
    fn resolve() -> Option<Self> {
        let unpacked = std::env::var_os("MATCHACLAW_PACKAGED_UNPACKED")?;
        let resources = PathBuf::from(unpacked).join("resources");
        let artifact = Self {
            bun_executable: resources.join("bin").join("bun.exe"),
            entry: resources
                .join("matcha-agent")
                .join("dist")
                .join("cli-bun.js"),
            git_bash: resources
                .join("bin")
                .join("git-for-windows")
                .join("bin")
                .join("bash.exe"),
            resources,
        };
        (artifact.resources.join("app.asar").is_file()
            && artifact.bun_executable.is_file()
            && artifact.entry.is_file()
            && artifact.git_bash.is_file())
        .then_some(artifact)
    }
}

#[cfg(windows)]
fn packaged_input(root: &TestRoot, artifact: &PackagedMatchaArtifact) -> MatchaPeerInput {
    MatchaPeerInput {
        bun_executable: artifact.bun_executable.clone(),
        entry: artifact.entry.clone(),
        working_directory: artifact.resources.clone(),
        storage_root: root.0.join("storage"),
        port: available_loopback_port(),
        toolchain: toolchain(),
        report_diagnostic: Arc::new(|_| {}),
        git_bash: artifact.git_bash.clone(),
    }
}

#[cfg(windows)]
fn available_loopback_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("fixture must reserve a loopback port")
        .local_addr()
        .expect("reserved listener must have an address")
        .port()
}

#[cfg(windows)]
async fn wait_for_phase(peer: &MatchaPeer, expected: SupervisorPhase) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if peer.snapshot().phase() == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("packaged peer did not reach expected lifecycle phase");
}

#[cfg(windows)]
async fn wait_for_recovery_cycle(peer: &MatchaPeer, first_pid: u32) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = peer.snapshot();
            if snapshot.phase() == SupervisorPhase::Running
                && snapshot
                    .process()
                    .is_some_and(|process| process.identity().pid() != first_pid)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("packaged peer did not recover a new app-server process");
}

#[cfg(windows)]
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires MATCHACLAW_PACKAGED_UNPACKED to name a real unpacked Electron artifact"]
async fn packaged_app_server_fixture_proves_real_artifact_lifecycle() {
    let artifact = PackagedMatchaArtifact::resolve().expect(
        "set MATCHACLAW_PACKAGED_UNPACKED to a real unpacked Electron artifact with bundled Matcha",
    );
    let root = TestRoot::new();
    let diagnostics = Arc::new(AtomicUsize::new(0));
    let mut input = packaged_input(&root, &artifact);
    let observed_diagnostics = Arc::clone(&diagnostics);
    input.report_diagnostic = Arc::new(move |_| {
        observed_diagnostics.fetch_add(1, Ordering::Relaxed);
    });
    let peer = MatchaPeerFactory::try_new(input, secret())
        .expect("packaged artifact must produce a peer")
        .build();

    assert_eq!(
        peer.start().await,
        Ok(foundation::process::supervision::StartOutcome::Started)
    );
    assert_eq!(peer.snapshot().phase(), SupervisorPhase::Running);
    assert!(matches!(
        peer.list_history().await,
        crate::session::history::HistoryResult::Complete(_)
    ));

    let first_pid = peer
        .snapshot()
        .process()
        .expect("running peer must expose its owned process")
        .identity()
        .pid();
    assert!(kill_owned_process(first_pid));
    wait_for_recovery_cycle(&peer, first_pid).await;

    assert_eq!(peer.restart().await, Ok(RestartOutcome::Restarted));
    assert_eq!(peer.snapshot().phase(), SupervisorPhase::Running);

    assert!(matches!(
        peer.stop().await,
        Ok(TerminationCompletion::Completed(
            TerminationOutcome::Graceful(_)
        ))
    ));
    wait_for_phase(&peer, SupervisorPhase::Idle).await;

    assert!(matches!(peer.confirm_shutdown().await, Ok(_)));
    peer.join().await.expect("peer supervisor must join");
    assert_eq!(diagnostics.load(Ordering::Relaxed), 0);
}

#[cfg(windows)]
fn kill_owned_process(pid: u32) -> bool {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::{Foundation as F, System::Threading as T};

    // The PID is obtained from the supervisor's owned observation immediately
    // before termination, so the fixture never targets an arbitrary port owner.
    let raw = unsafe { T::OpenProcess(T::PROCESS_TERMINATE, 0, pid) };
    if raw.is_null() || raw == F::INVALID_HANDLE_VALUE {
        return false;
    }
    let process = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) };
    unsafe { T::TerminateProcess(process.as_raw_handle() as _, 1) != 0 }
}

#[test]
fn factory_does_not_spawn() {
    let root = TestRoot::new();

    let factory = MatchaPeerFactory::try_new(input(&root), secret()).unwrap();

    assert_eq!(format!("{factory:?}"), "MatchaPeerFactory { .. }");
    assert!(root.0.join("storage").is_dir());
}

#[tokio::test]
async fn built_peer_is_idle() {
    let root = TestRoot::new();
    let peer = MatchaPeerFactory::try_new(input(&root), secret())
        .unwrap()
        .build();

    assert_eq!(peer.snapshot().phase(), SupervisorPhase::Idle);
    assert!(root.0.join("storage").is_dir());

    assert!(matches!(peer.confirm_shutdown().await, Ok(_)));
    peer.join().await.unwrap();
}

#[test]
fn factory_rejects_invalid_endpoint_without_spawning() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.port = 0;

    let error = MatchaPeerFactory::try_new(input, secret()).unwrap_err();

    assert_eq!(
        error,
        ConstructionError::Endpoint(AppServerClientError::InvalidEndpoint)
    );
    assert_eq!(error.to_string(), "app-server endpoint is invalid");
}

#[test]
fn factory_rejects_invalid_launch_without_spawning() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.bun_executable = PathBuf::from("relative-sensitive-artifact");

    let error = match MatchaPeerFactory::try_new(input, secret()) {
        Ok(_) => panic!("invalid matcha-agent launch input was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, ConstructionError::Launch(LaunchError::InvalidInput));
    assert_eq!(error.to_string(), "matcha-agent launch input is invalid");
    assert!(!format!("{error:?} {error}").contains("sensitive"));
}

#[cfg(unix)]
#[test]
fn factory_rejects_relative_guardian_without_spawning() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.guardian_executable = PathBuf::from("relative-guardian");

    let error = match MatchaPeerFactory::try_new(input, secret()) {
        Ok(_) => panic!("relative guardian executable was accepted"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        ConstructionError::Guardian(InvalidGuardianExecutable)
    );
    assert_eq!(error.to_string(), "guardian executable is not absolute");
}
