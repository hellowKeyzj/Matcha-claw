use std::{collections::HashMap, sync::Arc};

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

#[derive(Default)]
pub(crate) struct TeamRunMessageProjectionCache {
    current: Option<MessageProjection>,
}

impl TeamRunMessageProjectionCache {
    pub(crate) fn clear(&mut self) {
        self.current = None;
    }
}

struct MessageProjection {
    // Revalidate current attempts and eligible terminal metadata before reusing locators.
    dependencies: [u8; 32],
    // Pin immutable bodies so removed outputs cannot reuse their allocation identity.
    contents: Vec<Arc<[String]>>,
    revision_prefix: Sha256,
    messages: Vec<MessageLocation>,
    by_id: HashMap<String, usize>,
    missing: bool,
}

pub(super) struct MessageLocation {
    pub(super) id: String,
    pub(super) terminal_index: usize,
    pub(super) body_index: usize,
}

impl MessageLocation {
    fn output<'a>(
        &self,
        terminals: &[&'a crate::run::delivery::TerminalObservation],
    ) -> &'a crate::TeamNodeOutput {
        terminals[self.terminal_index]
            .output()
            .expect("message location has a validated output")
    }
}

pub(super) fn project_messages(
    facts: &OrganizationFacts,
    run: &GraphRunFacts,
    artifacts: &[TeamRunPublicArtifact],
    cursor: Option<&TeamRunMessageCursor>,
    cache: &mut TeamRunMessageProjectionCache,
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
    let mut dependencies = Sha256::new();
    dependencies.update(digest.clone().finalize());
    let mut terminals = Vec::new();
    let mut content_index = 0;
    let mut contents_match = cache.current.is_some();
    for delivery in facts
        .deliveries_for_run(run_id)
        .filter(|delivery| delivery.facts().team_id == run.team().as_str())
    {
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
        hash_field(
            &mut dependencies,
            observation.delivery_id().as_str().as_bytes(),
        );
        hash_field(&mut dependencies, observation.node_id().as_bytes());
        hash_field(
            &mut dependencies,
            observation.fence().attempt_id().as_str().as_bytes(),
        );
        hash_field(
            &mut dependencies,
            observation.fence().node_execution_id().as_str().as_bytes(),
        );
        hash_field(&mut dependencies, observation.role_id().as_bytes());
        dependencies.update(observation.observed_at().to_le_bytes());
        dependencies.update([u8::from(observation.output().is_some())]);
        terminals.push(observation);
        let Some(output) = observation.output() else {
            missing = true;
            continue;
        };
        contents_match &= cache
            .current
            .as_ref()
            .and_then(|current| current.contents.get(content_index))
            .is_some_and(|content| Arc::ptr_eq(content, output.business_messages_identity()));
        content_index += 1;
        if output.business_messages().is_empty() {
            missing = true;
        }
    }
    missing |= !completed.is_empty();
    dependencies.update((terminals.len() as u64).to_le_bytes());
    dependencies.update([u8::from(missing)]);
    let dependencies: [u8; 32] = dependencies.finalize().into();
    if !contents_match
        || cache.current.as_ref().is_none_or(|current| {
            current.dependencies != dependencies || current.contents.len() != content_index
        })
    {
        let mut messages = Vec::new();
        let mut contents = Vec::with_capacity(content_index);
        for (terminal_index, observation) in terminals.iter().enumerate() {
            hash_field(&mut digest, observation.delivery_id().as_str().as_bytes());
            let Some(output) = observation.output() else {
                continue;
            };
            contents.push(Arc::clone(output.business_messages_identity()));
            for (body_index, body) in output.business_messages().iter().enumerate() {
                let id = message_id(run_id, observation, body_index);
                hash_field(&mut digest, id.as_bytes());
                hash_field(&mut digest, body.as_bytes());
                messages.push(MessageLocation {
                    id,
                    terminal_index,
                    body_index,
                });
            }
        }
        digest.update([u8::from(missing)]);
        messages.sort_by(|left, right| {
            let left_terminal = terminals[left.terminal_index];
            let right_terminal = terminals[right.terminal_index];
            left_terminal
                .observed_at()
                .cmp(&right_terminal.observed_at())
                .then_with(|| {
                    left_terminal
                        .delivery_id()
                        .cmp(right_terminal.delivery_id())
                })
                .then_with(|| left.body_index.cmp(&right.body_index))
        });
        let mut by_id = HashMap::with_capacity(messages.len());
        for (index, message) in messages.iter().enumerate() {
            by_id.entry(message.id.clone()).or_insert(index);
        }
        cache.current = Some(MessageProjection {
            dependencies,
            contents,
            revision_prefix: digest,
            messages,
            by_id,
            missing,
        });
    }
    let projection = cache
        .current
        .as_ref()
        .expect("message projection was rebuilt or validated");
    // Preserve the original revision bytes; only the immutable message prefix is reused.
    let mut digest = projection.revision_prefix.clone();
    for artifact in artifacts {
        // This fixed DTO contains no maps or fallible custom serializers.
        hash_field(
            &mut digest,
            &serde_json::to_vec(artifact).expect("artifact projection serializes"),
        );
    }
    let revision = format!("{:x}", digest.finalize());
    page_messages(
        run_id,
        &terminals,
        &projection.messages,
        &projection.by_id,
        revision,
        cursor,
        projection.missing,
    )
}

pub(super) fn page_messages(
    run_id: &str,
    terminals: &[&crate::run::delivery::TerminalObservation],
    messages: &[MessageLocation],
    by_id: &HashMap<String, usize>,
    revision: String,
    cursor: Option<&TeamRunMessageCursor>,
    missing: bool,
) -> (Vec<TeamRunPublicMessage>, TeamRunMessagePage, bool) {
    let start = match cursor {
        None => Some((0, 0)),
        Some(cursor) if cursor.revision == revision => by_id
            .get(&cursor.message_id)
            .copied()
            .and_then(|index| {
                let message = &messages[index];
                let body = &message.output(terminals).business_messages()[message.body_index];
                usize::try_from(cursor.body_offset)
                    .ok()
                    .filter(|offset| *offset < body.len() && body.is_char_boundary(*offset))
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
        let terminal = terminals[message.terminal_index];
        let output = message.output(terminals);
        let body = &output.business_messages()[message.body_index];
        let mut end = body.len().min(offset + remaining);
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset {
            break;
        }
        page.push(TeamRunPublicMessage {
            message_id: message.id.clone(),
            run_id: run_id.to_owned(),
            node_id: terminal.node_id().to_owned(),
            node_execution_id: terminal.fence().node_execution_id().as_str().to_owned(),
            attempt_id: terminal.fence().attempt_id().as_str().to_owned(),
            kind: "note",
            from_role_id: terminal.role_id().to_owned(),
            to_role_id: "",
            summary: output.summary().to_owned(),
            body: body[offset..end].to_owned(),
            body_offset: offset,
            body_bytes: body.len(),
            body_complete: end == body.len(),
            failure_items: Vec::new(),
            idempotency_key: "",
            created_at: terminal.observed_at(),
        });
        remaining -= end - offset;
        if end == body.len() {
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

pub(super) fn message_id(
    run_id: &str,
    observation: &crate::run::delivery::TerminalObservation,
    body_index: usize,
) -> String {
    let mut identity = Sha256::new();
    hash_field(&mut identity, run_id.as_bytes());
    hash_field(&mut identity, observation.delivery_id().as_str().as_bytes());
    identity.update((body_index as u64).to_le_bytes());
    format!("team-result-{:x}", identity.finalize())
}

pub(super) fn hash_field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
}
