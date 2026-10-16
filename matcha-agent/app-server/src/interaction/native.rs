use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::rpc::{self, Error};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Category {
    Permission,
    AskUserQuestion,
    ElicitationForm,
    ElicitationUrl,
    HookCallback,
}

impl Category {
    pub(super) fn family(self) -> &'static str {
        match self {
            Self::Permission => "approvals",
            Self::AskUserQuestion | Self::ElicitationForm | Self::ElicitationUrl => "questions",
            Self::HookCallback => "hooks",
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(tag = "subtype")]
pub(super) enum Request {
    #[serde(rename = "can_use_tool")]
    Permission {
        tool_name: String,
        input: Map<String, Value>,
        tool_use_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permission_suggestions: Option<Vec<Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blocked_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision_reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    #[serde(rename = "elicitation")]
    Elicitation {
        mcp_server_name: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        elicitation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requested_schema: Option<Map<String, Value>>,
    },
    #[serde(rename = "hook_callback")]
    Hook {
        callback_id: String,
        input: Map<String, Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
}

impl Request {
    pub(super) fn decode(value: Value) -> rpc::Result<Self> {
        match value.get("subtype").and_then(Value::as_str) {
            Some("can_use_tool" | "elicitation" | "hook_callback") => (),
            Some(_) => {
                return Err(Error::unavailable(
                    "interaction_unsupported_subtype",
                    "This native control request subtype has no interaction handler",
                ));
            }
            None => return Err(native_invalid("interaction_request_invalid")),
        }
        let request: Self = serde_json::from_value(value)
            .map_err(|source| native_invalid("interaction_request_invalid").with_source(source))?;
        match &request {
            Self::Permission {
                tool_name,
                tool_use_id,
                input,
                ..
            } => {
                if tool_name.is_empty() || tool_use_id.is_empty() {
                    return Err(native_invalid("interaction_permission_request_invalid"));
                }
                if tool_name == "AskUserQuestion" {
                    question_input(input)?;
                }
            }
            Self::Elicitation {
                mcp_server_name,
                mode,
                url,
                elicitation_id,
                ..
            } => {
                if mcp_server_name.is_empty() {
                    return Err(native_invalid("interaction_elicitation_request_invalid"));
                }
                match mode.as_deref().unwrap_or("form") {
                    "form" => (),
                    "url"
                        if url.as_ref().is_some_and(|v| !v.is_empty())
                            && elicitation_id.as_ref().is_some_and(|v| !v.is_empty()) => {}
                    "url" => return Err(native_invalid("interaction_elicitation_url_invalid")),
                    _ => {
                        return Err(Error::unavailable(
                            "interaction_unsupported_elicitation_mode",
                            "This native elicitation mode is not supported",
                        ));
                    }
                }
            }
            Self::Hook {
                callback_id, input, ..
            } => {
                if callback_id.is_empty()
                    || input
                        .get("hook_event_name")
                        .and_then(Value::as_str)
                        .is_none()
                {
                    return Err(native_invalid("interaction_hook_request_invalid"));
                }
                if !HOOK_EVENTS.contains(&input["hook_event_name"].as_str().unwrap_or_default()) {
                    return Err(Error::unavailable(
                        "interaction_unsupported_hook_event",
                        "This native hook event is not supported",
                    ));
                }
            }
        }
        Ok(request)
    }

    pub(super) fn category(&self) -> Category {
        match self {
            Self::Permission { tool_name, .. } if tool_name == "AskUserQuestion" => {
                Category::AskUserQuestion
            }
            Self::Permission { .. } => Category::Permission,
            Self::Elicitation { mode, .. } if mode.as_deref() == Some("url") => {
                Category::ElicitationUrl
            }
            Self::Elicitation { .. } => Category::ElicitationForm,
            Self::Hook { .. } => Category::HookCallback,
        }
    }

    pub(super) fn response(&self, response: Value) -> rpc::Result<Value> {
        let response: Response = rpc::params(response)?;
        let payload = match (self, response) {
            (
                Self::Permission {
                    tool_name,
                    input,
                    tool_use_id,
                    ..
                },
                Response::Permission { decision },
            ) if tool_name != "AskUserQuestion" => decision.payload(input, tool_use_id)?,
            (
                Self::Permission {
                    tool_name,
                    input,
                    tool_use_id,
                    ..
                },
                Response::AskUserQuestion { answer },
            ) if tool_name == "AskUserQuestion" => match answer {
                Answer::Answer {
                    answers,
                    annotations,
                } => {
                    let questions = question_input(input)?;
                    let expected: BTreeSet<&str> = questions
                        .questions
                        .iter()
                        .map(|q| q.question.as_str())
                        .collect();
                    if answers.len() != expected.len()
                        || answers.keys().any(|key| !expected.contains(key.as_str()))
                        || annotations.as_ref().is_some_and(|values| {
                            values.keys().any(|key| !expected.contains(key.as_str()))
                        })
                    {
                        return Err(Error::invalid(
                            "Answers must cover exactly the pending questions; annotations must refer to those questions",
                        ));
                    }
                    let mut updated = input.clone();
                    updated.insert("answers".into(), rpc::value(answers)?);
                    if let Some(annotations) = annotations {
                        updated.insert("annotations".into(), rpc::value(annotations)?);
                    }
                    json!({"behavior": "allow", "updatedInput": updated, "toolUseID": tool_use_id})
                }
                Answer::Decline { message, interrupt } => {
                    let mut payload =
                        json!({"behavior": "deny", "message": message, "toolUseID": tool_use_id});
                    if let Some(interrupt) = interrupt {
                        payload["interrupt"] = json!(interrupt);
                    }
                    payload
                }
            },
            (Self::Elicitation { mode, .. }, Response::Elicitation { action, content }) => {
                if mode.as_deref() == Some("url") && content.is_some() {
                    return Err(Error::invalid(
                        "URL elicitation does not accept form content; accepting is not proof of URL completion",
                    ));
                }
                if action != Action::Accept && content.is_some() {
                    return Err(Error::invalid(
                        "Only accepted form elicitation may contain content",
                    ));
                }
                if mode.as_deref() != Some("url") && action == Action::Accept && content.is_none() {
                    return Err(Error::invalid(
                        "Accepted form elicitation requires a content object",
                    ));
                }
                let mut payload = json!({"action": action});
                if let Some(content) = content {
                    payload["content"] = json!(content);
                }
                payload
            }
            (Self::Hook { input, .. }, Response::HookCallback { output }) => {
                output.validate(input["hook_event_name"].as_str().unwrap_or_default())?;
                rpc::value(output)?
            }
            _ => {
                return Err(Error::invalid(
                    "Response type does not match the pending interaction",
                ));
            }
        };
        // protocol::control_response injects request_id and the outer message.
        Ok(json!({"subtype": "success", "response": payload}))
    }
}

fn native_invalid(kind: &str) -> Error {
    Error::new(
        -32004,
        kind,
        "The native interaction request does not match its supported schema",
    )
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Response {
    Permission {
        decision: PermissionDecision,
    },
    AskUserQuestion {
        answer: Answer,
    },
    Elicitation {
        action: Action,
        content: Option<Map<String, Value>>,
    },
    HookCallback {
        output: HookOutput,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "behavior", rename_all = "camelCase", deny_unknown_fields)]
enum PermissionDecision {
    Allow {
        #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
        updated_input: Option<Map<String, Value>>,
        #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<PermissionUpdate>>,
        #[serde(
            rename = "decisionClassification",
            skip_serializing_if = "Option::is_none"
        )]
        decision_classification: Option<DecisionClassification>,
    },
    Deny {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
        #[serde(
            rename = "decisionClassification",
            skip_serializing_if = "Option::is_none"
        )]
        decision_classification: Option<DecisionClassification>,
    },
}

impl PermissionDecision {
    fn payload(self, original: &Map<String, Value>, tool_use_id: &str) -> rpc::Result<Value> {
        if let Self::Allow {
            updated_permissions,
            ..
        } = &self
        {
            validate_updates(updated_permissions.as_deref().unwrap_or_default())?;
        }
        let mut payload = rpc::value(self)?;
        if payload["behavior"] == "allow" && payload.get("updatedInput").is_none() {
            payload["updatedInput"] = json!(original);
        }
        payload["toolUseID"] = json!(tool_use_id);
        Ok(payload)
    }
}

#[derive(Deserialize, Serialize)]
enum DecisionClassification {
    #[serde(rename = "user_temporary")]
    Temporary,
    #[serde(rename = "user_permanent")]
    Permanent,
    #[serde(rename = "user_reject")]
    Reject,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum PermissionUpdate {
    AddRules {
        rules: Vec<Rule>,
        behavior: Behavior,
        destination: Destination,
    },
    ReplaceRules {
        rules: Vec<Rule>,
        behavior: Behavior,
        destination: Destination,
    },
    RemoveRules {
        rules: Vec<Rule>,
        behavior: Behavior,
        destination: Destination,
    },
    SetMode {
        mode: PermissionMode,
        destination: Destination,
    },
    AddDirectories {
        directories: Vec<String>,
        destination: Destination,
    },
    RemoveDirectories {
        directories: Vec<String>,
        destination: Destination,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rule {
    tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    rule_content: Option<String>,
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Behavior {
    Allow,
    Deny,
    Ask,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Destination {
    UserSettings,
    ProjectSettings,
    LocalSettings,
    Session,
    CliArg,
}

// The actual PermissionPromptToolResultSchema uses externalPermissionModeSchema,
// not the wider SDK declaration (which also lists auto).
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
}

fn validate_updates(updates: &[PermissionUpdate]) -> rpc::Result<()> {
    for update in updates {
        if let PermissionUpdate::AddRules {
            rules,
            behavior: Behavior::Allow,
            ..
        }
        | PermissionUpdate::ReplaceRules {
            rules,
            behavior: Behavior::Allow,
            ..
        } = update
            && rules.iter().any(|rule| {
                rule.tool_name == "*"
                    || rule.tool_name == "Bash(*)"
                    || (rule.tool_name == "Bash"
                        && rule.rule_content.as_deref().is_none_or(|content| {
                            content.trim().is_empty() || content.trim() == "*"
                        }))
            })
        {
            return Err(Error::invalid(
                "Unrestricted Bash allow rules are not accepted",
            ));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Answer {
    Answer {
        answers: BTreeMap<String, String>,
        annotations: Option<BTreeMap<String, Annotation>>,
    },
    Decline {
        message: String,
        interrupt: Option<bool>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Annotation {
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

#[derive(Deserialize)]
struct QuestionInput {
    questions: Vec<Question>,
}

#[derive(Deserialize)]
struct Question {
    question: String,
    #[serde(rename = "header")]
    _header: String,
    options: Vec<QuestionOption>,
    #[serde(default, rename = "multiSelect")]
    _multi_select: bool,
}

#[derive(Deserialize)]
struct QuestionOption {
    label: String,
    #[serde(rename = "description")]
    _description: String,
    #[serde(rename = "preview")]
    _preview: Option<String>,
}

fn question_input(input: &Map<String, Value>) -> rpc::Result<QuestionInput> {
    let parsed: QuestionInput = serde_json::from_value(json!(input)).map_err(|source| {
        native_invalid("interaction_question_input_invalid").with_source(source)
    })?;
    let unique: BTreeSet<&str> = parsed
        .questions
        .iter()
        .map(|q| q.question.as_str())
        .collect();
    if !(1..=4).contains(&parsed.questions.len())
        || unique.len() != parsed.questions.len()
        || parsed.questions.iter().any(|question| {
            let labels: BTreeSet<&str> = question
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect();
            !(2..=4).contains(&question.options.len()) || labels.len() != question.options.len()
        })
    {
        return Err(native_invalid("interaction_question_input_invalid"));
    }
    Ok(parsed)
}

#[derive(Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Accept,
    Decline,
    Cancel,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum HookOutput {
    Async(AsyncHook),
    Sync(SyncHook),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AsyncHook {
    #[serde(rename = "async")]
    asynchronous: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    async_timeout: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncHook {
    #[serde(skip_serializing_if = "Option::is_none")]
    r#continue: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suppress_output: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<HookDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hook_specific_output: Option<HookSpecificOutput>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookDecision {
    Approve,
    Block,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "hookEventName",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum HookSpecificOutput {
    PreToolUse {
        #[serde(skip_serializing_if = "Option::is_none")]
        permission_decision: Option<Behavior>,
        #[serde(skip_serializing_if = "Option::is_none")]
        permission_decision_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<Map<String, Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
    },
    UserPromptSubmit {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
    },
    SessionStart {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_user_message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        watch_paths: Option<Vec<String>>,
    },
    Setup {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
    },
    SubagentStart {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
    },
    PostToolUse {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
        #[serde(
            rename = "updatedMCPToolOutput",
            skip_serializing_if = "Option::is_none"
        )]
        updated_mcp_tool_output: Option<Value>,
    },
    PostToolUseFailure {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
    },
    PermissionDenied {
        #[serde(skip_serializing_if = "Option::is_none")]
        retry: Option<bool>,
    },
    Notification {
        #[serde(skip_serializing_if = "Option::is_none")]
        additional_context: Option<String>,
    },
    PermissionRequest {
        decision: HookPermissionDecision,
    },
    Elicitation {
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<Action>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Map<String, Value>>,
    },
    ElicitationResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<Action>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Map<String, Value>>,
    },
    CwdChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        watch_paths: Option<Vec<String>>,
    },
    FileChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        watch_paths: Option<Vec<String>>,
    },
    WorktreeCreate {
        worktree_path: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "behavior",
    rename_all_fields = "camelCase",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum HookPermissionDecision {
    Allow {
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<Map<String, Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<PermissionUpdate>>,
    },
    Deny {
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

impl HookOutput {
    fn validate(&self, event: &str) -> rpc::Result<()> {
        match self {
            Self::Async(output) if !output.asynchronous => {
                return Err(Error::invalid(
                    "An asynchronous hook response requires async=true",
                ));
            }
            Self::Sync(output) => {
                if let Some(specific) = &output.hook_specific_output {
                    if rpc::value(specific)?["hookEventName"] != event {
                        return Err(Error::invalid(
                            "Hook output must match the pending hook event",
                        ));
                    }
                    if let HookSpecificOutput::PermissionRequest {
                        decision:
                            HookPermissionDecision::Allow {
                                updated_permissions: Some(updates),
                                ..
                            },
                    } = specific
                    {
                        validate_updates(updates)?;
                    }
                }
            }
            _ => (),
        }
        Ok(())
    }
}

const HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "PermissionDenied",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
];
