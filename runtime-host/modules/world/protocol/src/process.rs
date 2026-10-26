use crate::{
    bindings::{ImplementationRef, MethodPort, SlotKind},
    failure::Failure,
    ids::*,
    lifecycle::LifecycleOperation,
    slots::{SlotFailure, SlotRequest, SlotResponse},
    sources::ContractRef,
    time::DurationMs,
};
use serde::{Deserialize, Serialize};
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_HANDSHAKE_BYTES: usize = 65_536;
pub const PROTOCOL: &str = "matcha.world-process/1";
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Endpoint {
    Host,
    Driver,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallId {
    pub initiator: Endpoint,
    pub generation_id: PluginGenerationId,
    pub request_id: RequestId,
}
/// Each initiator allocates strictly increasing, never-reused counters within a generation.
pub fn request_id(initiator: Endpoint, sequence: Sequence) -> Result<RequestId, ProcessFailure> {
    RequestId::try_new(format!(
        "{}:{}",
        if initiator == Endpoint::Host {
            "h"
        } else {
            "p"
        },
        sequence.0
    ))
    .map_err(|_| ProcessFailure::InternalFault)
}
pub fn request_sequence(id: &CallId) -> Result<Sequence, ProcessFailure> {
    let prefix = if id.initiator == Endpoint::Host {
        "h:"
    } else {
        "p:"
    };
    let digits = id
        .request_id
        .as_str()
        .strip_prefix(prefix)
        .ok_or(ProcessFailure::UnexpectedDirection)?;
    let number: u64 = digits
        .parse()
        .map_err(|_| ProcessFailure::InvalidRequestId)?;
    if number.to_string() != digits {
        return Err(ProcessFailure::InvalidRequestId);
    }
    Ok(Sequence(number))
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "message",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Frame {
    Hello(Hello),
    Select(Select),
    Ready(Ready),
    Call(Call),
    HostCall(HostCall),
    HostResult(HostResult),
    Accepted(Accepted),
    Result(CallResult),
    SystemCall(SystemCall),
    SystemResult(SystemResult),
    StreamOpen(StreamOpen),
    StreamItem(StreamItem),
    Credit(Credit),
    Cancel(Cancel),
    CancelAck(CancelAck),
    StreamEnd(StreamEnd),
    Terminal(Terminal),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub protocol: String,
    pub contracts: Vec<ContractRef>,
    pub methods: Vec<MethodPort>,
    pub slots: Vec<SlotKind>,
    pub maximum_frame_bytes: u32,
    pub maximum_inflight: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Select {
    pub config: crate::api::PackageConfigView,
    pub protocol: String,
    pub generation_id: PluginGenerationId,
    pub implementation: ImplementationRef,
    pub contracts: Vec<ContractRef>,
    pub methods: Vec<MethodPort>,
    pub maximum_frame_bytes: u32,
    pub maximum_inflight: u32,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ready {
    pub config_digest: Digest,
    pub generation_id: PluginGenerationId,
    pub contracts: Vec<ContractRef>,
    pub methods: Vec<MethodPort>,
    pub implementation_digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Call {
    pub id: CallId,
    pub parent: Option<CallId>,
    pub contract: ContractRef,
    pub timeout: DurationMs,
    pub request: SlotRequest,
}
/// A driver import belongs to an accepted, nonterminal parent; it creates no authority root.
/// Parent cancellation/deadline joins its host I/O before returning Cancelled through HostResult.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCall {
    pub id: CallId,
    pub parent: CallId,
    pub contract: ContractRef,
    pub timeout: DurationMs,
    pub request: HostRequest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The host call's sole terminal response; it has no separate acceptance, terminal or streams.
pub struct HostResult {
    pub id: CallId,
    pub result: Result<HostResponse, Failure<HostFailure>>,
}
/// Ordinary imports only; storage roots, authorization, effects and peer proofs are private ports.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostRequest {
    SourceRead(crate::sources::SourceReadPlan),
    WorldRead(crate::query::QueryRequest),
    ModelGenerate(crate::generation::GenerationRequest),
    StateRead(StateRead),
    StateWrite(StateWrite),
    Clock,
    Log(LogRecord),
}
/// Host-provided service selection, not an access grant or a source provider.
#[derive(
    Clone,
    Copy,
    Debug,
    Eq,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum HostImport {
    WorldRead,
    ModelGenerate,
    StateRead,
    StateWrite,
    Clock,
    Log,
}
/// Canonical typed port; activation takes requiredness from the manifest requirement.
pub fn host_import_port(import: HostImport) -> Result<MethodPort, crate::schema::SchemaFailure> {
    match import {
        HostImport::WorldRead => {
            host_port::<crate::query::QueryRequest, crate::query::QueryPage, HostFailure>(
                "world-read.query",
            )
        }
        HostImport::ModelGenerate => host_port::<
            crate::generation::GenerationRequest,
            crate::generation::GenerationReceipt,
            HostFailure,
        >("model.generate"),
        HostImport::StateRead => {
            host_port::<StateRead, Option<StateValue>, HostFailure>("state.read")
        }
        HostImport::StateWrite => host_port::<StateWrite, StateValue, HostFailure>("state.write"),
        HostImport::Clock => host_port::<(), crate::time::Timestamp, HostFailure>("clock.now"),
        HostImport::Log => host_port::<LogRecord, (), HostFailure>("logging.log"),
    }
}
pub fn host_request_port(
    request: &HostRequest,
) -> Result<MethodPort, crate::schema::SchemaFailure> {
    match request {
        HostRequest::SourceRead(_) => host_port::<
            crate::sources::SourceReadPlan,
            crate::sources::SourcePage,
            crate::sources::SourceFailure,
        >("source.read"),
        HostRequest::WorldRead(_) => host_import_port(HostImport::WorldRead),
        HostRequest::ModelGenerate(_) => host_import_port(HostImport::ModelGenerate),
        HostRequest::StateRead(_) => host_import_port(HostImport::StateRead),
        HostRequest::StateWrite(_) => host_import_port(HostImport::StateWrite),
        HostRequest::Clock => host_import_port(HostImport::Clock),
        HostRequest::Log(_) => host_import_port(HostImport::Log),
    }
}
fn host_port<
    Request: schemars::JsonSchema,
    Response: schemars::JsonSchema,
    Failure: schemars::JsonSchema,
>(
    id: &str,
) -> Result<MethodPort, crate::schema::SchemaFailure> {
    Ok(MethodPort {
        name: id.into(),
        contract: crate::schema::method::<Request, Response, Failure>(id)?,
        request_schema: crate::schema::digest::<Request>()?,
        result_schema: crate::schema::digest::<Response>()?,
        direction: crate::bindings::PortDirection::Import,
        required: true,
    })
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostResponse {
    SourceRead(crate::sources::SourcePage),
    WorldRead(crate::query::QueryPage),
    ModelGenerate(crate::generation::GenerationReceipt),
    StateRead(Option<StateValue>),
    StateWrite(StateValue),
    Clock(crate::time::Timestamp),
    Log,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostFailure {
    Process(ProcessFailure),
    Operation(crate::operation::OperationFailure),
    Input(crate::failure::InputFailure),
    Authorization(crate::authorization::AuthorizationFailure),
    Binding(crate::bindings::BindingFailure),
    Source(crate::sources::SourceFailure),
    Slot(crate::slots::SlotFailure),
    Query(crate::query::QueryFailure),
    Generation(crate::generation::GenerationFailure),
    State(crate::state::StateFailure),
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateRead {
    pub key: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateWrite {
    pub key: String,
    pub expected_revision: Option<Revision>,
    pub value: Vec<u8>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateValue {
    pub revision: Revision,
    pub value: Vec<u8>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogRecord {
    pub level: LogLevel,
    pub code: String,
    pub message: String,
}
pub const MAX_STATE_KEY_BYTES: usize = 1024;
pub const MAX_STATE_VALUE_BYTES: usize = 131_072;
pub const MAX_LOG_BYTES: usize = 4096;
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Accepted {
    pub id: CallId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Authoritative typed result; additional output streams never replace or merge into it.
pub struct CallResult {
    pub id: CallId,
    pub result: Result<SlotResponse, Failure<SlotFailure>>,
    pub effects: Vec<crate::actions::SourceReceipt>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemCall {
    pub id: CallId,
    pub method: SystemMethod,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SystemMethod {
    Describe,
    Health,
    Prepare {
        activation_lock_id: ActivationLockId,
    },
    Start,
    Drain {
        cutoff: Sequence,
        operation: LifecycleOperation,
    },
    Stop {
        operation: LifecycleOperation,
    },
    Checkpoint {
        format: CheckpointFormatId,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemResult {
    pub id: CallId,
    pub result: Result<SystemValue, ProcessFailure>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SystemValue {
    Description {
        contracts: Vec<ContractRef>,
        methods: Vec<MethodPort>,
        slots: Vec<SlotKind>,
    },
    Health {
        ready: bool,
    },
    Prepared {
        activation_lock_id: ActivationLockId,
    },
    Started,
    Drained {
        cutoff: Sequence,
    },
    StopAcknowledged,
    Checkpoint {
        format: CheckpointFormatId,
        bytes: Vec<u8>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Additional output with its own schema; no implicit codec or replacement of CallResult.
pub struct StreamOpen {
    pub id: CallId,
    pub stream_id: StreamId,
    pub content_schema: Digest,
}
pub const MAX_STREAMS_PER_CALL: usize = 8;
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamItem {
    pub id: CallId,
    pub stream_id: StreamId,
    pub sequence: Sequence,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credit {
    pub id: CallId,
    pub stream_id: StreamId,
    pub consumed_sequence: Option<Sequence>,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub bytes: u64,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub items: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cancel {
    pub id: CallId,
    pub cancellation_id: RequestId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelAck {
    pub id: CallId,
    pub cancellation_id: RequestId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamEnd {
    pub id: CallId,
    pub stream_id: StreamId,
    pub state: TerminalState,
    pub last_sequence: Option<Sequence>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Call terminal has no shared stream sequence: last_sequence is None; each StreamEnd carries its own final sequence.
pub struct Terminal {
    pub id: CallId,
    pub state: TerminalState,
    pub last_sequence: Option<Sequence>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalState {
    Completed,
    Failed,
    Cancelled,
    Retained,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProcessFailure {
    InvalidRequestId,
    SpawnFailed,
    SandboxUnavailable,
    StdioFailed,
    ReadinessFailed,
    TransportClosed,
    BackpressureTimeout,
    HandshakeTimeout,
    HandshakeMismatch,
    ContractMismatch { contract_id: ContractId },
    FrameEmpty,
    FrameTooLarge,
    FrameMalformed,
    PartialHeader,
    PartialBody,
    DuplicateRequest,
    UnexpectedDirection,
    UnknownCorrelation,
    CreditExceeded,
    SequenceMismatch,
    ChildExited { code: Option<i32> },
    ReadFailed,
    WriteFailed,
    FlushFailed,
    CancelTimeout,
    ExitUnconfirmed,
    Retained,
    InternalFault,
}
pub fn frame_length(header: [u8; 4], handshake: bool) -> Result<usize, ProcessFailure> {
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 {
        return Err(ProcessFailure::FrameEmpty);
    }
    if size
        > if handshake {
            MAX_HANDSHAKE_BYTES
        } else {
            MAX_FRAME_BYTES
        }
    {
        return Err(ProcessFailure::FrameTooLarge);
    }
    Ok(size)
}
pub fn encode_frame(frame: &Frame, handshake: bool) -> Result<Vec<u8>, crate::wire::CodecFailure> {
    let body = crate::wire::encode(
        frame,
        if handshake {
            MAX_HANDSHAKE_BYTES
        } else {
            MAX_FRAME_BYTES
        },
    )?;
    let mut bytes = Vec::with_capacity(body.len() + 4);
    bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&body);
    Ok(bytes)
}
pub fn decode_frame(body: &[u8], handshake: bool) -> Result<Frame, crate::wire::CodecFailure> {
    crate::wire::decode(
        body,
        if handshake {
            MAX_HANDSHAKE_BYTES
        } else {
            MAX_FRAME_BYTES
        },
    )
}
