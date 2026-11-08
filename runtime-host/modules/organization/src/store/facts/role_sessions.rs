use super::*;
use crate::{RoleId, RoleSessionReceipt, RoleSessionRef, StoreFault, application::team_runtime::RoleSessionCreateScope};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RoleSessionIntent {
    pub(crate) binding: RoleSessionReceipt,
    pub(crate) submission_uncertain: bool,
}

impl GraphRunFacts {
    pub(crate) fn role_session_intents(&self) -> &BTreeMap<String, RoleSessionIntent> {
        &self.role_session_intents
    }

    pub(crate) fn session_installed(&self, binding: &RoleSessionReceipt) -> bool {
        self.runtime().is_some_and(|runtime| runtime.bindings().contains(binding))
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
        if self.role_session_intents.iter().any(|(key, intent)| intents.get(key).is_none_or(|next| next.binding != intent.binding)) {
            return Err(OrganizationFactsError::RuntimeRoleBindingSetMismatch);
        }
        self.role_session_intents = intents;
        self.validate_role_session_intents()
    }

    pub(super) fn validate_role_session_intents(&self) -> Result<(), OrganizationFactsError> {
        if self.role_session_intents.is_empty() { return Ok(()); }
        if self.runtime().is_none() { return Err(OrganizationFactsError::RuntimeRunMissing); }
        let mut slots = BTreeSet::new();
        for (key, intent) in &self.role_session_intents {
            let binding = &intent.binding;
            if IdempotencyKey::try_new(key.clone()).is_err()
                || binding.team() != self.team() || binding.team_run() != self.run_id()
                || !slots.insert((binding.role().as_str(), binding.session_ref().as_str()))
                || (intent.submission_uncertain && self.session_installed(binding))
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
        if intents.iter().any(|(key, intent)| self.role_session_intents.get(key).is_none_or(|next| next.binding != intent.binding)) {
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
            let endpoint = match scope {
                RoleSessionCreateScope::Runtime(endpoint) => endpoint.clone(),
                RoleSessionCreateScope::Design { epoch, generation } => {
                    crate::application::design::guard(facts, team, run_id, epoch, Some(generation), None)?;
                    let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
                    if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
                        return Err(StoreFault::Design(crate::store::DesignError::RunInactive));
                    }
                    if facts.team(team).is_none_or(|team| team.tombstoned()) {
                        return Err(StoreFault::Design(crate::store::DesignError::UnknownTeam));
                    }
                    facts.materialization(team).and_then(|receipt| receipt.roles().iter()
                        .find(|binding| binding.role() == role))
                        .ok_or(StoreFault::InvalidFacts)?.endpoint().clone()
                }
            };
            let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
            if run.team() != team { return Err(StoreFault::InvalidFacts); }
            if let Some(intent) = run.role_session_intents.get(key.as_str()) {
                if intent.binding.role() != role || intent.binding.endpoint() != &endpoint {
                    return Err(StoreFault::InvalidFacts);
                }
                if run.session_installed(&intent.binding) { return Ok(intent.clone()); }
            }
            if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || facts.team(team).is_none_or(|team| team.tombstoned()) || run.runtime().is_none()
            {
                return Err(StoreFault::InvalidFacts);
            }
            let materialized = facts.materialization(team).and_then(|receipt| {
                receipt.roles().iter().find(|binding| binding.role() == role && binding.endpoint() == &endpoint)
            }).ok_or(StoreFault::InvalidFacts)?;
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
                submission_uncertain: false,
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
            if run.role_session_intents.get(key).is_none_or(|intent| &intent.binding != binding)
                || run.session_installed(binding) { return Err(StoreFault::InvalidFacts); }
            if uncertain && (!matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || facts.team(binding.team()).is_none_or(|team| team.tombstoned())) {
                return Err(StoreFault::InvalidFacts);
            }
            facts.touch_run(binding.team_run().as_str());
            facts.runs.get_mut(binding.team_run().as_str()).expect("validated run")
                .role_session_intents.get_mut(key).expect("validated intent").submission_uncertain = uncertain;
            Ok(())
        })
    }

    pub(crate) fn confirm_role_session(&mut self, key: &str, binding: &RoleSessionReceipt) -> Result<(), StoreFault> {
        self.transact(|facts| {
            let run = facts.run(binding.team_run()).ok_or(StoreFault::InvalidFacts)?;
            if run.role_session_intents.get(key).is_none_or(|intent| &intent.binding != binding) {
                return Err(StoreFault::InvalidFacts);
            }
            if run.session_installed(binding) { return Ok(()); }
            if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                || facts.team(binding.team()).is_none_or(|team| team.tombstoned()) {
                return Err(StoreFault::InvalidFacts);
            }
            let mut bindings = run.runtime().ok_or(StoreFault::InvalidFacts)?.bindings().to_vec();
            bindings.push(binding.clone());
            let receipt = RunRuntimeReceipt::try_new(binding.team_run().clone(), bindings).map_err(|_| StoreFault::InvalidFacts)?;
            facts.touch_run(binding.team_run().as_str());
            let run = facts.runs.get_mut(binding.team_run().as_str()).expect("validated run");
            run.runtime = Some(receipt);
            run.role_session_intents.get_mut(key).expect("validated intent").submission_uncertain = false;
            Ok(())
        })
    }
}
