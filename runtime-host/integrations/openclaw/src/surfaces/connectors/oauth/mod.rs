mod cli;
mod status;

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use connectors::{
    Connector, ConnectorCatalog, ConnectorKind, McpAuth,
    ports::{
        ConnectorOperationFailure, McpOAuthAction, McpOAuthReceipt, McpOAuthRequest, McpOAuthState,
    },
};
use foundation::{execution::OwnedTask, process::ProcessContainment};
use platform::state_dir::CanonicalStateDir;
use tokio::sync::{Mutex, RwLock, RwLockWriteGuard, watch};
use tokio_util::sync::CancellationToken;

use crate::native_config::{
    config_store::OpenClawConfigStore, connector::external::managed_external_server_id,
};

use cli::{Command, Handoff, McpCli, Output};

type OAuthResult<T> = Result<T, ConnectorOperationFailure>;

pub(crate) struct McpOAuth {
    cli: Arc<McpCli>,
    state_dir: CanonicalStateDir,
    // Browser waits never hold this gate. Projection holds it through old-identity clear and commit.
    projection: RwLock<()>,
    servers: StdMutex<BTreeMap<String, Arc<Mutex<Server>>>>,
    shutdown: CancellationToken,
    shutdown_result: Mutex<Option<bool>>,
}

#[derive(Default)]
struct Server {
    login: Option<Login>,
    command: Option<OwnedTask<Output>>,
    cleanup_failed: bool,
}

struct Login {
    id: String,
    url: String,
    task: Option<OwnedTask<Output>>,
    handoff: watch::Receiver<Handoff>,
    exit: Option<Result<bool, ConnectorOperationFailure>>,
}

impl McpOAuth {
    pub(crate) fn new(
        executable: PathBuf,
        entry: PathBuf,
        working_directory: PathBuf,
        environment_root: PathBuf,
        state_dir: CanonicalStateDir,
        containment: ProcessContainment,
    ) -> Self {
        Self {
            cli: Arc::new(McpCli::new(
                executable,
                entry,
                working_directory,
                environment_root,
                state_dir.clone(),
                containment,
            )),
            state_dir,
            projection: RwLock::new(()),
            servers: StdMutex::new(BTreeMap::new()),
            shutdown: CancellationToken::new(),
            shutdown_result: Mutex::new(None),
        }
    }

    fn server(&self, name: &str) -> Arc<Mutex<Server>> {
        self.servers
            .lock()
            .expect("OAuth servers lock")
            .entry(name.to_owned())
            .or_default()
            .clone()
    }

    pub(crate) async fn execute(
        &self,
        connector: &Connector,
        request: McpOAuthRequest,
    ) -> OAuthResult<McpOAuthReceipt> {
        if request.agent_id.is_some()
            || (request.action == McpOAuthAction::Start && request.flow_id.is_some())
            || connector.kind() != ConnectorKind::McpHttp
            || connector.auth() != Some(McpAuth::OAuth)
            || !connector.enabled()
        {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        let url = connector
            .url()
            .ok_or(ConnectorOperationFailure::Unavailable)?;
        let name = managed_external_server_id(connector.id());
        let _projection = self.projection.read().await;
        if self.shutdown.is_cancelled() {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        let native = self.native_servers()?;
        if !native
            .get(&name)
            .is_some_and(|server| server.usable_oauth(url))
        {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        let server_owner = self.server(&name);
        let mut server = server_owner.lock().await;
        if self.shutdown.is_cancelled() || server.cleanup_failed {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        if let Some(flow_id) = &request.flow_id {
            if !server
                .login
                .as_ref()
                .is_some_and(|login| login.id == *flow_id && login.url == url)
            {
                return Err(ConnectorOperationFailure::Unavailable);
            }
        }
        if server.login.as_ref().is_some_and(|login| login.url != url) {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        match request.action {
            McpOAuthAction::Start => {
                let (id, handoff) = self.start(&name, url, &mut server).await?;
                drop(server);
                drop(_projection);
                self.wait_handoff(&name, url, id, handoff, server_owner)
                    .await
            }
            McpOAuthAction::Status => self.observe(&name, &mut server).await,
            McpOAuthAction::Logout => {
                self.stop_login(&mut server).await?;
                self.clear(&name, &mut server).await?;
                server.login = None;
                Ok(receipt(McpOAuthState::Unauthenticated, None, None))
            }
        }
    }

    async fn start(
        &self,
        name: &str,
        url: &str,
        server: &mut Server,
    ) -> OAuthResult<(String, watch::Receiver<Handoff>)> {
        self.settle_command(server).await?;
        self.finish_login(server, false).await?;
        if server
            .login
            .as_ref()
            .is_none_or(|login| login.task.is_none())
        {
            let mut entropy = [0; 16];
            getrandom::fill(&mut entropy).map_err(|_| ConnectorOperationFailure::Unavailable)?;
            let id = entropy
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let (handoff, receiver) = watch::channel(Handoff::Pending);
            let cli = self.cli.clone();
            let shutdown = self.shutdown.clone();
            let name = name.to_owned();
            let (task, _) = OwnedTask::spawn(move |cancellation| async move {
                let output = cli
                    .run(
                        Command::Login(name),
                        cancellation,
                        shutdown,
                        Some(handoff.clone()),
                    )
                    .await;
                handoff.send_replace(Handoff::Finished);
                output
            });
            server.login = Some(Login {
                id,
                url: url.to_owned(),
                task: Some(task),
                handoff: receiver,
                exit: None,
            });
        }
        let login = server.login.as_ref().expect("owned OAuth login");
        Ok((login.id.clone(), login.handoff.clone()))
    }

    async fn wait_handoff(
        &self,
        name: &str,
        url: &str,
        id: String,
        mut handoff: watch::Receiver<Handoff>,
        server: Arc<Mutex<Server>>,
    ) -> OAuthResult<McpOAuthReceipt> {
        let authorization_url = loop {
            let current = handoff.borrow().clone();
            match current {
                Handoff::AuthorizationUrl(url) => break Some(url),
                Handoff::Finished => break None,
                Handoff::Pending => {}
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => return Err(ConnectorOperationFailure::Unknown),
                changed = handoff.changed() => {
                    if changed.is_err() { break None; }
                }
            }
        };
        let _projection = self.projection.read().await;
        let mut server = server.lock().await;
        if self.shutdown.is_cancelled()
            || !server
                .login
                .as_ref()
                .is_some_and(|login| login.id == id && login.url == url)
        {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        if let Some(url) = authorization_url {
            if server
                .login
                .as_ref()
                .and_then(|login| login.task.as_ref())
                .is_some_and(|task| !task.is_finished())
            {
                return Ok(receipt(McpOAuthState::Authorizing, Some(url), Some(id)));
            }
        }
        self.finish_login(&mut server, true).await?;
        // A successful CLI exit may only mean callback bind failed: always read native facts.
        self.observe(name, &mut server).await
    }

    async fn observe(&self, name: &str, server: &mut Server) -> OAuthResult<McpOAuthReceipt> {
        self.finish_login(server, false).await?;
        let state = self.native_status(name, server).await?;
        let state = match (&server.login, state) {
            (_, McpOAuthState::Authorized | McpOAuthState::AuthorizationRequired) => state,
            (Some(login), _) if login.task.is_some() => McpOAuthState::Authorizing,
            (Some(login), _) => match login.exit {
                Some(Ok(true)) => McpOAuthState::AuthorizationRequired,
                Some(Ok(false)) => McpOAuthState::Failed,
                Some(Err(ConnectorOperationFailure::Unavailable)) => McpOAuthState::Unavailable,
                Some(Err(ConnectorOperationFailure::Unknown)) | None => McpOAuthState::Unknown,
            },
            _ => state,
        };
        Ok(receipt(
            state,
            None,
            server.login.as_ref().map(|login| login.id.clone()),
        ))
    }

    async fn settle_command(&self, server: &mut Server) -> OAuthResult<()> {
        // A dropped caller leaves the owned command here; reap it before any new native side effect.
        if let Some(task) = server.command.as_mut() {
            let previous = task.join().await;
            server.command = None;
            if !previous.is_ok_and(|output| output.reaped) {
                server.cleanup_failed = true;
                return Err(ConnectorOperationFailure::Unknown);
            }
        }
        Ok(())
    }

    async fn command(&self, command: Command, server: &mut Server) -> OAuthResult<Output> {
        self.settle_command(server).await?;
        if self.shutdown.is_cancelled() || server.cleanup_failed {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        let cli = self.cli.clone();
        let shutdown = self.shutdown.clone();
        let (task, _) = OwnedTask::spawn(move |cancellation| async move {
            cli.run(command, cancellation, shutdown, None).await
        });
        server.command = Some(task);
        let output = server
            .command
            .as_mut()
            .expect("owned OAuth command")
            .join()
            .await;
        server.command = None;
        match output {
            Ok(output) if output.reaped => Ok(output),
            _ => {
                server.cleanup_failed = true;
                Err(ConnectorOperationFailure::Unknown)
            }
        }
    }

    async fn native_status(&self, name: &str, server: &mut Server) -> OAuthResult<McpOAuthState> {
        let output = self.command(Command::Status, server).await?;
        match output.exit {
            Ok(true) => status::decode(&output.stdout, name),
            Ok(false) => Err(ConnectorOperationFailure::Unknown),
            Err(error) => Err(error),
        }
    }

    async fn clear(&self, name: &str, server: &mut Server) -> OAuthResult<()> {
        let output = self
            .command(Command::Logout(name.to_owned()), server)
            .await?;
        match output.exit {
            Ok(true) => {}
            Ok(false) => return Err(ConnectorOperationFailure::Unknown),
            Err(error) => return Err(error),
        }
        if self.native_status(name, server).await? != McpOAuthState::Unauthenticated {
            return Err(ConnectorOperationFailure::Unknown);
        }
        Ok(())
    }

    async fn finish_login(&self, server: &mut Server, wait: bool) -> OAuthResult<()> {
        let Some(login) = server.login.as_mut() else {
            return Ok(());
        };
        let Some(task) = login.task.as_mut() else {
            return Ok(());
        };
        if !wait && !task.is_finished() {
            return Ok(());
        }
        let output = task.join().await;
        login.task = None;
        match output {
            Ok(output) if output.reaped => {
                login.exit = Some(output.exit);
                Ok(())
            }
            _ => {
                server.cleanup_failed = true;
                Err(ConnectorOperationFailure::Unknown)
            }
        }
    }

    async fn stop_login(&self, server: &mut Server) -> OAuthResult<()> {
        if let Some(task) = server.login.as_ref().and_then(|login| login.task.as_ref()) {
            task.cancel();
        }
        self.finish_login(server, true).await?;
        if server.cleanup_failed {
            return Err(ConnectorOperationFailure::Unknown);
        }
        Ok(())
    }

    pub(crate) async fn prepare_projection(
        &self,
        catalog: &ConnectorCatalog,
    ) -> OAuthResult<RwLockWriteGuard<'_, ()>> {
        let guard = self.projection.write().await;
        if self.shutdown.is_cancelled() {
            return Err(ConnectorOperationFailure::Unavailable);
        }
        let mut desired = BTreeMap::new();
        for connector in catalog.connectors().iter().filter(|connector| {
            matches!(
                connector.kind(),
                ConnectorKind::McpStdio | ConnectorKind::McpHttp
            )
        }) {
            if desired
                .insert(managed_external_server_id(connector.id()), connector)
                .is_some()
            {
                return Err(ConnectorOperationFailure::Unavailable);
            }
        }
        let native = self.native_servers()?;
        for (name, old) in native {
            if !old.managed_oauth {
                continue;
            }
            let retained = desired.get(&name).is_some_and(|connector| {
                connector.enabled()
                    && connector.kind() == ConnectorKind::McpHttp
                    && connector.auth() == Some(McpAuth::OAuth)
                    && connector.url() == old.url.as_deref()
            });
            if retained {
                continue;
            }
            let server = self.server(&name);
            let mut server = server.lock().await;
            self.stop_login(&mut server).await?;
            // Native logout resolves name + URL from the STILL-OLD canonical projection.
            self.clear(&name, &mut server).await?;
            server.login = None;
        }
        // Caller retains this integration gate until the existing projection has committed/read back.
        Ok(guard)
    }

    pub(crate) async fn close_and_join(&self) -> bool {
        self.shutdown.cancel();
        let mut result = self.shutdown_result.lock().await;
        if let Some(result) = *result {
            return result;
        }
        let _projection = self.projection.write().await;
        let servers: Vec<_> = self
            .servers
            .lock()
            .expect("OAuth servers lock")
            .values()
            .cloned()
            .collect();
        let mut reaped = true;
        for server in servers {
            let mut server = server.lock().await;
            reaped &= self.stop_login(&mut server).await.is_ok();
            if let Some(task) = server.command.as_mut() {
                let output = task.cancel_and_join().await;
                reaped &= output.is_ok_and(|output| output.reaped);
                server.command = None;
            }
            reaped &= !server.cleanup_failed;
            server.login = None;
        }
        *result = Some(reaped);
        reaped
    }

    fn native_servers(&self) -> OAuthResult<BTreeMap<String, NativeServer>> {
        let document = OpenClawConfigStore::new(self.state_dir.clone())
            .read_private()
            .map_err(|_| ConnectorOperationFailure::Unavailable)?;
        let Some(servers) = document
            .get("mcp")
            .and_then(|mcp| mcp.get("servers"))
            .and_then(serde_json::Value::as_object)
        else {
            return Ok(BTreeMap::new());
        };
        Ok(servers
            .iter()
            .map(|(name, server)| {
                let oauth = server.get("auth").and_then(serde_json::Value::as_str) == Some("oauth");
                let url = server
                    .get("url")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                let operator = server
                    .get("oauth")
                    .and_then(|oauth| oauth.get("identity"))
                    .and_then(serde_json::Value::as_str)
                    != Some("per-requester");
                let enabled = server.get("enabled").and_then(serde_json::Value::as_bool) != Some(false);
                (
                    name.clone(),
                    NativeServer {
                        managed_oauth: oauth
                            && crate::native_config::connector::external::connector_id_for_managed_external_server(name).is_some(),
                        oauth,
                        url,
                        operator,
                        enabled,
                    },
                )
            })
            .collect())
    }
}

struct NativeServer {
    managed_oauth: bool,
    oauth: bool,
    url: Option<String>,
    operator: bool,
    enabled: bool,
}

impl NativeServer {
    fn usable_oauth(&self, url: &str) -> bool {
        self.oauth && self.operator && self.enabled && self.url.as_deref() == Some(url)
    }
}

fn receipt(
    state: McpOAuthState,
    authorization_url: Option<String>,
    flow_id: Option<String>,
) -> McpOAuthReceipt {
    McpOAuthReceipt {
        state,
        authorization_url,
        flow_id,
    }
}
