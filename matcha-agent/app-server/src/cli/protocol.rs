use crate::rpc;
use serde_json::{Value, json};

pub enum NativeMessage {
    Result(Value),
    ControlRequest { request_id: String, request: Value },
    ControlResponse { request_id: String, response: Value },
    ControlCancel { request_id: String },
    Message(Value),
}

pub fn decode(bytes: &[u8]) -> rpc::Result<NativeMessage> {
    let mut message: Value = serde_json::from_slice(bytes).map_err(|error| {
        rpc::Error::new(
            -32004,
            if error.is_eof() {
                "native_json_incomplete"
            } else {
                "native_json_invalid"
            },
            "Native CLI output is not a complete JSON message",
        )
        .with_data(json!({ "line": error.line(), "column": error.column() }))
        .with_source(error)
    })?;
    if !message.is_object() {
        return Err(field_error("message", "invalid"));
    }
    match text(&message, "type", "message_type")? {
        "control_request" => {
            let request_id = text(&message, "request_id", "control_request_request_id")?.to_owned();
            check(
                &message,
                "request",
                "control_request_request",
                Value::is_object,
            )?;
            let request = &message["request"];
            match text(request, "subtype", "control_request_subtype")? {
                "can_use_tool" => {
                    text(request, "tool_name", "can_use_tool_tool_name")?;
                    text(request, "tool_use_id", "can_use_tool_tool_use_id")?;
                    check(request, "input", "can_use_tool_input", Value::is_object)?;
                }
                "hook_callback" => {
                    text(request, "callback_id", "hook_callback_callback_id")?;
                    check(request, "input", "hook_callback_input", Value::is_object)?;
                }
                "elicitation" => {
                    text(request, "mcp_server_name", "elicitation_mcp_server_name")?;
                    text(request, "message", "elicitation_message")?;
                }
                _ => {}
            }
            Ok(NativeMessage::ControlRequest {
                request_id,
                request: message["request"].take(),
            })
        }
        "control_response" => {
            check(
                &message,
                "response",
                "control_response_response",
                Value::is_object,
            )?;
            let response = &message["response"];
            let request_id =
                text(response, "request_id", "control_response_request_id")?.to_owned();
            match text(response, "subtype", "control_response_subtype")? {
                "success" => {
                    if response.get("response").is_some() {
                        check(
                            response,
                            "response",
                            "control_response_payload",
                            Value::is_object,
                        )?;
                    }
                }
                "error" => {
                    text(response, "error", "control_response_error")?;
                    if response.get("pending_permission_requests").is_some() {
                        check(
                            response,
                            "pending_permission_requests",
                            "control_response_pending_permission_requests",
                            Value::is_array,
                        )?;
                    }
                }
                _ => return Ok(NativeMessage::Message(message)),
            }
            // Keep the inner envelope: its subtype distinguishes an ACK from an error.
            Ok(NativeMessage::ControlResponse {
                request_id,
                response: message["response"].take(),
            })
        }
        "control_cancel_request" => Ok(NativeMessage::ControlCancel {
            request_id: text(&message, "request_id", "control_cancel_request_id")?.to_owned(),
        }),
        "result" => {
            match text(&message, "subtype", "result_subtype")? {
                "success" => {
                    text(&message, "result", "result_result")?;
                }
                "error_during_execution"
                | "error_max_turns"
                | "error_max_budget_usd"
                | "error_max_structured_output_retries" => {
                    check(&message, "errors", "result_errors", |value| {
                        value
                            .as_array()
                            .is_some_and(|errors| errors.iter().all(Value::is_string))
                    })?;
                }
                _ => return Ok(NativeMessage::Message(message)),
            }
            check(&message, "is_error", "result_is_error", Value::is_boolean)?;
            text(&message, "session_id", "result_session_id")?;
            text(&message, "uuid", "result_uuid")?;
            for name in [
                "duration_ms",
                "duration_api_ms",
                "num_turns",
                "total_cost_usd",
            ] {
                check(&message, name, &format!("result_{name}"), Value::is_number)?;
            }
            check(&message, "stop_reason", "result_stop_reason", |value| {
                value.is_null() || value.is_string()
            })?;
            check(&message, "usage", "result_usage", Value::is_object)?;
            check(
                &message,
                "modelUsage",
                "result_model_usage",
                Value::is_object,
            )?;
            check(
                &message,
                "permission_denials",
                "result_permission_denials",
                Value::is_array,
            )?;
            // A result is a turn observation, not an OS exit; success may still have is_error=true.
            Ok(NativeMessage::Result(message))
        }
        "user" => {
            check(&message, "message", "user_message", Value::is_object)?;
            let user = &message["message"];
            if text(user, "role", "user_message_role")? != "user" {
                return Err(field_error("user_message_role", "invalid"));
            }
            check(user, "content", "user_message_content", |value| {
                value.is_string()
                    || value.as_array().is_some_and(|blocks| {
                        blocks
                            .iter()
                            .all(|block| block.get("type").is_some_and(Value::is_string))
                    })
            })?;
            check(
                &message,
                "parent_tool_use_id",
                "user_parent_tool_use_id",
                |value| value.is_null() || value.is_string(),
            )?;
            for name in ["uuid", "session_id"] {
                if message.get(name).is_some() {
                    text(&message, name, &format!("user_{name}"))?;
                }
            }
            Ok(NativeMessage::Message(message))
        }
        _ => Ok(NativeMessage::Message(message)),
    }
}

/// Content is a native string or content-block array, never a prompt control request.
pub fn user_message(session_id: &str, message_id: &str, content: Value) -> Value {
    json!({
        "type": "user",
        "session_id": session_id,
        "uuid": message_id,
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null,
    })
}

pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": request })
}

/// Expects an inner {subtype:"success",response?:object} or {subtype:"error",error:string} envelope.
pub fn control_response(request_id: &str, mut response: Value) -> Value {
    response["request_id"] = Value::String(request_id.to_owned());
    json!({ "type": "control_response", "response": response })
}

fn required<'a>(value: &'a Value, name: &str, field: &str) -> rpc::Result<&'a Value> {
    value.get(name).ok_or_else(|| field_error(field, "missing"))
}

fn text<'a>(value: &'a Value, name: &str, field: &str) -> rpc::Result<&'a str> {
    required(value, name, field)?
        .as_str()
        .ok_or_else(|| field_error(field, "invalid"))
}

fn check(value: &Value, name: &str, field: &str, valid: fn(&Value) -> bool) -> rpc::Result<()> {
    if valid(required(value, name, field)?) {
        Ok(())
    } else {
        Err(field_error(field, "invalid"))
    }
}

fn field_error(field: &str, reason: &str) -> rpc::Error {
    rpc::Error::new(
        -32004,
        &format!("native_{field}_{reason}"),
        format!("Native CLI message field is {reason}: {field}"),
    )
}
