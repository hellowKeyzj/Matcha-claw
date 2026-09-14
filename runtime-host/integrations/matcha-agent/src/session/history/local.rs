use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{self, File, Metadata},
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::session::{
    history::{HistoryContentChunk, HistoryResult},
    hydration::{self, HydrationSnapshot, HydrationWindowRequest},
    model::SessionId,
};

const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";
const PROJECTS_DIR: &str = "projects";
const JSONL_EXTENSION: &str = "jsonl";
const LIST_LIMIT: usize = 200;
const MAX_SANITIZED_LENGTH: usize = 200;
const TRANSCRIPT_MAX_LINES: usize = 10_000;
const MAX_TEXT_PREVIEW_BYTES: usize = 64 * 1024;
const DEFAULT_CONTENT_CHUNK_BYTES: usize = 64 * 1024;
const IMAGE_MEDIA_TYPES: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

#[derive(Clone)]
pub struct LocalHistoryReader {
    project_dir: Option<PathBuf>,
    project_dir_prefix: Option<String>,
    scope: LocalHistoryScope,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum LocalHistoryScope {
    Projects,
    Project,
}

#[derive(Clone, Eq, PartialEq)]
pub struct LocalHistoryCatalog {
    sessions: Vec<LocalHistorySession>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct LocalHistorySession {
    session_id: SessionId,
    updated_at: Option<u64>,
}

#[derive(Clone)]
struct SessionFile {
    session_id: SessionId,
    path: PathBuf,
    updated_at: Option<u64>,
}

#[derive(Clone)]
struct TranscriptMessage {
    uuid: String,
    parent_uuid: Option<String>,
    entry_type: EntryType,
    is_sidechain: bool,
    session_id: Option<String>,
    timestamp: Option<String>,
    message: Option<Value>,
    content: Option<Value>,
    source_index: usize,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum EntryType {
    User,
    Assistant,
    System,
    Attachment,
}

impl LocalHistoryReader {
    pub fn from_environment() -> Self {
        Self {
            project_dir: claude_config_home_from_environment().map(|home| home.join(PROJECTS_DIR)),
            project_dir_prefix: None,
            scope: LocalHistoryScope::Projects,
        }
    }

    pub fn for_workspace(cwd: impl Into<PathBuf>) -> Self {
        let (project_dir, project_dir_prefix) = workspace_project_dir(cwd.into());
        Self {
            project_dir,
            project_dir_prefix,
            scope: LocalHistoryScope::Project,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_project_dir(project_dir: PathBuf) -> Self {
        Self {
            project_dir: Some(project_dir),
            project_dir_prefix: None,
            scope: LocalHistoryScope::Projects,
        }
    }

    #[cfg(test)]
    fn from_workspace_project_dir(
        project_dir: PathBuf,
        project_dir_prefix: Option<String>,
    ) -> Self {
        Self {
            project_dir: Some(project_dir),
            project_dir_prefix,
            scope: LocalHistoryScope::Project,
        }
    }

    pub async fn list(&self) -> HistoryResult<LocalHistoryCatalog> {
        let reader = self.clone();
        match tokio::task::spawn_blocking(move || reader.list_blocking()).await {
            Ok(Ok(catalog)) => HistoryResult::Complete(catalog),
            Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => {
                HistoryResult::Complete(LocalHistoryCatalog::empty())
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidInput => {
                HistoryResult::Unavailable
            }
            Ok(Err(_)) | Err(_) => HistoryResult::Unknown,
        }
    }

    pub async fn load(
        &self,
        session_id: SessionId,
        request: HydrationWindowRequest,
    ) -> HistoryResult<HydrationSnapshot> {
        let reader = self.clone();
        match tokio::task::spawn_blocking(move || reader.load_blocking(session_id, request)).await {
            Ok(result) => result,
            Err(_) => HistoryResult::Unknown,
        }
    }

    pub async fn load_content(
        &self,
        session_id: SessionId,
        content_ref: String,
        offset: u64,
        limit: usize,
    ) -> HistoryResult<HistoryContentChunk> {
        let reader = self.clone();
        match tokio::task::spawn_blocking(move || {
            reader.load_content_blocking(session_id, content_ref, offset, limit)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => HistoryResult::Unknown,
        }
    }

    fn list_blocking(&self) -> io::Result<LocalHistoryCatalog> {
        let mut sessions = self
            .session_files()?
            .into_values()
            .map(|file| LocalHistorySession {
                session_id: file.session_id,
                updated_at: file.updated_at,
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.session_id.as_str().cmp(right.session_id.as_str()))
        });
        sessions.truncate(LIST_LIMIT);
        Ok(LocalHistoryCatalog { sessions })
    }

    fn load_blocking(
        &self,
        session_id: SessionId,
        request: HydrationWindowRequest,
    ) -> HistoryResult<HydrationSnapshot> {
        let file = match self.session_file(&session_id) {
            Ok(Some(file)) => file,
            Ok(None) => return HistoryResult::NotFound,
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                return HistoryResult::Unavailable;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return HistoryResult::NotFound;
            }
            Err(_) => return HistoryResult::Unknown,
        };
        let lines = match replay_lines(&file.path) {
            Ok(lines) => lines,
            Err(_) => return HistoryResult::Unknown,
        };
        match hydration::hydrate_lines(&lines, request) {
            Ok(snapshot) => HistoryResult::Complete(snapshot),
            Err(reason) => HistoryResult::Incomplete(reason),
        }
    }

    fn load_content_blocking(
        &self,
        session_id: SessionId,
        content_ref: String,
        offset: u64,
        limit: usize,
    ) -> HistoryResult<HistoryContentChunk> {
        let file = match self.session_file(&session_id) {
            Ok(Some(file)) => file,
            Ok(None) => return HistoryResult::NotFound,
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                return HistoryResult::Unavailable;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return HistoryResult::NotFound;
            }
            Err(_) => return HistoryResult::Unknown,
        };
        let messages = match read_transcript_messages(&file.path) {
            Ok(messages) => messages,
            Err(_) => return HistoryResult::Unknown,
        };
        let chain = replay_chain(&messages);
        let Some(text) = find_large_text(&chain, &content_ref) else {
            return HistoryResult::NotFound;
        };
        let Some((chunk, next_offset)) = text_chunk(text, offset, limit) else {
            return HistoryResult::NotFound;
        };
        HistoryResult::Complete(HistoryContentChunk::new(
            content_ref,
            offset,
            chunk.to_owned(),
            next_offset,
            text.len() as u64,
        ))
    }

    fn session_file(&self, session_id: &SessionId) -> io::Result<Option<SessionFile>> {
        Ok(self.session_files()?.remove(session_id.as_str()))
    }

    fn session_files(&self) -> io::Result<HashMap<String, SessionFile>> {
        let Some(project_dir) = &self.project_dir else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "claude config home is unavailable",
            ));
        };
        let mut by_session = HashMap::<String, SessionFile>::new();
        if let Some(prefix) = &self.project_dir_prefix
            && !project_dir.is_dir()
            && let Some(resolved) = find_project_dir_with_prefix(project_dir, prefix)
        {
            collect_project_session_files(&resolved, &mut by_session);
            return Ok(by_session);
        }
        match self.scope {
            LocalHistoryScope::Projects => {
                for entry in fs::read_dir(project_dir)? {
                    let Ok(entry) = entry else { continue };
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };
                    if file_type.is_dir() {
                        collect_project_session_files(&entry.path(), &mut by_session);
                    } else if file_type.is_file() {
                        collect_session_file(&entry.path(), &mut by_session);
                    }
                }
            }
            LocalHistoryScope::Project => {
                collect_project_session_files(project_dir, &mut by_session);
            }
        }
        Ok(by_session)
    }
}

impl LocalHistoryCatalog {
    fn empty() -> Self {
        Self {
            sessions: Vec::new(),
        }
    }

    pub fn sessions(&self) -> &[LocalHistorySession] {
        &self.sessions
    }
}

impl LocalHistorySession {
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub const fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }
}

impl fmt::Debug for LocalHistoryReader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalHistoryReader")
            .field("has_project_dir", &self.project_dir.is_some())
            .field("has_project_dir_prefix", &self.project_dir_prefix.is_some())
            .finish()
    }
}

impl fmt::Debug for LocalHistoryCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalHistoryCatalog")
            .field("session_count", &self.sessions.len())
            .finish()
    }
}

impl fmt::Debug for LocalHistorySession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalHistorySession")
            .field("has_session_id", &true)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

fn workspace_project_dir(cwd: PathBuf) -> (Option<PathBuf>, Option<String>) {
    let Some(home) = claude_config_home_from_environment() else {
        return (None, None);
    };
    workspace_project_dir_at(home, &cwd)
}

fn workspace_project_dir_at(home: PathBuf, cwd: &Path) -> (Option<PathBuf>, Option<String>) {
    let Some(workspace) = workspace_path_string(cwd) else {
        return (None, None);
    };
    let sanitized = sanitize_path(&workspace);
    let project_dir = home.join(PROJECTS_DIR).join(&sanitized);
    let prefix = (sanitized.len() > MAX_SANITIZED_LENGTH)
        .then(|| sanitized[..MAX_SANITIZED_LENGTH].to_owned());
    (Some(project_dir), prefix)
}

fn workspace_path_string(cwd: &Path) -> Option<String> {
    let path = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    portable_path_string(&path)
}

#[cfg(windows)]
fn portable_path_string(path: &Path) -> Option<String> {
    let value = path.to_str()?;
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{value}"));
    }
    Some(value.strip_prefix(r"\\?\").unwrap_or(value).to_owned())
}

#[cfg(not(windows))]
fn portable_path_string(path: &Path) -> Option<String> {
    path.to_str().map(str::to_owned)
}

fn sanitize_path(value: &str) -> String {
    let sanitized = value
        .encode_utf16()
        .map(|unit| match unit {
            0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a => {
                char::from_u32(u32::from(unit)).expect("ASCII alphanumeric is valid char")
            }
            _ => '-',
        })
        .collect::<String>();
    if sanitized.len() <= MAX_SANITIZED_LENGTH {
        return sanitized;
    }
    format!(
        "{}-{}",
        &sanitized[..MAX_SANITIZED_LENGTH],
        base36_abs(djb2_hash(value))
    )
}

fn djb2_hash(value: &str) -> i32 {
    value.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit))
    })
}

fn base36_abs(value: i32) -> String {
    let mut value = value.unsigned_abs();
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = value % 36;
        digits.push(match digit {
            0..=9 => (b'0' + digit as u8) as char,
            _ => (b'a' + (digit - 10) as u8) as char,
        });
        value /= 36;
    }
    digits.iter().rev().collect()
}

fn find_project_dir_with_prefix(project_dir: &Path, prefix: &str) -> Option<PathBuf> {
    let projects_dir = project_dir.parent()?;
    let entries = fs::read_dir(projects_dir).ok()?;
    let prefix = format!("{prefix}-");
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(&prefix) {
            return Some(entry.path());
        }
    }
    None
}

fn collect_project_session_files(project_dir: &Path, sessions: &mut HashMap<String, SessionFile>) {
    let Ok(entries) = fs::read_dir(project_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() {
            collect_session_file(&entry.path(), sessions);
        }
    }
}

fn collect_session_file(path: &Path, sessions: &mut HashMap<String, SessionFile>) {
    if path.extension().and_then(|extension| extension.to_str()) != Some(JSONL_EXTENSION) {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return;
    }
    let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
        return;
    };
    let Ok(session_id) = SessionId::try_new(stem.to_owned()) else {
        return;
    };
    let updated_at = modified_millis(&metadata);
    let file = SessionFile {
        session_id,
        path: path.to_owned(),
        updated_at,
    };
    match sessions.get(stem) {
        Some(existing) if existing.updated_at >= file.updated_at => {}
        _ => {
            sessions.insert(stem.to_owned(), file);
        }
    }
}

fn replay_lines(path: &Path) -> io::Result<Vec<String>> {
    let messages = read_transcript_messages(path)?;
    let chain = replay_chain(&messages);
    let start = chain.len().saturating_sub(TRANSCRIPT_MAX_LINES);
    Ok(chain[start..]
        .iter()
        .filter_map(|message| transcript_replay_line(message))
        .collect())
}

fn read_transcript_messages(path: &Path) -> io::Result<HashMap<String, TranscriptMessage>> {
    let file = File::open(path)?;
    let mut messages = HashMap::<String, TranscriptMessage>::new();
    let mut progress_bridge = HashMap::<String, Option<String>>::new();
    let mut source_index = 0usize;
    for line in BufReader::new(file).lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };
        let entry_type = object.get("type").and_then(Value::as_str);
        let uuid = object
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let parent_uuid = object
            .get("parentUuid")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if entry_type == Some("progress") {
            if let Some(uuid) = uuid {
                let parent = parent_uuid.and_then(|parent| {
                    progress_bridge
                        .get(&parent)
                        .cloned()
                        .unwrap_or(Some(parent))
                });
                progress_bridge.insert(uuid, parent);
            }
            continue;
        }
        let Some(entry_type) = entry_type.and_then(EntryType::from_raw) else {
            continue;
        };
        let Some(uuid) = uuid else {
            continue;
        };
        let parent_uuid = parent_uuid.and_then(|parent| {
            progress_bridge
                .get(&parent)
                .cloned()
                .unwrap_or(Some(parent))
        });
        messages.insert(
            uuid.clone(),
            TranscriptMessage {
                uuid,
                parent_uuid,
                entry_type,
                is_sidechain: object
                    .get("isSidechain")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                session_id: object
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                timestamp: object
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                message: object.get("message").cloned(),
                content: object.get("content").cloned(),
                source_index,
            },
        );
        source_index = source_index.saturating_add(1);
    }
    Ok(messages)
}

fn replay_chain(messages: &HashMap<String, TranscriptMessage>) -> Vec<&TranscriptMessage> {
    let Some(leaf) = latest_non_sidechain_leaf(messages) else {
        return Vec::new();
    };
    build_chain(messages, leaf)
}

impl EntryType {
    fn from_raw(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "system" => Some(Self::System),
            "attachment" => Some(Self::Attachment),
            _ => None,
        }
    }
}

fn latest_non_sidechain_leaf(
    messages: &HashMap<String, TranscriptMessage>,
) -> Option<&TranscriptMessage> {
    let parent_uuids = messages
        .values()
        .filter(|message| !message.is_sidechain)
        .filter_map(|message| message.parent_uuid.as_deref())
        .collect::<HashSet<_>>();
    messages
        .values()
        .filter(|message| !parent_uuids.contains(message.uuid.as_str()))
        .filter_map(|terminal| nearest_user_assistant_ancestor(messages, terminal))
        .filter(|message| !message.is_sidechain)
        .max_by(|left, right| {
            timestamp_millis(left)
                .cmp(&timestamp_millis(right))
                .then_with(|| left.source_index.cmp(&right.source_index))
        })
}

fn nearest_user_assistant_ancestor<'a>(
    messages: &'a HashMap<String, TranscriptMessage>,
    terminal: &'a TranscriptMessage,
) -> Option<&'a TranscriptMessage> {
    let mut seen = HashSet::new();
    let mut current = Some(terminal);
    while let Some(message) = current {
        if !seen.insert(message.uuid.as_str()) {
            return None;
        }
        if matches!(message.entry_type, EntryType::User | EntryType::Assistant) {
            return Some(message);
        }
        current = message
            .parent_uuid
            .as_deref()
            .and_then(|parent| messages.get(parent));
    }
    None
}

fn build_chain<'a>(
    messages: &'a HashMap<String, TranscriptMessage>,
    leaf: &'a TranscriptMessage,
) -> Vec<&'a TranscriptMessage> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(leaf);
    while let Some(message) = current {
        if !seen.insert(message.uuid.as_str()) {
            break;
        }
        chain.push(message);
        current = message
            .parent_uuid
            .as_deref()
            .and_then(|parent| messages.get(parent));
    }
    chain.reverse();
    recover_parallel_tool_results(messages, chain, seen)
}

fn recover_parallel_tool_results<'a>(
    messages: &'a HashMap<String, TranscriptMessage>,
    chain: Vec<&'a TranscriptMessage>,
    mut seen: HashSet<&'a str>,
) -> Vec<&'a TranscriptMessage> {
    let mut anchor_by_message_id = HashMap::<&str, &TranscriptMessage>::new();
    for message in chain.iter().copied() {
        if message.entry_type == EntryType::Assistant
            && let Some(message_id) = nested_message_id(message)
        {
            anchor_by_message_id.insert(message_id, message);
        }
    }
    if anchor_by_message_id.is_empty() {
        return chain;
    }

    let mut siblings_by_message_id = HashMap::<&str, Vec<&TranscriptMessage>>::new();
    let mut tool_results_by_assistant = HashMap::<&str, Vec<&TranscriptMessage>>::new();
    for message in messages.values() {
        if message.entry_type == EntryType::Assistant
            && let Some(message_id) = nested_message_id(message)
        {
            siblings_by_message_id
                .entry(message_id)
                .or_default()
                .push(message);
        } else if message.entry_type == EntryType::User
            && let Some(parent) = message.parent_uuid.as_deref()
            && is_tool_result_message(message)
        {
            tool_results_by_assistant
                .entry(parent)
                .or_default()
                .push(message);
        }
    }

    let mut processed = HashSet::<&str>::new();
    let mut inserts = HashMap::<&str, Vec<&TranscriptMessage>>::new();
    for assistant in chain.iter().copied() {
        let Some(message_id) = nested_message_id(assistant) else {
            continue;
        };
        if !processed.insert(message_id) {
            continue;
        }
        let mut recovered = siblings_by_message_id
            .get(message_id)
            .into_iter()
            .flat_map(|siblings| siblings.iter().copied())
            .filter(|sibling| !seen.contains(sibling.uuid.as_str()))
            .collect::<Vec<_>>();
        if let Some(siblings) = siblings_by_message_id.get(message_id) {
            for sibling in siblings {
                if let Some(results) = tool_results_by_assistant.get(sibling.uuid.as_str()) {
                    recovered.extend(
                        results
                            .iter()
                            .copied()
                            .filter(|result| !seen.contains(result.uuid.as_str())),
                    );
                }
            }
        }
        if recovered.is_empty() {
            continue;
        }
        recovered.sort_by(|left, right| {
            left.timestamp
                .cmp(&right.timestamp)
                .then_with(|| left.source_index.cmp(&right.source_index))
        });
        for message in &recovered {
            seen.insert(message.uuid.as_str());
        }
        if let Some(anchor) = anchor_by_message_id.get(message_id) {
            inserts.insert(anchor.uuid.as_str(), recovered);
        }
    }

    if inserts.is_empty() {
        return chain;
    }
    let mut result =
        Vec::with_capacity(chain.len() + inserts.values().map(Vec::len).sum::<usize>());
    for message in chain {
        result.push(message);
        if let Some(insert) = inserts.remove(message.uuid.as_str()) {
            result.extend(insert);
        }
    }
    result
}

fn transcript_replay_line(message: &TranscriptMessage) -> Option<String> {
    let role = transcript_replay_role(message)?;
    let content = transcript_replay_content(message)?;
    let mut line = Map::new();
    if !message.uuid.is_empty() {
        line.insert("id".to_owned(), Value::String(message.uuid.clone()));
    }
    if let Some(parent) = &message.parent_uuid {
        line.insert("parentId".to_owned(), Value::String(parent.clone()));
    }
    if let Some(timestamp) = &message.timestamp {
        line.insert("timestamp".to_owned(), Value::String(timestamp.clone()));
    }

    let mut replay_message = Map::new();
    replay_message.insert("role".to_owned(), Value::String(role.to_owned()));
    replay_message.insert("content".to_owned(), content);
    replay_message.insert("id".to_owned(), Value::String(message.uuid.clone()));
    if let Some(parent) = &message.parent_uuid {
        replay_message.insert("originMessageId".to_owned(), Value::String(parent.clone()));
    }
    if role == "toolresult"
        && let Some(tool_call_id) = read_tool_result_call_id(message)
    {
        replay_message.insert(
            "toolCallId".to_owned(),
            Value::String(tool_call_id.to_owned()),
        );
    }
    let mut metadata = Map::new();
    if let Some(session_id) = &message.session_id {
        metadata.insert("sessionId".to_owned(), Value::String(session_id.clone()));
    }
    replay_message.insert("metadata".to_owned(), Value::Object(metadata));
    line.insert("message".to_owned(), Value::Object(replay_message));
    serde_json::to_string(&Value::Object(line)).ok()
}

fn transcript_replay_role(message: &TranscriptMessage) -> Option<&'static str> {
    match message.entry_type {
        EntryType::Assistant => Some("assistant"),
        EntryType::User if is_tool_result_message(message) => Some("toolresult"),
        EntryType::User => Some("user"),
        EntryType::System => Some("system"),
        EntryType::Attachment => None,
    }
}

fn transcript_replay_content(message: &TranscriptMessage) -> Option<Value> {
    match message_content(message)? {
        Value::String(text) if !text.is_empty() && text.len() <= MAX_TEXT_PREVIEW_BYTES => {
            Some(Value::String(text.clone()))
        }
        Value::String(text) if !text.is_empty() => {
            large_text_block(message, None, text).map(|block| Value::Array(vec![block]))
        }
        Value::Array(blocks) => {
            let blocks = blocks
                .iter()
                .enumerate()
                .filter_map(|(index, block)| transcript_replay_block(message, index, block))
                .collect::<Vec<_>>();
            (!blocks.is_empty()).then_some(Value::Array(blocks))
        }
        _ => None,
    }
}

fn transcript_replay_block(
    message: &TranscriptMessage,
    block_index: usize,
    block: &Value,
) -> Option<Value> {
    let block = block.as_object()?;
    match block.get("type")?.as_str()? {
        "text" => text_block(message, Some(block_index), block),
        "thinking" => thinking_block(block),
        "tool_use" => tool_use_block(block),
        "tool_result" | "tool_use_result" => tool_result_block(block),
        "image" => image_block(block),
        _ => None,
    }
}

fn text_block(
    message: &TranscriptMessage,
    block_index: Option<usize>,
    block: &Map<String, Value>,
) -> Option<Value> {
    text_content(message, block_index, block.get("text")?.as_str()?)
}

fn text_content(
    message: &TranscriptMessage,
    block_index: Option<usize>,
    text: &str,
) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    if text.len() <= MAX_TEXT_PREVIEW_BYTES {
        return Some(Value::Object(Map::from_iter([
            ("type".to_owned(), Value::String("text".to_owned())),
            ("text".to_owned(), Value::String(text.to_owned())),
        ])));
    }
    large_text_block(message, block_index, text)
}

fn large_text_block(
    message: &TranscriptMessage,
    block_index: Option<usize>,
    text: &str,
) -> Option<Value> {
    let preview = utf8_prefix(text, MAX_TEXT_PREVIEW_BYTES);
    Some(Value::Object(Map::from_iter([
        ("type".to_owned(), Value::String("large_text".to_owned())),
        ("text".to_owned(), Value::String(preview.to_owned())),
        (
            "content_ref".to_owned(),
            Value::String(large_text_ref(message, block_index)),
        ),
        (
            "total_bytes".to_owned(),
            Value::Number((text.len() as u64).into()),
        ),
    ])))
}

fn thinking_block(block: &Map<String, Value>) -> Option<Value> {
    let text = block
        .get("text")
        .or_else(|| block.get("thinking"))?
        .as_str()?;
    if text.is_empty() {
        return None;
    }
    Some(Value::Object(Map::from_iter([
        ("type".to_owned(), Value::String("thinking".to_owned())),
        ("thinking".to_owned(), Value::String(text.to_owned())),
    ])))
}

fn tool_use_block(block: &Map<String, Value>) -> Option<Value> {
    let id = block.get("id")?.as_str()?;
    let name = block.get("name")?.as_str()?;
    let mut input = Map::new();
    if let Some(object) = block.get("input").and_then(Value::as_object) {
        input.extend(object.keys().map(|key| (key.clone(), Value::Null)));
    }
    Some(Value::Object(Map::from_iter([
        ("type".to_owned(), Value::String("tool_use".to_owned())),
        ("id".to_owned(), Value::String(id.to_owned())),
        ("name".to_owned(), Value::String(name.to_owned())),
        ("input".to_owned(), Value::Object(input)),
    ])))
}

fn tool_result_block(block: &Map<String, Value>) -> Option<Value> {
    let mut result = Map::new();
    result.insert(
        "type".to_owned(),
        Value::String(block.get("type")?.as_str()?.to_owned()),
    );
    for key in ["tool_use_id", "toolUseId", "id"] {
        if let Some(value) = block.get(key).and_then(Value::as_str) {
            result.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    if let Some(content) = block
        .get("content")
        .and_then(transcript_replay_tool_result_content)
    {
        result.insert("content".to_owned(), content);
    }
    for key in ["is_error", "isError"] {
        if let Some(value) = block.get(key).and_then(Value::as_bool) {
            result.insert(key.to_owned(), Value::Bool(value));
        }
    }
    (result.len() > 1).then_some(Value::Object(result))
}

fn transcript_replay_tool_result_content(content: &Value) -> Option<Value> {
    match content {
        Value::String(text) => Some(Value::String(text.clone())),
        Value::Array(blocks) => {
            let blocks = blocks
                .iter()
                .filter_map(text_block_from_value)
                .collect::<Vec<_>>();
            (!blocks.is_empty()).then_some(Value::Array(blocks))
        }
        _ => None,
    }
}

fn text_block_from_value(block: &Value) -> Option<Value> {
    let block = block.as_object()?;
    let text = block.get("text")?.as_str()?;
    Some(Value::Object(Map::from_iter([
        ("type".to_owned(), Value::String("text".to_owned())),
        (
            "text".to_owned(),
            Value::String(utf8_prefix(text, MAX_TEXT_PREVIEW_BYTES).to_owned()),
        ),
    ])))
}

fn find_large_text<'a>(chain: &[&'a TranscriptMessage], content_ref: &str) -> Option<&'a str> {
    for message in chain {
        let Some(content) = message_content(message) else {
            continue;
        };
        match content {
            Value::String(text) if content_ref == large_text_ref(message, None) => {
                return Some(text);
            }
            Value::Array(blocks) => {
                for (index, block) in blocks.iter().enumerate() {
                    let Some(block) = block.as_object() else {
                        continue;
                    };
                    if block.get("type").and_then(Value::as_str) == Some("text")
                        && content_ref == large_text_ref(message, Some(index))
                    {
                        return block.get("text").and_then(Value::as_str);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn large_text_ref(message: &TranscriptMessage, block_index: Option<usize>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(message.uuid.as_bytes());
    hasher.update([0]);
    hasher.update(message.source_index.to_le_bytes());
    hasher.update([0]);
    hasher.update(block_index.unwrap_or(usize::MAX).to_le_bytes());
    let digest = hasher.finalize();
    format!("matcha-local:{}", URL_SAFE_NO_PAD.encode(&digest[..18]))
}

fn text_chunk(text: &str, offset: u64, limit: usize) -> Option<(&str, u64)> {
    let offset = usize::try_from(offset).ok()?;
    if offset > text.len() || !text.is_char_boundary(offset) {
        return None;
    }
    let end = utf8_chunk_end(text, offset, limit.max(1).min(DEFAULT_CONTENT_CHUNK_BYTES));
    Some((&text[offset..end], end as u64))
}

fn utf8_prefix(text: &str, limit: usize) -> &str {
    &text[..utf8_chunk_end(text, 0, limit)]
}

fn utf8_chunk_end(text: &str, offset: usize, limit: usize) -> usize {
    let mut end = offset.saturating_add(limit).min(text.len());
    while end > offset && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end > offset || offset >= text.len() {
        return end;
    }
    text[offset..]
        .chars()
        .next()
        .map_or(offset, |character| offset + character.len_utf8())
}

fn image_block(block: &Map<String, Value>) -> Option<Value> {
    let source = block.get("source")?.as_object()?;
    if source.get("type")?.as_str()? != "url" {
        return None;
    }
    let url = source.get("url")?.as_str()?;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return None;
    }
    let media_type = source
        .get("media_type")
        .or_else(|| source.get("mediaType"))?
        .as_str()?;
    if !IMAGE_MEDIA_TYPES.contains(&media_type) {
        return None;
    }
    let replay_source = Map::from_iter([
        ("type".to_owned(), Value::String("url".to_owned())),
        (
            "media_type".to_owned(),
            Value::String(media_type.to_owned()),
        ),
        ("url".to_owned(), Value::String(url.to_owned())),
    ]);
    Some(Value::Object(Map::from_iter([
        ("type".to_owned(), Value::String("image".to_owned())),
        ("source".to_owned(), Value::Object(replay_source)),
    ])))
}

fn message_content(message: &TranscriptMessage) -> Option<&Value> {
    message
        .message
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|message| message.get("content"))
        .or(message.content.as_ref())
}

fn nested_message_id(message: &TranscriptMessage) -> Option<&str> {
    message
        .message
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
}

fn is_tool_result_message(message: &TranscriptMessage) -> bool {
    let Some(Value::Array(content)) = message_content(message) else {
        return false;
    };
    content.iter().any(|block| {
        block
            .as_object()
            .and_then(|block| block.get("type"))
            .and_then(Value::as_str)
            == Some("tool_result")
    })
}

fn read_tool_result_call_id(message: &TranscriptMessage) -> Option<&str> {
    let Some(Value::Array(content)) = message_content(message) else {
        return None;
    };
    for block in content {
        let Some(block) = block.as_object() else {
            continue;
        };
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        for key in ["tool_use_id", "toolUseId", "id"] {
            if let Some(value) = block.get(key).and_then(Value::as_str) {
                return Some(value);
            }
        }
    }
    None
}

fn modified_millis(metadata: &Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn timestamp_millis(message: &TranscriptMessage) -> i64 {
    message
        .timestamp
        .as_deref()
        .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or_default()
}

fn claude_config_home_from_environment() -> Option<PathBuf> {
    if let Some(value) = non_empty_env_path(CLAUDE_CONFIG_DIR) {
        return Some(value);
    }
    home_dir_from_environment().map(|home| home.join(".claude"))
}

#[cfg(windows)]
fn home_dir_from_environment() -> Option<PathBuf> {
    non_empty_env_path("USERPROFILE").or_else(|| {
        let drive = std::env::var_os("HOMEDRIVE")?;
        let path = std::env::var_os("HOMEPATH")?;
        if drive.is_empty() || path.is_empty() {
            None
        } else {
            Some(PathBuf::from(drive).join(path))
        }
    })
}

#[cfg(not(windows))]
fn home_dir_from_environment() -> Option<PathBuf> {
    non_empty_env_path("HOME")
}

fn non_empty_env_path(key: &str) -> Option<PathBuf> {
    let value = std::env::var_os(key)?;
    (!value.is_empty()).then_some(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use std::{fs, time::Duration};

    use super::*;
    use crate::session::hydration::{HydratedMessageRole, HydrationWindowMode};

    #[tokio::test(flavor = "current_thread")]
    async fn lists_only_the_workspace_project_dir() {
        let home = test_project_dir("workspace-list-home");
        let workspace = test_project_dir("workspace-list-cwd");
        let (Some(project_dir), _) = workspace_project_dir_at(home.clone(), &workspace) else {
            panic!("workspace project dir should resolve");
        };
        let other_project = home.join(PROJECTS_DIR).join("other-workspace");
        fs::create_dir_all(&project_dir).unwrap();
        fs::create_dir_all(&other_project).unwrap();
        fs::write(
            project_dir.join("session-a.jsonl"),
            transcript(&[user("u1", None, "a")]),
        )
        .unwrap();
        fs::write(
            other_project.join("session-b.jsonl"),
            transcript(&[user("u1", None, "b")]),
        )
        .unwrap();

        let reader = LocalHistoryReader::from_workspace_project_dir(project_dir, None);
        let HistoryResult::Complete(catalog) = reader.list().await else {
            panic!("list should complete");
        };

        assert_eq!(catalog.sessions().len(), 1);
        assert_eq!(catalog.sessions()[0].session_id().as_str(), "session-a");
    }

    #[test]
    fn sanitize_path_matches_matcha_agent_short_paths() {
        assert_eq!(sanitize_path("E:/code/Matcha-claw"), "E--code-Matcha-claw");
        assert_eq!(sanitize_path(r"C:\Users\Mr.Key\项目"), "C--Users-Mr-Key---");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lists_long_workspace_prefix_match_when_hash_suffix_differs() {
        let home = test_project_dir("workspace-list-long-home");
        let exact = home
            .join(PROJECTS_DIR)
            .join(format!("{}-rust", "a".repeat(MAX_SANITIZED_LENGTH)));
        let actual = home
            .join(PROJECTS_DIR)
            .join(format!("{}-native", "a".repeat(MAX_SANITIZED_LENGTH)));
        fs::create_dir_all(&actual).unwrap();
        fs::write(
            actual.join("session-a.jsonl"),
            transcript(&[user("u1", None, "a")]),
        )
        .unwrap();

        let reader = LocalHistoryReader::from_workspace_project_dir(
            exact,
            Some("a".repeat(MAX_SANITIZED_LENGTH)),
        );
        let HistoryResult::Complete(catalog) = reader.list().await else {
            panic!("list should complete");
        };

        assert_eq!(catalog.sessions().len(), 1);
        assert_eq!(catalog.sessions()[0].session_id().as_str(), "session-a");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn loads_latest_non_sidechain_chain_as_hydration_replay_lines() {
        let root = test_project_dir("load-chain");
        let project = root.join("project-a");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("session-a.jsonl"),
            transcript(&[
                user("u1", None, "first"),
                assistant("a1", Some("u1"), "old"),
                user("u2", Some("a1"), "latest"),
                assistant("a2", Some("u2"), "answer"),
                sidechain_user("side", Some("a2"), "sidechain"),
            ]),
        )
        .unwrap();

        let reader = LocalHistoryReader::from_project_dir(root);
        let HistoryResult::Complete(snapshot) = reader
            .load(
                SessionId::try_new("session-a").unwrap(),
                HydrationWindowRequest::new(HydrationWindowMode::Latest, 20, None),
            )
            .await
        else {
            panic!("load should complete");
        };

        assert_eq!(snapshot.messages().len(), 4);
        assert_eq!(snapshot.messages()[0].text(), "first");
        assert_eq!(snapshot.messages()[2].role(), HydratedMessageRole::User);
        assert_eq!(snapshot.messages()[2].text(), "latest");
        assert_eq!(snapshot.messages()[3].text(), "answer");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bridges_legacy_progress_entries_before_chain_walk() {
        let root = test_project_dir("progress");
        let project = root.join("project-a");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("session-a.jsonl"),
            transcript(&[
                user("u1", None, "first"),
                raw(r#"{"type":"progress","uuid":"p1","parentUuid":"u1"}"#),
                assistant("a1", Some("p1"), "answer"),
            ]),
        )
        .unwrap();

        let reader = LocalHistoryReader::from_project_dir(root);
        let HistoryResult::Complete(snapshot) = reader
            .load(
                SessionId::try_new("session-a").unwrap(),
                HydrationWindowRequest::latest(),
            )
            .await
        else {
            panic!("load should complete");
        };

        assert_eq!(snapshot.messages().len(), 2);
        assert_eq!(snapshot.messages()[1].parent_id(), Some("u1"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recovers_parallel_tool_result_siblings_without_tool_input_values() {
        let root = test_project_dir("parallel-tools");
        let project = root.join("project-a");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("session-a.jsonl"),
            transcript(&[
                user("u1", None, "run tools"),
                assistant_tool("a1", Some("u1"), "message-1", "tool-1", "Read"),
                assistant_tool("a2", Some("a1"), "message-1", "tool-2", "Write"),
                tool_result("tr1", Some("a1"), "tool-1", "ok /private/file"),
                tool_result("tr2", Some("a2"), "tool-2", "done"),
                assistant("a3", Some("tr1"), "final"),
            ]),
        )
        .unwrap();

        let reader = LocalHistoryReader::from_project_dir(root);
        let HistoryResult::Complete(snapshot) = reader
            .load(
                SessionId::try_new("session-a").unwrap(),
                HydrationWindowRequest::latest(),
            )
            .await
        else {
            panic!("load should complete");
        };

        assert!(
            snapshot
                .messages()
                .iter()
                .any(|message| message.id() == Some("tr2"))
        );
        let rendered = format!("{snapshot:?}");
        assert!(!rendered.contains("/private/file"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn large_text_hydrates_preview_and_loads_utf8_chunks() {
        let root = test_project_dir("large-text");
        let project = root.join("project-a");
        fs::create_dir_all(&project).unwrap();
        let text = format!("{}好", "a".repeat(MAX_TEXT_PREVIEW_BYTES));
        fs::write(
            project.join("session-a.jsonl"),
            transcript(&[user("u1", None, &text)]),
        )
        .unwrap();

        let reader = LocalHistoryReader::from_project_dir(root);
        let HistoryResult::Complete(snapshot) = reader
            .load(
                SessionId::try_new("session-a").unwrap(),
                HydrationWindowRequest::latest(),
            )
            .await
        else {
            panic!("load should complete");
        };
        let content_ref = match &snapshot.messages()[0].content()[0] {
            crate::session::hydration::HydratedContentBlock::LargeText(text) => {
                assert_eq!(text.loaded_bytes(), MAX_TEXT_PREVIEW_BYTES as u64);
                assert_eq!(text.total_bytes(), (MAX_TEXT_PREVIEW_BYTES + 3) as u64);
                text.content_ref().to_owned()
            }
            _ => panic!("expected large text"),
        };

        let HistoryResult::Complete(chunk) = reader
            .load_content(
                SessionId::try_new("session-a").unwrap(),
                content_ref.clone(),
                MAX_TEXT_PREVIEW_BYTES as u64,
                2,
            )
            .await
        else {
            panic!("chunk should load");
        };
        assert_eq!(chunk.content_ref(), content_ref);
        assert_eq!(chunk.offset(), MAX_TEXT_PREVIEW_BYTES as u64);
        assert_eq!(chunk.text(), "好");
        assert_eq!(chunk.next_offset(), (MAX_TEXT_PREVIEW_BYTES + 3) as u64);
        assert!(chunk.complete());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn missing_session_is_not_found() {
        let root = test_project_dir("missing");
        fs::create_dir_all(root.join("project-a")).unwrap();
        let reader = LocalHistoryReader::from_project_dir(root);

        assert!(matches!(
            reader
                .load(
                    SessionId::try_new("missing").unwrap(),
                    HydrationWindowRequest::latest()
                )
                .await,
            HistoryResult::NotFound
        ));
    }

    fn test_project_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "matcha-local-history-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn transcript(lines: &[String]) -> String {
        let mut value = lines.join("\n");
        value.push('\n');
        value
    }

    fn raw(line: &str) -> String {
        line.to_owned()
    }

    fn user(uuid: &str, parent: Option<&str>, text: &str) -> String {
        message(uuid, parent, "user", json_string(text), false)
    }

    fn sidechain_user(uuid: &str, parent: Option<&str>, text: &str) -> String {
        message(uuid, parent, "user", json_string(text), true)
    }

    fn assistant(uuid: &str, parent: Option<&str>, text: &str) -> String {
        message(uuid, parent, "assistant", json_string(text), false)
    }

    fn assistant_tool(
        uuid: &str,
        parent: Option<&str>,
        message_id: &str,
        tool_id: &str,
        name: &str,
    ) -> String {
        let parent = parent_json(parent);
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}",{parent}"sessionId":"session-a","timestamp":"2026-09-01T00:00:01.000Z","message":{{"id":"{message_id}","content":[{{"type":"tool_use","id":"{tool_id}","name":"{name}","input":{{"secret":"private"}}}}]}}}}"#
        )
    }

    fn tool_result(uuid: &str, parent: Option<&str>, tool_id: &str, content: &str) -> String {
        let parent = parent_json(parent);
        format!(
            r#"{{"type":"user","uuid":"{uuid}",{parent}"sessionId":"session-a","timestamp":"2026-09-01T00:00:02.000Z","message":{{"content":[{{"type":"tool_result","tool_use_id":"{tool_id}","content":{}}}]}}}}"#,
            json_string(content)
        )
    }

    fn message(
        uuid: &str,
        parent: Option<&str>,
        entry_type: &str,
        content: String,
        is_sidechain: bool,
    ) -> String {
        let parent = parent_json(parent);
        let sidechain = if is_sidechain {
            r#","isSidechain":true"#
        } else {
            ""
        };
        format!(
            r#"{{"type":"{entry_type}","uuid":"{uuid}",{parent}"sessionId":"session-a","timestamp":"2026-09-01T00:00:00.000Z","message":{{"content":{content}}}{sidechain}}}"#
        )
    }

    fn parent_json(parent: Option<&str>) -> String {
        parent.map_or_else(String::new, |parent| format!(r#""parentUuid":"{parent}","#))
    }

    fn json_string(value: &str) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[allow(dead_code)]
    fn wait_for_distinct_mtime() {
        std::thread::sleep(Duration::from_millis(2));
    }
}
