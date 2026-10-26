use super::*;

impl Wire for world_protocol::process::HostFailure {
    type Output = w::HostFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_host_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_host_failure()?)
    }
}
variant!(world_protocol::process::ProcessFailure, ProcessFailure; units [InvalidRequestId, SpawnFailed, SandboxUnavailable, StdioFailed, ReadinessFailed, TransportClosed, BackpressureTimeout, HandshakeTimeout, HandshakeMismatch, FrameEmpty, FrameTooLarge, FrameMalformed, PartialHeader, PartialBody, DuplicateRequest, UnexpectedDirection, UnknownCorrelation, CreditExceeded, SequenceMismatch, ReadFailed, WriteFailed, FlushFailed, CancelTimeout, ExitUnconfirmed, Retained, InternalFault]; tuples []; records [ContractMismatch { contract_id } => ProcessFailureContractMismatch, ChildExited { code } => ProcessFailureChildExited]);
variant!(component::HostFailureNode, HostFailureNode; units [Cancelled, InternalFault]; tuples [Process, Operation, Input, Authorization, Binding, Source, Slot, Query, Generation, State]; records [BudgetExceeded { dimension } => HostFailureNodeBudgetExceeded]);
record!(world_protocol::process::StateRead, StateRead; key);
record!(world_protocol::process::StateWrite, StateWrite; key, expected_revision, value);
record!(world_protocol::process::StateValue, StateValue; revision, value);
unit_enum!(world_protocol::process::LogLevel, LogLevel; Debug, Info, Warn, Error);
record!(world_protocol::process::LogRecord, LogRecord; level, code, message);
