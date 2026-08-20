use super::{
    facts::{
        BoundedHistoryFacts, LiveSessionFacts, NativeFactRead, NativeFactStatus,
        SessionIdentityFacts, SessionRuntimeFacts,
    },
    projection::{
        CanonicalSessionDelta, CanonicalSessionDeltaProducer, NativeSessionProjection,
        ProjectionGap, SnapshotField,
    },
    protocol::{MessageId, SessionKey},
};
use crate::session_window::{Message, MessageContent, MessageRole, OmittedContentKind};
use std::fmt;

/// Canonical role mapping for a native history message.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalMessageRole {
    User,
    Assistant,
    System,
    ToolResult,
}

impl From<MessageRole> for CanonicalMessageRole {
    fn from(role: MessageRole) -> Self {
        match role {
            MessageRole::User => Self::User,
            MessageRole::Assistant => Self::Assistant,
            MessageRole::System => Self::System,
            MessageRole::ToolResult => Self::ToolResult,
        }
    }
}

/// One message retained by the bounded native history window.
///
/// `message_id` is never derived locally. The native decoder already applies
/// the only permitted precedence (`messageId`, otherwise `id`) and rejects a
/// response that supplies both aliases.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct CanonicalHistoryMessage<'facts> {
    message: &'facts Message,
}

impl<'facts> CanonicalHistoryMessage<'facts> {
    fn new(message: &'facts Message) -> Self {
        Self { message }
    }

    pub fn native(self) -> &'facts Message {
        self.message
    }

    pub fn role(self) -> CanonicalMessageRole {
        match self.message.role() {
            MessageRole::User => CanonicalMessageRole::User,
            MessageRole::Assistant => CanonicalMessageRole::Assistant,
            MessageRole::System => CanonicalMessageRole::System,
            MessageRole::ToolResult => CanonicalMessageRole::ToolResult,
        }
    }

    pub fn message_id(self) -> Option<&'facts str> {
        self.message.message_id()
    }

    pub fn parent_id(self) -> Option<&'facts str> {
        self.message.parent_id()
    }

    pub fn run_id(self) -> Option<&'facts str> {
        self.message.run_id()
    }

    pub fn tool_call_id(self) -> Option<&'facts str> {
        self.message.tool_call_id()
    }

    pub fn text(self) -> &'facts str {
        self.message.text()
    }

    pub const fn sequence(self) -> Option<u64> {
        self.message.sequence()
    }

    pub fn content(self) -> &'facts [MessageContent] {
        self.message.content()
    }
}

impl fmt::Debug for CanonicalHistoryMessage<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalHistoryMessage")
            .field("role", &self.role())
            .field("has_message_id", &self.message_id().is_some())
            .field("has_run_id", &self.run_id().is_some())
            .field("has_parent_id", &self.parent_id().is_some())
            .field("text_bytes", &self.text().len())
            .finish()
    }
}

/// An assistant history message. No turn id is invented when the native
/// message has no `runId`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CanonicalAssistantTurn<'facts> {
    message: CanonicalHistoryMessage<'facts>,
}

impl<'facts> CanonicalAssistantTurn<'facts> {
    pub fn message(self) -> CanonicalHistoryMessage<'facts> {
        self.message
    }

    pub fn message_id(self) -> Option<&'facts str> {
        self.message.message_id()
    }

    pub fn run_id(self) -> Option<&'facts str> {
        self.message.run_id()
    }

    pub fn text(self) -> &'facts str {
        self.message.text()
    }
}

/// Thinking was present in the native message, but the native decoder only
/// exposes its redacted/omitted marker. No thinking text is fabricated.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CanonicalThinking<'facts> {
    message: CanonicalHistoryMessage<'facts>,
    block_index: usize,
}

impl<'facts> CanonicalThinking<'facts> {
    pub fn message(self) -> CanonicalHistoryMessage<'facts> {
        self.message
    }

    pub const fn block_index(self) -> usize {
        self.block_index
    }
}

/// A media block from native history. Inline bytes are reported as present,
/// while the decoder's unsafe-media omission is retained explicitly.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct CanonicalMedia<'facts> {
    message: CanonicalHistoryMessage<'facts>,
    block_index: usize,
    media_type: Option<&'facts str>,
    reference: Option<&'facts str>,
    bytes: Option<usize>,
    unsafe_content_omitted: bool,
}

impl<'facts> CanonicalMedia<'facts> {
    pub fn message(self) -> CanonicalHistoryMessage<'facts> {
        self.message
    }

    pub const fn block_index(self) -> usize {
        self.block_index
    }

    pub fn media_type(self) -> Option<&'facts str> {
        self.media_type
    }

    pub fn reference(self) -> Option<&'facts str> {
        self.reference
    }

    pub const fn bytes(self) -> Option<usize> {
        self.bytes
    }

    pub const fn unsafe_content_omitted(self) -> bool {
        self.unsafe_content_omitted
    }
}

impl fmt::Debug for CanonicalMedia<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalMedia")
            .field("has_media_type", &self.media_type.is_some())
            .field("has_reference", &self.reference.is_some())
            .field("has_inline_bytes", &self.bytes.is_some())
            .field("unsafe_content_omitted", &self.unsafe_content_omitted)
            .finish()
    }
}

#[derive(Clone, Copy)]
pub struct CanonicalToolCall<'facts> {
    message: CanonicalHistoryMessage<'facts>,
    block_index: usize,
    name: &'facts str,
    tool_call_id: Option<&'facts str>,
    identity_conflict: bool,
}

impl<'facts> CanonicalToolCall<'facts> {
    fn new(
        message: CanonicalHistoryMessage<'facts>,
        block_index: usize,
        name: &'facts str,
        block_tool_call_id: Option<&'facts str>,
    ) -> Self {
        let (tool_call_id, identity_conflict) =
            resolve_tool_identity(message.tool_call_id(), block_tool_call_id);
        Self {
            message,
            block_index,
            name,
            tool_call_id,
            identity_conflict,
        }
    }

    pub fn message(self) -> CanonicalHistoryMessage<'facts> {
        self.message
    }

    pub const fn block_index(self) -> usize {
        self.block_index
    }

    pub fn name(self) -> &'facts str {
        self.name
    }

    pub fn tool_call_id(self) -> Option<&'facts str> {
        self.tool_call_id
    }

    pub const fn identity_conflict(self) -> bool {
        self.identity_conflict
    }
}

impl fmt::Debug for CanonicalToolCall<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalToolCall")
            .field("has_tool_call_id", &self.tool_call_id.is_some())
            .field("identity_conflict", &self.identity_conflict)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
pub struct CanonicalToolResult<'facts> {
    message: CanonicalHistoryMessage<'facts>,
    block_index: usize,
    tool_name: Option<&'facts str>,
    tool_call_id: Option<&'facts str>,
    summary: Option<&'facts str>,
    is_error: Option<bool>,
    identity_conflict: bool,
}

impl<'facts> CanonicalToolResult<'facts> {
    fn new(
        message: CanonicalHistoryMessage<'facts>,
        block_index: usize,
        tool_name: Option<&'facts str>,
        block_tool_call_id: Option<&'facts str>,
        summary: Option<&'facts str>,
        is_error: Option<bool>,
    ) -> Self {
        let (tool_call_id, identity_conflict) =
            resolve_tool_identity(message.tool_call_id(), block_tool_call_id);
        Self {
            message,
            block_index,
            tool_name,
            tool_call_id,
            summary,
            is_error,
            identity_conflict,
        }
    }

    pub fn message(self) -> CanonicalHistoryMessage<'facts> {
        self.message
    }

    pub const fn block_index(self) -> usize {
        self.block_index
    }

    pub fn tool_name(self) -> Option<&'facts str> {
        self.tool_name
    }

    pub fn tool_call_id(self) -> Option<&'facts str> {
        self.tool_call_id
    }

    pub fn summary(self) -> Option<&'facts str> {
        self.summary
    }

    pub const fn is_error(self) -> Option<bool> {
        self.is_error
    }

    pub const fn identity_conflict(self) -> bool {
        self.identity_conflict
    }
}

impl fmt::Debug for CanonicalToolResult<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalToolResult")
            .field("has_tool_name", &self.tool_name.is_some())
            .field("has_tool_call_id", &self.tool_call_id.is_some())
            .field("has_summary", &self.summary.is_some())
            .field("is_error", &self.is_error)
            .field("identity_conflict", &self.identity_conflict)
            .finish()
    }
}

/// Pairing is limited to the observed bounded history window. A missing side
/// may therefore be outside the requested window rather than globally absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolPairState {
    Paired,
    MissingResult,
    MissingCall,
    IdentityUnavailable,
    ConflictingIdentity,
}

#[derive(Clone, Copy)]
pub struct CanonicalToolPair<'facts> {
    state: ToolPairState,
    call: Option<CanonicalToolCall<'facts>>,
    result: Option<CanonicalToolResult<'facts>>,
}

impl<'facts> CanonicalToolPair<'facts> {
    fn new(
        state: ToolPairState,
        call: Option<CanonicalToolCall<'facts>>,
        result: Option<CanonicalToolResult<'facts>>,
    ) -> Self {
        Self {
            state,
            call,
            result,
        }
    }

    pub const fn state(self) -> ToolPairState {
        self.state
    }

    pub const fn call(self) -> Option<CanonicalToolCall<'facts>> {
        self.call
    }

    pub const fn result(self) -> Option<CanonicalToolResult<'facts>> {
        self.result
    }
}

impl fmt::Debug for CanonicalToolPair<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalToolPair")
            .field("state", &self.state)
            .field("has_call", &self.call.is_some())
            .field("has_result", &self.result.is_some())
            .finish()
    }
}

/// A borrow-only canonical view over OpenClaw's existing native fact families.
/// It never turns Gateway positions into Host positions and never claims a
/// complete renderer snapshot.
#[derive(Clone, Copy)]
pub struct CanonicalSessionView<'facts> {
    projection: &'facts NativeSessionProjection,
}

impl<'facts> CanonicalSessionView<'facts> {
    pub fn projection(self) -> &'facts NativeSessionProjection {
        self.projection
    }

    pub fn session_key(self) -> Option<&'facts SessionKey> {
        self.projection.session_key()
    }

    pub fn identity(self) -> &'facts NativeFactRead<SessionIdentityFacts> {
        self.projection.identity()
    }

    pub fn runtime(self) -> &'facts NativeFactRead<SessionRuntimeFacts> {
        self.projection.runtime()
    }

    pub fn history(self) -> &'facts NativeFactRead<BoundedHistoryFacts> {
        self.projection.history()
    }

    pub fn live_event(self) -> &'facts NativeFactRead<LiveSessionFacts> {
        self.projection.live_event()
    }

    pub fn gaps(self) -> &'facts [ProjectionGap] {
        self.projection.gaps()
    }

    /// Aggregated status for this native read. Renderer projection gaps keep a
    /// view incomplete even when an individual native family is complete.
    pub fn status(self) -> NativeFactStatus {
        let statuses = [
            self.identity().status(),
            self.runtime().status(),
            self.history().status(),
            self.live_event().status(),
        ];
        if statuses.contains(&NativeFactStatus::Unknown) {
            return NativeFactStatus::Unknown;
        }
        if statuses
            .iter()
            .all(|status| *status == NativeFactStatus::Unavailable)
        {
            return NativeFactStatus::Unavailable;
        }
        if self.gaps().is_empty()
            && statuses
                .iter()
                .all(|status| *status == NativeFactStatus::Complete)
        {
            NativeFactStatus::Complete
        } else {
            NativeFactStatus::Incomplete
        }
    }

    pub fn messages(self) -> Option<&'facts [Message]> {
        self.history()
            .facts()
            .map(|facts| facts.window().messages())
    }

    pub fn history_messages(self) -> Vec<CanonicalHistoryMessage<'facts>> {
        self.messages()
            .unwrap_or_default()
            .iter()
            .map(CanonicalHistoryMessage::new)
            .collect()
    }

    pub fn assistant_turns(self) -> Vec<CanonicalAssistantTurn<'facts>> {
        self.messages()
            .unwrap_or_default()
            .iter()
            .filter(|message| message.role() == MessageRole::Assistant)
            .map(|message| CanonicalAssistantTurn {
                message: CanonicalHistoryMessage::new(message),
            })
            .collect()
    }

    pub fn thinking(self) -> Vec<CanonicalThinking<'facts>> {
        let mut thinking = Vec::new();
        for message in self.messages().unwrap_or_default() {
            let canonical = CanonicalHistoryMessage::new(message);
            for (block_index, block) in message.content().iter().enumerate() {
                if matches!(
                    block,
                    MessageContent::Omitted {
                        kind: OmittedContentKind::Thinking
                    }
                ) {
                    thinking.push(CanonicalThinking {
                        message: canonical,
                        block_index,
                    });
                }
            }
        }
        thinking
    }

    pub fn media(self) -> Vec<CanonicalMedia<'facts>> {
        let mut media = Vec::new();
        for message in self.messages().unwrap_or_default() {
            let canonical = CanonicalHistoryMessage::new(message);
            for (block_index, block) in message.content().iter().enumerate() {
                let MessageContent::Media {
                    media_type,
                    reference,
                    bytes,
                } = block
                else {
                    continue;
                };
                let unsafe_content_omitted =
                    message.content().get(block_index + 1).is_some_and(|next| {
                        matches!(
                            next,
                            MessageContent::Omitted {
                                kind: OmittedContentKind::UnsafeMedia
                            }
                        )
                    });
                media.push(CanonicalMedia {
                    message: canonical,
                    block_index,
                    media_type: media_type.as_deref(),
                    reference: reference.as_deref(),
                    bytes: *bytes,
                    unsafe_content_omitted,
                });
            }
        }
        media
    }

    pub fn tool_pairs(self) -> Vec<CanonicalToolPair<'facts>> {
        let mut calls = Vec::new();
        let mut results = Vec::new();
        for message in self.messages().unwrap_or_default() {
            let canonical = CanonicalHistoryMessage::new(message);
            for (block_index, block) in message.content().iter().enumerate() {
                match block {
                    MessageContent::ToolUse { name, tool_call_id } => {
                        calls.push(CanonicalToolCall::new(
                            canonical,
                            block_index,
                            name,
                            tool_call_id.as_deref(),
                        ))
                    }
                    MessageContent::ToolResult {
                        tool_name,
                        tool_call_id,
                        summary,
                        is_error,
                    } => results.push(CanonicalToolResult::new(
                        canonical,
                        block_index,
                        tool_name.as_deref(),
                        tool_call_id.as_deref(),
                        summary.as_deref(),
                        *is_error,
                    )),
                    MessageContent::Text { .. }
                    | MessageContent::Media { .. }
                    | MessageContent::Omitted { .. } => {}
                }
            }
        }

        let mut used_results = vec![false; results.len()];
        let mut pairs = Vec::with_capacity(calls.len() + results.len());
        for call in calls {
            if call.identity_conflict() {
                pairs.push(CanonicalToolPair::new(
                    ToolPairState::ConflictingIdentity,
                    Some(call),
                    None,
                ));
                continue;
            }
            let Some(tool_call_id) = call.tool_call_id() else {
                pairs.push(CanonicalToolPair::new(
                    ToolPairState::IdentityUnavailable,
                    Some(call),
                    None,
                ));
                continue;
            };
            let result_index = results.iter().enumerate().find_map(|(index, result)| {
                (!used_results[index]
                    && !result.identity_conflict()
                    && result.tool_call_id() == Some(tool_call_id))
                .then_some(index)
            });
            if let Some(result_index) = result_index {
                used_results[result_index] = true;
                pairs.push(CanonicalToolPair::new(
                    ToolPairState::Paired,
                    Some(call),
                    Some(results[result_index]),
                ));
            } else {
                pairs.push(CanonicalToolPair::new(
                    ToolPairState::MissingResult,
                    Some(call),
                    None,
                ));
            }
        }

        for (index, result) in results.into_iter().enumerate() {
            if used_results[index] {
                continue;
            }
            let state = if result.identity_conflict() {
                ToolPairState::ConflictingIdentity
            } else if result.tool_call_id().is_some() {
                ToolPairState::MissingCall
            } else {
                ToolPairState::IdentityUnavailable
            };
            pairs.push(CanonicalToolPair::new(state, None, Some(result)));
        }
        pairs
    }

    /// Live message identity uses the native event's explicit `messageId`; the
    /// existing facts owner has already applied embedded-message fallback.
    pub fn live_message_id(self) -> Option<&'facts MessageId> {
        self.live_event()
            .facts()
            .and_then(LiveSessionFacts::message_id)
    }

    /// Maps the actual live event into the existing integration-local delta
    /// producer. The returned source epoch/cursor remain optional native facts.
    pub fn live_delta(self, route_key: Option<String>) -> Option<CanonicalSessionDelta> {
        self.live_event()
            .facts()
            .and_then(|facts| CanonicalSessionDeltaProducer::from_facts(facts, route_key))
    }

    /// OpenClaw currently has no native approval event or snapshot producer.
    /// Callers receive the existing typed projection gap instead of a guessed
    /// requested/resolved approval record.
    pub fn approval_gaps(self) -> Vec<&'facts ProjectionGap> {
        self.gaps()
            .iter()
            .filter(|gap| gap.field() == SnapshotField::Approvals)
            .collect()
    }

    pub fn is_incomplete(self) -> bool {
        self.status() != NativeFactStatus::Complete
    }
}

impl fmt::Debug for CanonicalSessionView<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalSessionView")
            .field("status", &self.status())
            .field("has_session_key", &self.session_key().is_some())
            .field("history_status", &self.history().status())
            .field("live_event_status", &self.live_event().status())
            .field("gap_count", &self.gaps().len())
            .finish()
    }
}

/// Integration-local assembler for OpenClaw native facts.
#[derive(Clone, Copy, Debug, Default)]
pub struct CanonicalSessionAssembler;

impl CanonicalSessionAssembler {
    pub const fn new() -> Self {
        Self
    }

    pub fn assemble<'facts>(
        projection: &'facts NativeSessionProjection,
    ) -> CanonicalSessionView<'facts> {
        CanonicalSessionView { projection }
    }
}

fn resolve_tool_identity<'facts>(
    message_tool_call_id: Option<&'facts str>,
    block_tool_call_id: Option<&'facts str>,
) -> (Option<&'facts str>, bool) {
    match (message_tool_call_id, block_tool_call_id) {
        (Some(message), Some(block)) if message != block => (None, true),
        (Some(message), _) => (Some(message), false),
        (None, Some(block)) => (Some(block), false),
        (None, None) => (None, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        gateway::{ingress::GatewayEpoch, wire::GatewayEvent},
        session::{
            facts::{LiveSessionFacts, NativeFactGap},
            projection::{ProjectionGapReason, SnapshotProducer},
            protocol::{SessionSummary, decode_session_event},
        },
        session_window::PageRequest,
    };
    use serde_json::json;

    fn summary() -> SessionSummary {
        SessionSummary {
            key: SessionKey::try_new("agent:main:session-1").unwrap(),
            kind: super::super::protocol::SessionKind::Direct,
            agent_id: None,
            label: Some("label".into()),
            display_name: Some("display".into()),
            derived_title: Some("title".into()),
            updated_at: Some(42),
            status: Some("idle".into()),
            has_active_run: Some(true),
            model: Some("provider/model".into()),
        }
    }

    fn event(
        name: &str,
        payload: serde_json::Value,
    ) -> super::super::protocol::SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: name.into(),
            payload: Some(payload),
            sequence: Some(91),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    fn projection(
        history: NativeFactRead<BoundedHistoryFacts>,
        live: NativeFactRead<LiveSessionFacts>,
    ) -> NativeSessionProjection {
        NativeSessionProjection::from_reads(
            SessionIdentityFacts::from_native(&summary()),
            SessionRuntimeFacts::from_native(&summary()),
            history,
            live,
        )
        .unwrap()
    }

    #[test]
    fn assembler_maps_assistant_thinking_media_and_tool_pairing_without_payload_synthesis() {
        let history = BoundedHistoryFacts::decode(
            json!({
                "sessionKey":"agent:main:session-1",
                "messages":[
                    {
                        "role":"assistant",
                        "messageId":"assistant-1",
                        "runId":"run-1",
                        "content":[
                            {"type":"thinking"},
                            {"type":"text","text":"answer"},
                            {"type":"toolCall","name":"read","id":"tool-1"},
                            {"type":"image","mimeType":"image/png","data":"aW1hZ2U="}
                        ]
                    },
                    {
                        "role":"toolResult",
                        "messageId":"result-1",
                        "toolCallId":"tool-1",
                        "content":[{"type":"toolResult","toolCallId":"tool-1","content":"ok","isError":false}]
                    }
                ]
            }),
            PageRequest::latest(),
        )
        .unwrap();
        let projection = projection(history, NativeFactRead::Unavailable);
        let view = CanonicalSessionAssembler::assemble(&projection);

        assert_eq!(view.assistant_turns().len(), 1);
        assert_eq!(view.assistant_turns()[0].message_id(), Some("assistant-1"));
        assert_eq!(view.assistant_turns()[0].run_id(), Some("run-1"));
        assert_eq!(view.thinking().len(), 1);
        assert_eq!(view.media().len(), 1);
        assert_eq!(view.media()[0].bytes(), Some(8));
        assert!(view.media()[0].unsafe_content_omitted());

        let pairs = view.tool_pairs();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].state(), ToolPairState::Paired);
        assert_eq!(pairs[0].call().unwrap().name(), "read");
        assert_eq!(pairs[0].result().unwrap().summary(), Some("ok"));
        assert_eq!(pairs[0].result().unwrap().is_error(), Some(false));
        assert!(view.is_incomplete());
    }

    #[test]
    fn tool_pairing_preserves_partial_and_conflicting_native_identities() {
        let history = BoundedHistoryFacts::decode(
            json!({
                "sessionKey":"agent:main:session-1",
                "messages":[
                    {"role":"assistant","content":[{"type":"toolCall","name":"read","id":"missing-result"}]},
                    {"role":"toolResult","toolCallId":"orphan-call","content":[{"type":"toolResult","toolCallId":"orphan-call","result":"failed","isError":true}]},
                    {"role":"assistant","toolCallId":"message-id","content":[{"type":"toolCall","name":"conflict","id":"block-id"}]}
                ]
            }),
            PageRequest::latest(),
        )
        .unwrap();
        let projection = projection(history, NativeFactRead::Unavailable);
        let view = CanonicalSessionAssembler::assemble(&projection);
        let pairs = view.tool_pairs();

        assert!(
            pairs
                .iter()
                .any(|pair| pair.state() == ToolPairState::MissingResult)
        );
        assert!(
            pairs
                .iter()
                .any(|pair| pair.state() == ToolPairState::MissingCall)
        );
        assert!(
            pairs
                .iter()
                .any(|pair| pair.state() == ToolPairState::ConflictingIdentity)
        );
    }

    #[test]
    fn live_identity_prefers_explicit_message_id_and_terminal_maps_native_fields() {
        let message = LiveSessionFacts::from_native_at_epoch(
            event(
                "session.message",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "messageId":"explicit-message",
                    "lifecycle":"delta",
                    "message":{"id":"embedded-message","content":"delta"}
                }),
            ),
            Some(GatewayEpoch::try_new(3).unwrap()),
        );
        let message_projection = projection(NativeFactRead::Unavailable, message);
        let message_view = CanonicalSessionAssembler::assemble(&message_projection);
        assert_eq!(
            message_view.live_message_id().unwrap().as_str(),
            "explicit-message"
        );
        assert_eq!(
            message_view
                .live_delta(None)
                .unwrap()
                .provenance()
                .source_epoch(),
            Some(3)
        );

        let terminal = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":8,
                    "state":"error",
                    "errorKind":"timeout",
                    "stopReason":"native-stop"
                }),
            ),
            Some(GatewayEpoch::try_new(3).unwrap()),
        );
        let terminal_projection = projection(NativeFactRead::Unavailable, terminal);
        let terminal_view = CanonicalSessionAssembler::assemble(&terminal_projection);
        assert!(matches!(
            terminal_view.live_delta(None).unwrap().changes(),
            [super::super::projection::CanonicalSessionChange::Terminal {
                run_id,
                outcome: super::super::events::TerminalOutcome::Error,
                message_id: None,
                message_text: None,
                error_kind: Some(super::super::protocol::SessionErrorKind::Timeout),
                stop_reason: Some(reason)
            }] if run_id.as_str() == "run-1" && reason == "native-stop"
        ));
    }

    #[test]
    fn approval_requested_and_resolved_remain_projection_gaps_without_native_producer() {
        let projection = projection(NativeFactRead::Unavailable, NativeFactRead::Unavailable);
        let view = CanonicalSessionAssembler::assemble(&projection);
        assert!(view.approval_gaps().iter().any(|gap| {
            gap.producer() == SnapshotProducer::SessionEvent
                && gap.reason() == ProjectionGapReason::NotProduced
        }));
        assert!(
            view.gaps()
                .iter()
                .all(|gap| gap.field() != SnapshotField::Approvals
                    || gap.reason() != ProjectionGapReason::Native(NativeFactGap::ApprovalFacts))
        );
    }

    #[test]
    fn source_cursor_and_epoch_are_not_promoted_to_host_coordinates() {
        let live = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":9,
                    "state":"delta",
                    "deltaText":"partial"
                }),
            ),
            Some(GatewayEpoch::try_new(4).unwrap()),
        );
        let projection = projection(NativeFactRead::Unavailable, live);
        let view = CanonicalSessionAssembler::assemble(&projection);
        let delta = view.live_delta(None).unwrap();
        assert_eq!(delta.source_epoch(), Some(4));
        assert_eq!(delta.source_cursor(), Some(91));
        assert!(delta.provenance().route_key().is_none());
        assert!(view.status() != NativeFactStatus::Complete);
    }
}
