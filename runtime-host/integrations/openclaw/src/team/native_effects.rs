use std::{future::Future, pin::Pin};

use organization::{
    MaterializationOperationOutcome, NativeEffectFailure,
    PromptDeliveryOutcome as DomainDeliveryOutcome, PromptDeliveryRequest, RoleSessionAbortOutcome,
    RoleSessionAbortReceipt, RoleSessionDeleteOutcome, RoleSessionDeleteReceipt,
    RoleSessionReadbackOutcome, RoleSessionReadbackReceipt, RoleSessionReceipt,
    SessionWindowReference, TeamMaterializationRemoval, TeamMaterializationRequest,
    TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use crate::{
    port::{OpenClawGateway, OpenClawSessionError},
    session::protocol::{
        AgentId, AgentScopedSessionKey, ChatAbortParams, ChatAbortResult, ChatHistoryParams,
        EndpointSessionId, RunId, SessionDeleteParams, SessionDeleteResult, SessionKey,
    },
};

use super::{
    PromptDelivery, PromptDeliveryFailure, PromptDeliveryOutcome as NativeDeliveryOutcome,
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

    fn deliver(
        &mut self,
        request: PromptDeliveryRequest,
    ) -> Pin<Box<dyn Future<Output = DomainDeliveryOutcome> + Send + '_>> {
        let delivery = match native_delivery(request) {
            Ok(delivery) => delivery,
            Err(_) => {
                return Box::pin(async {
                    DomainDeliveryOutcome::Rejected {
                        rejection: organization::DeliveryRejection::Permanent,
                    }
                });
            }
        };
        let gateway = &mut *self.gateway;
        Box::pin(async move { map_delivery(gateway.deliver_team_prompt(delivery).await) })
    }

    fn abort(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionAbortOutcome> + Send + '_>> {
        let session = receipt.external_session().clone();
        let key = match scoped_session_key(receipt) {
            Ok(key) => key,
            Err(failure) => {
                return Box::pin(async move { RoleSessionAbortOutcome::Failed { failure } });
            }
        };
        let gateway = &mut *self.gateway;
        Box::pin(
            async move { map_abort(gateway.abort_chat(ChatAbortParams::new(key)).await, session) },
        )
    }

    fn delete(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionDeleteOutcome> + Send + '_>> {
        let session = receipt.external_session().clone();
        let key = match agent_scoped_session_key(receipt) {
            Ok(key) => key,
            Err(failure) => {
                return Box::pin(async move { RoleSessionDeleteOutcome::Failed { failure } });
            }
        };
        let gateway = &mut *self.gateway;
        Box::pin(async move {
            map_delete(
                gateway.delete_session(SessionDeleteParams::new(key)).await,
                session,
            )
        })
    }

    fn readback(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionReadbackOutcome> + Send + '_>> {
        let session = receipt.external_session().clone();
        let key = match scoped_session_key(receipt) {
            Ok(key) => key,
            Err(failure) => {
                return Box::pin(async move { RoleSessionReadbackOutcome::Failed { failure } });
            }
        };
        let window = SessionWindowReference::try_new(format!(
            "openclaw-window:{}",
            receipt.external_session().as_str()
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
                    crate::session_window::PageRequest::latest(),
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

fn native_delivery(request: PromptDeliveryRequest) -> Result<PromptDelivery, NativeEffectFailure> {
    let agent = AgentId::try_new(request.binding().agent().as_str().to_owned())
        .map_err(|_| NativeEffectFailure::InvalidInput)?;
    let session =
        EndpointSessionId::try_new(request.binding().external_session().as_str().to_owned())
            .map_err(|_| NativeEffectFailure::InvalidInput)?;
    let idempotency = RunId::try_new(request.idempotency_key().as_str().to_owned())
        .map_err(|_| NativeEffectFailure::InvalidInput)?;
    PromptDelivery::try_new(
        agent,
        session,
        request.payload().as_str().to_owned(),
        idempotency,
    )
    .map_err(|_| NativeEffectFailure::InvalidInput)
}

fn map_delivery(native: NativeDeliveryOutcome) -> DomainDeliveryOutcome {
    match native {
        NativeDeliveryOutcome::Accepted { receipt } => DomainDeliveryOutcome::Delivered {
            receipt: organization::DeliveryReceiptReference::try_new(format!(
                "openclaw-run:{}",
                receipt.as_str()
            ))
            .expect("native OpenClaw run receipt must be a valid opaque reference"),
        },
        NativeDeliveryOutcome::Rejected { failure } => DomainDeliveryOutcome::Rejected {
            rejection: match failure {
                PromptDeliveryFailure::PolicyRejected => organization::DeliveryRejection::Permanent,
                PromptDeliveryFailure::Unavailable => organization::DeliveryRejection::Retryable,
            },
        },
        NativeDeliveryOutcome::OutcomeUnknown => DomainDeliveryOutcome::OutcomeUnknown,
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
    let session = EndpointSessionId::try_new(receipt.external_session().as_str().to_owned())
        .map_err(|_| NativeEffectFailure::InvalidInput)?;
    AgentScopedSessionKey::try_new(agent, session).map_err(|_| NativeEffectFailure::InvalidInput)
}

fn map_abort(
    result: Result<InvocationOutcome<ChatAbortResult, OpenClawSessionError>, OpenClawSessionError>,
    session: organization::ExternalSessionReference,
) -> RoleSessionAbortOutcome {
    match result {
        Ok(InvocationOutcome::Succeeded(result)) if result.ok && result.aborted => {
            RoleSessionAbortOutcome::Confirmed {
                receipt: RoleSessionAbortReceipt::new(session),
            }
        }
        Ok(InvocationOutcome::Succeeded(_)) | Ok(InvocationOutcome::TargetRejected(_)) => {
            RoleSessionAbortOutcome::Failed {
                failure: NativeEffectFailure::Rejected,
            }
        }
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
        InvocationOutcome<SessionDeleteResult, OpenClawSessionError>,
        OpenClawSessionError,
    >,
    session: organization::ExternalSessionReference,
) -> RoleSessionDeleteOutcome {
    match result {
        Ok(InvocationOutcome::Succeeded(result)) if result.deleted => {
            RoleSessionDeleteOutcome::Confirmed {
                receipt: RoleSessionDeleteReceipt::new(session),
            }
        }
        Ok(InvocationOutcome::Succeeded(_)) | Ok(InvocationOutcome::TargetRejected(_)) => {
            RoleSessionDeleteOutcome::Failed {
                failure: NativeEffectFailure::Rejected,
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_receipts_redact_private_payloads() {
        let receipt = RoleSessionAbortReceipt::new(
            organization::ExternalSessionReference::try_new("session-canary").unwrap(),
        );
        assert_eq!(
            format!("{receipt:?}"),
            "RoleSessionAbortReceipt(<redacted>)"
        );
        let delivery = PromptDelivery::try_new(
            AgentId::try_new("agent-canary").unwrap(),
            EndpointSessionId::try_new("session-canary").unwrap(),
            "prompt-private",
            RunId::try_new("run-canary").unwrap(),
        )
        .unwrap();
        assert!(!format!("{delivery:?}").contains("prompt-private"));
    }
}
