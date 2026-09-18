use std::{fmt, future::Future, pin::Pin};

use organization::{
    DeliveryReceiptReference, DeliveryRejection, EndpointSessionId, GraphRunId,
    MaterializationOperationOutcome, MaterializationRejection, NativeDeletionEvidence,
    NativeDeletionProof, NativeEffectFailure, PromptDeliveryOutcome as DomainDeliveryOutcome,
    PromptDeliveryRequest, RoleAbortOutcome, RoleSessionAbortOutcome, RoleSessionAbortReceipt,
    RoleSessionDeleteOutcome, RoleSessionDeleteReceipt, RoleSessionDeletionConfirmation,
    RoleSessionReadbackOutcome, RoleSessionReadbackReceipt, RoleSessionReceipt,
    SessionWindowReference, TeamMaterializationRemoval, TeamMaterializationRequest,
    TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use crate::{
    peer::{MatchaPeer, RoleSessionError, RoleSessionNativeHandle, RoleSessionPromptHandle},
    session::{
        client::AppServerClientError,
        hydration::HydrationWindowRequest,
        receipt::NativeRunSettled,
        request::SessionCancelParams,
        role::{RolePrompt, RoleRunId, RoleSessionId},
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatchaEffectFailure {
    InvalidInput,
    Rejected,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaDeliveryReceipt(RoleRunId);

impl MatchaDeliveryReceipt {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for MatchaDeliveryReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatchaDeliveryReceipt(<redacted>)")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct MatchaDeliveryRequest {
    delivery_id: RoleRunId,
    session: RoleSessionId,
    prompt: RolePrompt,
}

impl MatchaDeliveryRequest {
    pub fn try_new(
        delivery_id: impl Into<String>,
        session: RoleSessionId,
        prompt: RolePrompt,
    ) -> Result<Self, MatchaEffectFailure> {
        let delivery_id = RoleRunId::try_new(delivery_id.into())
            .map_err(|_| MatchaEffectFailure::InvalidInput)?;
        Ok(Self {
            delivery_id,
            session,
            prompt,
        })
    }

    pub fn delivery_id(&self) -> &str {
        self.delivery_id.as_str()
    }
}

impl fmt::Debug for MatchaDeliveryRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MatchaDeliveryRequest")
            .field("has_delivery_id", &true)
            .field("session", &self.session)
            .field("prompt", &self.prompt)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchaDeliveryOutcome {
    Delivered { receipt: MatchaDeliveryReceipt },
    Rejected { failure: MatchaEffectFailure },
    OutcomeUnknown,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchaTerminalWatchOutcome {
    Settled { settled: NativeRunSettled },
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

    pub async fn deliver(&self, request: MatchaDeliveryRequest) -> MatchaDeliveryOutcome {
        let prompt = self.peer.role_session_prompt_handle();
        deliver_matcha_prompt(&prompt, request).await
    }

    pub async fn watch_terminal_settled(
        &self,
        session: RoleSessionId,
        native_run_id: RoleRunId,
    ) -> MatchaTerminalWatchOutcome {
        let native = self.peer.role_session_native_handle();
        watch_terminal_settled_with_handle(native, session, native_run_id).await
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
        let receipt = MatchaSessionReceipt::new(session.clone());
        match self.peer.close_role_session(session).await {
            InvocationOutcome::Succeeded(()) => MatchaSessionMutationOutcome::Confirmed { receipt },
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

pub fn deliver_prompt(
    peer: &MatchaPeer,
    request: PromptDeliveryRequest,
) -> impl Future<Output = DomainDeliveryOutcome> + Send + 'static {
    let prompt = peer.role_session_prompt_handle();
    async move { deliver_prompt_with_handle(prompt, request).await }
}

pub async fn deliver_prompt_with_handle(
    prompt: RoleSessionPromptHandle,
    request: PromptDeliveryRequest,
) -> DomainDeliveryOutcome {
    let session =
        match RoleSessionId::try_new(request.binding().endpoint_session_id().as_str().to_owned()) {
            Ok(session) => session,
            Err(_) => {
                return DomainDeliveryOutcome::Rejected {
                    rejection: DeliveryRejection::Permanent,
                };
            }
        };
    let prompt_payload = match RolePrompt::try_new(request.payload().as_str().to_owned()) {
        Ok(prompt) => prompt,
        Err(_) => {
            return DomainDeliveryOutcome::Rejected {
                rejection: DeliveryRejection::Permanent,
            };
        }
    };
    let delivery = match MatchaDeliveryRequest::try_new(
        request.idempotency_key().as_str().to_owned(),
        session,
        prompt_payload,
    ) {
        Ok(delivery) => delivery,
        Err(_) => {
            return DomainDeliveryOutcome::Rejected {
                rejection: DeliveryRejection::Permanent,
            };
        }
    };
    map_matcha_delivery(deliver_matcha_prompt(&prompt, delivery).await)
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

async fn watch_terminal_settled_with_handle(
    native: RoleSessionNativeHandle,
    session: RoleSessionId,
    native_run_id: RoleRunId,
) -> MatchaTerminalWatchOutcome {
    match native
        .watch_role_terminal_settled(session, native_run_id.clone())
        .await
    {
        Some(settled) if settled.native_run_id().as_str() == native_run_id.as_str() => {
            MatchaTerminalWatchOutcome::Settled { settled }
        }
        Some(_) => MatchaTerminalWatchOutcome::Failed {
            failure: MatchaEffectFailure::Rejected,
        },
        None => MatchaTerminalWatchOutcome::OutcomeUnknown,
    }
}

async fn deliver_matcha_prompt(
    prompt: &RoleSessionPromptHandle,
    request: MatchaDeliveryRequest,
) -> MatchaDeliveryOutcome {
    let requested_run_id = request.delivery_id.clone();
    match prompt
        .prompt_role_session_with_run_id(
            &request.session,
            request.prompt,
            Some(request.delivery_id),
        )
        .await
    {
        InvocationOutcome::Succeeded(run_id) if run_id == requested_run_id => {
            MatchaDeliveryOutcome::Delivered {
                receipt: MatchaDeliveryReceipt(run_id),
            }
        }
        InvocationOutcome::Succeeded(_) => MatchaDeliveryOutcome::Rejected {
            failure: MatchaEffectFailure::Rejected,
        },
        InvocationOutcome::TargetRejected(error) => MatchaDeliveryOutcome::Rejected {
            failure: map_role_error(error),
        },
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            MatchaDeliveryOutcome::OutcomeUnknown
        }
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

    fn deliver(
        &mut self,
        request: PromptDeliveryRequest,
    ) -> Pin<Box<dyn Future<Output = DomainDeliveryOutcome> + Send + '_>> {
        let prompt = self.peer.role_session_prompt_handle();
        Box::pin(async move { deliver_prompt_with_handle(prompt, request).await })
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

fn map_matcha_delivery(outcome: MatchaDeliveryOutcome) -> DomainDeliveryOutcome {
    match outcome {
        MatchaDeliveryOutcome::Delivered { receipt } => DomainDeliveryOutcome::Delivered {
            receipt: DeliveryReceiptReference::try_new(receipt.as_str().to_owned())
                .expect("native Matcha run receipt must be a valid opaque reference"),
        },
        MatchaDeliveryOutcome::Rejected { failure } => DomainDeliveryOutcome::Rejected {
            rejection: match failure {
                MatchaEffectFailure::Unavailable => DeliveryRejection::Retryable,
                MatchaEffectFailure::InvalidInput
                | MatchaEffectFailure::Rejected
                | MatchaEffectFailure::Unsupported => DeliveryRejection::Permanent,
            },
        },
        MatchaDeliveryOutcome::OutcomeUnknown => DomainDeliveryOutcome::OutcomeUnknown,
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

fn map_role_error(error: RoleSessionError) -> MatchaEffectFailure {
    match error {
        RoleSessionError::RuntimeUnavailable => MatchaEffectFailure::Unavailable,
        RoleSessionError::Client(
            AppServerClientError::PeerRejected | AppServerClientError::SessionNotFound,
        ) => MatchaEffectFailure::Rejected,
        RoleSessionError::Client(_) => MatchaEffectFailure::Unavailable,
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
    fn local_receipts_and_requests_redact_native_values() {
        let session = RoleSessionId::try_new("session-private").unwrap();
        let prompt = RolePrompt::try_new("prompt-private").unwrap();
        let request =
            MatchaDeliveryRequest::try_new("delivery-private", session.clone(), prompt).unwrap();
        assert!(!format!("{request:?}").contains("prompt-private"));
        assert!(!format!("{:?}", MatchaSessionReceipt::new(session)).contains("session-private"));
    }
}
