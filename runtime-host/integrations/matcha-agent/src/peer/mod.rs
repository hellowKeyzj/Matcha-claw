mod construction;
mod lifecycle;
mod session_create;

pub use construction::{ConstructionError, MatchaPeerFactory, MatchaPeerInput};
pub use lifecycle::{
    JoinError, LifecycleError, MatchaPeer, MatchaPeerLifecycleHandle, MatchaPeerSessionHandle,
    RendererApprovalPhase, RendererEvent, RendererEventEnvelope, RendererMessageLifecycle,
    RendererRunPhase, RendererSubscriptionError, RendererToolPhase, RoleSessionError,
    RoleSessionNativeHandle, RoleSessionOwnership, RoleSessionPromptHandle, RoleTerminalWatch,
    SessionSubscriptionItem, ShutdownError, TerminalReceiptReadError,
};

#[cfg(test)]
mod tests;
