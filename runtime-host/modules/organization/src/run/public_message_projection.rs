use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::run::{
    delivery::{NativeTerminalStatus, TerminalObservationResolution},
    graph::{AttemptStatus, NodeKind},
};
use crate::{DeliveryPhase, GraphRunFacts, NodeId, OrganizationFacts};

use super::TeamRunPublicArtifact;

const PAGE_BODY_BYTES: usize = 48 * 1024;
const PAGE_MESSAGES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamRunMessageCursor {
    revision: String,
    message_id: String,
    body_offset: u64,
}

impl TeamRunMessageCursor {
    pub(crate) fn is_valid(&self) -> bool {
        self.revision.len() == 64
            && self
                .revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && !self.message_id.trim().is_empty()
            && self.message_id.len() <= 512
            && !self.message_id.contains('\0')
            && self.body_offset <= 9_007_199_254_740_991
            && usize::try_from(self.body_offset).is_ok()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRunMessagePageStatus {
    Complete,
    Incomplete,
    Unavailable,
    Stale,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunMessagePage {
    revision: String,
    status: TeamRunMessagePageStatus,
    next_cursor: Option<TeamRunMessageCursor>,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunPublicMessage {
    message_id: String,
    run_id: String,
    node_id: String,
    node_execution_id: String,
    attempt_id: String,
    kind: &'static str,
    from_role_id: String,
    to_role_id: &'static str,
    summary: String,
    body: String,
    body_offset: usize,
    body_bytes: usize,
    body_complete: bool,
    failure_items: Vec<()>,
    idempotency_key: &'static str,
    created_at: u64,
}

impl std::fmt::Debug for TeamRunPublicMessage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TeamRunPublicMessage")
            .field("message_id", &self.message_id)
            .field("body_bytes", &self.body_bytes)
            .field("body_offset", &self.body_offset)
            .field("body", &"<redacted>")
            .finish()
    }
}

struct Message<'a> {
    id: String,
    index: usize,
    terminal: &'a crate::run::delivery::TerminalObservation,
    output: &'a crate::TeamNodeOutput,
    body: &'a str,
}

pub(super) fn project_messages(
    facts: &OrganizationFacts,
    run: &GraphRunFacts,
    artifacts: &[TeamRunPublicArtifact],
    cursor: Option<&TeamRunMessageCursor>,
) -> (Vec<TeamRunPublicMessage>, TeamRunMessagePage, bool) {
    let run_id = run.graph().definition().run_id().as_str();
    let mut digest = Sha256::new();
    hash_field(&mut digest, run.team().as_str().as_bytes());
    hash_field(&mut digest, run_id.as_bytes());
    let mut missing = false;
    let mut completed = std::collections::BTreeSet::new();
    for history in run.graph().executions().values() {
        let attempt = history.current();
        hash_field(&mut digest, attempt.node_id().as_str().as_bytes());
        hash_field(
            &mut digest,
            attempt.fence().attempt_id().as_str().as_bytes(),
        );
        hash_field(
            &mut digest,
            attempt.fence().node_execution_id().as_str().as_bytes(),
        );
        digest.update([attempt.status() as u8]);
        if attempt.status() == AttemptStatus::Completed
            && matches!(attempt.node_kind(), NodeKind::Work | NodeKind::Review)
        {
            completed.insert(attempt.fence().node_execution_id().as_str());
        }
    }
    let mut messages = Vec::new();
    for delivery in facts.deliveries().deliveries().filter(|delivery| {
        delivery.facts().run_id == run_id && delivery.facts().team_id == run.team().as_str()
    }) {
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            continue;
        };
        let node = NodeId::new(observation.node_id());
        if observation.graph_run_id() != run_id
            || run.execution_is_retired(&node, observation.fence())
            || !run
                .graph()
                .current_attempt(&node)
                .is_some_and(|attempt| attempt.fence() == observation.fence())
            || observation.native_terminal() != NativeTerminalStatus::Completed
            || !matches!(
                observation.resolution(),
                TerminalObservationResolution::GraphResolved(_)
            )
        {
            continue;
        }
        completed.remove(observation.fence().node_execution_id().as_str());
        hash_field(&mut digest, observation.delivery_id().as_str().as_bytes());
        let Some(output) = observation.output() else {
            missing = true;
            continue;
        };
        if output.business_messages().is_empty() {
            missing = true;
        }
        for (index, body) in output.business_messages().iter().enumerate() {
            let mut identity = Sha256::new();
            hash_field(&mut identity, run_id.as_bytes());
            hash_field(&mut identity, observation.delivery_id().as_str().as_bytes());
            identity.update((index as u64).to_le_bytes());
            let id = format!("team-result-{:x}", identity.finalize());
            hash_field(&mut digest, id.as_bytes());
            hash_field(&mut digest, body.as_bytes());
            messages.push(Message {
                id,
                index,
                terminal: observation,
                output,
                body,
            });
        }
    }
    missing |= !completed.is_empty();
    digest.update([u8::from(missing)]);
    for artifact in artifacts {
        // This fixed DTO contains no maps or fallible custom serializers.
        hash_field(
            &mut digest,
            &serde_json::to_vec(artifact).expect("artifact projection serializes"),
        );
    }
    let revision = format!("{:x}", digest.finalize());
    messages.sort_by(|left, right| {
        left.terminal
            .observed_at()
            .cmp(&right.terminal.observed_at())
            .then_with(|| {
                left.terminal
                    .delivery_id()
                    .cmp(right.terminal.delivery_id())
            })
            .then_with(|| left.index.cmp(&right.index))
    });
    let start = match cursor {
        None => Some((0, 0)),
        Some(cursor) if cursor.revision == revision => messages
            .iter()
            .position(|message| message.id == cursor.message_id)
            .and_then(|index| {
                usize::try_from(cursor.body_offset)
                    .ok()
                    .filter(|offset| {
                        *offset < messages[index].body.len()
                            && messages[index].body.is_char_boundary(*offset)
                    })
                    .map(|offset| (index, offset))
            }),
        Some(_) => None,
    };
    let Some((mut index, mut offset)) = start else {
        return (
            Vec::new(),
            TeamRunMessagePage {
                revision,
                status: TeamRunMessagePageStatus::Stale,
                next_cursor: None,
            },
            missing,
        );
    };
    let mut page = Vec::new();
    let mut remaining = PAGE_BODY_BYTES;
    while index < messages.len() && page.len() < PAGE_MESSAGES && remaining > 0 {
        let message = &messages[index];
        let mut end = message.body.len().min(offset + remaining);
        while !message.body.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset {
            break;
        }
        page.push(TeamRunPublicMessage {
            message_id: message.id.clone(),
            run_id: run_id.to_owned(),
            node_id: message.terminal.node_id().to_owned(),
            node_execution_id: message
                .terminal
                .fence()
                .node_execution_id()
                .as_str()
                .to_owned(),
            attempt_id: message.terminal.fence().attempt_id().as_str().to_owned(),
            kind: "note",
            from_role_id: message.terminal.role_id().to_owned(),
            to_role_id: "",
            summary: message.output.summary().to_owned(),
            body: message.body[offset..end].to_owned(),
            body_offset: offset,
            body_bytes: message.body.len(),
            body_complete: end == message.body.len(),
            failure_items: Vec::new(),
            idempotency_key: "",
            created_at: message.terminal.observed_at(),
        });
        remaining -= end - offset;
        if end == message.body.len() {
            index += 1;
            offset = 0;
        } else {
            offset = end;
        }
    }
    let next_cursor = messages.get(index).map(|message| TeamRunMessageCursor {
        revision: revision.clone(),
        message_id: message.id.clone(),
        body_offset: offset as u64,
    });
    let status = if next_cursor.is_some() || (missing && !messages.is_empty()) {
        TeamRunMessagePageStatus::Incomplete
    } else if missing {
        TeamRunMessagePageStatus::Unavailable
    } else {
        TeamRunMessagePageStatus::Complete
    };
    (
        page,
        TeamRunMessagePage {
            revision,
            status,
            next_cursor,
        },
        missing,
    )
}

fn hash_field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
}
