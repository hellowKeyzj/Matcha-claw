use std::{collections::BTreeMap, fmt};

const MAX_FIELD_BYTES: usize = 128;
const MAX_NOTE_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionType {
    Retry,
    ProceedDegraded,
    Abort,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TeamDecisionCommand {
    decision_id: String,
    run_id: String,
    stage_id: String,
    decision: TeamDecisionType,
    note: Option<String>,
    idempotency_key: String,
    created_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionCommandError {
    InvalidDecisionId,
    InvalidRunId,
    InvalidStageId,
    InvalidIdempotencyKey,
    InvalidNote,
}

impl TeamDecisionCommand {
    pub fn try_new(
        decision_id: impl Into<String>,
        run_id: impl Into<String>,
        stage_id: impl Into<String>,
        decision: TeamDecisionType,
        note: Option<String>,
        idempotency_key: impl Into<String>,
        created_at: u64,
    ) -> Result<Self, TeamDecisionCommandError> {
        let decision_id = decision_id.into();
        let run_id = run_id.into();
        let stage_id = stage_id.into();
        let idempotency_key = idempotency_key.into();
        if !valid_field(&decision_id) {
            return Err(TeamDecisionCommandError::InvalidDecisionId);
        }
        if !valid_field(&run_id) {
            return Err(TeamDecisionCommandError::InvalidRunId);
        }
        if !valid_field(&stage_id) {
            return Err(TeamDecisionCommandError::InvalidStageId);
        }
        if !valid_field(&idempotency_key) {
            return Err(TeamDecisionCommandError::InvalidIdempotencyKey);
        }
        if note
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > MAX_NOTE_BYTES)
        {
            return Err(TeamDecisionCommandError::InvalidNote);
        }
        Ok(Self {
            decision_id,
            run_id,
            stage_id,
            decision,
            note,
            idempotency_key,
            created_at,
        })
    }

    pub fn decision_id(&self) -> &str {
        &self.decision_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn stage_id(&self) -> &str {
        &self.stage_id
    }
    pub const fn decision(&self) -> TeamDecisionType {
        self.decision
    }
    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

impl fmt::Debug for TeamDecisionCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamDecisionCommand")
            .field("decision_id", &self.decision_id)
            .field("run_id", &self.run_id)
            .field("stage_id", &self.stage_id)
            .field("decision", &self.decision)
            .field("has_note", &self.note.is_some())
            .field("idempotency_key", &self.idempotency_key)
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionReceipt {
    decision: TeamDecision,
    replayed: bool,
}

impl TeamDecisionReceipt {
    pub(crate) fn recorded(decision: TeamDecision) -> Self {
        Self {
            decision,
            replayed: false,
        }
    }

    pub(crate) fn replayed(decision: TeamDecision) -> Self {
        Self {
            decision,
            replayed: true,
        }
    }

    pub fn decision(&self) -> &TeamDecision {
        &self.decision
    }
    pub const fn is_replay(&self) -> bool {
        self.replayed
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamDecisionRecordError {
    ConflictingIdempotencyKey,
    DuplicateDecisionId,
    SequenceOverflow,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionSnapshot {
    pub(crate) sequence: u64,
    decision_id: String,
    run_id: String,
    stage_id: String,
    decision: TeamDecisionType,
    note: Option<String>,
    idempotency_key: String,
    created_at: u64,
}

impl From<&TeamDecision> for TeamDecisionSnapshot {
    fn from(decision: &TeamDecision) -> Self {
        Self {
            sequence: decision.sequence,
            decision_id: decision.decision_id().to_owned(),
            run_id: decision.run_id().to_owned(),
            stage_id: decision.stage_id().to_owned(),
            decision: decision.decision(),
            note: decision.note().map(ToOwned::to_owned),
            idempotency_key: decision.idempotency_key().to_owned(),
            created_at: decision.created_at(),
        }
    }
}

impl TeamDecisionSnapshot {
    pub(crate) fn from_durable(sequence: u64, command: TeamDecisionCommand) -> Self {
        Self {
            sequence,
            decision_id: command.decision_id().to_owned(),
            run_id: command.run_id().to_owned(),
            stage_id: command.stage_id().to_owned(),
            decision: command.decision(),
            note: command.note().map(ToOwned::to_owned),
            idempotency_key: command.idempotency_key().to_owned(),
            created_at: command.created_at(),
        }
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn decision_id(&self) -> &str {
        &self.decision_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn stage_id(&self) -> &str {
        &self.stage_id
    }

    pub(crate) fn command(&self) -> Result<TeamDecisionCommand, TeamDecisionCommandError> {
        TeamDecisionCommand::try_new(
            self.decision_id.clone(),
            self.run_id.clone(),
            self.stage_id.clone(),
            self.decision,
            self.note.clone(),
            self.idempotency_key.clone(),
            self.created_at,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionEventType {
    Submitted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionEvent {
    event_id: String,
    run_id: String,
    sequence: u64,
    event_type: TeamDecisionEventType,
    decision: TeamDecision,
}

impl TeamDecisionEvent {
    pub(crate) fn submitted(decision: TeamDecision) -> Self {
        Self {
            event_id: decision.decision_id().to_owned(),
            run_id: decision.run_id().to_owned(),
            sequence: decision.sequence(),
            event_type: TeamDecisionEventType::Submitted,
            decision,
        }
    }

    fn from_snapshot(
        snapshot: &TeamDecisionEventSnapshot,
    ) -> Result<Self, TeamDecisionEventRestoreError> {
        let command = snapshot
            .decision
            .command()
            .map_err(TeamDecisionEventRestoreError::InvalidCommand)?;
        if snapshot.run_id != command.run_id()
            || snapshot.event_id != command.decision_id()
            || snapshot.sequence != snapshot.decision.sequence
        {
            return Err(TeamDecisionEventRestoreError::IdentityMismatch);
        }
        Ok(Self {
            event_id: snapshot.event_id.clone(),
            run_id: snapshot.run_id.clone(),
            sequence: snapshot.sequence,
            event_type: TeamDecisionEventType::Submitted,
            decision: TeamDecision::from_durable(snapshot.decision.sequence, command),
        })
    }

    pub fn event_id(&self) -> &str {
        &self.event_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn event_type(&self) -> TeamDecisionEventType {
        self.event_type
    }

    pub fn decision(&self) -> &TeamDecision {
        &self.decision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionEventRestoreError {
    InvalidCommand(TeamDecisionCommandError),
    IdentityMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionEventSnapshot {
    event_id: String,
    run_id: String,
    sequence: u64,
    decision: TeamDecisionSnapshot,
}

impl From<&TeamDecisionEvent> for TeamDecisionEventSnapshot {
    fn from(event: &TeamDecisionEvent) -> Self {
        Self {
            event_id: event.event_id.clone(),
            run_id: event.run_id.clone(),
            sequence: event.sequence,
            decision: TeamDecisionSnapshot::from(&event.decision),
        }
    }
}

impl TeamDecisionEventSnapshot {
    pub(crate) fn from_durable(
        event_id: String,
        run_id: String,
        sequence: u64,
        decision: TeamDecisionSnapshot,
    ) -> Self {
        Self {
            event_id,
            run_id,
            sequence,
            decision,
        }
    }

    pub fn event_id(&self) -> &str {
        &self.event_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn decision(&self) -> &TeamDecisionSnapshot {
        &self.decision
    }

    pub(crate) fn event(&self) -> Result<TeamDecisionEvent, TeamDecisionEventRestoreError> {
        TeamDecisionEvent::from_snapshot(self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct TeamDecisionState {
    decisions: BTreeMap<(String, String), TeamDecision>,
}

impl TeamDecisionState {
    pub fn decision(&self, run_id: &str, idempotency_key: &str) -> Option<&TeamDecision> {
        self.decisions
            .get(&(run_id.to_owned(), idempotency_key.to_owned()))
    }

    pub fn decisions_for_run(&self, run_id: &str) -> impl Iterator<Item = &TeamDecision> {
        self.decisions
            .values()
            .filter(move |decision| decision.run_id() == run_id)
    }

    pub fn decisions(&self) -> impl Iterator<Item = &TeamDecision> {
        self.decisions.values()
    }

    pub(crate) fn retain_without_run(&mut self, run_id: &str) {
        self.decisions
            .retain(|(candidate, _), _| candidate != run_id);
    }

    fn decision_count_for_run(&self, run_id: &str) -> usize {
        self.decisions_for_run(run_id).count()
    }

    pub fn apply(&mut self, event: &TeamDecisionEvent) -> Result<(), TeamDecisionReducerError> {
        TeamDecisionReducer::default().reduce(self, event)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionReducerError {
    InvalidEvent,
    SequenceGap,
    SequenceOverflow,
    ConflictingIdempotencyKey,
    DuplicateDecisionId,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TeamDecisionReducer;

impl TeamDecisionReducer {
    pub fn reduce(
        &self,
        state: &mut TeamDecisionState,
        event: &TeamDecisionEvent,
    ) -> Result<(), TeamDecisionReducerError> {
        if event.event_type != TeamDecisionEventType::Submitted
            || event.run_id != event.decision.run_id()
            || event.sequence != event.decision.sequence()
            || !valid_field(event.event_id())
        {
            return Err(TeamDecisionReducerError::InvalidEvent);
        }
        let expected_sequence = state
            .decision_count_for_run(event.run_id())
            .checked_add(1)
            .ok_or(TeamDecisionReducerError::SequenceOverflow)?;
        if event.sequence() != expected_sequence as u64 {
            return Err(TeamDecisionReducerError::SequenceGap);
        }
        let key = (
            event.run_id().to_owned(),
            event.decision().idempotency_key().to_owned(),
        );
        if let Some(existing) = state.decisions.get(&key) {
            return if existing == event.decision() {
                Err(TeamDecisionReducerError::ConflictingIdempotencyKey)
            } else {
                Err(TeamDecisionReducerError::ConflictingIdempotencyKey)
            };
        }
        if state.decisions.values().any(|decision| {
            decision.run_id() == event.run_id()
                && decision.decision_id() == event.decision().decision_id()
        }) {
            return Err(TeamDecisionReducerError::DuplicateDecisionId);
        }
        state.decisions.insert(key, event.decision().clone());
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct TeamDecisionLedgerSnapshot {
    pub(crate) decisions: Vec<TeamDecisionSnapshot>,
    pub(crate) events: Vec<TeamDecisionEventSnapshot>,
}

impl TeamDecisionLedgerSnapshot {
    pub(crate) fn from_durable(
        decisions: Vec<TeamDecisionSnapshot>,
        events: Vec<TeamDecisionEventSnapshot>,
    ) -> Self {
        Self { decisions, events }
    }

    pub fn decisions(&self) -> &[TeamDecisionSnapshot] {
        &self.decisions
    }

    pub fn events(&self) -> &[TeamDecisionEventSnapshot] {
        &self.events
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamDecisionLedgerRestoreError {
    InvalidCommand(TeamDecisionCommandError),
    InvalidEvent(TeamDecisionEventRestoreError),
    DuplicateIdempotencyKey,
    DuplicateDecisionId,
    DuplicateEventId,
    SequenceGap,
    EventSequenceGap,
    EventDoesNotMatchDecision,
    MissingDecisionEvent,
    SequenceOverflow,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecision {
    command: TeamDecisionCommand,
    sequence: u64,
}

impl TeamDecision {
    pub(crate) fn from_durable(sequence: u64, command: TeamDecisionCommand) -> Self {
        Self { command, sequence }
    }

    pub(crate) fn new(sequence: u64, command: TeamDecisionCommand) -> Self {
        Self { command, sequence }
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn decision_id(&self) -> &str {
        self.command.decision_id()
    }
    pub fn run_id(&self) -> &str {
        self.command.run_id()
    }
    pub fn stage_id(&self) -> &str {
        self.command.stage_id()
    }
    pub const fn decision(&self) -> TeamDecisionType {
        self.command.decision()
    }
    pub fn note(&self) -> Option<&str> {
        self.command.note()
    }
    pub fn idempotency_key(&self) -> &str {
        self.command.idempotency_key()
    }
    pub const fn created_at(&self) -> u64 {
        self.command.created_at()
    }
    pub fn command(&self) -> &TeamDecisionCommand {
        &self.command
    }
}

fn valid_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_FIELD_BYTES
}
