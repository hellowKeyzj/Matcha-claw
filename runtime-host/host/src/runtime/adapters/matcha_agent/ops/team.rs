use super::*;

impl TeamOps for MatchaRuntimeDriver {
    fn materialize_team(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async {
            organization::MaterializationOperationOutcome::Rejected {
                rejection: organization::MaterializationRejection::Permanent,
            }
        })
    }

    fn remove_team(
        &self,
        _removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn recover_team_materialization(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn confirm_team_run_receipt(
        &self,
        _receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::organization::RuntimeReceiptOutcome> {
        Box::pin(async { crate::organization::RuntimeReceiptOutcome::OutcomeUnknown })
    }

    fn deliver_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
        let prompt = self.prompt.clone();
        Box::pin(async move { deliver_prompt_with_handle(prompt, request).await })
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        let native = self.native.clone();
        Box::pin(async move {
            for binding in bindings {
                let session = match ::matcha_agent::session::role::RoleSessionId::try_new(
                    binding.external_session().as_str().to_owned(),
                ) {
                    Ok(session) => session,
                    Err(_) => return organization::RoleAbortOutcome::OutcomeUnknown,
                };
                match native.cancel_role_session(session).await {
                    InvocationOutcome::Succeeded(()) => {}
                    InvocationOutcome::TargetRejected(_)
                    | InvocationOutcome::Cancelled
                    | InvocationOutcome::Unknown => {
                        return organization::RoleAbortOutcome::OutcomeUnknown;
                    }
                }
            }
            organization::RoleAbortOutcome::Confirmed
        })
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        let native = self.native.clone();
        Box::pin(async move {
            if abort_first {
                for binding in &bindings {
                    let session = match ::matcha_agent::session::role::RoleSessionId::try_new(
                        binding.external_session().as_str().to_owned(),
                    ) {
                        Ok(session) => session,
                        Err(_) => return organization::NativeDeletionEvidence::OutcomeUnknown,
                    };
                    match native.cancel_role_session(session).await {
                        InvocationOutcome::Succeeded(()) => {}
                        InvocationOutcome::TargetRejected(_)
                        | InvocationOutcome::Cancelled
                        | InvocationOutcome::Unknown => {
                            return organization::NativeDeletionEvidence::OutcomeUnknown;
                        }
                    }
                }
            }
            let mut confirmations = Vec::with_capacity(bindings.len());
            for binding in bindings {
                let session = match ::matcha_agent::session::role::RoleSessionId::try_new(
                    binding.external_session().as_str().to_owned(),
                ) {
                    Ok(session) => session,
                    Err(_) => return organization::NativeDeletionEvidence::Rejected,
                };
                match native.close_role_session(session).await {
                    InvocationOutcome::Succeeded(()) => {
                        let receipt = organization::RoleSessionDeleteReceipt::new(
                            binding.external_session().clone(),
                        );
                        let Ok(confirmation) =
                            organization::RoleSessionDeletionConfirmation::try_new(
                                binding, receipt,
                            )
                        else {
                            return organization::NativeDeletionEvidence::Rejected;
                        };
                        confirmations.push(confirmation);
                    }
                    InvocationOutcome::TargetRejected(_) => {
                        return organization::NativeDeletionEvidence::Rejected;
                    }
                    InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
                        return organization::NativeDeletionEvidence::OutcomeUnknown;
                    }
                }
            }
            organization::NativeDeletionProof::try_new(run_id, confirmations).map_or(
                organization::NativeDeletionEvidence::Rejected,
                organization::NativeDeletionEvidence::Confirmed,
            )
        })
    }
}

impl TeamOps for MatchaAgentInstance {
    fn materialize_team(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async {
            organization::MaterializationOperationOutcome::Rejected {
                rejection: organization::MaterializationRejection::Permanent,
            }
        })
    }

    fn remove_team(
        &self,
        _removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn recover_team_materialization(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn confirm_team_run_receipt(
        &self,
        _receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::organization::RuntimeReceiptOutcome> {
        Box::pin(async { crate::organization::RuntimeReceiptOutcome::OutcomeUnknown })
    }

    fn deliver_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
        Box::pin(deliver_prompt(self.peer(), request))
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        Box::pin(abort_role_sessions(self.peer(), bindings))
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        Box::pin(delete_role_sessions(
            self.peer(),
            run_id,
            bindings,
            abort_first,
        ))
    }
}
