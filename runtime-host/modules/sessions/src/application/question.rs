use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::state::{MAX_SAFE_INTEGER, MAX_TEXT_BYTES, SessionIdentity, SessionProvider};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionTarget {
    pub session_id: String,
    pub instance_id: String,
    pub native_request_id: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QuestionRequest {
    AskUserQuestion {
        questions: Vec<Question>,
    },
    ElicitationForm {
        mcp_server_name: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        requested_schema: Option<Map<String, Value>>,
    },
    ElicitationUrl {
        mcp_server_name: String,
        message: String,
        url: String,
        elicitation_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnnotation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum QuestionAnswer {
    AskUserQuestion {
        answer: AskUserAnswer,
    },
    Elicitation {
        action: ElicitationAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Map<String, Value>>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum AskUserAnswer {
    Answer {
        answers: BTreeMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<BTreeMap<String, QuestionAnnotation>>,
    },
    Decline {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ElicitationAction {
    Accept,
    Decline,
    Cancel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuestionAvailability {
    Pending,
    NativeCancelled,
    InstanceClosed,
    ServerRestarted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuestionDelivery {
    NotSent,
    Sending,
    Sent,
    WriteFailed,
    Unknown,
}

/// The native protocol has no acknowledgement that an answer was applied.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeApplication {
    NotSubmitted,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionView {
    pub target: QuestionTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub request: QuestionRequest,
    pub availability: QuestionAvailability,
    pub delivery: QuestionDelivery,
    pub native_application: NativeApplication,
    pub requested_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionFailure {
    pub code: i64,
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionReceipt {
    pub target: QuestionTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub availability: QuestionAvailability,
    pub delivery: QuestionDelivery,
    pub native_application: NativeApplication,
    pub requested_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<QuestionFailure>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingQuestionsCommand {
    #[serde(rename = "sessionIdentity")]
    pub identity: SessionIdentity,
    pub endpoint_session_id: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQuestionCommand {
    #[serde(rename = "sessionIdentity")]
    pub identity: SessionIdentity,
    pub target: QuestionTarget,
    pub answer: QuestionAnswer,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PendingQuestionsOutcome {
    Listed { questions: Vec<QuestionView> },
    TargetRejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionQuestionOutcome {
    Responded {
        receipt: QuestionReceipt,
    },
    TargetRejected {
        #[serde(skip_serializing_if = "Option::is_none")]
        receipt: Option<QuestionReceipt>,
        #[serde(skip_serializing_if = "Option::is_none")]
        response_attempt_delivery: Option<QuestionDelivery>,
    },
    Unknown {
        #[serde(skip_serializing_if = "Option::is_none")]
        receipt: Option<QuestionReceipt>,
        #[serde(skip_serializing_if = "Option::is_none")]
        response_attempt_delivery: Option<QuestionDelivery>,
    },
    Unsupported,
    Unavailable {
        #[serde(skip_serializing_if = "Option::is_none")]
        receipt: Option<QuestionReceipt>,
        #[serde(skip_serializing_if = "Option::is_none")]
        response_attempt_delivery: Option<QuestionDelivery>,
    },
}

impl SessionQuestionOutcome {
    pub fn unavailable() -> Self {
        Self::Unavailable {
            receipt: None,
            response_attempt_delivery: None,
        }
    }

    pub fn rejected() -> Self {
        Self::TargetRejected {
            receipt: None,
            response_attempt_delivery: Some(QuestionDelivery::NotSent),
        }
    }

    pub fn unknown() -> Self {
        Self::Unknown {
            receipt: None,
            response_attempt_delivery: None,
        }
    }

    pub fn receipt(&self) -> Option<&QuestionReceipt> {
        match self {
            Self::Responded { receipt } => Some(receipt),
            Self::TargetRejected { receipt, .. }
            | Self::Unknown { receipt, .. }
            | Self::Unavailable { receipt, .. } => receipt.as_ref(),
            Self::Unsupported => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidQuestion;

pub fn supports_identity(identity: &SessionIdentity) -> bool {
    identity.endpoint.kind == "native-runtime"
        && identity.provider() == SessionProvider::MatchaAgent
        && identity.endpoint.runtime_instance_id == "local"
}

impl QuestionTarget {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        valid(
            identifier(&self.session_id)
                && identifier(&self.instance_id)
                && identifier(&self.native_request_id),
        )
    }
}

impl PendingQuestionsCommand {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        valid(self.identity.validate().is_ok() && identifier(&self.endpoint_session_id))
    }
}

impl SessionQuestionCommand {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        self.identity.validate().map_err(|_| InvalidQuestion)?;
        self.target.validate()?;
        self.answer.validate()
    }
}

impl QuestionAnswer {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        valid(match self {
            Self::AskUserQuestion {
                answer:
                    AskUserAnswer::Answer {
                        answers,
                        annotations,
                    },
            } => {
                (1..=4).contains(&answers.len())
                    && answers
                        .iter()
                        .all(|(question, answer)| text(question) && text(answer))
                    && annotations.as_ref().is_none_or(|annotations| {
                        annotations.iter().all(|(key, value)| {
                            answers.contains_key(key)
                                && value.preview.as_deref().is_none_or(text)
                                && value.notes.as_deref().is_none_or(text)
                        })
                    })
            }
            Self::AskUserQuestion {
                answer: AskUserAnswer::Decline { message, .. },
            } => text(message),
            Self::Elicitation { action, content } => {
                *action == ElicitationAction::Accept || content.is_none()
            }
        })
    }

    pub fn matches_request(&self, request: &QuestionRequest) -> bool {
        match (self, request) {
            (
                Self::AskUserQuestion {
                    answer: AskUserAnswer::Answer { answers, .. },
                },
                QuestionRequest::AskUserQuestion { questions },
            ) => {
                answers.len() == questions.len()
                    && questions
                        .iter()
                        .all(|question| answers.contains_key(&question.question))
            }
            (
                Self::AskUserQuestion {
                    answer: AskUserAnswer::Decline { .. },
                },
                QuestionRequest::AskUserQuestion { .. },
            ) => true,
            (Self::Elicitation { action, content }, QuestionRequest::ElicitationForm { .. }) => {
                (*action == ElicitationAction::Accept) == content.is_some()
            }
            (Self::Elicitation { content, .. }, QuestionRequest::ElicitationUrl { .. }) => {
                content.is_none()
            }
            _ => false,
        }
    }
}

impl QuestionRequest {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        valid(match self {
            Self::AskUserQuestion { questions } => {
                (1..=4).contains(&questions.len())
                    && questions
                        .iter()
                        .map(|question| &question.question)
                        .collect::<BTreeSet<_>>()
                        .len()
                        == questions.len()
                    && questions.iter().all(|question| {
                        text(&question.question)
                            && text(&question.header)
                            && (2..=4).contains(&question.options.len())
                            && question
                                .options
                                .iter()
                                .map(|option| &option.label)
                                .collect::<BTreeSet<_>>()
                                .len()
                                == question.options.len()
                            && question.options.iter().all(|option| {
                                text(&option.label)
                                    && text(&option.description)
                                    && option.preview.as_deref().is_none_or(text)
                            })
                    })
            }
            Self::ElicitationForm {
                mcp_server_name,
                message,
                ..
            } => identifier(mcp_server_name) && text(message),
            Self::ElicitationUrl {
                mcp_server_name,
                message,
                url,
                elicitation_id,
            } => {
                identifier(mcp_server_name)
                    && text(message)
                    && identifier(elicitation_id)
                    && identifier(url)
            }
        })
    }
}

impl QuestionView {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        self.target.validate()?;
        self.request.validate()?;
        validate_facts(
            self.run_id.as_deref(),
            self.delivery,
            self.native_application,
            self.requested_at_ms,
            self.updated_at_ms,
        )
    }
}

impl QuestionReceipt {
    pub fn validate(&self) -> Result<(), InvalidQuestion> {
        self.target.validate()?;
        validate_facts(
            self.run_id.as_deref(),
            self.delivery,
            self.native_application,
            self.requested_at_ms,
            self.updated_at_ms,
        )?;
        valid(self.failure.as_ref().is_none_or(|failure| {
            !failure.kind.is_empty()
                && failure.kind.len() <= 128
                && failure
                    .kind
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
                && failure.code.unsigned_abs() <= MAX_SAFE_INTEGER
        }))
    }
}

fn validate_facts(
    run_id: Option<&str>,
    delivery: QuestionDelivery,
    application: NativeApplication,
    requested: u64,
    updated: u64,
) -> Result<(), InvalidQuestion> {
    valid(
        run_id.is_none_or(identifier)
            && requested <= MAX_SAFE_INTEGER
            && updated <= MAX_SAFE_INTEGER
            && application
                == if matches!(
                    delivery,
                    QuestionDelivery::NotSent | QuestionDelivery::WriteFailed
                ) {
                    NativeApplication::NotSubmitted
                } else {
                    NativeApplication::Unknown
                },
    )
}

fn identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

fn text(value: &str) -> bool {
    value.len() <= MAX_TEXT_BYTES && !value.contains('\0')
}
fn valid(value: bool) -> Result<(), InvalidQuestion> {
    value.then_some(()).ok_or(InvalidQuestion)
}

pub fn descriptor(scope: &Value) -> Option<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Scope {
        kind: String,
        identity: SessionIdentity,
    }
    let decoded: Scope = serde_json::from_value(scope.clone()).ok()?;
    if decoded.kind != "session"
        || decoded.identity.validate().is_err()
        || !supports_identity(&decoded.identity)
    {
        return None;
    }
    Some(json!({
        "id": "session.question", "kind": "session-question", "scopeKind": "session", "scope": scope,
        "targetKinds": ["session"], "runtimeAdapterId": "matcha-agent", "runtimeInstanceId": "local",
        "supportLevel": "native", "availability": "available", "policyScope": "session.question",
        "ownerModuleId": "sessions", "routeOwnerId": "matcha-agent",
        "operations": [
            {"id":"sessions.questions.list","title":"List session questions","targetKind":"session","targetRequired":true},
            {"id":"sessions.questions.respond","title":"Respond to session question","targetKind":"session","targetRequired":true}
        ]
    }))
}
