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
    decision: String,
    dispatch: Vec<TeamMessageDispatch>,
}

impl TeamMessage {
    pub(crate) fn summary(&self) -> &str {
        &self.summary
    }

    pub(crate) fn decision(&self) -> &str {
        &self.decision
    }

    pub(crate) fn dispatch(&self) -> &[TeamMessageDispatch] {
        &self.dispatch
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TeamMessageDispatch {
    role_id: String,
    task: String,
}

impl TeamMessageDispatch {
    pub(crate) fn role_id(&self) -> &str {
        &self.role_id
    }

    pub(crate) fn task(&self) -> &str {
        &self.task
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
        if !matches!(field.as_str(), "summary" | "decision" | "dispatch") {
            errors.push(TeamMessageValidationError::UnexpectedField(field.clone()));
        }
    }
    let summary = required_string(object, "summary", &mut errors);
    let decision = required_string(object, "decision", &mut errors);
    if let Some(summary) = summary {
        validate_summary(summary, &mut errors);
    }
    let dispatch = required_dispatch(object.get("dispatch"), &mut errors);
    if !errors.is_empty() {
        return Err(TeamMessageError::ErrorList(errors));
    }
    Ok(TeamMessage {
        summary: summary.expect("validated summary is present").to_owned(),
        decision: decision.expect("validated decision is present").to_owned(),
        dispatch: dispatch.expect("validated dispatch is present"),
    })
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &'static str,
    errors: &mut Vec<TeamMessageValidationError>,
) -> Option<&'a str> {
    required_string_value(object.get(field), field, errors)
}

fn required_string_value<'a>(
    value: Option<&'a Value>,
    field: &'static str,
    errors: &mut Vec<TeamMessageValidationError>,
) -> Option<&'a str> {
    match value {
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

fn required_dispatch(
    value: Option<&Value>,
    errors: &mut Vec<TeamMessageValidationError>,
) -> Option<Vec<TeamMessageDispatch>> {
    let Some(Value::Array(items)) = value else {
        match value {
            Some(_) => errors.push(TeamMessageValidationError::FieldType {
                field: "dispatch",
                expected: "an array",
            }),
            None => errors.push(TeamMessageValidationError::MissingField("dispatch")),
        }
        return None;
    };
    let mut dispatch = Vec::with_capacity(items.len());
    for item in items {
        let Some(object) = item.as_object() else {
            errors.push(TeamMessageValidationError::FieldType {
                field: "dispatch",
                expected: "an array of objects",
            });
            continue;
        };
        for field in object.keys() {
            if !matches!(field.as_str(), "role_id" | "task") {
                errors.push(TeamMessageValidationError::UnexpectedField(format!(
                    "dispatch.{field}"
                )));
            }
        }
        let role_id = required_string(object, "role_id", errors);
        let task = required_string(object, "task", errors);
        if let (Some(role_id), Some(task)) = (role_id, task) {
            dispatch.push(TeamMessageDispatch {
                role_id: role_id.to_owned(),
                task: task.to_owned(),
            });
        }
    }
    Some(dispatch)
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
    let correct_format = r#"<team_message>{"summary":"中文交付摘要","decision":"completed","dispatch":[]}</team_message>"#;
    let prompt = format!(
        "<teamrun_message_repair>\n\
你正在修复 TeamRun 节点最终回复中的 `<team_message>` 控制块。\n\n\
只做格式修复，不重新执行任务，不调用工具，不输出解释。\n\
最终回复必须只包含一个 `<team_message>...</team_message>`，其中内容必须是合法 JSON。\n\n\
原始输出：\n{original_output}\n\n\
校验错误：\n{}\n\n\
目标结构：\n{correct_format}\n\n\
修复规则：\n\
- JSON 顶层只能包含 `summary`、`decision`、`dispatch`\n\
- `summary`：用中文概括原始输出里的完成内容、关键结论、产物/改动、风险、下游必要上下文\n\
- `decision`：保留原始输出表达的后续流向；如果无法判断，填 `completed`\n\
- `dispatch`：必须是数组；没有明确下游任务时填 `[]`\n\
- `dispatch` 每项只能包含非空字符串字段 `role_id` 和 `task`\n\
- JSON 字符串里的换行和引号必须正确转义\n\
</teamrun_message_repair>",
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
        let text = "noise <team_message>{\"summary\":\"旧摘要\",\"decision\":\"completed\",\"dispatch\":[]}</team_message> tail <team_message>{\"summary\":\"新摘要\",\"decision\":\"completed\",\"dispatch\":[]}</team_message>";

        assert_eq!(
            extract_last_team_message(text).unwrap(),
            "{\"summary\":\"新摘要\",\"decision\":\"completed\",\"dispatch\":[]}"
        );
        assert_eq!(parse_team_message(text).unwrap().summary(), "新摘要");
    }

    #[test]
    fn json_syntax_error_is_reported() {
        let error =
            parse_team_message("<team_message>{\"summary\":\"摘要\",\"decision\":</team_message>")
                .unwrap_err();

        assert!(matches!(error, TeamMessageError::Json(_)));
    }

    #[test]
    fn schema_validation_collects_multiple_errors() {
        let error = validate_team_message(&json!({
            "summary": "bad\nsummary",
            "decision": "",
            "dispatch": [{"role_id": "", "task": false, "extra": true}]
        }))
        .unwrap_err();

        assert_eq!(
            error,
            TeamMessageError::ErrorList(vec![
                TeamMessageValidationError::EmptyString("decision"),
                TeamMessageValidationError::ControlCharacter("summary"),
                TeamMessageValidationError::UnexpectedField("dispatch.extra".to_owned()),
                TeamMessageValidationError::EmptyString("role_id"),
                TeamMessageValidationError::FieldType {
                    field: "task",
                    expected: "a string"
                },
            ])
        );
    }

    #[test]
    fn dispatch_accepts_role_tasks() {
        let message = parse_team_message(
            "<team_message>{\"summary\":\"已完成交付\",\"decision\":\"completed\",\"dispatch\":[{\"role_id\":\"reviewer\",\"task\":\"复核结果\"}]}</team_message>",
        )
        .unwrap();

        assert_eq!(message.decision(), "completed");
        assert_eq!(message.dispatch().len(), 1);
        assert_eq!(message.dispatch()[0].role_id(), "reviewer");
        assert_eq!(message.dispatch()[0].task(), "复核结果");
    }

    #[test]
    fn normalize_wraps_bare_valid_json_only_after_validation() {
        let normalized = parse_or_normalize_team_message_text(
            "before {\"summary\":\"已完成交付\",\"decision\":\"completed\",\"dispatch\":[]} after",
        )
        .unwrap();

        assert_eq!(
            normalized,
            "<team_message>{\"summary\":\"已完成交付\",\"decision\":\"completed\",\"dispatch\":[]}</team_message>"
        );

        let error = parse_or_normalize_team_message_text(
            "before {\"summary\":\"已完成交付\",\"output_port\":\"done\",\"payload\":{}} after",
        )
        .unwrap_err();

        assert!(matches!(error, TeamMessageError::ErrorList(_)));
    }

    #[test]
    fn schema_rejects_unexpected_top_level_fields() {
        let error = validate_team_message(&json!({
            "summary": "已完成",
            "decision": "completed",
            "dispatch": [],
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
                assert!(prompt.as_str().contains("不调用工具"));
                assert!(prompt.as_str().contains("不重新执行任务"));
                assert!(prompt.as_str().contains(
                    "{\"summary\":\"中文交付摘要\",\"decision\":\"completed\",\"dispatch\":[]}"
                ));
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
