use std::{future::Future, pin::Pin};

use organization::{
    MaterializationOperationOutcome, NativeEffectFailure, RoleSessionAbortOutcome,
    RoleSessionAbortReceipt, RoleSessionDeleteOutcome, RoleSessionDeleteReceipt,
    RoleSessionReadbackOutcome, RoleSessionReadbackReceipt, RoleSessionReceipt,
    SessionWindowReference, TeamMaterializationRemoval, TeamMaterializationRequest,
    TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use crate::{
    port::{OpenClawGateway, OpenClawSessionError, OpenClawSessionMutationFailure},
    session::protocol::{
        AgentId, AgentScopedSessionKey, ChatAbortParams, ChatAbortResult, ChatHistoryParams,
        EndpointSessionId, SessionDeleteParams, SessionDeleteResult, SessionKey,
    },
};

/// Organization's typed Team effect producer backed by native OpenClaw APIs.
///
/// The adapter owns only native request construction and outcome projection. Native
/// workspaces, config snapshots, history messages, and protocol DTOs remain inside
/// the OpenClaw integration.
pub struct OpenClawTeamNativeEffects<'gateway> {
    gateway: &'gateway mut OpenClawGateway,
}

impl<'gateway> OpenClawTeamNativeEffects<'gateway> {
    pub fn new(gateway: &'gateway mut OpenClawGateway) -> Self {
        Self { gateway }
    }
}

impl TeamNativeEffectsPort for OpenClawTeamNativeEffects<'_> {
    fn materialize(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        let gateway = &*self.gateway;
        Box::pin(async move { gateway.materialize_team(request).await })
    }

    fn recover_materialization(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        let gateway = &*self.gateway;
        Box::pin(async move { gateway.recover_team_materialization(request).await })
    }

    fn remove(
        &mut self,
        removal: TeamMaterializationRemoval,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        let gateway = &*self.gateway;
        Box::pin(async move { gateway.remove_team_materialization(removal).await })
    }

    fn abort(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionAbortOutcome> + Send + '_>> {
        let session = receipt.endpoint_session_id().clone();
        let key = match scoped_session_key(receipt) {
            Ok(key) => key,
            Err(failure) => {
                return Box::pin(async move { RoleSessionAbortOutcome::Failed { failure } });
            }
        };
        let gateway = &mut *self.gateway;
        Box::pin(async move {
            map_abort(
                gateway
                    .abort_chat_diagnostic(ChatAbortParams::new(key))
                    .await,
                session,
            )
        })
    }

    fn delete(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionDeleteOutcome> + Send + '_>> {
        let session = receipt.endpoint_session_id().clone();
        let key = match agent_scoped_session_key(receipt) {
            Ok(key) => key,
            Err(failure) => {
                return Box::pin(async move { RoleSessionDeleteOutcome::Failed { failure } });
            }
        };
        let gateway = &mut *self.gateway;
        Box::pin(async move {
            map_delete(
                gateway
                    .delete_session_diagnostic(SessionDeleteParams::new(key))
                    .await,
                session,
            )
        })
    }

    fn readback(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionReadbackOutcome> + Send + '_>> {
        let session = receipt.endpoint_session_id().clone();
        let key = match scoped_session_key(receipt) {
            Ok(key) => key,
            Err(failure) => {
                return Box::pin(async move { RoleSessionReadbackOutcome::Failed { failure } });
            }
        };
        let window = SessionWindowReference::try_new(format!(
            "openclaw-window:{}",
            receipt.endpoint_session_id().as_str()
        ));
        let Ok(window) = window else {
            return Box::pin(async {
                RoleSessionReadbackOutcome::Failed {
                    failure: NativeEffectFailure::InvalidInput,
                }
            });
        };
        let gateway = &mut *self.gateway;
        Box::pin(async move {
            match gateway
                .history_window(
                    ChatHistoryParams::new(key),
                    crate::session::window::PageRequest::latest(),
                )
                .await
            {
                Ok(_) => RoleSessionReadbackOutcome::Confirmed {
                    receipt: RoleSessionReadbackReceipt::new(session, window),
                },
                Err(OpenClawSessionError::TargetRejected) => RoleSessionReadbackOutcome::Failed {
                    failure: NativeEffectFailure::Rejected,
                },
                Err(OpenClawSessionError::SessionConnection) => {
                    RoleSessionReadbackOutcome::Failed {
                        failure: NativeEffectFailure::Unavailable,
                    }
                }
                Err(_) => RoleSessionReadbackOutcome::OutcomeUnknown,
            }
        })
    }
}

fn scoped_session_key(receipt: &RoleSessionReceipt) -> Result<SessionKey, NativeEffectFailure> {
    let key = agent_scoped_session_key(receipt)?;
    SessionKey::try_new(key.as_str().to_owned()).map_err(|_| NativeEffectFailure::InvalidInput)
}

fn agent_scoped_session_key(
    receipt: &RoleSessionReceipt,
) -> Result<AgentScopedSessionKey, NativeEffectFailure> {
    let agent = AgentId::try_new(receipt.agent().as_str().to_owned())
        .map_err(|_| NativeEffectFailure::InvalidInput)?;
    let session = EndpointSessionId::try_new(receipt.endpoint_session_id().as_str().to_owned())
        .map_err(|_| NativeEffectFailure::InvalidInput)?;
    AgentScopedSessionKey::try_new(agent, session).map_err(|_| NativeEffectFailure::InvalidInput)
}

fn map_abort(
    result: Result<
        InvocationOutcome<ChatAbortResult, OpenClawSessionMutationFailure>,
        OpenClawSessionError,
    >,
    session: organization::EndpointSessionId,
) -> RoleSessionAbortOutcome {
    match result {
        Ok(InvocationOutcome::Succeeded(result)) if result.ok => {
            RoleSessionAbortOutcome::Confirmed {
                receipt: RoleSessionAbortReceipt::new(session),
            }
        }
        Ok(InvocationOutcome::Succeeded(_)) => RoleSessionAbortOutcome::Failed {
            failure: NativeEffectFailure::Rejected,
        },
        Ok(InvocationOutcome::TargetRejected(failure)) if is_not_found_rejection(&failure) => {
            RoleSessionAbortOutcome::Confirmed {
                receipt: RoleSessionAbortReceipt::new(session),
            }
        }
        Ok(InvocationOutcome::TargetRejected(_)) => RoleSessionAbortOutcome::Failed {
            failure: NativeEffectFailure::Rejected,
        },
        Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => {
            RoleSessionAbortOutcome::OutcomeUnknown
        }
        Err(OpenClawSessionError::TargetRejected) => RoleSessionAbortOutcome::Failed {
            failure: NativeEffectFailure::Rejected,
        },
        Err(OpenClawSessionError::SessionConnection) => RoleSessionAbortOutcome::Failed {
            failure: NativeEffectFailure::Unavailable,
        },
        Err(_) => RoleSessionAbortOutcome::OutcomeUnknown,
    }
}

fn map_delete(
    result: Result<
        InvocationOutcome<SessionDeleteResult, OpenClawSessionMutationFailure>,
        OpenClawSessionError,
    >,
    session: organization::EndpointSessionId,
) -> RoleSessionDeleteOutcome {
    match result {
        Ok(InvocationOutcome::Succeeded(_)) => RoleSessionDeleteOutcome::Confirmed {
            receipt: RoleSessionDeleteReceipt::new(session),
        },
        Ok(InvocationOutcome::TargetRejected(failure)) if is_not_found_rejection(&failure) => {
            RoleSessionDeleteOutcome::Confirmed {
                receipt: RoleSessionDeleteReceipt::new(session),
            }
        }
        Ok(InvocationOutcome::TargetRejected(_)) => RoleSessionDeleteOutcome::Failed {
            failure: NativeEffectFailure::Rejected,
        },
        Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => {
            RoleSessionDeleteOutcome::OutcomeUnknown
        }
        Err(OpenClawSessionError::TargetRejected) => RoleSessionDeleteOutcome::Failed {
            failure: NativeEffectFailure::Rejected,
        },
        Err(OpenClawSessionError::SessionConnection) => RoleSessionDeleteOutcome::Failed {
            failure: NativeEffectFailure::Unavailable,
        },
        Err(_) => RoleSessionDeleteOutcome::OutcomeUnknown,
    }
}

fn is_not_found_rejection(failure: &OpenClawSessionMutationFailure) -> bool {
    failure.peer_rejection().is_some_and(|rejection| {
        matches!(
            rejection.code(),
            "NOT_FOUND" | "SESSION_NOT_FOUND" | "not_found" | "session_not_found"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_session_delete_confirms_absent_session_as_idempotent_cleanup() {
        let session = organization::EndpointSessionId::try_new("session:gone").unwrap();

        assert!(matches!(
            map_delete(
                Ok(InvocationOutcome::Succeeded(SessionDeleteResult {
                    deleted: false
                })),
                session.clone(),
            ),
            RoleSessionDeleteOutcome::Confirmed { .. }
        ));
        assert!(matches!(
            map_delete(
                Ok(InvocationOutcome::TargetRejected(
                    OpenClawSessionMutationFailure::from_peer_rejection_for_test("NOT_FOUND")
                )),
                session,
            ),
            RoleSessionDeleteOutcome::Confirmed { .. }
        ));
    }

    #[test]
    fn role_session_abort_confirms_native_noop_as_idempotent_cleanup() {
        let session = organization::EndpointSessionId::try_new("session:gone").unwrap();

        assert!(matches!(
            map_abort(
                Ok(InvocationOutcome::Succeeded(ChatAbortResult {
                    ok: true,
                    aborted: false,
                    run_ids: Vec::new(),
                })),
                session.clone(),
            ),
            RoleSessionAbortOutcome::Confirmed { .. }
        ));
        assert!(matches!(
            map_abort(
                Ok(InvocationOutcome::TargetRejected(
                    OpenClawSessionMutationFailure::from_peer_rejection_for_test("NOT_FOUND")
                )),
                session,
            ),
            RoleSessionAbortOutcome::Confirmed { .. }
        ));
    }

    #[test]
    fn native_receipts_redact_private_payloads() {
        let receipt = RoleSessionAbortReceipt::new(
            organization::EndpointSessionId::try_new("session-canary").unwrap(),
        );
        assert_eq!(
            format!("{receipt:?}"),
            "RoleSessionAbortReceipt(<redacted>)"
        );
    }
}
