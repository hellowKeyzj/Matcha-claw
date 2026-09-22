use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_HEADER_BYTES: usize = 8 * 1024;
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeError {
    HeaderTooLarge,
    BodyTooLarge,
    MalformedHeader,
    MalformedJson,
    InvalidRequest,
}

impl DecodeError {
    pub const fn json_rpc_error_code(self) -> i32 {
        match self {
            Self::MalformedJson => -32700,
            Self::HeaderTooLarge
            | Self::BodyTooLarge
            | Self::MalformedHeader
            | Self::InvalidRequest => -32600,
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HeaderTooLarge => "MCP header exceeds its fixed size limit",
            Self::BodyTooLarge => "MCP body exceeds its fixed size limit",
            Self::MalformedHeader => "MCP Content-Length header is invalid",
            Self::MalformedJson => "MCP JSON-RPC payload is malformed",
            Self::InvalidRequest => "MCP JSON-RPC request is invalid",
        })
    }
}

impl std::error::Error for DecodeError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Framing {
    JsonLines,
    ContentLength { body_bytes: usize },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    id: Option<RequestId>,
    method: String,
    params: Option<Value>,
}

impl Request {
    pub fn id(&self) -> Option<&RequestId> {
        self.id.as_ref()
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn params(&self) -> Option<&Value> {
        self.params.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Null,
    Number(serde_json::Number),
    String(String),
}

pub fn detect_framing(input: &[u8]) -> Result<Option<Framing>, DecodeError> {
    let Some(first) = input
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
    else {
        return Ok(None);
    };
    if first == b'{' {
        return Ok(Some(Framing::JsonLines));
    }

    let Some(header_end) = input.windows(4).position(|window| window == b"\r\n\r\n") else {
        return if input.len() > MAX_HEADER_BYTES {
            Err(DecodeError::HeaderTooLarge)
        } else {
            Ok(None)
        };
    };
    let header_bytes = header_end + 4;
    if header_bytes > MAX_HEADER_BYTES {
        return Err(DecodeError::HeaderTooLarge);
    }

    let header =
        std::str::from_utf8(&input[..header_end]).map_err(|_| DecodeError::MalformedHeader)?;
    let mut content_length = None;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            return Err(DecodeError::MalformedHeader);
        };
        if name.eq_ignore_ascii_case("content-length")
            && content_length
                .replace(value.trim().parse::<usize>())
                .is_some()
        {
            return Err(DecodeError::MalformedHeader);
        }
    }
    let Some(Ok(body_bytes)) = content_length else {
        return Err(DecodeError::MalformedHeader);
    };
    if body_bytes > MAX_BODY_BYTES {
        return Err(DecodeError::BodyTooLarge);
    }
    Ok(Some(Framing::ContentLength { body_bytes }))
}

pub fn decode_request(payload: &[u8]) -> Result<Request, DecodeError> {
    let value = serde_json::from_slice::<Value>(payload).map_err(|_| DecodeError::MalformedJson)?;
    let Value::Object(mut object) = value else {
        return Err(DecodeError::InvalidRequest);
    };
    if object
        .remove("jsonrpc")
        .and_then(|value| value.as_str().map(str::to_owned))
        .as_deref()
        != Some("2.0")
    {
        return Err(DecodeError::InvalidRequest);
    }
    let method = object
        .remove("method")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|method| !method.is_empty())
        .ok_or(DecodeError::InvalidRequest)?;
    let id = match object.remove("id") {
        None => None,
        Some(Value::Null) => Some(RequestId::Null),
        Some(Value::String(id)) => Some(RequestId::String(id)),
        Some(Value::Number(id)) => Some(RequestId::Number(id)),
        Some(_) => return Err(DecodeError::InvalidRequest),
    };
    let params = object.remove("params");
    if !object.is_empty() {
        return Err(DecodeError::InvalidRequest);
    }
    Ok(Request { id, method, params })
}

pub fn encode_result(id: Option<&RequestId>, result: Value) -> Option<Vec<u8>> {
    id.map(|id| encode_message(id, "result", result))
}

pub fn encode_error(id: Option<&RequestId>, code: i32, message: &'static str) -> Option<Vec<u8>> {
    id.map(|id| {
        encode_message(
            id,
            "error",
            Value::Object(Map::from_iter([
                ("code".to_owned(), Value::Number(code.into())),
                ("message".to_owned(), Value::String(message.to_owned())),
            ])),
        )
    })
}

fn encode_message(id: &RequestId, member: &'static str, payload: Value) -> Vec<u8> {
    let mut object = Map::new();
    object.insert("jsonrpc".to_owned(), Value::String("2.0".to_owned()));
    object.insert(
        "id".to_owned(),
        serde_json::to_value(id).expect("MCP request ids are JSON serializable"),
    );
    object.insert(member.to_owned(), payload);
    serde_json::to_vec(&Value::Object(object)).expect("MCP JSON-RPC responses are serializable")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn detects_json_lines_from_the_first_non_whitespace_byte() {
        assert_eq!(
            detect_framing(b"\n {\"jsonrpc\":\"2.0\"}"),
            Ok(Some(Framing::JsonLines))
        );
    }

    #[test]
    fn waits_for_a_complete_content_length_header() {
        assert_eq!(detect_framing(b"Content-Length: 12\r\n"), Ok(None));
    }

    #[test]
    fn detects_a_bounded_content_length_body() {
        assert_eq!(
            detect_framing(b"Content-Length: 12\r\n\r\n{\"jsonrpc\"}"),
            Ok(Some(Framing::ContentLength { body_bytes: 12 }))
        );
    }

    #[test]
    fn rejects_headers_without_one_content_length() {
        assert_eq!(
            detect_framing(b"Content-Type: application/json\r\n\r\n"),
            Err(DecodeError::MalformedHeader)
        );
        assert_eq!(
            detect_framing(b"Content-Length: 1\r\nContent-Length: 1\r\n\r\n"),
            Err(DecodeError::MalformedHeader)
        );
    }

    #[test]
    fn rejects_bodies_above_the_fixed_limit() {
        assert_eq!(
            detect_framing(format!("Content-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1).as_bytes()),
            Err(DecodeError::BodyTooLarge)
        );
    }

    #[test]
    fn decodes_only_json_rpc_requests() {
        let request = decode_request(
            br#"{"jsonrpc":"2.0","id":"request-1","method":"tools/list","params":{}}"#,
        )
        .unwrap();

        assert_eq!(
            request.id(),
            Some(&RequestId::String("request-1".to_owned()))
        );
        assert_eq!(request.method(), "tools/list");
        assert_eq!(request.params(), Some(&json!({})));
        assert_eq!(
            decode_request(br#"{"jsonrpc":"2.0","method":"tools/list","extra":true}"#),
            Err(DecodeError::InvalidRequest)
        );
        assert_eq!(decode_request(b"{"), Err(DecodeError::MalformedJson));
    }

    #[test]
    fn notifications_never_produce_responses() {
        assert_eq!(encode_result(None, json!({})), None);
        assert_eq!(encode_error(None, -32600, "Invalid Request"), None);
    }

    #[test]
    fn retains_null_and_fractional_request_ids() {
        let null = decode_request(br#"{"jsonrpc":"2.0","id":null,"method":"initialize"}"#).unwrap();
        let fractional =
            decode_request(br#"{"jsonrpc":"2.0","id":1.5,"method":"initialize"}"#).unwrap();

        assert_eq!(null.id(), Some(&RequestId::Null));
        assert_eq!(
            fractional.id(),
            Some(&RequestId::Number(
                serde_json::Number::from_f64(1.5).unwrap()
            ))
        );
    }

    #[test]
    fn encodes_closed_result_and_error_envelopes() {
        assert_eq!(
            String::from_utf8(
                encode_result(
                    Some(&RequestId::Number(serde_json::Number::from(1))),
                    json!({"tools": []})
                )
                .unwrap(),
            )
            .unwrap(),
            r#"{"id":1,"jsonrpc":"2.0","result":{"tools":[]}}"#
        );
        assert_eq!(
            String::from_utf8(
                encode_error(
                    Some(&RequestId::String("request-1".to_owned())),
                    -32602,
                    "Invalid params"
                )
                .unwrap()
            )
            .unwrap(),
            r#"{"error":{"code":-32602,"message":"Invalid params"},"id":"request-1","jsonrpc":"2.0"}"#
        );
    }
}
