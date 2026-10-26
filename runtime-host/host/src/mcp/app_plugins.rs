use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use platform::mcp::{ToolCallError, ToolCallFuture, ToolCallOutcome, ToolProvider};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const TOOL_NAMES: [&str; 6] = [
    "app_plugins_sdk",
    "app_plugins_list",
    "app_plugins_inspect",
    "app_plugins_build",
    "app_plugins_install",
    "app_plugins_status",
];

pub(super) struct AppPlugins {
    discovery: PathBuf,
    tools: Vec<Value>,
    client: reqwest::Client,
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
    tools: Vec<Value>,
}

fn secret<'de, D: Deserializer<'de>>(decoder: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(decoder).map(Zeroizing::new)
}

impl AppPlugins {
    pub(super) fn open(state_dir: &Path) -> Result<Option<Self>, ()> {
        let bytes = match read_metadata(&state_dir.join("app-plugin-agent.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
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
        let discovery = Discovery::read(&descriptor.discovery)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| ())?;
        Ok(Some(Self {
            discovery: descriptor.discovery,
            tools: discovery.tools,
            client,
        }))
    }

    async fn call_gateway(&self, name: &str, arguments: &Map<String, Value>) -> ToolCallOutcome {
        let body = serde_json::to_vec(&json!({ "name": name, "arguments": arguments }))
            .map_err(|_| unavailable())?;
        if body.len() > MAX_REQUEST_BYTES {
            return Err(ToolCallError::ExecutionText(
                "App plugin tool input exceeds 32 MiB.".into(),
            ));
        }
        let discovery = Discovery::read(&self.discovery).map_err(|_| unavailable())?;
        let authorization = Zeroizing::new(format!("Bearer {}", discovery.token.as_str()));
        let response = self
            .client
            .post(format!("http://127.0.0.1:{}/tools/call", discovery.port))
            .header(reqwest::header::AUTHORIZATION, authorization.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| unavailable())?;
        let successful = response.status().is_success();
        let bytes = response.bytes().await.map_err(|_| unavailable())?;
        let mut body: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if !successful {
            return Err(ToolCallError::ExecutionText(
                body.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("App plugin tool failed.")
                    .to_owned(),
            ));
        }
        body.as_object_mut()
            .and_then(|body| body.remove("result"))
            .ok_or_else(unavailable)
    }
}

impl ToolProvider for AppPlugins {
    fn tools(&self) -> Vec<Value> {
        self.tools.clone()
    }

    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> Option<ToolCallFuture<'a>> {
        self.tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            .then(|| Box::pin(self.call_gateway(name, arguments)) as ToolCallFuture<'a>)
    }
}

impl Discovery {
    fn read(path: &Path) -> Result<Self, ()> {
        let bytes = read_metadata(path).map_err(|_| ())?;
        let discovery: Self = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if uuid::Uuid::parse_str(&discovery.identity).is_err()
            || discovery.port == 0
            || discovery.token.len() != 64
            || !discovery
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || discovery.tools.len() != TOOL_NAMES.len()
        {
            return Err(());
        }
        let mut names = BTreeSet::new();
        for tool in &discovery.tools {
            let name = tool.get("name").and_then(Value::as_str).ok_or(())?;
            if !TOOL_NAMES.contains(&name)
                || !names.insert(name)
                || !tool.get("description").is_some_and(Value::is_string)
                || tool
                    .get("inputSchema")
                    .and_then(|schema| schema.get("type"))
                    .and_then(Value::as_str)
                    != Some("object")
            {
                return Err(());
            }
        }
        Ok(discovery)
    }
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

fn unavailable() -> ToolCallError {
    ToolCallError::ExecutionText(
        "App plugin gateway is unavailable or returned invalid data; no success was confirmed."
            .into(),
    )
}
