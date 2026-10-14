use std::{future::Future, io, pin::Pin, sync::Arc};

use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    task::{AbortHandle, Id, JoinError, JoinSet},
};

use super::{
    DecodeError, Framing, RequestId, decode_request, detect_framing, encode_error, encode_result,
};
use crate::mcp::arguments::{require_exact_keys, required_string, strict_object};

const SERVER_VERSION: &str = "0.0.0";
const INVALID_REQUEST: &str = "Invalid Request";
const PARSE_ERROR: &str = "Parse error";
const METHOD_NOT_FOUND: &str = "Method not found";
const INVALID_PARAMS: &str = "Invalid params";
const INTERNAL_ERROR: &str = "Internal error";
const MAX_IN_FLIGHT: usize = 32;

pub trait ToolProvider: Send + Sync {
    fn tools(&self) -> Vec<Value>;
    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> Option<ToolCallFuture<'a>>;
}

pub type ToolCallOutcome = Result<Value, ToolCallError>;
pub type ToolCallFuture<'a> = Pin<Box<dyn Future<Output = ToolCallOutcome> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolCallError {
    InvalidParams,
    Internal,
    Execution(Value),
}

pub struct ToolCatalog {
    providers: Vec<Box<dyn ToolProvider>>,
}

impl ToolCatalog {
    pub fn new(providers: Vec<Box<dyn ToolProvider>>) -> Self {
        Self { providers }
    }

    fn tools(&self) -> Vec<Value> {
        self.providers
            .iter()
            .flat_map(|provider| provider.tools())
            .collect()
    }

    async fn call(&self, name: &str, arguments: &Map<String, Value>) -> ToolCallOutcome {
        for provider in &self.providers {
            if let Some(result) = provider.call(name, arguments) {
                return result.await;
            }
        }
        Err(ToolCallError::InvalidParams)
    }
}

pub async fn run_stdio<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    catalog: ToolCatalog,
    input: R,
    mut output: W,
) -> io::Result<()> {
    let mut calls = JoinSet::new();
    let result = Server {
        catalog: Arc::new(catalog),
    }
    .run(input, &mut output, &mut calls)
    .await;
    // Transport failure ends MCP waits, not effects already admitted by the Host owner.
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    result
}

struct Server {
    catalog: Arc<ToolCatalog>,
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
        loop {
            while let Some(completed) = calls.try_join_next_with_id() {
                complete_call(completed, &mut pending, output).await?;
            }
            if let Some((framing, payload, consumed)) = next_message(&buffer, eof) {
                buffer.drain(..consumed);
                let response = match payload {
                    Ok(payload) => {
                        self.handle_payload(payload, framing.clone(), calls, &mut pending)
                    }
                    Err(error) => encode_error(
                        Some(&RequestId::Null),
                        error.json_rpc_error_code(),
                        decode_message(error),
                    ),
                };
                if let Some(response) = response {
                    write_response(output, framing, &response).await?;
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
            }
        }
    }

    fn handle_payload(
        &self,
        payload: Vec<u8>,
        framing: Framing,
        calls: &mut JoinSet<Option<Vec<u8>>>,
        pending: &mut Vec<PendingCall>,
    ) -> Option<Vec<u8>> {
        let request = match decode_request(&payload) {
            Ok(request) => request,
            Err(error) => {
                let id = extract_request_id(&payload);
                return encode_error(
                    id.as_ref(),
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
            "initialize" => Ok(initialize_result()),
            "notifications/initialized" => Ok(Value::Null),
            "tools/list" => Ok(json!({ "tools": self.catalog.tools() })),
            "tools/call" => {
                if calls.len() == MAX_IN_FLIGHT {
                    return encode_error(request.id(), -32000, "Server busy");
                }
                let catalog = Arc::clone(&self.catalog);
                let request_id = request.id().cloned();
                let task = calls.spawn(async move {
                    match call_tool(&catalog, request.params()).await {
                        Ok(value) => encode_result(request.id(), value),
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
        write_response(output, call.framing, &response).await?;
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

async fn call_tool(
    catalog: &ToolCatalog,
    params: Option<&Value>,
) -> Result<Value, (i32, &'static str)> {
    let params = strict_object(params).map_err(|_| invalid_params())?;
    require_exact_keys(params, &["name", "arguments"]).map_err(|_| invalid_params())?;
    let name = required_string(params, "name").map_err(|_| invalid_params())?;
    let arguments = strict_object(params.get("arguments")).map_err(|_| invalid_params())?;
    let (result, is_error) = match catalog.call(name, arguments).await {
        Ok(result) => (result, false),
        Err(ToolCallError::Execution(result)) => (result, true),
        Err(ToolCallError::InvalidParams) => return Err(invalid_params()),
        Err(ToolCallError::Internal) => return Err(internal_error()),
    };
    let mut response = json!({
        "content": [{ "type": "text", "text": serde_json::to_string(&result).expect("closed MCP result is serializable") }]
    });
    if is_error {
        response["isError"] = Value::Bool(true);
    }
    Ok(response)
}

fn next_message(
    buffer: &[u8],
    eof: bool,
) -> Option<(Framing, Result<Vec<u8>, DecodeError>, usize)> {
    let framing = match detect_framing(buffer) {
        Ok(Some(framing)) => framing,
        Ok(None) => {
            return eof
                .then_some((
                    Framing::JsonLines,
                    Err(DecodeError::MalformedHeader),
                    buffer.len(),
                ))
                .filter(|_| !buffer.is_empty());
        }
        Err(error) => return Some((Framing::JsonLines, Err(error), buffer.len())),
    };
    match framing {
        Framing::JsonLines => match buffer.iter().position(|byte| *byte == b'\n') {
            Some(end) => Some((
                Framing::JsonLines,
                Ok(trim_line(&buffer[..end]).to_vec()),
                end + 1,
            )),
            None if eof => Some((
                Framing::JsonLines,
                Ok(trim_line(buffer).to_vec()),
                buffer.len(),
            )),
            None => None,
        },
        Framing::ContentLength { body_bytes } => {
            let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")? + 4;
            let total = header_end.checked_add(body_bytes)?;
            if buffer.len() < total {
                return eof.then_some((framing, Err(DecodeError::MalformedJson), buffer.len()));
            }
            Some((framing, Ok(buffer[header_end..total].to_vec()), total))
        }
    }
}

fn trim_line(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn extract_request_id(payload: &[u8]) -> Option<RequestId> {
    let value = serde_json::from_slice::<Value>(payload).ok()?;
    match value.as_object()?.get("id")? {
        Value::Null => Some(RequestId::Null),
        Value::String(value) => Some(RequestId::String(value.clone())),
        Value::Number(value) => Some(RequestId::Number(value.clone())),
        _ => None,
    }
}

async fn write_response<W: AsyncWrite + Unpin>(
    output: &mut W,
    framing: Framing,
    response: &[u8],
) -> io::Result<()> {
    match framing {
        Framing::JsonLines => {
            output.write_all(response).await?;
            output.write_all(b"\n").await?;
        }
        Framing::ContentLength { .. } => {
            let header = format!("Content-Length: {}\r\n\r\n", response.len());
            output.write_all(header.as_bytes()).await?;
            output.write_all(response).await?;
        }
    }
    output.flush().await
}

fn initialize_result() -> Value {
    json!({ "protocolVersion": "2024-11-05", "capabilities": { "tools": {} }, "serverInfo": { "name": "matcha", "version": SERVER_VERSION } })
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
