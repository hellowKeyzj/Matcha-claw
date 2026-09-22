use std::io::{self, BufRead, Write};

use serde_json::{Map, Value, json};

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

pub trait ToolProvider {
    fn tools(&self) -> Vec<Value>;
    fn call(&mut self, name: &str, arguments: &Map<String, Value>) -> Option<ToolCallOutcome>;
}

pub type ToolCallOutcome = Result<Value, ToolCallError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolCallError {
    InvalidParams,
    Internal,
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

    fn call(&mut self, name: &str, arguments: &Map<String, Value>) -> ToolCallOutcome {
        for provider in &mut self.providers {
            if let Some(result) = provider.call(name, arguments) {
                return result;
            }
        }
        Err(ToolCallError::InvalidParams)
    }
}

pub fn run_stdio<R: BufRead, W: Write>(
    catalog: ToolCatalog,
    input: R,
    output: W,
) -> io::Result<()> {
    Server { catalog }.run(input, output)
}

struct Server {
    catalog: ToolCatalog,
}

impl Server {
    fn run<R: BufRead, W: Write>(&mut self, mut input: R, mut output: W) -> io::Result<()> {
        let mut buffer = Vec::new();
        loop {
            let mut chunk = [0_u8; 8192];
            let read = input.read(&mut chunk)?;
            if read == 0 {
                self.drain(&mut buffer, &mut output, true)?;
                return Ok(());
            }
            buffer.extend_from_slice(&chunk[..read]);
            self.drain(&mut buffer, &mut output, false)?;
        }
    }

    fn drain<W: Write>(
        &mut self,
        buffer: &mut Vec<u8>,
        output: &mut W,
        eof: bool,
    ) -> io::Result<()> {
        while let Some((framing, payload, consumed)) = next_message(buffer, eof) {
            buffer.drain(..consumed);
            let response = match payload {
                Ok(payload) => self.handle_payload(payload),
                Err(error) => encode_error(
                    Some(&RequestId::Null),
                    error.json_rpc_error_code(),
                    decode_message(error),
                ),
            };
            if let Some(response) = response {
                write_response(output, framing, &response)?;
            }
        }
        Ok(())
    }

    fn handle_payload(&mut self, payload: Vec<u8>) -> Option<Vec<u8>> {
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
        let result = match request.method() {
            "initialize" => Ok(initialize_result()),
            "notifications/initialized" => Ok(Value::Null),
            "tools/list" => Ok(json!({ "tools": self.catalog.tools() })),
            "tools/call" => self.call_tool(request.params()),
            _ => Err((-32601, METHOD_NOT_FOUND)),
        };
        match result {
            Ok(value) => encode_result(request.id(), value),
            Err((code, message)) => encode_error(request.id(), code, message),
        }
    }

    fn call_tool(&mut self, params: Option<&Value>) -> Result<Value, (i32, &'static str)> {
        let params = strict_object(params).map_err(|_| invalid_params())?;
        require_exact_keys(params, &["name", "arguments"]).map_err(|_| invalid_params())?;
        let name = required_string(params, "name").map_err(|_| invalid_params())?;
        let arguments = strict_object(params.get("arguments")).map_err(|_| invalid_params())?;
        let result = self
            .catalog
            .call(name, arguments)
            .map_err(map_tool_call_error)?;
        Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string(&result).expect("closed MCP result is serializable") }]
        }))
    }
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

fn write_response<W: Write>(output: &mut W, framing: Framing, response: &[u8]) -> io::Result<()> {
    match framing {
        Framing::JsonLines => {
            output.write_all(response)?;
            output.write_all(b"\n")?;
        }
        Framing::ContentLength { .. } => {
            write!(output, "Content-Length: {}\r\n\r\n", response.len())?;
            output.write_all(response)?;
        }
    }
    output.flush()
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

const fn map_tool_call_error(error: ToolCallError) -> (i32, &'static str) {
    match error {
        ToolCallError::InvalidParams => invalid_params(),
        ToolCallError::Internal => internal_error(),
    }
}

const fn invalid_params() -> (i32, &'static str) {
    (-32602, INVALID_PARAMS)
}
const fn internal_error() -> (i32, &'static str) {
    (-32603, INTERNAL_ERROR)
}
