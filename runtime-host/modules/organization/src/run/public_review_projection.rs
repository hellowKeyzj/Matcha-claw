use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DeliveryPhase, GraphRunFacts, GraphRunId, NodeId, OrganizationFacts, TeamId};
use crate::run::{
    delivery::{TerminalObservation, TerminalObservationResolution},
    graph::{AttemptStatus, NodeAttempt, NodeKind},
};

use super::{TeamRunMessageCursor, TeamRunMessagePage, TeamRunPublicMessage};
use super::public_message_projection::{MessageLocation, hash_field, message_id, page_messages};

const PAGE_REVIEWS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum TeamNodeReviewHistoryQuery {
    List { cursor: Option<TeamNodeReviewHistoryCursor> },
    Messages {
        node_execution_id: String,
        attempt_id: String,
        cursor: Option<TeamRunMessageCursor>,
    },
}

impl TeamNodeReviewHistoryQuery {
    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::List { cursor } => cursor.as_ref().is_none_or(TeamNodeReviewHistoryCursor::is_valid),
            Self::Messages { node_execution_id, attempt_id, cursor } => {
                valid_identity(node_execution_id)
                    && valid_identity(attempt_id)
                    && cursor.as_ref().is_none_or(TeamRunMessageCursor::is_valid)
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamNodeReviewHistoryCursor {
    revision: String,
    node_execution_id: String,
    attempt_id: String,
}

impl TeamNodeReviewHistoryCursor {
    fn is_valid(&self) -> bool {
        self.revision.len() == 64
            && self.revision.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && valid_identity(&self.node_execution_id)
            && valid_identity(&self.attempt_id)
    }
}

fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum TeamNodeReviewHistoryResult {
    List {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        entries: Vec<TeamNodeReviewHistoryEntry>,
        page: TeamNodeReviewHistoryPage,
    },
    Messages {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "nodeExecutionId")]
        node_execution_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        messages: Vec<TeamRunPublicMessage>,
        #[serde(rename = "messagePage")]
        message_page: TeamRunMessagePage,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamNodeReviewHistoryEntry {
    node_execution_id: String,
    attempt_id: String,
    attempt_number: u32,
    batch_id: u64,
    current_attempt: bool,
    role_id: Option<String>,
    output_port: &'static str,
    status: &'static str,
    summary: Option<String>,
    created_at: u64,
    updated_at: u64,
    resolved_at: Option<u64>,
    body_status: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamNodeReviewHistoryPage {
    revision: String,
    status: &'static str,
    next_cursor: Option<TeamNodeReviewHistoryCursor>,
}

pub(crate) fn query_team_node_review_history(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
    node_id: &NodeId,
    query: &TeamNodeReviewHistoryQuery,
) -> Option<TeamNodeReviewHistoryResult> {
    let run = super::validated_public_run(facts, team_id, run_id).ok()?;
    let history = run.graph().executions().get(node_id);
    let mut terminals = BTreeMap::new();
    for delivery in facts.deliveries_for_run(run_id.as_str()) {
        if delivery.facts().team_id != team_id.as_str() {
            continue;
        }
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            continue;
        };
        if observation.graph_run_id() == run_id.as_str()
            && observation.node_id() == node_id.as_str()
            && !run.execution_is_retired(node_id, observation.fence())
            && matches!(observation.resolution(), TerminalObservationResolution::GraphResolved(_))
        {
            terminals.entry(observation.fence()).or_insert(observation);
        }
    }
    let reviews: Vec<_> = history.into_iter().flat_map(|history| history.attempts())
        .filter(|attempt| is_review(attempt))
        .collect();
    let mut digest = Sha256::new();
    hash_field(&mut digest, team_id.as_str().as_bytes());
    hash_field(&mut digest, run_id.as_str().as_bytes());
    hash_field(&mut digest, node_id.as_str().as_bytes());
    match query {
        TeamNodeReviewHistoryQuery::List { cursor } => {
            let start = match cursor {
                None => Some(0),
                Some(cursor) => reviews.iter().position(|attempt| {
                    attempt.fence().node_execution_id().as_str() == cursor.node_execution_id
                        && attempt.fence().attempt_id().as_str() == cursor.attempt_id
                }),
            };
            let mut entries = Vec::new();
            for (index, attempt) in reviews.iter().enumerate() {
                let entry = review_entry(run, attempt, terminals.get(attempt.fence()).copied());
                hash_field(&mut digest, &serde_json::to_vec(&entry).expect("review entry serializes"));
                if start.is_some_and(|start| index >= start && index - start < PAGE_REVIEWS) {
                    entries.push(entry);
                }
            }
            let revision = format!("{:x}", digest.finalize());
            let stale = start.is_none() || cursor.as_ref().is_some_and(|cursor| cursor.revision != revision);
            let next_cursor = if stale {
                entries.clear();
                None
            } else {
                reviews.get(start.expect("non-stale review cursor was located") + PAGE_REVIEWS)
                    .map(|attempt| TeamNodeReviewHistoryCursor {
                        revision: revision.clone(),
                        node_execution_id: attempt.fence().node_execution_id().as_str().to_owned(),
                        attempt_id: attempt.fence().attempt_id().as_str().to_owned(),
                    })
            };
            Some(TeamNodeReviewHistoryResult::List {
                run_id: run_id.as_str().to_owned(),
                node_id: node_id.as_str().to_owned(),
                entries,
                page: TeamNodeReviewHistoryPage {
                    revision,
                    status: if stale { "stale" } else if next_cursor.is_some() { "incomplete" } else { "complete" },
                    next_cursor,
                },
            })
        }
        TeamNodeReviewHistoryQuery::Messages { node_execution_id, attempt_id, cursor } => {
            let attempt = reviews.into_iter().find(|attempt| {
                attempt.fence().node_execution_id().as_str() == node_execution_id
                    && attempt.fence().attempt_id().as_str() == attempt_id
            })?;
            hash_field(&mut digest, node_execution_id.as_bytes());
            hash_field(&mut digest, attempt_id.as_bytes());
            let terminal = terminals.get(attempt.fence()).copied();
            let terminals: Vec<_> = terminal.into_iter().collect();
            let mut messages = Vec::new();
            let mut missing = true;
            for (terminal_index, terminal) in terminals.iter().enumerate() {
                hash_field(&mut digest, terminal.delivery_id().as_str().as_bytes());
                hash_field(&mut digest, terminal.role_id().as_bytes());
                digest.update(terminal.observed_at().to_le_bytes());
                let Some(output) = terminal.output() else {
                    continue;
                };
                hash_field(&mut digest, output.summary().as_bytes());
                missing = output.business_messages().is_empty();
                for (body_index, body) in output.business_messages().iter().enumerate() {
                    let id = message_id(run_id.as_str(), terminal, body_index);
                    hash_field(&mut digest, id.as_bytes());
                    hash_field(&mut digest, body.as_bytes());
                    messages.push(MessageLocation { id, terminal_index, body_index });
                }
            }
            digest.update([u8::from(missing)]);
            let by_id: HashMap<_, _> = messages.iter().enumerate()
                .map(|(index, message)| (message.id.clone(), index)).collect();
            let (messages, message_page, _) = page_messages(
                run_id.as_str(), &terminals, &messages, &by_id,
                format!("{:x}", digest.finalize()), cursor.as_ref(), missing,
            );
            Some(TeamNodeReviewHistoryResult::Messages {
                run_id: run_id.as_str().to_owned(),
                node_id: node_id.as_str().to_owned(),
                node_execution_id: node_execution_id.clone(),
                attempt_id: attempt_id.clone(),
                messages,
                message_page,
            })
        }
    }
}

fn is_review(attempt: &NodeAttempt) -> bool {
    attempt.node_kind() == NodeKind::Review
        && matches!(attempt.status(), AttemptStatus::Completed | AttemptStatus::Failed)
        && matches!(attempt.output_port(), Some("completed" | "rework"))
}

fn review_entry(
    run: &GraphRunFacts,
    attempt: &NodeAttempt,
    terminal: Option<&TerminalObservation>,
) -> TeamNodeReviewHistoryEntry {
    let output = terminal.and_then(TerminalObservation::output);
    TeamNodeReviewHistoryEntry {
        node_execution_id: attempt.fence().node_execution_id().as_str().to_owned(),
        attempt_id: attempt.fence().attempt_id().as_str().to_owned(),
        attempt_number: attempt.number().get(),
        batch_id: attempt.batch_id().get(),
        current_attempt: run.graph().current_attempt(attempt.node_id())
            .is_some_and(|current| current.fence() == attempt.fence()),
        role_id: terminal.map(|terminal| terminal.role_id().to_owned()),
        output_port: if attempt.output_port() == Some("completed") { "completed" } else { "rework" },
        status: if attempt.status() == AttemptStatus::Completed { "completed" } else { "failed" },
        summary: output.map(|output| output.summary().to_owned()),
        created_at: attempt.created_at(),
        updated_at: attempt.updated_at(),
        resolved_at: terminal.and_then(|terminal| match terminal.resolution() {
            TerminalObservationResolution::GraphResolved(resolution) => Some(resolution.resolved_at()),
            _ => None,
        }),
        body_status: if output.is_some_and(|output| !output.business_messages().is_empty()) {
            "available"
        } else {
            "unavailable"
        },
    }
}
