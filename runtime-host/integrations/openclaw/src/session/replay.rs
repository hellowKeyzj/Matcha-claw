use std::{fmt, path::PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::{
    gateway::{ingress::GatewayEpoch, wire::GatewayEvent},
    lifecycle::state_dir::CanonicalStateDir,
    session_window::{Message, PageRequest, WindowRange, decode_transcript_event_message},
};

use super::{
    projection::CanonicalIngressResult,
    protocol::{AgentId, SessionEventEnvelope, SessionKey, decode_session_event},
    reducer::SessionReducerActor,
};

const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const AGENT_SESSION_PREFIX: &str = "agent:";
const AGENT_DATABASE_NAME: &str = "openclaw-agent.sqlite";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionReplayError {
    InvalidSourceEpoch,
}

impl fmt::Display for SessionReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSourceEpoch => "session replay source epoch must be non-zero",
        })
    }
}

impl std::error::Error for SessionReplayError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionReplaySourceError {
    MissingStateDir,
    UnsupportedSessionKey,
    AgentStoreUnavailable,
    SessionUnavailable,
    StoreReadFailed,
    SourceMalformed,
    SourceUndecodable { source_sequence: u64 },
}

impl fmt::Display for SessionReplaySourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingStateDir => "OpenClaw replay source needs a state directory",
            Self::UnsupportedSessionKey => {
                "OpenClaw replay source needs an agent-scoped session key"
            }
            Self::AgentStoreUnavailable => "OpenClaw agent transcript store is unavailable",
            Self::SessionUnavailable => "OpenClaw session transcript is unavailable",
            Self::StoreReadFailed => "OpenClaw replay source read failed",
            Self::SourceMalformed => "OpenClaw replay source row is malformed",
            Self::SourceUndecodable { .. } => "OpenClaw replay source row cannot be decoded",
        })
    }
}

impl std::error::Error for SessionReplaySourceError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionReplaySourceSkipReason {
    Metadata,
    UnsupportedEvent,
    Undecodable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionReplaySourceSkip {
    source_sequence: u64,
    reason: SessionReplaySourceSkipReason,
}

impl SessionReplaySourceSkip {
    pub const fn source_sequence(self) -> u64 {
        self.source_sequence
    }

    pub const fn reason(self) -> SessionReplaySourceSkipReason {
        self.reason
    }
}

#[derive(Clone, PartialEq)]
pub struct SessionReplaySourcePage {
    session_key: SessionKey,
    native_session_id: String,
    source_range: WindowRange,
    total_source_events: usize,
    rows: Vec<SessionReplaySourceRow>,
    skipped_events: Vec<SessionReplaySourceSkip>,
}

impl SessionReplaySourcePage {
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn native_session_id(&self) -> &str {
        &self.native_session_id
    }

    pub const fn source_range(&self) -> WindowRange {
        self.source_range
    }

    pub const fn total_source_events(&self) -> usize {
        self.total_source_events
    }

    pub fn rows(&self) -> &[SessionReplaySourceRow] {
        &self.rows
    }

    pub fn events(&self) -> Vec<SessionEventEnvelope> {
        self.rows
            .iter()
            .filter_map(SessionReplaySourceRow::event)
            .cloned()
            .collect()
    }

    pub fn into_rows(self) -> Vec<SessionReplaySourceRow> {
        self.rows
    }

    pub fn into_events(self) -> Vec<SessionEventEnvelope> {
        self.rows
            .into_iter()
            .filter_map(SessionReplaySourceRow::into_event)
            .collect()
    }

    pub fn skipped_events(&self) -> &[SessionReplaySourceSkip] {
        &self.skipped_events
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

impl fmt::Debug for SessionReplaySourcePage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionReplaySourcePage")
            .field("has_session_key", &true)
            .field("has_native_session_id", &!self.native_session_id.is_empty())
            .field("source_range", &self.source_range)
            .field("total_source_events", &self.total_source_events)
            .field("row_count", &self.rows.len())
            .field("skipped_event_count", &self.skipped_events.len())
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub enum SessionReplaySourceRow {
    Event(SessionEventEnvelope),
    TranscriptMessage(Message),
    Recovery { source_sequence: u64 },
}

impl SessionReplaySourceRow {
    pub fn event(&self) -> Option<&SessionEventEnvelope> {
        match self {
            Self::Event(event) => Some(event),
            Self::TranscriptMessage(_) | Self::Recovery { .. } => None,
        }
    }

    fn into_event(self) -> Option<SessionEventEnvelope> {
        match self {
            Self::Event(event) => Some(event),
            Self::TranscriptMessage(_) | Self::Recovery { .. } => None,
        }
    }

    pub fn transcript_message(&self) -> Option<&Message> {
        match self {
            Self::TranscriptMessage(message) => Some(message),
            Self::Event(_) | Self::Recovery { .. } => None,
        }
    }
}

impl fmt::Debug for SessionReplaySourceRow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Event(_) => formatter.debug_tuple("Event").field(&"redacted").finish(),
            Self::TranscriptMessage(message) => formatter
                .debug_struct("TranscriptMessage")
                .field("role", &message.role())
                .field("has_message_id", &message.message_id().is_some())
                .field("content_count", &message.content().len())
                .finish(),
            Self::Recovery { source_sequence } => formatter
                .debug_struct("Recovery")
                .field("source_sequence", source_sequence)
                .finish(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalSessionReplay {
    session_key: SessionKey,
    route_key: Option<String>,
    source_epoch: Option<u64>,
    ingress_results: Vec<CanonicalIngressResult>,
}

impl CanonicalSessionReplay {
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn route_key(&self) -> Option<&str> {
        self.route_key.as_deref()
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub fn ingress_results(&self) -> &[CanonicalIngressResult] {
        &self.ingress_results
    }

    pub fn into_ingress_results(self) -> Vec<CanonicalIngressResult> {
        self.ingress_results
    }

    pub fn is_empty(&self) -> bool {
        self.ingress_results.is_empty()
    }
}

impl fmt::Debug for CanonicalSessionReplay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalSessionReplay")
            .field("has_session_key", &true)
            .field("has_route_key", &self.route_key.is_some())
            .field("source_epoch", &self.source_epoch)
            .field("ingress_result_count", &self.ingress_results.len())
            .finish()
    }
}

pub fn load_session_replay_source(
    state_dir: &CanonicalStateDir,
    session_key: SessionKey,
    request: PageRequest,
) -> Result<SessionReplaySourcePage, SessionReplaySourceError> {
    let agent_id = agent_id_from_session_key(&session_key)?;
    let database_path = agent_database_path(state_dir, agent_id.as_str());
    if !database_path.is_file() {
        return Err(SessionReplaySourceError::AgentStoreUnavailable);
    }
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| SessionReplaySourceError::AgentStoreUnavailable)?;
    let native_session_id = read_current_session_id(&connection, &session_key)?;
    let total_source_events = read_source_event_count(&connection, &native_session_id)?;
    let source_range = replay_source_range(total_source_events, request);
    let mut rows = Vec::new();
    let mut skipped_events = Vec::new();

    for row in read_source_rows(&connection, &native_session_id, source_range)? {
        match decode_source_row(&session_key, row.source_sequence, &row.event_json)? {
            SourceRowDecode::Row(row) => rows.push(row),
            SourceRowDecode::Skip(reason) => skipped_events.push(SessionReplaySourceSkip {
                source_sequence: row.source_sequence,
                reason,
            }),
            SourceRowDecode::Recover => {
                rows.push(SessionReplaySourceRow::Recovery {
                    source_sequence: row.source_sequence,
                });
                skipped_events.push(SessionReplaySourceSkip {
                    source_sequence: row.source_sequence,
                    reason: SessionReplaySourceSkipReason::Undecodable,
                });
            }
        }
    }

    Ok(SessionReplaySourcePage {
        session_key,
        native_session_id,
        source_range,
        total_source_events,
        rows,
        skipped_events,
    })
}

pub fn materialize_session_replay(
    session_key: SessionKey,
    events: impl IntoIterator<Item = SessionEventEnvelope>,
    source_epoch: Option<u64>,
    route_key: Option<String>,
) -> Result<CanonicalSessionReplay, SessionReplayError> {
    materialize_session_replay_rows(
        session_key,
        events.into_iter().map(SessionReplaySourceRow::Event),
        source_epoch,
        route_key,
    )
}

pub fn materialize_session_replay_rows(
    session_key: SessionKey,
    rows: impl IntoIterator<Item = SessionReplaySourceRow>,
    source_epoch: Option<u64>,
    route_key: Option<String>,
) -> Result<CanonicalSessionReplay, SessionReplayError> {
    let gateway_epoch = source_epoch
        .map(|epoch| {
            GatewayEpoch::try_new(epoch).map_err(|_| SessionReplayError::InvalidSourceEpoch)
        })
        .transpose()?;
    let mut reducer = SessionReducerActor::new(session_key.clone());
    let mut ingress_results = Vec::new();

    for row in rows {
        match row {
            SessionReplaySourceRow::Event(event) => {
                if let Some(result) = reducer.reduce(event, gateway_epoch, route_key.clone()) {
                    ingress_results.push(result);
                }
            }
            SessionReplaySourceRow::TranscriptMessage(message) => {
                let Some(result) = CanonicalIngressResult::from_transcript_message(
                    session_key.clone(),
                    source_epoch,
                    route_key.clone(),
                    message,
                ) else {
                    continue;
                };
                ingress_results.push(result);
            }
            SessionReplaySourceRow::Recovery { source_sequence } => {
                ingress_results.push(CanonicalIngressResult::from_replay_recovery(
                    session_key.clone(),
                    source_epoch,
                    source_sequence,
                    route_key.clone(),
                ));
            }
        }
    }

    Ok(CanonicalSessionReplay {
        session_key,
        route_key,
        source_epoch,
        ingress_results,
    })
}

struct SourceRow {
    source_sequence: u64,
    event_json: String,
}

enum SourceRowDecode {
    Row(SessionReplaySourceRow),
    Skip(SessionReplaySourceSkipReason),
    Recover,
}

fn replay_source_range(total_source_events: usize, request: PageRequest) -> WindowRange {
    let offset = request
        .offset()
        .unwrap_or(total_source_events)
        .min(total_source_events);
    match request.direction() {
        crate::session_window::Direction::Latest => WindowRange::new(
            total_source_events.saturating_sub(request.limit()),
            total_source_events,
        ),
        crate::session_window::Direction::Older => {
            WindowRange::new(offset.saturating_sub(request.limit()), offset)
        }
        crate::session_window::Direction::Newer => WindowRange::new(
            offset,
            offset
                .saturating_add(request.limit())
                .min(total_source_events),
        ),
    }
}

fn agent_id_from_session_key(
    session_key: &SessionKey,
) -> Result<AgentId, SessionReplaySourceError> {
    let Some(scoped) = session_key.as_str().strip_prefix(AGENT_SESSION_PREFIX) else {
        return Err(SessionReplaySourceError::UnsupportedSessionKey);
    };
    let Some((agent_id, rest)) = scoped.split_once(':') else {
        return Err(SessionReplaySourceError::UnsupportedSessionKey);
    };
    if rest.is_empty() || rest.starts_with(':') {
        return Err(SessionReplaySourceError::UnsupportedSessionKey);
    }
    AgentId::try_new(agent_id.to_owned())
        .map_err(|_| SessionReplaySourceError::UnsupportedSessionKey)
}

fn agent_database_path(state_dir: &CanonicalStateDir, agent_id: &str) -> PathBuf {
    state_dir
        .as_path()
        .join("agents")
        .join(agent_id)
        .join("agent")
        .join(AGENT_DATABASE_NAME)
}

fn read_current_session_id(
    connection: &Connection,
    session_key: &SessionKey,
) -> Result<String, SessionReplaySourceError> {
    connection
        .query_row(
            "SELECT current_session_id FROM session_nodes WHERE session_key = ?1",
            [session_key.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| SessionReplaySourceError::StoreReadFailed)?
        .ok_or(SessionReplaySourceError::SessionUnavailable)
}

fn read_source_event_count(
    connection: &Connection,
    native_session_id: &str,
) -> Result<usize, SessionReplaySourceError> {
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM transcript_events WHERE session_id = ?1",
            [native_session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
    if count < 0 {
        return Err(SessionReplaySourceError::StoreReadFailed);
    }
    usize::try_from(count).map_err(|_| SessionReplaySourceError::StoreReadFailed)
}

fn read_source_rows(
    connection: &Connection,
    native_session_id: &str,
    source_range: WindowRange,
) -> Result<Vec<SourceRow>, SessionReplaySourceError> {
    let limit = source_range.end().saturating_sub(source_range.start());
    if limit == 0 {
        return Ok(Vec::new());
    }
    let limit = i64::try_from(limit).map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
    let offset = i64::try_from(source_range.start())
        .map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
    let mut statement = connection
        .prepare(
            "SELECT seq, event_json FROM transcript_events \
             WHERE session_id = ?1 ORDER BY seq ASC LIMIT ?2 OFFSET ?3",
        )
        .map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
    let rows = statement
        .query_map(params![native_session_id, limit, offset], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
    let mut source_rows = Vec::new();
    for row in rows {
        let (source_sequence, event_json) =
            row.map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
        source_rows.push(SourceRow {
            source_sequence: source_sequence_u64(source_sequence)?,
            event_json,
        });
    }
    Ok(source_rows)
}

fn source_sequence_u64(value: i64) -> Result<u64, SessionReplaySourceError> {
    let sequence = u64::try_from(value).map_err(|_| SessionReplaySourceError::StoreReadFailed)?;
    if sequence > MAX_SAFE_SEQUENCE {
        return Err(SessionReplaySourceError::StoreReadFailed);
    }
    Ok(sequence)
}

fn decode_source_row(
    session_key: &SessionKey,
    source_sequence: u64,
    event_json: &str,
) -> Result<SourceRowDecode, SessionReplaySourceError> {
    let value: Value =
        serde_json::from_str(event_json).map_err(|_| SessionReplaySourceError::SourceMalformed)?;
    let object = value
        .as_object()
        .ok_or(SessionReplaySourceError::SourceMalformed)?;
    match stored_gateway_event_name(object) {
        StoredGatewayEventName::Named(name) => {
            return decode_gateway_source_event(session_key, source_sequence, name, object);
        }
        StoredGatewayEventName::Malformed => return Ok(SourceRowDecode::Recover),
        StoredGatewayEventName::NotGateway => {}
    }
    decode_transcript_source_event(session_key, source_sequence, object)
}

enum StoredGatewayEventName<'a> {
    Named(&'a str),
    Malformed,
    NotGateway,
}

fn stored_gateway_event_name(object: &Map<String, Value>) -> StoredGatewayEventName<'_> {
    let name = object
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| object.get("name").and_then(Value::as_str))
        .filter(|name| !name.is_empty());
    if object.get("type").and_then(Value::as_str) == Some("event") {
        return name.map_or(
            StoredGatewayEventName::Malformed,
            StoredGatewayEventName::Named,
        );
    }
    if object.contains_key("type") {
        return StoredGatewayEventName::NotGateway;
    }
    if object.contains_key("event") || object.contains_key("name") {
        return name.map_or(
            StoredGatewayEventName::Malformed,
            StoredGatewayEventName::Named,
        );
    }
    StoredGatewayEventName::NotGateway
}

fn decode_gateway_source_event(
    session_key: &SessionKey,
    source_sequence: u64,
    name: &str,
    object: &Map<String, Value>,
) -> Result<SourceRowDecode, SessionReplaySourceError> {
    let decoded = match decode_session_event(GatewayEvent {
        name: name.to_owned(),
        payload: object.get("payload").cloned(),
        sequence: Some(source_sequence),
        state_version: None,
    }) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(SourceRowDecode::Recover),
    };
    let Some(event) = decoded else {
        return Ok(SourceRowDecode::Skip(
            SessionReplaySourceSkipReason::UnsupportedEvent,
        ));
    };
    if &event.session_key != session_key {
        return Err(SessionReplaySourceError::SourceUndecodable { source_sequence });
    }
    Ok(SourceRowDecode::Row(SessionReplaySourceRow::Event(event)))
}

fn decode_transcript_source_event(
    _session_key: &SessionKey,
    source_sequence: u64,
    object: &Map<String, Value>,
) -> Result<SourceRowDecode, SessionReplaySourceError> {
    match object.get("type").and_then(Value::as_str) {
        Some("message") => decode_transcript_message_source(source_sequence, object),
        None if object.contains_key("message") => {
            decode_transcript_message_source(source_sequence, object)
        }
        Some(_) | None => Ok(SourceRowDecode::Skip(
            SessionReplaySourceSkipReason::Metadata,
        )),
    }
}

fn decode_transcript_message_source(
    source_sequence: u64,
    object: &Map<String, Value>,
) -> Result<SourceRowDecode, SessionReplaySourceError> {
    match decode_transcript_event_message(source_sequence, object) {
        Ok(message) => Ok(SourceRowDecode::Row(
            SessionReplaySourceRow::TranscriptMessage(message),
        )),
        Err(_) => Ok(SourceRowDecode::Recover),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    use serde_json::json;

    use super::*;
    use crate::{
        gateway::{ingress::GatewayEpoch, wire::GatewayEvent},
        session::{
            events::TerminalOutcome,
            projection::{AssistantTurnChunkKind, CanonicalSessionChange},
            protocol::{ToolActivityPhase, decode_session_event},
            reducer::SessionReducerActor,
        },
    };

    static NEXT_TEST_STATE: AtomicU64 = AtomicU64::new(1);

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn epoch(value: u64) -> GatewayEpoch {
        GatewayEpoch::try_new(value).unwrap()
    }

    fn decode(name: &str, payload: serde_json::Value, sequence: u64) -> SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: name.to_owned(),
            payload: Some(payload),
            sequence: Some(sequence),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    fn chat_snapshot(sequence: u64, content: &str) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "delta",
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": content}]
                }
            }),
            sequence,
        )
    }

    fn terminal_snapshot(sequence: u64) -> SessionEventEnvelope {
        decode(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": sequence,
                "state": "final",
                "message": {
                    "id": "message-1",
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "plan"},
                        {"type": "text", "text": "answer"}
                    ]
                }
            }),
            sequence,
        )
    }

    fn tool_event(sequence: u64, phase: &str) -> SessionEventEnvelope {
        tool_event_with_id(sequence, phase, "tool-1")
    }

    fn tool_event_with_id(sequence: u64, phase: &str, tool_call_id: &str) -> SessionEventEnvelope {
        decode(
            "session.tool",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "phase": phase,
                "toolCallId": tool_call_id,
                "toolName": "read",
                "args": {"path": "Cargo.toml"},
                "summary": format!("tool {phase}"),
                "partialResult": {"partial": true},
                "result": {"ok": true},
                "isError": false
            }),
            sequence,
        )
    }

    fn approval_event(sequence: u64, name: &str) -> SessionEventEnvelope {
        decode(
            name,
            json!({
                "id": "approval-1",
                "request": {
                    "sessionKey": "agent:main:session-1",
                    "runId": "run-1",
                    "allowedDecisions": ["allow-once", "deny"]
                }
            }),
            sequence,
        )
    }

    fn produced_delta(
        result: &CanonicalIngressResult,
    ) -> &super::super::projection::CanonicalSessionDelta {
        let CanonicalIngressResult::Produced(delta) = result else {
            panic!("expected produced canonical replay delta");
        };
        delta
    }

    fn produced_change(result: Option<CanonicalIngressResult>) -> CanonicalSessionChange {
        let Some(CanonicalIngressResult::Produced(delta)) = result else {
            panic!("expected produced canonical delta");
        };
        assert_eq!(delta.changes().len(), 1);
        delta.changes()[0].clone()
    }

    fn test_state_dir() -> CanonicalStateDir {
        let sequence = NEXT_TEST_STATE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "openclaw-replay-source-{}-{sequence}",
            std::process::id()
        ));
        CanonicalStateDir::provision(path).unwrap()
    }

    fn write_agent_store(state_dir: &CanonicalStateDir, events: &[serde_json::Value]) {
        let event_json = events
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>();
        write_agent_store_rows(state_dir, &event_json);
    }

    fn write_agent_store_rows(state_dir: &CanonicalStateDir, event_json: &[String]) {
        let database_dir = state_dir
            .as_path()
            .join("agents")
            .join("main")
            .join("agent");
        fs::create_dir_all(&database_dir).unwrap();
        let connection = Connection::open(database_dir.join(AGENT_DATABASE_NAME)).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
                 CREATE TABLE transcript_events (
                    session_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    event_json TEXT NOT NULL,
                    PRIMARY KEY (session_id, seq)
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_nodes (session_key, current_session_id) VALUES (?1, ?2)",
                params!["agent:main:session-1", "native-session-1"],
            )
            .unwrap();
        for (index, event_json) in event_json.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?1, ?2, ?3)",
                    params!["native-session-1", i64::try_from(index + 1).unwrap(), event_json],
                )
                .unwrap();
        }
    }

    #[test]
    fn replay_uses_temporary_reducer_without_polluting_live_reducer() {
        let mut live = SessionReducerActor::new(session_key());
        assert!(matches!(
            produced_change(live.reduce(chat_snapshot(1, "live"), Some(epoch(1)), None)),
            CanonicalSessionChange::AssistantTurnChunk {
                kind: AssistantTurnChunkKind::Text,
                text,
                ..
            } if text == "live"
        ));

        let replay = materialize_session_replay(
            session_key(),
            [chat_snapshot(2, "history replay")],
            Some(9),
            None,
        )
        .unwrap();
        assert_eq!(replay.source_epoch(), Some(9));
        assert_eq!(replay.ingress_results().len(), 1);

        assert!(matches!(
            produced_change(live.reduce(chat_snapshot(3, "live after"), Some(epoch(1)), None)),
            CanonicalSessionChange::AssistantTurnChunk {
                kind: AssistantTurnChunkKind::Text,
                text,
                ..
            } if text == " after"
        ));
    }

    #[test]
    fn terminal_replay_processes_snapshot_before_terminal() {
        let replay = materialize_session_replay(
            session_key(),
            [terminal_snapshot(1)],
            Some(42),
            Some("route-1".to_owned()),
        )
        .unwrap();
        assert_eq!(replay.session_key().as_str(), "agent:main:session-1");
        assert_eq!(replay.route_key(), Some("route-1"));
        assert_eq!(replay.source_epoch(), Some(42));
        assert_eq!(replay.ingress_results().len(), 1);

        let delta = produced_delta(&replay.ingress_results()[0]);
        assert_eq!(delta.route_key(), Some("route-1"));
        assert_eq!(delta.source_epoch(), Some(42));
        assert!(matches!(
            delta.changes(),
            [
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Thinking,
                    text: thinking,
                    ..
                },
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Text,
                    text,
                    ..
                },
                CanonicalSessionChange::Terminal {
                    outcome: TerminalOutcome::Completed,
                    ..
                }
            ] if text == "answer" && thinking == "plan"
        ));
    }

    #[test]
    fn replay_preserves_assistant_snapshot_tool_snapshot_order() {
        let replay = materialize_session_replay(
            session_key(),
            [
                chat_snapshot(1, "before"),
                tool_event_with_id(2, "start", "tool-1"),
                chat_snapshot(3, "before after"),
            ],
            Some(10),
            None,
        )
        .unwrap();

        let changes = replay
            .ingress_results()
            .iter()
            .map(produced_delta)
            .map(|delta| {
                assert_eq!(delta.changes().len(), 1);
                &delta.changes()[0]
            })
            .collect::<Vec<_>>();

        assert!(matches!(
            changes.as_slice(),
            [
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Text,
                    text: before,
                    ..
                },
                CanonicalSessionChange::ToolActivity { tool_id, .. },
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Text,
                    text: after,
                    ..
                },
            ] if before == "before" && tool_id.as_str() == "tool-1" && after == " after"
        ));
    }

    #[test]
    fn tool_and_approval_replay_outputs_canonical_results() {
        let replay = materialize_session_replay(
            session_key(),
            [
                tool_event(1, "start"),
                tool_event(2, "start"),
                tool_event(3, "update"),
                tool_event(4, "result"),
                tool_event(5, "start"),
                approval_event(6, "exec.approval.requested"),
                approval_event(7, "exec.approval.requested"),
                approval_event(8, "exec.approval.resolved"),
            ],
            Some(11),
            Some("route-1".to_owned()),
        )
        .unwrap();

        let changes = replay
            .ingress_results()
            .iter()
            .map(produced_delta)
            .map(|delta| {
                assert_eq!(delta.route_key(), Some("route-1"));
                assert_eq!(delta.source_epoch(), Some(11));
                assert_eq!(delta.changes().len(), 1);
                &delta.changes()[0]
            })
            .collect::<Vec<_>>();

        assert_eq!(changes.len(), 5);
        assert!(matches!(
            changes.as_slice(),
            [
                CanonicalSessionChange::ToolActivity {
                    phase: ToolActivityPhase::Started,
                    ..
                },
                CanonicalSessionChange::ToolActivity {
                    phase: ToolActivityPhase::Updated,
                    ..
                },
                CanonicalSessionChange::ToolActivity {
                    phase: ToolActivityPhase::Completed,
                    ..
                },
                CanonicalSessionChange::ApprovalRequested { option_ids, .. },
                CanonicalSessionChange::ApprovalResolved { option_ids: resolved, .. },
            ] if option_ids.len() == 2 && resolved.len() == 2
        ));
    }

    #[test]
    fn replay_rejects_invalid_source_epoch() {
        assert_eq!(
            materialize_session_replay(session_key(), [], Some(0), None),
            Err(SessionReplayError::InvalidSourceEpoch)
        );
    }

    #[test]
    fn sqlite_source_replays_text_snapshot_growth_only() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[
                json!({"type":"session","id":"native-session-1"}),
                json!({
                    "type":"event",
                    "event":"chat",
                    "payload":{
                        "sessionKey":"agent:main:session-1",
                        "runId":"run-1",
                        "seq":2,
                        "state":"delta",
                        "message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"hello"}]}
                    }
                }),
                json!({
                    "type":"event",
                    "event":"chat",
                    "payload":{
                        "sessionKey":"agent:main:session-1",
                        "runId":"run-1",
                        "seq":3,
                        "state":"delta",
                        "message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"hello"}]}
                    }
                }),
                json!({
                    "type":"event",
                    "event":"chat",
                    "payload":{
                        "sessionKey":"agent:main:session-1",
                        "runId":"run-1",
                        "seq":4,
                        "state":"delta",
                        "message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"hello world"}]}
                    }
                }),
            ],
        );

        let source =
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()).unwrap();
        assert_eq!(source.total_source_events(), 4);
        assert_eq!(source.events().len(), 3);
        assert_eq!(source.skipped_events().len(), 1);
        assert_eq!(
            source.skipped_events()[0].reason(),
            SessionReplaySourceSkipReason::Metadata
        );
        let replay = materialize_session_replay(
            source.session_key().clone(),
            source.events().iter().cloned(),
            Some(5),
            None,
        )
        .unwrap();

        let chunks = replay
            .ingress_results()
            .iter()
            .map(produced_delta)
            .flat_map(|delta| delta.changes())
            .filter_map(|change| match change {
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Text,
                    text,
                    ..
                } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(chunks, ["hello", " world"]);
    }

    #[test]
    fn sqlite_gateway_event_source_decodes_thinking_text_and_terminal_order() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[
                json!({"type":"session","id":"native-session-1"}),
                json!({
                    "type":"event",
                    "event":"chat",
                    "payload":{
                        "sessionKey":"agent:main:session-1",
                        "runId":"run-1",
                        "seq":2,
                        "state":"final",
                        "message":{
                            "id":"message-1",
                            "role":"assistant",
                            "content":[
                                {"type":"thinking","thinking":"plan"},
                                {"type":"text","text":"answer"}
                            ]
                        }
                    }
                }),
            ],
        );

        let source =
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()).unwrap();
        assert_eq!(source.native_session_id(), "native-session-1");
        assert_eq!(source.events().len(), 1);
        assert_eq!(source.skipped_events().len(), 1);
        let replay = materialize_session_replay(
            source.session_key().clone(),
            source.into_events(),
            Some(6),
            Some("route-1".to_owned()),
        )
        .unwrap();
        assert_eq!(replay.ingress_results().len(), 1);

        let delta = produced_delta(&replay.ingress_results()[0]);
        assert_eq!(delta.route_key(), Some("route-1"));
        assert!(matches!(
            delta.changes(),
            [
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Thinking,
                    text: thinking,
                    ..
                },
                CanonicalSessionChange::AssistantTurnChunk {
                    kind: AssistantTurnChunkKind::Text,
                    text,
                    ..
                },
                CanonicalSessionChange::Terminal {
                    outcome: TerminalOutcome::Completed,
                    ..
                }
            ] if text == "answer" && thinking == "plan"
        ));
    }

    #[test]
    fn sqlite_raw_transcript_messages_materialize_canonical_replay() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[
                json!({"type":"session","id":"native-session-1"}),
                json!({
                    "type":"message",
                    "id":"user-1",
                    "parentId":null,
                    "timestamp":"2026-09-05T00:00:00.000Z",
                    "message":{"role":"user","content":"question"}
                }),
                json!({
                    "type":"message",
                    "id":"message-1",
                    "parentId":"user-1",
                    "timestamp":"2026-09-05T00:00:01.000Z",
                    "message":{
                        "role":"assistant",
                        "runId":"run-1",
                        "content":[
                            {"type":"thinking","thinking":"plan"},
                            {"type":"output_text","text":"answer"}
                        ]
                    }
                }),
            ],
        );

        let source =
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()).unwrap();
        assert_eq!(source.events().len(), 0);
        assert_eq!(source.rows().len(), 2);
        let replay = materialize_session_replay_rows(
            source.session_key().clone(),
            source.into_rows(),
            Some(7),
            None,
        )
        .unwrap();
        assert_eq!(replay.ingress_results().len(), 2);

        let changes = replay
            .ingress_results()
            .iter()
            .map(produced_delta)
            .flat_map(|delta| delta.changes())
            .collect::<Vec<_>>();
        assert!(matches!(
            changes.as_slice(),
            [
                CanonicalSessionChange::TranscriptMessage { message: user },
                CanonicalSessionChange::TranscriptMessage { message: assistant }
            ] if user.role() == crate::session_window::MessageRole::User
                && user.message_id() == Some("user-1")
                && user.sequence() == Some(2)
                && user.text() == "question"
                && assistant.role() == crate::session_window::MessageRole::Assistant
                && assistant.message_id() == Some("message-1")
                && assistant.parent_id() == Some("user-1")
                && assistant.run_id() == Some("run-1")
                && assistant.sequence() == Some(3)
                && assistant.text() == "answer"
                && assistant.content().iter().any(|content| matches!(content, crate::session_window::MessageContent::Thinking { text } if text == "plan"))
        ));
    }

    #[test]
    fn sqlite_unknown_transcript_metadata_rows_are_skipped() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[
                json!({"type":"session","id":"native-session-1"}),
                json!({"type":"message","id":"user-1","message":{"role":"user","content":"question"}}),
                json!({"type":"custom","private":"metadata"}),
                json!({"type":"proof","value":{"opaque":true}}),
                json!({"type":"leaf","id":"leaf-1"}),
                json!({"type":"label","text":"topic"}),
                json!({"type":"model_change","model":"claude"}),
                json!({"type":"message","id":"assistant-1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}),
            ],
        );

        let source =
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()).unwrap();
        assert_eq!(source.rows().len(), 2);
        assert_eq!(source.skipped_events().len(), 6);
        assert!(
            source
                .skipped_events()
                .iter()
                .all(|event| event.reason() == SessionReplaySourceSkipReason::Metadata)
        );
    }

    #[test]
    fn sqlite_bad_chat_fact_rows_recover_without_rejecting_page() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[
                json!({"type":"session","id":"native-session-1"}),
                json!({"type":"message","id":"user-1","message":{"role":"user","content":"question"}}),
                json!({"type":"message","id":"bad-message","message":{"content":"missing role"}}),
                json!({"type":"event","event":"chat","payload":{"sessionKey":"agent:main:session-1","state":"delta"}}),
                json!({"type":"message","id":"assistant-1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}),
            ],
        );

        let source =
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()).unwrap();
        assert_eq!(source.rows().len(), 4);
        assert_eq!(source.skipped_events().len(), 3);
        assert_eq!(
            source.skipped_events()[0].reason(),
            SessionReplaySourceSkipReason::Metadata
        );
        assert_eq!(
            source.skipped_events()[1].reason(),
            SessionReplaySourceSkipReason::Undecodable
        );
        assert_eq!(
            source.skipped_events()[2].reason(),
            SessionReplaySourceSkipReason::Undecodable
        );

        let replay = materialize_session_replay_rows(
            source.session_key().clone(),
            source.into_rows(),
            Some(8),
            None,
        )
        .unwrap();
        let changes = replay
            .ingress_results()
            .iter()
            .map(produced_delta)
            .flat_map(|delta| delta.changes())
            .collect::<Vec<_>>();
        assert!(matches!(
            changes.as_slice(),
            [
                CanonicalSessionChange::TranscriptMessage { .. },
                CanonicalSessionChange::RecoveryRequired { .. },
                CanonicalSessionChange::RecoveryRequired { .. },
                CanonicalSessionChange::TranscriptMessage { .. },
            ]
        ));
    }

    #[test]
    fn sqlite_no_type_message_row_replays_as_transcript_message() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[
                json!({"message":{"role":"user","content":"legacy question"}}),
                json!({"type":"custom","messageId":"metadata-only"}),
            ],
        );

        let source =
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()).unwrap();
        assert_eq!(source.rows().len(), 1);
        assert_eq!(source.skipped_events().len(), 1);
        let replay = materialize_session_replay_rows(
            source.session_key().clone(),
            source.into_rows(),
            Some(9),
            None,
        )
        .unwrap();
        let changes = replay
            .ingress_results()
            .iter()
            .map(produced_delta)
            .flat_map(|delta| delta.changes())
            .collect::<Vec<_>>();
        assert!(matches!(
            changes.as_slice(),
            [CanonicalSessionChange::TranscriptMessage { message }]
                if message.text() == "legacy question" && message.sequence() == Some(1)
        ));
    }

    #[test]
    fn sqlite_malformed_json_still_rejects_source_page() {
        let state_dir = test_state_dir();
        write_agent_store_rows(
            &state_dir,
            &[
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"ok\"}}"
                    .to_owned(),
                "{".to_owned(),
            ],
        );

        assert_eq!(
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()),
            Err(SessionReplaySourceError::SourceMalformed)
        );
    }

    #[test]
    fn sqlite_gateway_identity_mismatch_still_rejects_source_page() {
        let state_dir = test_state_dir();
        write_agent_store(
            &state_dir,
            &[json!({
                "type":"event",
                "event":"chat",
                "payload":{
                    "sessionKey":"agent:main:other-session",
                    "runId":"run-1",
                    "seq":1,
                    "state":"delta",
                    "message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"wrong"}]}
                }
            })],
        );

        assert_eq!(
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()),
            Err(SessionReplaySourceError::SourceUndecodable { source_sequence: 1 })
        );
    }

    #[test]
    fn sqlite_source_reports_unavailable_store_and_unsupported_keys() {
        let state_dir = test_state_dir();
        assert_eq!(
            load_session_replay_source(&state_dir, session_key(), PageRequest::latest()),
            Err(SessionReplaySourceError::AgentStoreUnavailable)
        );
        assert_eq!(
            load_session_replay_source(
                &state_dir,
                SessionKey::try_new("session-1").unwrap(),
                PageRequest::latest(),
            ),
            Err(SessionReplaySourceError::UnsupportedSessionKey)
        );
    }
}
