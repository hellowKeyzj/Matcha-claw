use std::{future::Future, pin::Pin};

use serde_json::Value;
use sha2::{Digest, Sha256};

const TEAM_MESSAGE_OPEN: &str = "<team_message>";
const TEAM_MESSAGE_CLOSE: &str = "</team_message>";
pub const MAX_REPAIR_ATTEMPTS: usize = 3;

type TeamMessageRepairFuture<'a> = Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TeamMessage {
    summary: String,
    output_port: String,
    payload: Value,
    outcome: Option<String>,
    status: Option<String>,
}

impl TeamMessage {
    pub(crate) fn summary(&self) -> &str {
        &self.summary
    }

    pub(crate) fn output_port(&self) -> &str {
        &self.output_port
    }

    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }

    pub(crate) fn outcome(&self) -> Option<&str> {
        self.outcome.as_deref()
    }

    pub(crate) fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageError {
    MissingEnvelope,
    Json(String),
    ErrorList(Vec<TeamMessageValidationError>),
}

impl TeamMessageError {
    fn repair_errors(&self) -> Vec<String> {
        match self {
            Self::MissingEnvelope => {
                vec!["missing <team_message>...</team_message> envelope".to_owned()]
            }
            Self::Json(error) => vec![format!("invalid JSON: {error}")],
            Self::ErrorList(errors) => errors.iter().map(ToString::to_string).collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageValidationError {
    RootNotObject,
    MissingField(&'static str),
    UnexpectedField(String),
    FieldType {
        field: &'static str,
        expected: &'static str,
    },
    EmptyString(&'static str),
    StringTooLong {
        field: &'static str,
        max: usize,
    },
    ControlCharacter(&'static str),
    UnsafeOutputPort,
}

impl std::fmt::Display for TeamMessageValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RootNotObject => write!(formatter, "root must be a JSON object"),
            Self::MissingField(field) => write!(formatter, "missing required field `{field}`"),
            Self::UnexpectedField(field) => write!(formatter, "unexpected field `{field}`"),
            Self::FieldType { field, expected } => {
                write!(formatter, "field `{field}` must be {expected}")
            }
            Self::EmptyString(field) => write!(formatter, "field `{field}` must not be empty"),
            Self::StringTooLong { field, max } => {
                write!(
                    formatter,
                    "field `{field}` must be at most {max} characters"
                )
            }
            Self::ControlCharacter(field) => {
                write!(
                    formatter,
                    "field `{field}` must not contain control characters"
                )
            }
            Self::UnsafeOutputPort => write!(
                formatter,
                "field `output_port` must contain only ASCII graphic characters except `/` or `\\`"
            ),
        }
    }
}

pub(crate) fn extract_last_team_message(text: &str) -> Result<&str, TeamMessageError> {
    let close = text
        .rfind(TEAM_MESSAGE_CLOSE)
        .ok_or(TeamMessageError::MissingEnvelope)?;
    let before_close = &text[..close];
    let open = before_close
        .rfind(TEAM_MESSAGE_OPEN)
        .ok_or(TeamMessageError::MissingEnvelope)?;
    Ok(&before_close[open + TEAM_MESSAGE_OPEN.len()..])
}

pub(crate) fn parse_team_message(text: &str) -> Result<TeamMessage, TeamMessageError> {
    let json = extract_last_team_message(text)?;
    let value = serde_json::from_str::<Value>(json.trim())
        .map_err(|error| TeamMessageError::Json(error.to_string()))?;
    validate_team_message(&value)
}

fn parse_or_normalize_team_message_text(text: &str) -> Result<String, TeamMessageError> {
    match parse_team_message(text) {
        Ok(_) => return Ok(text.to_owned()),
        Err(TeamMessageError::MissingEnvelope) => {}
        Err(error) => return Err(error),
    }
    let Some(json) = text
        .get(text.find('{').ok_or(TeamMessageError::MissingEnvelope)?..)
        .and_then(|suffix| suffix.get(..suffix.rfind('}')? + 1))
    else {
        return Err(TeamMessageError::MissingEnvelope);
    };
    let value = serde_json::from_str::<Value>(json.trim())
        .map_err(|error| TeamMessageError::Json(error.to_string()))?;
    validate_team_message(&value)?;
    Ok(format!(
        "{TEAM_MESSAGE_OPEN}{}{TEAM_MESSAGE_CLOSE}",
        json.trim()
    ))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMessageTerminalContext {
    run_id: organization::GraphRunId,
    delivery_id: organization::DeliveryId,
    endpoint_session_id: organization::EndpointSessionId,
}

impl TeamMessageTerminalContext {
    pub(crate) fn new(
        run_id: organization::GraphRunId,
        delivery_id: organization::DeliveryId,
        endpoint_session_id: organization::EndpointSessionId,
    ) -> Self {
        Self {
            run_id,
            delivery_id,
            endpoint_session_id,
        }
    }

    pub fn run_id(&self) -> &organization::GraphRunId {
        &self.run_id
    }

    pub fn delivery_id(&self) -> &organization::DeliveryId {
        &self.delivery_id
    }

    pub fn endpoint_session_id(&self) -> &organization::EndpointSessionId {
        &self.endpoint_session_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMessageRepairDispatch {
    attempt: usize,
    requested_run_id: String,
    endpoint_session_id: organization::EndpointSessionId,
    prompt: String,
    last_invalid_output: String,
}

impl TeamMessageRepairDispatch {
    pub fn attempt(&self) -> usize {
        self.attempt
    }

    pub fn requested_run_id(&self) -> &str {
        &self.requested_run_id
    }

    pub fn endpoint_session_id(&self) -> &organization::EndpointSessionId {
        &self.endpoint_session_id
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn last_invalid_output(&self) -> &str {
        &self.last_invalid_output
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageTerminalPlan {
    Settle {
        final_assistant_text: Option<String>,
    },
    Repair(TeamMessageRepairDispatch),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageTerminalObservation {
    Ignored,
    Settled,
    Repair(TeamMessageRepairDispatch),
}

pub fn plan_team_message_terminal(
    context: &TeamMessageTerminalContext,
    attempt: usize,
    final_assistant_text: Option<String>,
) -> TeamMessageTerminalPlan {
    let Some(text) = final_assistant_text else {
        return TeamMessageTerminalPlan::Settle {
            final_assistant_text: None,
        };
    };
    match parse_or_normalize_team_message_text(&text) {
        Ok(normalized) => TeamMessageTerminalPlan::Settle {
            final_assistant_text: Some(normalized),
        },
        Err(error) if attempt < MAX_REPAIR_ATTEMPTS => {
            let next_attempt = attempt + 1;
            let prompt = build_team_message_repair_prompt(next_attempt, &text, &error);
            TeamMessageTerminalPlan::Repair(TeamMessageRepairDispatch {
                attempt: next_attempt,
                requested_run_id: team_message_repair_run_id(context.delivery_id(), next_attempt),
                endpoint_session_id: context.endpoint_session_id().clone(),
                prompt: prompt.as_str().to_owned(),
                last_invalid_output: text,
            })
        }
        Err(_) => TeamMessageTerminalPlan::Settle {
            final_assistant_text: Some(text),
        },
    }
}

fn team_message_repair_run_id(delivery_id: &organization::DeliveryId, attempt: usize) -> String {
    let mut digest = Sha256::new();
    digest.update(delivery_id.as_str().as_bytes());
    digest.update([0]);
    digest.update(attempt.to_le_bytes());
    format!("tmr-{:x}", digest.finalize())
}

pub(crate) fn validate_team_message(value: &Value) -> Result<TeamMessage, TeamMessageError> {
    let Some(object) = value.as_object() else {
        return Err(TeamMessageError::ErrorList(vec![
            TeamMessageValidationError::RootNotObject,
        ]));
    };
    let mut errors = Vec::new();
    for field in object.keys() {
        if !matches!(
            field.as_str(),
            "summary" | "output_port" | "payload" | "outcome" | "status"
        ) {
            errors.push(TeamMessageValidationError::UnexpectedField(field.clone()));
        }
    }
    let summary = required_string(object, "summary", &mut errors);
    let output_port = required_string(object, "output_port", &mut errors);
    if let Some(summary) = summary {
        validate_summary(summary, &mut errors);
    }
    if let Some(output_port) = output_port {
        validate_output_port(output_port, &mut errors);
    }
    let payload = object.get("payload").cloned().or_else(|| {
        errors.push(TeamMessageValidationError::MissingField("payload"));
        None
    });
    let outcome = optional_string(object, "outcome", &mut errors);
    let status = optional_string(object, "status", &mut errors);
    if !errors.is_empty() {
        return Err(TeamMessageError::ErrorList(errors));
    }
    Ok(TeamMessage {
        summary: summary.expect("validated summary is present").to_owned(),
        output_port: output_port
            .expect("validated output_port is present")
            .to_owned(),
        payload: payload.expect("validated payload is present"),
        outcome: outcome.map(str::to_owned),
        status: status.map(str::to_owned),
    })
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &'static str,
    errors: &mut Vec<TeamMessageValidationError>,
) -> Option<&'a str> {
    match object.get(field) {
        Some(Value::String(value)) if value.trim().is_empty() => {
            errors.push(TeamMessageValidationError::EmptyString(field));
            None
        }
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => {
            errors.push(TeamMessageValidationError::FieldType {
                field,
                expected: "a string",
            });
            None
        }
        None => {
            errors.push(TeamMessageValidationError::MissingField(field));
            None
        }
    }
}

fn validate_summary(summary: &str, errors: &mut Vec<TeamMessageValidationError>) {
    if summary.len() > 512 {
        errors.push(TeamMessageValidationError::StringTooLong {
            field: "summary",
            max: 512,
        });
    }
    if summary.chars().any(char::is_control) {
        errors.push(TeamMessageValidationError::ControlCharacter("summary"));
    }
}

fn validate_output_port(output_port: &str, errors: &mut Vec<TeamMessageValidationError>) {
    if !output_port
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
    {
        errors.push(TeamMessageValidationError::UnsafeOutputPort);
    }
}

fn optional_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &'static str,
    errors: &mut Vec<TeamMessageValidationError>,
) -> Option<&'a str> {
    match object.get(field) {
        Some(Value::String(value)) if value.trim().is_empty() => {
            errors.push(TeamMessageValidationError::EmptyString(field));
            None
        }
        Some(Value::String(value)) => Some(value.as_str()),
        Some(Value::Null) | None => None,
        Some(_) => {
            errors.push(TeamMessageValidationError::FieldType {
                field,
                expected: "a string or null",
            });
            None
        }
    }
}

pub(crate) trait TeamMessageRepairer {
    fn repair_team_message<'a>(
        &'a mut self,
        prompt: TeamMessageRepairPrompt<'a>,
    ) -> TeamMessageRepairFuture<'a>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMessageRepairPrompt<'a> {
    pub(crate) attempt: usize,
    pub(crate) max_attempts: usize,
    pub(crate) original_output: &'a str,
    pub(crate) errors: Vec<String>,
    pub(crate) correct_format: &'static str,
    prompt: String,
}

impl TeamMessageRepairPrompt<'_> {
    pub fn as_str(&self) -> &str {
        &self.prompt
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TeamMessageRepairOutcome {
    Valid(TeamMessage),
    Failed(TeamMessageError),
}

pub(crate) async fn parse_or_repair_team_message(
    original_output: &str,
    repairer: &mut impl TeamMessageRepairer,
) -> TeamMessageRepairOutcome {
    let mut candidate = original_output.to_owned();
    let mut error = match parse_team_message(&candidate) {
        Ok(message) => return TeamMessageRepairOutcome::Valid(message),
        Err(error) => error,
    };
    for attempt in 1..=MAX_REPAIR_ATTEMPTS {
        let prompt = build_team_message_repair_prompt(attempt, original_output, &error);
        let Some(repaired) = repairer.repair_team_message(prompt).await else {
            return TeamMessageRepairOutcome::Failed(error);
        };
        candidate = repaired;
        match parse_team_message(&candidate) {
            Ok(message) => return TeamMessageRepairOutcome::Valid(message),
            Err(next_error) => error = next_error,
        }
    }
    TeamMessageRepairOutcome::Failed(error)
}

fn build_team_message_repair_prompt<'a>(
    attempt: usize,
    original_output: &'a str,
    error: &TeamMessageError,
) -> TeamMessageRepairPrompt<'a> {
    let errors = error.repair_errors();
    let correct_format =
        r#"<team_message>{"summary":"...","output_port":"...","payload":{}}</team_message>"#;
    let prompt = format!(
        "Repair TeamRun node output (attempt {attempt}/{MAX_REPAIR_ATTEMPTS}).\n\
Do not call tools. Do not redo the task. Only output a valid <team_message> envelope.\n\
Original output:\n{original_output}\n\
Errors:\n{}\n\
Correct format:\n{correct_format}\n\
The JSON object must include non-empty string fields `summary` and `output_port`, and a `payload` field with any JSON value. Optional `outcome` and `status` must be non-empty strings if present.",
        errors.join("\n")
    );
    TeamMessageRepairPrompt {
        attempt,
        max_attempts: MAX_REPAIR_ATTEMPTS,
        original_output,
        errors,
        correct_format,
        prompt,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn multiple_envelopes_extracts_last() {
        let text = "noise <team_message>{\"summary\":\"old\",\"output_port\":\"x\",\"payload\":1}</team_message> tail <team_message>{\"summary\":\"new\",\"output_port\":\"done\",\"payload\":{\"ok\":true}}</team_message>";

        assert_eq!(
            extract_last_team_message(text).unwrap(),
            "{\"summary\":\"new\",\"output_port\":\"done\",\"payload\":{\"ok\":true}}"
        );
        assert_eq!(parse_team_message(text).unwrap().summary(), "new");
    }

    #[test]
    fn json_syntax_error_is_reported() {
        let error =
            parse_team_message("<team_message>{\"summary\":\"x\",\"output_port\":</team_message>")
                .unwrap_err();

        assert!(matches!(error, TeamMessageError::Json(_)));
    }

    #[test]
    fn schema_validation_collects_multiple_errors() {
        let error = validate_team_message(&json!({
            "summary": "bad\nsummary",
            "output_port": "bad/port",
            "outcome": false
        }))
        .unwrap_err();

        assert_eq!(
            error,
            TeamMessageError::ErrorList(vec![
                TeamMessageValidationError::ControlCharacter("summary"),
                TeamMessageValidationError::UnsafeOutputPort,
                TeamMessageValidationError::MissingField("payload"),
                TeamMessageValidationError::FieldType {
                    field: "outcome",
                    expected: "a string or null"
                },
            ])
        );
    }

    #[test]
    fn payload_accepts_dynamic_json() {
        let message = parse_team_message(
            "<team_message>{\"summary\":\"ok\",\"output_port\":\"review\",\"payload\":[1,{\"nested\":true}],\"status\":\"passed\"}</team_message>",
        )
        .unwrap();

        assert_eq!(message.output_port(), "review");
        assert_eq!(message.payload(), &json!([1, {"nested": true}]));
        assert_eq!(message.status(), Some("passed"));
    }

    #[test]
    fn schema_rejects_unexpected_top_level_fields() {
        let error = validate_team_message(&json!({
            "summary": "ok",
            "output_port": "done",
            "payload": {},
            "extra": true
        }))
        .unwrap_err();

        assert_eq!(
            error,
            TeamMessageError::ErrorList(vec![TeamMessageValidationError::UnexpectedField(
                "extra".to_owned()
            )])
        );
    }

    #[tokio::test]
    async fn repair_stops_after_three_failed_attempts() {
        struct AlwaysBroken {
            attempts: usize,
        }

        impl TeamMessageRepairer for AlwaysBroken {
            fn repair_team_message<'a>(
                &'a mut self,
                prompt: TeamMessageRepairPrompt<'a>,
            ) -> TeamMessageRepairFuture<'a> {
                self.attempts += 1;
                assert_eq!(prompt.attempt, self.attempts);
                assert_eq!(prompt.max_attempts, 3);
                assert!(prompt.as_str().contains("Do not call tools"));
                assert!(prompt.as_str().contains("Do not redo the task"));
                assert_eq!(prompt.original_output, "broken");
                Box::pin(async { Some("still broken".to_owned()) })
            }
        }

        let mut repairer = AlwaysBroken { attempts: 0 };
        let outcome = parse_or_repair_team_message("broken", &mut repairer).await;

        assert_eq!(repairer.attempts, 3);
        assert!(matches!(outcome, TeamMessageRepairOutcome::Failed(_)));
    }
}
