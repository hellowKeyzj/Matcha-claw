use std::{
    collections::VecDeque,
    fmt,
    sync::{Arc, Mutex, OnceLock},
};

const REDACTED: &str = "[redacted]";
const SECRET_MARKERS: [&str; 11] = [
    "token",
    "secret",
    "password",
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "bearer",
    "config",
    "transcript",
    "canary",
];

pub fn sanitize_log_line(bytes: &[u8]) -> String {
    let source = String::from_utf8_lossy(bytes);
    let mut sanitized = String::with_capacity(source.len().min(MAX_TAIL_ENTRY_BYTES));
    let mut redact_next = false;

    for token in source.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        let is_sensitive_key = SECRET_MARKERS.iter().any(|marker| lower.contains(marker));
        let is_path = token.starts_with('/')
            || token.starts_with('\\')
            || (token.len() >= 3 && token.as_bytes()[1] == b':' && token.as_bytes()[2] == b'\\')
            || token.contains("\\\\");
        let is_url = token.contains("://");
        let rendered = if redact_next || is_sensitive_key {
            redact_next = is_sensitive_key && !token.contains('=');
            if let Some((key, _)) = token.split_once('=') {
                format!("{key}={REDACTED}")
            } else {
                REDACTED.to_owned()
            }
        } else if is_path {
            "[path redacted]".to_owned()
        } else if is_url {
            "[url redacted]".to_owned()
        } else {
            token
                .chars()
                .map(|character| {
                    if character.is_control() {
                        ' '
                    } else {
                        character
                    }
                })
                .collect()
        };

        if !sanitized.is_empty() && sanitized.len() < MAX_TAIL_ENTRY_BYTES {
            sanitized.push(' ');
        }
        if sanitized.len() + rendered.len() > MAX_TAIL_ENTRY_BYTES {
            let remaining = MAX_TAIL_ENTRY_BYTES.saturating_sub(sanitized.len());
            let mut truncated = String::new();
            for character in rendered.chars() {
                if truncated.len() + character.len_utf8() > remaining {
                    break;
                }
                truncated.push(character);
            }
            sanitized.push_str(&truncated);
            break;
        }
        sanitized.push_str(&rendered);
    }

    sanitized
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
}

impl LifecycleLogBuffer {
    pub fn new() -> Self {
        Self::default()
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
}
impl LifecycleDiagnostic {
    pub const fn new(stream: LogStream, category: LifecycleDiagnosticCategory) -> Self {
        Self { stream, category }
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
    categories: Arc<Mutex<Vec<LifecycleDiagnosticCategory>>>,
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
        self.categories
            .lock()
            .expect("OpenClaw lifecycle diagnostic state mutex poisoned")
            .push(diagnostic.category());
    }

    pub fn snapshot(&self) -> Vec<LifecycleDiagnosticCategory> {
        self.categories
            .lock()
            .expect("OpenClaw lifecycle diagnostic state mutex poisoned")
            .clone()
    }

    #[cfg(test)]
    pub fn clear(&self) {
        self.categories
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
    PortConflict,
    ConfigurationRejected,
    BindRejected,
    ListenerTag,
    ListenerAddress,
    StartupFailed,
}

const PATTERNS: [(Signal, &[u8]); 13] = [
    (
        Signal::PortConflict,
        b"another gateway instance is already listening",
    ),
    (Signal::PortConflict, b"gateway already running"),
    (Signal::ConfigurationRejected, b"gateway start blocked:"),
    (Signal::ConfigurationRejected, b"invalid config"),
    (Signal::ConfigurationRejected, b"config invalid"),
    (Signal::ConfigurationRejected, b"unrecognized key"),
    (Signal::ConfigurationRejected, b"run: openclaw doctor --fix"),
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
    patterns: [Pattern; 13],
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
            if self.diagnostics_reported == MAX_DIAGNOSTICS_PER_STREAM {
                break;
            }
        }
        diagnostics
    }

    pub fn finish(&mut self) -> Vec<LifecycleDiagnostic> {
        if self.finished {
            return Vec::new();
        }
        if self.diagnostics_reported == MAX_DIAGNOSTICS_PER_STREAM {
            self.reset_line();
            self.finished = true;
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
            buffer.push(LifecycleLogEntry {
                stream: self.stream,
                line: sanitize_log_line(&self.line),
            });
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

    const fn diagnostic(&self, category: LifecycleDiagnosticCategory) -> LifecycleDiagnostic {
        LifecycleDiagnostic {
            stream: self.stream,
            category,
        }
    }
}
