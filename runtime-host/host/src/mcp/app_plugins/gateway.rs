use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use platform::mcp::{
    CallToolResult, ReadResourceResult, Resource, ResourceReadError, Tool, ToolCallError,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

pub(super) struct Gateway {
    state_dir: PathBuf,
    catalog_client: reqwest::Client,
    call_client: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    discovery: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Discovery {
    pub identity: String,
    port: u16,
    #[serde(deserialize_with = "secret")]
    token: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Catalog {
    pub revision: String,
    pub tools: Vec<Tool>,
    pub resources: Vec<Resource>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultEnvelope<T> {
    result: T,
}

#[derive(Serialize)]
struct ToolCall<'a> {
    name: &'a str,
    arguments: &'a Map<String, Value>,
}

#[derive(Serialize)]
struct ResourceRead<'a> {
    uri: &'a str,
}

fn secret<'de, D: Deserializer<'de>>(decoder: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(decoder).map(Zeroizing::new)
}

impl Gateway {
    pub(super) fn new(state_dir: PathBuf) -> Result<Self, ()> {
        Ok(Self {
            state_dir,
            catalog_client: client(Duration::from_secs(30))?,
            call_client: client(Duration::from_secs(30 * 60))?,
        })
    }

    pub(super) fn discovery(&self) -> io::Result<Discovery> {
        let bytes = read_metadata(&self.state_dir.join("app-plugin-agent.json"))?;
        let descriptor: Descriptor = serde_json::from_slice(&bytes).map_err(invalid_metadata)?;
        if !descriptor.discovery.is_absolute()
            || descriptor
                .discovery
                .as_os_str()
                .as_encoded_bytes()
                .contains(&0)
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let bytes = read_metadata(&descriptor.discovery)?;
        let discovery: Discovery = serde_json::from_slice(&bytes).map_err(invalid_metadata)?;
        if uuid::Uuid::parse_str(&discovery.identity).is_err()
            || discovery.port == 0
            || discovery.token.len() != 64
            || !discovery
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(discovery)
    }

    pub(super) async fn catalog(
        &self,
        discovery: &Discovery,
        revision: Option<&str>,
    ) -> Result<Option<Catalog>, ()> {
        let authorization = discovery.authorization();
        let mut request = self
            .catalog_client
            .get(discovery.url("/catalog"))
            .header(reqwest::header::AUTHORIZATION, authorization.as_str());
        if let Some(revision) = revision {
            request = request.query(&[("revision", revision)]);
        }
        let response = request.send().await.map_err(|_| ())?;
        if response.status() == reqwest::StatusCode::NO_CONTENT && revision.is_some() {
            return Ok(None);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(());
        }
        let bytes = response.bytes().await.map_err(|_| ())?;
        let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if catalog.revision.is_empty() {
            return Err(());
        }
        Ok(Some(catalog))
    }

    pub(super) async fn call(
        &self,
        name: &str,
        arguments: &Map<String, Value>,
    ) -> Result<CallToolResult, ToolCallError> {
        let response = self
            .post("/tools/call", &ToolCall { name, arguments })
            .await
            .map_err(|_| unavailable())?;
        let successful = response.status().is_success();
        let bytes = response.bytes().await.map_err(|_| unavailable())?;
        if !successful {
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
            return Ok(CallToolResult::error(
                body.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("App plugin tool failed; no success was confirmed.")
                    .to_owned(),
            ));
        }
        serde_json::from_slice::<ResultEnvelope<CallToolResult>>(&bytes)
            .map(|envelope| envelope.result)
            .map_err(|_| unavailable())
    }

    pub(super) async fn read(&self, uri: &str) -> Result<ReadResourceResult, ResourceReadError> {
        let response = self
            .post("/resources/read", &ResourceRead { uri })
            .await
            .map_err(|_| ResourceReadError::Internal)?;
        match response.status() {
            reqwest::StatusCode::OK => {}
            reqwest::StatusCode::NOT_FOUND => return Err(ResourceReadError::NotFound),
            reqwest::StatusCode::BAD_REQUEST => return Err(ResourceReadError::InvalidParams),
            _ => return Err(ResourceReadError::Internal),
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| ResourceReadError::Internal)?;
        serde_json::from_slice::<ResultEnvelope<ReadResourceResult>>(&bytes)
            .map(|envelope| envelope.result)
            .map_err(|_| ResourceReadError::Internal)
    }

    async fn post(&self, path: &str, payload: &impl Serialize) -> Result<reqwest::Response, ()> {
        let body = serde_json::to_vec(payload).map_err(|_| ())?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(());
        }
        let discovery = self.discovery().map_err(|_| ())?;
        let authorization = discovery.authorization();
        // A dropped MCP call drops this request/body wait; Main propagates disconnect to its handler.
        self.call_client
            .post(discovery.url(path))
            .header(reqwest::header::AUTHORIZATION, authorization.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| ())
    }
}

impl Discovery {
    fn authorization(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("Bearer {}", self.token.as_str()))
    }
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, ()> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| ())
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

fn invalid_metadata(_: serde_json::Error) -> io::Error {
    io::ErrorKind::InvalidData.into()
}

fn unavailable() -> ToolCallError {
    ToolCallError::ExecutionText(
        "App plugin gateway is unavailable or returned invalid data; no success was confirmed."
            .into(),
    )
}
