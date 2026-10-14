use super::*;

#[derive(Clone, Default)]
pub(super) struct DeliveryIndexes {
    correlations: BTreeMap<(String, String), crate::DeliveryId>,
    receipts: BTreeMap<String, crate::DeliveryId>,
}

impl PartialEq for DeliveryIndexes {
    fn eq(&self, _: &Self) -> bool { true }
}
impl Eq for DeliveryIndexes {}

impl fmt::Debug for DeliveryIndexes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeliveryIndexes(<redacted>)")
    }
}

fn correlation_key(delivery: &crate::Delivery) -> Option<(String, String)> {
    let correlation = match delivery.phase() {
        DeliveryPhase::Delivered { native_correlation, .. } => native_correlation.as_ref(),
        DeliveryPhase::TerminalObserved { observation } => Some(observation.correlation()),
        _ => None,
    }?;
    Some((correlation.endpoint_session_id().as_str().to_owned(), correlation.native_run_receipt().as_str().to_owned()))
}

fn resolution_key(delivery: &crate::Delivery) -> Option<String> {
    let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else { return None; };
    let TerminalObservationResolution::GraphResolved(resolution) = observation.resolution() else { return None; };
    Some(resolution.receipt().as_str().to_owned())
}

impl DeliveryIndexes {
    pub(super) fn restore(deliveries: &DeliveryLedger) -> Result<Self, OrganizationFactsError> {
        let mut indexes = Self::default();
        for delivery in deliveries.deliveries() { indexes.insert(delivery)?; }
        Ok(indexes)
    }

    fn insert(&mut self, delivery: &crate::Delivery) -> Result<(), OrganizationFactsError> {
        let id = &delivery.facts().delivery_id;
        if let Some(key) = correlation_key(delivery) {
            if self.correlations.get(&key).is_some_and(|owner| owner != id) {
                return Err(OrganizationFactsError::DuplicateMatchaTerminalCorrelation);
            }
            self.correlations.insert(key, id.clone());
        }
        if let Some(key) = resolution_key(delivery) {
            if self.receipts.get(&key).is_some_and(|owner| owner != id) {
                return Err(OrganizationFactsError::DuplicateAuthorizedGraphResolution);
            }
            self.receipts.insert(key, id.clone());
        }
        Ok(())
    }

    fn remove(&mut self, delivery: &crate::Delivery) {
        let id = &delivery.facts().delivery_id;
        if let Some(key) = correlation_key(delivery) {
            if self.correlations.get(&key) == Some(id) { self.correlations.remove(&key); }
        }
        if let Some(key) = resolution_key(delivery) {
            if self.receipts.get(&key) == Some(id) { self.receipts.remove(&key); }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct FactsJournal {
    pub(super) active: bool,
    pub(super) teams: BTreeMap<String, Option<TeamFacts>>,
    pub(super) materializations: BTreeMap<String, Option<TeamMaterializationLifecycle>>,
    pub(super) templates: BTreeMap<String, Option<WorkflowTemplateFacts>>,
    pub(super) admissions: BTreeMap<String, Option<PendingWorkflowPlanAdmission>>,
    pub(super) purged: BTreeMap<String, Option<PurgedRunMarker>>,
    pub(super) runs: BTreeMap<String, RunUndo>,
    pub(super) approvals: BTreeMap<String, ApprovalUndo>,
}

impl PartialEq for FactsJournal {
    fn eq(&self, _: &Self) -> bool { true }
}
impl Eq for FactsJournal {}

#[derive(Clone, Debug)]
pub(super) struct RunHeader {
    pub(super) team: TeamId,
    pub(super) revision: TeamRevision,
    pub(super) runtime: Option<RunRuntimeReceipt>,
    pub(super) lifecycle: GraphRunLifecycle,
    pub(super) start_gate: RunStartGate,
}

impl RunHeader {
    fn capture(run: &GraphRunFacts) -> Self {
        Self {
            team: run.team.clone(), revision: run.frozen_team_revision,
            runtime: run.runtime.clone(), lifecycle: run.lifecycle.clone(),
            start_gate: run.start_gate.clone(),
        }
    }

    fn restore(self, run: &mut GraphRunFacts) {
        run.team = self.team;
        run.frozen_team_revision = self.revision;
        run.runtime = self.runtime;
        run.lifecycle = self.lifecycle;
        run.start_gate = self.start_gate;
    }
}

#[derive(Clone, Debug)]
pub(super) enum ApprovalUndo {
    Inserted,
    Updated,
    Removed(Approval),
}

#[derive(Clone, Debug)]
pub(super) enum RunUndo {
    Inserted,
    Updated(RunHeader),
    Removed(GraphRunFacts),
}

macro_rules! touch_map {
    ($method:ident, $field:ident, $undo:ident) => {
        pub(super) fn $method(&mut self, key: &str) {
            if self.journal.active && !self.journal.$undo.contains_key(key) {
                self.journal.$undo.insert(key.to_owned(), self.$field.get(key).cloned());
            }
        }
    };
}

impl OrganizationFacts {
    pub(super) fn refresh_delivery_indexes(&mut self, id: &crate::DeliveryId, replacement: Option<&crate::Delivery>) -> Result<(), OrganizationFactsError> {
        if let Some(old) = self.deliveries.delivery(id) { self.delivery_indexes.remove(old); }
        if let Some(value) = replacement { self.delivery_indexes.insert(value)?; }
        Ok(())
    }

    pub(super) fn validate_changed(&self) -> Result<(), OrganizationFactsError> {
        for (key, old) in &self.journal.teams {
            let current = self.teams.get(key).ok_or(OrganizationFactsError::RemovedTeam)?;
            if let Some(old) = old {
                if current.revision().get() < old.revision().get()
                    || (current.revision() == old.revision() && current.definition() != old.definition())
                    || (old.tombstoned() && !current.tombstoned())
                { return Err(OrganizationFactsError::InvalidTeamTransition); }
            }
        }
        for (key, old) in &self.journal.materializations {
            let current = self.materializations.get(key).ok_or(OrganizationFactsError::RemovedMaterialization)?;
            if !self.teams.contains_key(key) { return Err(OrganizationFactsError::UnknownMaterializationTeam); }
            if let Some(old) = old {
                if !current.can_transition_from(old) { return Err(OrganizationFactsError::MaterializationChanged); }
            }
        }
        for (key, old) in &self.journal.templates {
            let current = self.templates.get(key).ok_or(OrganizationFactsError::WorkflowTemplateChanged)?;
            if !self.teams.contains_key(key) { return Err(OrganizationFactsError::UnknownWorkflowTemplateTeam); }
            if let Some(old) = old {
                if current.team() != old.team() || current.revision() < old.revision()
                    || (current.revision() == old.revision() && current != old)
                { return Err(OrganizationFactsError::WorkflowTemplateChanged); }
            }
        }
        for (key, old) in &self.journal.admissions {
            match (old, self.pending_workflow_plan_admissions.get(key)) {
                (Some(old), Some(current)) if old != current => return Err(OrganizationFactsError::WorkflowPlanAdmissionChanged),
                (Some(old), None) if !self.purged_runs.contains_key(key) => {
                    let run = self.runs.get(key).ok_or(OrganizationFactsError::WorkflowPlanAdmissionChanged)?;
                    let template = self.templates.get(old.team_id().as_str()).ok_or(OrganizationFactsError::WorkflowPlanAdmissionChanged)?;
                    if run.team() != old.team_id() || run.frozen_team_revision() != old.team_revision()
                        || template.team() != old.team_id() || template.source_identity() != old.source_identity()
                        || template.plan().run_id() != run.run_id().as_str()
                    { return Err(OrganizationFactsError::WorkflowPlanAdmissionChanged); }
                }
                (_, Some(current)) => {
                    let team = self.teams.get(current.team_id().as_str()).ok_or(OrganizationFactsError::UnknownWorkflowPlanAdmissionTeam)?;
                    if team.tombstoned() || team.revision().get() < current.team_revision().get() || self.runs.contains_key(key) {
                        return Err(OrganizationFactsError::InvalidWorkflowPlanAdmission);
                    }
                }
                _ => {}
            }
        }
        for (key, old) in &self.journal.runs {
            let Some(run) = self.runs.get(key) else {
                if !self.purged_runs.contains_key(key) { return Err(OrganizationFactsError::RemovedRun); }
                continue;
            };
            let team = self.teams.get(run.team.as_str()).ok_or(OrganizationFactsError::UnknownRunTeam)?;
            if run.frozen_team_revision.get() > team.revision().get() || self.purged_runs.contains_key(key) {
                return Err(OrganizationFactsError::InvalidGraphRun);
            }
            if let RunUndo::Updated(old) = old {
                if run.team != old.team || run.frozen_team_revision != old.revision { return Err(OrganizationFactsError::RunOwnershipChanged); }
                if !run.lifecycle.can_transition_from(&old.lifecycle) { return Err(OrganizationFactsError::InvalidGraphRunLifecycle); }
                if !run.start_gate.can_transition_from(&old.start_gate) { return Err(OrganizationFactsError::InvalidRunStartGate); }
            }
            if matches!(old, RunUndo::Inserted) {
                GraphState::restore_durable(run.graph.durable_snapshot()).map_err(|_| OrganizationFactsError::InvalidGraphRun)?;
            } else {
                run.graph.validate_changes().map_err(|_| OrganizationFactsError::InvalidGraphRun)?;
            }
            if matches!(old, RunUndo::Inserted) || run.graph.changes().is_some_and(|changes| changes.definition) {
                self.validate_replaced_graph_dependents(key)?;
            }
            if let Some(runtime) = &run.runtime {
                let receipt = self.materializations.get(run.team.as_str()).and_then(TeamMaterializationLifecycle::receipt)
                    .ok_or(OrganizationFactsError::RunMaterializationMissing)?;
                validate_runtime_receipt_alignment(run, runtime, receipt)?;
            }
        }
        let changed_deliveries = self.deliveries.changed_ids().collect::<BTreeSet<_>>();
        let mut correlations = BTreeMap::new();
        let mut receipts = BTreeMap::new();
        for id in &changed_deliveries {
            let old = self.deliveries.previous(id);
            let Some(current) = self.deliveries.delivery(id) else {
                if old.is_some_and(|old| !self.purged_runs.contains_key(&old.facts().run_id)) {
                    return Err(OrganizationFactsError::RemovedDelivery);
                }
                continue;
            };
            let run = self.runs.get(&current.facts().run_id).ok_or(OrganizationFactsError::UnknownDeliveryRun)?;
            if let Some(old) = old {
                if current.facts() != old.facts() { return Err(OrganizationFactsError::DeliveryIdentityChanged); }
                validate_delivery_transition(old, current)?;
            }
            if let DeliveryPhase::TerminalObserved { observation } = current.phase() {
                validate_terminal_observation(current, run, observation)?;
            }
            if let Some(key) = correlation_key(current) {
                if self.delivery_indexes.correlations.get(&key).is_some_and(|owner| owner != *id && !changed_deliveries.contains(owner))
                    || correlations.insert(key, *id).is_some()
                { return Err(OrganizationFactsError::DuplicateMatchaTerminalCorrelation); }
            }
            if let Some(key) = resolution_key(current) {
                if self.delivery_indexes.receipts.get(&key).is_some_and(|owner| owner != *id && !changed_deliveries.contains(owner))
                    || receipts.insert(key, *id).is_some()
                { return Err(OrganizationFactsError::DuplicateAuthorizedGraphResolution); }
            }
        }
        for id in self.activities.changed_ids() {
            let old = self.activities.previous(id);
            let Some(current) = self.activities.activity(id) else {
                if old.is_some_and(|old| !self.purged_runs.contains_key(old.facts().run_id.as_str())) {
                    return Err(OrganizationFactsError::RemovedActivity);
                }
                continue;
            };
            validate_activity(&self.runs, current)?;
            if let Some(old) = old {
                if current.facts() != old.facts() { return Err(OrganizationFactsError::ActivityIdentityChanged); }
                validate_activity_transition(old, current)?;
            } else { validate_new_activity_prompt(&self.runs, current.facts())?; }
        }
        for id in self.evidence.changed_ids() {
            if let Some(record) = self.evidence.evidence(id) { validate_evidence_provenance(&self.runs, record)?; }
        }
        for id in self.artifacts.changed_ids() {
            if let Some(record) = self.artifacts.artifact(id) { validate_artifact_provenance(&self.runs, record)?; }
        }
        for key in self.triggers.changed_keys() {
            if let Some(request) = self.triggers.request(&key.0, &key.1) { validate_trigger_registration(&self.runs, request)?; }
        }
        for key in self.control_resolutions.changed_keys() {
            if let Some(resolution) = self.control_resolutions.resolution(key) { validate_control_node_resolution(&self.runs, resolution)?; }
        }
        for key in self.task_board.changed_keys() {
            if let crate::run::task_board::TaskBoardKey::Task { team, run, id } = key
                && let Some((_, task)) = self.task_board.task_record(team, run, id)
            {
                task.validate_ownership(task.status()).map_err(|_| OrganizationFactsError::InvalidTaskBoard)?;
            }
        }
        self.validate_trigger_deltas()?;
        self.validate_changed_approvals()?;
        Ok(())
    }

    fn validate_trigger_deltas(&self) -> Result<(), OrganizationFactsError> {
        let mut attempts = BTreeMap::<(String, String), i64>::new();
        for (run_id, undo) in &self.journal.runs {
            let Some(run) = self.runs.get(run_id) else { continue; };
            let Some(changes) = run.graph.changes() else { continue; };
            if changes.definition || matches!(undo, RunUndo::Inserted) { continue; }
            for (node, number) in &changes.attempts {
                if !run.graph.definition().node(node).is_some_and(|node| node.is_armed_start()) { continue; }
                let previous = run.graph.previous_attempt(node, *number)
                    .is_some_and(|attempt| matches!(attempt.reason(), crate::AttemptReason::Trigger));
                let current = run.graph.executions().get(node).and_then(|history| history.attempts().get(*number as usize - 1))
                    .is_some_and(|attempt| matches!(attempt.reason(), crate::AttemptReason::Trigger));
                *attempts.entry((run_id.clone(), node.as_str().to_owned())).or_default() += i64::from(current) - i64::from(previous);
            }
        }
        for (run_id, id) in self.triggers.changed_keys() {
            let Some(run) = self.runs.get(run_id) else { continue; };
            if run.graph.changes().is_some_and(|changes| changes.definition)
                || matches!(self.journal.runs.get(run_id), Some(RunUndo::Inserted)) { continue; }
            if let Some(old) = self.triggers.previous(run_id, id) {
                *attempts.entry((run_id.clone(), old.start_node_id.clone())).or_default() += 1;
            }
            if let Some(current) = self.triggers.request(run_id, id) {
                *attempts.entry((run_id.clone(), current.start_node_id.clone())).or_default() -= 1;
            }
        }
        if attempts.values().any(|delta| *delta != 0) { return Err(OrganizationFactsError::InvalidTriggerRegistration); }
        Ok(())
    }

    fn validate_replaced_graph_dependents(&self, run_id: &str) -> Result<(), OrganizationFactsError> {
        let run = &self.runs[run_id];
        for delivery in self.deliveries.deliveries().filter(|value| value.facts().run_id == run_id) {
            if let DeliveryPhase::TerminalObserved { observation } = delivery.phase() {
                validate_terminal_observation(delivery, run, observation)?;
            }
        }
        for activity in self.activities.activities().filter(|value| value.facts().run_id.as_str() == run_id) {
            validate_activity(&self.runs, activity)?;
        }
        for record in self.evidence.records().filter(|value| value.run_id() == run_id) {
            validate_evidence_provenance(&self.runs, record)?;
        }
        for record in self.artifacts.records().filter(|value| value.run_id() == run_id) {
            validate_artifact_provenance(&self.runs, record)?;
        }
        for resolution in self.control_resolutions.resolutions().filter(|value| value.graph_run_id().as_str() == run_id) {
            validate_control_node_resolution(&self.runs, resolution)?;
        }
        let mut trigger_counts = BTreeMap::new();
        for request in self.triggers.requests().filter(|value| value.run_id == run_id) {
            validate_trigger_registration(&self.runs, request)?;
            *trigger_counts.entry(request.start_node_id.as_str()).or_insert(0_usize) += 1;
        }
        for node in run.graph.definition().nodes() {
            if !node.is_armed_start() { continue; }
            let fired = run.graph.executions().get(node.id()).map_or(0, |history| history.attempts().iter()
                .filter(|attempt| matches!(attempt.reason(), crate::AttemptReason::Trigger)).count());
            if fired != trigger_counts.get(node.id().as_str()).copied().unwrap_or(0) {
                return Err(OrganizationFactsError::InvalidTriggerRegistration);
            }
        }
        validate_human_decision_approvals(&self.runs,
            self.approvals.values().filter(|approval| approval.facts().run_id == run_id), &self.control_resolutions)
    }

    fn validate_changed_approvals(&self) -> Result<(), OrganizationFactsError> {
        let mut expected = BTreeMap::new();
        for (id, undo) in &self.journal.approvals {
            let Some(approval) = self.approvals.get(id) else { continue; };
            if let ApprovalUndo::Removed(old) = undo {
                if approval != old { return Err(OrganizationFactsError::ApprovalChanged); }
            }
            Approval::restore(approval.durable_snapshot()).map_err(|_| OrganizationFactsError::InvalidApprovalLedger)?;
            let facts = approval.facts();
            let run = self.runs.get(&facts.run_id).ok_or(OrganizationFactsError::UnknownApprovalRun)?;
            for receipt in approval.new_resolutions() {
                *expected.entry((facts.run_id.as_str(), facts.approval_id.as_str(),
                    approval_decision_tag(receipt.decision), receipt.idempotency_key.as_str(), receipt.resolved_at))
                    .or_insert(0_usize) += 1;
            }
            if let crate::ApprovalSubject::HumanDecision { node_id } = &facts.subject
                && facts.origin == crate::ApprovalOrigin::HumanDecision
                && facts.effect == crate::ApprovalEffect::RouteDecisionPorts
            {
                let node_id = NodeId::new(node_id.clone());
                let execution = facts.execution_fence.as_deref().ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
                let attempt = run.graph.executions().get(&node_id)
                    .and_then(|history| history.attempts().iter().find(|attempt| attempt.fence().node_execution_id().as_str() == execution))
                    .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
                for receipt in approval.new_resolutions() {
                    let resolution = ControlNodeResolution::human_decision(run.run_id().clone(), node_id.clone(), attempt.fence().clone(),
                        match receipt.decision {
                            crate::ApprovalDecision::Approve => crate::HumanDecision::Approve,
                            crate::ApprovalDecision::Deny => crate::HumanDecision::Deny,
                            crate::ApprovalDecision::Abort => crate::HumanDecision::Abort,
                        }, receipt.resolved_at).map_err(|_| OrganizationFactsError::InvalidApprovalLedger)?;
                    if self.control_resolutions.resolution(resolution.idempotency_key()) != Some(&resolution) {
                        return Err(OrganizationFactsError::InvalidApprovalLedger);
                    }
                }
            }
        }
        for run_id in self.events.changed_runs() {
            for event in self.events.new_events(run_id) {
                let crate::run::event::TeamEventPayload::ApprovalResolved { approval_id, decision, status } = event.payload() else { continue; };
                if *status != decision.status() { return Err(OrganizationFactsError::InvalidApprovalLedger); }
                let count = expected.get_mut(&(event.run_id(), approval_id.as_str(), approval_decision_tag(*decision), event.idempotency_key(), event.created_at()))
                    .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
                *count = count.checked_sub(1).ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
            }
        }
        if expected.values().any(|count| *count != 0) { return Err(OrganizationFactsError::InvalidApprovalLedger); }
        Ok(())
    }

    touch_map!(touch_team, teams, teams);
    touch_map!(touch_materialization, materializations, materializations);
    touch_map!(touch_template, templates, templates);
    touch_map!(touch_admission, pending_workflow_plan_admissions, admissions);
    touch_map!(touch_purged, purged_runs, purged);

    pub(super) fn touch_run(&mut self, key: &str) {
        if !self.journal.active || self.journal.runs.contains_key(key) { return; }
        let undo = match self.runs.get_mut(key) {
            Some(run) => {
                run.graph.begin_mutation();
                RunUndo::Updated(RunHeader::capture(run))
            }
            None => RunUndo::Inserted,
        };
        self.journal.runs.insert(key.to_owned(), undo);
    }

    pub(super) fn remove_run(&mut self, key: &str) {
        self.touch_run(key);
        if let Some(mut run) = self.runs.remove(key) {
            if let Some(RunUndo::Updated(header)) = self.journal.runs.remove(key) {
                run.graph.rollback_mutation();
                header.restore(&mut run);
                self.journal.runs.insert(key.to_owned(), RunUndo::Removed(run));
            } else if self.journal.active {
                self.journal.runs.insert(key.to_owned(), RunUndo::Inserted);
            }
        }
    }

    pub(super) fn touch_approval(&mut self, key: &str) {
        if !self.journal.active || self.journal.approvals.contains_key(key) { return; }
        let undo = if let Some(approval) = self.approvals.get_mut(key) {
            approval.begin_transaction();
            ApprovalUndo::Updated
        } else {
            ApprovalUndo::Inserted
        };
        self.journal.approvals.insert(key.to_owned(), undo);
    }

    pub(super) fn insert_approval(&mut self, approval: Approval) {
        let key = approval.facts().approval_id.clone();
        self.touch_approval(&key);
        if let Some(mut old) = self.approvals.insert(key.clone(), approval) {
            if matches!(self.journal.approvals.get(&key), Some(ApprovalUndo::Updated)) {
                old.rollback_transaction();
                self.journal.approvals.insert(key, ApprovalUndo::Removed(old));
            }
        }
    }

    pub(super) fn remove_approval(&mut self, key: &str) {
        self.touch_approval(key);
        if let Some(mut approval) = self.approvals.remove(key) {
            approval.rollback_transaction();
            if self.journal.active && matches!(self.journal.approvals.get(key), Some(ApprovalUndo::Updated)) {
                self.journal.approvals.insert(key.to_owned(), ApprovalUndo::Removed(approval));
            }
        }
    }

    pub(crate) fn begin_transaction(&mut self) {
        assert!(!self.journal.active);
        self.journal.active = true;
        self.deliveries.begin_transaction();
        self.activities.begin_transaction();
        self.triggers.begin_transaction();
        self.control_resolutions.begin_transaction();
        self.events.begin_transaction();
        self.evidence.begin_transaction();
        self.artifacts.begin_transaction();
        self.decisions.begin_transaction();
        self.task_board.begin_transaction();
    }

    pub(crate) fn commit_transaction(&mut self) {
        for id in self.deliveries.changed_ids() {
            if let Some(old) = self.deliveries.previous(id) { self.delivery_indexes.remove(old); }
        }
        for id in self.deliveries.changed_ids() {
            if let Some(current) = self.deliveries.delivery(id) {
                self.delivery_indexes.insert(current).expect("validated delivery indexes");
            }
        }
        for key in self.journal.runs.keys() {
            if let Some(run) = self.runs.get_mut(key) { run.graph.commit_mutation(); }
        }
        for key in self.journal.approvals.keys() {
            if let Some(approval) = self.approvals.get_mut(key) { approval.commit_transaction(); }
        }
        self.deliveries.commit_transaction();
        self.activities.commit_transaction();
        self.triggers.commit_transaction();
        self.control_resolutions.commit_transaction();
        self.events.commit_transaction();
        self.evidence.commit_transaction();
        self.artifacts.commit_transaction();
        self.decisions.commit_transaction();
        self.task_board.commit_transaction();
        self.journal = FactsJournal::default();
    }

    pub(crate) fn rollback_transaction(&mut self) {
        let journal = std::mem::take(&mut self.journal);
        macro_rules! restore_map {
            ($field:ident, $undo:ident) => {
                for (key, old) in journal.$undo {
                    match old {
                        Some(value) => { self.$field.insert(key, value); }
                        None => { self.$field.remove(&key); }
                    }
                }
            };
        }
        restore_map!(teams, teams);
        restore_map!(materializations, materializations);
        restore_map!(templates, templates);
        restore_map!(pending_workflow_plan_admissions, admissions);
        restore_map!(purged_runs, purged);
        for (key, undo) in journal.runs {
            match undo {
                RunUndo::Inserted => { self.runs.remove(&key); }
                RunUndo::Removed(run) => { self.runs.insert(key, run); }
                RunUndo::Updated(header) => {
                    let run = self.runs.get_mut(&key).expect("journalled run remains present");
                    run.graph.rollback_mutation();
                    header.restore(run);
                }
            }
        }
        for (key, old) in journal.approvals {
            match old {
                ApprovalUndo::Removed(approval) => { self.approvals.insert(key, approval); }
                ApprovalUndo::Inserted => { self.approvals.remove(&key); }
                ApprovalUndo::Updated => {
                    if let Some(approval) = self.approvals.get_mut(&key) {
                        approval.rollback_transaction();
                    }
                }
            }
        }
        self.deliveries.rollback_transaction();
        self.activities.rollback_transaction();
        self.triggers.rollback_transaction();
        self.control_resolutions.rollback_transaction();
        self.events.rollback_transaction();
        self.evidence.rollback_transaction();
        self.artifacts.rollback_transaction();
        self.decisions.rollback_transaction();
        self.task_board.rollback_transaction();
    }
}
