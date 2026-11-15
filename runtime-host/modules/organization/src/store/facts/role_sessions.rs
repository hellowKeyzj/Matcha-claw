use super::*;
use crate::{RoleId, RoleSessionReceipt, RoleSessionRef, StoreFault, application::team_runtime::RoleSessionCreateScope};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RoleSessionPhase {
    Reserved,
    SubmissionUncertain,
    Confirmed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RoleSessionIntent {
    pub(crate) binding: RoleSessionReceipt,
    pub(crate) phase: RoleSessionPhase,
}

impl GraphRunFacts {
    pub(crate) fn initial_runtime_receipt(&self, materialization: ConfirmedTeamMaterialization<'_>) -> Result<RunRuntimeReceipt, OrganizationFactsError> {
        if let Some(receipt) = self.runtime() { return Ok(receipt.clone()); }
        if !self.role_session_intents.is_empty() {
            return RunRuntimeReceipt::try_new(self.run_id().clone(), self.owned_role_sessions())
                .map_err(|_| OrganizationFactsError::RuntimeRoleBindingSetMismatch);
        }
        let mut slots = materialization.roles()
            .map(|role| (role.role().as_str().to_owned(), RoleSessionRef::initial())).collect::<BTreeSet<_>>();
        for node in self.graph().definition().nodes() {
            if let Some(assignment) = node.work_assignment() { slots.insert((assignment.role_id().to_owned(), assignment.session_ref().clone())); }
            if let Some(assignment) = node.review_assignment() { slots.insert((assignment.role_id().to_owned(), assignment.session_ref().clone())); }
        }
        let bindings = slots.into_iter().map(|(role, session_ref)| {
            let role = materialization.roles().find(|binding| binding.role().as_str() == role)
                .ok_or(OrganizationFactsError::RuntimeRoleBindingSetMismatch)?;
            Ok(RoleSessionReceipt::for_runtime(self.team().clone(), self.run_id().clone(), role.role().clone(), session_ref,
                role.agent().clone(), role.endpoint().clone()))
        }).collect::<Result<Vec<_>, OrganizationFactsError>>()?;
        RunRuntimeReceipt::try_new(self.run_id().clone(), bindings).map_err(|_| OrganizationFactsError::RuntimeRoleBindingSetMismatch)
    }

    pub(crate) fn role_session_intents(&self) -> &BTreeMap<String, RoleSessionIntent> {
        &self.role_session_intents
    }

    pub(crate) fn session_installed(&self, binding: &RoleSessionReceipt) -> bool {
        self.runtime().is_some_and(|runtime| runtime.bindings().contains(binding))
    }

    pub(crate) fn confirmed_role_sessions(&self) -> Vec<RoleSessionReceipt> {
        let mut bindings = self.runtime().map(|runtime| runtime.bindings().to_vec()).unwrap_or_default();
        bindings.extend(self.role_session_intents.values()
            .filter(|intent| intent.phase == RoleSessionPhase::Confirmed && !self.session_installed(&intent.binding))
            .map(|intent| intent.binding.clone()));
        bindings
    }

    pub(crate) fn owned_role_sessions(&self) -> Vec<RoleSessionReceipt> {
        let mut bindings = self.runtime().map(|runtime| runtime.bindings().to_vec()).unwrap_or_default();
        bindings.extend(self.role_session_intents.values().filter(|intent| !self.session_installed(&intent.binding))
            .map(|intent| intent.binding.clone()));
        bindings
    }

    pub(crate) fn restore_role_session_intents(
        &mut self,
        intents: BTreeMap<String, RoleSessionIntent>,
    ) -> Result<(), OrganizationFactsError> {
        if self.role_session_intents.iter().any(|(key, intent)| intents.get(key).is_none_or(|next| {
            next.binding != intent.binding || (intent.phase == RoleSessionPhase::Confirmed && next.phase != intent.phase)
        })) {
            return Err(OrganizationFactsError::RuntimeRoleBindingSetMismatch);
        }
        self.role_session_intents = intents;
        self.validate_role_session_intents()
    }

    pub(super) fn validate_role_session_intents(&self) -> Result<(), OrganizationFactsError> {
        if self.role_session_intents.is_empty() { return Ok(()); }
        if self.runtime().is_none() && self.workspace().is_none() { return Err(OrganizationFactsError::RuntimeRunMissing); }
        let mut slots = BTreeSet::new();
        for (key, intent) in &self.role_session_intents {
            let binding = &intent.binding;
            if IdempotencyKey::try_new(key.clone()).is_err()
                || binding.team() != self.team() || binding.team_run() != self.run_id()
                || !slots.insert((binding.role().as_str(), binding.session_ref().as_str()))
                || (self.session_installed(binding) && intent.phase != RoleSessionPhase::Confirmed)
                || (self.runtime().is_some() && intent.phase == RoleSessionPhase::Confirmed && !self.session_installed(binding))
                || (intent.phase != RoleSessionPhase::Reserved && self.workspace().is_some_and(|workspace| !workspace.is_prepared()))
            {
                return Err(OrganizationFactsError::RuntimeRoleBindingSetMismatch);
            }
        }
        RunRuntimeReceipt::try_new(self.run_id().clone(), self.owned_role_sessions())
            .map_err(|_| OrganizationFactsError::RuntimeRoleBindingSetMismatch)?;
        Ok(())
    }

    pub(crate) fn validate_session_transition(
        &self,
        previous: Option<&RunRuntimeReceipt>,
        intents: &BTreeMap<String, RoleSessionIntent>,
    ) -> Result<(), OrganizationFactsError> {
        if intents.iter().any(|(key, intent)| self.role_session_intents.get(key).is_none_or(|next| {
            next.binding != intent.binding || (intent.phase == RoleSessionPhase::Confirmed && next.phase != intent.phase)
        })) {
            return Err(OrganizationFactsError::RuntimeRoleBindingSetMismatch);
        }
        if let Some(previous) = previous {
            let current = self.runtime().ok_or(OrganizationFactsError::RuntimeRunMissing)?;
            if !current.bindings().starts_with(previous.bindings())
                || current.bindings()[previous.bindings().len()..].iter()
                    .any(|binding| !self.role_session_intents.values().any(|intent| &intent.binding == binding))
            {
                return Err(OrganizationFactsError::RuntimeRoleBindingSetMismatch);
            }
        }
        self.validate_role_session_intents()
    }
}

impl crate::OrganizationStore {
    pub(crate) fn reserve_role_session(
        &mut self,
        team: &TeamId,
        run_id: &GraphRunId,
        role: &RoleId,
        key: &IdempotencyKey,
        scope: &RoleSessionCreateScope,
    ) -> Result<RoleSessionIntent, StoreFault> {
        self.transact(|facts| {
            match scope {
                RoleSessionCreateScope::Runtime(endpoint) => {
                    if facts.materialization(team).is_none_or(|materialization| {
                        !materialization.receipts().any(|receipt| receipt.endpoint() == endpoint)
                    }) { return Err(StoreFault::InvalidFacts); }
                }
                RoleSessionCreateScope::Design { epoch, generation } => {
                    crate::application::design::guard(facts, team, run_id, epoch, Some(generation), None)?;
                    let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
                    if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
                        return Err(StoreFault::Design(crate::store::DesignError::RunInactive));
                    }
                    if facts.team(team).is_none_or(|team| team.tombstoned()) {
                        return Err(StoreFault::Design(crate::store::DesignError::UnknownTeam));
                    }
                }
            }
            let materialized = facts.materialization(team).and_then(|receipt| {
                receipt.roles().find(|binding| binding.role() == role)
            }).ok_or(StoreFault::InvalidFacts)?;
            let endpoint = materialized.endpoint();
            let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
            if run.team() != team { return Err(StoreFault::InvalidFacts); }
            if let Some(intent) = run.role_session_intents.get(key.as_str()) {
                if intent.binding.role() != role || intent.binding.endpoint() != endpoint {
                    return Err(StoreFault::InvalidFacts);
                }
                if run.session_installed(&intent.binding) { return Ok(intent.clone()); }
            }
            if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || facts.team(team).is_none_or(|team| team.tombstoned()) || run.runtime().is_none()
                || (run.workspace().is_some() && !run.workspace_ready())
            {
                return Err(StoreFault::InvalidFacts);
            }
            if let Some(intent) = run.role_session_intents.get(key.as_str()) { return Ok(intent.clone()); }
            if matches!(run.start_gate(), RunStartGate::Started) { return Err(StoreFault::InvalidFacts); }
            let mut next = 1u64;
            for binding in run.owned_role_sessions().iter().filter(|binding| binding.role() == role) {
                let number = binding.session_ref().as_str()[2..].parse::<u64>().map_err(|_| StoreFault::InvalidFacts)?;
                next = next.max(number.checked_add(1).ok_or(StoreFault::InvalidFacts)?);
            }
            let intent = RoleSessionIntent {
                binding: RoleSessionReceipt::for_runtime(
                    team.clone(), run_id.clone(), role.clone(),
                    RoleSessionRef::try_new(format!("rs{next}")).map_err(|_| StoreFault::InvalidFacts)?,
                    materialized.agent().clone(), materialized.endpoint().clone(),
                ),
                phase: RoleSessionPhase::Reserved,
            };
            facts.touch_run(run_id.as_str());
            facts.runs.get_mut(run_id.as_str()).expect("validated run")
                .role_session_intents.insert(key.as_str().to_owned(), intent.clone());
            Ok(intent)
        })
    }

    pub(crate) fn mark_role_session_submission(
        &mut self,
        key: &str,
        binding: &RoleSessionReceipt,
        uncertain: bool,
    ) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.run(binding.team_run()).ok_or(StoreFault::InvalidFacts)?;
            if run.role_session_intents.get(key).is_none_or(|intent| &intent.binding != binding || intent.phase == RoleSessionPhase::Confirmed)
                || run.session_installed(binding) { return Err(StoreFault::InvalidFacts); }
            if uncertain && (!matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || facts.team(binding.team()).is_none_or(|team| team.tombstoned())
                || run.workspace().is_some_and(|workspace| !workspace.is_prepared())) {
                return Err(StoreFault::InvalidFacts);
            }
            facts.touch_run(binding.team_run().as_str());
            facts.runs.get_mut(binding.team_run().as_str()).expect("validated run")
                .role_session_intents.get_mut(key).expect("validated intent").phase = if uncertain {
                    RoleSessionPhase::SubmissionUncertain
                } else { RoleSessionPhase::Reserved };
            Ok(())
        })
    }

    pub(crate) fn confirm_role_session(&mut self, key: &str, binding: &RoleSessionReceipt) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.run(binding.team_run()).ok_or(StoreFault::InvalidFacts)?;
            let intent = run.role_session_intents.get(key).filter(|intent| &intent.binding == binding)
                .ok_or(StoreFault::InvalidFacts)?;
            if intent.phase == RoleSessionPhase::Confirmed { return Ok(()); }
            if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || facts.team(binding.team()).is_none_or(|team| team.tombstoned())
                || run.workspace().is_some_and(|workspace| !workspace.is_prepared()) {
                return Err(StoreFault::InvalidFacts);
            }
            facts.touch_run(binding.team_run().as_str());
            let run = facts.runs.get_mut(binding.team_run().as_str()).expect("validated run");
            run.role_session_intents.get_mut(key).expect("validated intent").phase = RoleSessionPhase::Confirmed;
            if let Some(runtime) = &run.runtime {
                let mut bindings = runtime.bindings().to_vec();
                bindings.push(binding.clone());
                run.runtime = Some(RunRuntimeReceipt::try_new(binding.team_run().clone(), bindings).map_err(|_| StoreFault::InvalidFacts)?);
            } else if run.role_session_intents.values().all(|intent| intent.phase == RoleSessionPhase::Confirmed) {
                run.runtime = Some(RunRuntimeReceipt::try_new(binding.team_run().clone(),
                    run.role_session_intents.values().map(|intent| intent.binding.clone()).collect()).map_err(|_| StoreFault::InvalidFacts)?);
            }
            Ok(())
        })
    }
}
