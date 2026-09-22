use super::*;

impl Reader<'_> {
    pub(super) fn commands(&mut self) -> Result<Vec<CommandRecord>, StoreFault> {
        let count = self.count()?;
        (0..count).map(|_| self.command_record()).collect()
    }

    pub(super) fn command_record(&mut self) -> Result<CommandRecord, StoreFault> {
        let intent = self.command_intent()?;
        let state = self.command_state()?;
        let attempt = self.optional_command_attempt()?;
        let last_failure = self.optional_failure()?;
        let updated_at = self.system_time()?;
        CommandRecord::restore(intent, state, attempt, last_failure, updated_at)
            .map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn command_intent(&mut self) -> Result<CommandIntent, StoreFault> {
        let command_id =
            CommandId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let idempotency_key =
            IdempotencyKey::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)?;
        let target = self.command_target()?;
        let kind = match self.byte()? {
            0 => CommandKind::ProbeNode,
            1 => CommandKind::InstallAgent,
            2 => CommandKind::StartRuntime,
            3 => CommandKind::StopRuntime,
            4 => CommandKind::SyncCapabilities,
            5 => CommandKind::UpgradeAgent,
            6 => CommandKind::MountWorkspace,
            7 => CommandKind::ExposePort,
            _ => return Err(StoreFault::CorruptRecord),
        };
        let queued_at = self.system_time()?;
        Ok(CommandIntent::new(
            command_id,
            idempotency_key,
            target,
            kind,
            queued_at,
        ))
    }

    pub(super) fn command_target(&mut self) -> Result<CommandTarget, StoreFault> {
        match self.byte()? {
            0 => Ok(CommandTarget::Node(self.node_id()?)),
            1 => Ok(CommandTarget::Runtime {
                node_id: self.node_id()?,
                runtime_id: RuntimeId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
            }),
            2 => Ok(CommandTarget::Endpoint {
                node_id: self.node_id()?,
                runtime_id: RuntimeId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
                endpoint_id: EndpointId::try_new(self.string()?)
                    .map_err(|_| StoreFault::CorruptRecord)?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn node_id(&mut self) -> Result<NodeId, StoreFault> {
        NodeId::try_new(self.string()?).map_err(|_| StoreFault::CorruptRecord)
    }

    pub(super) fn command_state(&mut self) -> Result<CommandState, StoreFault> {
        match self.byte()? {
            0 => Ok(CommandState::Queued {
                queued_at: self.system_time()?,
            }),
            1 => Ok(CommandState::Running {
                started_at: self.system_time()?,
            }),
            2 => Ok(CommandState::Succeeded {
                completed_at: self.system_time()?,
            }),
            3 => Ok(CommandState::Failed {
                completed_at: self.system_time()?,
                failure: self.command_failure()?,
            }),
            4 => Ok(CommandState::Cancelled {
                completed_at: self.system_time()?,
                reason: self.optional_cancellation()?,
            }),
            5 => {
                let completed_at = self.system_time()?;
                let seconds = self.u64()?;
                let nanoseconds = self.u32()?;
                if nanoseconds >= 1_000_000_000 {
                    return Err(StoreFault::CorruptRecord);
                }
                Ok(CommandState::TimedOut {
                    completed_at,
                    timeout: std::time::Duration::new(seconds, nanoseconds),
                })
            }
            6 => Ok(CommandState::OutcomeUnknown {
                observed_at: self.system_time()?,
            }),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn optional_command_attempt(
        &mut self,
    ) -> Result<Option<CommandAttempt>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => CommandAttempt::try_new(self.u64()?)
                .map(Some)
                .map_err(|_| StoreFault::CorruptRecord),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn optional_failure(&mut self) -> Result<Option<CommandFailure>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.command_failure().map(Some),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn command_failure(&mut self) -> Result<CommandFailure, StoreFault> {
        match self.byte()? {
            0 => Ok(CommandFailure::Rejected),
            1 => Ok(CommandFailure::Unavailable),
            2 => Ok(CommandFailure::ExecutionFailed),
            _ => Err(StoreFault::CorruptRecord),
        }
    }

    pub(super) fn optional_cancellation(
        &mut self,
    ) -> Result<Option<CommandCancellation>, StoreFault> {
        match self.byte()? {
            0 => Ok(None),
            1 => match self.byte()? {
                0 => Ok(Some(CommandCancellation::Requested)),
                1 => Ok(Some(CommandCancellation::Superseded)),
                _ => Err(StoreFault::CorruptRecord),
            },
            _ => Err(StoreFault::CorruptRecord),
        }
    }
}
