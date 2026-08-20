use std::{fmt, num::NonZeroU64};

use tokio_util::sync::CancellationToken;

/// An opaque identifier for one ready supervised child generation.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SupervisorGeneration(NonZeroU64);

impl SupervisorGeneration {
    pub(crate) const fn new(value: NonZeroU64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// An observer for the current ready supervised child generation.
///
/// The supervisor invalidates this lease before it stops or replaces that
/// generation, and before supervisor shutdown begins. The lease does not prove
/// process, transport, or application liveness.
#[derive(Clone)]
pub struct SupervisorLease {
    generation: SupervisorGeneration,
    cancellation: CancellationToken,
}

impl SupervisorLease {
    pub(crate) const fn new(
        generation: SupervisorGeneration,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            generation,
            cancellation,
        }
    }

    pub const fn generation(&self) -> SupervisorGeneration {
        self.generation
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    pub(crate) fn cancel(&self) {
        self.cancellation.cancel();
    }

    #[cfg(feature = "test-support")]
    pub fn test_lease(cancellation: CancellationToken) -> Self {
        Self::new(
            SupervisorGeneration::new(
                NonZeroU64::new(1).expect("fixed test supervisor generation must be non-zero"),
            ),
            cancellation,
        )
    }
}

impl fmt::Debug for SupervisorLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorLease")
            .field("generation", &self.generation)
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}
