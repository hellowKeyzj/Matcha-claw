pub mod command;
pub(crate) mod idle;
pub mod process;
pub mod projection;
pub mod protocol;
mod search;

use crate::{
    config::{AgentConfig, Config, Paths},
    diagnostics::Diagnostics,
    rpc::{self, Error},
};
use process::{Output, Process};
use protocol::NativeMessage;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    mem,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub struct LaunchSpec {
    pub config: Config,
    pub agent: AgentConfig,
    pub agent_id: String,
    pub session_id: String,
    pub paths: Paths,
    pub resume: bool,
    pub fork_from: Option<String>,
}

pub enum CliEvent {
    Message(Value),
    Result(Value),
    Request {
        request_id: String,
        request: Value,
    },
    Cancel {
        request_id: String,
    },
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    Fault(Error),
}

#[derive(Clone)]
pub struct Cli(Arc<Handle>);

struct Handle {
    instance: Arc<Instance>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.instance.begin_close();
    }
}

struct Instance {
    process: Process,
    instance_id: String,
    session_id: String,
    model_overrides: [bool; 3],
    has_autonomous_inputs: bool,
    sealed: Option<crate::sealed::InstanceGuard>,
    search: tokio::sync::Mutex<search::State>,
    pending: Mutex<Pending>,
    incoming: Mutex<HashSet<String>>,
    admission: Arc<tokio::sync::RwLock<idle::Admission>>,
    activity: watch::Sender<tokio::time::Instant>,
    closing: AtomicBool,
    output_fault: AtomicBool,
    initialized: watch::Sender<Option<rpc::Result<Value>>>,
    closed: watch::Sender<Option<rpc::Result<()>>>,
    initializer: Mutex<Option<JoinHandle<()>>>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Pending {
    requests: BTreeMap<String, PendingRequest>,
    failure: Option<Error>,
}

struct PendingRequest {
    response: oneshot::Sender<rpc::Result<Value>>,
    _admission: Option<Arc<idle::Lease>>,
}

impl Cli {
    pub async fn start(
        spec: LaunchSpec,
        diagnostics: Diagnostics,
    ) -> rpc::Result<(Self, mpsc::Receiver<CliEvent>)> {
        Uuid::parse_str(&spec.session_id)
            .map_err(|_| Error::invalid("Session ID must be a UUID"))?;
        if let Some(source) = &spec.fork_from {
            Uuid::parse_str(source)
                .map_err(|_| Error::invalid("Fork source must be a session UUID"))?;
            if spec.resume || source == &spec.session_id {
                return Err(Error::invalid(
                    "A fork needs a new session ID and cannot also resume",
                ));
            }
        }
        let mut args = vec![
            "-p".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
            "--replay-user-messages".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
        ];
        if let Some(source) = &spec.fork_from {
            args.extend([
                "--resume".into(),
                source.clone(),
                "--fork-session".into(),
                "--session-id".into(),
                spec.session_id.clone(),
            ]);
        } else if spec.resume {
            args.extend(["--resume".into(), spec.session_id.clone()]);
        } else {
            args.extend(["--session-id".into(), spec.session_id.clone()]);
        }
        if let Some(model) = projection::model(&spec.config, &spec.agent)? {
            args.extend(["--model".into(), model]);
        }
        if let Some(tools) = &spec.agent.tools {
            args.push("--tools".into());
            if tools.is_empty() {
                args.push(String::new());
            } else {
                args.extend(tools.iter().cloned());
            }
        }
        if !spec.agent.allowed_tools.is_empty() {
            args.push("--allowedTools".into());
            args.extend(spec.agent.allowed_tools.iter().cloned());
        }
        if !spec.agent.disallowed_tools.is_empty() {
            args.push("--disallowedTools".into());
            args.extend(spec.agent.disallowed_tools.iter().cloned());
        }
        let required_sandbox =
            spec.agent.settings.pointer("/sandbox/enabled") == Some(&Value::Bool(true));
        let channels = channels(&spec)?;
        let has_channel_inputs = !channels.is_empty();
        let mut settings = projection::settings(&spec.paths, &spec.agent_id, &spec.agent)?;
        settings
            .as_object_mut()
            .expect("native settings object")
            .entry("enabledPlugins")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| Error::invalid("enabledPlugins must be an object"))?
            .insert("weixin@builtin".into(), Value::Bool(has_channel_inputs));
        args.extend([
            "--settings".into(),
            serde_json::to_string(&settings)
                .map_err(|source| Error::internal("native_settings_encode").with_source(source))?,
        ]);
        if has_channel_inputs {
            args.push("--channels".into());
            args.extend(channels);
        }
        let mut execution_config = spec.config.clone();
        if !execution_config.agents.contains_key(&spec.agent_id) {
            return Err(Error::not_found("agent"));
        }
        execution_config
            .agents
            .insert(spec.agent_id.clone(), spec.agent.clone());
        let mut launch =
            projection::launch(&execution_config, &spec.paths, &spec.agent_id, args).await?;
        let instance_id = Uuid::new_v4().to_string();
        let sealed = spec.config.private_sealed.acquire(
            &spec.config,
            &spec.agent_id,
            &spec.session_id,
            &instance_id,
        )?;
        if let Some(sealed) = &sealed {
            sealed.inject(&mut launch.env);
        }
        let has_autonomous_inputs = has_channel_inputs || has_cron_inputs(&launch).await;
        let model_overrides = ["OPENAI_MODEL", "GEMINI_MODEL", "GROK_MODEL"]
            .map(|name| launch.env.get(name).is_some_and(|model| !model.is_empty()));
        let (process, output) = Process::spawn(launch).await?;
        let (closed, _) = watch::channel(None);
        let (initialized, _) = watch::channel(None);
        let instance = Arc::new(Instance {
            process,
            instance_id,
            session_id: spec.session_id.clone(),
            model_overrides,
            has_autonomous_inputs,
            sealed,
            search: tokio::sync::Mutex::new(search::State::default()),
            pending: Mutex::new(Pending::default()),
            incoming: Mutex::new(HashSet::new()),
            admission: idle::admission(),
            activity: watch::channel(tokio::time::Instant::now()).0,
            closing: AtomicBool::new(false),
            output_fault: AtomicBool::new(false),
            initialized,
            closed,
            initializer: Mutex::new(None),
            reader: Mutex::new(None),
        });
        // Only buffers a transient stdio burst; Session owns an independent durable consumer.
        let (events, receiver) = mpsc::channel(256);
        let mut reader_slot = instance.reader.lock().expect("native reader lock");
        let mut initializer_slot = instance
            .initializer
            .lock()
            .expect("native initializer lock");
        let reader = tokio::spawn(read_output(
            instance.clone(),
            output,
            events,
            diagnostics,
            spec.agent_id,
        ));
        *reader_slot = Some(reader);
        let mut initialize = json!({"subtype": "initialize"});
        if let Some(prompt) = spec.agent.system_prompt {
            initialize["systemPrompt"] = Value::String(prompt);
        }
        if let Some(prompt) = spec.agent.append_system_prompt {
            initialize["appendSystemPrompt"] = Value::String(prompt);
        }
        let initializing = instance.clone();
        let initializer = tokio::spawn(async move {
            let result = async {
                let initialized = initializing.request(initialize).await?;
                if let Some(projection) = &spec.config.search {
                    initializing.apply_search(Some(projection)).await?;
                }
                if required_sandbox {
                    let response = initializing
                        .request(json!({"subtype": "get_settings"}))
                        .await?;
                    crate::policy::validate_required_sandbox(&response["effective"]).await?;
                }
                Ok(initialized)
            }
            .await;
            let failed = result.is_err();
            initializing.initialized.send_replace(Some(result));
            if failed {
                initializing.begin_close();
            }
        });
        *initializer_slot = Some(initializer);
        drop(initializer_slot);
        drop(reader_slot);
        Ok((Self(Arc::new(Handle { instance })), receiver))
    }

    pub fn instance_id(&self) -> &str {
        &self.0.instance.instance_id
    }

    pub(crate) fn has_autonomous_inputs(&self) -> bool {
        self.0.instance.has_autonomous_inputs
    }

    pub async fn initialized(&self) -> rpc::Result<Value> {
        let mut initialized = self.0.instance.initialized.subscribe();
        loop {
            if let Some(result) = initialized.borrow_and_update().clone() {
                return result;
            }
            initialized
                .changed()
                .await
                .map_err(|_| Error::internal("native_initialization_observer_closed"))?;
        }
    }

    pub fn model_requires_restart(&self) -> bool {
        let initialized = self.0.instance.initialized.borrow();
        let Some(Ok(initialized)) = initialized.as_ref() else {
            return true;
        };
        match initialized
            .pointer("/account/apiProvider")
            .and_then(Value::as_str)
        {
            Some("openai" | "openaiResponses") => self.0.instance.model_overrides[0],
            Some("gemini") => self.0.instance.model_overrides[1],
            Some("grok") => self.0.instance.model_overrides[2],
            Some("firstParty" | "bedrock" | "vertex" | "foundry") => false,
            _ => true,
        }
    }

    pub async fn request(&self, request: Value) -> rpc::Result<Value> {
        self.admit()?.request(request).await
    }

    pub async fn send_user(
        &self,
        session_id: &str,
        message_id: &str,
        content: Value,
    ) -> rpc::Result<()> {
        if session_id != self.0.instance.session_id {
            return Err(not_sent(Error::invalid(
                "The user message belongs to a different CLI session",
            )));
        }
        if Uuid::parse_str(message_id).is_err() || !(content.is_string() || content.is_array()) {
            return Err(not_sent(Error::invalid(
                "User input requires a message UUID and text or native content blocks",
            )));
        }
        let _control = self.admit()?;
        self.initialized().await.map_err(not_sent)?;
        self.0.instance.ensure_open()?;
        self.0
            .instance
            .process
            .send(encode(protocol::user_message(
                session_id, message_id, content,
            ))?)
            .await
    }

    pub async fn respond(&self, request_id: &str, response: Value) -> rpc::Result<()> {
        self.admit()?.respond(request_id, response).await
    }

    async fn respond_admitted(&self, request_id: &str, response: Value) -> rpc::Result<()> {
        let valid = match response.get("subtype").and_then(Value::as_str) {
            Some("success") => response.get("response").is_none_or(Value::is_object),
            Some("error") => response.get("error").is_some_and(Value::is_string),
            _ => false,
        };
        if !valid || response.get("request_id").is_some() {
            return Err(not_sent(Error::invalid(
                "A native response must be a success or error envelope without request_id",
            )));
        }
        self.0.instance.ensure_open()?;
        let bytes = encode(protocol::control_response(request_id, response))?;
        if !self
            .0
            .instance
            .incoming
            .lock()
            .expect("native requests lock")
            .remove(request_id)
        {
            return Err(not_sent(Error::conflict(
                "native_request_not_pending",
                "This CLI instance no longer has the native request",
            )));
        }
        let result = self.0.instance.process.send(bytes).await;
        if result
            .as_ref()
            .err()
            .and_then(|error| error.data.as_ref())
            .and_then(|data| data.get("delivery"))
            .and_then(Value::as_str)
            == Some("notSent")
        {
            self.0
                .instance
                .incoming
                .lock()
                .expect("native requests lock")
                .insert(request_id.into());
        }
        result
    }

    pub async fn close(&self) -> rpc::Result<()> {
        let mut closed = self.0.instance.closed.subscribe();
        self.0.instance.begin_close();
        loop {
            if let Some(result) = closed.borrow_and_update().clone() {
                return result;
            }
            closed
                .changed()
                .await
                .map_err(|_| Error::internal("native_cleanup_observer_closed"))?;
        }
    }
}

impl Instance {
    fn ensure_open(&self) -> rpc::Result<()> {
        if self.closing.load(Ordering::Acquire)
            || self
                .pending
                .lock()
                .expect("native pending lock")
                .failure
                .is_some()
        {
            return Err(not_sent(Error::unavailable(
                "native_instance_closed",
                "The native CLI instance is closed",
            )));
        }
        Ok(())
    }

    async fn request_admitted(
        &self,
        request: Value,
        admission: Option<Arc<idle::Lease>>,
    ) -> rpc::Result<Value> {
        if !request.is_object()
            || request
                .get("subtype")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Err(not_sent(Error::invalid(
                "A native control request requires a subtype",
            )));
        }
        self.ensure_open()?;
        let request_id = format!("{}:{}", self.instance_id, Uuid::new_v4());
        let bytes = encode(protocol::control_request(&request_id, request))?;
        let (sender, response) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("native pending lock");
            if pending.failure.is_some() || self.closing.load(Ordering::Acquire) {
                return Err(not_sent(Error::unavailable(
                    "native_instance_closed",
                    "The native CLI instance is closed",
                )));
            }
            pending.requests.insert(
                request_id.clone(),
                PendingRequest {
                    response: sender,
                    _admission: admission,
                },
            );
        }
        // Cancellation of the caller cannot release its admission while the native
        // control may still be running. The response or instance close releases it.
        if let Err(error) = self.process.send(bytes).await {
            self.pending
                .lock()
                .expect("native pending lock")
                .requests
                .remove(&request_id);
            return Err(error);
        }
        response.await.map_err(|_| Error::new(-32006, "native_response_lost", "The native control response could not be observed")
            .with_data(json!({"instanceId": self.instance_id, "nativeRequestId": request_id, "delivery": "unknown"})))?
    }

    fn reject_pending(&self, reason: &str) {
        let requests = {
            let mut pending = self.pending.lock().expect("native pending lock");
            pending.failure = Some(Error::unavailable(
                "native_instance_closed",
                "The native CLI instance is closed",
            ));
            mem::take(&mut pending.requests)
        };
        self.incoming.lock().expect("native requests lock").clear();
        for (request_id, sender) in requests {
            let _ = sender.response.send(Err(Error::new(-32006, "native_response_lost", "The native CLI closed before the control response was observed")
                .with_data(json!({"instanceId": self.instance_id, "nativeRequestId": request_id, "reason": reason, "delivery": "unknown"}))));
        }
    }

    fn begin_close(self: &Arc<Self>) {
        if let Some(sealed) = &self.sealed {
            sealed.revoke();
        }
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        self.reject_pending("closing");
        let instance = self.clone();
        tokio::spawn(async move {
            let mut result = instance.process.close().await;
            let initializer = instance
                .initializer
                .lock()
                .expect("native initializer lock")
                .take();
            if let Some(initializer) = initializer
                && let Err(source) = initializer.await
            {
                result = command::combine_cleanup(
                    result,
                    Err(Error::internal("native_initializer_join").with_source(source)),
                );
            }
            let reader = instance.reader.lock().expect("native reader lock").take();
            if let Some(reader) = reader
                && let Err(source) = reader.await
            {
                result = command::combine_cleanup(
                    result,
                    Err(Error::internal("native_reader_join").with_source(source)),
                );
            }
            instance.closed.send_replace(Some(result));
        });
    }
}

fn encode(message: Value) -> rpc::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(&message)
        .map_err(|source| not_sent(Error::internal("native_input_encode").with_source(source)))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn not_sent(error: Error) -> Error {
    error.with_data(json!({"delivery": "notSent"}))
}

fn channels(spec: &LaunchSpec) -> rpc::Result<Vec<String>> {
    let mut sources = HashSet::new();
    for id in &spec.agent.channels {
        let channel = spec
            .config
            .channels
            .get(id)
            .ok_or_else(|| Error::not_found("channel"))?;
        if channel.get("agentId").and_then(Value::as_str) != Some(&spec.agent_id) {
            return Err(Error::invalid(
                "An Agent channel binding belongs to another Agent",
            ));
        }
        if channel.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let session = channel
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::invalid("An enabled channel requires a session binding"))?;
        if session != spec.session_id {
            continue;
        }
        if channel.get("source").and_then(Value::as_str) != Some("plugin:weixin@builtin") {
            return Err(Error::invalid("This channel source is not supported"));
        }
        sources.insert("plugin:weixin@builtin".into());
    }
    Ok(sources.into_iter().collect())
}

async fn has_cron_inputs(launch: &process::Launch) -> bool {
    if launch
        .env
        .get("CLAUDE_CODE_DISABLE_CRON")
        .is_some_and(|value| {
            ["1", "true", "yes", "on"]
                .iter()
                .any(|truthy| value.trim().eq_ignore_ascii_case(truthy))
        })
    {
        return false;
    }
    let bytes = match tokio::fs::read(launch.cwd.join(".claude").join("scheduled_tasks.json")).await
    {
        Ok(bytes) => bytes,
        Err(source) => return source.kind() != std::io::ErrorKind::NotFound,
    };
    let Ok(file) = serde_json::from_slice::<Value>(&bytes) else {
        return true;
    };
    file.get("tasks")
        .and_then(Value::as_array)
        .is_none_or(|tasks| !tasks.is_empty())
}

async fn read_output(
    instance: Arc<Instance>,
    mut output: mpsc::Receiver<Output>,
    events: mpsc::Sender<CliEvent>,
    diagnostics: Diagnostics,
    agent_id: String,
) {
    let mut buffer = Vec::new();
    let mut fault = None;
    let mut fault_reported = false;
    let mut exit = None;
    let mut stderr_observed = false;
    let mut orphan_responses = 0_u64;
    let mut consumer_closed = false;
    while let Some(output) = output.recv().await {
        let mut emitted = Vec::new();
        match output {
            Output::Stdout(bytes) if fault.is_none() => {
                buffer.extend_from_slice(&bytes);
                let mut start = 0;
                while let Some(end) = buffer[start..].iter().position(|byte| *byte == b'\n') {
                    let end = start + end;
                    let line = &buffer[start..end];
                    if !line.iter().all(u8::is_ascii_whitespace) {
                        match decode_line(&instance, line, &mut emitted, &mut orphan_responses) {
                            Ok(()) => {}
                            Err(error) => {
                                fault = Some(error);
                                break;
                            }
                        }
                    }
                    start = end + 1;
                }
                buffer.drain(..start);
            }
            Output::Stdout(_) => {}
            Output::StdoutClosed => {
                if fault.is_none()
                    && !buffer.iter().all(u8::is_ascii_whitespace)
                    && let Err(error) =
                        decode_line(&instance, &buffer, &mut emitted, &mut orphan_responses)
                {
                    fault = Some(error);
                }
                buffer.clear();
                instance.reject_pending("stdout_eof");
                instance.begin_close();
            }
            Output::Stderr => stderr_observed = true,
            Output::ReadFailed { stream, kind } => {
                fault = Some(
                    Error::new(
                        -32004,
                        "native_output_read",
                        "Reading native CLI output failed",
                    )
                    .with_data(json!({"stream": stream, "reason": kind})),
                );
            }
            Output::Exited { code, signal } => {
                if let Some(sealed) = &instance.sealed {
                    sealed.revoke();
                }
                instance.reject_pending("exit");
                exit = Some((code, signal));
                emitted.push(CliEvent::Exited { code, signal });
            }
        }
        if !fault_reported && let Some(error) = &fault {
            instance.output_fault.store(true, Ordering::Release);
            fault_reported = true;
            instance.reject_pending("output_fault");
            emitted.push(CliEvent::Fault(error.clone()));
            instance.begin_close();
        }
        for event in emitted {
            if !consumer_closed && events.send(event).await.is_err() {
                consumer_closed = true;
                instance.begin_close();
            }
        }
        if exit.is_some() {
            break;
        }
    }
    instance.reject_pending("output_closed");
    if exit.is_none() {
        instance.output_fault.store(true, Ordering::Release);
        let error = Error::new(
            -32006,
            "native_exit_unobserved",
            "The native CLI output closed before its process exit was observed",
        );
        if !consumer_closed {
            let _ = events.send(CliEvent::Fault(error)).await;
        }
        instance.begin_close();
    }
    let (code, signal) = exit.unwrap_or((None, None));
    let kind = if fault.is_some() {
        "output_fault"
    } else if exit.is_none() {
        "exit_unobserved"
    } else {
        "exited"
    };
    if diagnostics.record("cli", "instance", kind, json!({
        "agentId": agent_id, "sessionId": instance.session_id, "instanceId": instance.instance_id,
        "pid": instance.process.pid(), "exitCode": code, "signal": signal,
        "stderrObserved": stderr_observed, "count": orphan_responses,
    })).await.is_err() {
        eprintln!("native CLI diagnostics could not be persisted");
    }
}

struct NativeControlFailure(Value);

impl std::fmt::Display for NativeControlFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "native control response rejected ({} fields)",
            self.0.as_object().map_or(0, |fields| fields.len())
        )
    }
}

impl std::fmt::Debug for NativeControlFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, formatter)
    }
}

impl std::error::Error for NativeControlFailure {}

fn decode_line(
    instance: &Instance,
    line: &[u8],
    events: &mut Vec<CliEvent>,
    orphan_responses: &mut u64,
) -> rpc::Result<()> {
    match protocol::decode(line)? {
        NativeMessage::ControlResponse {
            request_id,
            response,
        } => {
            if let Some(sender) = instance
                .pending
                .lock()
                .expect("native pending lock")
                .requests
                .remove(&request_id)
            {
                let result = if response.get("subtype").and_then(Value::as_str) == Some("success") {
                    Ok(response
                        .get("response")
                        .cloned()
                        .unwrap_or_else(|| json!({})))
                } else {
                    let pending_permissions = response
                        .get("pending_permission_requests")
                        .and_then(Value::as_array)
                        .map(Vec::len);
                    Err(Error::new(-32004, "native_control_error", "The native CLI rejected the control request")
                        .with_data(json!({"instanceId": instance.instance_id, "nativeRequestId": request_id, "delivery": "sent", "pendingPermissionCount": pending_permissions}))
                        .with_source(NativeControlFailure(response)))
                };
                let _ = sender.response.send(result);
            } else {
                *orphan_responses = orphan_responses.saturating_add(1);
            }
        }
        NativeMessage::ControlRequest {
            request_id,
            request,
        } => {
            if !instance
                .incoming
                .lock()
                .expect("native requests lock")
                .insert(request_id.clone())
            {
                return Err(Error::new(
                    -32004,
                    "native_duplicate_request",
                    "The CLI repeated an outstanding native request ID",
                ));
            }
            events.push(CliEvent::Request {
                request_id,
                request,
            });
        }
        NativeMessage::ControlCancel { request_id } => {
            instance
                .incoming
                .lock()
                .expect("native requests lock")
                .remove(&request_id);
            events.push(CliEvent::Cancel { request_id });
        }
        NativeMessage::Result(value) => events.push(CliEvent::Result(value)),
        NativeMessage::Message(value) => events.push(CliEvent::Message(value)),
    }
    Ok(())
}
