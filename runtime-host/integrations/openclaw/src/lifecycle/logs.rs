use std::{
    collections::VecDeque,
    fmt,
    sync::{Arc, Mutex, OnceLock},
};

use super::journal::{LifecycleJournal, LifecycleProcess, format_line};

const REDACTED: &str = "[redacted]";
const SECRET_MARKERS: [&str; 15] = [
    "token",
    "secret",
    "password",
    "apikey",
    "accesskey",
    "privatekey",
    "secretkey",
    "authorization",
    "credential",
    "credentials",
    "bearer",
    "transcript",
    "passphrase",
    "content",
    "messages",
];

pub fn sanitize_log_line(bytes: &[u8]) -> String {
    sanitize_log_line_bounded(bytes, MAX_TAIL_ENTRY_BYTES)
}

pub(crate) fn sanitize_log_line_bounded(bytes: &[u8], limit: usize) -> String {
    let source = String::from_utf8_lossy(bytes);
    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&source) {
        sanitize_json_log(&mut value);
        bound_json_log(&mut value, limit);
        return serde_json::to_string(&value).unwrap_or_else(|_| REDACTED.to_owned());
    }
    let mut line = sanitize_log_text(&source);
    line.truncate(line.floor_char_boundary(limit));
    line
}

fn bound_json_log(value: &mut serde_json::Value, limit: usize) -> usize {
    match value {
        serde_json::Value::String(text) => {
            let mut length = serde_json::to_string(text).unwrap().len();
            while length > limit && !text.is_empty() {
                let character = text.pop().unwrap();
                length -= match character {
                    '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
                    character if character <= '\u{1f}' => 6,
                    character => character.len_utf8(),
                };
            }
            length
        }
        serde_json::Value::Object(fields) => {
            let mut length = 2;
            fields.retain(|key, value| {
                let overhead =
                    serde_json::to_string(key).unwrap().len() + 1 + usize::from(length > 2);
                if length + overhead + 4 > limit {
                    return false;
                }
                length += overhead + bound_json_log(value, limit - length - overhead);
                true
            });
            length
        }
        serde_json::Value::Array(values) => {
            let mut length = 2;
            let mut retained = 0;
            for value in values.iter_mut() {
                let comma = usize::from(retained > 0);
                if length + comma + 4 > limit {
                    break;
                }
                length += comma + bound_json_log(value, limit - length - comma);
                retained += 1;
            }
            values.truncate(retained);
            length
        }
        _ => {
            let length = serde_json::to_string(value).unwrap().len();
            if length > limit {
                *value = serde_json::Value::Null;
                4
            } else {
                length
            }
        }
    }
}

fn sanitize_json_log(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if is_secret_log_key(key) {
                    *value = serde_json::Value::String(REDACTED.to_owned());
                } else {
                    sanitize_json_log(value);
                }
            }
        }
        serde_json::Value::Array(values) => values.iter_mut().for_each(sanitize_json_log),
        serde_json::Value::String(text) => *text = sanitize_log_text(text),
        _ => {}
    }
}

fn sanitize_log_text(source: &str) -> String {
    let mut redacted = String::with_capacity(source.len());
    let mut copied = 0;
    let mut cursor = 0;
    while cursor < source.len() {
        let character = source[cursor..].chars().next().unwrap();
        if !character.is_ascii() || !is_log_key_byte(character as u8) {
            cursor += character.len_utf8();
            continue;
        }
        let start = cursor;
        while cursor < source.len() && is_log_key_byte(source.as_bytes()[cursor]) {
            cursor += 1;
        }
        if source[start..cursor].eq_ignore_ascii_case("api") {
            let next = cursor + source[cursor..].len() - source[cursor..].trim_start().len();
            if source[next..]
                .get(..3)
                .is_some_and(|key| key.eq_ignore_ascii_case("key"))
                && source
                    .as_bytes()
                    .get(next + 3)
                    .is_none_or(|byte| !is_log_key_byte(*byte))
            {
                cursor = next + 3;
            }
        }
        let key = &source[start..cursor];
        let after_key = source[cursor..]
            .trim_start_matches(['\'', '"'])
            .trim_start();
        let value = if is_secret_log_key(key) && after_key.starts_with(['=', ':']) {
            after_key[1..].trim_start()
        } else if is_secret_log_key(key) && source[cursor..].starts_with(char::is_whitespace) {
            source[cursor..].trim_start()
        } else {
            continue;
        };
        let value_start = source.len() - value.len();
        let mut value_end = log_value_end(value);
        if value[..value_end].eq_ignore_ascii_case("bearer")
            || value[..value_end].eq_ignore_ascii_case("basic")
        {
            let credential = value[value_end..].trim_start();
            value_end = value.len() - credential.len() + log_value_end(credential);
        }
        redacted.push_str(&source[copied..value_start]);
        if value.starts_with(['\'', '"']) {
            let quote = value.as_bytes()[0] as char;
            redacted.push(quote);
            redacted.push_str(REDACTED);
            redacted.push(quote);
        } else {
            redacted.push_str(REDACTED);
        }
        cursor = value_start + value_end;
        copied = cursor;
    }
    redacted.push_str(&source[copied..]);

    let mut sanitized = String::with_capacity(redacted.len().min(MAX_TAIL_ENTRY_BYTES));
    let mut remaining = redacted.trim();
    while !remaining.is_empty() {
        // Keep quoted paths together so a space in a user directory cannot expose its suffix.
        let mut quote = None;
        let mut escaped = false;
        let end = remaining
            .char_indices()
            .find_map(|(index, character)| {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if quote == Some(character) {
                    quote = None;
                } else if quote.is_none() && matches!(character, '\'' | '"') {
                    quote = Some(character);
                } else if quote.is_none() && character.is_whitespace() {
                    return Some(index);
                }
                None
            })
            .unwrap_or(remaining.len());
        let token = &remaining[..end];
        let is_path = token.contains(['/', '\\']);
        let rendered = if token.contains("://") {
            "[url redacted]"
        } else if is_path {
            "[path redacted]"
        } else {
            token
        };
        if !sanitized.is_empty() && sanitized.len() < MAX_TAIL_ENTRY_BYTES {
            sanitized.push(' ');
        }
        for character in rendered.chars() {
            let character = if character.is_control() {
                ' '
            } else {
                character
            };
            if sanitized.len() + character.len_utf8() > MAX_TAIL_ENTRY_BYTES {
                return sanitized;
            }
            sanitized.push(character);
        }
        remaining = remaining[end..].trim_start();
    }
    sanitized
}

fn is_log_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn is_secret_log_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect();
    SECRET_MARKERS
        .iter()
        .any(|marker| normalized.ends_with(marker))
        || key.split(['.', '_', '-']).any(|part| {
            SECRET_MARKERS
                .iter()
                .any(|marker| part.eq_ignore_ascii_case(marker))
        })
}

fn log_value_end(value: &str) -> usize {
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0usize;
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
        } else if character == '\\' && quote.is_some() {
            escaped = true;
        } else if quote == Some(character) {
            quote = None;
            if depth == 0 {
                return index + character.len_utf8();
            }
        } else if quote.is_some() {
            continue;
        } else if matches!(character, '\'' | '"') {
            if index > 0 && depth == 0 {
                return index;
            }
            quote = Some(character);
        } else if matches!(character, '{' | '[') {
            depth += 1;
        } else if matches!(character, '}' | ']') {
            if depth == 0 {
                return index;
            }
            depth -= 1;
            if depth == 0 {
                return index + character.len_utf8();
            }
        } else if depth == 0 && (character.is_whitespace() || matches!(character, ',' | ';')) {
            return index;
        }
    }
    value.len()
}

pub const MAX_LINE_BYTES: usize = 16 * 1024;
pub const MAX_TAIL_LINES: usize = 128;
pub const MAX_TAIL_ENTRY_BYTES: usize = 1024;
const MAX_DIAGNOSTICS_PER_STREAM: usize = 16;

/// A sanitized, bounded line retained from one OpenClaw lifecycle output stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleLogEntry {
    stream: LogStream,
    line: String,
}

impl LifecycleLogEntry {
    pub const fn stream(&self) -> LogStream {
        self.stream
    }

    pub fn line(&self) -> &str {
        &self.line
    }
}

/// A snapshot of the retained lifecycle tail and its eviction coverage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleLogSnapshot {
    pub entries: Vec<LifecycleLogEntry>,
    pub tail_evicted: bool,
}

#[derive(Default)]
struct LifecycleLogBufferState {
    entries: VecDeque<LifecycleLogEntry>,
    tail_evicted: bool,
}

/// Shared tail storage for sanitized OpenClaw lifecycle output.
#[derive(Clone, Default)]
pub struct LifecycleLogBuffer {
    state: Arc<Mutex<LifecycleLogBufferState>>,
    journal: Option<LifecycleJournal>,
    restored: Arc<tokio::sync::OnceCell<()>>,
    process: Option<LifecycleProcess>,
}

impl LifecycleLogBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_journal(state_dir: platform::state_dir::CanonicalStateDir) -> Self {
        Self {
            journal: Some(LifecycleJournal::new(state_dir)),
            ..Self::default()
        }
    }

    pub(crate) fn for_process(&self, process: LifecycleProcess) -> Self {
        Self {
            process: Some(process),
            ..self.clone()
        }
    }

    pub(crate) async fn restore(&self) {
        self.restored
            .get_or_init(|| async {
                let Some(journal) = &self.journal else { return };
                let (entries, evicted) = journal.read_tail().await;
                let mut state = self
                    .state
                    .lock()
                    .expect("OpenClaw lifecycle log buffer mutex poisoned");
                state.tail_evicted |= evicted;
                for (stream, line) in entries.into_iter().rev() {
                    if state.entries.len() == MAX_TAIL_LINES {
                        state.tail_evicted = true;
                        break;
                    }
                    state.entries.push_front(LifecycleLogEntry { stream, line });
                }
            })
            .await;
    }

    pub(crate) async fn flush(&self) {
        self.restore().await;
        if let Some(journal) = &self.journal {
            if let Some(notice) = journal.flush().await {
                self.push(LifecycleLogEntry {
                    stream: LogStream::Stderr,
                    line: format_line(None, LogStream::Stderr, notice.as_bytes()),
                });
            }
        }
    }

    pub fn snapshot(&self) -> Vec<LifecycleLogEntry> {
        self.state
            .lock()
            .expect("OpenClaw lifecycle log buffer mutex poisoned")
            .entries
            .iter()
            .cloned()
            .collect()
    }

    pub fn snapshot_with_coverage(&self) -> LifecycleLogSnapshot {
        let state = self
            .state
            .lock()
            .expect("OpenClaw lifecycle log buffer mutex poisoned");
        LifecycleLogSnapshot {
            entries: state.entries.iter().cloned().collect(),
            tail_evicted: state.tail_evicted,
        }
    }

    pub fn len(&self) -> usize {
        self.state
            .lock()
            .expect("OpenClaw lifecycle log buffer mutex poisoned")
            .entries
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn append(&self, stream: LogStream, bytes: &[u8]) {
        let bytes = &bytes[..bytes.len().min(MAX_LINE_BYTES)];
        let line = if let Some(journal) = &self.journal {
            let line = format_line(self.process, stream, bytes);
            journal.append(&line);
            line
        } else {
            sanitize_log_line(bytes)
        };
        self.push(LifecycleLogEntry { stream, line });
    }

    fn push(&self, entry: LifecycleLogEntry) {
        let mut state = self
            .state
            .lock()
            .expect("OpenClaw lifecycle log buffer mutex poisoned");
        if state.entries.len() == MAX_TAIL_LINES {
            state.entries.pop_front();
            state.tail_evicted = true;
        }
        state.entries.push_back(entry);
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogStream {
    Stdout,
    Stderr,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleDiagnosticCategory {
    /// A gateway listener was mentioned in output. This observation never establishes readiness.
    ListenerReported,
    PortConflict,
    ConfigurationRejected,
    BindRejected,
    StartupFailed,
    InvalidEncoding,
    LineTooLong,
    DiagnosticLimitReached,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LifecycleDiagnostic {
    stream: LogStream,
    category: LifecycleDiagnosticCategory,
    repair: RepairDisposition,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RepairDisposition {
    None,
    Required,
    Blocked,
}
impl LifecycleDiagnostic {
    pub const fn new(stream: LogStream, category: LifecycleDiagnosticCategory) -> Self {
        Self {
            stream,
            category,
            repair: RepairDisposition::None,
        }
    }

    pub const fn stream(&self) -> LogStream {
        self.stream
    }
    pub const fn category(&self) -> LifecycleDiagnosticCategory {
        self.category
    }
}
impl LifecycleDiagnostic {
    pub fn state() -> LifecycleDiagnosticState {
        static STATE: OnceLock<LifecycleDiagnosticState> = OnceLock::new();
        STATE.get_or_init(LifecycleDiagnosticState::new).clone()
    }
}

#[derive(Clone, Default)]
pub struct LifecycleDiagnosticState {
    diagnostics: Arc<Mutex<Vec<LifecycleDiagnostic>>>,
}

impl LifecycleDiagnosticState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reporter(&self) -> Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync> {
        let state = self.clone();
        Arc::new(move |diagnostic| state.record(diagnostic))
    }

    pub fn record(&self, diagnostic: LifecycleDiagnostic) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("OpenClaw lifecycle diagnostic state mutex poisoned");
        if let Some(index) = diagnostics
            .iter()
            .position(|previous| *previous == diagnostic)
        {
            diagnostics.remove(index);
        }
        diagnostics.push(diagnostic);
    }

    pub fn snapshot(&self) -> Vec<LifecycleDiagnosticCategory> {
        self.diagnostics
            .lock()
            .expect("OpenClaw lifecycle diagnostic state mutex poisoned")
            .iter()
            .map(LifecycleDiagnostic::category)
            .collect()
    }

    pub fn requires_repair(&self) -> bool {
        let diagnostics = self
            .diagnostics
            .lock()
            .expect("OpenClaw lifecycle diagnostic state mutex poisoned");
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.repair == RepairDisposition::Required)
            && !diagnostics.iter().any(|diagnostic| {
                diagnostic.repair == RepairDisposition::Blocked
                    || matches!(
                        diagnostic.category,
                        LifecycleDiagnosticCategory::PortConflict
                            | LifecycleDiagnosticCategory::BindRejected
                            | LifecycleDiagnosticCategory::InvalidEncoding
                            | LifecycleDiagnosticCategory::LineTooLong
                            | LifecycleDiagnosticCategory::DiagnosticLimitReached
                    )
            })
    }

    pub fn clear(&self) {
        self.diagnostics
            .lock()
            .expect("OpenClaw lifecycle diagnostic state mutex poisoned")
            .clear();
    }
}

impl fmt::Display for LifecycleDiagnostic {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self.category {
            LifecycleDiagnosticCategory::ListenerReported => {
                "OpenClaw gateway output reported a listener"
            }
            LifecycleDiagnosticCategory::PortConflict => {
                "OpenClaw gateway output reported a port conflict"
            }
            LifecycleDiagnosticCategory::ConfigurationRejected => {
                "OpenClaw gateway output reported rejected configuration"
            }
            LifecycleDiagnosticCategory::BindRejected => {
                "OpenClaw gateway output reported a rejected socket bind"
            }
            LifecycleDiagnosticCategory::StartupFailed => {
                "OpenClaw gateway output reported startup failure"
            }
            LifecycleDiagnosticCategory::InvalidEncoding => {
                "OpenClaw gateway output contained invalid UTF-8"
            }
            LifecycleDiagnosticCategory::LineTooLong => {
                "OpenClaw gateway output exceeded the line limit"
            }
            LifecycleDiagnosticCategory::DiagnosticLimitReached => {
                "OpenClaw gateway output reached the diagnostic limit"
            }
        };
        output.write_str(message)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Signal {
    RepairRequired,
    RepairBlocked,
    PortConflict,
    ConfigurationRejected,
    BindRejected,
    ListenerTag,
    ListenerAddress,
    StartupFailed,
}

const PATTERNS: [(Signal, &[u8]); 30] = [
    // Native startup-maintenance errors, not arbitrary mentions of Doctor.
    (Signal::RepairRequired, b"openclaw state database schema migration required ("),
    (Signal::RepairRequired, b"legacy workspace setup state requires migration for "),
    (Signal::RepairRequired, b"legacy session store requires migration: "),
    (Signal::RepairRequired, b"run openclaw doctor --fix to migrate persisted media before using it."),
    (Signal::RepairRequired, b"stop active agents and run openclaw doctor --fix to migrate session identities before using it."),
    (Signal::RepairRequired, b"has a legacy operator approval schema; run openclaw doctor --fix to migrate it."),
    (Signal::RepairRequired, b"legacy exec approvals exist at "),
    (Signal::RepairRequired, b"run \"openclaw doctor --fix\" to repair, then retry."),
    (Signal::RepairRequired, b"run \"openclaw doctor --fix\" to repair the config, then retry."),
    (Signal::RepairBlocked, b"database schema preflight rejected newer schema"),
    (Signal::RepairBlocked, b"openclaw database schema(s) are newer than this build."),
    (Signal::RepairBlocked, b"this openclaw build cannot open your existing data."),
    (Signal::RepairBlocked, b"gateway requires a newer openclaw build"),
    (Signal::RepairBlocked, b"config file is not readable by the current process."),
    (Signal::RepairBlocked, b"eacces"),
    (Signal::RepairBlocked, b"eperm"),
    (Signal::RepairBlocked, b"legacy config entries detected while running in nix mode."),
    (Signal::RepairBlocked, b"this is a plugin packaging issue, not a local config problem."),

    (
        Signal::PortConflict,
        b"another gateway instance is already listening",
    ),
    (Signal::PortConflict, b"gateway already running"),
    (Signal::ConfigurationRejected, b"gateway start blocked:"),
    (Signal::ConfigurationRejected, b"invalid config"),
    (Signal::ConfigurationRejected, b"config invalid"),
    (Signal::ConfigurationRejected, b"unrecognized key"),
    (Signal::BindRejected, b"refusing to bind gateway"),
    (Signal::BindRejected, b"failed to bind gateway socket"),
    (Signal::ListenerTag, b"[gateway]"),
    (Signal::ListenerAddress, b"listening on ws"),
    (Signal::StartupFailed, b"gateway failed to start:"),
    (Signal::StartupFailed, b"gateway startup failed:"),
];

struct Pattern {
    signal: Signal,
    needle: &'static [u8],
    prefix: Vec<usize>,
    matched: usize,
    found: bool,
}

impl Pattern {
    fn new(signal: Signal, needle: &'static [u8]) -> Self {
        let mut prefix = vec![0; needle.len()];
        for index in 1..needle.len() {
            let mut candidate = prefix[index - 1];
            while candidate > 0 && needle[index] != needle[candidate] {
                candidate = prefix[candidate - 1];
            }
            if needle[index] == needle[candidate] {
                candidate += 1;
            }
            prefix[index] = candidate;
        }
        Self {
            signal,
            needle,
            prefix,
            matched: 0,
            found: false,
        }
    }

    fn push(&mut self, byte: u8) {
        if self.found {
            return;
        }
        let byte = byte.to_ascii_lowercase();
        while self.matched > 0 && self.needle[self.matched] != byte {
            self.matched = self.prefix[self.matched - 1];
        }
        if self.needle[self.matched] == byte {
            self.matched += 1;
            if self.matched == self.needle.len() {
                self.found = true;
            }
        }
    }

    fn reset(&mut self) {
        self.matched = 0;
        self.found = false;
    }
}

struct Utf8Validator {
    malformed: bool,
    remaining: u8,
    continuation_min: u8,
    continuation_max: u8,
}

impl Utf8Validator {
    const fn new() -> Self {
        Self {
            malformed: false,
            remaining: 0,
            continuation_min: 0x80,
            continuation_max: 0xbf,
        }
    }

    fn push(&mut self, byte: u8) {
        if self.malformed {
            return;
        }
        if self.remaining > 0 {
            if !(self.continuation_min..=self.continuation_max).contains(&byte) {
                self.malformed = true;
                return;
            }
            self.remaining -= 1;
            self.continuation_min = 0x80;
            self.continuation_max = 0xbf;
            return;
        }
        match byte {
            0x00..=0x7f => {}
            0xc2..=0xdf => self.multibyte(1, 0x80, 0xbf),
            0xe0 => self.multibyte(2, 0xa0, 0xbf),
            0xe1..=0xec | 0xee..=0xef => self.multibyte(2, 0x80, 0xbf),
            0xed => self.multibyte(2, 0x80, 0x9f),
            0xf0 => self.multibyte(3, 0x90, 0xbf),
            0xf1..=0xf3 => self.multibyte(3, 0x80, 0xbf),
            0xf4 => self.multibyte(3, 0x80, 0x8f),
            _ => self.malformed = true,
        }
    }

    fn multibyte(&mut self, remaining: u8, continuation_min: u8, continuation_max: u8) {
        self.remaining = remaining;
        self.continuation_min = continuation_min;
        self.continuation_max = continuation_max;
    }

    const fn is_valid(&self) -> bool {
        !self.malformed && self.remaining == 0
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

struct LineRecognition {
    patterns: [Pattern; PATTERNS.len()],
    utf8: Utf8Validator,
}

impl LineRecognition {
    fn new() -> Self {
        Self {
            patterns: PATTERNS.map(|(signal, needle)| Pattern::new(signal, needle)),
            utf8: Utf8Validator::new(),
        }
    }

    fn push(&mut self, byte: u8) {
        self.utf8.push(byte);
        for pattern in &mut self.patterns {
            pattern.push(byte);
        }
    }

    fn category(&self) -> Option<LifecycleDiagnosticCategory> {
        if !self.utf8.is_valid() {
            return Some(LifecycleDiagnosticCategory::InvalidEncoding);
        }
        if self.has(Signal::RepairBlocked) || self.has(Signal::RepairRequired) {
            return Some(LifecycleDiagnosticCategory::ConfigurationRejected);
        }
        match (
            self.has(Signal::PortConflict),
            self.has(Signal::ConfigurationRejected),
            self.has(Signal::BindRejected),
            self.has(Signal::StartupFailed),
            self.has(Signal::ListenerTag) && self.has(Signal::ListenerAddress),
        ) {
            (true, ..) => Some(LifecycleDiagnosticCategory::PortConflict),
            (_, true, ..) => Some(LifecycleDiagnosticCategory::ConfigurationRejected),
            (_, _, true, ..) => Some(LifecycleDiagnosticCategory::BindRejected),
            (_, _, _, true, _) => Some(LifecycleDiagnosticCategory::StartupFailed),
            (_, _, _, _, true) => Some(LifecycleDiagnosticCategory::ListenerReported),
            _ => None,
        }
    }

    fn has(&self, signal: Signal) -> bool {
        self.patterns
            .iter()
            .any(|pattern| pattern.signal == signal && pattern.found)
    }

    fn reset(&mut self) {
        for pattern in &mut self.patterns {
            pattern.reset();
        }
        self.utf8.reset();
    }
}

/// Recognizes bounded, category-only lifecycle facts without retaining native output.
pub struct LifecycleLogClassifier {
    stream: LogStream,
    recognition: LineRecognition,
    line_bytes: usize,
    line: Vec<u8>,
    pending_carriage_return: bool,
    discarding_oversized_line: bool,
    diagnostics_reported: usize,
    finished: bool,
    buffer: Option<LifecycleLogBuffer>,
}

impl LifecycleLogClassifier {
    pub fn new(stream: LogStream) -> Self {
        Self::with_buffer_option(stream, None)
    }

    pub fn with_buffer(stream: LogStream, buffer: LifecycleLogBuffer) -> Self {
        Self::with_buffer_option(stream, Some(buffer))
    }

    fn with_buffer_option(stream: LogStream, buffer: Option<LifecycleLogBuffer>) -> Self {
        Self {
            stream,
            recognition: LineRecognition::new(),
            line_bytes: 0,
            line: Vec::new(),
            pending_carriage_return: false,
            discarding_oversized_line: false,
            diagnostics_reported: 0,
            finished: false,
            buffer,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<LifecycleDiagnostic> {
        if self.finished {
            return Vec::new();
        }
        let mut diagnostics = Vec::new();
        for &byte in chunk {
            match byte {
                b'\n' => self.end_line(&mut diagnostics),
                b'\r' => self.defer_carriage_return(&mut diagnostics),
                _ => {
                    self.flush_pending_carriage_return(&mut diagnostics);
                    self.append(byte, &mut diagnostics);
                }
            }
        }
        diagnostics
    }

    pub fn finish(&mut self) -> Vec<LifecycleDiagnostic> {
        if self.finished {
            return Vec::new();
        }
        let mut diagnostics = Vec::new();
        self.flush_pending_carriage_return(&mut diagnostics);
        if !self.discarding_oversized_line && self.line_bytes > 0 {
            self.retain_line();
            self.classify_line(&mut diagnostics);
        }
        self.reset_line();
        self.finished = true;
        diagnostics
    }

    fn defer_carriage_return(&mut self, diagnostics: &mut Vec<LifecycleDiagnostic>) {
        if self.discarding_oversized_line {
            return;
        }
        if self.pending_carriage_return {
            self.append(b'\r', diagnostics);
        }
        if !self.discarding_oversized_line {
            self.pending_carriage_return = true;
        }
    }

    fn flush_pending_carriage_return(&mut self, diagnostics: &mut Vec<LifecycleDiagnostic>) {
        if self.pending_carriage_return {
            self.pending_carriage_return = false;
            self.append(b'\r', diagnostics);
        }
    }

    fn append(&mut self, byte: u8, diagnostics: &mut Vec<LifecycleDiagnostic>) {
        if self.discarding_oversized_line {
            return;
        }
        if self.line_bytes == MAX_LINE_BYTES {
            self.discarding_oversized_line = true;
            self.pending_carriage_return = false;
            self.report(LifecycleDiagnosticCategory::LineTooLong, diagnostics);
            return;
        }
        self.line_bytes += 1;
        self.line.push(byte);
        self.recognition.push(byte);
    }

    fn end_line(&mut self, diagnostics: &mut Vec<LifecycleDiagnostic>) {
        self.pending_carriage_return = false;
        if !self.discarding_oversized_line && self.line_bytes > 0 {
            self.retain_line();
            self.classify_line(diagnostics);
        }
        self.reset_line();
    }

    fn retain_line(&self) {
        if let Some(buffer) = &self.buffer {
            buffer.append(self.stream, &self.line);
        }
    }

    fn classify_line(&mut self, diagnostics: &mut Vec<LifecycleDiagnostic>) {
        if let Some(category) = self.recognition.category() {
            self.report(category, diagnostics);
        }
    }

    fn reset_line(&mut self) {
        self.line_bytes = 0;
        self.line.clear();
        self.pending_carriage_return = false;
        self.discarding_oversized_line = false;
        self.recognition.reset();
    }

    fn report(
        &mut self,
        category: LifecycleDiagnosticCategory,
        diagnostics: &mut Vec<LifecycleDiagnostic>,
    ) {
        if self.diagnostics_reported + 1 == MAX_DIAGNOSTICS_PER_STREAM {
            diagnostics.push(self.diagnostic(LifecycleDiagnosticCategory::DiagnosticLimitReached));
            self.diagnostics_reported += 1;
        } else if self.diagnostics_reported < MAX_DIAGNOSTICS_PER_STREAM {
            diagnostics.push(self.diagnostic(category));
            self.diagnostics_reported += 1;
        }
    }

    fn diagnostic(&self, category: LifecycleDiagnosticCategory) -> LifecycleDiagnostic {
        LifecycleDiagnostic {
            stream: self.stream,
            category,
            repair: if self.recognition.has(Signal::RepairBlocked)
                || self.recognition.has(Signal::PortConflict)
                || self.recognition.has(Signal::BindRejected)
            {
                RepairDisposition::Blocked
            } else if self.recognition.has(Signal::RepairRequired) {
                RepairDisposition::Required
            } else {
                RepairDisposition::None
            },
        }
    }
}
