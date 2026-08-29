use std::{fmt, sync::Arc};

#[derive(Clone)]
pub struct ObservationSink {
    observer: Option<Arc<dyn ObservationObserver>>,
}

impl ObservationSink {
    pub const fn disabled() -> Self {
        Self { observer: None }
    }

    pub fn new(observer: Arc<dyn ObservationObserver>) -> Self {
        Self {
            observer: Some(observer),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.observer.is_some()
    }

    pub fn observe(&self, record: ObservationRecord) {
        if let Some(observer) = &self.observer {
            observer.observe(record);
        }
    }
}

impl Default for ObservationSink {
    fn default() -> Self {
        Self::disabled()
    }
}

impl fmt::Debug for ObservationSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObservationSink")
            .field("enabled", &self.is_enabled())
            .finish()
    }
}

pub trait ObservationObserver: Send + Sync + 'static {
    fn observe(&self, record: ObservationRecord);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TraceContext {
    id: u64,
}

impl TraceContext {
    pub const fn root(id: u64) -> Self {
        Self { id }
    }

    pub const fn absent() -> Self {
        Self { id: 0 }
    }

    pub const fn id(self) -> u64 {
        self.id
    }
}

impl Default for TraceContext {
    fn default() -> Self {
        Self::absent()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationRecord {
    OwnerRuntime(OwnerRuntimeObservation),
    Operation(OperationObservation),
    Control(ControlObservation),
    Event(EventObservation),
    Shutdown(ShutdownObservation),
    Peer(PeerObservation),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OwnerRuntimeObservation {
    pub trace: TraceContext,
    pub owner_id: u64,
    pub owner_kind: &'static str,
    pub stage: OwnerRuntimeStage,
    pub item: OwnerRuntimeItem,
    pub route: OwnerRuntimeRoute,
    pub key_hash: Option<u64>,
    pub queue_depth: Option<usize>,
    pub reason: Option<OwnerRuntimeReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerRuntimeStage {
    Spawn,
    Route,
    Enqueue,
    Dequeue,
    HandlerStart,
    HandlerSettle,
    ShutdownStart,
    ShutdownSettle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerRuntimeItem {
    Command,
    Query,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerRuntimeRoute {
    Direct,
    Keyed,
    Global,
    Exclusive,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerRuntimeReason {
    Accepted,
    QueueFull,
    ReadyQueueClosed,
    MailboxClosed,
    Cancellation,
    Panic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationObservation {
    pub trace: TraceContext,
    pub operation_kind: &'static str,
    pub stage: OperationStage,
    pub reason: Option<OperationReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationStage {
    Start,
    Cancel,
    Join,
    Settle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationReason {
    Completed,
    Cancelled,
    JoinFailed,
    Dropped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlObservation {
    pub trace: TraceContext,
    pub command_kind: &'static str,
    pub stage: ControlStage,
    pub reason: Option<ControlReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlStage {
    Decode,
    Admit,
    Dispatch,
    Settle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlReason {
    Accepted,
    Rejected,
    TimedOut,
    CapacityExhausted,
    DecodeRejected,
    OutputClosed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EventObservation {
    pub trace: TraceContext,
    pub event_kind: &'static str,
    pub stage: EventStage,
    pub reason: Option<EventReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventStage {
    Validate,
    Project,
    Emit,
    Drop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventReason {
    Accepted,
    ValidationRejected,
    SinkClosed,
    SinkFull,
    RouteMismatch,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShutdownObservation {
    pub trace: TraceContext,
    pub step: &'static str,
    pub stage: ShutdownStage,
    pub reason: Option<ShutdownReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownStage {
    Start,
    Settle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownReason {
    Completed,
    AlreadyClosed,
    Unresolved,
    JoinFailed,
    ConfirmationFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PeerObservation {
    pub trace: TraceContext,
    pub peer_kind: &'static str,
    pub stage: PeerStage,
    pub reason: Option<PeerReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerStage {
    Lifecycle,
    Readiness,
    NativeRpc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerReason {
    Starting,
    Running,
    Stopping,
    Ready,
    NotReady,
    Failed,
    Restarting,
}
