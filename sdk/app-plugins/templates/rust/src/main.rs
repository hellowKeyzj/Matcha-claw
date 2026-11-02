use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;
const MAX_ACTIVE_TOOLS: usize = 16;
const MODEL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
type ModelReply = Result<Value, String>;

struct Connection {
    output: Mutex<io::Stdout>,
    model_replies: Mutex<HashMap<String, SyncSender<ModelReply>>>,
    active_tools: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next_model_id: AtomicU64,
    log_level: AtomicU8,
}

impl Connection {
    fn send(&self, message: Value) -> io::Result<()> {
        let bytes = serde_json::to_vec(&message)?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(io::Error::other("MCP output exceeds 128 MiB"));
        }
        let mut output = self.output.lock().unwrap();
        output.write_all(&bytes)?;
        output.write_all(b"\n")?;
        output.flush()
    }

    fn respond(&self, id: Value, result: Value) -> io::Result<()> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }

    fn reject(&self, id: Value, code: i32, message: &str) -> io::Result<()> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}))
    }

    fn notify(&self, method: &str, params: Value) -> io::Result<()> {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    fn route_model_reply(&self, message: &Value) {
        let Some(id) = message["id"].as_str() else {
            return;
        };
        let Some(sender) = self.model_replies.lock().unwrap().remove(id) else {
            return;
        };
        let reply = match (message.get("result"), message.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => Err(error["message"]
                .as_str()
                .unwrap_or("Host model request failed")
                .to_owned()),
            _ => Err("Host returned an invalid model response".to_owned()),
        };
        let _ = sender.send(reply);
    }
}

#[derive(Clone)]
struct HostContext {
    plugin_id: String,
    version: String,
    // Package files are read-only; durable plugin data belongs in storage_path.
    #[allow(dead_code)]
    package_path: String,
    #[allow(dead_code)]
    storage_path: String,
    connection: Arc<Connection>,
}

impl HostContext {
    fn from_initialize(params: &Value, connection: Arc<Connection>) -> Result<Self, &'static str> {
        let metadata = params
            .pointer("/_meta/matcha")
            .ok_or("Missing initialize.params._meta.matcha")?;
        let read_text = |field: &str| {
            metadata[field]
                .as_str()
                .filter(|text| !text.is_empty() && text.len() <= 4096 && !text.contains('\0'))
                .map(str::to_owned)
                .ok_or("Invalid Matcha initialization metadata")
        };
        Ok(Self {
            plugin_id: read_text("pluginId")?,
            version: read_text("version")?,
            package_path: read_text("packagePath")?,
            storage_path: read_text("storagePath")?,
            connection,
        })
    }

    fn publish(&self, topic: &str, data: Value) -> io::Result<()> {
        self.connection.notify(
            "notifications/matcha/event",
            json!({"topic": topic, "data": data}),
        )
    }

    fn log(&self, level: &str, message: &str) -> io::Result<()> {
        let priority =
            log_priority(level).ok_or_else(|| io::Error::other("Invalid MCP log level"))?;
        if priority < self.connection.log_level.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.connection.notify(
            "notifications/message",
            json!({"level": level, "logger": "rust-plugin", "data": message}),
        )
    }

    fn report_progress(&self, token: Option<&Value>, progress: u64, total: u64) -> io::Result<()> {
        let Some(token) = token else { return Ok(()) };
        self.connection.notify(
            "notifications/progress",
            json!({"progressToken": token, "progress": progress, "total": total}),
        )
    }

    fn request_model(&self, method: &str, request: Value, cancelled: &AtomicBool) -> ModelReply {
        if !request.is_object() {
            return Err("Model request must be an object".to_owned());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("Tool request cancelled".to_owned());
        }
        let id = format!(
            "rust-model-{}",
            self.connection
                .next_model_id
                .fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        self.connection
            .model_replies
            .lock()
            .unwrap()
            .insert(id.clone(), sender);
        let result = (|| {
            self.connection
                .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": request}))
                .map_err(|_| "Could not send the host model request".to_owned())?;
            let deadline = Instant::now() + MODEL_TIMEOUT;
            loop {
                if cancelled.load(Ordering::Acquire) {
                    return Err("Tool request cancelled".to_owned());
                }
                if Instant::now() >= deadline {
                    return Err("Host model request timed out after 20 minutes; generation may already have occurred".to_owned());
                }
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(reply) => return reply,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err("Host model connection closed".to_owned())
                    }
                }
            }
        })();
        let is_pending = self
            .connection
            .model_replies
            .lock()
            .unwrap()
            .remove(&id)
            .is_some();
        if is_pending {
            // Cancelling a tool must also cancel the particular reverse request it started.
            let _ = self.connection.notify(
                "notifications/cancelled",
                json!({"requestId": id, "reason": "Plugin stopped waiting for the model request"}),
            );
        }
        result
    }
}

// These helpers pass the public SDK request unchanged; credentials stay in Matcha.
// Call only from a tool worker, never from the stdin reader below.
#[allow(dead_code)]
impl HostContext {
    fn list_models(&self, request: Value, cancelled: &AtomicBool) -> ModelReply {
        self.request_model("matcha/models/list", request, cancelled)
    }
    fn generate(&self, request: Value, cancelled: &AtomicBool) -> ModelReply {
        self.request_model("matcha/models/generate", request, cancelled)
    }
    fn generate_text(&self, request: Value, cancelled: &AtomicBool) -> ModelReply {
        self.request_model("matcha/models/generateText", request, cancelled)
    }
    fn submit_video(&self, request: Value, cancelled: &AtomicBool) -> ModelReply {
        self.request_model("matcha/models/submitVideo", request, cancelled)
    }
    fn query_video(&self, request: Value, cancelled: &AtomicBool) -> ModelReply {
        self.request_model("matcha/models/queryVideo", request, cancelled)
    }
    fn collect_video(&self, request: Value, cancelled: &AtomicBool) -> ModelReply {
        self.request_model("matcha/models/collectVideo", request, cancelled)
    }
}

fn log_priority(level: &str) -> Option<u8> {
    [
        "debug",
        "info",
        "notice",
        "warning",
        "error",
        "critical",
        "alert",
        "emergency",
    ]
    .iter()
    .position(|candidate| *candidate == level)
    .map(|priority| priority as u8)
}

fn is_request_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|id| !id.is_empty() && id.len() <= 128)
        || value
            .as_i64()
            .is_some_and(|id| id.unsigned_abs() <= 9_007_199_254_740_991)
}

fn call_tool(host: &HostContext, params: &Value, cancelled: &AtomicBool) -> Result<Value, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Tool request cancelled".to_owned());
    }
    if params["name"] != "echo" {
        return Err("Unknown tool; this template only provides echo".to_owned());
    }
    let arguments = params["arguments"]
        .as_object()
        .ok_or("echo requires an arguments object")?;
    let text = arguments
        .get("text")
        .and_then(Value::as_str)
        .ok_or("echo requires text to be a string")?;
    if arguments.len() != 1 || text.chars().count() > 4096 {
        return Err("echo accepts only text, with at most 4096 characters".to_owned());
    }
    let data = json!({"text": text, "pluginId": host.plugin_id, "version": host.version});
    if cancelled.load(Ordering::Acquire) {
        return Err("Tool request cancelled".to_owned());
    }
    host.publish("echo.completed", data.clone())
        .map_err(|_| "Could not publish the echo result")?;
    host.report_progress(params.pointer("/_meta/progressToken"), 1, 1)
        .map_err(|_| "Could not report echo progress")?;
    Ok(json!({
        "content": [
            {"type": "text", "text": text},
            {"type": "resource", "resource": {"uri": format!("echo://{}/result", host.plugin_id), "mimeType": "text/plain", "text": text}}
        ],
        "structuredContent": data,
        "_meta": {"backend": "rust"}
    }))
}

fn start_tool(host: HostContext, id: Value, params: Value) -> io::Result<()> {
    let key = id.to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = host.connection.active_tools.lock().unwrap();
        if active.contains_key(&key) {
            return host
                .connection
                .reject(id, -32600, "Duplicate active request ID");
        }
        if active.len() >= MAX_ACTIVE_TOOLS {
            return host
                .connection
                .reject(id, -32000, "At most 16 concurrent tools are supported");
        }
        active.insert(key.clone(), cancelled.clone());
    }
    let connection = host.connection.clone();
    let worker_key = key.clone();
    let worker_id = id.clone();
    // ponytail: one thread per tool, capped at 16; use a worker pool only for a higher measured workload.
    let worker = thread::Builder::new().name("plugin-tool".to_owned()).spawn(move || {
        let result = call_tool(&host, &params, &cancelled);
        let response = if cancelled.load(Ordering::Acquire) {
            host.connection.reject(worker_id, -32800, "Tool request cancelled")
        } else {
            let result = result.unwrap_or_else(|message| json!({"content": [{"type": "text", "text": message}], "isError": true}));
            host.connection.respond(worker_id, result)
        };
        host.connection.active_tools.lock().unwrap().remove(&worker_key);
        if response.is_err() { eprintln!("[rust-plugin] Could not write a tool response"); }
    });
    if worker.is_err() {
        connection.active_tools.lock().unwrap().remove(&key);
        connection.reject(id, -32603, "Could not start the tool worker")?;
    }
    Ok(())
}

enum Initialization {
    Waiting,
    Accepted(HostContext),
    Ready(HostContext),
}

fn serve(connection: &Arc<Connection>) -> io::Result<()> {
    // Compile-time manifest keeps tools/list identical to the packaged contract.
    let manifest: Value = serde_json::from_str(include_str!("../manifest.json"))?;
    let mut initialization = Initialization::Waiting;
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut frame = Vec::new();
    loop {
        frame.clear();
        let read = (&mut reader)
            .take((MAX_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut frame)?;
        if read == 0 {
            return Ok(());
        }
        if frame.len() > MAX_FRAME_BYTES {
            return Err(io::Error::other("MCP input exceeds 128 MiB"));
        }
        let message: Value = match serde_json::from_slice(&frame) {
            Ok(message) => message,
            Err(_) => {
                connection.reject(Value::Null, -32700, "Invalid JSON")?;
                continue;
            }
        };
        if !message.is_object() || message["jsonrpc"] != "2.0" {
            connection.reject(Value::Null, -32600, "Expected a JSON-RPC 2.0 object")?;
            continue;
        }
        if message.get("method").is_none() {
            connection.route_model_reply(&message);
            continue;
        }
        let id = message.get("id").cloned();
        if id.as_ref().is_some_and(|id| !is_request_id(id)) {
            connection.reject(Value::Null, -32600, "Invalid request ID")?;
            continue;
        }
        let Some(method) = message["method"].as_str() else {
            if let Some(id) = id {
                connection.reject(id, -32600, "Invalid method")?;
            }
            continue;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let Some(id) = id else {
            match method {
                "notifications/initialized" => {
                    if let Initialization::Accepted(host) = &initialization {
                        host.log(
                            "info",
                            "Rust backend initialized; echo does not call a model",
                        )?;
                        initialization = Initialization::Ready(host.clone());
                    }
                }
                "notifications/cancelled" if is_request_id(&params["requestId"]) => {
                    if let Some(cancelled) = connection
                        .active_tools
                        .lock()
                        .unwrap()
                        .get(&params["requestId"].to_string())
                    {
                        cancelled.store(true, Ordering::Release);
                    }
                    if let Some(id) = params["requestId"].as_str() {
                        if let Some(sender) = connection.model_replies.lock().unwrap().remove(id) {
                            let _ = sender.send(Err("Host cancelled the model request".to_owned()));
                        }
                    }
                }
                _ => {}
            }
            continue;
        };
        if !params.is_object() {
            connection.reject(id, -32602, "Parameters must be an object")?;
            continue;
        }
        if method == "ping" {
            connection.respond(id, json!({}))?;
            continue;
        }
        if method == "initialize" {
            if !matches!(initialization, Initialization::Waiting) {
                connection.reject(id, -32600, "Already initialized")?;
                continue;
            }
            let version = params["protocolVersion"].as_str().unwrap_or("");
            let version = match version {
                "2025-11-25" | "2025-06-18" | "2024-11-05" => version,
                _ => "2025-11-25",
            };
            match HostContext::from_initialize(&params, connection.clone()) {
                Ok(host) => {
                    connection.respond(id, json!({"protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}, "logging": {}},
                        "serverInfo": {"name": "matcha-app-plugin-rust", "version": env!("CARGO_PKG_VERSION")}}))?;
                    initialization = Initialization::Accepted(host);
                }
                Err(message) => connection.reject(id, -32602, message)?,
            }
            continue;
        }
        let Initialization::Ready(host) = &initialization else {
            connection.reject(
                id,
                -32002,
                "Send initialize and notifications/initialized first",
            )?;
            continue;
        };
        match method {
            "tools/list" => {
                connection.respond(id, json!({"tools": manifest["contributes"]["tools"]}))?
            }
            "tools/call" => start_tool(host.clone(), id, params)?,
            "logging/setLevel" => match params["level"].as_str().and_then(log_priority) {
                Some(priority) => {
                    connection.log_level.store(priority, Ordering::Relaxed);
                    connection.respond(id, json!({}))?;
                }
                None => connection.reject(id, -32602, "Invalid MCP log level")?,
            },
            _ => connection.reject(id, -32601, "Method not found")?,
        }
    }
}

fn main() {
    let connection = Arc::new(Connection {
        output: Mutex::new(io::stdout()),
        model_replies: Mutex::new(HashMap::new()),
        active_tools: Mutex::new(HashMap::new()),
        next_model_id: AtomicU64::new(1),
        log_level: AtomicU8::new(1),
    });
    let result = serve(&connection);
    for cancelled in connection.active_tools.lock().unwrap().values() {
        cancelled.store(true, Ordering::Release);
    }
    connection.model_replies.lock().unwrap().clear();
    if let Err(error) = result {
        eprintln!("[rust-plugin] MCP connection closed: {error}");
        std::process::exit(1);
    }
    // Returning from main ends worker threads as well; stdin EOF is host shutdown.
}
