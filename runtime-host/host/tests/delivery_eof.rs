#![recursion_limit = "512"]

use std::{
    fs,
    io::{BufReader, Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use openclaw::projection::workspace::WorkspaceProjectionFixture;
use serde_json::{Value, json};

#[test]
fn delivery_host_completes_request_then_shuts_down_cleanly_on_stdin_eof() {
    let root = TestRoot::new();
    let (bootstrap, ports) = bootstrap(&root);
    let mut child = Command::new(env!("CARGO_BIN_EXE_runtime-host"))
        .env(
            "MATCHACLAW_RUNTIME_HOST_PORT",
            ports.runtime_host.to_string(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn runtime-host");
    let mut input = child.stdin.take().expect("runtime-host stdin");
    let output = child.stdout.take().expect("runtime-host stdout");
    let (frames, ready) = read_frames(output);
    write_frame(&mut input, &bootstrap);
    if ready.recv_timeout(Duration::from_secs(5)) != Ok(()) {
        let status = wait_for_exit(&mut child, Duration::from_secs(5));
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .expect("runtime-host stderr")
            .read_to_string(&mut stderr)
            .expect("read runtime-host stderr");
        panic!("runtime-host exited before ready with {status}: {stderr}");
    }

    write_frame(
        &mut input,
        &json!({
            "version": 1,
            "type": "command",
            "id": "health-before-eof",
            "timeoutMs": 1_000,
            "command": { "name": "host.health" },
        }),
    );
    assert_eq!(
        frames.recv_timeout(Duration::from_secs(5)).unwrap()["id"],
        "health-before-eof"
    );
    for path in [
        "/api/workspace/files/read-text",
        "/api/workspace/files/binary",
        "/api/workspace/files/list-dir",
        "/api/workspace/files/write-text",
        "/api/workspace/media",
    ] {
        let port = ports.runtime_host;
        assert_eq!(post(port, path), 401);
    }

    drop(input);

    let status = wait_for_exit(&mut child, Duration::from_secs(5));
    let stderr = BufReader::new(child.stderr.take().expect("runtime-host stderr"))
        .bytes()
        .flatten()
        .collect::<Vec<_>>();
    assert!(
        status.success(),
        "runtime-host stderr: {}",
        String::from_utf8_lossy(&stderr)
    );
    let stderr = String::from_utf8_lossy(&stderr);
    assert!(
        !stderr.contains("runtime-host:"),
        "runtime-host stderr: {stderr}"
    );
    assert!(!stderr.contains("token"), "runtime-host stderr: {stderr}");
    assert!(
        !stderr.contains(&root.path("")),
        "runtime-host stderr: {stderr}"
    );
}

fn post(port: u16, path: &str) -> u16 {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect transport");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set response timeout");
    stream
        .write_all(
            format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{{}}")
                .as_bytes(),
        )
        .expect("write transport request");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("read transport response");
    response
        .split_whitespace()
        .nth(1)
        .expect("response status")
        .parse()
        .expect("numeric response status")
}

fn read_frames(
    mut output: impl Read + Send + 'static,
) -> (mpsc::Receiver<Value>, mpsc::Receiver<()>) {
    let (frames_sender, frames) = mpsc::channel();
    let (ready_sender, ready) = mpsc::channel();
    thread::spawn(move || {
        loop {
            let mut length = [0_u8; 4];
            if output.read_exact(&mut length).is_err() {
                return;
            }
            let mut body = vec![0_u8; u32::from_be_bytes(length) as usize];
            if output.read_exact(&mut body).is_err() {
                return;
            }
            let frame: Value = serde_json::from_slice(&body).expect("runtime-host control output");
            if frame["type"] == "ready" {
                let _ = ready_sender.send(());
            } else if frame["type"] == "outcome" && frames_sender.send(frame).is_err() {
                return;
            }
        }
    });
    (frames, ready)
}

fn write_frame(input: &mut impl Write, value: &Value) {
    let body = serde_json::to_vec(value).expect("serialize control frame");
    input
        .write_all(&(body.len() as u32).to_be_bytes())
        .expect("write control frame length");
    input.write_all(&body).expect("write control frame body");
    input.flush().expect("flush control frame");
}

fn wait_for_exit(child: &mut std::process::Child, timeout: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("observe runtime-host exit") {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "runtime-host did not exit after stdin EOF"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

struct TestRoot {
    path: std::path::PathBuf,
    openclaw: WorkspaceProjectionFixture,
}

impl TestRoot {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("runtime-host-delivery-eof-{nanos}"));
        fs::create_dir_all(&path).expect("create test root");
        fs::create_dir_all(path.join("work")).expect("create work directory");
        fs::create_dir_all(path.join("matcha-storage")).expect("create storage directory");
        fs::create_dir_all(path.join("subagent-templates")).expect("create template directory");
        Self {
            openclaw: WorkspaceProjectionFixture::install(&path),
            path,
        }
    }

    fn path(&self, name: &str) -> String {
        self.path.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn bootstrap(root: &TestRoot) -> (Value, DeliveryPorts) {
    let ports = delivery_ports();
    let root_path = root.path.to_string_lossy();
    let mut bootstrap = json!({
        "version": 1,
        "appVersion": "test",
        "appLogDir": root.path("userdata-logs"),
        "runtimeHostStateDir": root.path("runtime-host-state"),
        "runtimeHostMcpExecutable": format!("{root_path}/missing-runtime-host-mcp"),
        "parentCallbackBaseUrl": "http://127.0.0.1:1",
        "parentCallbackDispatchToken": "test-parent-dispatch-token",
        "deliveryVerificationKey": "MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE",
        "runtimeHostTransportPort": ports.runtime_host,
        "matcha": {
            "bunExecutable": format!("{root_path}/missing-bun"),
            "entry": format!("{root_path}/missing-entry"),
            "workingDirectory": root.path("work"),
            "storageRoot": root.path("matcha-storage"),
            "port": ports.matcha,
        },
        "openClaw": {
            "electronImage": format!("{root_path}/missing-electron"),
            "workingDirectory": root.path("work"),
            "openclawDir": root.openclaw.openclaw_dir(),
            "managedPluginRoot": root.path("openclaw-plugins"),
            "companionSkillSourceRoot": root.path("resources/skills/plugin-companion-skills"),
            "subagentTemplateDir": root.path("subagent-templates"),
            "entry": root.openclaw.openclaw_dir().join("openclaw.mjs"),
            "stateDir": root.path("state"),
            "port": ports.openclaw,
        },
    });
    #[cfg(windows)]
    {
        bootstrap["matcha"]["gitBash"] = Value::String(format!("{root_path}/missing-git-bash"));
    }
    #[cfg(unix)]
    {
        bootstrap["guardianExecutable"] = Value::String(format!("{root_path}/missing-guardian"));
    }
    (bootstrap, ports)
}

struct DeliveryPorts {
    runtime_host: u16,
    matcha: u16,
    openclaw: u16,
}

fn delivery_ports() -> DeliveryPorts {
    let mut ports = Vec::with_capacity(3);
    while ports.len() < 3 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve delivery port");
        let port = listener.local_addr().expect("delivery port address").port();
        drop(listener);
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    DeliveryPorts {
        runtime_host: ports[0],
        matcha: ports[1],
        openclaw: ports[2],
    }
}
