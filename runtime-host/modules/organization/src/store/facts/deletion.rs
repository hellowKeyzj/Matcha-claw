use super::*;
use crate::{NativeDeletionProof, RoleSessionDeletionConfirmation, StoreFault};

impl GraphRunFacts {
    pub(crate) fn deletion_confirmations(&self) -> &[RoleSessionDeletionConfirmation] {
        &self.deletion_confirmations
    }

    pub(crate) fn restore_deletion_confirmations(
        &mut self,
        confirmations: Vec<RoleSessionDeletionConfirmation>,
    ) -> Result<(), OrganizationFactsError> {
        self.validate_deletion_confirmations(&confirmations)?;
        self.deletion_confirmations = confirmations;
        Ok(())
    }

    pub(super) fn validate_deletion_confirmations(
        &self,
        confirmations: &[RoleSessionDeletionConfirmation],
    ) -> Result<(), OrganizationFactsError> {
        if confirmations.is_empty() {
            return if self.deletion_confirmations.is_empty() { Ok(()) }
                else { Err(OrganizationFactsError::InvalidGraphRun) };
        }
        let confirmed = self.confirmed_role_sessions();
        if matches!(self.lifecycle().state(), GraphRunLifecycleState::Active)
            || self.deletion_confirmations.iter().any(|previous| !confirmations.contains(previous))
            || confirmations.iter().any(|confirmation| !confirmed.contains(confirmation.binding()))
        {
            return Err(OrganizationFactsError::InvalidGraphRun);
        }
        NativeDeletionProof::try_new(self.run_id().clone(), confirmations.to_vec())
            .map_err(|_| OrganizationFactsError::InvalidGraphRun)?;
        Ok(())
    }
}

impl crate::OrganizationStore {
    pub(crate) fn record_run_deletion_evidence(
        &mut self,
        run_id: &GraphRunId,
        native: NativeDeletionEvidence,
    ) -> Result<NativeDeletionEvidence, StoreFault> {
        self.transact(|facts| {
            facts.touch_run(run_id.as_str());
            let run = facts.runs.get_mut(run_id.as_str()).ok_or(StoreFault::InvalidFacts)?;
            if matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
                return Err(StoreFault::InvalidFacts);
            }
            let expected = run.confirmed_role_sessions();
            let mut confirmations = run.deletion_confirmations.clone();
            if let Some(proof) = native.proof() {
                if proof.run_id() != run_id || proof.confirmations().iter()
                    .any(|confirmation| !expected.contains(confirmation.binding()))
                {
                    return Err(StoreFault::InvalidFacts);
                }
                for confirmation in proof.confirmations() {
                    if !confirmations.contains(confirmation) { confirmations.push(confirmation.clone()); }
                }
            }
            let proof = NativeDeletionProof::try_new(run_id.clone(), confirmations.clone())
                .map_err(|_| StoreFault::InvalidFacts)?;
            let complete = proof.covers(&expected);
            run.restore_deletion_confirmations(confirmations).map_err(|_| StoreFault::InvalidFacts)?;
            Ok(if complete {
                NativeDeletionEvidence::Confirmed(proof)
            } else {
                NativeDeletionEvidence::from_confirmations(run_id.clone(), proof.confirmations().to_vec(),
                    Some(native.failure().unwrap_or(crate::NativeDeletionFailure::OutcomeUnknown)))
            })
        })
    }
}
