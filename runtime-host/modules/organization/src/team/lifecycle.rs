use crate::{
    MaterializationOperationOutcome, MaterializationReceipt, MaterializationRejection,
    RoleMaterializationAgent, RoleMaterializationOwnership, TeamMaterializationRemoval,
    TeamMaterializationRequest,
};

/// The durable Organization-owned state for one Team's provider materialization.
///
/// This records intent and verified facts separately. Provider acceptance is not a
/// materialization receipt: without a provider-owned fact it becomes `OutcomeUnknown`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMaterializationLifecycle {
    Requested(TeamMaterializationRequest),
    Rejected {
        request: TeamMaterializationRequest,
        rejection: MaterializationRejection,
    },
    OutcomeUnknown(TeamMaterializationRequest),
    Confirmed(MaterializationReceipt),
    Tombstoned(TombstonedMaterialization),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TombstonedMaterialization {
    None(TeamMaterializationRequest),
    OutcomeUnknown(TeamMaterializationRequest),
    Confirmed {
        receipt: MaterializationReceipt,
        cleanup: TeamMaterializationCleanup,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMaterializationCleanup {
    Pending(TeamMaterializationRemoval),
    Confirmed(TeamMaterializationRemoval),
    Rejected {
        removal: TeamMaterializationRemoval,
        rejection: MaterializationRejection,
    },
    OutcomeUnknown(TeamMaterializationRemoval),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterializationRecordOutcome {
    Recorded,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterializationLifecycleError {
    InvalidTransition,
    OperationReceiptMismatch,
    ReceiptDoesNotMatchIntent,
}

impl TeamMaterializationLifecycle {
    pub fn requested(request: TeamMaterializationRequest) -> Self {
        Self::Requested(request)
    }

    pub fn team(&self) -> Option<&crate::TeamId> {
        match self {
            Self::Requested(request) | Self::OutcomeUnknown(request) => {
                Some(request.intent().team())
            }
            Self::Rejected { request, .. } => Some(request.intent().team()),
            Self::Confirmed(receipt) => Some(receipt.team()),
            Self::Tombstoned(TombstonedMaterialization::OutcomeUnknown(request)) => {
                Some(request.intent().team())
            }
            Self::Tombstoned(TombstonedMaterialization::Confirmed { receipt, .. }) => {
                Some(receipt.team())
            }
            Self::Tombstoned(TombstonedMaterialization::None(request)) => {
                Some(request.intent().team())
            }
        }
    }

    pub fn receipt(&self) -> Option<&MaterializationReceipt> {
        match self {
            Self::Confirmed(receipt) => Some(receipt),
            Self::Tombstoned(TombstonedMaterialization::Confirmed { receipt, .. }) => Some(receipt),
            Self::Requested(_)
            | Self::Rejected { .. }
            | Self::OutcomeUnknown(_)
            | Self::Tombstoned(_) => None,
        }
    }

    /// Returns a recorded intent that may be settled only by a provider readback.
    /// It must never be used to replay a native materialization mutation.
    pub fn receipt_recovery_request(&self) -> Option<&TeamMaterializationRequest> {
        match self {
            Self::Requested(request) | Self::OutcomeUnknown(request) => Some(request),
            Self::Rejected { .. } | Self::Confirmed(_) | Self::Tombstoned(_) => None,
        }
    }

    pub fn cleanup_request(&self) -> Option<&TeamMaterializationRemoval> {
        match self {
            Self::Tombstoned(TombstonedMaterialization::Confirmed {
                cleanup: TeamMaterializationCleanup::Pending(removal),
                ..
            }) => Some(removal),
            _ => None,
        }
    }

    pub fn cleanup(&self) -> Option<&TeamMaterializationCleanup> {
        match self {
            Self::Tombstoned(TombstonedMaterialization::Confirmed { cleanup, .. }) => Some(cleanup),
            _ => None,
        }
    }

    pub(crate) fn can_transition_from(&self, previous: &Self) -> bool {
        if self == previous {
            return true;
        }
        match (previous, self) {
            (
                Self::Requested(_),
                Self::Rejected { .. } | Self::OutcomeUnknown(_) | Self::Confirmed(_),
            )
            | (Self::OutcomeUnknown(_), Self::Confirmed(_))
            | (
                Self::Requested(_)
                | Self::Rejected { .. }
                | Self::OutcomeUnknown(_)
                | Self::Confirmed(_),
                Self::Tombstoned(_),
            ) => true,
            (
                Self::OutcomeUnknown(previous_request),
                Self::Rejected {
                    request: current_request,
                    ..
                },
            )
            | (
                Self::Tombstoned(TombstonedMaterialization::OutcomeUnknown(previous_request)),
                Self::Tombstoned(TombstonedMaterialization::None(current_request)),
            ) => previous_request == current_request,
            (
                Self::Tombstoned(TombstonedMaterialization::Confirmed {
                    receipt: previous_receipt,
                    cleanup: TeamMaterializationCleanup::Pending(previous_removal),
                }),
                Self::Tombstoned(TombstonedMaterialization::Confirmed {
                    receipt: current_receipt,
                    cleanup:
                        TeamMaterializationCleanup::Confirmed(current_removal)
                        | TeamMaterializationCleanup::Rejected {
                            removal: current_removal,
                            ..
                        }
                        | TeamMaterializationCleanup::OutcomeUnknown(current_removal),
                }),
            ) => previous_receipt == current_receipt && previous_removal == current_removal,
            (
                Self::Tombstoned(TombstonedMaterialization::Confirmed {
                    receipt: previous_receipt,
                    cleanup: TeamMaterializationCleanup::OutcomeUnknown(previous_removal),
                }),
                Self::Tombstoned(TombstonedMaterialization::Confirmed {
                    receipt: current_receipt,
                    cleanup: TeamMaterializationCleanup::Confirmed(current_removal),
                }),
            ) => previous_receipt == current_receipt && previous_removal == current_removal,
            _ => false,
        }
    }

    pub fn record_materialization_outcome(
        &mut self,
        outcome: MaterializationOperationOutcome,
    ) -> Result<MaterializationRecordOutcome, MaterializationLifecycleError> {
        let request = match self {
            Self::Requested(request) => request,
            Self::OutcomeUnknown(request)
                if matches!(&outcome, MaterializationOperationOutcome::Rejected { .. }) =>
            {
                request
            }
            _ => return Err(MaterializationLifecycleError::InvalidTransition),
        };
        let next = match outcome {
            MaterializationOperationOutcome::Confirmed { receipt } => {
                if !receipt_matches_request(&receipt, request) {
                    return Err(MaterializationLifecycleError::ReceiptDoesNotMatchIntent);
                }
                Self::Confirmed(receipt)
            }
            MaterializationOperationOutcome::Accepted { receipt }
                if receipt.idempotency_key() != request.idempotency_key() =>
            {
                return Err(MaterializationLifecycleError::OperationReceiptMismatch);
            }
            MaterializationOperationOutcome::Accepted { .. }
            | MaterializationOperationOutcome::OutcomeUnknown => {
                Self::OutcomeUnknown(request.clone())
            }
            MaterializationOperationOutcome::Rejected { rejection } => Self::Rejected {
                request: request.clone(),
                rejection,
            },
        };
        *self = next;
        Ok(MaterializationRecordOutcome::Recorded)
    }

    pub fn confirm(
        &mut self,
        receipt: MaterializationReceipt,
    ) -> Result<MaterializationRecordOutcome, MaterializationLifecycleError> {
        match self {
            Self::Confirmed(existing) if existing == &receipt => {
                Ok(MaterializationRecordOutcome::Replayed)
            }
            Self::Requested(request) | Self::OutcomeUnknown(request) => {
                if !receipt_matches_request(&receipt, request) {
                    return Err(MaterializationLifecycleError::ReceiptDoesNotMatchIntent);
                }
                *self = Self::Confirmed(receipt);
                Ok(MaterializationRecordOutcome::Recorded)
            }
            Self::Rejected { .. } | Self::Confirmed(_) | Self::Tombstoned(_) => {
                Err(MaterializationLifecycleError::InvalidTransition)
            }
        }
    }

    /// Logical removal is final in the Domain. It never erases provider facts or
    /// triggers an effect. A confirmed receipt produces one Integration-owned cleanup
    /// request; an ambiguous materialization remains explicitly ambiguous.
    pub fn tombstone(
        self,
        removal: impl FnOnce(&MaterializationReceipt) -> TeamMaterializationRemoval,
    ) -> Self {
        match self {
            Self::Confirmed(receipt) => {
                let cleanup = TeamMaterializationCleanup::Pending(removal(&receipt));
                Self::Tombstoned(TombstonedMaterialization::Confirmed { receipt, cleanup })
            }
            Self::Requested(request) | Self::OutcomeUnknown(request) => {
                Self::Tombstoned(TombstonedMaterialization::OutcomeUnknown(request))
            }
            Self::Rejected { request, .. } => {
                Self::Tombstoned(TombstonedMaterialization::None(request))
            }
            Self::Tombstoned(state) => Self::Tombstoned(state),
        }
    }

    pub fn record_cleanup_outcome(
        &mut self,
        outcome: MaterializationOperationOutcome,
    ) -> Result<MaterializationRecordOutcome, MaterializationLifecycleError> {
        if let Self::Tombstoned(TombstonedMaterialization::OutcomeUnknown(request)) = self {
            return match outcome {
                MaterializationOperationOutcome::Confirmed { receipt } => {
                    if !receipt_matches_request(&receipt, request) {
                        return Err(MaterializationLifecycleError::ReceiptDoesNotMatchIntent);
                    }
                    *self = Self::Tombstoned(TombstonedMaterialization::None(request.clone()));
                    Ok(MaterializationRecordOutcome::Recorded)
                }
                MaterializationOperationOutcome::Accepted { receipt }
                    if receipt.idempotency_key() != request.idempotency_key() =>
                {
                    Err(MaterializationLifecycleError::OperationReceiptMismatch)
                }
                MaterializationOperationOutcome::Accepted { .. }
                | MaterializationOperationOutcome::Rejected { .. }
                | MaterializationOperationOutcome::OutcomeUnknown => {
                    Ok(MaterializationRecordOutcome::Replayed)
                }
            };
        }
        let Self::Tombstoned(TombstonedMaterialization::Confirmed { cleanup, .. }) = self else {
            return Err(MaterializationLifecycleError::InvalidTransition);
        };
        let removal = match cleanup {
            TeamMaterializationCleanup::Pending(removal)
            | TeamMaterializationCleanup::Confirmed(removal)
            | TeamMaterializationCleanup::OutcomeUnknown(removal)
            | TeamMaterializationCleanup::Rejected { removal, .. } => removal,
        };
        let next = cleanup_outcome(removal, outcome)?;
        if *cleanup == next {
            return Ok(MaterializationRecordOutcome::Replayed);
        }
        if !matches!(cleanup, TeamMaterializationCleanup::Pending(_))
            && !matches!(
                (&*cleanup, &next),
                (
                    TeamMaterializationCleanup::OutcomeUnknown(_),
                    TeamMaterializationCleanup::Confirmed(_),
                )
            )
        {
            return Err(MaterializationLifecycleError::InvalidTransition);
        }
        *cleanup = next;
        Ok(MaterializationRecordOutcome::Recorded)
    }
}

fn cleanup_outcome(
    removal: &TeamMaterializationRemoval,
    outcome: MaterializationOperationOutcome,
) -> Result<TeamMaterializationCleanup, MaterializationLifecycleError> {
    match outcome {
        MaterializationOperationOutcome::Accepted { receipt }
            if receipt.idempotency_key() != removal.idempotency_key() =>
        {
            Err(MaterializationLifecycleError::OperationReceiptMismatch)
        }
        MaterializationOperationOutcome::Rejected { .. } => {
            // A cleanup rejection does not prove that the native resource was untouched.
            // Preserve the removal intent, but require provider readback before settling it.
            Ok(TeamMaterializationCleanup::OutcomeUnknown(removal.clone()))
        }
        MaterializationOperationOutcome::Confirmed { receipt } => {
            if &receipt != removal.receipt() {
                return Err(MaterializationLifecycleError::ReceiptDoesNotMatchIntent);
            }
            Ok(TeamMaterializationCleanup::Confirmed(removal.clone()))
        }
        MaterializationOperationOutcome::Accepted { .. }
        | MaterializationOperationOutcome::OutcomeUnknown => {
            Ok(TeamMaterializationCleanup::OutcomeUnknown(removal.clone()))
        }
    }
}

fn receipt_matches_request(
    receipt: &MaterializationReceipt,
    request: &TeamMaterializationRequest,
) -> bool {
    let intent = request.intent();
    if receipt.team() != intent.team()
        || receipt.endpoint() != intent.endpoint()
        || receipt.roles().len() != intent.agents().len()
    {
        return false;
    }

    intent.agents().iter().all(|requested| {
        let Some(materialized) = receipt
            .roles()
            .iter()
            .find(|materialized| materialized.role() == requested.role())
        else {
            return false;
        };
        if materialized.agents_markdown() != requested.agents_markdown() {
            return false;
        }
        match requested.agent() {
            RoleMaterializationAgent::Managed { .. } => {
                materialized.ownership() == RoleMaterializationOwnership::Managed
            }
            RoleMaterializationAgent::External { agent } => {
                materialized.ownership() == RoleMaterializationOwnership::External
                    && materialized.agent() == agent
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use crate::{
        IdempotencyKey, ManagedAgentReference, MaterializationOperationReceipt,
        MaterializationSource, RoleAgentMaterialization, RoleId, RoleMaterializationReceipt,
        RuntimeEndpointReference, TeamId, ports::materialization::NativeWorkspaceReceipt,
    };

    use super::*;

    fn request() -> TeamMaterializationRequest {
        let role = RoleAgentMaterialization::managed(RoleId::try_new("lead").unwrap(), "team-lead")
            .unwrap();
        TeamMaterializationRequest::new(
            crate::TeamMaterializationIntent::try_new(
                TeamId::try_new("team:research").unwrap(),
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                MaterializationSource::Manual,
                vec![role],
            )
            .unwrap(),
            IdempotencyKey::try_new("materialize-1").unwrap(),
        )
    }

    fn receipt() -> MaterializationReceipt {
        MaterializationReceipt::try_new(
            TeamId::try_new("team:research").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            vec![RoleMaterializationReceipt::with_native_workspace(
                RoleId::try_new("lead").unwrap(),
                ManagedAgentReference::try_new("agent:lead").unwrap(),
                RoleMaterializationOwnership::Managed,
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                NativeWorkspaceReceipt::try_new("workspace:lead").unwrap(),
            )],
        )
        .unwrap()
    }

    #[test]
    fn confirmed_provider_facts_become_a_durable_materialization_receipt() {
        let mut lifecycle = TeamMaterializationLifecycle::requested(request());

        assert_eq!(
            lifecycle.record_materialization_outcome(MaterializationOperationOutcome::Confirmed {
                receipt: receipt(),
            }),
            Ok(MaterializationRecordOutcome::Recorded)
        );
        assert!(matches!(
            lifecycle,
            TeamMaterializationLifecycle::Confirmed(ref confirmed) if confirmed == &receipt()
        ));
    }

    #[test]
    fn accepted_provider_effect_is_outcome_unknown_until_confirmed_fact_arrives() {
        let mut lifecycle = TeamMaterializationLifecycle::requested(request());
        let outcome = lifecycle
            .record_materialization_outcome(MaterializationOperationOutcome::Accepted {
                receipt: MaterializationOperationReceipt::new(
                    IdempotencyKey::try_new("materialize-1").unwrap(),
                ),
            })
            .unwrap();

        assert_eq!(outcome, MaterializationRecordOutcome::Recorded);
        assert!(matches!(
            lifecycle,
            TeamMaterializationLifecycle::OutcomeUnknown(_)
        ));
        assert!(lifecycle.receipt().is_none());
        assert!(lifecycle.receipt_recovery_request().is_some());

        assert_eq!(
            lifecycle.confirm(receipt()),
            Ok(MaterializationRecordOutcome::Recorded)
        );
        assert!(lifecycle.receipt().is_some());
    }

    #[test]
    fn tombstone_retains_confirmed_receipt_and_never_claims_cleanup_completion() {
        let removal_key = IdempotencyKey::try_new("remove-1").unwrap();
        let lifecycle = TeamMaterializationLifecycle::Confirmed(receipt()).tombstone(|receipt| {
            TeamMaterializationRemoval::new(receipt.clone(), removal_key.clone())
        });
        let mut lifecycle = lifecycle;
        assert!(lifecycle.receipt().is_some());
        assert!(lifecycle.cleanup_request().is_some());

        lifecycle
            .record_cleanup_outcome(MaterializationOperationOutcome::Accepted {
                receipt: MaterializationOperationReceipt::new(removal_key),
            })
            .unwrap();
        assert!(matches!(
            lifecycle,
            TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
                cleanup: TeamMaterializationCleanup::OutcomeUnknown(_),
                ..
            })
        ));
    }

    #[test]
    fn cleanup_rejection_remains_unknown_until_provider_readback() {
        let removal_key = IdempotencyKey::try_new("remove-rejected").unwrap();
        let mut lifecycle = TeamMaterializationLifecycle::Confirmed(receipt())
            .tombstone(|receipt| TeamMaterializationRemoval::new(receipt.clone(), removal_key));

        lifecycle
            .record_cleanup_outcome(MaterializationOperationOutcome::Rejected {
                rejection: MaterializationRejection::Permanent,
            })
            .unwrap();

        assert!(matches!(
            lifecycle,
            TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
                cleanup: TeamMaterializationCleanup::OutcomeUnknown(_),
                ..
            })
        ));
    }

    #[test]
    fn cleanup_confirmed_replay_is_idempotent_after_unknown_readback() {
        let removal_key = IdempotencyKey::try_new("remove-readback").unwrap();
        let mut lifecycle =
            TeamMaterializationLifecycle::Confirmed(receipt()).tombstone(|receipt| {
                TeamMaterializationRemoval::new(receipt.clone(), removal_key.clone())
            });

        lifecycle
            .record_cleanup_outcome(MaterializationOperationOutcome::OutcomeUnknown)
            .unwrap();
        assert_eq!(
            lifecycle.record_cleanup_outcome(MaterializationOperationOutcome::Confirmed {
                receipt: receipt(),
            }),
            Ok(MaterializationRecordOutcome::Recorded)
        );
        assert_eq!(
            lifecycle.record_cleanup_outcome(MaterializationOperationOutcome::Confirmed {
                receipt: receipt(),
            }),
            Ok(MaterializationRecordOutcome::Replayed)
        );
    }

    #[test]
    fn mismatched_operation_receipts_cannot_settle_materialization_or_cleanup() {
        let mut lifecycle = TeamMaterializationLifecycle::requested(request());
        assert_eq!(
            lifecycle.record_materialization_outcome(MaterializationOperationOutcome::Accepted {
                receipt: MaterializationOperationReceipt::new(
                    IdempotencyKey::try_new("wrong-materialization").unwrap(),
                ),
            }),
            Err(MaterializationLifecycleError::OperationReceiptMismatch)
        );
        assert!(matches!(
            lifecycle,
            TeamMaterializationLifecycle::Requested(_)
        ));

        let removal_key = IdempotencyKey::try_new("remove-1").unwrap();
        let mut lifecycle = TeamMaterializationLifecycle::Confirmed(receipt())
            .tombstone(|receipt| TeamMaterializationRemoval::new(receipt.clone(), removal_key));
        assert_eq!(
            lifecycle.record_cleanup_outcome(MaterializationOperationOutcome::Accepted {
                receipt: MaterializationOperationReceipt::new(
                    IdempotencyKey::try_new("wrong-cleanup").unwrap(),
                ),
            }),
            Err(MaterializationLifecycleError::OperationReceiptMismatch)
        );
        assert!(lifecycle.cleanup_request().is_some());
    }

    #[test]
    fn tombstoning_ambiguous_materialization_does_not_invent_cleanup_effect() {
        let lifecycle =
            TeamMaterializationLifecycle::OutcomeUnknown(request()).tombstone(|receipt| {
                TeamMaterializationRemoval::new(
                    receipt.clone(),
                    IdempotencyKey::try_new("remove-1").unwrap(),
                )
            });

        assert!(matches!(
            lifecycle,
            TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::OutcomeUnknown(_))
        ));
        assert!(lifecycle.receipt().is_none());
        assert!(lifecycle.cleanup_request().is_none());
    }
}
