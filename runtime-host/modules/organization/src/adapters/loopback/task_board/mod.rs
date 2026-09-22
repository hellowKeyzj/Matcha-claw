use platform::capability::CapabilityDecisionVerifier;

pub(crate) mod handler;

use crate::OrganizationHandle;
use serde_json::{Value, json};

const ENDPOINT: &str = "/api/team/task-board";

#[derive(Debug)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    Read {
        team_id: organization::TeamId,
        run_id: organization::GraphRunId,
    },
    Mutate {
        team_id: organization::TeamId,
        run_id: organization::GraphRunId,
        operation: crate::application::task_board::Operation,
    },
}

#[derive(Debug)]
pub(crate) enum Delivery {
    Read(Value),
    Mutated(crate::application::task_board::MutationResult),
    Rejected,
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Read(_) | Self::Mutated(_) => 200,
            Self::Rejected => 409,
            Self::Unavailable => 503,
        }
    }
    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Read(projection) => projection.clone(),
            Self::Mutated(result) => mutation_body(result),
            Self::Rejected => {
                json!({"success":false,"error":"Team task board request was rejected"})
            }
            Self::Unavailable => json!({"success":false,"error":"Team task board is unavailable"}),
        }
    }
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    let action = body
        .get("action")
        .and_then(Value::as_str)
        .ok_or(DecodeError::Invalid)?;
    let operation = body.get("operation").and_then(Value::as_str);
    let (scope, capability) = match (action, operation) {
        ("read", None) => ("team:read", "team.task-board.read"),
        ("mutate", Some(op)) if valid_operation(op) => ("team:write", op),
        _ => return Err(DecodeError::Invalid),
    };
    verifier
        .verify(
            authorization,
            now,
            ENDPOINT,
            scope,
            capability,
            "team-task-board",
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    let team_id = team_id(body.get("teamId"))?;
    let run_id = organization::GraphRunId::new(text(body.get("runId"))?);
    match action {
        "read" if exact(&body, &["action", "teamId", "runId"]) => {
            Ok(Request::Read { team_id, run_id })
        }
        "mutate"
            if exact(
                &body,
                &["action", "teamId", "runId", "operation", "payload"],
            ) =>
        {
            Ok(Request::Mutate {
                team_id: team_id.clone(),
                run_id: run_id.clone(),
                operation: decode_operation(
                    operation.unwrap(),
                    body.get("payload"),
                    &team_id,
                    &run_id,
                )?,
            })
        }
        _ => Err(DecodeError::Invalid),
    }
}

fn valid_operation(op: &str) -> bool {
    matches!(
        op,
        "claimNext"
            | "heartbeat"
            | "release"
            | "transition"
            | "startRunner"
            | "pauseRunner"
            | "closeRunner"
            | "reclaimExpired"
            | "postMailbox"
            | "pullMailbox"
            | "upsertPlan"
    )
}
fn exact(body: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    body.len() == keys.len() && keys.iter().all(|key| body.contains_key(*key))
}
fn text(value: Option<&Value>) -> Result<String, DecodeError> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .map(ToOwned::to_owned)
        .ok_or(DecodeError::Invalid)
}
fn string(value: Option<&Value>) -> Result<&str, DecodeError> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .ok_or(DecodeError::Invalid)
}
fn number(value: Option<&Value>) -> Result<u64, DecodeError> {
    value.and_then(Value::as_u64).ok_or(DecodeError::Invalid)
}
fn optional_text(value: Option<&Value>) -> Result<Option<String>, DecodeError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() && !value.chars().any(char::is_control) => {
            Ok(Some(value.clone()))
        }
        _ => Err(DecodeError::Invalid),
    }
}
fn object(value: Option<&Value>) -> Result<&serde_json::Map<String, Value>, DecodeError> {
    match value {
        Some(Value::Object(value)) => Ok(value),
        _ => Err(DecodeError::Invalid),
    }
}
fn team_id(value: Option<&Value>) -> Result<organization::TeamId, DecodeError> {
    organization::TeamId::try_new(text(value)?).map_err(|_| DecodeError::Invalid)
}
fn task_id(value: Option<&Value>) -> Result<organization::run::task_board::TaskId, DecodeError> {
    organization::run::task_board::TaskId::try_new(text(value)?).map_err(|_| DecodeError::Invalid)
}

fn decode_operation(
    op: &str,
    value: Option<&Value>,
    team: &organization::TeamId,
    run: &organization::GraphRunId,
) -> Result<crate::application::task_board::Operation, DecodeError> {
    let p = object(value)?;
    match op {
        "claimNext" => {
            exact_required(p, &["agentId", "session", "leaseSeconds", "now"])?;
            Ok(crate::application::task_board::Operation::ClaimNext {
                agent_id: text(p.get("agentId"))?,
                session: text(p.get("session"))?,
                lease_seconds: number(p.get("leaseSeconds"))?,
                now: number(p.get("now"))?,
            })
        }
        "heartbeat" => {
            exact_required(p, &["taskId", "agentId", "session", "leaseSeconds", "now"])?;
            Ok(crate::application::task_board::Operation::Heartbeat {
                task_id: task_id(p.get("taskId"))?,
                agent_id: text(p.get("agentId"))?,
                session: text(p.get("session"))?,
                lease_seconds: number(p.get("leaseSeconds"))?,
                now: number(p.get("now"))?,
            })
        }
        "release" => {
            exact_required(p, &["taskId", "agentId", "session", "now"])?;
            Ok(crate::application::task_board::Operation::Release {
                task_id: task_id(p.get("taskId"))?,
                agent_id: text(p.get("agentId"))?,
                session: text(p.get("session"))?,
                now: number(p.get("now"))?,
            })
        }
        "transition" => {
            let with_agent = p.contains_key("agentId") || p.contains_key("session");
            let keys = if with_agent {
                vec![
                    "taskId", "next", "agentId", "session", "summary", "error", "now",
                ]
            } else {
                vec!["taskId", "next", "summary", "error", "now"]
            };
            exact_required(p, &keys)?;
            Ok(crate::application::task_board::Operation::Transition {
                task_id: task_id(p.get("taskId"))?,
                next: status(string(p.get("next"))?)?,
                agent: if with_agent {
                    Some((text(p.get("agentId"))?, text(p.get("session"))?))
                } else {
                    None
                },
                summary: optional_text(p.get("summary"))?,
                error: optional_text(p.get("error"))?,
                now: number(p.get("now"))?,
            })
        }
        "startRunner" | "pauseRunner" | "closeRunner" => {
            exact_required(p, &["runnerId", "session", "now"])?;
            let runner_id = text(p.get("runnerId"))?;
            let session = text(p.get("session"))?;
            let now = number(p.get("now"))?;
            Ok(match op {
                "startRunner" => crate::application::task_board::Operation::StartRunner {
                    runner_id,
                    session,
                    now,
                },
                "pauseRunner" => crate::application::task_board::Operation::PauseRunner {
                    runner_id,
                    session,
                    now,
                },
                _ => crate::application::task_board::Operation::CloseRunner {
                    runner_id,
                    session,
                    now,
                },
            })
        }
        "reclaimExpired" => {
            exact_required(p, &["now"])?;
            Ok(crate::application::task_board::Operation::ReclaimExpired {
                now: number(p.get("now"))?,
            })
        }
        "postMailbox" => {
            exact_required(
                p,
                &[
                    "msgId",
                    "fromAgentId",
                    "to",
                    "relatedTaskId",
                    "replyToMsgId",
                    "kind",
                    "content",
                    "createdAt",
                ],
            )?;
            let related = match p.get("relatedTaskId") {
                Some(Value::Null) => None,
                Some(Value::String(_)) => Some(task_id(p.get("relatedTaskId"))?),
                _ => return Err(DecodeError::Invalid),
            };
            Ok(crate::application::task_board::Operation::PostMailbox {
                message: organization::run::task_board::MailboxMessage::new(
                    team.clone(),
                    run.clone(),
                    text(p.get("msgId"))?,
                    text(p.get("fromAgentId"))?,
                    text(p.get("to"))?,
                    related,
                    optional_text(p.get("replyToMsgId"))?,
                    mailbox_kind(string(p.get("kind"))?)?,
                    text(p.get("content"))?,
                    number(p.get("createdAt"))?,
                )
                .map_err(|_| DecodeError::Invalid)?,
            })
        }
        "pullMailbox" => {
            if p.contains_key("cursor") {
                exact_required(p, &["cursor", "limit"])?;
            } else {
                exact_required(p, &["limit"])?;
            }
            Ok(crate::application::task_board::Operation::PullMailbox {
                cursor: optional_text(p.get("cursor"))?,
                limit: number(p.get("limit"))?
                    .try_into()
                    .map_err(|_| DecodeError::Invalid)?,
            })
        }
        "upsertPlan" => {
            exact_required(p, &["plan", "now", "fingerprint"])?;
            let entries = p
                .get("plan")
                .and_then(Value::as_array)
                .ok_or(DecodeError::Invalid)?;
            let mut plan = Vec::with_capacity(entries.len());
            for entry in entries {
                let e = object(Some(entry))?;
                exact_required(e, &["taskId", "title", "instruction", "dependsOn"])?;
                let deps = e
                    .get("dependsOn")
                    .and_then(Value::as_array)
                    .ok_or(DecodeError::Invalid)?
                    .iter()
                    .map(|v| task_id(Some(v)))
                    .collect::<Result<Vec<_>, _>>()?;
                plan.push(organization::run::task_board::TaskPlanInput {
                    team_id: team.clone(),
                    run_id: run.clone(),
                    task_id: task_id(e.get("taskId"))?,
                    title: text(e.get("title"))?,
                    instruction: text(e.get("instruction"))?,
                    depends_on: deps,
                });
            }
            Ok(crate::application::task_board::Operation::UpsertPlan {
                plan,
                now: number(p.get("now"))?,
                fingerprint: text(p.get("fingerprint"))?,
            })
        }
        _ => Err(DecodeError::Invalid),
    }
}
fn exact_required(body: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<(), DecodeError> {
    if exact(body, keys) {
        Ok(())
    } else {
        Err(DecodeError::Invalid)
    }
}
fn status(value: &str) -> Result<organization::run::task_board::TaskStatus, DecodeError> {
    match value {
        "todo" => Ok(organization::run::task_board::TaskStatus::Todo),
        "claimed" => Ok(organization::run::task_board::TaskStatus::Claimed),
        "running" => Ok(organization::run::task_board::TaskStatus::Running),
        "blocked" => Ok(organization::run::task_board::TaskStatus::Blocked),
        "done" => Ok(organization::run::task_board::TaskStatus::Done),
        "failed" => Ok(organization::run::task_board::TaskStatus::Failed),
        _ => Err(DecodeError::Invalid),
    }
}
fn mailbox_kind(value: &str) -> Result<organization::run::task_board::MailboxKind, DecodeError> {
    match value {
        "question" => Ok(organization::run::task_board::MailboxKind::Question),
        "proposal" => Ok(organization::run::task_board::MailboxKind::Proposal),
        "decision" => Ok(organization::run::task_board::MailboxKind::Decision),
        "report" => Ok(organization::run::task_board::MailboxKind::Report),
        _ => Err(DecodeError::Invalid),
    }
}

fn mutation_body(result: &crate::application::task_board::MutationResult) -> Value {
    let mut body = serde_json::Map::new();
    body.insert("success".into(), Value::Bool(true));
    body.insert("action".into(), Value::String("mutate".into()));
    match result {
        crate::application::task_board::MutationResult::ClaimNext { task_id } => {
            body.insert(
                "taskId".into(),
                task_id
                    .as_ref()
                    .map_or(Value::Null, |id| Value::String(id.as_str().into())),
            );
        }
        crate::application::task_board::MutationResult::Reclaimed { count } => {
            body.insert("reclaimed".into(), json!(count));
        }
        crate::application::task_board::MutationResult::Posted { posted } => {
            body.insert("posted".into(), json!(posted));
        }
        crate::application::task_board::MutationResult::Messages {
            messages,
            next_cursor,
        } => {
            body.insert(
                "messages".into(),
                Value::Array(messages.iter().map(mailbox_value).collect()),
            );
            body.insert(
                "nextCursor".into(),
                next_cursor.clone().map_or(Value::Null, Value::String),
            );
        }
        crate::application::task_board::MutationResult::Plan { task_ids } => {
            body.insert(
                "taskIds".into(),
                Value::Array(
                    task_ids
                        .iter()
                        .map(|id| Value::String(id.as_str().into()))
                        .collect(),
                ),
            );
        }
        crate::application::task_board::MutationResult::Changed => {}
    }
    Value::Object(body)
}

pub(crate) async fn handle(owner: &OrganizationHandle, request: Request) -> Delivery {
    match request {
        Request::Read { team_id, run_id } => owner
            .task_board_read(team_id.clone(), run_id.clone())
            .await
            .map(|facts| Delivery::Read(project(&facts, &team_id, &run_id)))
            .unwrap_or(Delivery::Unavailable),
        Request::Mutate {
            team_id,
            run_id,
            operation,
        } => match owner.task_board_mutate(team_id, run_id, operation).await {
            Ok(Ok(result)) => Delivery::Mutated(result),
            Ok(Err(_)) => Delivery::Rejected,
            Err(_) => Delivery::Unavailable,
        },
    }
}

pub(crate) fn project(
    board: &organization::run::task_board::TaskBoardFacts,
    team_id: &organization::TeamId,
    run_id: &organization::GraphRunId,
) -> Value {
    let mailbox = board
        .mailbox()
        .filter(|message| message.team_id() == team_id && message.run_id() == run_id)
        .collect::<Vec<_>>();
    let cursor = mailbox
        .iter()
        .max_by(|left, right| {
            left.created_at()
                .cmp(&right.created_at())
                .then_with(|| left.msg_id().cmp(right.msg_id()))
        })
        .map_or_else(String::new, |message| {
            format!("{}:{}", message.created_at(), message.msg_id())
        });

    json!({
        "success": true,
        "action": "read",
        "tasks": board.tasks().filter(|t| t.team_id() == team_id && t.run_id() == run_id).map(|t| json!({
            "taskId": t.task_id().as_str(), "title": t.title(), "instruction": t.instruction(),
            "dependsOn": t.depends_on().iter().map(|id| id.as_str()).collect::<Vec<_>>(),
            "status": format_status(t.status()), "ownerAgentId": t.owner_agent_id(),
            "claimSession": t.claim_session(), "claimedAt": t.claimed_at(), "leaseUntil": t.lease_until(),
            "attempt": t.attempt(), "resultSummary": t.result_summary(), "error": t.error(),
            "createdAt": t.created_at(), "updatedAt": t.updated_at()
        })).collect::<Vec<_>>(),
        "runner": board.runners().filter(|r| r.team_id() == team_id && r.run_id() == run_id).map(|r| json!({
            "runnerId": r.runner_id(), "session": r.session(), "status": format_runner(r.status()), "updatedAt": r.updated_at()
        })).collect::<Vec<_>>(),
        "mailbox": mailbox.into_iter().map(mailbox_value).collect::<Vec<_>>(),
        "cursor": cursor
    })
}
pub(crate) fn mailbox_value(m: &organization::run::task_board::MailboxMessage) -> Value {
    json!({"msgId":m.msg_id(),"fromAgentId":m.from_agent_id(),"to":m.to(),"relatedTaskId":m.related_task_id().map(|id| id.as_str()),"replyToMsgId":m.reply_to_msg_id(),"kind":format_kind(m.kind()),"content":m.content(),"createdAt":m.created_at()})
}
fn format_status(s: organization::run::task_board::TaskStatus) -> &'static str {
    match s {
        organization::run::task_board::TaskStatus::Todo => "todo",
        organization::run::task_board::TaskStatus::Claimed => "claimed",
        organization::run::task_board::TaskStatus::Running => "running",
        organization::run::task_board::TaskStatus::Blocked => "blocked",
        organization::run::task_board::TaskStatus::Done => "done",
        organization::run::task_board::TaskStatus::Failed => "failed",
    }
}
fn format_runner(s: organization::run::task_board::RunnerStatus) -> &'static str {
    match s {
        organization::run::task_board::RunnerStatus::Active => "active",
        organization::run::task_board::RunnerStatus::Paused => "paused",
        organization::run::task_board::RunnerStatus::Closed => "closed",
    }
}
fn format_kind(s: organization::run::task_board::MailboxKind) -> &'static str {
    match s {
        organization::run::task_board::MailboxKind::Question => "question",
        organization::run::task_board::MailboxKind::Proposal => "proposal",
        organization::run::task_board::MailboxKind::Decision => "decision",
        organization::run::task_board::MailboxKind::Report => "report",
    }
}
