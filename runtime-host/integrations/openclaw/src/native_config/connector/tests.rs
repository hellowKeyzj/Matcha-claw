use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use connectors::{
    Connector, ConnectorCatalog, ConnectorInput, ConnectorKind, ConnectorSecretRef,
    ConnectorSecretResolution, ConnectorSecretResolverPort, ConnectorSecretValue, McpTransport,
    unavailable_connector_secret_authority,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

use platform::state_dir::CanonicalStateDir;

use super::external::{
    ConnectorObservation, ConnectorProjectionEffect, ConnectorProjectionSkip,
    observe_external_connector, probe_external_connector, project_external_connectors,
    projection_effect,
};
use super::preset::{PRESET_MCP_SERVER_ID, project_preset_mcp_server};

static NEXT_PROJECTION_ROOT: AtomicU64 = AtomicU64::new(1);

struct MemoryConnectorSecretResolver;

impl ConnectorSecretResolverPort for MemoryConnectorSecretResolver {
    fn resolve(
        &self,
        reference: &ConnectorSecretRef,
    ) -> Result<ConnectorSecretResolution, connectors::ConnectorSecretAuthorityPortError> {
        let value = match reference.as_str() {
            "credential:v1:stdio-token" => "resolved-stdio-token",
            "credential:v1:http-token" => "resolved-http-token",
            _ => {
                return Ok(ConnectorSecretResolution::NotFound {
                    metadata: connectors::ConnectorSecretResolutionMetadata {
                        source: connectors::ConnectorSecretSourceStatus::NotFound,
                    },
                });
            }
        };
        Ok(ConnectorSecretResolution::Resolved {
            value: ConnectorSecretValue::from_secret(value).unwrap(),
            metadata: connectors::ConnectorSecretResolutionMetadata {
                source: connectors::ConnectorSecretSourceStatus::Resolved,
            },
        })
    }
}

#[test]
fn connector_projection_is_idempotent_and_preserves_unmanaged_servers() {
    let root = projection_root();
    let state_dir = canonical_state_dir(&root);
    let config_path = state_dir.as_path().join("openclaw.json");
    fs::write(
        &config_path,
        json!({
            "mcp": {
                "servers": {
                    "user-owned": { "command": "user-mcp", "args": ["--raw"] },
                    "removed": { "command": "bare-connector-id" },
                    "matcha-system": { "command": "legacy-mcp" },
                    "matcha-external.removed": { "command": "removed-mcp" },
                    "matcha-external.current": { "command": "old-managed-mcp" }
                }
            },
            "commands": { "custom": true }
        })
        .to_string(),
    )
    .unwrap();
    let catalog =
        ConnectorCatalog::try_new(vec![stdio_connector("matcha-external.current")]).unwrap();

    let (effect, report) = project_external_connectors(
        state_dir.clone(),
        &catalog,
        &unavailable_connector_secret_authority(),
    )
    .unwrap();
    assert_eq!(effect, ConnectorProjectionEffect::Written { changed: true });
    assert_eq!(report.projected, vec!["matcha-external.current"]);
    let first_bytes = fs::read(&config_path).unwrap();
    let first_document = config_document(&config_path);
    assert_eq!(
        first_document["mcp"]["servers"]["user-owned"],
        json!({ "command": "user-mcp", "args": ["--raw"] })
    );
    assert_eq!(
        first_document["mcp"]["servers"]["matcha-external.current"],
        json!({ "command": "managed-mcp", "args": ["--serve"] })
    );
    assert_eq!(
        first_document["mcp"]["servers"]["removed"],
        json!({ "command": "bare-connector-id" })
    );
    assert_eq!(
        first_document["mcp"]["servers"]["matcha-system"],
        json!({ "command": "legacy-mcp" })
    );
    assert!(
        first_document["mcp"]["servers"]
            .get("matcha-external.removed")
            .is_none()
    );
    assert_eq!(
        first_document["commands"],
        json!({ "custom": true, "restart": true })
    );

    let (effect, report) = project_external_connectors(
        state_dir,
        &catalog,
        &unavailable_connector_secret_authority(),
    )
    .unwrap();
    assert_eq!(
        effect,
        ConnectorProjectionEffect::Written { changed: false }
    );
    assert_eq!(report.projected, vec!["matcha-external.current"]);
    assert_eq!(fs::read(&config_path).unwrap(), first_bytes);
    assert_eq!(config_document(&config_path), first_document);

    remove_projection_root(root);
}

#[test]
fn preset_mcp_projection_is_idempotent_and_preserves_other_servers() {
    let root = projection_root();
    let state_dir = canonical_state_dir(&root);
    let config_path = state_dir.as_path().join("openclaw.json");
    let runtime_host_state_dir = root.join("runtime-host");
    let executable = root.join(if cfg!(windows) {
        "runtime-host-mcp.exe"
    } else {
        "runtime-host-mcp"
    });
    fs::write(
        &config_path,
        json!({
            "mcp": {
                "servers": {
                    "user-owned": { "command": "user-mcp", "args": ["--raw"] },
                    "matcha-external.current": { "command": "managed-mcp", "args": ["--serve"] },
                    "matcha-teamrun": { "command": "old-mcp", "enabled": false, "cwd": "custom-workspace" }
                }
            },
            "commands": { "custom": true }
        })
        .to_string(),
    )
    .unwrap();

    let effect =
        project_preset_mcp_server(state_dir.clone(), &executable, &runtime_host_state_dir);

    assert_eq!(effect, ConnectorProjectionEffect::Written { changed: true });
    let first_bytes = fs::read(&config_path).unwrap();
    let first_document = config_document(&config_path);
    let expected = json!({
        "command": executable.to_str().unwrap(),
        "args": ["--state-dir", runtime_host_state_dir.to_str().unwrap()],
        "transport": "stdio",
        "enabled": false,
        "cwd": "custom-workspace"
    });
    assert_eq!(PRESET_MCP_SERVER_ID, "matcha");
    assert_eq!(
        first_document["mcp"]["servers"][PRESET_MCP_SERVER_ID],
        expected
    );
    assert!(first_document["mcp"]["servers"].get("matcha-teamrun").is_none());
    assert_eq!(
        first_document["mcp"]["servers"]["user-owned"],
        json!({ "command": "user-mcp", "args": ["--raw"] })
    );
    assert_eq!(
        first_document["mcp"]["servers"]["matcha-external.current"],
        json!({ "command": "managed-mcp", "args": ["--serve"] })
    );
    assert_eq!(
        first_document["commands"],
        json!({ "custom": true, "restart": true })
    );
    let preset_server = first_document["mcp"]["servers"][PRESET_MCP_SERVER_ID]
        .as_object()
        .unwrap();
    for private_field in [
        "authorization",
        "authorizationVerificationKey",
        "authorization-verification-key",
        "verificationKey",
        "secretEnv",
        "env",
    ] {
        assert!(!preset_server.contains_key(private_field));
    }

    let effect =
        project_preset_mcp_server(state_dir.clone(), &executable, &runtime_host_state_dir);

    assert_eq!(
        effect,
        ConnectorProjectionEffect::Written { changed: false }
    );
    assert_eq!(fs::read(&config_path).unwrap(), first_bytes);
    assert_eq!(config_document(&config_path), first_document);

    remove_projection_root(root);
}

#[test]
fn connector_projection_cleans_stale_entries_for_disabled_and_unsupported_connectors() {
    let root = projection_root();
    let state_dir = canonical_state_dir(&root);
    let config_path = state_dir.as_path().join("openclaw.json");
    fs::write(
        &config_path,
        json!({
            "mcp": {
                "servers": {
                    "matcha-external.disabled": { "command": "stale" },
                    "matcha-external.unsupported": { "command": "stale" },
                    "user-owned": { "command": "retained" }
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let catalog = ConnectorCatalog::try_new(vec![
        disabled_connector("matcha-external.disabled"),
        unsupported_connector("matcha-external.unsupported"),
    ])
    .unwrap();

    let (effect, report) = project_external_connectors(
        state_dir,
        &catalog,
        &unavailable_connector_secret_authority(),
    )
    .unwrap();

    assert_eq!(effect, ConnectorProjectionEffect::Written { changed: true });
    assert!(report.projected.is_empty());
    assert_eq!(
        report.skipped,
        vec![
            (
                "matcha-external.disabled".into(),
                ConnectorProjectionSkip::Disabled,
            ),
            (
                "matcha-external.unsupported".into(),
                ConnectorProjectionSkip::Unsupported,
            ),
        ]
    );
    let document = config_document(&config_path);
    assert_eq!(
        document["mcp"]["servers"],
        json!({ "user-owned": { "command": "retained" } })
    );
    assert_eq!(document["commands"], json!({ "restart": true }));

    remove_projection_root(root);
}

#[test]
fn secret_ref_mcp_connectors_are_not_written_to_openclaw_config() {
    for connector in [
        mcp_stdio_secret_connector("matcha-external.stdio-secret", "credential:v1:opaque"),
        mcp_http_secret_connector("matcha-external.http-secret", "credential:v1:opaque"),
    ] {
        let root = projection_root();
        let state_dir = canonical_state_dir(&root);
        let config_path = state_dir.as_path().join("openclaw.json");
        let catalog = ConnectorCatalog::try_new(vec![connector.clone()]).unwrap();

        let (effect, report) = project_external_connectors(
            state_dir,
            &catalog,
            &unavailable_connector_secret_authority(),
        )
        .unwrap();

        assert_eq!(effect, ConnectorProjectionEffect::Unavailable);
        assert!(report.projected.is_empty());
        assert_eq!(
            report.skipped,
            vec![(
                connector.id().to_owned(),
                ConnectorProjectionSkip::Unsupported
            )]
        );
        assert!(!config_path.exists());
        remove_projection_root(root);
    }
}

#[test]
fn secret_ref_mcp_connectors_project_resolved_private_values_to_openclaw_config() {
    let root = projection_root();
    let state_dir = canonical_state_dir(&root);
    let config_path = state_dir.as_path().join("openclaw.json");
    let catalog = ConnectorCatalog::try_new(vec![
        mcp_stdio_secret_connector("matcha-external.stdio-secret", "credential:v1:stdio-token"),
        mcp_http_secret_connector("matcha-external.http-secret", "credential:v1:http-token"),
    ])
    .unwrap();
    let secrets = MemoryConnectorSecretResolver;

    let (effect, report) = project_external_connectors(state_dir, &catalog, &secrets).unwrap();

    assert_eq!(effect, ConnectorProjectionEffect::Written { changed: true });
    assert_eq!(
        report.projected,
        vec![
            "matcha-external.http-secret",
            "matcha-external.stdio-secret"
        ]
    );
    assert!(report.skipped.is_empty());
    let document = config_document(&config_path);
    assert_eq!(
        document["mcp"]["servers"]["matcha-external.stdio-secret"]["env"],
        json!({ "PUBLIC_ENV": "public", "MCP_TOKEN": "resolved-stdio-token" })
    );
    assert_eq!(
        document["mcp"]["servers"]["matcha-external.http-secret"]["headers"],
        json!({ "X-Public": "public", "Authorization": "resolved-http-token" })
    );
    assert!(!document.to_string().contains("credential:v1"));
    remove_projection_root(root);
}

#[test]
fn secret_ref_mcp_connectors_fail_closed_when_private_resolver_is_unavailable() {
    let root = projection_root();
    let state_dir = canonical_state_dir(&root);
    let config_path = state_dir.as_path().join("openclaw.json");
    let connector =
        mcp_http_secret_connector("matcha-external.http-secret", "credential:v1:http-token");
    let catalog = ConnectorCatalog::try_new(vec![connector.clone()]).unwrap();

    let (effect, report) = project_external_connectors(
        state_dir,
        &catalog,
        &unavailable_connector_secret_authority(),
    )
    .unwrap();

    assert_eq!(effect, ConnectorProjectionEffect::Unavailable);
    assert!(report.projected.is_empty());
    assert_eq!(
        report.skipped,
        vec![(
            connector.id().to_owned(),
            ConnectorProjectionSkip::Unsupported
        )]
    );
    assert!(!config_path.exists());
    remove_projection_root(root);
}

#[test]
fn connector_projection_maps_store_failure_classes_without_discarding_report() {
    assert_eq!(
        projection_effect(crate::native_config::config_store::OpenClawConfigStoreError::ReadFailed),
        ConnectorProjectionEffect::Unavailable
    );
    assert_eq!(
        projection_effect(
            crate::native_config::config_store::OpenClawConfigStoreError::CommittedButNotDurable
        ),
        ConnectorProjectionEffect::Unknown
    );
}

#[tokio::test(flavor = "current_thread")]
async fn connector_observation_matrix_keeps_non_probeable_states_typed() {
    let disabled = connector("disabled", ConnectorKind::McpHttp, Some(false), None);
    assert_eq!(
        observe_external_connector(&disabled),
        ConnectorObservation::Disabled
    );

    let unsupported = unsupported_connector("unsupported");
    assert_eq!(
        observe_external_connector(&unsupported),
        ConnectorObservation::Unsupported
    );

    let mut input = ConnectorInput::new("unknown".into(), ConnectorKind::McpHttp);
    input.enabled = Some(true);
    input.url = Some("http://127.0.0.1:1/mcp".into());
    let unknown = Connector::new(input);
    assert_eq!(
        observe_external_connector(&unknown),
        ConnectorObservation::Unknown
    );
    assert_eq!(
        probe_external_connector(&unknown_without_url()).await,
        ConnectorObservation::Unknown
    );

    let secret = mcp_http_secret_connector("secret", "credential:v1:opaque");
    assert_eq!(
        observe_external_connector(&secret),
        ConnectorObservation::Unsupported
    );
    assert_eq!(
        projection_effect(crate::native_config::config_store::OpenClawConfigStoreError::ReadFailed),
        ConnectorProjectionEffect::Unavailable
    );
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_accepts_sse_success_from_a_loopback_server() {
    let server = LoopbackMcpServer::start(
        http_response(
            "200 OK",
            Some("text/event-stream"),
            b"event: message\ndata: ready\n\n",
            "",
        ),
        ExpectedRequest::Sse,
        None,
    )
    .await;
    let connector = mcp_http_connector(&server.url(), Some("sse"), None);

    assert_eq!(
        probe_external_connector(&connector).await,
        ConnectorObservation::Connected
    );
    server.finish().await;
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_accepts_streamable_http_initialize_jsonrpc_from_loopback() {
    let server = LoopbackMcpServer::start(
        http_response(
            "200 OK",
            None,
            br#"{"jsonrpc":"2.0","id":"matcha-connector-probe","result":{"protocolVersion":"2024-11-05"}}"#,
            "",
        ),
        ExpectedRequest::StreamableHttp,
        None,
    )
    .await;
    let connector = mcp_http_connector(&server.url(), Some("streamable-http"), None);

    assert_eq!(
        probe_external_connector(&connector).await,
        ConnectorObservation::Connected
    );
    server.finish().await;
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_rejects_non_success_and_redirect_responses() {
    for response in [
        http_response(
            "503 Service Unavailable",
            Some("application/json"),
            b"{}",
            "",
        ),
        http_response(
            "302 Found",
            None,
            b"",
            "Location: http://127.0.0.1:9/final\r\n",
        ),
    ] {
        let server =
            LoopbackMcpServer::start(response, ExpectedRequest::StreamableHttp, None).await;
        let connector = mcp_http_connector(&server.url(), Some("streamable-http"), None);

        assert_eq!(
            probe_external_connector(&connector).await,
            ConnectorObservation::Disconnected
        );
        server.finish().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_accepts_valid_json_without_a_response_content_type_gate() {
    let server = LoopbackMcpServer::start(
        http_response(
            "200 OK",
            Some("text/plain"),
            br#"{"jsonrpc":"2.0","id":"matcha-connector-probe","result":{"protocolVersion":"2024-11-05"}}"#,
            "",
        ),
        ExpectedRequest::StreamableHttp,
        None,
    )
    .await;
    let connector = mcp_http_connector(&server.url(), Some("streamable-http"), None);

    assert_eq!(
        probe_external_connector(&connector).await,
        ConnectorObservation::Connected
    );
    server.finish().await;
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_rejects_invalid_initialize_json() {
    let server = LoopbackMcpServer::start(
        http_response("200 OK", Some("application/json"), b"not-json", ""),
        ExpectedRequest::StreamableHttp,
        None,
    )
    .await;
    let connector = mcp_http_connector(&server.url(), Some("streamable-http"), None);

    assert_eq!(
        probe_external_connector(&connector).await,
        ConnectorObservation::Disconnected
    );
    server.finish().await;
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_rejects_a_streamable_body_over_the_limit() {
    let body = vec![b'x'; 1_000_001];
    let server = LoopbackMcpServer::start(
        http_response("200 OK", Some("application/json"), &body, ""),
        ExpectedRequest::StreamableHttp,
        None,
    )
    .await;
    let connector = mcp_http_connector(&server.url(), Some("streamable-http"), None);

    assert_eq!(
        probe_external_connector(&connector).await,
        ConnectorObservation::Disconnected
    );
    server.finish().await;
}

#[tokio::test(flavor = "current_thread")]
async fn connector_probe_maps_a_deadline_timeout_to_disconnected() {
    let server = LoopbackMcpServer::start(
        Vec::new(),
        ExpectedRequest::StreamableHttp,
        Some(Duration::from_millis(100)),
    )
    .await;
    let connector = mcp_http_connector(&server.url(), Some("streamable-http"), Some(20));

    assert_eq!(
        probe_external_connector(&connector).await,
        ConnectorObservation::Disconnected
    );
    server.finish().await;
}

fn unknown_without_url() -> Connector {
    let mut input = ConnectorInput::new("missing-url".into(), ConnectorKind::McpHttp);
    input.enabled = Some(true);
    Connector::new(input)
}

fn mcp_http_connector(url: &str, transport: Option<&str>, timeout_ms: Option<u64>) -> Connector {
    let mut input = ConnectorInput::new("loopback".into(), ConnectorKind::McpHttp);
    input.enabled = Some(true);
    input.url = Some(url.into());
    input.transport = transport.map(|transport| match transport {
        "sse" => McpTransport::Sse,
        "streamable-http" => McpTransport::StreamableHttp,
        _ => panic!("unknown transport"),
    });
    input.connection_timeout_ms = timeout_ms;
    Connector::new(input)
}

#[derive(Clone, Copy)]
enum ExpectedRequest {
    Sse,
    StreamableHttp,
}

struct LoopbackMcpServer {
    url: String,
    task: JoinHandle<()>,
}

impl LoopbackMcpServer {
    async fn start(
        response: Vec<u8>,
        expected_request: ExpectedRequest,
        delay: Option<Duration>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut stream).await;
            assert_http_request(&request, expected_request);
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            if !response.is_empty() {
                let _ = stream.write_all(&response).await;
            }
        });
        Self {
            url: format!("http://{address}/mcp"),
            task,
        }
    }

    fn url(&self) -> &str {
        &self.url
    }

    async fn finish(self) {
        self.task.await.unwrap();
    }
}

async fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut expected_len = None;
    loop {
        let read = stream.read(&mut buffer).await.unwrap();
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if expected_len.is_none()
            && let Some(header_end) = find_header_end(&request)
        {
            let content_length = String::from_utf8_lossy(&request[..header_end])
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            expected_len = Some(header_end + 4 + content_length);
        }
        if expected_len.is_some_and(|length| request.len() >= length) {
            break;
        }
    }
    request
}

fn assert_http_request(request: &[u8], expected: ExpectedRequest) {
    let header_end = find_header_end(request).expect("HTTP request headers");
    let header = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
    match expected {
        ExpectedRequest::Sse => {
            assert!(header.starts_with("get /mcp http/1.1"));
            assert!(header.contains("accept: text/event-stream"));
        }
        ExpectedRequest::StreamableHttp => {
            assert!(header.starts_with("post /mcp http/1.1"));
            assert!(header.contains("accept: application/json, text/event-stream"));
            assert!(header.contains("content-type: application/json"));
            let body = &request[header_end + 4..];
            assert_eq!(
                serde_json::from_slice::<Value>(body).unwrap(),
                json!({
                    "jsonrpc": "2.0",
                    "id": "matcha-connector-probe",
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "matcha-connector-probe",
                            "version": "0.0.0"
                        }
                    }
                })
            );
        }
    }
}

fn find_header_end(request: &[u8]) -> Option<usize> {
    request.windows(4).position(|window| window == b"\r\n\r\n")
}

fn http_response(
    status: &str,
    content_type: Option<&str>,
    body: &[u8],
    extra_headers: &str,
) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(content_type) = content_type {
        response.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    response.push_str(extra_headers);
    response.push_str("\r\n");
    response
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
}

fn stdio_connector(id: &str) -> Connector {
    connector(
        id,
        ConnectorKind::McpStdio,
        Some(true),
        Some("managed-mcp".into()),
    )
}

fn disabled_connector(id: &str) -> Connector {
    connector(
        id,
        ConnectorKind::McpStdio,
        Some(false),
        Some("managed-mcp".into()),
    )
}

fn unsupported_connector(id: &str) -> Connector {
    connector(
        id,
        ConnectorKind::Cli,
        Some(true),
        Some("managed-cli".into()),
    )
}

fn connector(
    id: &str,
    kind: ConnectorKind,
    enabled: Option<bool>,
    command: Option<String>,
) -> Connector {
    let mut input = ConnectorInput::new(id.into(), kind);
    input.enabled = enabled;
    input.command = command;
    input.args = Some(vec!["--serve".into()]);
    Connector::new(input)
}

fn mcp_stdio_secret_connector(id: &str, reference: &str) -> Connector {
    let mut input = ConnectorInput::new(id.into(), ConnectorKind::McpStdio);
    input.enabled = Some(true);
    input.command = Some("managed-mcp".into());
    input.env = Some(BTreeMap::from([("PUBLIC_ENV".into(), "public".into())]));
    Connector::new(input).with_secret_references(
        Some(BTreeMap::from([("MCP_TOKEN".into(), reference.into())])),
        None,
        None,
    )
}

fn mcp_http_secret_connector(id: &str, reference: &str) -> Connector {
    let mut input = ConnectorInput::new(id.into(), ConnectorKind::McpHttp);
    input.enabled = Some(true);
    input.url = Some("https://example.test/mcp".into());
    input.headers = Some(BTreeMap::from([("X-Public".into(), "public".into())]));
    Connector::new(input).with_secret_references(
        None,
        Some(BTreeMap::from([("Authorization".into(), reference.into())])),
        None,
    )
}

fn projection_root() -> PathBuf {
    let sequence = NEXT_PROJECTION_ROOT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "matcha-openclaw-projection-test-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        sequence
    ))
}

fn canonical_state_dir(root: &std::path::Path) -> CanonicalStateDir {
    CanonicalStateDir::provision(root).unwrap()
}

fn config_document(config_path: &std::path::Path) -> Value {
    serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap()
}

fn remove_projection_root(root: PathBuf) {
    fs::remove_dir_all(root).unwrap();
}
