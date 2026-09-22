use crate::{GraphRunFacts, GraphRunId, RoleSessionReceipt};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphRunLifecycle {
    creation_idempotency_key: String,
    state: GraphRunLifecycleState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphRunLifecycleState {
    Active,
    Cancelling {
        idempotency_key: String,
        requested_at: u64,
    },
    Cancelled {
        idempotency_key: String,
        cancelled_at: u64,
    },
    OutcomeUnknown {
        idempotency_key: String,
        observed_at: u64,
    },
    Tombstoned {
        idempotency_key: String,
        tombstoned_at: u64,
    },
}

impl GraphRunLifecycleState {
    pub const fn is_durable_active(&self) -> bool {
        matches!(self, Self::Active | Self::Cancelling { .. })
    }

    pub const fn requires_native_readback(&self) -> bool {
        matches!(self, Self::Cancelling { .. } | Self::OutcomeUnknown { .. })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancellationPlan {
    run: GraphRunId,
    bindings: Vec<RoleSessionReceipt>,
}

impl CancellationPlan {
    pub(crate) fn new(run: GraphRunId, bindings: Vec<RoleSessionReceipt>) -> Self {
        Self { run, bindings }
    }

    pub fn run(&self) -> &GraphRunId {
        &self.run
    }

    pub fn bindings(&self) -> &[RoleSessionReceipt] {
        &self.bindings
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginCancellationOutcome {
    Started(CancellationPlan),
    Replayed(CancellationPlan),
    AlreadyCancelled,
    OutcomeUnknown,
    Tombstoned,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleAbortOutcome {
    Confirmed,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettleCancellationOutcome {
    Cancelled,
    Replayed,
    OutcomeUnknown,
    Tombstoned,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TombstoneOutcome {
    Tombstoned,
    Replayed,
    CancellationRequired(CancellationPlan),
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResumeOutcome {
    Active(GraphRunId),
    Cancelled(GraphRunId),
    OutcomeUnknown(GraphRunId),
    Tombstoned(GraphRunId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreateGraphRunOutcome {
    Created(GraphRunId),
    Replayed(GraphRunId),
    ConflictingIdempotency,
    ExistingRun,
}

impl GraphRunLifecycle {
    pub(crate) fn active() -> Self {
        Self {
            creation_idempotency_key: String::new(),
            state: GraphRunLifecycleState::Active,
        }
    }

    pub(crate) fn created(creation_idempotency_key: String) -> Self {
        Self {
            creation_idempotency_key,
            state: GraphRunLifecycleState::Active,
        }
    }

    pub(crate) fn restore(
        creation_idempotency_key: String,
        state: GraphRunLifecycleState,
    ) -> Result<Self, ()> {
        if !valid_state_key(&state) {
            return Err(());
        }
        Ok(Self {
            creation_idempotency_key,
            state,
        })
    }

    pub fn state(&self) -> &GraphRunLifecycleState {
        &self.state
    }

    pub(crate) fn creation_idempotency_key(&self) -> &str {
        &self.creation_idempotency_key
    }

    pub(crate) fn matches_creation(&self, key: &str) -> bool {
        !self.creation_idempotency_key.is_empty() && self.creation_idempotency_key == key
    }

    pub(crate) fn can_transition_from(&self, previous: &Self) -> bool {
        if self.creation_idempotency_key != previous.creation_idempotency_key {
            return false;
        }
        match (previous.state(), self.state()) {
            (GraphRunLifecycleState::Active, GraphRunLifecycleState::Active) => true,
            (GraphRunLifecycleState::Active, GraphRunLifecycleState::Cancelling { .. })
            | (
                GraphRunLifecycleState::Cancelling { .. },
                GraphRunLifecycleState::Cancelled { .. },
            )
            | (
                GraphRunLifecycleState::Cancelling { .. },
                GraphRunLifecycleState::OutcomeUnknown { .. },
            )
            | (
                GraphRunLifecycleState::Cancelled { .. },
                GraphRunLifecycleState::Tombstoned { .. },
            ) => true,
            (
                GraphRunLifecycleState::OutcomeUnknown {
                    idempotency_key: previous_key,
                    ..
                },
                GraphRunLifecycleState::Cancelled {
                    idempotency_key: current_key,
                    ..
                },
            )
            | (
                GraphRunLifecycleState::OutcomeUnknown {
                    idempotency_key: previous_key,
                    ..
                },
                GraphRunLifecycleState::OutcomeUnknown {
                    idempotency_key: current_key,
                    ..
                },
            ) if previous_key == current_key => true,
            _ => self.state == previous.state,
        }
    }

    pub(crate) fn recover_interrupted_cancellation(&mut self, observed_at: u64) -> bool {
        let GraphRunLifecycleState::Cancelling {
            idempotency_key, ..
        } = &self.state
        else {
            return false;
        };
        self.state = GraphRunLifecycleState::OutcomeUnknown {
            idempotency_key: idempotency_key.clone(),
            observed_at,
        };
        true
    }

    pub(crate) fn begin_cancellation(
        &mut self,
        run: &GraphRunFacts,
        idempotency_key: &str,
        requested_at: u64,
    ) -> BeginCancellationOutcome {
        match &self.state {
            GraphRunLifecycleState::Active => {
                self.state = GraphRunLifecycleState::Cancelling {
                    idempotency_key: idempotency_key.to_owned(),
                    requested_at,
                };
                BeginCancellationOutcome::Started(cancellation_plan(run))
            }
            GraphRunLifecycleState::Cancelling {
                idempotency_key: existing,
                ..
            } if existing == idempotency_key => {
                BeginCancellationOutcome::Replayed(cancellation_plan(run))
            }
            GraphRunLifecycleState::Cancelling { .. }
            | GraphRunLifecycleState::OutcomeUnknown { .. } => {
                BeginCancellationOutcome::OutcomeUnknown
            }
            GraphRunLifecycleState::Cancelled { .. } => BeginCancellationOutcome::AlreadyCancelled,
            GraphRunLifecycleState::Tombstoned { .. } => BeginCancellationOutcome::Tombstoned,
        }
    }

    pub(crate) fn settle_cancellation(
        &mut self,
        idempotency_key: &str,
        outcome: RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<SettleCancellationOutcome, ()> {
        match &self.state {
            GraphRunLifecycleState::Cancelling {
                idempotency_key: existing,
                ..
            } if existing == idempotency_key => {
                self.state = match outcome {
                    RoleAbortOutcome::Confirmed => GraphRunLifecycleState::Cancelled {
                        idempotency_key: idempotency_key.to_owned(),
                        cancelled_at: observed_at,
                    },
                    RoleAbortOutcome::OutcomeUnknown => GraphRunLifecycleState::OutcomeUnknown {
                        idempotency_key: idempotency_key.to_owned(),
                        observed_at,
                    },
                };
                Ok(match outcome {
                    RoleAbortOutcome::Confirmed => SettleCancellationOutcome::Cancelled,
                    RoleAbortOutcome::OutcomeUnknown => SettleCancellationOutcome::OutcomeUnknown,
                })
            }
            GraphRunLifecycleState::Cancelled {
                idempotency_key: existing,
                ..
            } if existing == idempotency_key && outcome == RoleAbortOutcome::Confirmed => {
                Ok(SettleCancellationOutcome::Replayed)
            }
            GraphRunLifecycleState::OutcomeUnknown {
                idempotency_key: existing,
                ..
            } if existing == idempotency_key && outcome == RoleAbortOutcome::Confirmed => {
                self.state = GraphRunLifecycleState::Cancelled {
                    idempotency_key: idempotency_key.to_owned(),
                    cancelled_at: observed_at,
                };
                Ok(SettleCancellationOutcome::Cancelled)
            }
            GraphRunLifecycleState::OutcomeUnknown { .. } => {
                Ok(SettleCancellationOutcome::OutcomeUnknown)
            }
            GraphRunLifecycleState::Tombstoned { .. } => Ok(SettleCancellationOutcome::Tombstoned),
            _ => Err(()),
        }
    }

    pub(crate) fn tombstone(
        &mut self,
        run: &GraphRunFacts,
        idempotency_key: &str,
        tombstoned_at: u64,
    ) -> TombstoneOutcome {
        match &self.state {
            GraphRunLifecycleState::Cancelled { .. } => {
                self.state = GraphRunLifecycleState::Tombstoned {
                    idempotency_key: idempotency_key.to_owned(),
                    tombstoned_at,
                };
                TombstoneOutcome::Tombstoned
            }
            GraphRunLifecycleState::Tombstoned {
                idempotency_key: existing,
                ..
            } if existing == idempotency_key => TombstoneOutcome::Replayed,
            GraphRunLifecycleState::Tombstoned { .. }
            | GraphRunLifecycleState::OutcomeUnknown { .. } => TombstoneOutcome::OutcomeUnknown,
            GraphRunLifecycleState::Active | GraphRunLifecycleState::Cancelling { .. } => {
                TombstoneOutcome::CancellationRequired(cancellation_plan(run))
            }
        }
    }
}

fn cancellation_plan(run: &GraphRunFacts) -> CancellationPlan {
    CancellationPlan::new(
        run.run_id().clone(),
        run.runtime()
            .map(|receipt| receipt.bindings().to_vec())
            .unwrap_or_default(),
    )
}

fn valid_state_key(state: &GraphRunLifecycleState) -> bool {
    match state {
        GraphRunLifecycleState::Active => true,
        GraphRunLifecycleState::Cancelling {
            idempotency_key, ..
        }
        | GraphRunLifecycleState::Cancelled {
            idempotency_key, ..
        }
        | GraphRunLifecycleState::OutcomeUnknown {
            idempotency_key, ..
        }
        | GraphRunLifecycleState::Tombstoned {
            idempotency_key, ..
        } => !idempotency_key.trim().is_empty(),
    }
}
