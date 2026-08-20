use crate::{
    GraphRunId, OrganizationStore, RoleSessionDeleteReceipt, RoleSessionReceipt, StoreFault,
};

/// A native deletion confirmation paired with the exact binding it deleted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleSessionDeletionConfirmation {
    binding: RoleSessionReceipt,
    receipt: RoleSessionDeleteReceipt,
}

impl RoleSessionDeletionConfirmation {
    pub fn try_new(
        binding: RoleSessionReceipt,
        receipt: RoleSessionDeleteReceipt,
    ) -> Result<Self, NativeDeletionProofError> {
        if binding.external_session() != receipt.session() {
            return Err(NativeDeletionProofError::ReceiptSessionMismatch);
        }
        Ok(Self { binding, receipt })
    }

    pub fn binding(&self) -> &RoleSessionReceipt {
        &self.binding
    }

    pub fn receipt(&self) -> &RoleSessionDeleteReceipt {
        &self.receipt
    }
}

/// Typed proof that native deletion was confirmed for every listed binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeDeletionProof {
    run_id: GraphRunId,
    confirmations: Vec<RoleSessionDeletionConfirmation>,
}

impl NativeDeletionProof {
    pub fn try_new(
        run_id: GraphRunId,
        confirmations: Vec<RoleSessionDeletionConfirmation>,
    ) -> Result<Self, NativeDeletionProofError> {
        if run_id.as_str().trim().is_empty() {
            return Err(NativeDeletionProofError::EmptyRunId);
        }
        let mut proof = Self {
            run_id,
            confirmations,
        };
        proof.validate_shape()?;
        Ok(proof)
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn confirmations(&self) -> &[RoleSessionDeletionConfirmation] {
        &self.confirmations
    }

    pub(crate) fn covers(&self, expected: &[RoleSessionReceipt]) -> bool {
        self.confirmations.len() == expected.len()
            && expected.iter().all(|binding| {
                self.confirmations
                    .iter()
                    .any(|confirmation| confirmation.binding() == binding)
            })
    }

    fn validate_shape(&mut self) -> Result<(), NativeDeletionProofError> {
        for confirmation in &self.confirmations {
            if confirmation.binding().team_run() != &self.run_id {
                return Err(NativeDeletionProofError::BindingRunMismatch);
            }
        }
        for (index, confirmation) in self.confirmations.iter().enumerate() {
            if self.confirmations[..index]
                .iter()
                .any(|previous| previous.binding() == confirmation.binding())
            {
                return Err(NativeDeletionProofError::DuplicateBinding);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeDeletionProofError {
    EmptyRunId,
    BindingRunMismatch,
    DuplicateBinding,
    ReceiptSessionMismatch,
}

/// Evidence supplied by the native owner before Organization removes local facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeDeletionEvidence {
    Confirmed(NativeDeletionProof),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphRunPurgeOutcome {
    Purged,
    Replayed,
    Rejected(GraphRunPurgeRejection),
    OutcomeUnknown(GraphRunPurgeUnknown),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphRunPurgeRejection {
    AlreadyPurged,
    NotTombstoned,
    NativeDeletionRejected,
    ProofMismatch,
    InvalidIdempotencyKey,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphRunPurgeUnknown {
    MissingRun,
    NativeDeletionOutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamRunPurgeRequest {
    run_id: GraphRunId,
    idempotency_key: String,
    native: NativeDeletionEvidence,
}

impl TeamRunPurgeRequest {
    pub fn new(
        run_id: GraphRunId,
        idempotency_key: impl Into<String>,
        native: NativeDeletionEvidence,
    ) -> Self {
        Self {
            run_id,
            idempotency_key: idempotency_key.into(),
            native,
        }
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn native(&self) -> &NativeDeletionEvidence {
        &self.native
    }
}

/// Organization is the sole producer of the physical TeamRun purge transition.
pub fn purge_team_run(
    store: &mut OrganizationStore,
    request: TeamRunPurgeRequest,
) -> Result<GraphRunPurgeOutcome, StoreFault> {
    store.purge_graph_run(request)
}
