use std::io;

use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
    task::{AbortHandle, Id, JoinError, JoinSet},
};

use super::arguments::{require_exact_keys, required_string, strict_object};
use super::registry::CatalogRevision;
use super::transport::{extract_request_id, next_message, write_message};
use super::{
    DecodeError, Framing, Registry, Request, RequestId, ResourceReadError, ToolCallError,
    ToolCatalog, decode_request, encode_error, encode_result,
};

const SERVER_VERSION: &str = "0.0.0";
const INVALID_REQUEST: &str = "Invalid Request";
const PARSE_ERROR: &str = "Parse error";
const METHOD_NOT_FOUND: &str = "Method not found";
const INVALID_PARAMS: &str = "Invalid params";
const INTERNAL_ERROR: &str = "Internal error";
const MAX_IN_FLIGHT: usize = 32;

pub async fn run_stdio<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    catalog: ToolCatalog,
    input: R,
    output: W,
) -> io::Result<()> {
    let registry = Registry::new(catalog).map_err(io::Error::other)?;
    run_stdio_registry(registry, input, output).await
}

pub async fn run_stdio_registry<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    registry: Registry,
    input: R,
    mut output: W,
) -> io::Result<()> {
    let mut calls = JoinSet::new();
    let result = Server { registry }
        .run(input, &mut output, &mut calls)
        .await;
    // Transport failure ends MCP waits, not effects already admitted by the Host owner.
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    result
}

struct Server {
    registry: Registry,
}

struct PendingCall {
    request_id: Option<RequestId>,
    framing: Framing,
    task: AbortHandle,
}

impl Server {
    async fn run<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
        &self,
        mut input: R,
        output: &mut W,
        calls: &mut JoinSet<Option<Vec<u8>>>,
    ) -> io::Result<()> {
        let mut buffer = Vec::new();
        let mut pending = Vec::new();
        let mut eof = false;
        let mut initialized_framing = None;
        let mut changes = self.registry.subscribe();
        let mut observed = *changes.borrow_and_update();
        loop {
            while let Some(completed) = calls.try_join_next_with_id() {
                complete_call(completed, &mut pending, output).await?;
            }
            if let Some((framing, payload, consumed)) = next_message(&buffer, eof) {
                buffer.drain(..consumed);
                let response = match payload {
                    Ok(payload) => self.handle_payload(
                        payload,
                        framing.clone(),
                        calls,
                        &mut pending,
                        &mut initialized_framing,
                    ),
                    Err(error) => encode_error(
                        Some(&RequestId::Null),
                        error.json_rpc_error_code(),
                        decode_message(error),
                    ),
                };
                if let Some(response) = response {
                    write_message(output, framing, &response).await?;
                }
                continue;
            }
            if eof {
                while let Some(completed) = calls.join_next_with_id().await {
                    complete_call(completed, &mut pending, output).await?;
                }
                return Ok(());
            }
            let mut chunk = [0_u8; 8192];
            tokio::select! {
                read = input.read(&mut chunk) => {
                    let read = read?;
                    eof = read == 0;
                    buffer.extend_from_slice(&chunk[..read]);
                }
                Some(completed) = calls.join_next_with_id(), if !calls.is_empty() => {
                    complete_call(completed, &mut pending, output).await?;
                }
                changed = changes.changed() => {
                    if changed.is_err() { return Err(io::Error::other("MCP catalog observation closed")); }
                    let current = *changes.borrow_and_update();
                    if let Some(framing) = &initialized_framing {
                        notify_changes(output, framing.clone(), observed, current).await?;
                    }
                    observed = current;
                }
            }
        }
    }

    fn handle_payload(
        &self,
        payload: Vec<u8>,
        framing: Framing,
        calls: &mut JoinSet<Option<Vec<u8>>>,
        pending: &mut Vec<PendingCall>,
        initialized_framing: &mut Option<Framing>,
    ) -> Option<Vec<u8>> {
        let request = match decode_request(&payload) {
            Ok(request) => request,
            Err(error) => {
                return encode_error(
                    extract_request_id(&payload).as_ref(),
                    error.json_rpc_error_code(),
                    decode_message(error),
                );
            }
        };
        if request.method() == "notifications/cancelled" && request.id().is_none() {
            if let Some(request_id) = cancellation_id(request.params()) {
                if let Some(index) = pending
                    .iter()
                    .position(|call| call.request_id.as_ref() == Some(&request_id))
                {
                    pending.swap_remove(index).task.abort();
                }
            }
            return None;
        }
        if request.id().is_some_and(|id| {
            pending
                .iter()
                .any(|call| call.request_id.as_ref() == Some(id))
        }) {
            return encode_error(request.id(), -32600, INVALID_REQUEST);
        }
        let result = match request.method() {
            "initialize" => Ok(initialize_result(request.params())),
            "notifications/initialized" => {
                *initialized_framing = Some(framing);
                Ok(Value::Null)
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.registry.tools() })),
            "resources/list" => Ok(json!({ "resources": self.registry.resources() })),
            "tools/call" | "resources/read" => {
                if calls.len() == MAX_IN_FLIGHT {
                    return encode_error(request.id(), -32000, "Server busy");
                }
                let registry = self.registry.clone();
                let request_id = request.id().cloned();
                let task = calls.spawn(async move {
                    match execute(&registry, &request).await {
                        Ok(response) => response,
                        Err((code, message)) => encode_error(request.id(), code, message),
                    }
                });
                pending.push(PendingCall {
                    request_id,
                    framing,
                    task,
                });
                return None;
            }
            _ => Err((-32601, METHOD_NOT_FOUND)),
        };
        match result {
            Ok(value) => encode_result(request.id(), value),
            Err((code, message)) => encode_error(request.id(), code, message),
        }
    }
}

async fn execute(
    registry: &Registry,
    request: &Request,
) -> Result<Option<Vec<u8>>, (i32, &'static str)> {
    let params = strict_object(request.params()).map_err(|_| invalid_params())?;
    if request.method() == "resources/read" {
        require_exact_keys(params, &["uri", "_meta"]).map_err(|_| invalid_params())?;
        let uri = required_string(params, "uri").map_err(|_| invalid_params())?;
        let result = registry.read(uri).await.map_err(|error| match error {
            ResourceReadError::InvalidParams => invalid_params(),
            ResourceReadError::NotFound => (-32002, "Resource not found"),
            ResourceReadError::Internal => internal_error(),
        })?;
        return Ok(encode_result(request.id(), result));
    }
    require_exact_keys(params, &["name", "arguments", "_meta"]).map_err(|_| invalid_params())?;
    let name = required_string(params, "name").map_err(|_| invalid_params())?;
    let arguments = strict_object(params.get("arguments")).map_err(|_| invalid_params())?;
    let meta = params
        .get("_meta")
        .map(|meta| strict_object(Some(meta)))
        .transpose()
        .map_err(|_| invalid_params())?;
    let result = registry
        .call(name, arguments, meta)
        .await
        .map_err(|error| match error {
            ToolCallError::InvalidParams => invalid_params(),
            ToolCallError::Internal
            | ToolCallError::Execution(_)
            | ToolCallError::ExecutionText(_) => internal_error(),
        })?;
    Ok(encode_result(request.id(), result))
}

async fn notify_changes<W: AsyncWrite + Unpin>(
    output: &mut W,
    framing: Framing,
    previous: CatalogRevision,
    current: CatalogRevision,
) -> io::Result<()> {
    for (changed, method) in [
        (
            previous.tools != current.tools,
            "notifications/tools/list_changed",
        ),
        (
            previous.resources != current.resources,
            "notifications/resources/list_changed",
        ),
    ] {
        if changed {
            let notification = serde_json::to_vec(&json!({"jsonrpc": "2.0", "method": method}))
                .expect("MCP notification is serializable");
            write_message(output, framing.clone(), &notification).await?;
        }
    }
    Ok(())
}

async fn complete_call<W: AsyncWrite + Unpin>(
    completed: Result<(Id, Option<Vec<u8>>), JoinError>,
    pending: &mut Vec<PendingCall>,
    output: &mut W,
) -> io::Result<()> {
    let task_id = match &completed {
        Ok((id, _)) => *id,
        Err(error) => error.id(),
    };
    let Some(index) = pending.iter().position(|call| call.task.id() == task_id) else {
        return Ok(());
    };
    let call = pending.swap_remove(index);
    let response = match completed {
        Ok((_, response)) => response,
        Err(error) if error.is_cancelled() => None,
        Err(_) => encode_error(call.request_id.as_ref(), -32603, INTERNAL_ERROR),
    };
    if let Some(response) = response {
        write_message(output, call.framing, &response).await?;
    }
    Ok(())
}

fn cancellation_id(params: Option<&Value>) -> Option<RequestId> {
    let params = params?.as_object()?;
    if params
        .get("reason")
        .is_some_and(|reason| !reason.is_string())
    {
        return None;
    }
    match params.get("requestId")? {
        Value::String(value) => Some(RequestId::String(value.clone())),
        Value::Number(value) => Some(RequestId::Number(value.clone())),
        _ => None,
    }
}

fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    let protocol_version = match requested {
        Some("2025-06-18") => "2025-06-18",
        Some("2025-11-25") => "2025-11-25",
        _ => "2024-11-05",
    };
    json!({ "protocolVersion": protocol_version, "capabilities": { "tools": {"listChanged": true}, "resources": {"listChanged": true} }, "serverInfo": { "name": "matcha", "version": SERVER_VERSION } })
}

const fn decode_message(error: DecodeError) -> &'static str {
    match error {
        DecodeError::MalformedJson => PARSE_ERROR,
        DecodeError::HeaderTooLarge
        | DecodeError::BodyTooLarge
        | DecodeError::MalformedHeader
        | DecodeError::InvalidRequest => INVALID_REQUEST,
    }
}

const fn invalid_params() -> (i32, &'static str) {
    (-32602, INVALID_PARAMS)
}
const fn internal_error() -> (i32, &'static str) {
    (-32603, INTERNAL_ERROR)
}
