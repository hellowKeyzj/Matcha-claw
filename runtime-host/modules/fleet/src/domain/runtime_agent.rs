use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    time::{Duration, SystemTime},
};

use platform::endpoint::NativeAgentId;

use crate::domain::{command::CommandAttempt, outbox::DispatchAttempt};

const MAX_MESSAGE_LENGTH: usize = 512;
const MAX_PHASE_LENGTH: usize = 128;
const MAX_RUNTIME_IDS: usize = 64;
const MAX_COMMANDS: usize = 1_024;

pub type RuntimeAgentId = NativeAgentId;
pub use crate::domain::command::{CommandId, IdempotencyKey};
pub use crate::domain::topology::RuntimeId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorMessage(String);

impl OperatorMessage {
    pub fn try_new(value: impl Into<String>) -> Result<Self, RuntimeAgentInputError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(RuntimeAgentInputError::Empty("message"));
        }
        if value.len() > MAX_MESSAGE_LENGTH {
            return Err(RuntimeAgentInputError::TooLong("message"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProgressPhase(String);

impl ProgressPhase {
    pub fn try_new(value: impl Into<String>) -> Result<Self, RuntimeAgentInputError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(RuntimeAgentInputError::Empty("progress phase"));
        }
        if value.len() > MAX_PHASE_LENGTH {
            return Err(RuntimeAgentInputError::TooLong("progress phase"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAgentStatus {
    Starting,
    Running,
    Draining,
    Stopping,
    Stopped,
    Degraded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentHeartbeat {
    observed_at: SystemTime,
    status: RuntimeAgentStatus,
    runtime_ids: Vec<RuntimeId>,
    message: Option<OperatorMessage>,
}

impl RuntimeAgentHeartbeat {
    pub fn try_new(
        observed_at: SystemTime,
        status: RuntimeAgentStatus,
        runtime_ids: impl IntoIterator<Item = RuntimeId>,
        message: Option<OperatorMessage>,
    ) -> Result<Self, RuntimeAgentInputError> {
        let runtime_ids: Vec<_> = runtime_ids.into_iter().collect();
        if runtime_ids.len() > MAX_RUNTIME_IDS {
            return Err(RuntimeAgentInputError::TooManyRuntimeIds);
        }
        let unique_runtime_ids: BTreeSet<_> = runtime_ids.iter().cloned().collect();
        if unique_runtime_ids.len() != runtime_ids.len() {
            return Err(RuntimeAgentInputError::DuplicateRuntimeId);
        }
        Ok(Self {
            observed_at,
            status,
            runtime_ids,
            message,
        })
    }

    pub const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }

    pub const fn status(&self) -> RuntimeAgentStatus {
        self.status
    }

    pub fn runtime_ids(&self) -> &[RuntimeId] {
        &self.runtime_ids
    }

    pub fn message(&self) -> Option<&OperatorMessage> {
        self.message.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandCorrelation {
    command_id: CommandId,
    idempotency_key: IdempotencyKey,
}

impl CommandCorrelation {
    pub fn new(command_id: CommandId, idempotency_key: IdempotencyKey) -> Self {
        Self {
            command_id,
            idempotency_key,
        }
    }

    pub fn command_id(&self) -> &CommandId {
        &self.command_id
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAgentProgressState {
    Queued,
    Running,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentProgress {
    state: RuntimeAgentProgressState,
    phase: Option<ProgressPhase>,
    message: Option<OperatorMessage>,
    percent: Option<u8>,
}

impl RuntimeAgentProgress {
    pub fn new(
        state: RuntimeAgentProgressState,
        phase: Option<ProgressPhase>,
        message: Option<OperatorMessage>,
        percent: Option<u8>,
    ) -> Self {
        Self {
            state,
            phase,
            message,
            percent,
        }
    }

    pub const fn state(&self) -> RuntimeAgentProgressState {
        self.state
    }

    pub fn phase(&self) -> Option<&ProgressPhase> {
        self.phase.as_ref()
    }

    pub fn message(&self) -> Option<&OperatorMessage> {
        self.message.as_ref()
    }

    pub const fn percent(&self) -> Option<u8> {
        self.percent
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeAgentResult {
    Succeeded {
        completed_at: SystemTime,
    },
    Failed {
        completed_at: SystemTime,
        message: OperatorMessage,
    },
    Cancelled {
        completed_at: SystemTime,
        message: Option<OperatorMessage>,
    },
    TimedOut {
        completed_at: SystemTime,
        timeout: Duration,
    },
}

impl RuntimeAgentResult {
    pub const fn completed_at(&self) -> SystemTime {
        match self {
            Self::Succeeded { completed_at }
            | Self::Failed { completed_at, .. }
            | Self::Cancelled { completed_at, .. }
            | Self::TimedOut { completed_at, .. } => *completed_at,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgentCommand {
    correlation: CommandCorrelation,
    progress: RuntimeAgentProgress,
    result: Option<RuntimeAgentResult>,
    updated_at: SystemTime,
    command_attempt: Option<u64>,
    dispatch_attempt: Option<u64>,
}

impl RuntimeAgentCommand {
    pub(crate) fn restore(
        correlation: CommandCorrelation,
        progress: RuntimeAgentProgress,
        result: Option<RuntimeAgentResult>,
        updated_at: SystemTime,
        command_attempt: u64,
        dispatch_attempt: u64,
    ) -> Self {
        Self {
            correlation,
            progress,
            result,
            updated_at,
            command_attempt: Some(command_attempt),
            dispatch_attempt: Some(dispatch_attempt),
        }
    }

    fn queued(correlation: CommandCorrelation, queued_at: SystemTime) -> Self {
        Self {
            correlation,
            progress: RuntimeAgentProgress::new(
                RuntimeAgentProgressState::Queued,
                None,
                None,
                None,
            ),
            result: None,
            updated_at: queued_at,
            command_attempt: None,
            dispatch_attempt: None,
        }
    }

    pub fn correlation(&self) -> &CommandCorrelation {
        &self.correlation
    }

    pub fn progress(&self) -> &RuntimeAgentProgress {
        &self.progress
    }

    pub fn result(&self) -> Option<&RuntimeAgentResult> {
        self.result.as_ref()
    }

    pub const fn updated_at(&self) -> SystemTime {
        self.updated_at
    }

    pub const fn command_attempt(&self) -> Option<u64> {
        self.command_attempt
    }

    pub const fn dispatch_attempt(&self) -> Option<u64> {
        self.dispatch_attempt
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeAgent {
    id: RuntimeAgentId,
    last_heartbeat: Option<RuntimeAgentHeartbeat>,
    status: RuntimeAgentStatus,
    runtime_ids: Vec<RuntimeId>,
    commands: BTreeMap<CommandId, RuntimeAgentCommand>,
    command_ids_by_idempotency_key: BTreeMap<IdempotencyKey, CommandId>,
}

impl RuntimeAgent {
    pub fn new(id: RuntimeAgentId) -> Self {
        Self {
            id,
            last_heartbeat: None,
            status: RuntimeAgentStatus::Starting,
            runtime_ids: Vec::new(),
            commands: BTreeMap::new(),
            command_ids_by_idempotency_key: BTreeMap::new(),
        }
    }

    pub fn id(&self) -> &RuntimeAgentId {
        &self.id
    }

    pub fn restore(
        id: RuntimeAgentId,
        heartbeat: Option<RuntimeAgentHeartbeat>,
        commands: impl IntoIterator<Item = RuntimeAgentCommand>,
    ) -> Result<Self, RuntimeAgentError> {
        let mut agent = Self::new(id);
        if let Some(heartbeat) = heartbeat {
            agent.status = heartbeat.status();
            agent.runtime_ids = heartbeat.runtime_ids().to_vec();
            agent.last_heartbeat = Some(heartbeat);
        }
        for command in commands {
            let correlation = command.correlation.clone();
            if agent.commands.len() == MAX_COMMANDS
                || agent.commands.contains_key(correlation.command_id())
                || agent
                    .command_ids_by_idempotency_key
                    .contains_key(correlation.idempotency_key())
            {
                return Err(RuntimeAgentError::DuplicateCommandId);
            }
            agent.command_ids_by_idempotency_key.insert(
                correlation.idempotency_key().clone(),
                correlation.command_id().clone(),
            );
            agent
                .commands
                .insert(correlation.command_id().clone(), command);
        }
        Ok(agent)
    }

    pub const fn status(&self) -> RuntimeAgentStatus {
        self.status
    }

    pub fn last_heartbeat(&self) -> Option<&RuntimeAgentHeartbeat> {
        self.last_heartbeat.as_ref()
    }

    pub fn runtime_ids(&self) -> &[RuntimeId] {
        &self.runtime_ids
    }

    pub fn command(&self, command_id: &CommandId) -> Option<&RuntimeAgentCommand> {
        self.commands.get(command_id)
    }

    pub fn commands(&self) -> impl Iterator<Item = &RuntimeAgentCommand> {
        self.commands.values()
    }

    pub fn register_command(
        &mut self,
        correlation: CommandCorrelation,
        queued_at: SystemTime,
    ) -> Result<(), RuntimeAgentError> {
        self.register_command_internal(correlation, queued_at, None, None)
    }

    pub fn register_command_with_attempts(
        &mut self,
        correlation: CommandCorrelation,
        queued_at: SystemTime,
        command_attempt: CommandAttempt,
        dispatch_attempt: DispatchAttempt,
    ) -> Result<(), RuntimeAgentError> {
        self.register_command_internal(
            correlation,
            queued_at,
            Some(command_attempt.sequence()),
            Some(dispatch_attempt.sequence()),
        )
    }

    fn register_command_internal(
        &mut self,
        correlation: CommandCorrelation,
        queued_at: SystemTime,
        command_attempt: Option<u64>,
        dispatch_attempt: Option<u64>,
    ) -> Result<(), RuntimeAgentError> {
        if self.commands.len() == MAX_COMMANDS {
            return Err(RuntimeAgentError::CommandCapacityReached);
        }
        if self.commands.contains_key(correlation.command_id()) {
            return Err(RuntimeAgentError::DuplicateCommandId);
        }
        if self
            .command_ids_by_idempotency_key
            .contains_key(correlation.idempotency_key())
        {
            return Err(RuntimeAgentError::DuplicateIdempotencyKey);
        }
        self.command_ids_by_idempotency_key.insert(
            correlation.idempotency_key().clone(),
            correlation.command_id().clone(),
        );
        self.commands.insert(correlation.command_id().clone(), {
            let mut command = RuntimeAgentCommand::queued(correlation, queued_at);
            command.command_attempt = command_attempt;
            command.dispatch_attempt = dispatch_attempt;
            command
        });
        Ok(())
    }

    pub fn record_heartbeat(
        &mut self,
        agent_id: &RuntimeAgentId,
        heartbeat: RuntimeAgentHeartbeat,
    ) -> Result<RuntimeAgentReportOutcome, RuntimeAgentError> {
        self.ensure_agent(agent_id)?;
        if self
            .last_heartbeat
            .as_ref()
            .is_some_and(|current| heartbeat.observed_at() < current.observed_at())
        {
            return Err(RuntimeAgentError::StaleHeartbeat);
        }
        if self.last_heartbeat.as_ref() == Some(&heartbeat) {
            return Ok(RuntimeAgentReportOutcome::Idempotent);
        }
        self.status = heartbeat.status();
        self.runtime_ids = heartbeat.runtime_ids().to_vec();
        self.last_heartbeat = Some(heartbeat);
        Ok(RuntimeAgentReportOutcome::Recorded)
    }

    pub fn record_progress(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        progress: RuntimeAgentProgress,
        reported_at: SystemTime,
    ) -> Result<RuntimeAgentReportOutcome, RuntimeAgentError> {
        self.record_progress_with_attempt(agent_id, correlation, progress, reported_at, None, None)
    }

    pub fn record_progress_with_attempt(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        progress: RuntimeAgentProgress,
        reported_at: SystemTime,
        command_attempt: Option<&CommandAttempt>,
        dispatch_attempt: Option<&DispatchAttempt>,
    ) -> Result<RuntimeAgentReportOutcome, RuntimeAgentError> {
        self.ensure_agent(agent_id)?;
        let command = self.command_for(correlation)?;
        if command.command_attempt.is_some() || command.dispatch_attempt.is_some() {
            if command_attempt.is_none() && dispatch_attempt.is_none() {
                return Err(RuntimeAgentError::AttemptRequired);
            }
            if command.command_attempt != command_attempt.map(CommandAttempt::sequence)
                || command.dispatch_attempt != dispatch_attempt.map(DispatchAttempt::sequence)
            {
                return Err(RuntimeAgentError::AttemptMismatch);
            }
        }
        if command.result.is_some() {
            return Err(RuntimeAgentError::TerminalCommand);
        }
        if reported_at < command.updated_at {
            return Err(RuntimeAgentError::StaleProgress);
        }
        if command.progress.state() == RuntimeAgentProgressState::Running
            && progress.state() == RuntimeAgentProgressState::Queued
        {
            return Err(RuntimeAgentError::InvalidProgressTransition);
        }
        if reported_at == command.updated_at && command.progress == progress {
            return Ok(RuntimeAgentReportOutcome::Idempotent);
        }
        let command = self
            .commands
            .get_mut(correlation.command_id())
            .expect("command correlation was checked above");
        command.progress = progress;
        command.updated_at = reported_at;
        Ok(RuntimeAgentReportOutcome::Recorded)
    }

    pub fn record_result(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        result: RuntimeAgentResult,
    ) -> Result<RuntimeAgentReportOutcome, RuntimeAgentError> {
        self.record_result_with_attempt(agent_id, correlation, result, None, None)
    }

    pub fn record_result_with_attempt(
        &mut self,
        agent_id: &RuntimeAgentId,
        correlation: &CommandCorrelation,
        result: RuntimeAgentResult,
        command_attempt: Option<&CommandAttempt>,
        dispatch_attempt: Option<&DispatchAttempt>,
    ) -> Result<RuntimeAgentReportOutcome, RuntimeAgentError> {
        self.ensure_agent(agent_id)?;
        let command = self.command_for(correlation)?;
        if command.command_attempt.is_some() || command.dispatch_attempt.is_some() {
            if command_attempt.is_none() && dispatch_attempt.is_none() {
                return Err(RuntimeAgentError::AttemptRequired);
            }
            if command.command_attempt != command_attempt.map(CommandAttempt::sequence)
                || command.dispatch_attempt != dispatch_attempt.map(DispatchAttempt::sequence)
            {
                return Err(RuntimeAgentError::AttemptMismatch);
            }
        }
        if let Some(current) = command.result() {
            return if current == &result {
                Ok(RuntimeAgentReportOutcome::Idempotent)
            } else {
                Err(RuntimeAgentError::ConflictingTerminalResult)
            };
        }
        if result.completed_at() < command.updated_at() {
            return Err(RuntimeAgentError::StaleResult);
        }
        let command = self
            .commands
            .get_mut(correlation.command_id())
            .expect("command correlation was checked above");
        command.updated_at = result.completed_at();
        command.result = Some(result);
        Ok(RuntimeAgentReportOutcome::Recorded)
    }

    fn ensure_agent(&self, agent_id: &RuntimeAgentId) -> Result<(), RuntimeAgentError> {
        if self.id == *agent_id {
            Ok(())
        } else {
            Err(RuntimeAgentError::AgentMismatch)
        }
    }

    fn command_for(
        &self,
        correlation: &CommandCorrelation,
    ) -> Result<&RuntimeAgentCommand, RuntimeAgentError> {
        let command = self
            .commands
            .get(correlation.command_id())
            .ok_or(RuntimeAgentError::UnknownCommand)?;
        if command.correlation.idempotency_key() != correlation.idempotency_key() {
            return Err(RuntimeAgentError::CorrelationMismatch);
        }
        Ok(command)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAgentReportOutcome {
    Recorded,
    Idempotent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAgentInputError {
    Empty(&'static str),
    TooLong(&'static str),
    TooManyRuntimeIds,
    DuplicateRuntimeId,
}

impl fmt::Display for RuntimeAgentInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty(label) => write!(formatter, "{label} must not be empty"),
            Self::TooLong(label) => write!(formatter, "{label} exceeds its maximum length"),
            Self::TooManyRuntimeIds => {
                formatter.write_str("runtime agent heartbeat has too many runtime IDs")
            }
            Self::DuplicateRuntimeId => {
                formatter.write_str("runtime agent heartbeat has duplicate runtime IDs")
            }
        }
    }
}

impl std::error::Error for RuntimeAgentInputError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeAgentError {
    AgentMismatch,
    CommandCapacityReached,
    DuplicateCommandId,
    DuplicateIdempotencyKey,
    UnknownCommand,
    CorrelationMismatch,
    StaleHeartbeat,
    StaleProgress,
    StaleResult,
    InvalidProgressTransition,
    TerminalCommand,
    AttemptRequired,
    AttemptMismatch,
    ConflictingTerminalResult,
}

impl fmt::Display for RuntimeAgentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AgentMismatch => formatter.write_str("runtime agent identity does not match"),
            Self::CommandCapacityReached => {
                formatter.write_str("runtime agent command capacity reached")
            }
            Self::DuplicateCommandId => {
                formatter.write_str("runtime agent command ID is already registered")
            }
            Self::DuplicateIdempotencyKey => {
                formatter.write_str("runtime agent idempotency key is already registered")
            }
            Self::UnknownCommand => formatter.write_str("runtime agent command is not registered"),
            Self::CorrelationMismatch => {
                formatter.write_str("runtime agent command correlation does not match")
            }
            Self::StaleHeartbeat => {
                formatter.write_str("runtime agent heartbeat predates the current heartbeat")
            }
            Self::StaleProgress => {
                formatter.write_str("runtime agent progress predates the current command state")
            }
            Self::StaleResult => {
                formatter.write_str("runtime agent result predates the current command state")
            }
            Self::InvalidProgressTransition => {
                formatter.write_str("runtime agent progress cannot move from running to queued")
            }
            Self::TerminalCommand => {
                formatter.write_str("runtime agent command already has a terminal result")
            }
            Self::AttemptRequired => {
                formatter.write_str("runtime agent command requires command and dispatch attempts")
            }
            Self::AttemptMismatch => {
                formatter.write_str("runtime agent command or dispatch attempt does not match")
            }
            Self::ConflictingTerminalResult => formatter.write_str(
                "runtime agent command terminal result conflicts with the recorded result",
            ),
        }
    }
}

impl std::error::Error for RuntimeAgentError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn agent() -> (RuntimeAgent, RuntimeAgentId) {
        let id = RuntimeAgentId::try_new("agent-1").unwrap();
        (RuntimeAgent::new(id.clone()), id)
    }

    fn correlation() -> CommandCorrelation {
        CommandCorrelation::new(
            CommandId::try_new("command-1").unwrap(),
            IdempotencyKey::try_new("idem-1").unwrap(),
        )
    }

    fn command_attempt() -> CommandAttempt {
        CommandAttempt::try_new(1).unwrap()
    }

    fn dispatch_attempt() -> DispatchAttempt {
        DispatchAttempt::try_new(1).unwrap()
    }

    #[test]
    fn records_heartbeat_and_rejects_stale_or_mismatched_agents() {
        let (mut agent, agent_id) = agent();
        let heartbeat = RuntimeAgentHeartbeat::try_new(
            at(10),
            RuntimeAgentStatus::Running,
            [RuntimeId::try_new("runtime-1").unwrap()],
            Some(OperatorMessage::try_new("available").unwrap()),
        )
        .unwrap();
        assert_eq!(
            agent.record_heartbeat(&agent_id, heartbeat.clone()),
            Ok(RuntimeAgentReportOutcome::Recorded)
        );
        assert_eq!(agent.status(), RuntimeAgentStatus::Running);
        assert_eq!(agent.runtime_ids()[0].as_str(), "runtime-1");
        assert_eq!(
            agent.record_heartbeat(&agent_id, heartbeat),
            Ok(RuntimeAgentReportOutcome::Idempotent)
        );
        let stale =
            RuntimeAgentHeartbeat::try_new(at(9), RuntimeAgentStatus::Stopped, [], None).unwrap();
        assert_eq!(
            agent.record_heartbeat(&agent_id, stale),
            Err(RuntimeAgentError::StaleHeartbeat)
        );
        let other = RuntimeAgentId::try_new("agent-2").unwrap();
        assert_eq!(
            agent.record_heartbeat(
                &other,
                RuntimeAgentHeartbeat::try_new(at(11), RuntimeAgentStatus::Running, [], None)
                    .unwrap(),
            ),
            Err(RuntimeAgentError::AgentMismatch)
        );
    }

    #[test]
    fn records_progress_and_rejects_stale_or_mismatched_correlation() {
        let (mut agent, agent_id) = agent();
        let correlation = correlation();
        agent
            .register_command_with_attempts(
                correlation.clone(),
                at(10),
                command_attempt(),
                dispatch_attempt(),
            )
            .unwrap();
        let progress = RuntimeAgentProgress::new(
            RuntimeAgentProgressState::Running,
            Some(ProgressPhase::try_new("installing").unwrap()),
            Some(OperatorMessage::try_new("installing runtime").unwrap()),
            Some(25),
        );
        assert_eq!(
            agent.record_progress_with_attempt(
                &agent_id,
                &correlation,
                progress.clone(),
                at(11),
                Some(&command_attempt()),
                Some(&dispatch_attempt()),
            ),
            Ok(RuntimeAgentReportOutcome::Recorded)
        );
        assert_eq!(
            agent.command(correlation.command_id()).unwrap().progress(),
            &progress
        );
        assert_eq!(
            agent.record_progress_with_attempt(
                &agent_id,
                &correlation,
                progress,
                at(10),
                Some(&command_attempt()),
                Some(&dispatch_attempt()),
            ),
            Err(RuntimeAgentError::StaleProgress)
        );
        let mismatched = CommandCorrelation::new(
            correlation.command_id().clone(),
            IdempotencyKey::try_new("different-key").unwrap(),
        );
        assert_eq!(
            agent.record_progress(
                &agent_id,
                &mismatched,
                RuntimeAgentProgress::new(RuntimeAgentProgressState::Running, None, None, None),
                at(12),
            ),
            Err(RuntimeAgentError::CorrelationMismatch)
        );
    }

    #[test]
    fn records_all_terminal_result_shapes_and_replays_the_same_result() {
        let (mut agent, agent_id) = agent();
        let correlation = correlation();
        agent
            .register_command_with_attempts(
                correlation.clone(),
                at(10),
                command_attempt(),
                dispatch_attempt(),
            )
            .unwrap();
        let result = RuntimeAgentResult::TimedOut {
            completed_at: at(11),
            timeout: Duration::from_millis(500),
        };
        assert_eq!(
            agent.record_result_with_attempt(
                &agent_id,
                &correlation,
                result.clone(),
                Some(&command_attempt()),
                Some(&dispatch_attempt()),
            ),
            Ok(RuntimeAgentReportOutcome::Recorded)
        );
        assert_eq!(
            agent.record_result_with_attempt(
                &agent_id,
                &correlation,
                result,
                Some(&command_attempt()),
                Some(&dispatch_attempt()),
            ),
            Ok(RuntimeAgentReportOutcome::Idempotent)
        );
        assert!(matches!(
            RuntimeAgentResult::Succeeded {
                completed_at: at(12)
            },
            RuntimeAgentResult::Succeeded { .. }
        ));
        assert!(matches!(
            RuntimeAgentResult::Failed {
                completed_at: at(12),
                message: OperatorMessage::try_new("failed").unwrap(),
            },
            RuntimeAgentResult::Failed { .. }
        ));
        assert!(matches!(
            RuntimeAgentResult::Cancelled {
                completed_at: at(12),
                message: None,
            },
            RuntimeAgentResult::Cancelled { .. }
        ));
    }

    #[test]
    fn rejects_conflicting_or_stale_terminal_results() {
        let (mut agent, agent_id) = agent();
        let correlation = correlation();
        agent
            .register_command_with_attempts(
                correlation.clone(),
                at(10),
                command_attempt(),
                dispatch_attempt(),
            )
            .unwrap();
        assert_eq!(
            agent.record_result_with_attempt(
                &agent_id,
                &correlation,
                RuntimeAgentResult::Succeeded {
                    completed_at: at(11),
                },
                Some(&command_attempt()),
                Some(&dispatch_attempt()),
            ),
            Ok(RuntimeAgentReportOutcome::Recorded)
        );
        assert_eq!(
            agent.record_result_with_attempt(
                &agent_id,
                &correlation,
                RuntimeAgentResult::Failed {
                    completed_at: at(11),
                    message: OperatorMessage::try_new("failed").unwrap(),
                },
                Some(&command_attempt()),
                Some(&dispatch_attempt()),
            ),
            Err(RuntimeAgentError::ConflictingTerminalResult)
        );
        let next = CommandCorrelation::new(
            CommandId::try_new("command-2").unwrap(),
            IdempotencyKey::try_new("idem-2").unwrap(),
        );
        agent.register_command(next.clone(), at(20)).unwrap();
        assert_eq!(
            agent.record_result(
                &agent_id,
                &next,
                RuntimeAgentResult::Cancelled {
                    completed_at: at(19),
                    message: None,
                },
            ),
            Err(RuntimeAgentError::StaleResult)
        );
    }
}
