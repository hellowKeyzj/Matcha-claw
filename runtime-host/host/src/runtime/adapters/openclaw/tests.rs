use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use foundation::process::supervision::{SupervisorLease, SupervisorPhase};
use openclaw::projection::workspace::WorkspaceProjectionFixture;
use tokio_util::sync::CancellationToken;

use super::*;

static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

struct TestStateRoot {
    state_dir: CanonicalStateDir,
    workspace: WorkspaceProjectionFixture,
}

impl TestStateRoot {
    fn new() -> Self {
        let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "runtime-host-openclaw-state-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        let state_dir = CanonicalStateDir::provision(path).unwrap();
        let workspace = WorkspaceProjectionFixture::install(state_dir.as_path());
        Self {
            state_dir,
            workspace,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.state_dir.as_path().join(name)
    }

    fn state_dir(&self) -> CanonicalStateDir {
        let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        CanonicalStateDir::provision(self.path(&format!("openclaw-{sequence}"))).unwrap()
    }
}

impl Drop for TestStateRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.workspace.root());
    }
}

fn input(state_root: &TestStateRoot) -> OpenClawInput {
    OpenClawInput {
        team_run_mcp_executable: state_root.path("runtime-host-mcp"),
        team_run_mcp_state_dir: state_root.path("runtime-host"),
        electron_image: state_root.path("MatchaClaw"),
        working_directory: state_root.path("runtime"),
        openclaw_dir: state_root.workspace.openclaw_dir().to_owned(),
        managed_plugin_root: state_root.path("openclaw-plugins"),
        companion_skill_source_root: state_root.path("resources/skills/plugin-companion-skills"),
        subagent_template_dir: {
            let path = state_root.path("subagent-templates");
            fs::create_dir_all(&path).unwrap();
            path
        },
        entry: state_root.workspace.openclaw_dir().join("openclaw.mjs"),
        state_dir: state_root.state_dir(),
        port: 18_789,
        sealed_endpoint: None,
        sealed_token: None,
        client_metadata: GatewayClientMetadata::try_new(
            "1.0.0".into(),
            std::env::consts::OS.into(),
        )
        .unwrap(),
        report_diagnostic: Arc::new(|_| {}),
        #[cfg(unix)]
        guardian_executable: state_root.path("bin/runtime-host-guardian"),
    }
}

fn secret() -> GatewaySecret {
    let entropy = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock must follow the Unix epoch")
        .as_nanos()
        ^ u128::from(NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed));
    GatewaySecret::new(entropy.to_string()).unwrap()
}

#[test]
fn prepare_leaves_workspace_initialization_to_openclaw_startup() {
    let state_root = TestStateRoot::new();
    let input = input(&state_root);
    let state_dir = input.state_dir.clone();
    let reviewer_workspace = state_root.path("reviewer-workspace");
    let team_buddy_workspace = state_dir.as_path().join("teambuddy/team-a");
    fs::write(
        state_dir.as_path().join("openclaw.json"),
        serde_json::to_vec(&serde_json::json!({
            "gateway": { "auth": { "token": "construction-secret-canary" } },
            "models": { "providers": { "openai": { "apiKey": "construction-secret-canary" } } },
            "mcp": { "servers": { "user-owned": { "command": "user-mcp" } } },
            "agents": {
                "list": [
                    { "id": "reviewer", "workspace": reviewer_workspace },
                    { "id": "team-buddy", "workspace": team_buddy_workspace }
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let main_workspace = input.state_dir.as_path().join("workspace");
    let expected_team_run_mcp_executable = input.team_run_mcp_executable.clone();
    let expected_team_run_mcp_state_dir = input.team_run_mcp_state_dir.clone();
    OpenClawInstance::prepare(input, secret()).unwrap();

    assert!(!reviewer_workspace.exists());
    assert!(!main_workspace.exists());
    assert!(!team_buddy_workspace.exists());
    let config: Value =
        serde_json::from_slice(&fs::read(state_dir.as_path().join("openclaw.json")).unwrap())
            .unwrap();
    assert_eq!(
        config["gateway"]["controlUi"]["dangerouslyDisableDeviceAuth"],
        true,
    );
    assert_eq!(
        config["mcp"]["servers"]["user-owned"]["command"],
        "user-mcp"
    );
    assert_eq!(
        config["mcp"]["servers"]["matcha-teamrun"],
        serde_json::json!({
            "command": expected_team_run_mcp_executable,
            "args": ["--state-dir", expected_team_run_mcp_state_dir],
            "transport": "stdio",
            "enabled": true
        })
    );
}

#[test]
fn prepare_generates_fresh_identity_and_retains_shared_launch_resources() {
    let state_root = TestStateRoot::new();
    let first = OpenClawInstance::prepare(input(&state_root), secret()).unwrap();
    let second = OpenClawInstance::prepare(input(&state_root), secret()).unwrap();

    assert_ne!(
        first.listener_identity.fingerprint(),
        second.listener_identity.fingerprint()
    );
    assert_eq!(Arc::strong_count(&first.listener_identity), 1);
    assert_eq!(Arc::strong_count(&first.secret), 2);
}

#[tokio::test]
async fn preparation_then_construction_is_idle_and_retains_shared_gateway_handles() {
    let state_root = TestStateRoot::new();
    let (events, _received) = mpsc::channel(1);
    let (canonical_events, _received_canonical) = mpsc::channel(1);
    let instance = OpenClawInstance::prepare(input(&state_root), secret())
        .unwrap()
        .into_instance(
            events,
            canonical_events,
            ParentCallbackHandle::for_tests("http://127.0.0.1:9", "test-token"),
        )
        .unwrap();

    assert_eq!(instance.owner().snapshot().phase(), SupervisorPhase::Idle);
    assert_eq!(instance.control_ui_url(), "http://127.0.0.1:18789/");
    assert!(!instance.control_ui_url().contains(['?', '@', '#']));
}

#[tokio::test]
async fn cancelled_control_lease_is_unavailable_without_a_gateway_probe() {
    let cancellation = CancellationToken::new();
    let lease = SupervisorLease::test_lease(cancellation.clone());
    let identity = platform::listener_identity::ListenerIdentity::generate_loopback().unwrap();
    let (events, _) = mpsc::channel(1);
    let (canonical_events, _) = mpsc::channel(1);
    let gateway = Arc::new(Mutex::new(OpenClawGateway::new(
        GatewayEndpoint::try_new("127.0.0.1:18789".parse().unwrap()).unwrap(),
        identity.fingerprint(),
        Arc::new(GatewaySecret::new("control-lease-secret".into()).unwrap()),
        GatewayClientMetadata::try_new("1.0.0".into(), "windows".into()).unwrap(),
        events,
        canonical_events,
    )));
    cancellation.cancel();

    assert_eq!(
        ControlLease::probe(gateway, lease).observe_control().await,
        OpenClawControlReadiness::Unavailable
    );
}

#[test]
fn listener_identity_failure_is_fixed_and_redacted() {
    let error = ConstructionError::ListenerIdentity;

    assert_eq!(error.to_string(), "listener identity generation failed");
    assert_eq!(format!("{error:?}"), "ListenerIdentity");
    assert!(std::error::Error::source(&error).is_none());
}

#[tokio::test]
async fn invalid_endpoint_failure_is_typed_and_fixed() {
    let state_root = TestStateRoot::new();
    let mut input = input(&state_root);
    input.port = 0;

    let error = match OpenClawInstance::prepare(input, secret()) {
        Ok(_) => panic!("invalid gateway endpoint was accepted"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        ConstructionError::Endpoint(GatewayClientError::InvalidEndpoint)
    );
    assert_eq!(error.to_string(), "gateway endpoint is invalid");
}

#[tokio::test]
async fn invalid_launch_failure_is_typed_and_redacted() {
    let state_root = TestStateRoot::new();
    let mut input = input(&state_root);
    input.electron_image = PathBuf::from("relative-sensitive-artifact");

    let error = match OpenClawInstance::prepare(input, secret()) {
        Ok(_) => panic!("invalid OpenClaw launch input was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, ConstructionError::Launch(LaunchError::InvalidInput));
    assert_eq!(error.to_string(), "OpenClaw launch input is invalid");
    assert!(!format!("{error:?} {error}").contains("sensitive"));
}

#[cfg(unix)]
#[tokio::test]
async fn relative_guardian_failure_stays_typed() {
    let state_root = TestStateRoot::new();
    let mut input = input(&state_root);
    input.guardian_executable = PathBuf::from("relative-guardian");

    let error = match OpenClawInstance::prepare(input, secret()) {
        Ok(_) => panic!("relative guardian executable was accepted"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        ConstructionError::Guardian(InvalidGuardianExecutable)
    );
    assert_eq!(error.to_string(), "guardian executable is not absolute");
}
