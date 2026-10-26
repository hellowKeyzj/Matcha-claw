use std::{collections::BTreeMap, sync::OnceLock, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{projection, reference_name};
use crate::{
    cli::{
        process::{Output, Process},
        projection::launch,
    },
    config::{Config, ConfigStore, Paths, validate_id},
    rpc::{self, Error},
    session::Sessions,
};

const CAPACITY: usize = 32;
const FRAME_BYTES: usize = 64 * 1024;
const REQUEST_WINDOW: Duration = Duration::from_secs(45);
const FLOW_WINDOW: Duration = Duration::from_secs(6 * 60);
static FLOWS: OnceLock<Mutex<Flows>> = OnceLock::new();

#[derive(Default)]
struct Flows {
    stopping: bool,
    entries: BTreeMap<(String, String), Flow>,
}

struct Flow {
    identity: Option<Identity>,
    operation: Option<Operation>,
}

struct Operation {
    action: Action,
    stop: CancellationToken,
    updates: watch::Receiver<Option<rpc::Result<Receipt>>>,
    task: JoinHandle<rpc::Result<()>>,
    completion: Option<rpc::Result<()>>,
}

struct Identity {
    id: String,
    expires: Instant,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Start,
    Status,
    Logout,
}

impl Operation {
    fn finished(&self) -> bool {
        self.task.is_finished()
            || self.updates.has_changed().is_err()
            || self.updates.borrow().as_ref().is_some_and(|result| {
                !matches!(result, Ok(receipt) if matches!(receipt.state, State::Authorizing))
            })
    }

    async fn join(&mut self) -> rpc::Result<()> {
        if self.completion.is_none() {
            self.completion = Some(
                (&mut self.task)
                    .await
                    .unwrap_or_else(|_| Err(Error::internal("mcp_oauth_join"))),
            );
        }
        self.completion
            .as_ref()
            .expect("joined OAuth worker")
            .clone()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    agent_id: String,
    name: String,
    flow_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum State {
    Authorizing,
    Authorized,
    Unauthenticated,
    Failed,
    Unavailable,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flow_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeReceipt {
    state: State,
    authorization_url: Option<String>,
}

fn flows() -> &'static Mutex<Flows> {
    FLOWS.get_or_init(|| Mutex::new(Flows::default()))
}

pub(super) async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result {
    let input: Input = rpc::params(params)?;
    validate_id(&input.agent_id)?;
    reference_name(&input.name)?;
    let action = match method {
        "mcp.oauth.start" => Action::Start,
        "mcp.oauth.status" => Action::Status,
        "mcp.oauth.logout" => Action::Logout,
        _ => return Err(Error::method(method)),
    };
    if action == Action::Start && input.flow_id.is_some() {
        return Err(Error::invalid("OAuth start does not accept flowId"));
    }
    let _agent = sessions.agent_guard(&input.agent_id).await;
    // Configuration replacement and registration share this native owner fence.
    let mut flows = flows().lock().await;
    if flows.stopping {
        return Err(unavailable());
    }
    let snapshot = config.checked_snapshot().await?;
    if !snapshot.agents.contains_key(&input.agent_id) {
        return Err(Error::not_found("agent"));
    }
    let key = (input.agent_id.clone(), input.name.clone());
    // Retain completed start identities, not a cached authorization fact. No background GC.
    let expired: Vec<_> = flows
        .entries
        .iter()
        .filter(|(_, flow)| match &flow.identity {
            Some(identity) => identity.expires <= Instant::now(),
            None => flow.operation.as_ref().is_none_or(Operation::finished),
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in expired {
        stop_entry(&mut flows, &key).await?;
    }
    if let Some(flow) = flows.entries.get_mut(&key)
        && let Some(operation) = &mut flow.operation
        && operation.finished()
    {
        // A published terminal already has a reaped child, even before task return.
        operation.join().await?;
        flow.operation = None;
    }
    if let Some(expected) = input.flow_id.as_deref()
        && flows
            .entries
            .get(&key)
            .and_then(|flow| flow.identity.as_ref())
            .is_none_or(|identity| identity.id != expected)
    {
        return Err(Error::conflict(
            "mcp_oauth_flow_changed",
            "The MCP OAuth flow no longer matches",
        ));
    }
    if let Some(flow) = flows.entries.get(&key)
        && let Some(operation) = &flow.operation
    {
        if operation.action == Action::Start && action != Action::Logout
            || operation.action == Action::Status && action == Action::Status
        {
            let id = flow.identity.as_ref().map(|identity| identity.id.clone());
            let updates = operation.updates.clone();
            drop(flows);
            drop(_agent);
            let mut receipt = observe(updates).await?;
            receipt.flow_id = id;
            return rpc::value(receipt);
        }
        if operation.action != Action::Start {
            return Err(Error::conflict(
                "mcp_oauth_busy",
                "A native MCP OAuth management action is still finishing",
            ));
        }
    }
    // Validate the exact managed overlay before retiring or registering a native worker.
    projection::oauth_server(&snapshot, &input.name, &mut BTreeMap::new())?;
    if action != Action::Status {
        stop_entry(&mut flows, &key).await?;
    }
    if !flows.entries.contains_key(&key) && flows.entries.len() >= CAPACITY {
        return Err(Error::conflict(
            "mcp_oauth_capacity",
            "Too many native MCP OAuth flows are active",
        ));
    }
    let identity = if action == Action::Start {
        Some(Identity {
            id: Uuid::new_v4().to_string(),
            expires: Instant::now() + FLOW_WINDOW,
        })
    } else {
        flows
            .entries
            .get_mut(&key)
            .and_then(|flow| flow.identity.take())
    };
    let id = identity.as_ref().map(|identity| identity.id.clone());
    let deadline = if action == Action::Start {
        identity.as_ref().expect("start identity").expires
    } else {
        Instant::now() + REQUEST_WINDOW
    };
    let stop = CancellationToken::new();
    let (updates, response) = watch::channel(None);
    let task_stop = stop.clone();
    let paths = config.paths().clone();
    let task_key = key.clone();
    let task = tokio::spawn(async move {
        run(
            snapshot, paths, task_key, action, task_stop, updates, deadline,
        )
        .await
    });
    flows.entries.insert(
        key,
        Flow {
            identity,
            operation: Some(Operation {
                action,
                stop,
                updates: response.clone(),
                task,
                completion: None,
            }),
        },
    );
    drop(flows);
    drop(_agent);
    let mut receipt = observe(response).await?;
    receipt.flow_id = id;
    rpc::value(receipt)
}

async fn observe(
    mut updates: watch::Receiver<Option<rpc::Result<Receipt>>>,
) -> rpc::Result<Receipt> {
    timeout(REQUEST_WINDOW, async {
        loop {
            if let Some(result) = updates.borrow_and_update().clone() {
                return result;
            }
            updates.changed().await.map_err(|_| unavailable())?;
        }
    })
    .await
    .map_err(|_| unavailable())?
}

pub(super) async fn replace(params: Value, config: &ConfigStore) -> rpc::Result {
    let prepared = projection::prepare(params)?;
    // ponytail: overlay replacement joins affected workers under one fence; shard if management contention matters.
    let mut flows = flows().lock().await;
    if flows.stopping {
        return Err(unavailable());
    }
    let snapshot = config.checked_snapshot().await?;
    let changed: Vec<_> = flows
        .entries
        .keys()
        .filter(|(_, name)| !prepared.unchanged(&snapshot, name))
        .cloned()
        .collect();
    for key in changed {
        stop_entry(&mut flows, &key).await?;
    }
    projection::replace(prepared, config).await
}

pub(crate) async fn stop_agent(agent_id: &str) -> rpc::Result<()> {
    let mut flows = flows().lock().await;
    let keys: Vec<_> = flows
        .entries
        .keys()
        .filter(|(agent, _)| agent == agent_id)
        .cloned()
        .collect();
    let mut failure = None;
    for key in keys {
        if let Err(error) = stop_entry(&mut flows, &key).await {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

pub(crate) async fn shutdown() -> rpc::Result<()> {
    let mut flows = flows().lock().await;
    flows.stopping = true;
    for flow in flows.entries.values() {
        if let Some(operation) = &flow.operation {
            operation.stop.cancel();
        }
    }
    let keys: Vec<_> = flows.entries.keys().cloned().collect();
    let mut failure = None;
    for key in keys {
        if let Err(error) = stop_entry(&mut flows, &key).await {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

async fn stop_entry(flows: &mut Flows, key: &(String, String)) -> rpc::Result<()> {
    if let Some(flow) = flows.entries.get_mut(key)
        && let Some(operation) = &mut flow.operation
    {
        operation.stop.cancel();
        // Keep ownership registered while joining; caller cancellation cannot detach it.
        operation.join().await?;
    }
    flows.entries.remove(key);
    Ok(())
}

struct Worker {
    process: Process,
    output: mpsc::Receiver<Output>,
    buffer: Vec<u8>,
    stdout_closed: bool,
    exit: Option<(Option<i32>, Option<i32>)>,
}

impl Worker {
    async fn spawn(
        config: &Config,
        paths: &Paths,
        agent: &str,
        name: &str,
        action: Action,
    ) -> rpc::Result<Self> {
        let mut launch = launch(config, paths, agent, vec!["--mcp-oauth-control".into()]).await?;
        let server = projection::oauth_server(config, name, &mut launch.env)?;
        let (process, output) = Process::spawn(launch).await?;
        let mut worker = Self {
            process,
            output,
            buffer: Vec::new(),
            stdout_closed: false,
            exit: None,
        };
        match worker
            .send(json!({"name": name, "server": server, "action": action}))
            .await
        {
            Ok(()) => Ok(worker),
            Err(error) => Err(match worker.close().await {
                Ok(()) => error,
                Err(cleanup) => {
                    error.with_data(json!({"cleanupUnconfirmed": true, "cleanup": cleanup}))
                }
            }),
        }
    }

    async fn send(&self, value: Value) -> rpc::Result<()> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| Error::internal("mcp_oauth_encode"))?;
        if bytes.len() > FRAME_BYTES {
            return Err(Error::invalid("MCP OAuth configuration is too large"));
        }
        bytes.push(b'\n');
        timeout(REQUEST_WINDOW, self.process.send(bytes))
            .await
            .map_err(|_| unavailable())?
    }

    async fn receipt(&mut self, deadline: Instant) -> rpc::Result<Option<Receipt>> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let frame: Vec<_> = self.buffer.drain(..=end).collect();
                let receipt: NativeReceipt =
                    serde_json::from_slice(&frame).map_err(|_| unavailable())?;
                if matches!(receipt.state, State::Authorizing)
                    != receipt.authorization_url.is_some()
                    || receipt.authorization_url.as_ref().is_some_and(|url| {
                        url.len() > 16 * 1024 || super::authorization_uri(url).is_none()
                    })
                {
                    return Err(unavailable());
                }
                return Ok(Some(Receipt {
                    state: receipt.state,
                    authorization_url: receipt.authorization_url,
                    flow_id: None,
                }));
            }
            match timeout_at(deadline, self.output.recv())
                .await
                .map_err(|_| unavailable())?
            {
                Some(Output::Stdout(bytes)) => {
                    if self.stdout_closed || self.buffer.len() + bytes.len() > FRAME_BYTES {
                        return Err(unavailable());
                    }
                    self.buffer.extend(bytes);
                }
                Some(Output::StdoutClosed) => {
                    if !self.buffer.is_empty() {
                        return Err(unavailable());
                    }
                    self.stdout_closed = true;
                }
                Some(Output::Exited { code, signal }) => {
                    self.exit = Some((code, signal));
                    return if self.stdout_closed {
                        Ok(None)
                    } else {
                        Err(unavailable())
                    };
                }
                Some(Output::ReadFailed { stream, kind }) => {
                    return Err(
                        unavailable().with_data(json!({"stream": stream, "nativeFailure": kind}))
                    );
                }
                Some(Output::Stderr) => {}
                None => return Err(unavailable()),
            }
        }
    }

    async fn close(&mut self) -> rpc::Result<()> {
        let input = self.process.finish_input().await;
        // EOF aborts native auth; drain while containment close/reap supplies the write fence.
        let output = &mut self.output;
        let (closed, ()) = tokio::join!(self.process.close(), async {
            while output.recv().await.is_some() {}
        });
        match (input, closed) {
            (Err(error), Err(cleanup)) => Err(error.with_data(json!({"cleanup": cleanup}))),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
}

async fn run(
    config: Config,
    paths: Paths,
    (agent, name): (String, String),
    action: Action,
    stop: CancellationToken,
    updates: watch::Sender<Option<rpc::Result<Receipt>>>,
    deadline: Instant,
) -> rpc::Result<()> {
    let mut worker = match Worker::spawn(&config, &paths, &agent, &name, action).await {
        Ok(worker) => worker,
        Err(error) => {
            let cleanup = cleanup_result(&error);
            updates.send_replace(Some(Err(error)));
            return cleanup;
        }
    };
    // Launch secrets are not needed once the native child owns its environment.
    drop(config);
    let result = async {
        let mut terminal = None;
        let mut receipt_deadline = deadline.min(Instant::now() + REQUEST_WINDOW);
        loop {
            let receipt = tokio::select! {
                biased;
                _ = stop.cancelled() => return Err(unavailable()),
                receipt = worker.receipt(receipt_deadline) => receipt?,
            };
            let Some(receipt) = receipt else {
                break;
            };
            if terminal.is_some() {
                return Err(unavailable());
            }
            if matches!(receipt.state, State::Authorizing) {
                if action != Action::Start {
                    return Err(unavailable());
                }
                updates.send_replace(Some(Ok(receipt)));
                receipt_deadline = deadline;
            } else {
                terminal = Some(receipt);
                // Once native auth settles, only the existing resource grace remains.
                receipt_deadline = Instant::now() + Duration::from_secs(10);
            }
        }
        let receipt = terminal.ok_or_else(unavailable)?;
        if worker.exit != Some((Some(0), None))
            && !matches!(receipt.state, State::Failed | State::Unavailable)
            || action == Action::Logout
                && !matches!(
                    receipt.state,
                    State::Unauthenticated | State::Failed | State::Unavailable
                )
        {
            return Err(unavailable());
        }
        Ok(receipt)
    }
    .await;
    // Both start and short actions stay registered after RPC cancellation, through join.
    let closed = worker.close().await;
    let completion = match (&result, closed) {
        (_, Ok(())) => Ok(()),
        (Err(error), Err(cleanup)) => Err(error.clone().with_data(json!({"cleanup": cleanup}))),
        (_, Err(cleanup)) => Err(cleanup),
    };
    let response = match &completion {
        Ok(()) => result,
        Err(error) => Err(error.clone()),
    };
    updates.send_replace(Some(response));
    completion
}

fn cleanup_result(error: &Error) -> rpc::Result<()> {
    if error.data.as_ref().is_some_and(|data| {
        data.get("cleanupUnconfirmed").and_then(Value::as_bool) == Some(true)
            || data.get("cleanupFailures").is_some()
    }) {
        Err(error.clone())
    } else {
        Ok(())
    }
}

fn unavailable() -> Error {
    Error::unavailable(
        "mcp_oauth_unavailable",
        "Native MCP OAuth state is unavailable",
    )
}
