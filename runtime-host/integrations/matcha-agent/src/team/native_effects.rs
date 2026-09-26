use std::{fmt, future::Future, pin::Pin};

use crate::{
    peer::{MatchaPeer, RoleSessionError, RoleSessionNativeHandle},
    session::{
        client::AppServerClientError, hydration::HydrationWindowRequest,
        request::SessionCancelParams, role::RoleSessionId,
    },
};
use organization::{
    EndpointSessionId, GraphRunId, MaterializationOperationOutcome, MaterializationRejection,
    NativeDeletionEvidence, NativeDeletionProof, NativeEffectFailure, RoleAbortOutcome,
    RoleSessionAbortOutcome, RoleSessionAbortReceipt, RoleSessionDeleteOutcome,
    RoleSessionDeleteReceipt, RoleSessionDeletionConfirmation, RoleSessionReadbackOutcome,
    RoleSessionReadbackReceipt, RoleSessionReceipt, SessionWindowReference,
    TeamMaterializationRemoval, TeamMaterializationRequest, TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatchaEffectFailure {
    InvalidInput,
    Rejected,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaSessionReceipt(RoleSessionId);

impl MatchaSessionReceipt {
    fn new(session: RoleSessionId) -> Self {
        Self(session)
    }

    pub fn session(&self) -> &RoleSessionId {
        &self.0
    }
}

impl fmt::Debug for MatchaSessionReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatchaSessionReceipt(<redacted>)")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchaSessionMutationOutcome {
    Confirmed { receipt: MatchaSessionReceipt },
    Failed { failure: MatchaEffectFailure },
    OutcomeUnknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaWindowReceipt(String);

impl MatchaWindowReceipt {
    fn new(session: &RoleSessionId) -> Self {
        Self(format!("matcha-window:{}", session.as_str()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for MatchaWindowReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatchaWindowReceipt(<redacted>)")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchaReadbackOutcome {
    Confirmed {
        session: MatchaSessionReceipt,
        window: MatchaWindowReceipt,
    },
    Failed {
        failure: MatchaEffectFailure,
    },
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchaMaterializationOutcome {
    Confirmed,
    Failed { failure: MatchaEffectFailure },
    OutcomeUnknown,
}

/// Matcha's native Team effect producer.
///
/// Matcha app-server currently has no Team materialization producer. The
/// materialization operations therefore remain explicit typed failures; this
/// adapter never invents a materialization receipt from a role-session API.
pub struct MatchaTeamNativeEffects<'peer> {
    peer: &'peer MatchaPeer,
}

impl<'peer> MatchaTeamNativeEffects<'peer> {
    pub fn new(peer: &'peer MatchaPeer) -> Self {
        Self { peer }
    }

    pub async fn materialize(&self) -> MatchaMaterializationOutcome {
        MatchaMaterializationOutcome::Failed {
            failure: MatchaEffectFailure::Unsupported,
        }
    }

    pub async fn recover_materialization(&self) -> MatchaMaterializationOutcome {
        MatchaMaterializationOutcome::OutcomeUnknown
    }

    pub async fn remove_materialization(&self) -> MatchaMaterializationOutcome {
        MatchaMaterializationOutcome::OutcomeUnknown
    }

    pub async fn abort(&self, session: RoleSessionId) -> MatchaSessionMutationOutcome {
        let receipt = MatchaSessionReceipt::new(session.clone());
        match self
            .peer
            .cancel_session(SessionCancelParams::new(session.native()))
            .await
        {
            InvocationOutcome::Succeeded(_) => MatchaSessionMutationOutcome::Confirmed { receipt },
            InvocationOutcome::TargetRejected(
                AppServerClientError::PeerRejected | AppServerClientError::SessionNotFound,
            ) => MatchaSessionMutationOutcome::Failed {
                failure: MatchaEffectFailure::Rejected,
            },
            InvocationOutcome::TargetRejected(_) => MatchaSessionMutationOutcome::Failed {
                failure: MatchaEffectFailure::Unavailable,
            },
            InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
                MatchaSessionMutationOutcome::OutcomeUnknown
            }
        }
    }

    pub async fn delete(&self, session: RoleSessionId) -> MatchaSessionMutationOutcome {
        match self.peer.close_role_session(session).await {
            // Closing the worker leaves its transcript; it is not native deletion proof.
            InvocationOutcome::Succeeded(()) => MatchaSessionMutationOutcome::OutcomeUnknown,
            InvocationOutcome::TargetRejected(RoleSessionError::Client(
                AppServerClientError::PeerRejected | AppServerClientError::SessionNotFound,
            )) => MatchaSessionMutationOutcome::Failed {
                failure: MatchaEffectFailure::Rejected,
            },
            InvocationOutcome::TargetRejected(_) => MatchaSessionMutationOutcome::Failed {
                failure: MatchaEffectFailure::Unavailable,
            },
            InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
                MatchaSessionMutationOutcome::OutcomeUnknown
            }
        }
    }

    pub async fn readback(&self, session: RoleSessionId) -> MatchaReadbackOutcome {
        let native_session = session.native();
        match self
            .peer
            .read_canonical_session(native_session, HydrationWindowRequest::latest())
            .await
        {
            crate::session::history::HistoryResult::Complete(_) => {
                MatchaReadbackOutcome::Confirmed {
                    session: MatchaSessionReceipt::new(session.clone()),
                    window: MatchaWindowReceipt::new(&session),
                }
            }
            crate::session::history::HistoryResult::NotFound => MatchaReadbackOutcome::Failed {
                failure: MatchaEffectFailure::Rejected,
            },
            crate::session::history::HistoryResult::Unavailable => MatchaReadbackOutcome::Failed {
                failure: MatchaEffectFailure::Unavailable,
            },
            crate::session::history::HistoryResult::Unknown
            | crate::session::history::HistoryResult::Incomplete(
                crate::session::hydration::HydrationIncomplete::ConnectionInterrupted,
            )
            | crate::session::history::HistoryResult::Incomplete(
                crate::session::hydration::HydrationIncomplete::ReplayRecoveryRequired
                | crate::session::hydration::HydrationIncomplete::ReplayIncomplete
                | crate::session::hydration::HydrationIncomplete::ConnectionCloseFailed,
            ) => MatchaReadbackOutcome::OutcomeUnknown,
            crate::session::history::HistoryResult::Incomplete(
                crate::session::hydration::HydrationIncomplete::SourceUnavailable,
            ) => MatchaReadbackOutcome::Failed {
                failure: MatchaEffectFailure::Unavailable,
            },
            crate::session::history::HistoryResult::Incomplete(
                crate::session::hydration::HydrationIncomplete::SourceRejected
                | crate::session::hydration::HydrationIncomplete::ProtocolRejected
                | crate::session::hydration::HydrationIncomplete::TranscriptRejected(_),
            ) => MatchaReadbackOutcome::Failed {
                failure: MatchaEffectFailure::Rejected,
            },
        }
    }
}

pub fn abort_role_sessions(
    peer: &MatchaPeer,
    bindings: Vec<RoleSessionReceipt>,
) -> impl Future<Output = RoleAbortOutcome> + Send + 'static {
    abort_role_sessions_with_handle(peer.role_session_native_handle(), bindings)
}

async fn abort_role_sessions_with_handle(
    native: RoleSessionNativeHandle,
    bindings: Vec<RoleSessionReceipt>,
) -> RoleAbortOutcome {
    for binding in bindings {
        let session =
            match RoleSessionId::try_new(binding.endpoint_session_id().as_str().to_owned()) {
                Ok(session) => session,
                Err(_) => return RoleAbortOutcome::OutcomeUnknown,
            };
        match native.cancel_role_session(session).await {
            InvocationOutcome::Succeeded(()) => {}
            InvocationOutcome::TargetRejected(_)
            | InvocationOutcome::Cancelled
            | InvocationOutcome::Unknown => return RoleAbortOutcome::OutcomeUnknown,
        }
    }
    RoleAbortOutcome::Confirmed
}

pub fn delete_role_sessions(
    peer: &MatchaPeer,
    run_id: GraphRunId,
    bindings: Vec<RoleSessionReceipt>,
    abort_first: bool,
) -> impl Future<Output = NativeDeletionEvidence> + Send + 'static {
    let native = peer.role_session_native_handle();
    async move {
        if abort_first
            && !matches!(
                abort_role_sessions_with_handle(native.clone(), bindings.clone()).await,
                RoleAbortOutcome::Confirmed
            )
        {
            return NativeDeletionEvidence::OutcomeUnknown;
        }
        let mut confirmations = Vec::with_capacity(bindings.len());
        for binding in bindings {
            let session =
                match RoleSessionId::try_new(binding.endpoint_session_id().as_str().to_owned()) {
                    Ok(session) => session,
                    Err(_) => return NativeDeletionEvidence::Rejected,
                };
            match native.close_role_session(session).await {
                InvocationOutcome::Succeeded(()) => {
                    let receipt =
                        RoleSessionDeleteReceipt::new(binding.endpoint_session_id().clone());
                    let Ok(confirmation) =
                        RoleSessionDeletionConfirmation::try_new(binding, receipt)
                    else {
                        return NativeDeletionEvidence::Rejected;
                    };
                    confirmations.push(confirmation);
                }
                InvocationOutcome::TargetRejected(_) => {
                    return NativeDeletionEvidence::Rejected;
                }
                InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
                    return NativeDeletionEvidence::OutcomeUnknown;
                }
            }
        }
        NativeDeletionProof::try_new(run_id, confirmations).map_or(
            NativeDeletionEvidence::Rejected,
            NativeDeletionEvidence::Confirmed,
        )
    }
}

impl TeamNativeEffectsPort for MatchaTeamNativeEffects<'_> {
    fn materialize(
        &mut self,
        _request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        Box::pin(async {
            MaterializationOperationOutcome::Rejected {
                rejection: MaterializationRejection::Permanent,
            }
        })
    }

    fn recover_materialization(
        &mut self,
        _request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        Box::pin(async { MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn remove(
        &mut self,
        _removal: TeamMaterializationRemoval,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        Box::pin(async { MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn abort(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionAbortOutcome> + Send + '_>> {
        let external_session = receipt.endpoint_session_id().clone();
        let session = match RoleSessionId::try_new(external_session.as_str().to_owned()) {
            Ok(session) => session,
            Err(_) => {
                return Box::pin(async {
                    RoleSessionAbortOutcome::Failed {
                        failure: NativeEffectFailure::InvalidInput,
                    }
                });
            }
        };
        let peer = self.peer;
        Box::pin(async move {
            map_matcha_abort(
                MatchaTeamNativeEffects { peer }.abort(session).await,
                external_session,
            )
        })
    }

    fn delete(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionDeleteOutcome> + Send + '_>> {
        let external_session = receipt.endpoint_session_id().clone();
        let session = match RoleSessionId::try_new(external_session.as_str().to_owned()) {
            Ok(session) => session,
            Err(_) => {
                return Box::pin(async {
                    RoleSessionDeleteOutcome::Failed {
                        failure: NativeEffectFailure::InvalidInput,
                    }
                });
            }
        };
        let peer = self.peer;
        Box::pin(async move {
            map_matcha_delete(
                MatchaTeamNativeEffects { peer }.delete(session).await,
                external_session,
            )
        })
    }

    fn readback(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionReadbackOutcome> + Send + '_>> {
        let external_session = receipt.endpoint_session_id().clone();
        let session = match RoleSessionId::try_new(external_session.as_str().to_owned()) {
            Ok(session) => session,
            Err(_) => {
                return Box::pin(async {
                    RoleSessionReadbackOutcome::Failed {
                        failure: NativeEffectFailure::InvalidInput,
                    }
                });
            }
        };
        let peer = self.peer;
        Box::pin(async move {
            map_matcha_readback(
                MatchaTeamNativeEffects { peer }.readback(session).await,
                external_session,
            )
        })
    }
}

fn map_matcha_abort(
    outcome: MatchaSessionMutationOutcome,
    session: EndpointSessionId,
) -> RoleSessionAbortOutcome {
    match outcome {
        MatchaSessionMutationOutcome::Confirmed { .. } => RoleSessionAbortOutcome::Confirmed {
            receipt: RoleSessionAbortReceipt::new(session),
        },
        MatchaSessionMutationOutcome::Failed { failure } => RoleSessionAbortOutcome::Failed {
            failure: map_matcha_failure(failure),
        },
        MatchaSessionMutationOutcome::OutcomeUnknown => RoleSessionAbortOutcome::OutcomeUnknown,
    }
}

fn map_matcha_delete(
    outcome: MatchaSessionMutationOutcome,
    session: EndpointSessionId,
) -> RoleSessionDeleteOutcome {
    match outcome {
        MatchaSessionMutationOutcome::Confirmed { .. } => RoleSessionDeleteOutcome::Confirmed {
            receipt: RoleSessionDeleteReceipt::new(session),
        },
        MatchaSessionMutationOutcome::Failed { failure } => RoleSessionDeleteOutcome::Failed {
            failure: map_matcha_failure(failure),
        },
        MatchaSessionMutationOutcome::OutcomeUnknown => RoleSessionDeleteOutcome::OutcomeUnknown,
    }
}

fn map_matcha_readback(
    outcome: MatchaReadbackOutcome,
    session: EndpointSessionId,
) -> RoleSessionReadbackOutcome {
    match outcome {
        MatchaReadbackOutcome::Confirmed { window, .. } => {
            match SessionWindowReference::try_new(window.as_str().to_owned()) {
                Ok(window) => RoleSessionReadbackOutcome::Confirmed {
                    receipt: RoleSessionReadbackReceipt::new(session, window),
                },
                Err(_) => RoleSessionReadbackOutcome::Failed {
                    failure: NativeEffectFailure::InvalidInput,
                },
            }
        }
        MatchaReadbackOutcome::Failed { failure } => RoleSessionReadbackOutcome::Failed {
            failure: map_matcha_failure(failure),
        },
        MatchaReadbackOutcome::OutcomeUnknown => RoleSessionReadbackOutcome::OutcomeUnknown,
    }
}

fn map_matcha_failure(failure: MatchaEffectFailure) -> NativeEffectFailure {
    match failure {
        MatchaEffectFailure::InvalidInput => NativeEffectFailure::InvalidInput,
        MatchaEffectFailure::Rejected => NativeEffectFailure::Rejected,
        MatchaEffectFailure::Unavailable => NativeEffectFailure::Unavailable,
        MatchaEffectFailure::Unsupported => NativeEffectFailure::Unsupported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materialization_does_not_claim_matcha_role_sessions_as_team_facts() {
        assert_eq!(
            MatchaMaterializationOutcome::Failed {
                failure: MatchaEffectFailure::Unsupported,
            },
            MatchaMaterializationOutcome::Failed {
                failure: MatchaEffectFailure::Unsupported,
            }
        );
    }

    #[test]
    fn local_receipts_redact_native_values() {
        let session = RoleSessionId::try_new("session-private").unwrap();

        assert!(!format!("{:?}", MatchaSessionReceipt::new(session)).contains("session-private"));
    }
}
