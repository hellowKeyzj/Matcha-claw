mod construction;
pub(crate) mod lifecycle;
mod session_create;

pub use construction::{ConstructionError, MatchaPeerFactory, MatchaPeerInput};
pub use lifecycle::{
    JoinError, LifecycleError, MatchaPeer, MatchaPeerLifecycleHandle, MatchaPeerSessionHandle,
    RendererApprovalPhase, RendererEvent, RendererEventEnvelope, RendererMessageLifecycle,
    RendererRunPhase, RendererToolPhase, RoleSessionError,
    RoleSessionNativeHandle, RoleSessionOwnership, RoleSessionPromptHandle,
    SessionSubscriptionItem, ShutdownError,
};

#[cfg(test)]
mod tests;
