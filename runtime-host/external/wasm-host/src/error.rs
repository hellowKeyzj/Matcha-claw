use std::{error::Error, fmt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stage {
    Engine,
    Load,
    Compile,
    Link,
    Configure,
    Instantiate,
    Call,
    HostIo,
    Cleanup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Resource {
    ArtifactBytes,
    MemoryBytes,
    Memories,
    TableElements,
    Tables,
    OutputBytes,
    HostResources,
    ComponentHandles,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    EngineConfiguration,
    InvalidLimit,
    DigestMismatch,
    NotComponentBinary,
    CompileBusy,
    Compilation,
    EngineMismatch,
    Linking,
    StoreConfiguration,
    Instantiation,
    GuestTrap(wasmtime::Trap),
    ComponentAbi,
    FuelExhausted,
    EpochInterrupted,
    ResourceExceeded {
        resource: Resource,
        limit: usize,
        requested: usize,
    },
    Allocation,
    HostCall,
    Cancelled,
    GuestDeadline,
    HostIoCancelled,
    HostIoDeadline,
    Cleanup,
    CachePoisoned,
}

/// Display/Debug are safe summaries. Inspect `cause()` only in private diagnostics.
pub struct ExecutionError {
    stage: Stage,
    kind: FailureKind,
    cause: Option<wasmtime::Error>,
}

impl ExecutionError {
    pub fn new(stage: Stage, kind: FailureKind) -> Self {
        Self {
            stage,
            kind,
            cause: None,
        }
    }

    pub fn with_cause(stage: Stage, kind: FailureKind, cause: wasmtime::Error) -> Self {
        Self {
            stage,
            kind,
            cause: Some(cause),
        }
    }

    /// Preserve observable typed causes; never classify by parsing error text.
    pub fn from_wasmtime(stage: Stage, cause: wasmtime::Error) -> Self {
        let kind = if let Some(error) = cause.downcast_ref::<Self>() {
            error.kind
        } else if cause.downcast_ref::<wasmtime::OutOfMemory>().is_some() {
            FailureKind::Allocation
        } else if let Some(trap) = cause.downcast_ref::<wasmtime::Trap>() {
            match trap {
                wasmtime::Trap::OutOfFuel => FailureKind::FuelExhausted,
                wasmtime::Trap::Interrupt => FailureKind::EpochInterrupted,
                trap => FailureKind::GuestTrap(*trap),
            }
        } else {
            match stage {
                Stage::Engine => FailureKind::EngineConfiguration,
                Stage::Compile => FailureKind::Compilation,
                Stage::Link => FailureKind::Linking,
                Stage::Instantiate => FailureKind::Instantiation,
                Stage::HostIo => FailureKind::HostCall,
                Stage::Cleanup => FailureKind::Cleanup,
                Stage::Call => FailureKind::ComponentAbi,
                _ => FailureKind::StoreConfiguration,
            }
        };
        let stage = cause
            .downcast_ref::<Self>()
            .filter(|error| error.stage == Stage::HostIo)
            .map_or(stage, |error| error.stage);
        Self::with_cause(stage, kind, cause)
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }
    pub fn kind(&self) -> FailureKind {
        self.kind
    }
    pub fn cause(&self) -> Option<&wasmtime::Error> {
        self.cause.as_ref()
    }
}

impl fmt::Debug for ExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionError")
            .field("stage", &self.stage)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl fmt::Display for ExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Wasm {:?}: {:?}", self.stage, self.kind)
    }
}

impl Error for ExecutionError {}

/// Cleanup failure is retained alongside, not instead of, the execution failure.
#[derive(Debug)]
pub struct InvocationError {
    pub execution: Option<ExecutionError>,
    pub cleanup: Option<ExecutionError>,
}

impl fmt::Display for InvocationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.execution, &self.cleanup) {
            (Some(error), Some(_)) => write!(formatter, "{error}; host cleanup failed"),
            (Some(error), None) | (None, Some(error)) => error.fmt(formatter),
            (None, None) => formatter.write_str("Wasm invocation failed"),
        }
    }
}

impl Error for InvocationError {}
