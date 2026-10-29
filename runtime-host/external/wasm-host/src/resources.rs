use std::time::Duration;

use foundation::execution::OwnedTask;
use tokio::{sync::Mutex, task::JoinError};

use crate::{Engine, EngineLimits, ExecutionError, FailureKind, Stage};

/// One owner's shared engine and epoch clock; construction starts no work.
pub struct EngineResources {
    limits: EngineLimits,
    epoch_interval: Duration,
    state: Mutex<EngineState>,
}

enum EngineState {
    Dormant,
    Ready { engine: Engine, clock: OwnedTask<()> },
    Failed(ExecutionError),
    Closing { clock: OwnedTask<()> },
    Closed,
}

impl EngineResources {
    pub fn new(limits: EngineLimits, epoch_interval: Duration) -> Self {
        Self {
            limits,
            epoch_interval,
            state: Mutex::new(EngineState::Dormant),
        }
    }

    /// Call only from the owner's blocking preparation path. Both successful and
    /// failed initialization are shared; concurrent preparation never starts twice.
    pub fn prepare_engine(&self) -> Result<Engine, ExecutionError> {
        let mut state = self.state.blocking_lock();
        if matches!(*state, EngineState::Dormant) {
            *state = match Engine::try_new(self.limits).and_then(|engine| {
                let (clock, _) = engine.spawn_epoch_clock(self.epoch_interval)?;
                Ok(EngineState::Ready { engine, clock })
            }) {
                Ok(ready) => ready,
                Err(error) => EngineState::Failed(error),
            };
        }
        match &*state {
            EngineState::Ready { engine, .. } => Ok(engine.clone()),
            EngineState::Failed(error) => Err(error.clone()),
            EngineState::Dormant | EngineState::Closing { .. } | EngineState::Closed => {
                Err(ExecutionError::new(Stage::Engine, FailureKind::Cancelled))
            }
        }
    }

    /// Close after the owner's guest work drains. A cancelled shutdown future
    /// leaves the owned join in Closing so the next shutdown can finish it.
    pub async fn shutdown(&self) -> Result<(), JoinError> {
        let mut state = self.state.lock().await;
        *state = match std::mem::replace(&mut *state, EngineState::Closed) {
            EngineState::Ready { clock, .. } => EngineState::Closing { clock },
            state => state,
        };
        let joined = match &mut *state {
            EngineState::Closing { clock } => clock.cancel_and_join().await,
            _ => Ok(()),
        };
        *state = EngineState::Closed;
        joined
    }
}
