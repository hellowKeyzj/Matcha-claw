use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use platform::mcp::{
    CallToolResult, CapabilityCatalog, CapabilityProvider, ContentBlock, ProviderRegistration,
    ReadResourceFuture, Registry, ResourceBody, ResourceContents, ResourceReadError, Tool,
    ToolCallError, ToolResultFuture,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use zeroize::Zeroizing;

const CAPABILITY_ENV: &str = "MATCHA_IAB_CAPABILITY";
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Capability {
    session_id: String,
    instance_id: String,
    #[serde(deserialize_with = "secret", serialize_with = "serialize_secret")]
    token: Zeroizing<String>,
}

// Only the synchronous MCP entrypoint calls this, before constructing Tokio or spawning threads.
#[allow(unsafe_code)]
pub(super) fn consume_capability() -> Option<Capability> {
    let raw = std::env::var_os(CAPABILITY_ENV);
    // SAFETY: process entry dispatches directly here before any concurrent environment readers.
    unsafe { std::env::remove_var(CAPABILITY_ENV) };
    let raw = Zeroizing::new(raw?.into_string().ok()?);
    if raw.len() as u64 > MAX_METADATA_BYTES {
        return None;
    }
    let capability: Capability = serde_json::from_str(&raw).ok()?;
    if ![
        capability.session_id.as_str(),
        capability.instance_id.as_str(),
    ]
    .into_iter()
    .all(|value| value.len() == 36 && uuid::Uuid::parse_str(value).is_ok())
        || capability.token.len() != 64
        || !capability
            .token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    Some(capability)
}

pub(super) struct Iab {
    watch: tokio::task::JoinHandle<()>,
}

impl Iab {
    pub(super) async fn attach(
        state_dir: PathBuf,
        capability: Capability,
        registry: &Registry,
    ) -> Result<Self, ()> {
        let gateway = Arc::new(Gateway {
            state_dir,
            capability,
        });
        let catalog = gateway.catalog().await.unwrap_or_default();
        let registration = registry
            .register(gateway.clone(), catalog)
            .map_err(|_| ())?;
        Ok(Self {
            watch: tokio::spawn(observe(gateway, registration)),
        })
    }
}

impl Drop for Iab {
    fn drop(&mut self) {
        self.watch.abort();
    }
}

struct Gateway {
    state_dir: PathBuf,
    capability: Capability,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    discovery: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Discovery {
    identity: String,
    port: u16,
    #[serde(deserialize_with = "secret")]
    token: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    tools: Vec<Tool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultEnvelope {
    result: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCall<'a> {
    params: &'a Map<String, Value>,
    capability: &'a Capability,
    invocation_id: &'a str,
    input_message_id: &'a str,
}

fn secret<'de, D: Deserializer<'de>>(decoder: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(decoder).map(Zeroizing::new)
}

fn serialize_secret<S: Serializer>(
    value: &Zeroizing<String>,
    encoder: S,
) -> Result<S::Ok, S::Error> {
    encoder.serialize_str(value)
}

impl Gateway {
    fn discovery(&self) -> Result<Discovery, ()> {
        let bytes = read_metadata(&self.state_dir.join("iab-agent.json")).map_err(|_| ())?;
        let descriptor: Descriptor = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if !descriptor.discovery.is_absolute()
            || descriptor
                .discovery
                .as_os_str()
                .as_encoded_bytes()
                .contains(&0)
        {
            return Err(());
        }
        let bytes = read_metadata(&descriptor.discovery).map_err(|_| ())?;
        let discovery: Discovery = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if uuid::Uuid::parse_str(&discovery.identity).is_err()
            || discovery.port == 0
            || discovery.token.len() != 64
            || !discovery
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(());
        }
        Ok(discovery)
    }

    async fn catalog(&self) -> Result<CapabilityCatalog, ()> {
        let (status, bytes) = self
            .request(
                "GET",
                "/matcha/catalog",
                &[],
                Duration::from_secs(5),
                super::MAX_BYTES,
            )
            .await?;
        if status != 200 {
            return Err(());
        }
        let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if catalog.tools.len() > 1
            || catalog.tools.iter().any(|tool| {
                tool.name != "browser"
                    || !tool
                        .attributes
                        .get("description")
                        .is_some_and(Value::is_string)
            })
        {
            return Err(());
        }
        Ok(CapabilityCatalog {
            tools: catalog.tools,
            resources: Vec::new(),
        })
    }

    async fn call(
        &self,
        arguments: &Map<String, Value>,
        input_message_id: &str,
    ) -> Result<CallToolResult, ()> {
        let invocation_id = uuid::Uuid::new_v4().to_string();
        let body = Zeroizing::new(
            serde_json::to_vec(&BrowserCall {
                params: arguments,
                capability: &self.capability,
                invocation_id: &invocation_id,
                input_message_id,
            })
            .map_err(|_| ())?,
        );
        if body.len() > MAX_REQUEST_BYTES {
            return Ok(CallToolResult::error(
                "Browser request exceeds the input limit.".into(),
            ));
        }
        let (status, bytes) = self
            .request(
                "POST",
                "/matcha/browser",
                &body,
                Duration::from_secs(310),
                MAX_RESPONSE_BYTES,
            )
            .await?;
        if status != 200 {
            let error: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            let message = error
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .ok_or(())?;
            return Ok(CallToolResult::error(message.to_owned()));
        }
        let result: ResultEnvelope = serde_json::from_slice(&bytes).map_err(|_| ())?;
        rich_result(result.result, &invocation_id)
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<(u16, Vec<u8>), ()> {
        let discovery = self.discovery()?;
        tokio::time::timeout(timeout, async {
            // HTTP/1.0 prevents chunked responses; one owned socket makes future drop a disconnect.
            let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, discovery.port)).await.map_err(|_| ())?;
            let header = Zeroizing::new(format!(
                "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                discovery.port, discovery.token.as_str(), body.len(),
            ));
            stream.write_all(header.as_bytes()).await.map_err(|_| ())?;
            stream.write_all(body).await.map_err(|_| ())?;
            let mut bytes = Vec::new();
            (&mut stream).take((max_bytes + MAX_HEADER_BYTES + 1) as u64)
                .read_to_end(&mut bytes).await.map_err(|_| ())?;
            parse_response(bytes, max_bytes)
        }).await.map_err(|_| ())?
    }
}

impl CapabilityProvider for Gateway {
    fn call_tool<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> ToolResultFuture<'a> {
        self.call_tool_with_meta(name, arguments, None)
    }

    fn call_tool_with_meta<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
        meta: Option<&'a Map<String, Value>>,
    ) -> ToolResultFuture<'a> {
        Box::pin(async move {
            if name != "browser" {
                return Err(ToolCallError::InvalidParams);
            }
            let Some(input_message_id) = meta
                .and_then(|meta| meta.get("matcha/iabInputMessageId"))
                .and_then(Value::as_str)
                .filter(|value| {
                    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == *value)
                })
            else {
                return Ok(CallToolResult::error(
                    "Browser calls require trusted _meta['matcha/iabInputMessageId'] containing a canonical UUID; no action was attempted.".into(),
                ));
            };
            Ok(self.call(arguments, input_message_id).await.unwrap_or_else(|()| CallToolResult::error(
                "Browser gateway is unavailable, timed out or returned invalid data; the action was not retried and completion is unknown.".into(),
            )))
        })
    }

    fn read_resource<'a>(&'a self, _uri: &'a str) -> ReadResourceFuture<'a> {
        Box::pin(async { Err(ResourceReadError::NotFound) })
    }
}

async fn observe(gateway: Arc<Gateway>, registration: ProviderRegistration) {
    loop {
        // The initial catalog is published before stdio serves initialize.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let catalog = gateway.catalog().await.unwrap_or_default();
        if registration.replace(catalog).is_err() {
            let _ = registration.replace(CapabilityCatalog::default());
        }
        // Discovery/catalog reads are repeatable; browser actions are never replayed.
    }
}

fn parse_response(mut bytes: Vec<u8>, max_bytes: usize) -> Result<(u16, Vec<u8>), ()> {
    let header_end = bytes
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or(())?
        + 4;
    if header_end > MAX_HEADER_BYTES || bytes.len() - header_end > max_bytes {
        return Err(());
    }
    let header = std::str::from_utf8(&bytes[..header_end]).map_err(|_| ())?;
    let mut lines = header.split("\r\n");
    let mut status = lines.next().ok_or(())?.split_ascii_whitespace();
    if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
        return Err(());
    }
    let status: u16 = status.next().ok_or(())?.parse().map_err(|_| ())?;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(());
        }
        if name.eq_ignore_ascii_case("content-length")
            && value.trim().parse::<usize>().map_err(|_| ())? != bytes.len() - header_end
        {
            return Err(());
        }
    }
    bytes.drain(..header_end);
    Ok((status, bytes))
}

fn read_metadata(path: &Path) -> io::Result<Zeroizing<Vec<u8>>> {
    let file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_METADATA_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(bytes)
}

fn rich_result(mut result: Value, invocation_id: &str) -> Result<CallToolResult, ()> {
    let mut content = Vec::new();
    if let Some(object) = result.as_object_mut() {
        if let Some(image) = object.remove("imageBase64") {
            let Value::String(data) = image else {
                return Err(());
            };
            let mime_type = match object.remove("imageType").as_ref().and_then(Value::as_str) {
                Some("png") => "image/png",
                Some("jpeg") => "image/jpeg",
                _ => return Err(()),
            };
            content.push(ContentBlock::Image {
                data,
                mime_type: mime_type.into(),
                attributes: Map::new(),
            });
        }
        if let Some(pdf) = object.remove("pdfBase64") {
            let Value::String(blob) = pdf else {
                return Err(());
            };
            content.push(ContentBlock::Resource {
                resource: ResourceContents {
                    uri: format!("iab://browser/{invocation_id}/document.pdf"),
                    mime_type: Some("application/pdf".into()),
                    body: ResourceBody::Blob { blob },
                    meta: None,
                },
                attributes: Map::new(),
            });
        }
    }
    if content.is_empty() || !result.as_object().is_some_and(Map::is_empty) {
        content.insert(
            0,
            ContentBlock::text(serde_json::to_string(&result).map_err(|_| ())?),
        );
    }
    Ok(CallToolResult {
        content,
        structured_content: None,
        is_error: None,
        meta: None,
    })
}
