use serde_json::Value;

use crate::ProviderApiProtocol;

/// Per-call evidence; does not change the legacy response/event contract.
#[derive(Default)]
pub(crate) struct Observation {
    pub actual_model: Option<String>,
    pub remote_revision: Option<String>,
    pub remote_call_reference: Option<String>,
    pub status: Option<u16>,
    pub retry_after: Option<String>,
    pub failure: Option<RemoteFailure>,
    pub usage: Option<super::LlmUsage>,
    pub finish_reason: Option<super::LlmFinishReason>,
    pub refused: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum RemoteFailure {
    Authentication,
    Permission,
    RateLimit,
    Rejected,
    Unavailable,
    Refused,
    Unrecognized,
}

impl Observation {
    pub fn headers(&mut self, response: &reqwest::Response) {
        self.status = Some(response.status().as_u16());
        self.retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 128)
            .map(str::to_owned);
        self.remote_call_reference = ["x-request-id", "request-id"]
            .into_iter()
            .find_map(|name| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
            })
            .map(platform::trace::identifier_hash);
    }

    pub fn payload(&mut self, protocol: ProviderApiProtocol, payload: &Value) {
        let body = match protocol {
            ProviderApiProtocol::AnthropicMessages => payload.get("message").unwrap_or(payload),
            ProviderApiProtocol::OpenAiResponses => payload.get("response").unwrap_or(payload),
            _ => payload,
        };
        let finish = match protocol {
            ProviderApiProtocol::OpenAiCompletions => body
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                .map(super::openai_chat::map_finish_reason),
            ProviderApiProtocol::OpenAiResponses => {
                super::openai_responses::extract_finish_reason(body)
            }
            ProviderApiProtocol::AnthropicMessages => body
                .get("stop_reason")
                .or_else(|| payload.pointer("/delta/stop_reason"))
                .and_then(Value::as_str)
                .map(super::anthropic::map_stop_reason),
            ProviderApiProtocol::GoogleGenerativeAi => None,
        };
        if finish.is_some() {
            self.finish_reason = finish;
        }
        if let Some(model) = safe_token(body.get("model")) {
            self.actual_model = Some(model);
        }
        if let Some(revision) = safe_token(body.get("system_fingerprint")) {
            self.remote_revision = Some(revision);
        }
        if self.remote_call_reference.is_none() {
            self.remote_call_reference = body
                .get("id")
                .and_then(Value::as_str)
                .map(platform::trace::identifier_hash);
        }
        if let Some(usage) = body.get("usage") {
            let number = |name| {
                usage
                    .get(name)
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
            };
            let next = match protocol {
                ProviderApiProtocol::OpenAiCompletions => super::LlmUsage {
                    input_tokens: number("prompt_tokens"),
                    output_tokens: number("completion_tokens"),
                    total_tokens: number("total_tokens"),
                },
                _ => super::LlmUsage {
                    input_tokens: number("input_tokens"),
                    output_tokens: number("output_tokens"),
                    total_tokens: number("total_tokens"),
                },
            };
            self.usage = Some(match self.usage {
                Some(previous) => super::LlmUsage {
                    input_tokens: next.input_tokens.or(previous.input_tokens),
                    output_tokens: next.output_tokens.or(previous.output_tokens),
                    total_tokens: next.total_tokens.or(previous.total_tokens),
                },
                None => next,
            });
        }
        self.refused |= body
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    choice
                        .pointer("/message/refusal")
                        .or_else(|| choice.pointer("/delta/refusal"))
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.is_empty())
                })
            })
            || body
                .get("output")
                .and_then(Value::as_array)
                .is_some_and(|output| {
                    output.iter().any(|item| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .is_some_and(|content| {
                                content.iter().any(|part| {
                                    part.get("type").and_then(Value::as_str) == Some("refusal")
                                })
                            })
                    })
                })
            || payload.get("type").and_then(Value::as_str) == Some("response.refusal.delta");
        let error = body
            .get("error")
            .filter(|error| !error.is_null())
            .or_else(|| payload.get("error").filter(|error| !error.is_null()))
            .or_else(|| {
                (payload.get("type").and_then(Value::as_str) == Some("error")).then_some(payload)
            });
        if let Some(error) = error {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .or_else(|| error.get("type").and_then(Value::as_str));
            self.failure = Some(match (protocol, code) {
                (ProviderApiProtocol::AnthropicMessages, Some("authentication_error"))
                | (_, Some("invalid_api_key" | "authentication_error")) => {
                    RemoteFailure::Authentication
                }
                (_, Some("permission_error" | "permission_denied")) => RemoteFailure::Permission,
                (_, Some("rate_limit_error" | "rate_limit_exceeded" | "insufficient_quota")) => {
                    RemoteFailure::RateLimit
                }
                (
                    _,
                    Some(
                        "invalid_request_error"
                        | "not_found_error"
                        | "model_not_found"
                        | "context_length_exceeded",
                    ),
                ) => RemoteFailure::Rejected,
                (_, Some("overloaded_error" | "api_error" | "server_error")) => {
                    RemoteFailure::Unavailable
                }
                (_, Some("content_policy_violation")) => RemoteFailure::Refused,
                _ => RemoteFailure::Unrecognized,
            });
        } else if body.get("status").and_then(Value::as_str) == Some("failed") {
            self.failure = Some(RemoteFailure::Unrecognized);
        }
    }
}

fn safe_token(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 512
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:/@+".contains(&byte))
        })
        .map(str::to_owned)
}
