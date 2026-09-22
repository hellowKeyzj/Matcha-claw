use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use matcha_agent::lifecycle::secret::Secret;
use openclaw::{
    gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
    lifecycle::state_dir::CanonicalStateDir,
    projection::workspace::WorkspaceProjectionFixture,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncWriteExt, duplex},
    time::timeout,
};

use super::*;
use crate::{
    HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig,
    control::{ControlError, frame, wire},
};

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    base: PathBuf,
    matcha_storage_parent: PathBuf,
    state_parent: PathBuf,
    openclaw: WorkspaceProjectionFixture,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "runtime-host-control-{}/-{nanos}-{sequence}",
            std::process::id()
        ));
        let state_parent = base.join("state");
        let matcha_storage_parent = base.join("matcha");
        fs::create_dir_all(&state_parent).unwrap();
        fs::create_dir(&matcha_storage_parent).unwrap();
        let openclaw = WorkspaceProjectionFixture::install(&base);
        Self {
            matcha_storage_parent,
            state_parent,
            openclaw,
            base,
        }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[tokio::test]
async fn control_service_emits_bounded_host_health_and_shuts_down_on_eof() {
    let root = TestRoot::new();
    let mut input = host_input(&root);
    input.matcha.bun_executable = root.base.join("missing-matcha-bun");
    input.open_claw.electron_image = root.base.join("missing-openclaw-image");
    input.open_claw.port = free_local_port();
    input.cron_transport_port = free_local_port();
    disable_openclaw_autostart(&input);
    let (mut parent_input, control_input) = duplex(8 * 1024);
    let (control_output, mut parent_output) = duplex(8 * 1024);
    let service = tokio::spawn(run_control_service(input, control_input, control_output));

    assert_ready(read_output(&mut parent_output).await);

    write_command(&mut parent_input, command("health-1", "host.health")).await;
    let health = read_outcome(&mut parent_output, "health-1").await;
    assert_eq!(health["type"], "outcome");
    assert_eq!(health["id"], "health-1");
    assert_eq!(health["outcome"]["kind"], "succeeded");
    assert_eq!(health["outcome"]["result"]["health"]["ok"], true);
    assert_no_private_details(&health);

    parent_input.shutdown().await.unwrap();
    timeout(Duration::from_secs(1), service)
        .await
        .expect("control service must stop after input EOF")
        .expect("control service task must not panic")
        .expect("control service must cleanly shut down its Host owner");
}

#[tokio::test]
async fn control_service_rejects_openclaw_platform_product_commands() {
    for (id, name, input) in [
        (
            "openclaw-environment-status-1",
            "openclaw.environment.status",
            None,
        ),
        ("openclaw-runtime-paths-1", "openclaw.runtime.paths", None),
        ("openclaw-cli-command-1", "openclaw.cli.command", None),
        (
            "openclaw-tool-permission-get-1",
            "openclaw.tool-permission.get",
            None,
        ),
        (
            "openclaw-tool-permission-set-1",
            "openclaw.tool-permission.set",
            Some(json!({ "mode": "default" })),
        ),
        (
            "openclaw-subagent-templates-list-1",
            "openclaw.subagent-templates.list",
            None,
        ),
        (
            "openclaw-subagent-templates-get-1",
            "openclaw.subagent-templates.get",
            Some(json!({ "id": "brand-guardian" })),
        ),
    ] {
        let root = TestRoot::new();
        let (mut parent_input, control_input) = duplex(8 * 1024);
        let (control_output, mut parent_output) = duplex(8 * 1024);
        let service = tokio::spawn(run_control_service(
            host_input(&root),
            control_input,
            control_output,
        ));

        assert_ready(read_output(&mut parent_output).await);
        write_command(
            &mut parent_input,
            command_with_optional_input(id, name, input),
        )
        .await;
        let outcome = read_outcome(&mut parent_output, id).await;
        assert_eq!(outcome["outcome"]["kind"], "rejected");
        assert_eq!(outcome["outcome"]["error"]["code"], "INVALID_INPUT");
        parent_input.shutdown().await.unwrap();
        timeout(Duration::from_secs(1), service)
            .await
            .expect("control service must stop after input EOF")
            .expect("control service task must not panic")
            .expect("control service must cleanly shut down its Host owner");
    }
}

#[tokio::test]
async fn malformed_command_stops_the_service_after_the_ready_frame() {
    let root = TestRoot::new();
    let (mut parent_input, control_input) = duplex(8 * 1024);
    let (control_output, mut parent_output) = duplex(8 * 1024);
    let service = tokio::spawn(run_control_service(
        host_input(&root),
        control_input,
        control_output,
    ));

    assert_ready(read_output(&mut parent_output).await);
    frame::encode(&mut parent_input, br#"{"version":1}"#)
        .await
        .unwrap();

    assert_invalid_command(service).await;
}

async fn assert_invalid_command(service: tokio::task::JoinHandle<Result<(), ControlError>>) {
    let result = timeout(Duration::from_secs(1), service)
        .await
        .expect("control service must reject an invalid command")
        .expect("control service task must not panic");
    assert!(matches!(result, Err(ControlError::InvalidCommand)));
}

#[tokio::test]
async fn truncated_control_frame_stops_the_service_after_the_ready_frame() {
    let root = TestRoot::new();
    let (mut parent_input, control_input) = duplex(8 * 1024);
    let (control_output, mut parent_output) = duplex(8 * 1024);
    let service = tokio::spawn(run_control_service(
        host_input(&root),
        control_input,
        control_output,
    ));

    assert_ready(read_output(&mut parent_output).await);
    parent_input.write_all(&5_u32.to_be_bytes()).await.unwrap();
    parent_input.write_all(b"cut").await.unwrap();
    parent_input.shutdown().await.unwrap();

    let result = timeout(Duration::from_secs(1), service)
        .await
        .expect("control service must reject a truncated frame")
        .expect("control service task must not panic");
    assert!(matches!(result, Err(ControlError::Input)));
}

#[tokio::test]
async fn ready_write_failure_still_shuts_down_the_owned_host() {
    let root = TestRoot::new();
    let (control_output, parent_output) = duplex(8 * 1024);
    drop(parent_output);

    let result = run_control_service(host_input(&root), tokio::io::empty(), control_output).await;

    assert!(matches!(result, Err(ControlError::Output)));
}

fn assert_ready(frame: Value) {
    assert_eq!(frame, json!({ "version": 1, "type": "ready" }));
}

fn command(id: &str, name: &str) -> Value {
    json!({
        "version": 1,
        "type": "command",
        "id": id,
        "timeoutMs": 1_000,
        "command": { "name": name },
    })
}

fn command_with_optional_input(id: &str, name: &str, input: Option<Value>) -> Value {
    let mut command = json!({ "name": name });
    if let Some(input) = input {
        command["input"] = input;
    }
    json!({
        "version": 1,
        "type": "command",
        "id": id,
        "timeoutMs": 1_000,
        "command": command,
    })
}

fn assert_public_capability_details(outcome: &Value) {
    let serialized = outcome.to_string();
    for private in [
        "token",
        "secret",
        "argv",
        "path",
        "rawPayload",
        "sessionKey",
        "private-session-id",
        "provider metadata",
    ] {
        assert!(
            !serialized.contains(private),
            "private field leaked: {private}"
        );
    }
}

fn assert_ready_has_no_private_details(outcome: &Value) {
    let serialized = outcome.to_string();
    for private in [
        "required",
        "missing",
        "method",
        "code",
        "error",
        "retryAfter",
        "endpoint",
        "port",
        "token",
        "rawPayload",
        "supervisor",
        "sentinel",
    ] {
        assert!(!serialized.contains(private));
    }
}

fn assert_no_private_details(outcome: &Value) {
    let serialized = outcome.to_string();
    for private in [
        "missing-matcha-bun",
        "missing-openclaw-image",
        "endpoint",
        "port",
        "token",
        "argv",
        "gateway payload",
        "provider metadata",
        "session identity",
        "run identity",
        "message identity",
        "native error",
    ] {
        assert!(
            !serialized.contains(private),
            "private field {private} in {serialized}"
        );
    }
}

async fn write_command(input: &mut tokio::io::DuplexStream, command: Value) {
    let bytes = serde_json::to_vec(&command).unwrap();
    frame::encode(input, &bytes).await.unwrap();
}

async fn read_output(output: &mut tokio::io::DuplexStream) -> Value {
    let frame = frame::decode(output).await.unwrap();
    wire::decode_output(&frame).unwrap();
    serde_json::from_slice(&frame).unwrap()
}

async fn read_outcome(output: &mut tokio::io::DuplexStream, id: &str) -> Value {
    loop {
        let output = read_output(output).await;
        if output["type"] == "outcome" && output["id"] == id {
            return output;
        }
    }
}

fn free_local_port() -> u16 {
    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn disable_openclaw_autostart(input: &HostInput) {
    fs::write(
        input.open_claw.state_dir.as_path().join("settings-desired.v1.json"),
        br#"{"revision":1,"browserMode":"relay","proxy":{"enabled":false,"server":"","bypassRules":"<local>;localhost;127.0.0.1;::1"},"launchAtStartup":false,"gatewayAutoStart":false,"effect":"confirmed","correlations":[]}"#,
    )
    .unwrap();
}

fn host_input(root: &TestRoot) -> HostInput {
    let state_dir = CanonicalStateDir::provision(root.state_parent.join("openclaw")).unwrap();

    HostInput {
        matcha: MatchaAgentInput {
            bun_executable: absolute_path("bin/bun"),
            entry: absolute_path("matcha-agent/dist/cli-bun.js"),
            working_directory: absolute_path("runtime"),
            storage_root: root.matcha_storage_parent.join("app-server"),
            port: 18_790,
            #[cfg(windows)]
            git_bash: absolute_path("bin/bash.exe"),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        matcha_secret: Secret::new(entropy()).unwrap(),
        open_claw: OpenClawInput {
            team_run_mcp_executable: absolute_path("runtime-host-mcp"),
            team_run_mcp_state_dir: absolute_path("runtime-host"),
            electron_image: absolute_path("MatchaClaw"),
            working_directory: absolute_path("runtime"),
            openclaw_dir: root.openclaw.openclaw_dir().to_owned(),
            companion_skill_source_root: root.state_parent.join("openclaw-plugins"),
            managed_plugin_root: root.state_parent.join("openclaw-plugins"),
            subagent_template_dir: {
                let path = root.state_parent.join("subagent-templates");
                fs::create_dir_all(&path).expect("create subagent template directory");
                path
            },
            entry: root.openclaw.openclaw_dir().join("openclaw.mjs"),
            state_dir,
            port: 18_789,
            sealed_endpoint: None,
            sealed_token: None,
            client_metadata: GatewayClientMetadata::try_new(
                "test".into(),
                std::env::consts::OS.into(),
            )
            .unwrap(),
            report_diagnostic: Arc::new(|_| {}),
            #[cfg(unix)]
            guardian_executable: absolute_path("bin/runtime-host-guardian"),
        },
        open_claw_secret: GatewaySecret::new(entropy()).unwrap(),
        organization_store: organization::OrganizationStore::open(
            root.state_parent.join("organization-facts.log"),
        )
        .unwrap(),
        runtime_state_dir: root.state_parent.join("runtime-host"),
        app_log_dir: root.state_parent.join("userdata-logs"),
        parent_callback_base_url: "http://127.0.0.1:34100".into(),
        parent_callback_dispatch_token: "test-parent-dispatch-token".into(),
        cron_transport_port: 18_791,
        runtime_observation: RuntimeObservationConfig::off(),
    }
}

fn entropy() -> String {
    let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock must follow the Unix epoch")
        .as_nanos();
    format!("{nanos}-{sequence}")
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}
