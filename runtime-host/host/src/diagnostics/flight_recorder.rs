use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use foundation::execution::{
    ControlObservation, ControlReason, ControlStage, EventObservation, EventReason, EventStage,
    ObservationObserver, ObservationRecord, ObservationSink, OperationObservation, OperationReason,
    OperationStage, OwnerRuntimeObservation, OwnerRuntimeReason, OwnerRuntimeRoute,
    OwnerRuntimeStage, PeerObservation, PeerReason, PeerStage, ShutdownObservation, ShutdownReason,
    ShutdownStage, TraceContext,
};
use serde::Serialize;

const NORMAL_RECORD_LIMIT: usize = 256;
const DIAGNOSTIC_RECORD_LIMIT: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeObservationMode {
    Off,
    Normal,
    Diagnostic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeObservationConfig {
    mode: RuntimeObservationMode,
    archive: bool,
    diagnostic_ttl: Option<Duration>,
}

impl RuntimeObservationConfig {
    pub const fn off() -> Self {
        Self {
            mode: RuntimeObservationMode::Off,
            archive: false,
            diagnostic_ttl: None,
        }
    }

    pub const fn normal(archive: bool) -> Self {
        Self {
            mode: RuntimeObservationMode::Normal,
            archive,
            diagnostic_ttl: None,
        }
    }

    pub const fn diagnostic(archive: bool, ttl: Duration) -> Self {
        Self {
            mode: RuntimeObservationMode::Diagnostic,
            archive,
            diagnostic_ttl: Some(ttl),
        }
    }

    pub const fn mode(self) -> RuntimeObservationMode {
        self.mode
    }

    pub const fn archive_enabled(self) -> bool {
        self.archive
    }

    pub const fn diagnostic_ttl(self) -> Option<Duration> {
        self.diagnostic_ttl
    }
}

impl Default for RuntimeObservationConfig {
    fn default() -> Self {
        Self::off()
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeFlightRecorder {
    inner: Option<Arc<RuntimeFlightRecorderInner>>,
}

impl RuntimeFlightRecorder {
    pub(crate) fn new(config: RuntimeObservationConfig) -> Self {
        match config.mode() {
            RuntimeObservationMode::Off => Self { inner: None },
            RuntimeObservationMode::Normal => Self {
                inner: Some(Arc::new(RuntimeFlightRecorderInner::new(
                    config,
                    NORMAL_RECORD_LIMIT,
                ))),
            },
            RuntimeObservationMode::Diagnostic => Self {
                inner: Some(Arc::new(RuntimeFlightRecorderInner::new(
                    config,
                    DIAGNOSTIC_RECORD_LIMIT,
                ))),
            },
        }
    }

    pub(crate) fn disabled() -> Self {
        Self { inner: None }
    }

    pub(crate) fn sink(&self) -> ObservationSink {
        match &self.inner {
            Some(inner) => {
                let observer: Arc<dyn ObservationObserver> = inner.clone();
                ObservationSink::new(observer)
            }
            None => ObservationSink::disabled(),
        }
    }

    pub(crate) fn archive_snapshot(&self) -> Option<RuntimeObservationSnapshot> {
        let inner = self.inner.as_ref()?;
        inner.config.archive_enabled().then(|| inner.snapshot())
    }
}

struct RuntimeFlightRecorderInner {
    config: RuntimeObservationConfig,
    expires_at_ms: Option<u64>,
    accepted_records: AtomicU64,
    lock_dropped_records: AtomicU64,
    expired_records: AtomicU64,
    ring: Mutex<ObservationRing>,
}

impl RuntimeFlightRecorderInner {
    fn new(config: RuntimeObservationConfig, record_limit: usize) -> Self {
        Self {
            config,
            expires_at_ms: config
                .diagnostic_ttl()
                .map(|ttl| unix_time_millis().saturating_add(duration_millis(ttl))),
            accepted_records: AtomicU64::new(0),
            lock_dropped_records: AtomicU64::new(0),
            expired_records: AtomicU64::new(0),
            ring: Mutex::new(ObservationRing::new(record_limit)),
        }
    }

    fn is_expired(&self, observed_at_ms: u64) -> bool {
        self.expires_at_ms
            .is_some_and(|expires_at_ms| observed_at_ms > expires_at_ms)
    }

    fn snapshot(&self) -> RuntimeObservationSnapshot {
        let ring = self.ring.lock().expect("runtime observation ring poisoned");
        RuntimeObservationSnapshot {
            mode: self.config.mode(),
            archive: self.config.archive_enabled(),
            counters: RuntimeObservationCounters {
                accepted: self.accepted_records.load(Ordering::Relaxed),
                lock_dropped: self.lock_dropped_records.load(Ordering::Relaxed),
                expired: self.expired_records.load(Ordering::Relaxed),
                overwritten: ring.overwritten_records,
            },
            records: ring
                .records
                .iter()
                .copied()
                .map(RuntimeObservationEntry::from)
                .collect(),
        }
    }
}

impl ObservationObserver for RuntimeFlightRecorderInner {
    fn observe(&self, record: ObservationRecord) {
        let observed_at_ms = unix_time_millis();
        if self.is_expired(observed_at_ms) {
            self.expired_records.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let entry = ObservedRecord {
            observed_at_ms,
            record,
        };
        match self.ring.try_lock() {
            Ok(mut ring) => {
                ring.push(entry);
                self.accepted_records.fetch_add(1, Ordering::Relaxed);
            }
            Err(TryLockError::WouldBlock | TryLockError::Poisoned(_)) => {
                self.lock_dropped_records.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

struct ObservationRing {
    records: VecDeque<ObservedRecord>,
    record_limit: usize,
    overwritten_records: u64,
}

impl ObservationRing {
    fn new(record_limit: usize) -> Self {
        Self {
            records: VecDeque::with_capacity(record_limit),
            record_limit,
            overwritten_records: 0,
        }
    }

    fn push(&mut self, record: ObservedRecord) {
        if self.records.len() >= self.record_limit {
            self.records.pop_front();
            self.overwritten_records = self.overwritten_records.saturating_add(1);
        }
        self.records.push_back(record);
    }
}

#[derive(Clone, Copy)]
struct ObservedRecord {
    observed_at_ms: u64,
    record: ObservationRecord,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeObservationSnapshot {
    mode: RuntimeObservationMode,
    archive: bool,
    counters: RuntimeObservationCounters,
    records: Vec<RuntimeObservationEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeObservationCounters {
    accepted: u64,
    lock_dropped: u64,
    expired: u64,
    overwritten: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeObservationEntry {
    observed_at_ms: u64,
    #[serde(flatten)]
    record: RuntimeObservationRecord,
}

impl From<ObservedRecord> for RuntimeObservationEntry {
    fn from(value: ObservedRecord) -> Self {
        Self {
            observed_at_ms: value.observed_at_ms,
            record: RuntimeObservationRecord::from(value.record),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "plane", rename_all = "camelCase")]
enum RuntimeObservationRecord {
    OwnerRuntime {
        #[serde(skip_serializing_if = "Option::is_none", rename = "traceId")]
        trace_id: Option<u64>,
        #[serde(rename = "ownerId")]
        owner_id: u64,
        #[serde(rename = "ownerKind")]
        owner_kind: &'static str,
        stage: &'static str,
        item: &'static str,
        route: &'static str,
        #[serde(skip_serializing_if = "Option::is_none", rename = "keyHash")]
        key_hash: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "queueDepth")]
        queue_depth: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    Operation {
        #[serde(skip_serializing_if = "Option::is_none", rename = "traceId")]
        trace_id: Option<u64>,
        #[serde(rename = "operationKind")]
        operation_kind: &'static str,
        stage: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    Control {
        #[serde(skip_serializing_if = "Option::is_none", rename = "traceId")]
        trace_id: Option<u64>,
        #[serde(rename = "commandKind")]
        command_kind: &'static str,
        stage: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    Event {
        #[serde(skip_serializing_if = "Option::is_none", rename = "traceId")]
        trace_id: Option<u64>,
        #[serde(rename = "eventKind")]
        event_kind: &'static str,
        stage: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    Shutdown {
        #[serde(skip_serializing_if = "Option::is_none", rename = "traceId")]
        trace_id: Option<u64>,
        step: &'static str,
        stage: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    Peer {
        #[serde(skip_serializing_if = "Option::is_none", rename = "traceId")]
        trace_id: Option<u64>,
        #[serde(rename = "peerKind")]
        peer_kind: &'static str,
        stage: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
}

impl From<ObservationRecord> for RuntimeObservationRecord {
    fn from(value: ObservationRecord) -> Self {
        match value {
            ObservationRecord::OwnerRuntime(record) => owner_runtime_record(record),
            ObservationRecord::Operation(record) => operation_record(record),
            ObservationRecord::Control(record) => control_record(record),
            ObservationRecord::Event(record) => event_record(record),
            ObservationRecord::Shutdown(record) => shutdown_record(record),
            ObservationRecord::Peer(record) => peer_record(record),
        }
    }
}

fn owner_runtime_record(record: OwnerRuntimeObservation) -> RuntimeObservationRecord {
    RuntimeObservationRecord::OwnerRuntime {
        trace_id: trace_id(record.trace),
        owner_id: record.owner_id,
        owner_kind: record.owner_kind,
        stage: owner_runtime_stage(record.stage),
        item: owner_runtime_item(record.item),
        route: owner_runtime_route(record.route),
        key_hash: record.key_hash,
        queue_depth: record.queue_depth,
        reason: record.reason.map(owner_runtime_reason),
    }
}

fn operation_record(record: OperationObservation) -> RuntimeObservationRecord {
    RuntimeObservationRecord::Operation {
        trace_id: trace_id(record.trace),
        operation_kind: record.operation_kind,
        stage: operation_stage(record.stage),
        reason: record.reason.map(operation_reason),
    }
}

fn control_record(record: ControlObservation) -> RuntimeObservationRecord {
    RuntimeObservationRecord::Control {
        trace_id: trace_id(record.trace),
        command_kind: record.command_kind,
        stage: control_stage(record.stage),
        reason: record.reason.map(control_reason),
    }
}

fn event_record(record: EventObservation) -> RuntimeObservationRecord {
    RuntimeObservationRecord::Event {
        trace_id: trace_id(record.trace),
        event_kind: record.event_kind,
        stage: event_stage(record.stage),
        reason: record.reason.map(event_reason),
    }
}

fn shutdown_record(record: ShutdownObservation) -> RuntimeObservationRecord {
    RuntimeObservationRecord::Shutdown {
        trace_id: trace_id(record.trace),
        step: record.step,
        stage: shutdown_stage(record.stage),
        reason: record.reason.map(shutdown_reason),
    }
}

fn peer_record(record: PeerObservation) -> RuntimeObservationRecord {
    RuntimeObservationRecord::Peer {
        trace_id: trace_id(record.trace),
        peer_kind: record.peer_kind,
        stage: peer_stage(record.stage),
        reason: record.reason.map(peer_reason),
    }
}

fn trace_id(trace: TraceContext) -> Option<u64> {
    (trace.id() != 0).then_some(trace.id())
}

fn owner_runtime_stage(value: OwnerRuntimeStage) -> &'static str {
    match value {
        OwnerRuntimeStage::Spawn => "spawn",
        OwnerRuntimeStage::Route => "route",
        OwnerRuntimeStage::Enqueue => "enqueue",
        OwnerRuntimeStage::Dequeue => "dequeue",
        OwnerRuntimeStage::HandlerStart => "handlerStart",
        OwnerRuntimeStage::HandlerSettle => "handlerSettle",
        OwnerRuntimeStage::ShutdownStart => "shutdownStart",
        OwnerRuntimeStage::ShutdownSettle => "shutdownSettle",
    }
}

fn owner_runtime_item(value: foundation::execution::OwnerRuntimeItem) -> &'static str {
    match value {
        foundation::execution::OwnerRuntimeItem::Command => "command",
        foundation::execution::OwnerRuntimeItem::Query => "query",
        foundation::execution::OwnerRuntimeItem::Shutdown => "shutdown",
    }
}

fn owner_runtime_route(value: OwnerRuntimeRoute) -> &'static str {
    match value {
        OwnerRuntimeRoute::Direct => "direct",
        OwnerRuntimeRoute::Keyed => "keyed",
        OwnerRuntimeRoute::Global => "global",
        OwnerRuntimeRoute::Exclusive => "exclusive",
        OwnerRuntimeRoute::Shutdown => "shutdown",
    }
}

fn owner_runtime_reason(value: OwnerRuntimeReason) -> &'static str {
    match value {
        OwnerRuntimeReason::Accepted => "accepted",
        OwnerRuntimeReason::QueueFull => "queueFull",
        OwnerRuntimeReason::ReadyQueueClosed => "readyQueueClosed",
        OwnerRuntimeReason::MailboxClosed => "mailboxClosed",
        OwnerRuntimeReason::Cancellation => "cancellation",
        OwnerRuntimeReason::Panic => "panic",
    }
}

fn operation_stage(value: OperationStage) -> &'static str {
    match value {
        OperationStage::Start => "start",
        OperationStage::Cancel => "cancel",
        OperationStage::Join => "join",
        OperationStage::Settle => "settle",
    }
}

fn operation_reason(value: OperationReason) -> &'static str {
    match value {
        OperationReason::Completed => "completed",
        OperationReason::Cancelled => "cancelled",
        OperationReason::JoinFailed => "joinFailed",
        OperationReason::Dropped => "dropped",
    }
}

fn control_stage(value: ControlStage) -> &'static str {
    match value {
        ControlStage::Decode => "decode",
        ControlStage::Admit => "admit",
        ControlStage::Dispatch => "dispatch",
        ControlStage::Settle => "settle",
    }
}

fn control_reason(value: ControlReason) -> &'static str {
    match value {
        ControlReason::Accepted => "accepted",
        ControlReason::Rejected => "rejected",
        ControlReason::TimedOut => "timedOut",
        ControlReason::CapacityExhausted => "capacityExhausted",
        ControlReason::DecodeRejected => "decodeRejected",
        ControlReason::OutputClosed => "outputClosed",
    }
}

fn event_stage(value: EventStage) -> &'static str {
    match value {
        EventStage::Validate => "validate",
        EventStage::Project => "project",
        EventStage::Emit => "emit",
        EventStage::Drop => "drop",
    }
}

fn event_reason(value: EventReason) -> &'static str {
    match value {
        EventReason::Accepted => "accepted",
        EventReason::ValidationRejected => "validationRejected",
        EventReason::SinkClosed => "sinkClosed",
        EventReason::SinkFull => "sinkFull",
        EventReason::RouteMismatch => "routeMismatch",
        EventReason::Unsupported => "unsupported",
    }
}

fn shutdown_stage(value: ShutdownStage) -> &'static str {
    match value {
        ShutdownStage::Start => "start",
        ShutdownStage::Settle => "settle",
    }
}

fn shutdown_reason(value: ShutdownReason) -> &'static str {
    match value {
        ShutdownReason::Completed => "completed",
        ShutdownReason::AlreadyClosed => "alreadyClosed",
        ShutdownReason::Unresolved => "unresolved",
        ShutdownReason::JoinFailed => "joinFailed",
        ShutdownReason::ConfirmationFailed => "confirmationFailed",
    }
}

fn peer_stage(value: PeerStage) -> &'static str {
    match value {
        PeerStage::Lifecycle => "lifecycle",
        PeerStage::Readiness => "readiness",
        PeerStage::NativeRpc => "nativeRpc",
    }
}

fn peer_reason(value: PeerReason) -> &'static str {
    match value {
        PeerReason::Starting => "starting",
        PeerReason::Running => "running",
        PeerReason::Stopping => "stopping",
        PeerReason::Ready => "ready",
        PeerReason::NotReady => "notReady",
        PeerReason::Failed => "failed",
        PeerReason::Restarting => "restarting",
    }
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration_millis(duration))
        .unwrap_or(0)
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
