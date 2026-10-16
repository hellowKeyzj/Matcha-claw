use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::json;
use tokio::{sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    cli::{
        process::{Output, Process},
        projection,
    },
    config::{Config, Paths},
    rpc::{self, Error},
};

// Native login prints a handful of status lines and a QR URL, not a transcript.
const LOGIN_OUTPUT_BYTES: usize = 64 * 1024;
// ponytail: explicit restart cleanup holds this registry lock; split per Agent if concurrent restarts matter.
static FLOWS: OnceLock<Mutex<Flows>> = OnceLock::new();
fn flows() -> &'static Mutex<Flows> {
    FLOWS.get_or_init(|| Mutex::new(Flows::default()))
}

#[derive(Default)]
struct Flows {
    stopping: bool,
    entries: BTreeMap<String, Flow>,
}
struct Flow {
    channel_id: String,
    progress: Arc<Mutex<Progress>>,
    stop: CancellationToken,
    task: Option<JoinHandle<rpc::Result<()>>>,
    completion: Option<rpc::Result<()>>,
}

struct Progress {
    flow_id: String,
    status: &'static str,
    output: Vec<u8>,
    output_truncated: bool,
    error: Option<Failure>,
    cleanup_error: Option<Failure>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    code: i64,
    kind: String,
}

impl Progress {
    fn view(&self) -> serde_json::Value {
        let output = String::from_utf8_lossy(&self.output);
        let complete = output
            .rsplit_once('\n')
            .map(|(complete, _)| complete)
            .unwrap_or("");
        let mut lines = complete.lines();
        let qr_url = lines
            .find(|line| line.contains("or open this URL:"))
            .and_then(|_| lines.find(|line| !line.trim().is_empty()))
            .filter(|line| line.starts_with("https://") || line.starts_with("http://"));
        // Only the explicit native login business fields leave this module, never raw stdout.
        json!({"flowId":self.flow_id,"status":self.status,"qrUrl":qr_url,
            "qrUnavailable":self.output_truncated,"qrRefreshObservable":false,"error":self.error,
            "cleanupError":self.cleanup_error})
    }
}

fn failure(error: &Error) -> Failure {
    Failure {
        code: error.code,
        kind: error
            .data
            .as_ref()
            .and_then(|data| data.get("kind"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("native_login_failed")
            .into(),
    }
}

pub(super) async fn start(
    id: &str,
    agent_id: &str,
    config: Config,
    paths: Paths,
    restart_flow_id: Option<&str>,
) -> rpc::Result<serde_json::Value> {
    let mut flows = flows().lock().await;
    if flows.stopping {
        return Err(Error::unavailable(
            "channel_stopping",
            "Channel login is shutting down",
        ));
    }
    if let Some(expected) = restart_flow_id {
        let flow = flows
            .entries
            .get(agent_id)
            .filter(|flow| flow.channel_id == id)
            .ok_or_else(|| {
                Error::conflict(
                    "channel_login_flow_changed",
                    "The login flow no longer matches; inspect channel status before restarting",
                )
            })?;
        if flow.progress.lock().await.flow_id != expected {
            return Err(Error::conflict(
                "channel_login_flow_changed",
                "The login flow changed; inspect channel status before restarting",
            ));
        }
        flow.stop.cancel();
        // Keep the old handle registered while awaiting cleanup; a cancelled caller cannot detach it.
        let flow = flows.entries.get_mut(agent_id).expect("checked flow");
        flow.join().await?;
        flows.entries.remove(agent_id);
    } else if let Some(flow) = flows.entries.get(agent_id)
        && flow.task.as_ref().is_some_and(|task| !task.is_finished())
    {
        if flow.channel_id != id {
            return Err(Error::conflict(
                "channel_login_active",
                "Another channel login is active for this Agent",
            ));
        }
        return Ok(flow.progress.lock().await.view());
    }
    if let Some(flow) = flows.entries.get_mut(agent_id) {
        flow.join().await?;
    }
    flows.entries.remove(agent_id);
    let progress = Arc::new(Mutex::new(Progress {
        flow_id: Uuid::new_v4().to_string(),
        status: "starting",
        output: Vec::new(),
        output_truncated: false,
        error: None,
        cleanup_error: None,
    }));
    let stop = CancellationToken::new();
    let task_progress = progress.clone();
    let task_stop = stop.clone();
    let agent_id_owned = agent_id.to_owned();
    let task = tokio::spawn(async move {
        let result = run(
            config,
            paths,
            &agent_id_owned,
            task_progress.clone(),
            task_stop.clone(),
        )
        .await;
        if let Err(error) = &result {
            let mut progress = task_progress.lock().await;
            progress.status = if task_stop.is_cancelled()
                || error.code == -32006
                || progress.cleanup_error.is_some()
            {
                "outcomeUnknown"
            } else {
                "failed"
            };
            if progress.error.is_none() {
                progress.error = Some(failure(error));
            }
        }
        // Business errors are retained in the flow; only unconfirmed resource cleanup fails shutdown.
        result
    });
    flows.entries.insert(
        agent_id.to_owned(),
        Flow {
            channel_id: id.to_owned(),
            progress: progress.clone(),
            stop,
            task: Some(task),
            completion: None,
        },
    );
    // Store ownership before awaiting a progress lock; cancellation cannot detach the observer.
    let response = progress.lock().await.view();
    Ok(response)
}

pub(super) async fn status(id: &str, agent_id: &str) -> Option<serde_json::Value> {
    let flows = flows().lock().await;
    let flow = flows
        .entries
        .get(agent_id)
        .filter(|flow| flow.channel_id == id)?;
    Some(flow.progress.lock().await.view())
}

pub(super) async fn cancel(
    id: &str,
    agent_id: &str,
    expected_flow_id: Option<&str>,
) -> rpc::Result<()> {
    let mut flows = flows().lock().await;
    let Some(flow) = flows.entries.get_mut(agent_id) else {
        return if expected_flow_id.is_none() {
            Ok(())
        } else {
            Err(Error::conflict(
                "channel_login_flow_changed",
                "The login flow no longer exists",
            ))
        };
    };
    if flow.channel_id != id {
        return Err(Error::conflict(
            "channel_login_flow_changed",
            "The login flow no longer matches",
        ));
    }
    if let Some(expected) = expected_flow_id
        && flow.progress.lock().await.flow_id != expected
    {
        return Err(Error::conflict(
            "channel_login_flow_changed",
            "The login flow no longer matches",
        ));
    }
    flow.stop.cancel();
    flow.join().await?;
    flow.progress.lock().await.status = "cancelled";
    Ok(())
}

pub(super) async fn ensure_idle(agent_id: &str) -> rpc::Result<()> {
    let mut flows = flows().lock().await;
    if let Some(flow) = flows.entries.get_mut(agent_id) {
        if flow.task.as_ref().is_some_and(|task| !task.is_finished()) {
            return Err(Error::conflict(
                "channel_login_active",
                "Stop the Agent's login flow before changing its channel binding",
            ));
        }
        flow.join().await?;
    }
    Ok(())
}

async fn run(
    config: Config,
    paths: Paths,
    agent_id: &str,
    progress: Arc<Mutex<Progress>>,
    stop: CancellationToken,
) -> rpc::Result<()> {
    let started = async {
        let launch = projection::launch(
            &config,
            &paths,
            agent_id,
            vec!["weixin".into(), "login".into()],
        )
        .await?;
        if stop.is_cancelled() {
            return Err(Error::unavailable(
                "channel_login_stopped",
                "Login was stopped before launch",
            ));
        }
        Process::spawn(launch).await
    }
    .await;
    let (process, mut output) = match started {
        Ok(started) => started,
        Err(error) => {
            let cleanup_unknown = error
                .data
                .as_ref()
                .is_some_and(|data| data.get("cleanupFailures").is_some());
            let mut progress = progress.lock().await;
            progress.status = if cleanup_unknown {
                "outcomeUnknown"
            } else {
                "failed"
            };
            progress.error = Some(failure(&error));
            if cleanup_unknown {
                progress.cleanup_error = Some(failure(&error));
                return Err(error);
            }
            return Ok(());
        }
    };
    let result = async {
        process.finish_input().await?;
        loop {
            tokio::select! {
                biased;
                _ = stop.cancelled() => return Err(Error::new(-32006, "channel_login_interrupted", "Login was interrupted; native account state was not inspected")),
                event = output.recv() => match event {
                    Some(Output::Stdout(bytes)) => {
                        let mut progress = progress.lock().await;
                        let remaining = LOGIN_OUTPUT_BYTES.saturating_sub(progress.output.len());
                        progress.output.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                        progress.output_truncated |= bytes.len() > remaining;
                        progress.status = "waiting";
                    }
                    Some(Output::Stderr | Output::StdoutClosed) => {},
                    Some(Output::Exited { code:Some(0), signal:None }) => {
                        progress.lock().await.status = "finishing";
                        return Ok(());
                    }
                    Some(Output::Exited { code, signal }) => return Err(Error::new(-32004, "channel_login_exit", "Native WeChat login did not complete successfully").with_data(json!({"exitCode":code,"signal":signal}))),
                    Some(Output::ReadFailed { stream, .. }) => return Err(Error::new(-32006, "channel_login_output", "Native login output could not be observed").with_data(json!({"stream":stream}))),
                    None => return Err(Error::new(-32006, "channel_login_exit_unobserved", "Native login ended without an observed exit")),
                }
            }
        }
    }.await;
    let cleanup = process.close().await;
    match (result, cleanup) {
        (Ok(()), Ok(())) => {
            progress.lock().await.status = "connected";
            Ok(())
        }
        (Err(error), Ok(())) => {
            // The flow holds the login result; successfully reclaimed tasks do not fail shutdown.
            let mut progress = progress.lock().await;
            progress.status = if error.code == -32006 {
                "outcomeUnknown"
            } else {
                "failed"
            };
            progress.error = Some(failure(&error));
            Ok(())
        }
        (result, Err(cleanup)) => {
            let mut progress = progress.lock().await;
            progress.status = "outcomeUnknown";
            progress.cleanup_error = Some(failure(&cleanup));
            let error = match result {
                Err(error) => error.with_data(json!({"cleanupError":failure(&cleanup)})),
                Ok(()) => Error::new(
                    -32006,
                    "channel_login_cleanup",
                    "Native login resource cleanup could not be confirmed",
                )
                .with_data(json!({"cleanupError":failure(&cleanup)}))
                .with_source(cleanup),
            };
            progress.error = Some(failure(&error));
            Err(error)
        }
    }
}

impl Flow {
    async fn join(&mut self) -> rpc::Result<()> {
        if let Some(completion) = &self.completion {
            return completion.clone();
        }
        let task = self.task.as_mut().expect("unjoined flow has a task");
        let result = task
            .await
            .map_err(|source| {
                Error::new(
                    -32006,
                    "channel_login_task",
                    "The native login observer ended without a confirmed cleanup",
                )
                .with_source(source)
            })
            .and_then(|result| result);
        self.task = None;
        self.completion = Some(result.clone());
        result
    }
}

pub(super) async fn shutdown() -> rpc::Result<()> {
    let entries = {
        let mut flows = flows().lock().await;
        flows.stopping = true;
        for flow in flows.entries.values() {
            flow.stop.cancel();
        }
        std::mem::take(&mut flows.entries)
    };
    let mut errors = Vec::new();
    let mut source = None;
    for (_, mut flow) in entries {
        if let Err(error) = flow.join().await {
            errors.push(json!({"code":error.code,"data":error.data}));
            if source.is_none() {
                source = Some(error);
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Error::new(
            -32006,
            "channel_login_cleanup",
            "Some native login resources could not be confirmed closed",
        )
        .with_data(json!({"failures":errors}))
        .with_source(source.expect("nonempty cleanup errors")))
    }
}
