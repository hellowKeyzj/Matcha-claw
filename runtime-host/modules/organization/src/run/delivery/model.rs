use std::fmt;

use serde_json::Value;

use crate::{
    ports::{DeliveryReceiptReference, EndpointSessionId},
    run::graph::ExecutionFence,
};

pub const DELIVERY_MAX_ATTEMPTS: u32 = 3;
pub const DELIVERY_RETRY_DELAY_MS: u64 = 30_000;

pub const fn delivery_retry_at(observed_at: u64) -> u64 {
    observed_at.saturating_add(DELIVERY_RETRY_DELAY_MS)
}

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DeliveryId(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryIdError {
    Blank,
}

impl fmt::Debug for DeliveryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeliveryId(<redacted>)")
    }
}

impl DeliveryId {
    pub fn new(value: impl Into<String>) -> Result<Self, DeliveryIdError> {
        let value = value.into();

        if value.trim().is_empty() {
            return Err(DeliveryIdError::Blank);
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct DeliveryRequest {
    pub delivery_id: DeliveryId,
    pub team_id: String,
    pub run_id: String,
    pub node_id: String,
    pub node_execution_id: String,
    pub task_id: String,
    pub role_id: String,
    pub session_ref: String,
    pub idempotency_key: String,
    /// Opaque role-session message owned solely by the private delivery fact.
    pub message: String,
    pub requested_at: u64,
    pub max_attempts: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryRequestError {
    BlankTeamId,
    BlankRunId,
    BlankNodeId,
    BlankNodeExecutionId,
    BlankTaskId,
    BlankRoleId,
    InvalidSessionRef,
    BlankIdempotencyKey,
    BlankMessage,
    ZeroMaxAttempts,
}

impl fmt::Debug for DeliveryRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveryRequest")
            .field("delivery_id", &"<redacted>")
            .field("team_id", &"<redacted>")
            .field("run_id", &"<redacted>")
            .field("node_id", &"<redacted>")
            .field("node_execution_id", &"<redacted>")
            .field("task_id", &"<redacted>")
            .field("role_id", &"<redacted>")
            .field("session_ref", &"<redacted>")
            .field("idempotency_key", &"<redacted>")
            .field("message", &"<redacted>")
            .field("requested_at", &self.requested_at)
            .field("max_attempts", &self.max_attempts)
            .finish()
    }
}

impl DeliveryRequest {
    pub fn validate(&self) -> Result<(), DeliveryRequestError> {
        if self.team_id.trim().is_empty() {
            return Err(DeliveryRequestError::BlankTeamId);
        }
        if self.run_id.trim().is_empty() {
            return Err(DeliveryRequestError::BlankRunId);
        }
        if self.node_id.trim().is_empty() {
            return Err(DeliveryRequestError::BlankNodeId);
        }
        if self.node_execution_id.trim().is_empty() {
            return Err(DeliveryRequestError::BlankNodeExecutionId);
        }
        if self.task_id.trim().is_empty() {
            return Err(DeliveryRequestError::BlankTaskId);
        }
        if self.role_id.trim().is_empty() {
            return Err(DeliveryRequestError::BlankRoleId);
        }
        if crate::RoleSessionRef::try_new(self.session_ref.clone()).is_err() {
            return Err(DeliveryRequestError::InvalidSessionRef);
        }
        if self.idempotency_key.trim().is_empty() {
            return Err(DeliveryRequestError::BlankIdempotencyKey);
        }
        if self.message.trim().is_empty() {
            return Err(DeliveryRequestError::BlankMessage);
        }
        if self.max_attempts == 0 {
            return Err(DeliveryRequestError::ZeroMaxAttempts);
        }
        Ok(())
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct Delivery {
    pub(super) facts: DeliveryRequest,
    pub(super) phase: DeliveryPhase,
    pub(super) completed_attempts: u32,
    pub(super) next_claim_generation: u64,
}

#[derive(Clone, Eq, PartialEq)]
pub enum DeliveryPhase {
    Pending,
    Delivering(DeliveryClaim),
    RetryScheduled {
        retry_at: u64,
        failure: DeliveryFailure,
    },
    Delivered {
        receipt: DeliveryReceiptReference,
        native_correlation: Option<NativeDeliveryCorrelation>,
        accepted_at: u64,
    },
    TerminalObserved {
        observation: TerminalObservation,
    },
    Failed {
        failed_at: u64,
        failure: DeliveryFailure,
    },
    OutcomeUnknown {
        observed_at: u64,
    },
    Cancelled {
        cancelled_at: u64,
    },
}

#[derive(Clone, Eq, PartialEq)]
pub struct DeliveryClaim {
    delivery_id: DeliveryId,
    attempt: u32,
    generation: u64,
    claimed_at: u64,
}

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NativeRunReceiptReference(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidNativeRunReceiptReference;

impl NativeRunReceiptReference {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidNativeRunReceiptReference> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidNativeRunReceiptReference);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for NativeRunReceiptReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeRunReceiptReference(<redacted>)")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct NativeDeliveryCorrelation {
    endpoint_session_id: EndpointSessionId,
    native_run_receipt: NativeRunReceiptReference,
}

impl NativeDeliveryCorrelation {
    pub fn new(
        endpoint_session_id: EndpointSessionId,
        native_run_receipt: NativeRunReceiptReference,
    ) -> Self {
        Self {
            endpoint_session_id,
            native_run_receipt,
        }
    }

    pub fn endpoint_session_id(&self) -> &EndpointSessionId {
        &self.endpoint_session_id
    }

    pub fn native_run_receipt(&self) -> &NativeRunReceiptReference {
        &self.native_run_receipt
    }
}

impl fmt::Debug for NativeDeliveryCorrelation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeDeliveryCorrelation(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeTerminalStatus {
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AuthorizedGraphResolutionReceipt(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidAuthorizedGraphResolutionReceipt;

impl AuthorizedGraphResolutionReceipt {
    pub fn try_new(
        value: impl Into<String>,
    ) -> Result<Self, InvalidAuthorizedGraphResolutionReceipt> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidAuthorizedGraphResolutionReceipt);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AuthorizedGraphResolutionReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthorizedGraphResolutionReceipt(<redacted>)")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct AuthorizedGraphResolution {
    receipt: AuthorizedGraphResolutionReceipt,
    delivery_id: DeliveryId,
    graph_run_id: String,
    fence: ExecutionFence,
    outcome: AuthorizedGraphOutcome,
    output_port: String,
    resolved_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizedGraphOutcome {
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidAuthorizedGraphResolution {
    BlankGraphRunId,
    BlankOutputPort,
    UnsafeOutputPort,
}

impl AuthorizedGraphResolution {
    pub fn new(
        receipt: AuthorizedGraphResolutionReceipt,
        delivery_id: DeliveryId,
        graph_run_id: impl Into<String>,
        fence: ExecutionFence,
        outcome: AuthorizedGraphOutcome,
        output_port: impl Into<String>,
        resolved_at: u64,
    ) -> Result<Self, InvalidAuthorizedGraphResolution> {
        let graph_run_id = graph_run_id.into();
        if graph_run_id.trim().is_empty() {
            return Err(InvalidAuthorizedGraphResolution::BlankGraphRunId);
        }
        let output_port = output_port.into();
        if output_port.trim().is_empty() {
            return Err(InvalidAuthorizedGraphResolution::BlankOutputPort);
        }
        if !is_safe_output_port(&output_port) {
            return Err(InvalidAuthorizedGraphResolution::UnsafeOutputPort);
        }
        Ok(Self {
            receipt,
            delivery_id,
            graph_run_id,
            fence,
            outcome,
            output_port,
            resolved_at,
        })
    }

    pub fn receipt(&self) -> &AuthorizedGraphResolutionReceipt {
        &self.receipt
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub fn graph_run_id(&self) -> &str {
        &self.graph_run_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub const fn outcome(&self) -> AuthorizedGraphOutcome {
        self.outcome
    }

    pub(super) fn with_outcome(mut self, outcome: AuthorizedGraphOutcome) -> Self {
        self.outcome = outcome;
        self
    }

    pub fn output_port(&self) -> &str {
        &self.output_port
    }

    pub const fn resolved_at(&self) -> u64 {
        self.resolved_at
    }
}

fn is_safe_output_port(output_port: &str) -> bool {
    output_port
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
}

impl fmt::Debug for AuthorizedGraphResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthorizedGraphResolution")
            .field("receipt", &"<redacted>")
            .field("delivery_id", &"<redacted>")
            .field("graph_run_id", &"<redacted>")
            .field("fence", &"<redacted>")
            .field("outcome", &self.outcome)
            .field("output_port", &"<redacted>")
            .field("resolved_at", &self.resolved_at)
            .finish()
    }
}

const TEAM_MESSAGE_OPEN: &str = "<team_message>";
const TEAM_MESSAGE_CLOSE: &str = "</team_message>";
const MAX_TEAM_MESSAGE_SUMMARY_BYTES: usize = 512;

#[derive(Clone, Eq, PartialEq)]
pub struct TeamNodeOutput {
    final_assistant_text: String,
    summary: String,
    decision: String,
    dispatch: Vec<TeamNodeOutputDispatch>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamNodeOutputDispatch {
    role_id: String,
    task: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamNodeOutputError {
    MissingEnvelope,
    InvalidJson,
    MissingField(&'static str),
    UnexpectedField(String),
    InvalidField(&'static str),
    InvalidSummary,
    UnsafeDecision,
}

impl TeamNodeOutput {
    pub fn parse(final_assistant_text: impl Into<String>) -> Result<Self, TeamNodeOutputError> {
        let final_assistant_text = final_assistant_text.into();
        let json = extract_last_team_message(&final_assistant_text)?;
        let value = serde_json::from_str::<Value>(json.trim())
            .map_err(|_| TeamNodeOutputError::InvalidJson)?;
        Self::from_value(final_assistant_text, value)
    }

    pub fn restore(
        final_assistant_text: impl Into<String>,
        summary: impl Into<String>,
        decision: impl Into<String>,
        dispatch: Vec<TeamNodeOutputDispatch>,
    ) -> Result<Self, TeamNodeOutputError> {
        let final_assistant_text = final_assistant_text.into();
        if final_assistant_text.trim().is_empty() {
            return Err(TeamNodeOutputError::MissingEnvelope);
        }
        let summary = validate_summary(summary.into())?;
        let decision = validate_decision(decision.into())?;
        for item in &dispatch {
            validate_dispatch_string(&item.role_id, "role_id")?;
            validate_dispatch_string(&item.task, "task")?;
        }
        Ok(Self {
            final_assistant_text,
            summary,
            decision,
            dispatch,
        })
    }

    fn from_value(final_assistant_text: String, value: Value) -> Result<Self, TeamNodeOutputError> {
        let Some(object) = value.as_object() else {
            return Err(TeamNodeOutputError::InvalidField("root"));
        };
        for field in object.keys() {
            if !matches!(field.as_str(), "summary" | "decision" | "dispatch") {
                return Err(TeamNodeOutputError::UnexpectedField(field.clone()));
            }
        }
        let summary = required_message_string(object, "summary")?;
        let decision = required_message_string(object, "decision")?;
        let dispatch = required_dispatch(object.get("dispatch"))?;
        Self::restore(final_assistant_text, summary, decision, dispatch)
    }

    pub fn final_assistant_text(&self) -> &str {
        &self.final_assistant_text
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn decision(&self) -> &str {
        &self.decision
    }

    pub fn dispatch(&self) -> &[TeamNodeOutputDispatch] {
        &self.dispatch
    }
}

impl TeamNodeOutputDispatch {
    pub fn new(
        role_id: impl Into<String>,
        task: impl Into<String>,
    ) -> Result<Self, TeamNodeOutputError> {
        let role_id = role_id.into();
        let task = task.into();
        validate_dispatch_string(&role_id, "role_id")?;
        validate_dispatch_string(&task, "task")?;
        Ok(Self { role_id, task })
    }

    pub fn role_id(&self) -> &str {
        &self.role_id
    }

    pub fn task(&self) -> &str {
        &self.task
    }
}

impl fmt::Debug for TeamNodeOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamNodeOutput")
            .field("final_assistant_text", &"<redacted>")
            .field("summary", &"<redacted>")
            .field("decision", &"<redacted>")
            .field("dispatch", &self.dispatch.len())
            .finish()
    }
}

fn extract_last_team_message(text: &str) -> Result<&str, TeamNodeOutputError> {
    let close = text
        .rfind(TEAM_MESSAGE_CLOSE)
        .ok_or(TeamNodeOutputError::MissingEnvelope)?;
    let before_close = &text[..close];
    let open = before_close
        .rfind(TEAM_MESSAGE_OPEN)
        .ok_or(TeamNodeOutputError::MissingEnvelope)?;
    Ok(&before_close[open + TEAM_MESSAGE_OPEN.len()..])
}

fn required_message_string(
    object: &serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<String, TeamNodeOutputError> {
    match object.get(field) {
        Some(Value::String(value)) => Ok(value.to_owned()),
        Some(_) => Err(TeamNodeOutputError::InvalidField(field)),
        None => Err(TeamNodeOutputError::MissingField(field)),
    }
}

fn required_dispatch(
    value: Option<&Value>,
) -> Result<Vec<TeamNodeOutputDispatch>, TeamNodeOutputError> {
    let Some(Value::Array(items)) = value else {
        return match value {
            Some(_) => Err(TeamNodeOutputError::InvalidField("dispatch")),
            None => Err(TeamNodeOutputError::MissingField("dispatch")),
        };
    };
    let mut dispatch = Vec::with_capacity(items.len());
    for item in items {
        let Some(object) = item.as_object() else {
            return Err(TeamNodeOutputError::InvalidField("dispatch"));
        };
        for field in object.keys() {
            if !matches!(field.as_str(), "role_id" | "task") {
                return Err(TeamNodeOutputError::UnexpectedField(format!(
                    "dispatch.{field}"
                )));
            }
        }
        dispatch.push(TeamNodeOutputDispatch::new(
            required_message_string(object, "role_id")?,
            required_message_string(object, "task")?,
        )?);
    }
    Ok(dispatch)
}

fn validate_summary(summary: String) -> Result<String, TeamNodeOutputError> {
    if summary.trim().is_empty()
        || summary.len() > MAX_TEAM_MESSAGE_SUMMARY_BYTES
        || summary.chars().any(char::is_control)
    {
        return Err(TeamNodeOutputError::InvalidSummary);
    }
    Ok(summary)
}

fn validate_decision(decision: String) -> Result<String, TeamNodeOutputError> {
    if decision.trim().is_empty() || !is_safe_output_port(&decision) {
        return Err(TeamNodeOutputError::UnsafeDecision);
    }
    Ok(decision)
}

fn validate_dispatch_string(value: &str, field: &'static str) -> Result<(), TeamNodeOutputError> {
    if value.trim().is_empty() {
        return Err(TeamNodeOutputError::InvalidField(field));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalObservationResolution {
    AwaitingAuthorizedGraphResolution,
    GraphResolved(AuthorizedGraphResolution),
    NodeCancelled,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TerminalObservation {
    payload: Box<TerminalObservationPayload>,
}

#[derive(Clone, Eq, PartialEq)]
pub(super) struct TerminalObservationPayload {
    pub(super) delivery_id: DeliveryId,
    pub(super) graph_run_id: String,
    pub(super) node_id: String,
    pub(super) fence: ExecutionFence,
    pub(super) role_id: String,
    pub(super) correlation: NativeDeliveryCorrelation,
    pub(super) delivered_receipt: DeliveryReceiptReference,
    pub(super) native_terminal: NativeTerminalStatus,
    pub(super) observed_at: u64,
    pub(super) output: Option<TeamNodeOutput>,
    pub(super) resolution: TerminalObservationResolution,
}

impl TerminalObservation {
    pub(crate) fn new(
        facts: &DeliveryRequest,
        fence: ExecutionFence,
        correlation: &NativeDeliveryCorrelation,
        delivered_receipt: DeliveryReceiptReference,
        native_terminal: NativeTerminalStatus,
        observed_at: u64,
        resolution: TerminalObservationResolution,
    ) -> Self {
        Self {
            payload: Box::new(TerminalObservationPayload {
                delivery_id: facts.delivery_id.clone(),
                graph_run_id: facts.run_id.clone(),
                node_id: facts.node_id.clone(),
                fence,
                role_id: facts.role_id.clone(),
                correlation: correlation.clone(),
                delivered_receipt,
                native_terminal,
                observed_at,
                output: None,
                resolution,
            }),
        }
    }

    pub(super) fn restore(payload: TerminalObservationPayload) -> Self {
        Self {
            payload: Box::new(payload),
        }
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.payload.delivery_id
    }

    pub fn graph_run_id(&self) -> &str {
        &self.payload.graph_run_id
    }

    pub fn node_id(&self) -> &str {
        &self.payload.node_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.payload.fence
    }

    pub fn role_id(&self) -> &str {
        &self.payload.role_id
    }

    pub fn correlation(&self) -> &NativeDeliveryCorrelation {
        &self.payload.correlation
    }

    pub fn endpoint_session_id(&self) -> &EndpointSessionId {
        self.payload.correlation.endpoint_session_id()
    }

    pub fn delivered_receipt(&self) -> &DeliveryReceiptReference {
        &self.payload.delivered_receipt
    }

    pub fn native_run_receipt(&self) -> &NativeRunReceiptReference {
        self.payload.correlation.native_run_receipt()
    }

    pub const fn native_terminal(&self) -> NativeTerminalStatus {
        self.payload.native_terminal
    }

    pub const fn observed_at(&self) -> u64 {
        self.payload.observed_at
    }

    pub fn output(&self) -> Option<&TeamNodeOutput> {
        self.payload.output.as_ref()
    }

    pub fn resolution(&self) -> &TerminalObservationResolution {
        &self.payload.resolution
    }

    pub(crate) fn resolve_graph(
        &mut self,
        output: Option<TeamNodeOutput>,
        resolution: AuthorizedGraphResolution,
    ) {
        if let Some(output) = output {
            self.payload.output = Some(output);
        }
        self.payload.resolution = TerminalObservationResolution::GraphResolved(resolution);
    }

    pub(crate) fn matches_native_fact(&self, other: &Self) -> bool {
        self.delivery_id() == other.delivery_id()
            && self.graph_run_id() == other.graph_run_id()
            && self.node_id() == other.node_id()
            && self.fence() == other.fence()
            && self.role_id() == other.role_id()
            && self.correlation() == other.correlation()
            && self.delivered_receipt() == other.delivered_receipt()
            && self.native_terminal() == other.native_terminal()
            && self.observed_at() == other.observed_at()
    }
}

impl fmt::Debug for TerminalObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalObservation")
            .field("delivery_id", &"<redacted>")
            .field("graph_run_id", &"<redacted>")
            .field("node_id", &"<redacted>")
            .field("fence", &"<redacted>")
            .field("role_id", &"<redacted>")
            .field("endpoint_session_id", &"<redacted>")
            .field("delivered_receipt", &"<redacted>")
            .field("native_run_receipt", &"<redacted>")
            .field("native_terminal", &self.payload.native_terminal)
            .field("observed_at", &self.payload.observed_at)
            .field("has_output", &self.payload.output.is_some())
            .field("resolution", &self.payload.resolution)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryFailure {
    ReceiverRejected,
    PolicyRejected,
    Unavailable,
    TimedOut,
}

impl DeliveryFailure {
    pub const fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::ReceiverRejected | Self::Unavailable | Self::TimedOut
        )
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum DeliveryReceipt {
    Accepted {
        receipt: DeliveryReceiptReference,
        native_correlation: Option<NativeDeliveryCorrelation>,
        accepted_at: u64,
    },
    Rejected {
        failure: DeliveryFailure,
        observed_at: u64,
    },
    OutcomeUnknown {
        observed_at: u64,
    },
}

impl fmt::Debug for DeliveryClaim {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveryClaim")
            .field("delivery_id", &"<redacted>")
            .field("attempt", &self.attempt)
            .field("generation", &self.generation)
            .field("claimed_at", &self.claimed_at)
            .finish()
    }
}

impl fmt::Debug for DeliveryPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::Delivering(claim) => formatter.debug_tuple("Delivering").field(claim).finish(),
            Self::RetryScheduled { retry_at, failure } => formatter
                .debug_struct("RetryScheduled")
                .field("retry_at", retry_at)
                .field("failure", failure)
                .finish(),
            Self::Delivered { accepted_at, .. } => formatter
                .debug_struct("Delivered")
                .field("receipt", &"<redacted>")
                .field("accepted_at", accepted_at)
                .finish(),
            Self::TerminalObserved { observation } => formatter
                .debug_struct("TerminalObserved")
                .field("observation", observation)
                .finish(),
            Self::Failed { failed_at, failure } => formatter
                .debug_struct("Failed")
                .field("failed_at", failed_at)
                .field("failure", failure)
                .finish(),
            Self::OutcomeUnknown { observed_at } => formatter
                .debug_struct("OutcomeUnknown")
                .field("observed_at", observed_at)
                .finish(),
            Self::Cancelled { cancelled_at } => formatter
                .debug_struct("Cancelled")
                .field("cancelled_at", cancelled_at)
                .finish(),
        }
    }
}

impl fmt::Debug for DeliveryReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Accepted { accepted_at, .. } => formatter
                .debug_struct("Accepted")
                .field("receipt", &"<redacted>")
                .field("accepted_at", accepted_at)
                .finish(),
            Self::Rejected {
                failure,
                observed_at,
            } => formatter
                .debug_struct("Rejected")
                .field("failure", failure)
                .field("observed_at", observed_at)
                .finish(),
            Self::OutcomeUnknown { observed_at } => formatter
                .debug_struct("OutcomeUnknown")
                .field("observed_at", observed_at)
                .finish(),
        }
    }
}

impl fmt::Debug for Delivery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Delivery")
            .field("facts", &self.facts)
            .field("phase", &self.phase)
            .field("next_claim_generation", &self.next_claim_generation)
            .finish()
    }
}

impl Delivery {
    pub fn request(facts: DeliveryRequest) -> Result<Self, DeliveryRequestError> {
        facts.validate()?;

        Ok(Self {
            facts,
            phase: DeliveryPhase::Pending,
            completed_attempts: 0,
            next_claim_generation: 1,
        })
    }

    pub fn facts(&self) -> &DeliveryRequest {
        &self.facts
    }

    pub fn phase(&self) -> &DeliveryPhase {
        &self.phase
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            &self.phase,
            DeliveryPhase::Delivered { .. }
                | DeliveryPhase::TerminalObserved { .. }
                | DeliveryPhase::Failed { .. }
                | DeliveryPhase::OutcomeUnknown { .. }
                | DeliveryPhase::Cancelled { .. }
        )
    }

    pub fn cancel(&mut self, cancelled_at: u64) {
        if !self.is_terminal() {
            self.phase = DeliveryPhase::Cancelled { cancelled_at };
        }
    }

    pub(crate) fn start_claim(&mut self, claimed_at: u64) -> DeliveryClaim {
        let claim = DeliveryClaim {
            delivery_id: self.facts.delivery_id.clone(),
            attempt: self.completed_attempts + 1,
            generation: self.next_claim_generation,
            claimed_at,
        };
        self.next_claim_generation += 1;
        self.phase = DeliveryPhase::Delivering(claim.clone());
        claim
    }

    pub(crate) fn schedule_retry(
        &mut self,
        retry_at: u64,
        observed_at: u64,
        failure: DeliveryFailure,
    ) -> bool {
        self.completed_attempts += 1;
        if self.completed_attempts < self.facts.max_attempts {
            self.phase = DeliveryPhase::RetryScheduled { retry_at, failure };
            true
        } else {
            self.phase = DeliveryPhase::Failed {
                failed_at: observed_at,
                failure,
            };
            false
        }
    }

    pub fn active_claim(&self) -> Option<&DeliveryClaim> {
        match &self.phase {
            DeliveryPhase::Delivering(claim) => Some(claim),
            _ => None,
        }
    }

    pub(crate) fn mark_delivered(
        &mut self,
        receipt: DeliveryReceiptReference,
        native_correlation: Option<NativeDeliveryCorrelation>,
        accepted_at: u64,
    ) {
        self.completed_attempts += 1;
        self.phase = DeliveryPhase::Delivered {
            receipt,
            native_correlation,
            accepted_at,
        };
    }

    pub(crate) fn confirm_unknown_native_delivery(
        &mut self,
        receipt: DeliveryReceiptReference,
        correlation: NativeDeliveryCorrelation,
    ) -> bool {
        let DeliveryPhase::OutcomeUnknown { observed_at } = self.phase else {
            return false;
        };
        self.phase = DeliveryPhase::Delivered {
            receipt,
            native_correlation: Some(correlation),
            accepted_at: observed_at,
        };
        true
    }

    pub(crate) fn mark_terminal_observed(&mut self, observation: TerminalObservation) {
        self.phase = DeliveryPhase::TerminalObserved { observation };
    }

    pub(crate) fn mark_failed(&mut self, failed_at: u64, failure: DeliveryFailure) {
        self.completed_attempts += 1;
        self.phase = DeliveryPhase::Failed { failed_at, failure };
    }

    pub(crate) fn mark_outcome_unknown(&mut self, observed_at: u64) {
        self.completed_attempts += 1;
        self.phase = DeliveryPhase::OutcomeUnknown { observed_at };
    }
}

impl DeliveryClaim {
    pub(super) fn restore(
        delivery_id: DeliveryId,
        attempt: u32,
        generation: u64,
        claimed_at: u64,
    ) -> Self {
        Self {
            delivery_id,
            attempt,
            generation,
            claimed_at,
        }
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn claimed_at(&self) -> u64 {
        self.claimed_at
    }
}
