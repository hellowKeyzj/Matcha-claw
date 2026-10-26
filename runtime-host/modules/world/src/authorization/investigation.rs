use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::InvestigationSelection,
    authorization::{AccessMode, ActualImpact, AuthorizationFailure, Decision},
    ids::*,
    operation::CancellationState,
    time::Timestamp,
};

use super::{
    Admission, AuthError, AuthorityRoot, NativeProof, NativeVerificationError,
    NativeWorldInvestigation, read::AuthorityRead,
};
use crate::{
    extensions::invocation::CallBudget,
    learning::investigation::{
        InvestigationAccepted, InvestigationIdentity, InvestigationReceipt, InvestigationRequest,
        InvestigationSentness, InvestigationState, InvestigationUsage,
    },
    owner::{OperationRecord, RunRecord, StepRecord},
    store::{StoreFuture, WorldStore, WorldTransaction},
};

/// Live owner custody, never a serializable credential or a grant obtained from an identifier.
pub struct InvestigationBinding {
    root: Arc<AuthorityRoot>,
    store: WorldStore,
    parent: Admission,
    identity: InvestigationIdentity,
    finite: ActualImpact,
    request_digest: Digest,
    deadline: Timestamp,
    budget: CallBudget,
    cancellation: CancellationToken,
    state: Mutex<State>,
}

struct State {
    accepted: Option<(NativeWorldInvestigation, String)>,
    recovery_only: bool,
    stopped: bool,
    accounted: bool,
    native_settled: bool,
    children: u64,
    released: bool,
}

/// An original Tasks-owned child must acknowledge its real join; dropping this never fabricates one.
pub(crate) struct InvestigationWork {
    binding: Arc<InvestigationBinding>,
    joined: bool,
}

impl InvestigationWork {
    pub(crate) fn world(&self) -> &WorldRef { self.binding.world() }
    pub(crate) fn binding_id(&self) -> &BindingId { &self.binding.identity.binding_id }
    pub(crate) fn is_joined(&self) -> bool { self.joined }
    pub(crate) fn joined(&mut self) {
        if self.joined { return; }
        let mut state = self.binding.state.lock().expect("investigation custody poisoned");
        state.children = state.children.checked_sub(1).expect("owned investigation child");
        state.released = state.stopped && state.accounted && state.native_settled && state.children == 0;
        self.joined = true;
    }
}

#[derive(Clone)]
pub(super) struct InvestigationChild {
    binding: Arc<InvestigationBinding>,
    accepted: NativeWorldInvestigation,
    producer: String,
}

pub(crate) async fn mint_investigation(
    tx: &WorldTransaction<'_>,
    store: &WorldStore,
    root: &Arc<AuthorityRoot>,
    parent: &Admission,
    operation: &OperationRecord,
    run: &RunRecord,
    step: &StepRecord,
    identity: &InvestigationIdentity,
    finite_impact: &ActualImpact,
    budget: &CallBudget,
    cancellation: &CancellationToken,
    now: &Timestamp,
) -> Result<InvestigationBinding, crate::owner::Error> {
    mint(tx, store, root, parent, operation, run, step, identity, finite_impact,
        budget, cancellation, now, false).await
}

/// Cleanup custody can inspect/cancel the original request, but cannot release held native work.
pub(crate) async fn mint_investigation_recovery(
    tx: &WorldTransaction<'_>,
    store: &WorldStore,
    root: &Arc<AuthorityRoot>,
    parent: &Admission,
    operation: &OperationRecord,
    run: &RunRecord,
    step: &StepRecord,
    identity: &InvestigationIdentity,
    finite_impact: &ActualImpact,
    budget: &CallBudget,
    cancellation: &CancellationToken,
    now: &Timestamp,
) -> Result<InvestigationBinding, crate::owner::Error> {
    mint(tx, store, root, parent, operation, run, step, identity, finite_impact,
        budget, cancellation, now, true).await
}

async fn mint(
    tx: &WorldTransaction<'_>, store: &WorldStore, root: &Arc<AuthorityRoot>,
    parent: &Admission, operation: &OperationRecord, run: &RunRecord, step: &StepRecord,
    identity: &InvestigationIdentity, finite: &ActualImpact, budget: &CallBudget,
    cancellation: &CancellationToken, now: &Timestamp, recovery_only: bool,
) -> Result<InvestigationBinding, crate::owner::Error> {
    if parent.verified().investigation.is_some() || parent.verified().evaluation.is_some()
        || parent.verified().online_oracle.is_some()
        || (!recovery_only && (parent.recovery_only || cancellation.is_cancelled()))
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    super::recheck(tx, parent, now).await?;
    parent.require_access(finite)?;
    require_finite(finite)?;
    require_records(tx.world(), parent, identity, operation, run, step, recovery_only)?;
    let deadline = if recovery_only {
        crate::learning::investigation::require_investigation_recovery_checkpoint(step, identity, finite)?
    } else {
        budget.check().map_err(|failure| crate::owner::Error::from_host_failure(
            world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension },
            world_protocol::failure::FailureStage::Admission,
        ))?;
        crate::learning::investigation::require_investigation_checkpoint(step, identity, finite, now)?
    }.min(parent.invocation().deadline.clone());
    let request_digest = crate::learning::investigation::investigation_request_digest(step, identity, finite)?;
    Ok(InvestigationBinding {
        root: root.clone(), store: store.clone(), parent: parent.clone(), identity: identity.clone(),
        finite: finite.clone(), request_digest, deadline, budget: budget.clone(), cancellation: cancellation.clone(),
        state: Mutex::new(State {
            accepted: None, recovery_only, stopped: false, accounted: false, native_settled: false,
            children: 0, released: false,
        }),
    })
}

impl InvestigationBinding {
    pub(crate) fn world(&self) -> &WorldRef { &self.identity.operation.world }
    pub(crate) fn run_id(&self) -> &RunId { &self.identity.run_id }
    pub(crate) fn identity(&self) -> &InvestigationIdentity { &self.identity }
    pub(crate) fn budget(&self) -> &CallBudget { &self.budget }
    pub(crate) fn cancellation(&self) -> &CancellationToken { &self.cancellation }
    pub(crate) fn released(&self) -> bool {
        self.state.lock().expect("investigation custody poisoned").released
    }

    pub fn require_request(&self, request: &InvestigationRequest) -> Result<(), NativeVerificationError> {
        let value = serde_json::to_value((
            &request.identity, &request.execution_prompt, &request.allowed_effects,
            &request.budget, &request.created_at,
        )).map_err(|error| verification_error(AuthError::Codec(error)))?;
        let digest = crate::definitions::canonical_digest(&value)
            .map_err(|_| verification_error(AuthorizationFailure::InternalFault.into()))?;
        if !std::ptr::eq(self, Arc::as_ref(&request.authority)) || digest != self.request_digest {
            return Err(verification_error(AuthorizationFailure::RequestDigestMismatch.into()));
        }
        Ok(())
    }

    pub async fn may_dispatch(
        self: &Arc<Self>, request: &InvestigationRequest,
    ) -> Result<bool, NativeVerificationError> {
        self.require_request(request)?;
        self.executable().await
    }

    /// Only the trusted outbound adapter has this live capability. Tool proofs can only compare.
    pub fn attach_accepted(
        &self, accepted: &InvestigationAccepted, producer_runtime_instance: &str,
    ) -> Result<(), NativeVerificationError> {
        let facts = accepted_facts(accepted);
        facts.validate().map_err(verification_error)?;
        if facts.binding_id != self.identity.binding_id
            || facts.accepted_request_id != self.identity.native_request_id
            || facts.content_budget_digest != self.identity.content_budget_digest
            || !super::native::bounded(producer_runtime_instance, 256)
        {
            return Err(verification_error(AuthorizationFailure::RequestDigestMismatch.into()));
        }
        let mut state = self.state.lock().expect("investigation custody poisoned");
        let exact = (facts, producer_runtime_instance.to_owned());
        match &state.accepted {
            Some(previous) if previous != &exact =>
                Err(verification_error(AuthorizationFailure::RequestDigestMismatch.into())),
            Some(_) => Ok(()),
            None if state.released => Err(verification_error(AuthorizationFailure::Revoked.into())),
            None => { state.accepted = Some(exact); Ok(()) },
        }
    }

    /// The release handshake observes original current authority, not a deserialized request budget.
    pub async fn may_release(self: &Arc<Self>) -> Result<bool, NativeVerificationError> {
        if self.state.lock().expect("investigation custody poisoned").accepted.is_none() {
            return Ok(false);
        }
        self.executable().await
    }

    async fn executable(self: &Arc<Self>) -> Result<bool, NativeVerificationError> {
        {
            let state = self.state.lock().expect("investigation custody poisoned");
            if state.recovery_only || state.stopped || state.released
                || self.cancellation.is_cancelled()
            {
                return Ok(false);
            }
        }
        let binding = self.clone();
        match self.store.snapshot(self.world().clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            binding.current(AuthorityRead::Snapshot(snapshot), &now).await
        })).await {
            Ok(_) => Ok(true),
            Err(AuthError::Denied(_)) => Ok(false),
            Err(error) => Err(verification_error(error)),
        }
    }

    pub(crate) async fn check_current(
        &self, tx: &WorldTransaction<'_>, now: &Timestamp,
    ) -> Result<(), AuthError> {
        self.current(AuthorityRead::Transaction(tx), now).await.map(|_| ())
    }

    /// Reuse the original Work's budget/custody; fresh authorization never renews this cap.
    pub(crate) async fn check_resume(
        &self, tx: &WorldTransaction<'_>, root: &Arc<AuthorityRoot>, parent: &Admission,
        operation: &OperationRecord, run: &RunRecord, step: &StepRecord,
        identity: &InvestigationIdentity, finite: &ActualImpact, now: &Timestamp,
    ) -> Result<(), AuthError> {
        if !Arc::ptr_eq(root, &self.root) || identity != &self.identity || finite != &self.finite
            || parent.verified().investigation.is_some()
            || parent.verified().evaluation.is_some() || parent.verified().online_oracle.is_some()
        {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        super::recheck(tx, parent, now).await?;
        parent.require_access(finite)?;
        require_records(tx.world(), parent, identity, operation, run, step, true)?;
        crate::learning::investigation::require_investigation_recovery_checkpoint(step, identity, finite)?;
        if parent.recovery_only || self.cancellation.is_cancelled() || now >= &self.deadline
            || operation.receipt.cancellation != CancellationState::NotRequested
        {
            self.state.lock().expect("investigation custody poisoned").recovery_only = true;
        } else {
            match self.current(AuthorityRead::Transaction(tx), now).await {
                Ok(_) => {},
                Err(AuthError::Denied(_)) => {
                    self.state.lock().expect("investigation custody poisoned").recovery_only = true;
                },
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub(crate) fn observe_receipt(&self, receipt: &InvestigationReceipt) -> Result<(), AuthError> {
        if receipt.identity != self.identity {
            return Err(AuthorizationFailure::RequestDigestMismatch.into());
        }
        let mut state = self.state.lock().expect("investigation custody poisoned");
        if let Some(accepted) = &receipt.accepted {
            if state.accepted.as_ref().map(|(current, _)| current) != Some(&accepted_facts(accepted)) {
                return Err(AuthorizationFailure::RequestDigestMismatch.into());
            }
        } else if matches!(receipt.state, InvestigationState::Terminal { .. })
            || (state.accepted.is_some() && receipt.sentness == InvestigationSentness::NotSent)
        {
            return Err(AuthorizationFailure::RequestDigestMismatch.into());
        }
        // Terminal is the native port's physical joined/pending-zero receipt, independent of metering.
        let not_sent = matches!(receipt.state, InvestigationState::Rejected { .. })
            && receipt.sentness == InvestigationSentness::NotSent && receipt.accepted.is_none();
        if not_sent || matches!(receipt.state, InvestigationState::Terminal { .. }) {
            state.stopped = true;
        }
        Ok(())
    }

    /// Only after the original durable usage marker and accounting acknowledgement.
    pub(crate) fn acknowledge_receipt(&self, receipt: &InvestigationReceipt) -> Result<(), AuthError> {
        self.observe_receipt(receipt)?;
        let mut state = self.state.lock().expect("investigation custody poisoned");
        let not_sent = matches!(receipt.state, InvestigationState::Rejected { .. })
            && receipt.sentness == InvestigationSentness::NotSent && receipt.accepted.is_none();
        let terminal = matches!(receipt.state, InvestigationState::Terminal { .. })
            && matches!(receipt.usage, InvestigationUsage::Complete { .. }) && receipt.accepted.is_some();
        if !state.stopped || !(not_sent || terminal) {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        state.accounted = true;
        state.released = state.native_settled && state.children == 0;
        Ok(())
    }

    /// Settlement only acknowledges stopped, joined and durably accounted original work.
    pub fn require_settlement(&self, request: &InvestigationRequest) -> Result<(), NativeVerificationError> {
        self.require_request(request)?;
        let state = self.state.lock().expect("investigation custody poisoned");
        if !state.stopped || !state.accounted || state.children != 0 {
            return Err(verification_error(AuthorizationFailure::InvalidDelegation.into()));
        }
        Ok(())
    }

    pub fn require_not_sent_settlement(&self, request: &InvestigationRequest) -> Result<(), NativeVerificationError> {
        self.require_settlement(request)?;
        if self.state.lock().expect("investigation custody poisoned").accepted.is_some() {
            return Err(verification_error(AuthorizationFailure::InvalidDelegation.into()));
        }
        Ok(())
    }

    pub(crate) fn acknowledge_settlement(&self, request: &InvestigationRequest) -> Result<(), NativeVerificationError> {
        self.require_settlement(request)?;
        let mut state = self.state.lock().expect("investigation custody poisoned");
        state.native_settled = true;
        state.released = true;
        Ok(())
    }

    pub(super) fn child(
        self: &Arc<Self>, root: &Arc<AuthorityRoot>, proof: &NativeProof,
    ) -> Result<InvestigationChild, AuthError> {
        if !Arc::ptr_eq(root, &self.root) || proof.facts().evaluation {
            return Err(AuthorizationFailure::InvalidPrincipal.into());
        }
        let facts = proof.facts();
        let accepted = facts.world_investigation.as_ref()
            .ok_or(AuthorizationFailure::InvalidDelegation)?;
        let state = self.state.lock().expect("investigation custody poisoned");
        if state.recovery_only || state.stopped || state.released
            || state.accepted.as_ref() != Some(&(accepted.clone(), proof.runtime_instance().to_owned()))
        {
            return Err(AuthorizationFailure::InvalidDelegation.into());
        }
        let selected = match &self.identity.selection {
            InvestigationSelection::Openclaw { agent_id, session_key, native_session_id } =>
                facts.endpoint_id.as_str() == "openclaw" && &facts.agent_id == agent_id
                    && facts.native_session_id.as_ref() == Some(native_session_id)
                    && facts.session_key.as_ref() == Some(session_key),
            InvestigationSelection::MatchaAgent { agent_id, native_session_id } =>
                facts.endpoint_id.as_str() == "matcha-agent" && &facts.agent_id == agent_id
                    && facts.native_session_id.as_ref() == Some(native_session_id),
        };
        if !selected { return Err(AuthorizationFailure::InvalidDelegation.into()); }
        Ok(InvestigationChild {
            binding: self.clone(), accepted: accepted.clone(), producer: proof.runtime_instance().to_owned(),
        })
    }

    fn current<'a>(
        &'a self, read: AuthorityRead<'a, '_>, now: &'a Timestamp,
    ) -> StoreFuture<'a, Decision, AuthError> {
        Box::pin(async move {
            {
                let state = self.state.lock().expect("investigation custody poisoned");
                if state.recovery_only || state.stopped || state.released || self.cancellation.is_cancelled() {
                    return Err(AuthorizationFailure::Revoked.into());
                }
            }
            if read.world() != self.world() { return Err(AuthorizationFailure::InsufficientScope.into()); }
            if now >= &self.deadline { return Err(AuthorizationFailure::DeadlineExpired.into()); }
            self.budget.check().map_err(|_| AuthError::from(AuthorizationFailure::ObligationUnsatisfied))?;
            let decision = super::admission::recheck_current(read, &self.parent, now).await?;
            let world = self.world();
            let operation = read.query_opt(
                "SELECT body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3 FOR SHARE",
                "SELECT body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &self.identity.operation.operation_id.as_str()],
            ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
            let operation: OperationRecord = super::decode(operation.get("body"))?;
            let run = read.query_opt(
                "SELECT body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 FOR SHARE",
                "SELECT body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &self.identity.run_id.as_str()],
            ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
            let run: RunRecord = super::decode(run.get("body"))?;
            let step = read.query_opt(
                "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4 FOR SHARE",
                "SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND step_id=$4",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &self.identity.run_id.as_str(), &self.identity.step_id.as_str()],
            ).await?.ok_or(AuthorizationFailure::InvalidDelegation)?;
            let step: StepRecord = super::decode(step.get("body"))?;
            require_records(world, &self.parent, &self.identity, &operation, &run, &step, false)?;
            let deadline = crate::learning::investigation::require_investigation_checkpoint(
                &step, &self.identity, &self.finite, now,
            )?;
            if deadline < self.deadline { return Err(AuthorizationFailure::DeadlineExpired.into()); }
            Ok(decision)
        })
    }
}

impl InvestigationChild {
    pub(super) fn binding(&self) -> &InvestigationBinding { &self.binding }
    pub(super) fn identity(&self) -> &BindingId { &self.binding.identity.binding_id }
    pub(super) fn work(&self) -> Result<InvestigationWork, AuthError> {
        let mut state = self.binding.state.lock().expect("investigation custody poisoned");
        if state.recovery_only || state.stopped || state.released || self.binding.cancellation.is_cancelled() {
            return Err(AuthorizationFailure::Revoked.into());
        }
        state.children = state.children.checked_add(1).ok_or(AuthorizationFailure::InternalFault)?;
        Ok(InvestigationWork { binding: self.binding.clone(), joined: false })
    }
    pub(super) fn restrict_candidates(&self, candidates: Vec<super::AccessGrant>) -> Vec<super::AccessGrant> {
        let candidates = super::policies::restrict_candidates(candidates, &super::AccessGrant {
            access: self.binding.parent.impact().access.clone(),
            labels: self.binding.parent.impact().labels.clone(),
            effects: self.binding.parent.impact().effects.clone(),
        });
        super::policies::restrict_candidates(candidates, &super::AccessGrant {
            access: self.binding.finite.access.clone(), labels: self.binding.finite.labels.clone(),
            effects: self.binding.finite.effects.clone(),
        })
    }
    pub(super) async fn current(
        &self, read: AuthorityRead<'_, '_>, actual: &ActualImpact, now: &Timestamp,
    ) -> Result<Decision, AuthError> {
        {
            let state = self.binding.state.lock().expect("investigation custody poisoned");
            if state.accepted.as_ref() != Some(&(self.accepted.clone(), self.producer.clone())) {
                return Err(AuthorizationFailure::InvalidDelegation.into());
            }
        }
        let decision = self.binding.current(read, now).await?;
        self.binding.parent.require_access(actual)?;
        let grant = super::AccessGrant {
            access: self.binding.finite.access.clone(), labels: self.binding.finite.labels.clone(),
            effects: self.binding.finite.effects.clone(),
        };
        if !super::scope::permits(&grant, actual)
            || !actual.state.iter().all(|state| self.binding.finite.state.contains(state))
            || !actual.source_ids.iter().all(|source| self.binding.finite.source_ids.contains(source))
        {
            return Err(AuthorizationFailure::InsufficientScope.into());
        }
        Ok(decision)
    }

    pub(super) fn check_output<'a>(
        &'a self, read: AuthorityRead<'a, '_>, actual: &'a ActualImpact, delivered: u64, now: &'a Timestamp,
    ) -> StoreFuture<'a, (), AuthError> {
        Box::pin(async move {
            self.current(read, actual, now).await?;
            super::admission::evaluate_output(
                read, self.binding.parent.verified(), &self.binding.parent, actual, delivered, now,
            ).await?;
            Ok(())
        })
    }
}

fn require_records(
    world: &WorldRef, parent: &Admission, identity: &InvestigationIdentity,
    operation: &OperationRecord, run: &RunRecord, step: &StepRecord, recovery: bool,
) -> Result<(), AuthError> {
    operation.identity.require_resume(parent.verified())?;
    let command = operation.input.command_envelope()
        .map_err(|_| AuthorizationFailure::InvalidDelegation)?;
    let world_protocol::api::WorldCommand::ResolveTask(request) = &command.command else {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    };
    if command.world != *world || command.request_id != identity.world_request_id
        || request.task != identity.task || request.execution != identity.selection
        || crate::definitions::canonical_digest(&request.input)
            .map_err(|_| AuthorizationFailure::RequestDigestMismatch)? != identity.input_digest
        || operation.receipt.accepted.world != *world
        || &identity.operation.world != world || &parent.invocation().world != world
        || identity.task.world != *world || identity.operation.operation_id != operation.receipt.accepted.operation_id
        || identity.operation.incarnation != operation.receipt.accepted.incarnation
        || run.operation.operation_id != identity.operation.operation_id
        || run.operation.incarnation != identity.operation.incarnation || run.operation.world != *world
        || run.id != identity.run_id || step.id != identity.step_id || step.run_id != run.id
        || step.attempt != identity.attempt || step.kind != "learning.resolve"
        || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
        || (!recovery && (operation.receipt.cancellation != CancellationState::NotRequested
            || crate::owner::terminal_phase(operation.receipt.phase)
            || crate::owner::terminal_phase(run.phase) || crate::owner::terminal_phase(step.phase)))
        || !super::native::bounded(&identity.native_request_id, 256)
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    Ok(())
}

fn require_finite(impact: &ActualImpact) -> Result<(), AuthError> {
    super::scope::validate_impact(impact)?;
    if impact.access.iter().any(|scope| scope.resources.is_empty()
        || (scope.fields.is_empty() && (scope.modes.contains(&AccessMode::Write)
            || scope.resources.iter().any(|resource| matches!(resource,
                ResourceRef::Object { .. } | ResourceRef::Relation { .. })))))
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    Ok(())
}

fn accepted_facts(accepted: &InvestigationAccepted) -> NativeWorldInvestigation {
    NativeWorldInvestigation {
        binding_id: accepted.binding_id.clone(), accepted_request_id: accepted.accepted_request_id.clone(),
        accepted_run_id: accepted.accepted_run_id.clone(), accepted_input_id: accepted.accepted_input_id.clone(),
        content_budget_digest: accepted.content_budget_digest.clone(), native_attempt_id: accepted.native_attempt_id.clone(),
        native_instance_id: accepted.native_instance_id.clone(),
    }
}

fn verification_error(error: AuthError) -> NativeVerificationError {
    match error {
        AuthError::Denied(reason) => NativeVerificationError::rejected(reason),
        error => NativeVerificationError::new(AuthorizationFailure::InternalFault, error),
    }
}
