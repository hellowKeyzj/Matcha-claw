mod construction;
mod errors;
pub(crate) mod lifecycle;
mod renderer;
pub(crate) mod session_create;

pub use construction::{ConstructionError, MatchaPeerFactory, MatchaPeerInput};
pub use errors::{JoinError, LifecycleError, ShutdownError};
pub use lifecycle::{MatchaPeer, MatchaPeerLifecycleHandle, MatchaPeerSessionHandle};
pub use renderer::{
    RendererApprovalPhase, RendererEvent, RendererEventEnvelope, RendererMessageLifecycle,
    RendererRunPhase, RendererToolPhase, SessionSubscriptionItem,
};

#[cfg(test)]
mod tests;
