mod api;
mod lock;
mod validation;

pub(crate) use api::Field;
pub use api::dispatch;
pub use validation::{validate_agent_id_available, validate_id, validate_settings};

use crate::{persistence::atomic_write, rpc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::ErrorKind,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

pub const DEFAULT_AGENT_ID: &str = "matcha";

#[derive(Clone)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("matcha-agent.json")
    }

    pub fn database(&self) -> PathBuf {
        self.root.join("state").join("app-server.sqlite3")
    }

    pub fn agent_dir(&self, agent_id: &str) -> rpc::Result<PathBuf> {
        validate_id(agent_id)?;
        Ok(self.root.join("agents").join(agent_id))
    }

    pub fn workspace(&self, agent_id: &str) -> rpc::Result<PathBuf> {
        Ok(self.agent_dir(agent_id)?.join("workspace"))
    }

    pub fn runtime(&self, agent_id: &str) -> rpc::Result<PathBuf> {
        Ok(self.agent_dir(agent_id)?.join("runtime"))
    }

    pub fn state(&self, agent_id: &str) -> rpc::Result<PathBuf> {
        Ok(self.agent_dir(agent_id)?.join("state"))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub listen: SocketAddr,
    pub auth_token_env: Option<String>,
    pub cli: CliConfig,
    pub agents: BTreeMap<String, AgentConfig>,
    pub agent_deletions: BTreeMap<String, AgentDeletion>,
    pub providers: BTreeMap<String, Value>,
    pub mcp_servers: BTreeMap<String, Value>,
    pub search: Option<crate::search::Projection>,
    #[serde(skip)]
    pub private_provider_env: crate::provider::PrivateProjection,
    #[serde(skip)]
    pub private_mcp_env: crate::provider::PrivateProjection,
    #[serde(skip)]
    pub private_sealed: crate::sealed::PrivateSource,
    pub schedules: BTreeMap<String, Value>,
    pub channels: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            auth_token_env: None,
            cli: CliConfig::default(),
            agents: BTreeMap::new(),
            agent_deletions: BTreeMap::new(),
            providers: BTreeMap::new(),
            mcp_servers: BTreeMap::new(),
            search: None,
            private_provider_env: Default::default(),
            private_mcp_env: Default::default(),
            private_sealed: Default::default(),
            schedules: BTreeMap::new(),
            channels: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CliConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
    /// Target environment variable -> source environment variable name, never its value.
    pub env: BTreeMap<String, String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            command: PathBuf::from("ccb"),
            args: Vec::new(),
            env: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentConfig {
    pub name: String,
    pub description: Option<String>,
    /// Only agents.create grants custody; legacy/config-imported Agents remain external.
    pub custody: Option<String>,
    pub owner: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Option<String>,
    pub settings: Value,
    pub tools: Option<Vec<String>>,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub channels: Vec<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: None,
            custody: None,
            owner: None,
            extra: BTreeMap::new(),
            model: None,
            provider: None,
            system_prompt: None,
            append_system_prompt: None,
            settings: json!({}),
            tools: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            channels: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentDeletionState {
    Absent,
    #[default]
    Deleted,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDeletion {
    pub agent_id: String,
    #[serde(default)]
    pub state: AgentDeletionState,
    pub custody: Option<String>,
    pub owner: Option<String>,
    pub delete_files: bool,
    pub data_deleted: bool,
    pub removed_sessions: u64,
    #[serde(default = "completed_deletion")]
    pub completed: bool,
}

fn completed_deletion() -> bool {
    true
}

#[derive(Clone)]
pub struct ConfigStore {
    paths: Paths,
    current: Arc<Mutex<Stored>>,
    _lock: Arc<std::fs::File>,
}

struct Stored {
    confirmed: Config,
    unresolved: Option<rpc::Error>,
}

impl ConfigStore {
    pub async fn open(mut paths: Paths) -> rpc::Result<Self> {
        paths.root = std::path::absolute(&paths.root).map_err(|error| {
            rpc::Error::new(
                -32005,
                "config_root_resolve",
                "The server home could not be resolved",
            )
            .with_data(json!({ "ioKind": format!("{:?}", error.kind()) }))
            .with_source(error)
        })?;
        create_directory(paths.root(), "config_root_create").await?;
        paths.root = tokio::fs::canonicalize(paths.root())
            .await
            .map_err(|error| {
                rpc::Error::new(
                    -32005,
                    "config_root_resolve",
                    "The server home could not be resolved",
                )
                .with_source(error)
            })?;
        let lock = Arc::new(lock::acquire(paths.root())?);
        let (mut config, mut changed) = match tokio::fs::read(paths.config_file()).await {
            Ok(bytes) => (
                serde_json::from_slice::<Config>(&bytes).map_err(|error| {
                    let kind = match error.classify() {
                        serde_json::error::Category::Io => "config_decode_io",
                        serde_json::error::Category::Syntax => "config_json_syntax",
                        serde_json::error::Category::Data => "config_schema",
                        serde_json::error::Category::Eof => "config_json_incomplete",
                    };
                    rpc::Error::new(-32602, kind, "The server configuration is invalid")
                        .with_data(json!({ "line": error.line(), "column": error.column() }))
                        .with_source(error)
                })?,
                false,
            ),
            Err(error) if error.kind() == ErrorKind::NotFound => (Config::default(), true),
            Err(error) => {
                return Err(rpc::Error::new(
                    -32005,
                    "config_read",
                    "The server configuration could not be read",
                )
                .with_data(json!({ "ioKind": format!("{:?}", error.kind()) }))
                .with_source(error));
            }
        };
        if !config.agents.contains_key(DEFAULT_AGENT_ID) {
            validate_agent_id_available(&config, DEFAULT_AGENT_ID)?;
            config.agents.insert(
                DEFAULT_AGENT_ID.to_owned(),
                AgentConfig {
                    name: "Matcha".to_owned(),
                    ..AgentConfig::default()
                },
            );
            changed = true;
        }
        validation::validate(&config)?;
        create_directory(&paths.root.join("state"), "config_state_create").await?;
        let store = Self {
            paths,
            _lock: lock,
            current: Arc::new(Mutex::new(Stored {
                confirmed: config,
                unresolved: None,
            })),
        };
        crate::agent::prepare_default(&store).await?;
        if changed {
            persist(&store.paths, &store.current.lock().await.confirmed).await?;
        }
        Ok(store)
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    pub async fn snapshot(&self) -> Config {
        self.current.lock().await.confirmed.clone()
    }

    pub async fn checked_snapshot(&self) -> rpc::Result<Config> {
        let current = self.current.lock().await;
        if let Some(cause) = &current.unresolved {
            return Err(unresolved_commit(cause));
        }
        Ok(current.confirmed.clone())
    }

    async fn read(&self) -> (Config, bool) {
        let current = self.current.lock().await;
        (current.confirmed.clone(), current.unresolved.is_some())
    }

    pub async fn update<F, R>(&self, update: F) -> rpc::Result<R>
    where
        F: FnOnce(&mut Config) -> rpc::Result<R> + Send,
        R: Send,
    {
        let mut current = self.current.clone().lock_owned().await;
        if let Some(cause) = &current.unresolved {
            return Err(unresolved_commit(cause));
        }
        let mut next = current.confirmed.clone();
        let result = update(&mut next)?;
        validation::validate(&next)?;
        let paths = self.paths.clone();
        // A disconnected caller must not cancel between the disk commit and memory replacement.
        tokio::spawn(async move {
            if let Err(error) = persist(&paths, &next).await {
                if error.code == -32006 {
                    let error = error.with_data(json!({
                        "application": "unresolved",
                        "commitState": "unresolved"
                    }));
                    current.unresolved = Some(error.clone());
                    return Err(error);
                }
                return Err(error);
            }
            current.confirmed = next;
            Ok::<(), rpc::Error>(())
        })
        .await
        .map_err(|error| rpc::Error::internal("config_commit_task").with_source(error))??;
        Ok(result)
    }
}

fn unresolved_commit(cause: &rpc::Error) -> rpc::Error {
    rpc::Error::new(
        -32006,
        "config_commit_unresolved",
        "The previous configuration commit is unresolved; restart the server to read it back before updating",
    )
    .with_data(json!({
        "cause": cause.data,
        "application": "unresolved",
        "commitState": "unresolved"
    }))
    .with_source(cause.clone())
}

async fn create_directory(path: &Path, kind: &str) -> rpc::Result<()> {
    tokio::fs::create_dir_all(path).await.map_err(|error| {
        rpc::Error::new(
            -32005,
            kind,
            "A required server directory could not be created",
        )
        .with_data(json!({ "ioKind": format!("{:?}", error.kind()) }))
        .with_source(error)
    })
}

async fn persist(paths: &Paths, config: &Config) -> rpc::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| rpc::Error::internal("config_encode").with_source(error))?;
    bytes.push(b'\n');
    atomic_write(&paths.config_file(), &bytes).await
}
